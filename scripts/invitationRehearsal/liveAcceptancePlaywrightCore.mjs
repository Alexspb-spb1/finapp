import { createHash } from 'node:crypto'
import { FIXTURE_MUTATION_SLOT_SPECS, SCENARIO_NAMES, assertNoSecretMaterial } from './liveAcceptanceCore.mjs'
import { classifyLiveBrowserRequest, createLiveBrowserRequestBinder } from './liveAcceptanceBrowserCore.mjs'
import {
  READ_ONLY_SLOT_SPECS, createLiveStagingExecutor, createVisibleOwnerHandoff,
} from './liveAcceptanceExecutorCore.mjs'

const blocked = () => { throw new Error('live_playwright_adapter_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const frozen = value => Object.freeze(structuredClone(value))

export const PLAYWRIGHT_OWNER_SELECTORS = Object.freeze({
  email: Object.freeze({ kind: 'label', name: 'Email', exact: true }),
  password: Object.freeze({ kind: 'label', name: 'Пароль', exact: true }),
  createAccount: Object.freeze({ kind: 'button', name: 'Создать аккаунт', exact: true }),
  register: Object.freeze({ kind: 'button', name: 'Зарегистрироваться', exact: true }),
  sendVerification: Object.freeze({ kind: 'button', name: 'Отправить письмо подтверждения', exact: true }),
  confirmVerification: Object.freeze({ kind: 'button', name: 'Я подтвердил email', exact: true }),
})

// Every required browser request now has a bounded held-response bridge. The
// executor remains disabled only until the separately authorized live Auth
// metadata shape is observed and its explicit marker is removed.
export const PLAYWRIGHT_LIVE_MISSING_BINDINGS = Object.freeze([])

/** Page routes take precedence over the context allowlist route. This bridge
 * holds one exact request before dispatch, returns only its hash, then releases
 * it through the durable binder after MAY exists. */
export function createHeldPlaywrightRequestBridge({
  summarizeRegistration, summarizeVerification, summarizeAccept, summarizeAccess,
  getExpectedMailboxUid, captureOwnerMailboxForcedRefresh, heldWaitTimeoutMs = 20_000,
}) {
  if ([summarizeRegistration, summarizeVerification, summarizeAccept, summarizeAccess, getExpectedMailboxUid,
    captureOwnerMailboxForcedRefresh].some(value => typeof value !== 'function') ||
      !Number.isSafeInteger(heldWaitTimeoutMs) || heldWaitTimeoutMs < 10 || heldWaitTimeoutMs > 60_000) blocked()
  let page = null, binder = null, expecting = null, held = null, preparedWaiter = null
  let verificationReleased = false, confirmationStarted = false, confirmationFailed = false, lookupSeen = false, forcedRefreshSeen = false
  let normalWaiter = null, expectAccess = false, acceptReleased = false, normalComplete = false
  const completed = new Set()
  const bounded = (promise, onTimeout) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { onTimeout() } finally { reject(new Error('live_playwright_adapter_blocked')) } }, heldWaitTimeoutMs)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
  const failConfirmation = async route => {
    try { await route.abort() } catch { /* best effort */ }
    confirmationFailed = true
    if (normalWaiter) { normalWaiter.resolve(null); normalWaiter = null }
  }
  const bindAndContinue = async (route, request) => {
    let decision
    try { decision = await bounded(binder.bind({ method: request.method(), url: request.url(), postData: request.postData() }), () => {}) } catch {
      await failConfirmation(route); return null
    }
    if (!decision || decision.action !== 'continue') { await failConfirmation(route); return null }
    try { await bounded(route.continue(), () => {}) } catch { await failConfirmation(route); return null }
    try { return await bounded(request.response(), () => {}) } catch { return null }
  }
  const attach = async value => {
    if (page || !exactKeys(value, ['page', 'browserBinder']) || !value.page || !value.browserBinder) blocked()
    page = value.page; binder = value.browserBinder
    await page.route('**/*', async route => {
      const request = route.request()
      let classification
      try { classification = classifyLiveBrowserRequest(request.method(), request.url()) } catch { return route.fallback() }
      if (confirmationStarted && classification.kind === 'identity' && classification.operation === 'accounts:lookup') {
        if (held || lookupSeen || forcedRefreshSeen) return failConfirmation(route)
        const response = await bindAndContinue(route, request)
        if (!response || response.status() !== 200) return failConfirmation(route)
        let body
        try { body = await response.json() } catch { return failConfirmation(route) }
        const expectedUid = getExpectedMailboxUid()
        if (!safeId(expectedUid) || !record(body) || !Array.isArray(body.users) || body.users.length !== 1 ||
            !record(body.users[0]) || body.users[0].localId !== expectedUid || body.users[0].emailVerified !== true) return failConfirmation(route)
        lookupSeen = true
        return
      }
      if (confirmationStarted && classification.kind === 'secure-token' && classification.operation === 'token') {
        if (held || !lookupSeen || forcedRefreshSeen) return failConfirmation(route)
        const response = await bindAndContinue(route, request)
        if (!response || response.status() !== 200) return failConfirmation(route)
        let captured
        try { captured = await bounded(captureOwnerMailboxForcedRefresh(response), () => {}) } catch { return failConfirmation(route) }
        if (!exactKeys(captured, ['captured']) || captured.captured !== true) return failConfirmation(route)
        forcedRefreshSeen = true
        return
      }
      if (confirmationStarted && !held && classification.kind === 'callable' && classification.operation === 'acceptInvite') {
        if (acceptReleased || expectAccess || normalComplete || !lookupSeen || !forcedRefreshSeen) return failConfirmation(route)
        const postData = request.postData()
        if (typeof postData !== 'string') return route.abort()
        held = { route, request, method: request.method(), url: request.url(), postData,
          requestSha256: sha256(postData), operation: 'acceptInvite' }
        if (normalWaiter) { normalWaiter.resolve(held.requestSha256); normalWaiter = null }
        return
      }
      if (expectAccess && !held && classification.kind === 'callable' && classification.operation === 'getCompanyAccess') {
        const postData = request.postData()
        if (typeof postData !== 'string') return route.abort()
        held = { route, request, method: request.method(), url: request.url(), postData,
          requestSha256: sha256(postData), operation: 'getCompanyAccess' }
        expectAccess = false
        if (normalWaiter) { normalWaiter.resolve(held.requestSha256); normalWaiter = null }
        return
      }
      if (!expecting || classification.operation !== expecting || held) return route.fallback()
      const postData = request.postData()
      if (typeof postData !== 'string') return route.abort()
      held = { route, request, method: request.method(), url: request.url(), postData, requestSha256: sha256(postData), operation: expecting }
      expecting = null
      preparedWaiter.resolve({ requestSha256: held.requestSha256 }); preparedWaiter = null
    })
    return { attached: true }
  }
  return Object.freeze({
    attach,
    async prepare({ operation, trigger }) {
      if (!page || held || expecting || completed.has(operation) || (operation === 'accounts:sendOobCode' && verificationReleased) ||
          typeof operation !== 'string' || typeof trigger !== 'function') blocked()
      expecting = operation
      const prepared = new Promise((resolve, reject) => { preparedWaiter = { resolve, reject } })
      try { await bounded(Promise.resolve().then(trigger), () => { expecting = null; preparedWaiter = null }) } catch {
        expecting = null; preparedWaiter = null; blocked()
      }
      return bounded(prepared, () => { expecting = null; preparedWaiter = null })
    },
    async release({ operation, permit }) {
      if (!held || held.operation !== operation || (operation === 'accounts:sendOobCode' && verificationReleased) ||
          !record(permit) || permit.requestSha256 !== held.requestSha256) blocked()
      const current = held; held = null; preparedWaiter = null
      const decision = await binder.bind({ method: current.method, url: current.url, postData: current.postData })
      if (!decision || decision.action !== 'continue') { await current.route.abort(); blocked() }
      if (operation === 'acceptInvite') expectAccess = true
      await current.route.continue()
      const response = await bounded(current.request.response(), () => { try { void current.route.abort() } catch { /* best effort */ } })
      const summarizer = { 'accounts:signUp': summarizeRegistration, 'accounts:sendOobCode': summarizeVerification,
        acceptInvite: summarizeAccept, getCompanyAccess: summarizeAccess }[operation]
      if (!summarizer) blocked()
      const result = await summarizer(response, { requestSha256: current.requestSha256 })
      if (['accounts:signUp', 'acceptInvite'].includes(operation)) {
        if (!exactKeys(result, ['requestSha256', 'outcomeSha256', 'producedSha256'])) blocked()
      } else if (!exactKeys(result, ['requestSha256', 'outcomeSha256'])) blocked()
      if (result.requestSha256 !== current.requestSha256 || !hex64(result.outcomeSha256) ||
          (Object.hasOwn(result, 'producedSha256') && !hex64(result.producedSha256))) blocked()
      assertNoSecretMaterial(result)
      if (operation === 'accounts:sendOobCode') verificationReleased = true
      if (operation === 'acceptInvite') acceptReleased = true
      if (operation === 'getCompanyAccess') normalComplete = true
      completed.add(operation)
      return frozen(result)
    },
    async takePreparedNormal(operation) {
      if (!['acceptInvite', 'getCompanyAccess'].includes(operation) || normalComplete ||
          (operation === 'acceptInvite' && acceptReleased) || (operation === 'getCompanyAccess' && !acceptReleased) ||
          (held?.operation && held.operation !== operation)) blocked()
      const requestSha256 = held?.operation === operation ? held.requestSha256 : await bounded(new Promise((resolve, reject) => {
        if (normalWaiter) blocked(); normalWaiter = { resolve, reject }
      }), () => { normalWaiter = null })
      return frozen({ requestSha256 })
    },
    async confirmVerifiedSession({ challenge, trigger }) {
      if (!verificationReleased || confirmationStarted || held || typeof trigger !== 'function' ||
          !exactKeys(challenge, ['challengeSha256']) || !hex64(challenge.challengeSha256)) blocked()
      confirmationStarted = true
      const acceptPrepared = new Promise((resolve, reject) => { normalWaiter = { resolve, reject } })
      try {
        const [, requestSha256] = await Promise.all([
          bounded(Promise.resolve().then(trigger), () => { normalWaiter = null }),
          bounded(acceptPrepared, () => { normalWaiter = null }),
        ])
        if (confirmationFailed || !lookupSeen || !forcedRefreshSeen || !hex64(requestSha256) || held?.operation !== 'acceptInvite') blocked()
      } catch { normalWaiter = null; blocked() }
      return frozen({ challengeSha256: challenge.challengeSha256, verified: true, reloaded: lookupSeen, forcedRefresh: forcedRefreshSeen })
    },
  })
}

const scenarioForFixture = Object.freeze({
  createOwnerAAuth: SCENARIO_NAMES[0], createCompanyA: SCENARIO_NAMES[0],
  createOwnerBAuth: SCENARIO_NAMES[0], createCompanyB: SCENARIO_NAMES[0],
  createMailboxCancelledInvite: SCENARIO_NAMES[0], cancelMailboxInvite: SCENARIO_NAMES[0],
  createMailboxFinalInvite: SCENARIO_NAMES[1], denyMailboxResendCooldown: SCENARIO_NAMES[1],
  resendMailboxFinalInvite: SCENARIO_NAMES[1], createOwnerMailboxAuth: SCENARIO_NAMES[3],
  denyWrongIdentityAccept: SCENARIO_NAMES[2], denyUnverifiedMailboxAccept: SCENARIO_NAMES[3],
  acceptMailboxFinalInvite: SCENARIO_NAMES[3], replayMailboxFinalInvite: SCENARIO_NAMES[5],
  createOwnerBInvite: SCENARIO_NAMES[4], acceptOwnerBInvite: SCENARIO_NAMES[4],
})

const scenarioForReadOnly = Object.freeze(Object.fromEntries(READ_ONLY_SLOT_SPECS.map(spec => [spec.slot,
  spec.slot.startsWith('previewCancelled') || spec.slot === 'listCancelledPending' ? SCENARIO_NAMES[0]
    : spec.slot.startsWith('previewFinal') || spec.slot === 'listFinalPending' ? SCENARIO_NAMES[1]
      : spec.slot.startsWith('mailbox') ? SCENARIO_NAMES[3]
        : spec.slot === 'ownerBCompanyARecovery' ? SCENARIO_NAMES[5] : SCENARIO_NAMES[4],
])))

export const SIX_SCENARIO_SCHEDULE = Object.freeze(SCENARIO_NAMES.map(name => Object.freeze({
  name,
  fixtureSlots: Object.freeze(FIXTURE_MUTATION_SLOT_SPECS.filter(spec => scenarioForFixture[spec.slot] === name).map(spec => spec.slot)),
  readOnlySlots: Object.freeze(READ_ONLY_SLOT_SPECS.filter(spec => scenarioForReadOnly[spec.slot] === name).map(spec => spec.slot)),
})))

function locator(page, selector) {
  if (selector.kind === 'label') return page.getByLabel(selector.name, { exact: selector.exact })
  if (selector.kind === 'button') return page.getByRole('button', { name: selector.name, exact: selector.exact })
  blocked()
}

/**
 * Create an exact-method owner session for createVisibleOwnerHandoff. Raw
 * mailbox, invite URL and password remain owned by secretActions/page. The
 * injected requestBridge owns held request/response bodies and may return only
 * hashes and booleans.
 */
export function createBoundedVisiblePlaywrightSessionFactory({
  chromium, browserBinder, secretActions, requestBridge, mailboxSha256, localStaticOrigin = 'http://127.0.0.1:5177',
}) {
  if (!chromium || typeof chromium.launch !== 'function' || !browserBinder || typeof browserBinder.bind !== 'function' ||
      !exactKeys(secretActions, ['navigateInvitation', 'fillMailbox', 'clearClipboard']) ||
      Object.values(secretActions).some(value => typeof value !== 'function') ||
      !exactKeys(requestBridge, ['attach', 'prepare', 'release', 'takePreparedNormal', 'confirmVerifiedSession']) || !hex64(mailboxSha256) ||
      Object.values(requestBridge).some(value => typeof value !== 'function') || localStaticOrigin !== 'http://127.0.0.1:5177') blocked()
  let browser = null, context = null, page = null, closed = false, financialModuleLoaded = false
  const closeAll = async () => {
    if (closed) return
    closed = true
    try { if (page) await secretActions.clearClipboard(page) } catch { /* best effort after safe stop */ }
    try { if (context) await context.close() } catch { /* best effort */ }
    try { if (browser) await browser.close() } catch { /* best effort */ }
  }
  const openSession = async options => {
    if (browser || closed || !exactKeys(options, ['headless', 'persistent', 'recordHar', 'recordVideo', 'trace']) ||
        options.headless !== false || options.persistent !== false || options.recordHar !== false ||
        options.recordVideo !== false || options.trace !== false) blocked()
    try {
      browser = await chromium.launch({ headless: false })
      context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
      await context.addInitScript(origin => {
        if (location.origin !== origin) return
        const token = location.hash.match(/(?:^#|&)token=([^&]+)/)?.[1] ?? null
        const state = { beforeScripts: document.scripts.length === 0, fragmentInitiallyPresent: Boolean(token),
          fragmentRemoved: false, providerBeforeRemoval: false, capabilityPersisted: false,
          storageReadBeforeRemoval: false, cachedCompanyDataLoaded: false }
        Object.defineProperty(window, '__finappLiveBoundary', { value: state, configurable: false })
        const replace = history.replaceState.bind(history)
        history.replaceState = (...args) => { const result = replace(...args); if (token && !location.hash.includes(`token=${token}`)) state.fragmentRemoved = true; return result }
        for (const method of ['getItem', 'setItem']) {
          const original = Storage.prototype[method]
          Storage.prototype[method] = function (...args) {
            if (!state.fragmentRemoved && method === 'getItem') state.storageReadBeforeRemoval = true
            if (method === 'getItem' && /^(?:finapp_last_company_id|company_data_)/.test(String(args[0]))) state.cachedCompanyDataLoaded = true
            if (token && args.some(value => String(value).includes(token))) state.capabilityPersisted = true
            return original.apply(this, args)
          }
        }
        const fetchOriginal = window.fetch
        window.fetch = (...args) => { if (!state.fragmentRemoved) state.providerBeforeRemoval = true; return fetchOriginal(...args) }
        const openOriginal = XMLHttpRequest.prototype.open
        XMLHttpRequest.prototype.open = function (...args) { if (!state.fragmentRemoved) state.providerBeforeRemoval = true; return openOriginal.apply(this, args) }
      }, localStaticOrigin)
      await context.route('**/*', async route => {
        try {
          const request = route.request()
          if (/(?:LegacyApp|authStore)-/.test(request.url())) financialModuleLoaded = true
          const decision = await browserBinder.bind({ method: request.method(), url: request.url(), postData: request.postData() })
          if (!decision || decision.action === 'abort') return route.abort()
          return route.continue()
        } catch { return route.abort() }
      })
      page = await context.newPage()
      page.setDefaultTimeout(20_000)
      const attached = await requestBridge.attach({ page, browserBinder })
      if (!exactKeys(attached, ['attached']) || attached.attached !== true) blocked()
      const navigated = await secretActions.navigateInvitation(page)
      if (!exactKeys(navigated, ['navigated']) || navigated.navigated !== true) blocked()
      if (await page.evaluate(expected => location.origin === expected, localStaticOrigin) !== true) blocked()
      await locator(page, PLAYWRIGHT_OWNER_SELECTORS.createAccount).click()
      const seeded = await secretActions.fillMailbox(page, locator(page, PLAYWRIGHT_OWNER_SELECTORS.email))
      if (!exactKeys(seeded, ['filled']) || seeded.filled !== true) blocked()
      const session = {
        async inspectBoundary() {
          const result = await page.evaluate(() => {
            const state = window.__finappLiveBoundary
            return { visible: true, persistent: false,
              fragmentRemovedBeforeInit: Boolean(state?.beforeScripts && state?.fragmentInitiallyPresent && state?.fragmentRemoved && !state?.providerBeforeRemoval && !state?.storageReadBeforeRemoval),
              financialModulesLoaded: [...document.scripts].some(node => /(?:LegacyApp|authStore)-/.test(node.src)),
              cachedCompanyDataLoaded: Boolean(state?.cachedCompanyDataLoaded), capabilityPersisted: Boolean(state?.capabilityPersisted) }
          })
          if (!exactKeys(result, ['visible', 'persistent', 'fragmentRemovedBeforeInit', 'financialModulesLoaded', 'cachedCompanyDataLoaded', 'capabilityPersisted'])) blocked()
          return frozen({ ...result, financialModulesLoaded: result.financialModulesLoaded || financialModuleLoaded })
        },
        async confirmCredentialReady() {
          return frozen(await locator(page, PLAYWRIGHT_OWNER_SELECTORS.password).evaluate(input => ({
            ready: typeof input.value === 'string' && input.value.length > 0,
            minimumLengthSatisfied: typeof input.value === 'string' && input.value.length >= 6,
          })))
        },
        async prepareRegistration() {
          const prepared = await requestBridge.prepare({ operation: 'accounts:signUp', trigger: () => locator(page, PLAYWRIGHT_OWNER_SELECTORS.register).click() })
          if (!exactKeys(prepared, ['requestSha256']) || !hex64(prepared.requestSha256)) blocked()
          return frozen({ ...prepared, binding: { identity: 'ownerMailbox', subjectSha256: mailboxSha256 } })
        },
        async dispatchRegistration(permit) {
          browserBinder.armMutation()
          return requestBridge.release({ operation: 'accounts:signUp', permit })
        },
        async prepareVerification() {
          const prepared = await requestBridge.prepare({ operation: 'accounts:sendOobCode', trigger: () => locator(page, PLAYWRIGHT_OWNER_SELECTORS.sendVerification).click() })
          if (!exactKeys(prepared, ['requestSha256']) || !hex64(prepared.requestSha256)) blocked()
          return frozen(prepared)
        },
        async dispatchVerification(permit) {
          browserBinder.armVerificationEmail()
          return requestBridge.release({ operation: 'accounts:sendOobCode', permit })
        },
        async confirmVerifiedSession(challenge) {
          return requestBridge.confirmVerifiedSession({ challenge, trigger: () => locator(page, PLAYWRIGHT_OWNER_SELECTORS.confirmVerification).click() })
        },
        close: closeAll,
      }
      return Object.freeze(session)
    } catch (error) { await closeAll(); throw error }
  }
  return Object.freeze({ openSession, close: closeAll, missingBindings: PLAYWRIGHT_LIVE_MISSING_BINDINGS })
}

export const LIVE_PLAYWRIGHT_UI_STEPS = Object.freeze([
  'admin-copy-link',
  'owner-a-admin-ui',
  'owner-b-company-b-admin-ui',
  'owner-b-company-a-viewer-ui',
  'owner-b-direct-url-denial',
  'owner-b-offline-blocked',
  'owner-b-online-recovered',
  'owner-b-company-b-restored',
  'owner-b-two-tab-logout',
  'owner-mailbox-accountant-ui',
  'owner-mailbox-reload-recovered',
])

const uiBounded = (promise, timeoutMs, onTimeout = () => {}) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { try { onTimeout() } finally { reject(new Error('live_playwright_adapter_blocked')) } }, timeoutMs)
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})

const uiRow = (step, observation) => {
  if (!LIVE_PLAYWRIGHT_UI_STEPS.includes(step) || !record(observation)) blocked()
  assertNoSecretMaterial(observation)
  const row = { step, status: 'PASS', observationSha256: sha256(JSON.stringify(observation)) }
  if (step === 'admin-copy-link') {
    if (observation.initialListSource !== 'verified-empty-local-bootstrap') blocked()
    row.initialListSource = observation.initialListSource
  }
  return frozen(row)
}

export function validateLivePlaywrightUiEvidence(rows) {
  if (!Array.isArray(rows) || rows.length !== LIVE_PLAYWRIGHT_UI_STEPS.length) blocked()
  const byStep = new Map()
  for (const row of rows) {
    const keys = row?.step === 'admin-copy-link' ? ['step', 'status', 'observationSha256', 'initialListSource'] : ['step', 'status', 'observationSha256']
    if (!exactKeys(row, keys) || !LIVE_PLAYWRIGHT_UI_STEPS.includes(row.step) ||
        row.status !== 'PASS' || !hex64(row.observationSha256) || byStep.has(row.step)) blocked()
    if (row.step === 'admin-copy-link' && row.initialListSource !== 'verified-empty-local-bootstrap') blocked()
    byStep.set(row.step, row)
  }
  if (LIVE_PLAYWRIGHT_UI_STEPS.some(step => !byStep.has(step))) blocked()
  const ordered = LIVE_PLAYWRIGHT_UI_STEPS.map(step => byStep.get(step))
  return frozen({ status: 'PASS', evidence: ordered, evidenceSha256: sha256(JSON.stringify(ordered)) })
}

/**
 * Drive the real owner-A invitation dialog for createMailboxCancelledInvite.
 * The callable request is held until the durable executor permit exists. Raw
 * link/token values remain in the page and the injected capability summarizer.
 */
export function createAdminInvitationPlaywrightDriver({
  chromium, browserBinder, secretActions, summarizeInvitation, summarizeList,
  localStaticOrigin = 'http://127.0.0.1:5177', waitTimeoutMs = 20_000,
}) {
  if (!chromium || typeof chromium.launch !== 'function' || !browserBinder || typeof browserBinder.bind !== 'function' ||
      !exactKeys(secretActions, ['signInOwnerA', 'fillInviteMailbox']) ||
      Object.values(secretActions).some(value => typeof value !== 'function') ||
      [summarizeInvitation, summarizeList].some(value => typeof value !== 'function') ||
      localStaticOrigin !== 'http://127.0.0.1:5177' || !Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 10 || waitTimeoutMs > 60_000) blocked()
  let browser = null, context = null, page = null, routeHandler = null, held = null, heldWaiter = null
  let expectedCompanyId = null, initialListFulfilled = false, postCreateList = null, postCreateListWaiter = null, postCreateListDispatched = false
  let opened = false, prepared = false, dispatched = false, evidence = null, closed = false
  const close = async () => {
    if (closed) return
    closed = true
    if (page) {
      try {
        await uiBounded(page.evaluate(async () => {
          const clipboard = navigator.clipboard
          if (!clipboard || typeof clipboard.writeText !== 'function' || typeof clipboard.readText !== 'function') throw new Error('clipboard_unavailable')
          await clipboard.writeText('')
          if (await clipboard.readText() !== '') throw new Error('clipboard_clear_mismatch')
        }), waitTimeoutMs)
      } catch { /* the active operation already fails closed */ }
    }
    try { if (context) await uiBounded(context.close(), waitTimeoutMs) } catch { /* best effort */ }
    try { if (browser) await uiBounded(browser.close(), waitTimeoutMs) } catch { /* best effort */ }
  }
  const failHeld = async route => {
    try { await uiBounded(route.abort(), waitTimeoutMs) } catch { /* best effort */ }
    if (heldWaiter) { heldWaiter.resolve(null); heldWaiter = null }
  }
  const interfaceValue = {
    async open() {
      if (opened || closed) blocked()
      opened = true
      try {
        browser = await uiBounded(chromium.launch({ headless: false }), waitTimeoutMs)
        context = await uiBounded(browser.newContext({ serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'],
          viewport: { width: 1280, height: 900 } }), waitTimeoutMs)
        await uiBounded(context.route('**/*', async route => {
          try {
            const request = route.request()
            const decision = await uiBounded(browserBinder.bind({ method: request.method(), url: request.url(), postData: request.postData() }), waitTimeoutMs)
            if (!decision || decision.action !== 'continue') return route.abort()
            return route.continue()
          } catch { return route.abort() }
        }), waitTimeoutMs)
        page = await uiBounded(context.newPage(), waitTimeoutMs)
        page.setDefaultTimeout(waitTimeoutMs)
        routeHandler = async route => {
          const request = route.request()
          let classification
          try { classification = classifyLiveBrowserRequest(request.method(), request.url()) } catch { return route.fallback() }
          if (classification.kind === 'callable' && classification.operation === 'listInvitations') {
            let body
            try { body = JSON.parse(request.postData()) } catch { return failHeld(route) }
            if (!exactKeys(body, ['data']) || !exactKeys(body.data, ['companyId', 'pageSize']) ||
                body.data.companyId !== expectedCompanyId || body.data.pageSize !== 20) return failHeld(route)
            if (!initialListFulfilled && prepared && !held && !dispatched) {
              initialListFulfilled = true
              return route.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify({ data: { items: [], nextCursor: null } }) })
            }
            if (initialListFulfilled && dispatched && !postCreateList && !postCreateListDispatched) {
              const postData = request.postData()
              postCreateList = { route, request, method: request.method(), url: request.url(), postData,
                requestSha256: sha256(postData) }
              if (postCreateListWaiter) { postCreateListWaiter.resolve(postCreateList.requestSha256); postCreateListWaiter = null }
              return
            }
            return failHeld(route)
          }
          if (!prepared || dispatched || held || classification.kind !== 'callable' || classification.operation !== 'inviteMember') return route.fallback()
          const postData = request.postData()
          if (typeof postData !== 'string') return failHeld(route)
          held = { route, request, method: request.method(), url: request.url(), postData, requestSha256: sha256(postData) }
          if (heldWaiter) { heldWaiter.resolve(held.requestSha256); heldWaiter = null }
        }
        await uiBounded(page.route('**/*', routeHandler), waitTimeoutMs)
        await uiBounded(page.goto(`${localStaticOrigin}/finapp/#/login`, { waitUntil: 'networkidle', timeout: waitTimeoutMs }), waitTimeoutMs)
        const signedIn = await uiBounded(secretActions.signInOwnerA(page), waitTimeoutMs)
        if (!exactKeys(signedIn, ['signedIn']) || signedIn.signedIn !== true) blocked()
        await uiBounded(page.waitForURL(`${localStaticOrigin}/finapp/#/`, { timeout: waitTimeoutMs }), waitTimeoutMs)
        return frozen({ opened: true, visible: true, persistent: false })
      } catch { await close(); blocked() }
    },
    async prepareCancelledInvitation(input) {
      if (!page || prepared || held || dispatched || evidence) blocked()
      if (!exactKeys(input, ['companyId']) || !safeId(input.companyId)) blocked()
      expectedCompanyId = input.companyId
      prepared = true
      const waiting = new Promise((resolve, reject) => { heldWaiter = { resolve, reject } })
      try {
        await uiBounded(page.goto(`${localStaticOrigin}/finapp/#/users`, { waitUntil: 'networkidle', timeout: waitTimeoutMs }), waitTimeoutMs)
        if (!initialListFulfilled) blocked()
        await uiBounded(page.getByRole('region', { name: 'Приглашения', exact: true }).waitFor({ timeout: waitTimeoutMs }), waitTimeoutMs)
        await uiBounded(page.getByRole('button', { name: 'Пригласить по email', exact: true }).click(), waitTimeoutMs)
        const dialog = page.getByRole('dialog')
        await uiBounded(dialog.waitFor({ timeout: waitTimeoutMs }), waitTimeoutMs)
        const filled = await uiBounded(secretActions.fillInviteMailbox(page, dialog.getByLabel('Email', { exact: true })), waitTimeoutMs)
        if (!exactKeys(filled, ['filled']) || filled.filled !== true) blocked()
        await uiBounded(dialog.getByRole('combobox').selectOption('accountant'), waitTimeoutMs)
        const click = uiBounded(dialog.getByRole('button', { name: 'Создать приглашение', exact: true }).click(), waitTimeoutMs)
        const requestSha256 = await uiBounded(waiting, waitTimeoutMs, () => { heldWaiter = null })
        await click
        if (!hex64(requestSha256) || held?.requestSha256 !== requestSha256) blocked()
        return frozen({ requestSha256 })
      } catch { if (held) await failHeld(held.route); await close(); blocked() }
    },
    async dispatchCancelledInvitation(permit) {
      if (!held || dispatched || !record(permit) || permit.requestSha256 !== held.requestSha256) blocked()
      dispatched = true
      const current = held
      try {
        const decision = await uiBounded(browserBinder.bind({ method: current.method, url: current.url, postData: current.postData }), waitTimeoutMs)
        if (!decision || decision.action !== 'continue') { await failHeld(current.route); blocked() }
        await uiBounded(current.route.continue(), waitTimeoutMs)
        const response = await uiBounded(current.request.response(), waitTimeoutMs)
        const result = await uiBounded(summarizeInvitation(response, { requestSha256: current.requestSha256 }), waitTimeoutMs)
        if (!exactKeys(result, ['requestSha256', 'outcomeSha256', 'sanitized']) || result.requestSha256 !== current.requestSha256 ||
            !hex64(result.outcomeSha256) || !exactKeys(result.sanitized, ['disposition', 'inviteId', 'capabilitySha256', 'expiresAtUtc']) ||
            result.sanitized.disposition !== 'SUCCESS' || !safeId(result.sanitized.inviteId) || !hex64(result.sanitized.capabilitySha256)) blocked()
        assertNoSecretMaterial(result)
        const dialog = page.getByRole('dialog')
        await uiBounded(dialog.getByLabel('Ссылка', { exact: true }).waitFor({ timeout: waitTimeoutMs }), waitTimeoutMs)
        await uiBounded(dialog.getByRole('button', { name: 'Копировать ссылку', exact: true }).click(), waitTimeoutMs)
        await uiBounded(dialog.getByRole('button', { name: 'Скопировано', exact: true }).waitFor({ timeout: waitTimeoutMs }), waitTimeoutMs)
        const clipboard = await uiBounded(page.evaluate(async expected => {
          const api = navigator.clipboard
          if (!api || typeof api.writeText !== 'function' || typeof api.readText !== 'function') throw new Error('clipboard_unavailable')
          const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
            .map(byte => byte.toString(16).padStart(2, '0')).join('')
          let safe = null
          try {
            const label = [...document.querySelectorAll('label')].find(node => node.textContent?.startsWith('Ссылка'))
            const input = label?.querySelector('input')
            if (!(input instanceof HTMLInputElement) || !input.readOnly) throw new Error('link_field_missing')
            const displayed = input.value
            const copied = await api.readText()
            const parsed = new URL(copied)
            const token = parsed.hash.startsWith('#token=') ? parsed.hash.slice(7) : ''
            if (copied !== displayed || parsed.origin !== expected.origin || parsed.search !== '' ||
                parsed.pathname !== `/finapp/accept-invite/${encodeURIComponent(expected.inviteId)}` || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
                await digest(token) !== expected.capabilitySha256) throw new Error('clipboard_mismatch')
            safe = { clipboardApi: true, displayedMatched: true, linkShapeMatched: true, capabilityMatched: true,
              linkSha256: await digest(copied) }
          } finally {
            await api.writeText('')
            if (await api.readText() !== '') throw new Error('clipboard_clear_mismatch')
          }
          return { ...safe, cleared: true, clearReadbackMatched: true }
        }, { origin: localStaticOrigin, inviteId: result.sanitized.inviteId,
          capabilitySha256: result.sanitized.capabilitySha256 }), waitTimeoutMs)
        if (!exactKeys(clipboard, ['clipboardApi', 'displayedMatched', 'linkShapeMatched', 'capabilityMatched', 'linkSha256', 'cleared', 'clearReadbackMatched']) ||
            Object.entries(clipboard).some(([key, value]) => key !== 'linkSha256' && value !== true) || !hex64(clipboard.linkSha256)) blocked()
        evidence = uiRow('admin-copy-link', { requestSha256: result.requestSha256, outcomeSha256: result.outcomeSha256,
          inviteId: result.sanitized.inviteId, capabilitySha256: result.sanitized.capabilitySha256, linkSha256: clipboard.linkSha256,
          clipboardCleared: true, initialListSource: 'verified-empty-local-bootstrap' })
        await uiBounded(dialog.getByRole('button', { name: 'Закрыть', exact: true }).click(), waitTimeoutMs)
        if (await uiBounded(dialog.getByLabel('Ссылка', { exact: true }).count(), waitTimeoutMs) !== 0) blocked()
        held = null
        return frozen(result)
      } catch {
        try {
          await uiBounded(page.evaluate(async () => {
            const api = navigator.clipboard
            if (!api || typeof api.writeText !== 'function' || typeof api.readText !== 'function') throw new Error('clipboard_unavailable')
            await api.writeText('')
            if (await api.readText() !== '') throw new Error('clipboard_clear_mismatch')
          }), waitTimeoutMs)
        } catch { /* remain blocked */ }
        await close(); blocked()
      }
    },
    async takePreparedPostCreateList() {
      if (!dispatched || !evidence || postCreateListDispatched) blocked()
      const requestSha256 = postCreateList?.requestSha256 ?? await uiBounded(new Promise((resolve, reject) => {
        if (postCreateListWaiter) blocked()
        postCreateListWaiter = { resolve, reject }
      }), waitTimeoutMs, () => { postCreateListWaiter = null })
      if (!hex64(requestSha256)) blocked()
      return frozen({ requestSha256 })
    },
    async dispatchPostCreateList(permit) {
      if (!postCreateList || postCreateListDispatched || !record(permit) || permit.requestSha256 !== postCreateList.requestSha256) blocked()
      postCreateListDispatched = true
      const current = postCreateList
      try {
        const decision = await uiBounded(browserBinder.bind({ method: current.method, url: current.url, postData: current.postData }), waitTimeoutMs)
        if (!decision || decision.action !== 'continue') { await failHeld(current.route); blocked() }
        await uiBounded(current.route.continue(), waitTimeoutMs)
        const response = await uiBounded(current.request.response(), waitTimeoutMs)
        const result = await uiBounded(summarizeList(response, { requestSha256: current.requestSha256 }), waitTimeoutMs)
        if (!exactKeys(result, ['requestSha256', 'outcomeSha256', 'sanitized']) || result.requestSha256 !== current.requestSha256 ||
            !hex64(result.outcomeSha256) || !exactKeys(result.sanitized, ['disposition', 'itemCount', 'itemsSha256', 'nextCursorPresent']) ||
            result.sanitized.disposition !== 'SUCCESS' || result.sanitized.itemCount !== 1 ||
            !hex64(result.sanitized.itemsSha256) || result.sanitized.nextCursorPresent !== false) blocked()
        assertNoSecretMaterial(result)
        postCreateList = null
        return frozen(result)
      } catch { await close(); blocked() }
    },
    readEvidence() { if (!evidence) blocked(); return frozen(evidence) },
    close,
  }
  return Object.freeze(interfaceValue)
}

/** Run the mutation-free UI portion after all fixture/read-only slots. Every
 * row comes from fixed Playwright observations. Injected sign-in code owns only
 * owner-A/B credentials; the verified mailbox page is borrowed from its
 * ownerHandoff and remains owned by that lifecycle. */
export function createPostFixturePlaywrightUiVerifier({
  chromium, browserBinder, secretActions, borrowVerifiedMailboxSession,
  companyNames = { a: 'Stage8 Company A', b: 'Stage8 Company B' },
  localStaticOrigin = 'http://127.0.0.1:5177', waitTimeoutMs = 20_000,
}) {
  if (!chromium || typeof chromium.launch !== 'function' || !browserBinder || typeof browserBinder.bind !== 'function' ||
      !exactKeys(secretActions, ['signIn']) || typeof secretActions.signIn !== 'function' ||
      typeof borrowVerifiedMailboxSession !== 'function' ||
      !exactKeys(companyNames, ['a', 'b']) || Object.values(companyNames).some(value => typeof value !== 'string' ||
        value.length < 1 || value.length > 80 || value !== value.trim()) || companyNames.a === companyNames.b ||
      localStaticOrigin !== 'http://127.0.0.1:5177' || !Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 10 || waitTimeoutMs > 60_000) blocked()
  let browser = null, ran = false, closed = false
  const contexts = new Set()
  const close = async () => {
    if (closed) return
    closed = true
    for (const context of contexts) { try { await uiBounded(context.close(), waitTimeoutMs) } catch { /* best effort */ } }
    contexts.clear()
    try { if (browser) await uiBounded(browser.close(), waitTimeoutMs) } catch { /* best effort */ }
  }
  const bindContext = async context => uiBounded(context.route('**/*', async route => {
    try {
      const request = route.request()
      const decision = await uiBounded(browserBinder.bind({ method: request.method(), url: request.url(), postData: request.postData() }), waitTimeoutMs)
      if (!decision || decision.action !== 'continue') return route.abort()
      return route.continue()
    } catch { return route.abort() }
  }), waitTimeoutMs)
  const openIdentity = async identity => {
    const context = await uiBounded(browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } }), waitTimeoutMs)
    contexts.add(context)
    await bindContext(context)
    const page = await uiBounded(context.newPage(), waitTimeoutMs)
    page.setDefaultTimeout(waitTimeoutMs)
    await uiBounded(page.goto(`${localStaticOrigin}/finapp/#/login`, { waitUntil: 'networkidle', timeout: waitTimeoutMs }), waitTimeoutMs)
    const signedIn = await uiBounded(secretActions.signIn(page, identity), waitTimeoutMs)
    if (!exactKeys(signedIn, ['signedIn']) || signedIn.signedIn !== true) blocked()
    assertNoSecretMaterial(signedIn)
    await uiBounded(page.waitForURL(`${localStaticOrigin}/finapp/#/`, { timeout: waitTimeoutMs }), waitTimeoutMs)
    await uiBounded(page.getByRole('heading', { name: 'Дашборд', exact: true }).waitFor({ timeout: waitTimeoutMs }), waitTimeoutMs)
    return { context, page }
  }
  const count = (locatorValue, expected) => uiBounded(locatorValue.count(), waitTimeoutMs).then(value => {
    if (value !== expected) blocked()
  })
  const visible = locatorValue => uiBounded(locatorValue.waitFor({ state: 'visible', timeout: waitTimeoutMs }), waitTimeoutMs)
  const goto = (page, hashPath) => uiBounded(page.goto(`${localStaticOrigin}/finapp/#${hashPath}`,
    { waitUntil: 'networkidle', timeout: waitTimeoutMs }), waitTimeoutMs)
  const expectCompanyButton = (page, name) => visible(page.getByRole('button', { name, exact: true }))
  const switchCompany = async (page, from, to) => {
    await uiBounded(page.getByRole('button', { name: from, exact: true }).click(), waitTimeoutMs)
    await uiBounded(page.getByRole('button', { name: to, exact: true }).click(), waitTimeoutMs)
  }
  const rows = []
  const add = (step, observation) => rows.push(uiRow(step, observation))
  return Object.freeze({
    async run() {
      if (ran || closed) blocked()
      ran = true
      try {
        browser = await uiBounded(chromium.launch({ headless: false }), waitTimeoutMs)

        const ownerA = await openIdentity('ownerA')
        await expectCompanyButton(ownerA.page, companyNames.a)
        await count(ownerA.page.getByRole('link', { name: 'Пользователи', exact: true }), 1)
        await goto(ownerA.page, '/settings')
        await visible(ownerA.page.getByRole('heading', { name: 'Настройки', exact: true }))
        await count(ownerA.page.getByRole('button', { name: 'Сохранить', exact: true }), 1)
        add('owner-a-admin-ui', { identity: 'ownerA', company: 'a', role: 'admin', usersNavigation: true, companyWriteControl: true })
        await uiBounded(ownerA.context.close(), waitTimeoutMs); contexts.delete(ownerA.context)

        const ownerB = await openIdentity('ownerB')
        await expectCompanyButton(ownerB.page, companyNames.b)
        await count(ownerB.page.getByRole('link', { name: 'Пользователи', exact: true }), 1)
        await goto(ownerB.page, '/settings')
        await count(ownerB.page.getByRole('button', { name: 'Сохранить', exact: true }), 1)
        add('owner-b-company-b-admin-ui', { identity: 'ownerB', company: 'b', role: 'admin', usersNavigation: true, companyWriteControl: true })

        await switchCompany(ownerB.page, companyNames.b, companyNames.a)
        await visible(ownerB.page.getByText('Режим только для чтения', { exact: false }))
        await count(ownerB.page.getByRole('link', { name: 'Пользователи', exact: true }), 0)
        add('owner-b-company-a-viewer-ui', { identity: 'ownerB', company: 'a', role: 'viewer', readOnlyBanner: true, usersNavigation: false })

        await goto(ownerB.page, '/users')
        await visible(ownerB.page.getByText('Управление пользователями доступно администратору активной компании после загрузки прав.', { exact: true }))
        await count(ownerB.page.getByRole('button', { name: 'Пригласить по email', exact: true }), 0)
        add('owner-b-direct-url-denial', { identity: 'ownerB', company: 'a', route: '/users', invitationUi: false, denialVisible: true })

        await uiBounded(ownerB.context.setOffline(true), waitTimeoutMs)
        let offlineRejected = false
        try { await uiBounded(ownerB.page.reload({ waitUntil: 'domcontentloaded', timeout: waitTimeoutMs }), waitTimeoutMs) } catch { offlineRejected = true }
        if (!offlineRejected) blocked()
        add('owner-b-offline-blocked', { identity: 'ownerB', company: 'a', reloadRejected: true, mutationAttempted: false })
        await uiBounded(ownerB.context.setOffline(false), waitTimeoutMs)
        await goto(ownerB.page, '/settings')
        await visible(ownerB.page.getByText('Режим только для чтения', { exact: false }))
        await count(ownerB.page.getByRole('button', { name: 'Сохранить', exact: true }), 0)
        add('owner-b-online-recovered', { identity: 'ownerB', company: 'a', role: 'viewer', directRoute: '/settings', recovered: true })

        await switchCompany(ownerB.page, companyNames.a, companyNames.b)
        await count(ownerB.page.getByRole('link', { name: 'Пользователи', exact: true }), 1)
        await count(ownerB.page.getByRole('button', { name: 'Сохранить', exact: true }), 1)
        add('owner-b-company-b-restored', { identity: 'ownerB', company: 'b', role: 'admin', restored: true })

        await goto(ownerB.page, '/')
        const secondTab = await uiBounded(ownerB.context.newPage(), waitTimeoutMs)
        secondTab.setDefaultTimeout(waitTimeoutMs)
        await goto(secondTab, '/')
        await visible(secondTab.getByRole('heading', { name: 'Дашборд', exact: true }))
        await uiBounded(ownerB.page.getByTitle('Выйти').click(), waitTimeoutMs)
        await Promise.all([
          uiBounded(ownerB.page.waitForURL(`${localStaticOrigin}/finapp/#/login`, { timeout: waitTimeoutMs }), waitTimeoutMs),
          uiBounded(secondTab.waitForURL(`${localStaticOrigin}/finapp/#/login`, { timeout: waitTimeoutMs }), waitTimeoutMs),
        ])
        add('owner-b-two-tab-logout', { identity: 'ownerB', tabs: 2, firstSignedOut: true, secondSignedOut: true })
        await uiBounded(ownerB.context.close(), waitTimeoutMs); contexts.delete(ownerB.context)

        const mailbox = await uiBounded(borrowVerifiedMailboxSession(), waitTimeoutMs)
        if (!exactKeys(mailbox, ['page', 'context']) || !mailbox.page || !mailbox.context ||
            typeof mailbox.page.goto !== 'function' || typeof mailbox.page.reload !== 'function' ||
            typeof mailbox.page.evaluate !== 'function' || typeof mailbox.page.getByRole !== 'function' ||
            typeof mailbox.page.getByText !== 'function' || typeof mailbox.page.setDefaultTimeout !== 'function' ||
            typeof mailbox.page.isClosed !== 'function' || mailbox.page.isClosed()) blocked()
        mailbox.page.setDefaultTimeout(waitTimeoutMs)
        if (await uiBounded(mailbox.page.evaluate(expected => location.origin === expected, localStaticOrigin), waitTimeoutMs) !== true) blocked()
        await expectCompanyButton(mailbox.page, companyNames.a)
        await count(mailbox.page.getByText('Режим только для чтения', { exact: false }), 0)
        await count(mailbox.page.getByRole('link', { name: 'Пользователи', exact: true }), 0)
        await goto(mailbox.page, '/transactions')
        await visible(mailbox.page.getByRole('heading', { name: 'Операции', exact: true }))
        if (await uiBounded(mailbox.page.getByRole('button', { name: 'Добавить', exact: true }).count(), waitTimeoutMs) < 1) blocked()
        add('owner-mailbox-accountant-ui', { identity: 'ownerMailbox', company: 'a', role: 'accountant', readOnlyBanner: false, writeControl: true })
        await uiBounded(mailbox.page.reload({ waitUntil: 'networkidle', timeout: waitTimeoutMs }), waitTimeoutMs)
        await visible(mailbox.page.getByRole('heading', { name: 'Операции', exact: true }))
        await count(mailbox.page.getByText('Режим только для чтения', { exact: false }), 0)
        add('owner-mailbox-reload-recovered', { identity: 'ownerMailbox', company: 'a', role: 'accountant', reloaded: true })

        return frozen({ status: 'UI_ACCEPTANCE_RECONCILED', evidence: rows,
          evidenceSha256: sha256(JSON.stringify(rows)) })
      } catch { await close(); blocked() }
    },
    close,
  })
}

const exactOperationKeys = specs => specs.map(spec => spec.slot)
function validateOperations(operations) {
  if (!exactKeys(operations, ['fixtures', 'readOnly', 'clipboard']) ||
      !exactKeys(operations.fixtures, exactOperationKeys(FIXTURE_MUTATION_SLOT_SPECS)) ||
      !exactKeys(operations.readOnly, exactOperationKeys(READ_ONLY_SLOT_SPECS)) ||
      !exactKeys(operations.clipboard, ['clear'])) blocked()
  for (const group of [operations.fixtures, operations.readOnly]) {
    for (const operation of Object.values(group)) if (!exactKeys(operation, ['mode', 'prepare', 'dispatch', 'readback']) ||
        !['bound-callback', 'held-normal-path', 'owner-handoff', 'provider-admin'].includes(operation.mode) ||
        [operation.prepare, operation.dispatch, operation.readback].some(value => typeof value !== 'function')) blocked()
  }
  for (const [slot, operation] of Object.entries(operations.fixtures)) {
    const expectedMode = ['createOwnerAAuth', 'createOwnerBAuth'].includes(slot) ? 'provider-admin'
      : ['createMailboxCancelledInvite', 'acceptMailboxFinalInvite'].includes(slot) ? 'held-normal-path'
        : slot === 'createOwnerMailboxAuth' ? 'owner-handoff' : 'bound-callback'
    if (operation.mode !== expectedMode) blocked()
  }
  for (const [slot, operation] of Object.entries(operations.readOnly)) {
    const expectedMode = ['listCancelledPending', 'mailboxCompanyAAccountant'].includes(slot) ? 'held-normal-path' : 'bound-callback'
    if (operation.mode !== expectedMode) blocked()
  }
  if (typeof operations.clipboard.clear !== 'function') blocked()
}

/** Deterministic six-scenario composer. Every operation prepares only safe
 * bindings/hashes, then receives a one-use bind callback after the executor has
 * durably appended MAY. Reconciliation is synced before advancing. */
export function createSixScenarioComposer({ executor, browserBinder, ownerHandoff, operations }) {
  validateOperations(operations)
  if (!executor || !browserBinder || !ownerHandoff) blocked()
  let ran = false, ownerOpened = false
  const evidence = []
  const recordEvidence = (scenario, kind, slot, result) => {
    const item = { scenario, kind, slot, readbackSha256: result?.readbackSha256 ?? null }
    if (item.readbackSha256 !== null && !hex64(item.readbackSha256)) blocked()
    assertNoSecretMaterial(item); evidence.push(Object.freeze(item))
  }
  const runBound = async (kind, spec, operation) => {
    const prepared = await operation.prepare(executor.snapshot())
    const expected = kind === 'fixture' ? ['requestSha256', 'binding'] : ['requestSha256', 'binding']
    if (!exactKeys(prepared, expected) || !hex64(prepared.requestSha256) || !record(prepared.binding)) blocked()
    let binds = 0
    const execute = kind === 'fixture' ? executor.executeFixtureSlot.bind(executor) : executor.executeReadOnlyCallable.bind(executor)
    const result = await execute({ slot: spec.slot, ...(kind === 'readOnly' ? { callable: spec.callable } : {}), ...prepared,
      dispatch: async permit => {
        if (operation.mode !== 'provider-admin') {
          if (kind === 'fixture') browserBinder.armMutation(); else browserBinder.armCallable()
        }
        const dispatched = await operation.dispatch(permit, operation.mode === 'bound-callback'
          ? async request => { binds++; return browserBinder.bind(request) } : undefined)
        if ((operation.mode === 'bound-callback' && binds !== 1) ||
            (['held-normal-path', 'provider-admin'].includes(operation.mode) && binds !== 0)) blocked()
        return dispatched
      }, readback: operation.readback })
    if (operation.mode === 'provider-admin') {
      if (typeof browserBinder.syncProviderMutationReconciled !== 'function') blocked()
      browserBinder.syncProviderMutationReconciled()
    } else {
      if (kind === 'fixture') browserBinder.syncMutationReconciled(); else browserBinder.syncCallableReconciled()
    }
    recordEvidence(kind === 'fixture' ? scenarioForFixture[spec.slot] : scenarioForReadOnly[spec.slot], kind, spec.slot, result)
  }
  const runOwnerRegistration = async (spec, operation) => {
    const captured = await operation.prepare(executor.snapshot())
    if (!exactKeys(captured, ['captured']) || captured.captured !== true) blocked()
    const prepared = await ownerHandoff.prepareRegistration()
    if (!exactKeys(prepared, ['requestSha256', 'binding']) || !hex64(prepared.requestSha256) || !record(prepared.binding)) blocked()
    const result = await executor.executeFixtureSlot({ slot: spec.slot, ...prepared,
      dispatch: permit => ownerHandoff.dispatchRegistration(permit), readback: operation.readback })
    browserBinder.syncMutationReconciled()
    recordEvidence(scenarioForFixture[spec.slot], 'fixture', spec.slot, result)
  }
  return Object.freeze({
    async run() {
      if (ran) blocked(); ran = true
      let readOnlyIndex = 0
      try {
        await executor.start()
        if (typeof browserBinder.syncStarted !== 'function') blocked()
        browserBinder.syncStarted()
        for (let index = 0; index < FIXTURE_MUTATION_SLOT_SPECS.length; index++) {
          const spec = FIXTURE_MUTATION_SLOT_SPECS[index]
          if (spec.slot === 'createOwnerMailboxAuth') {
            await ownerHandoff.open(); ownerOpened = true
            await ownerHandoff.awaitCredentialReady()
          }
          if (spec.slot === 'acceptMailboxFinalInvite') {
            const proof = await ownerHandoff.awaitVerifiedSession(executor.verificationSessionChallenge())
            executor.markVerifiedSession(proof); browserBinder.syncVerifiedSession()
          }
          if (spec.slot === 'createOwnerMailboxAuth') await runOwnerRegistration(spec, operations.fixtures[spec.slot])
          else await runBound('fixture', spec, operations.fixtures[spec.slot])
          if (spec.slot === 'denyUnverifiedMailboxAccept') {
            const prepared = await ownerHandoff.prepareVerification()
            if (!exactKeys(prepared, ['requestSha256']) || !hex64(prepared.requestSha256)) blocked()
            browserBinder.reserveVerificationEmail(prepared.requestSha256)
            await executor.executeVerificationEmail({ requestSha256: prepared.requestSha256,
              dispatch: permit => ownerHandoff.dispatchVerification(permit) })
            browserBinder.syncVerificationEmailSent()
          }
          while (READ_ONLY_SLOT_SPECS[readOnlyIndex]?.afterFixtureCount === index + 1) {
            const readSpec = READ_ONLY_SLOT_SPECS[readOnlyIndex++]
            await runBound('readOnly', readSpec, operations.readOnly[readSpec.slot])
          }
        }
        if (readOnlyIndex !== READ_ONLY_SLOT_SPECS.length) blocked()
        const scenarios = new Set(evidence.map(item => item.scenario))
        if (SCENARIO_NAMES.some(name => !scenarios.has(name))) blocked()
        return frozen({ status: 'SCENARIOS_RECONCILED', scenarios: [...SCENARIO_NAMES], evidence })
      } finally {
        try { await operations.clipboard.clear() } catch { /* best effort */ }
        if (ownerOpened) { try { await ownerHandoff.close() } catch { /* best effort */ } }
      }
    },
  })
}

export function createLivePlaywrightScenarioComposition({ executorOptions, browserBinderOptions, openOwnerSession, pauseOwner, operations }) {
  const executor = createLiveStagingExecutor(executorOptions)
  const browserBinder = createLiveBrowserRequestBinder(browserBinderOptions)
  const ownerHandoff = createVisibleOwnerHandoff({ openSession: openOwnerSession, pause: pauseOwner })
  return Object.freeze({ executor, browserBinder, ownerHandoff,
    composer: createSixScenarioComposer({ executor, browserBinder, ownerHandoff, operations }) })
}
