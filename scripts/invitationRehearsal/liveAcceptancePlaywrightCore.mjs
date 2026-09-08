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
      : slot === 'acceptMailboxFinalInvite' ? 'held-normal-path'
        : slot === 'createOwnerMailboxAuth' ? 'owner-handoff' : 'bound-callback'
    if (operation.mode !== expectedMode) blocked()
  }
  for (const [slot, operation] of Object.entries(operations.readOnly)) {
    const expectedMode = slot === 'mailboxCompanyAAccountant' ? 'held-normal-path' : 'bound-callback'
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
