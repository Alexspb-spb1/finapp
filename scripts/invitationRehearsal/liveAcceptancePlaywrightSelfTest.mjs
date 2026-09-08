import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { FIXTURE_MUTATION_SLOT_SPECS, SCENARIO_NAMES } from './liveAcceptanceCore.mjs'
import { READ_ONLY_SLOT_SPECS } from './liveAcceptanceExecutorCore.mjs'
import {
  PLAYWRIGHT_LIVE_MISSING_BINDINGS, SIX_SCENARIO_SCHEDULE,
  LIVE_PLAYWRIGHT_UI_STEPS, createAdminInvitationPlaywrightDriver, createBoundedVisiblePlaywrightSessionFactory,
  createHeldPlaywrightRequestBridge, createPostFixturePlaywrightUiVerifier, createSixScenarioComposer,
  validateLivePlaywrightUiEvidence,
} from './liveAcceptancePlaywrightCore.mjs'

const h = value => createHash('sha256').update(value).digest('hex')

function harness({ failSlot = null } = {}) {
  const calls = [], secrets = {
    mailbox: 'owner-private@example.invalid', password: 'owner-private-password',
    capability: 'owner-private-capability', idToken: 'owner-private-id-token',
  }
  let fixtureIndex = 0, readOnlyIndex = 0, emailSent = false, verified = false, closed = 0, cleared = 0
  const executor = {
    async start() { calls.push('start') },
    snapshot() { return { nextSlot: fixtureIndex, state: {} } },
    async executeFixtureSlot(input) {
      const spec = FIXTURE_MUTATION_SLOT_SPECS[fixtureIndex]
      assert.equal(input.slot, spec.slot)
      await input.dispatch({ requestSha256: input.requestSha256, slot: input.slot })
      const readback = await input.readback()
      fixtureIndex++
      return { slot: input.slot, readbackSha256: readback.readbackSha256 }
    },
    async executeReadOnlyCallable(input) {
      const spec = READ_ONLY_SLOT_SPECS[readOnlyIndex]
      assert.equal(input.slot, spec.slot); assert.equal(input.callable, spec.callable)
      await input.dispatch({ requestSha256: input.requestSha256, slot: input.slot })
      const readback = await input.readback()
      readOnlyIndex++
      return { slot: input.slot, readbackSha256: readback.readbackSha256 }
    },
    async executeVerificationEmail(input) { await input.dispatch({ requestSha256: input.requestSha256 }); emailSent = true },
    verificationSessionChallenge() { assert.equal(emailSent, true); return { challengeSha256: h('challenge') } },
    markVerifiedSession() { verified = true },
  }
  const binder = {
    syncStarted() { calls.push('sync-started') },
    armMutation() { calls.push('arm-mutation') }, armCallable() { calls.push('arm-callable') },
    async bind(request) { assert.equal(String(request.url).includes('finapp-staging'), false); calls.push('bind'); return { action: 'continue' } },
    syncMutationReconciled() { calls.push('sync-mutation') }, syncCallableReconciled() { calls.push('sync-callable') },
    syncProviderMutationReconciled() { calls.push('sync-provider-mutation') },
    reserveVerificationEmail(value) { assert.match(value, /^[a-f0-9]{64}$/); calls.push('reserve-email') },
    armVerificationEmail() { calls.push('arm-email') },
    syncVerificationEmailSent() { calls.push('sync-email') }, syncVerifiedSession() { assert.equal(verified, true); calls.push('sync-verified') },
  }
  const ownerHandoff = {
    async open() { calls.push('owner-open') }, async awaitCredentialReady() { calls.push('credential-ready') },
    async prepareRegistration() { return { requestSha256: h('request:createOwnerMailboxAuth'), binding: { semanticSha256: h('binding:createOwnerMailboxAuth') } } },
    async dispatchRegistration(permit) {
      binder.armMutation()
      await binder.bind({ method: 'POST', url: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator', postData: '{}' })
      return { requestSha256: permit.requestSha256, outcomeSha256: h('registration-outcome'), producedSha256: h('registration-produced') }
    },
    async prepareVerification() { return { requestSha256: h('verification-request') } },
    async dispatchVerification(permit) {
      binder.armVerificationEmail()
      await binder.bind({ method: 'POST', url: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=emulator', postData: '{}' })
      return { requestSha256: permit.requestSha256, outcomeSha256: h('verification-outcome') }
    },
    async awaitVerifiedSession(challenge) { return { ...challenge, sessionProofSha256: h('proof') } },
    async close() { closed++; calls.push('owner-close') },
  }
  const operation = slot => ({
    mode: ['createOwnerAAuth', 'createOwnerBAuth'].includes(slot) ? 'provider-admin'
      : slot === 'createOwnerMailboxAuth' ? 'owner-handoff'
      : ['createMailboxCancelledInvite', 'acceptMailboxFinalInvite', 'listCancelledPending', 'mailboxCompanyAAccountant'].includes(slot)
        ? 'held-normal-path' : 'bound-callback',
    async prepare() {
      // Referencing closure-owned secrets proves they exist during the run;
      // only hashes and semantic labels cross the adapter boundary.
      void secrets.password; void secrets.mailbox; void secrets.capability; void secrets.idToken
      if (slot === 'createOwnerMailboxAuth') return { captured: true }
      return { requestSha256: h(`request:${slot}`), binding: { semanticSha256: h(`binding:${slot}`) } }
    },
    async dispatch(permit, bind) {
      if (slot === failSlot) throw new Error('synthetic-safe-stop')
      const request = { method: 'POST', url: `http://127.0.0.1:5001/demo-finapp/us-central1/${slot}`, postData: '{}' }
      if (bind) await bind(request)
      else if (!['createOwnerAAuth', 'createOwnerBAuth'].includes(slot)) await binder.bind(request)
      return { requestSha256: permit.requestSha256, outcomeSha256: h(`outcome:${slot}`), producedSha256: h(`produced:${slot}`) }
    },
    async readback() { return { readbackSha256: h(`readback:${slot}`) } },
  })
  const operations = {
    fixtures: Object.fromEntries(FIXTURE_MUTATION_SLOT_SPECS.map(spec => [spec.slot, operation(spec.slot)])),
    readOnly: Object.fromEntries(READ_ONLY_SLOT_SPECS.map(spec => [spec.slot, operation(spec.slot)])),
    clipboard: { async clear() { cleared++; calls.push('clipboard-clear') } },
  }
  return { executor, binder, ownerHandoff, operations, calls, secrets,
    counts: () => ({ fixtureIndex, readOnlyIndex, emailSent, verified, closed, cleared }) }
}

test('six-scenario composer executes every exact fixture/read-only slot once with journal bind/sync ordering and no network', async t => {
  const originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => { networkCalls++; throw new Error('network-forbidden') }
  t.after(() => { globalThis.fetch = originalFetch })
  const value = harness()
  const composer = createSixScenarioComposer({ executor: value.executor, browserBinder: value.binder,
    ownerHandoff: value.ownerHandoff, operations: value.operations })
  const result = await composer.run()
  assert.equal(networkCalls, 0)
  assert.deepEqual(result.scenarios, [...SCENARIO_NAMES])
  assert.equal(result.evidence.length, FIXTURE_MUTATION_SLOT_SPECS.length + READ_ONLY_SLOT_SPECS.length)
  assert.deepEqual(value.counts(), { fixtureIndex: 16, readOnlyIndex: 14, emailSent: true, verified: true, closed: 1, cleared: 1 })
  const serialized = JSON.stringify(result)
  for (const secret of Object.values(value.secrets)) assert.equal(serialized.includes(secret), false)
  assert.equal(value.calls.filter(item => item === 'bind').length, 29)
  assert.equal(value.calls.filter(item => item === 'arm-mutation').length, 14)
  assert.equal(value.calls.filter(item => item === 'arm-callable').length, 14)
  assert.equal(value.calls.filter(item => item === 'sync-provider-mutation').length, 2)
  await assert.rejects(() => composer.run())
})

test('schedule names cover all exact slots without duplicates', () => {
  assert.equal(SIX_SCENARIO_SCHEDULE.length, 6)
  assert.deepEqual(SIX_SCENARIO_SCHEDULE.map(row => row.name), [...SCENARIO_NAMES])
  const fixtures = SIX_SCENARIO_SCHEDULE.flatMap(row => row.fixtureSlots)
  const reads = SIX_SCENARIO_SCHEDULE.flatMap(row => row.readOnlySlots)
  assert.equal(new Set(fixtures).size, 16); assert.equal(new Set(reads).size, 14)
  assert.deepEqual(new Set(fixtures), new Set(FIXTURE_MUTATION_SLOT_SPECS.map(row => row.slot)))
  assert.deepEqual(new Set(reads), new Set(READ_ONLY_SLOT_SPECS.map(row => row.slot)))
})

test('safe stop clears clipboard and closes an opened owner browser', async () => {
  const value = harness({ failSlot: 'denyWrongIdentityAccept' })
  const composer = createSixScenarioComposer({ executor: value.executor, browserBinder: value.binder,
    ownerHandoff: value.ownerHandoff, operations: value.operations })
  await assert.rejects(() => composer.run())
  const counts = value.counts()
  assert.equal(counts.cleared, 1)
  assert.equal(counts.closed, 1)
})

test('bounded visible Playwright session exports exact safe methods and keeps secrets in injected page closures', async () => {
  let contextOptions, launchOptions, routeHandler, cleared = 0, closed = 0
  const locator = {
    async click() {}, async evaluate() { return { ready: true, minimumLengthSatisfied: true } },
  }
  const page = {
    getByLabel() { return locator }, getByRole() { return locator }, setDefaultTimeout() {},
    async evaluate(_callback, argument) { if (argument !== undefined) return argument === 'http://127.0.0.1:5177'; return { visible: true, persistent: false, fragmentRemovedBeforeInit: true,
      financialModulesLoaded: false, cachedCompanyDataLoaded: false, capabilityPersisted: false } },
  }
  const context = {
    async addInitScript() {}, async route(_glob, handler) { routeHandler = handler }, async newPage() { return page },
    async close() { closed++ },
  }
  const chromium = { async launch(options) { launchOptions = options; return {
    async newContext(options2) { contextOptions = options2; return context }, async close() { closed++ },
  } } }
  const binder = { async bind(value) { return { action: value.url.includes('blocked.example') ? 'abort' : 'continue' } }, armMutation() {}, armVerificationEmail() {} }
  const privateMailbox = 'private-owner@example.invalid', privateInvite = 'private-capability-url', privatePassword = 'private-password'
  const factory = createBoundedVisiblePlaywrightSessionFactory({ chromium, browserBinder: binder,
    mailboxSha256: h(privateMailbox),
    secretActions: {
      async navigateInvitation(receivedPage) { assert.equal(receivedPage, page); void privateInvite; return { navigated: true } },
      async fillMailbox(receivedPage) { assert.equal(receivedPage, page); void privateMailbox; return { filled: true } },
      async clearClipboard(receivedPage) { assert.equal(receivedPage, page); void privatePassword; cleared++; return { cleared: true } },
    },
    requestBridge: {
      async attach() { return { attached: true } },
      async prepare() { return { requestSha256: h('request') } },
      async release({ permit }) { return { requestSha256: permit.requestSha256, outcomeSha256: h('outcome'), producedSha256: h('produced') } },
      async takePreparedNormal() { return { requestSha256: h('normal') } },
      async confirmVerifiedSession() { assert.fail('live boundary must remain disabled') },
    },
  })
  const session = await factory.openSession({ headless: false, persistent: false, recordHar: false, recordVideo: false, trace: false })
  assert.deepEqual(Object.keys(session).sort(), ['close', 'confirmCredentialReady', 'confirmVerifiedSession', 'dispatchRegistration',
    'dispatchVerification', 'inspectBoundary', 'prepareRegistration', 'prepareVerification'].sort())
  assert.deepEqual(launchOptions, { headless: false })
  assert.equal(contextOptions.serviceWorkers, 'block')
  assert.equal('recordHar' in contextOptions, false); assert.equal('recordVideo' in contextOptions, false)
  assert.equal(typeof routeHandler, 'function')
  let aborted = 0
  await routeHandler({ request: () => ({ method: () => 'GET', url: () => 'https://blocked.example/private', postData: () => null }),
    async abort() { aborted++ }, async continue() { assert.fail('blocked origin continued') } })
  assert.equal(aborted, 1)
  assert.equal((await session.inspectBoundary()).fragmentRemovedBeforeInit, true)
  assert.equal((await session.confirmCredentialReady()).minimumLengthSatisfied, true)
  assert.equal(JSON.stringify(session).includes(privateMailbox), false)
  assert.equal(JSON.stringify(session).includes(privateInvite), false)
  assert.equal(JSON.stringify(session).includes(privatePassword), false)
  await assert.rejects(() => session.confirmVerifiedSession({ challengeSha256: h('challenge') }))
  await session.close()
  assert.equal(cleared, 1); assert.equal(closed, 2)
  assert.deepEqual(factory.missingBindings, [])
  assert.deepEqual(PLAYWRIGHT_LIVE_MISSING_BINDINGS, [])
})

test('held request bridge hashes before release and sends exactly once through the durable binder', async () => {
  let pageRoute, continued = 0, fallback = 0, binds = 0
  const response = { status: () => 200 }
  const request = {
    method: () => 'POST', url: () => 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=private-test-key',
    postData: () => JSON.stringify({ email: 'closure-private', password: 'closure-private' }), async response() { return response },
  }
  const route = { request: () => request, async fallback() { fallback++ }, async abort() {}, async continue() { continued++ } }
  const bridge = createHeldPlaywrightRequestBridge({
    summarizeRegistration: async () => ({ requestSha256: h(request.postData()), outcomeSha256: h('outcome'), producedSha256: h('produced') }),
    summarizeVerification: async () => ({ requestSha256: h('unused'), outcomeSha256: h('unused') }),
    summarizeAccept: async () => ({ requestSha256: h('unused'), outcomeSha256: h('unused'), producedSha256: h('unused') }),
    summarizeAccess: async () => ({ requestSha256: h('unused'), outcomeSha256: h('unused') }),
    getExpectedMailboxUid: () => 'uid_owner_mailbox',
    captureOwnerMailboxForcedRefresh: async () => ({ captured: true }),
    heldWaitTimeoutMs: 20,
  })
  await bridge.attach({ page: { async route(_glob, handler) { pageRoute = handler } }, browserBinder: {
    async bind(value) { binds++; assert.equal(value.postData, request.postData()); return { action: 'continue' } },
  } })
  let triggered = false
  const preparedPromise = bridge.prepare({ operation: 'accounts:signUp', trigger: async () => { triggered = true; void pageRoute(route) } })
  const prepared = await preparedPromise
  assert.equal(triggered, true); assert.equal(continued, 0); assert.equal(fallback, 0)
  assert.deepEqual(Object.keys(prepared), ['requestSha256'])
  const result = await bridge.release({ operation: 'accounts:signUp', permit: { requestSha256: prepared.requestSha256 } })
  assert.equal(result.requestSha256, prepared.requestSha256)
  assert.equal(continued, 1); assert.equal(binds, 1)
  assert.equal(JSON.stringify({ prepared, result }).includes('closure-private'), false)
  await assert.rejects(() => bridge.release({ operation: 'accounts:signUp', permit: { requestSha256: prepared.requestSha256 } }))
})

test('normal path bridge verifies lookup and captures forced refresh before holding accept and access', async () => {
  let pageRoute, binds = 0, refreshCaptures = 0
  const privateValues = ['private-refresh-token', 'private-id-token', 'private-invite-capability', 'private-owner-password']
  const binder = { async bind() { binds++; return { action: 'continue' } } }
  const response = { status: () => 200 }
  const lookupResponse = { status: () => 200, json: async () => ({ users: [{ localId: 'uid_owner_mailbox', emailVerified: true }] }) }
  const refreshResponse = { status: () => 200, json: async () => ({ id_token: privateValues[1], refresh_token: privateValues[0] }) }
  const makeRoute = (method, url, postData, onContinue = null, routeResponse = response) => {
    const request = { method: () => method, url: () => url, postData: () => postData, async response() { return routeResponse } }
    return { request: () => request, async fallback() {}, async abort() { assert.fail(`unexpected abort ${url}`) },
      async continue() { if (onContinue) await onContinue() } }
  }
  const summaries = {
    summarizeRegistration: async (_response, meta) => ({ requestSha256: meta.requestSha256, outcomeSha256: h('registration'), producedSha256: h('registration-produced') }),
    summarizeVerification: async (_response, meta) => ({ requestSha256: meta.requestSha256, outcomeSha256: h('verification') }),
    summarizeAccept: async (_response, meta) => ({ requestSha256: meta.requestSha256, outcomeSha256: h('accept'), producedSha256: h('accept-produced') }),
    summarizeAccess: async (_response, meta) => ({ requestSha256: meta.requestSha256, outcomeSha256: h('access') }),
    getExpectedMailboxUid: () => 'uid_owner_mailbox',
    captureOwnerMailboxForcedRefresh: async received => {
      assert.equal(received, refreshResponse)
      const privateBody = await received.json()
      assert.equal(privateBody.id_token, privateValues[1]); assert.equal(privateBody.refresh_token, privateValues[0])
      refreshCaptures++
      return { captured: true }
    },
    heldWaitTimeoutMs: 20,
  }
  const bridge = createHeldPlaywrightRequestBridge(summaries)
  await bridge.attach({ page: { async route(_glob, handler) { pageRoute = handler } }, browserBinder: binder })
  await assert.rejects(() => bridge.confirmVerifiedSession({ challenge: { challengeSha256: h('fabricated-before-email') }, trigger: async () => {} }))

  const emailBody = JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken: privateValues[1] })
  const emailRoute = makeRoute('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=private-test-key', emailBody)
  const emailPreparedPromise = bridge.prepare({ operation: 'accounts:sendOobCode', trigger: async () => { void pageRoute(emailRoute) } })
  const emailPrepared = await emailPreparedPromise
  await bridge.release({ operation: 'accounts:sendOobCode', permit: { requestSha256: emailPrepared.requestSha256 } })
  await assert.rejects(() => bridge.prepare({ operation: 'accounts:sendOobCode', trigger: async () => {} }))

  const lookup = makeRoute('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=private-test-key', JSON.stringify({ idToken: privateValues[1] }), null, lookupResponse)
  const refresh = makeRoute('POST', 'https://securetoken.googleapis.com/v1/token?key=private-test-key', `grant_type=refresh_token&refresh_token=${privateValues[0]}`, null, refreshResponse)
  const accessBody = JSON.stringify({ data: { companyId: 'safe-company' } })
  const access = makeRoute('POST', 'https://us-central1-finapp-staging.cloudfunctions.net/getCompanyAccess', accessBody)
  const acceptBody = JSON.stringify({ data: { inviteId: 'safe-invite', token: privateValues[2] } })
  const accept = makeRoute('POST', 'https://us-central1-finapp-staging.cloudfunctions.net/acceptInvite', acceptBody,
    async () => { void pageRoute(access) })
  const challenge = { challengeSha256: h('executor-email-bound-challenge') }
  const proof = await bridge.confirmVerifiedSession({ challenge, trigger: async () => {
    await pageRoute(lookup); await pageRoute(refresh); void pageRoute(accept)
  } })
  assert.deepEqual(proof, { ...challenge, verified: true, reloaded: true, forcedRefresh: true })
  assert.equal(refreshCaptures, 1)
  for (const secret of privateValues) assert.equal(JSON.stringify(proof).includes(secret), false)
  await assert.rejects(() => bridge.confirmVerifiedSession({ challenge, trigger: async () => {} }))
  let duplicateAborts = 0
  await pageRoute({ ...lookup, async abort() { duplicateAborts++ } })
  await pageRoute({ ...refresh, async abort() { duplicateAborts++ } })
  assert.equal(duplicateAborts, 2)

  const acceptPrepared = await bridge.takePreparedNormal('acceptInvite')
  await assert.rejects(() => bridge.release({ operation: 'getCompanyAccess', permit: { requestSha256: acceptPrepared.requestSha256 } }))
  const accepted = await bridge.release({ operation: 'acceptInvite', permit: { requestSha256: acceptPrepared.requestSha256 } })
  assert.equal(accepted.requestSha256, h(acceptBody))
  const accessPrepared = await bridge.takePreparedNormal('getCompanyAccess')
  const accessed = await bridge.release({ operation: 'getCompanyAccess', permit: { requestSha256: accessPrepared.requestSha256 } })
  assert.equal(accessed.requestSha256, h(accessBody))
  assert.equal(binds, 5)
  for (const secret of privateValues) assert.equal(JSON.stringify({ emailPrepared, proof, acceptPrepared, accepted, accessPrepared, accessed }).includes(secret), false)
  await assert.rejects(() => bridge.takePreparedNormal('getCompanyAccess'))
})

test('verified-session proof fails closed on denied, failed, or unverified lookup and refresh paths', async t => {
  const cases = [
    { name: 'lookup HTTP 403', lookupStatus: 403 },
    { name: 'lookup network failure', lookupResponseError: true },
    { name: 'emailVerified false', lookupBody: { users: [{ localId: 'uid_owner_mailbox', emailVerified: false }] } },
    { name: 'wrong mailbox UID', lookupBody: { users: [{ localId: 'uid_other', emailVerified: true }] } },
    { name: 'binder denial aborts lookup', denyOperation: 'accounts:lookup', expectAbort: true },
    { name: 'route continue failure aborts lookup', failContinueOperation: 'accounts:lookup', expectAbort: true },
    { name: 'refresh HTTP 403', refreshStatus: 403 },
    { name: 'refresh network failure', refreshResponseError: true },
    { name: 'refresh capture rejection', captureRejects: true },
    { name: 'refresh capture result mismatch', captureResult: { captured: false } },
    { name: 'missing accept request times out', missingAccept: true },
  ]
  for (const item of cases) await t.test(item.name, async () => {
    let pageRoute, aborts = 0, captures = 0
    const responseFor = (status, body, fails) => ({ status: () => status, async json() { return body } ,
      async marker() { if (fails) throw new Error('unused') } })
    const lookupResponse = responseFor(item.lookupStatus ?? 200,
      item.lookupBody ?? { users: [{ localId: 'uid_owner_mailbox', emailVerified: true }] }, false)
    const refreshResponse = responseFor(item.refreshStatus ?? 200, { private_token: 'secret-token-body' }, false)
    const makeRoute = (operation, response, responseError = false) => {
      const urls = {
        'accounts:sendOobCode': 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=private-test-key',
        'accounts:lookup': 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=private-test-key',
        token: 'https://securetoken.googleapis.com/v1/token?key=private-test-key',
        acceptInvite: 'https://us-central1-finapp-staging.cloudfunctions.net/acceptInvite',
      }
      const request = { method: () => 'POST', url: () => urls[operation], postData: () => JSON.stringify({ private: 'secret-request' }),
        async response() { if (responseError) throw new Error('network-failure'); return response } }
      return { request: () => request, async fallback() {}, async abort() { aborts++ },
        async continue() { if (item.failContinueOperation === operation) throw new Error('route-continue-failure') } }
    }
    const bridge = createHeldPlaywrightRequestBridge({
      summarizeRegistration: async (_response, meta) => ({ requestSha256: meta.requestSha256, outcomeSha256: h('registration'), producedSha256: h('registration-produced') }),
      summarizeVerification: async (_response, meta) => ({ requestSha256: meta.requestSha256, outcomeSha256: h('verification') }),
      summarizeAccept: async (_response, meta) => ({ requestSha256: meta.requestSha256, outcomeSha256: h('accept'), producedSha256: h('accept-produced') }),
      summarizeAccess: async (_response, meta) => ({ requestSha256: meta.requestSha256, outcomeSha256: h('access') }),
      getExpectedMailboxUid: () => 'uid_owner_mailbox',
      captureOwnerMailboxForcedRefresh: async received => {
        captures++
        const body = await received.json()
        assert.equal(body.private_token, 'secret-token-body')
        if (item.captureRejects) throw new Error('capture-failure')
        return item.captureResult ?? { captured: true }
      },
      heldWaitTimeoutMs: 20,
    })
    await bridge.attach({ page: { async route(_glob, handler) { pageRoute = handler } }, browserBinder: {
      async bind(request) {
        if (item.denyOperation && request.url.includes(item.denyOperation)) return { action: 'abort' }
        return { action: 'continue' }
      },
    } })
    const email = makeRoute('accounts:sendOobCode', { status: () => 200 })
    const preparedPromise = bridge.prepare({ operation: 'accounts:sendOobCode', trigger: async () => { await pageRoute(email) } })
    const prepared = await preparedPromise
    await bridge.release({ operation: 'accounts:sendOobCode', permit: prepared })
    const lookup = makeRoute('accounts:lookup', lookupResponse, item.lookupResponseError)
    const refresh = makeRoute('token', refreshResponse, item.refreshResponseError)
    const accept = makeRoute('acceptInvite', { status: () => 200 })
    const exported = { challengeSha256: h('challenge') }
    await assert.rejects(() => bridge.confirmVerifiedSession({ challenge: exported, trigger: async () => {
      await pageRoute(lookup)
      if ((item.lookupStatus ?? 200) !== 200 || item.lookupResponseError || item.lookupBody || item.denyOperation || item.failContinueOperation) return
      await pageRoute(refresh)
      if ((item.refreshStatus ?? 200) !== 200 || item.refreshResponseError || item.captureRejects || item.captureResult) return
      if (!item.missingAccept) await pageRoute(accept)
    } }))
    if (item.expectAbort) assert.equal(aborts > 0, true)
    assert.equal(JSON.stringify(exported).includes('secret-token-body'), false)
    assert.equal(captures <= 1, true)
  })
})

test('bounded Playwright factory rejects any alternate static origin', () => {
  const method = async () => ({})
  assert.throws(() => createBoundedVisiblePlaywrightSessionFactory({
    chromium: { launch: method }, browserBinder: { bind: method }, mailboxSha256: h('mailbox'),
    secretActions: { navigateInvitation: method, fillMailbox: method, clearClipboard: method },
    requestBridge: { attach: method, prepare: method, release: method, takePreparedNormal: method, confirmVerifiedSession: method },
    localStaticOrigin: 'http://localhost:5177',
  }))
})

function adminUiHarness({ clipboardMode = 'ok', bootstrapCompanyId = 'company_a' } = {}) {
  let pageRoute, linkVisible = false, copied = false, closed = 0, fulfilled = 0, aborted = 0, binds = 0
  const inviteBody = JSON.stringify({ data: { companyId: 'company_a', email: 'private@example.invalid', role: 'accountant' } })
  const listBody = JSON.stringify({ data: { companyId: bootstrapCompanyId, pageSize: 20 } })
  const response = kind => ({ status: () => 200, kind })
  const route = (kind, url, body) => {
    const request = { method: () => 'POST', url: () => url, postData: () => body, async response() { return response(kind) } }
    return { request: () => request, async fallback() {}, async abort() { aborted++ },
      async fulfill(options) {
        fulfilled++
        assert.deepEqual(options, { status: 200, contentType: 'application/json', body: JSON.stringify({ data: { items: [], nextCursor: null } }) })
      },
      async continue() {
        if (kind === 'invite') {
          linkVisible = true
          void pageRoute(route('list', 'https://us-central1-finapp-staging.cloudfunctions.net/listInvitations',
            JSON.stringify({ data: { companyId: 'company_a', pageSize: 20 } })))
        }
      } }
  }
  const locator = (kind, name = '') => ({
    async waitFor() {
      if (kind === 'link-field' && !linkVisible) throw new Error('link-not-visible')
      if (kind === 'copied' && !copied) throw new Error('copy-not-complete')
    },
    async click() {
      if (kind === 'create') await pageRoute(route('invite', 'https://us-central1-finapp-staging.cloudfunctions.net/inviteMember', inviteBody))
      if (kind === 'copy') copied = true
      if (kind === 'close') linkVisible = false
    },
    async selectOption(value) { assert.equal(kind, 'combobox'); assert.equal(value, 'accountant') },
    async count() { return kind === 'link-field' && linkVisible ? 1 : 0 },
    getByLabel(label) {
      assert.equal(kind, 'dialog')
      if (label === 'Email') return locator('email')
      if (label === 'Ссылка') return locator('link-field')
      throw new Error('unexpected-label')
    },
    getByRole(role, options = {}) {
      assert.equal(kind, 'dialog')
      if (role === 'combobox') return locator('combobox')
      if (options.name === 'Создать приглашение') return locator('create')
      if (options.name === 'Копировать ссылку') return locator('copy')
      if (options.name === 'Скопировано') return locator('copied')
      if (options.name === 'Закрыть') return locator('close')
      throw new Error('unexpected-dialog-role')
    },
  })
  const page = {
    setDefaultTimeout() {}, async route(_glob, handler) { pageRoute = handler },
    async goto(url) {
      if (url.endsWith('#/users')) await pageRoute(route('bootstrap',
        'https://us-central1-finapp-staging.cloudfunctions.net/listInvitations', listBody))
    },
    async waitForURL() {},
    getByRole(role, options = {}) {
      if (role === 'region') return locator('region')
      if (role === 'dialog') return locator('dialog')
      if (role === 'button' && options.name === 'Пригласить по email') return locator('invite-open')
      throw new Error('unexpected-page-role')
    },
    async evaluate(_callback, argument) {
      if (argument) {
        if (clipboardMode === 'missing') throw new Error('clipboard-unavailable')
        return { clipboardApi: true, displayedMatched: clipboardMode !== 'mismatch', linkShapeMatched: true,
          capabilityMatched: true, linkSha256: h('private-link'), cleared: true, clearReadbackMatched: true }
      }
    },
  }
  const context = { async route() {}, async newPage() { return page }, async close() { closed++ } }
  const browser = { async newContext(options) {
    assert.deepEqual(options.permissions, ['clipboard-read', 'clipboard-write']); return context
  }, async close() { closed++ } }
  const driver = createAdminInvitationPlaywrightDriver({
    chromium: { async launch(options) { assert.deepEqual(options, { headless: false }); return browser } },
    browserBinder: { async bind() { binds++; return { action: 'continue' } } },
    secretActions: { async signInOwnerA() { return { signedIn: true } },
      async fillInviteMailbox(_page, field) { assert.equal(typeof field.click, 'function'); return { filled: true } } },
    summarizeInvitation: async (received, meta) => {
      assert.equal(received.kind, 'invite')
      return { requestSha256: meta.requestSha256, outcomeSha256: h('invite-outcome'), sanitized: {
        disposition: 'SUCCESS', inviteId: 'invite_cancelled', capabilitySha256: h('private-token'), expiresAtUtc: '2026-09-15T00:00:00.000Z' } }
    },
    summarizeList: async (received, meta) => {
      assert.equal(received.kind, 'list')
      return { requestSha256: meta.requestSha256, outcomeSha256: h('list-outcome'),
        sanitized: { disposition: 'SUCCESS', itemCount: 1, itemsSha256: h('items'), nextCursorPresent: false } }
    },
    waitTimeoutMs: 30,
  })
  return { driver, counts: () => ({ fulfilled, aborted, binds, closed }) }
}

test('admin UI driver locally bootstraps one verified-empty list, journals invite, verifies copy, and holds real listed readback', async () => {
  const value = adminUiHarness()
  await value.driver.open()
  const prepared = await value.driver.prepareCancelledInvitation({ companyId: 'company_a' })
  const invited = await value.driver.dispatchCancelledInvitation(prepared)
  assert.equal(invited.sanitized.inviteId, 'invite_cancelled')
  const listedPrepared = await value.driver.takePreparedPostCreateList()
  const listed = await value.driver.dispatchPostCreateList(listedPrepared)
  assert.equal(listed.sanitized.itemCount, 1)
  const evidence = value.driver.readEvidence()
  assert.equal(evidence.step, 'admin-copy-link'); assert.match(evidence.observationSha256, /^[a-f0-9]{64}$/)
  assert.equal(evidence.initialListSource, 'verified-empty-local-bootstrap')
  assert.deepEqual(value.counts(), { fulfilled: 1, aborted: 0, binds: 2, closed: 0 })
  assert.equal(JSON.stringify({ invited, listed, evidence }).includes('private@example.invalid'), false)
  await value.driver.close()
  assert.equal(value.counts().closed, 2)
})

test('admin UI driver blocks missing clipboard API, readback mismatch, and unmatched bootstrap company', async t => {
  for (const clipboardMode of ['missing', 'mismatch']) await t.test(clipboardMode, async () => {
    const value = adminUiHarness({ clipboardMode })
    await value.driver.open()
    const prepared = await value.driver.prepareCancelledInvitation({ companyId: 'company_a' })
    await assert.rejects(() => value.driver.dispatchCancelledInvitation(prepared))
    assert.equal(value.counts().closed, 2)
    assert.throws(() => value.driver.readEvidence())
  })
  const wrong = adminUiHarness({ bootstrapCompanyId: 'company_other' })
  await wrong.driver.open()
  await assert.rejects(() => wrong.driver.prepareCancelledInvitation({ companyId: 'company_a' }))
  assert.equal(wrong.counts().aborted, 1)
})

function postUiHarness() {
  let browserClosed = 0, contextClosed = 0, borrowedClosed = 0
  const signIns = []
  class FakeContext {
    constructor(borrowed = false) { this.identity = null; this.company = null; this.offline = false; this.pages = []; this.borrowed = borrowed }
    async route() {}
    async newPage() { const value = new FakePage(this); this.pages.push(value); return value }
    async setOffline(value) { this.offline = value }
    async close() { if (this.borrowed) borrowedClosed++; else contextClosed++ }
  }
  class FakePage {
    constructor(context) { this.context = context; this.path = '/login'; this.url = '' }
    setDefaultTimeout() {}
    isClosed() { return false }
    async evaluate(_callback, expected) { return expected === 'http://127.0.0.1:5177' }
    role() { return this.context.identity === 'ownerA' || this.context.identity === 'ownerB' && this.context.company === 'b' ? 'admin'
      : this.context.identity === 'ownerB' ? 'viewer' : 'accountant' }
    async goto(url) { this.url = url; this.path = url.split('#')[1] ?? '/'; return null }
    async waitForURL(url) { if (this.url !== url) throw new Error('wrong-url') }
    async reload() { if (this.context.offline) throw new Error('offline'); return null }
    getByTitle(title) { return { click: async () => {
      assert.equal(title, 'Выйти')
      for (const page of this.context.pages) { page.path = '/login'; page.url = 'http://127.0.0.1:5177/finapp/#/login' }
    } } }
    getByText(text) {
      const present = text.startsWith('Режим только для чтения') ? this.role() === 'viewer'
        : text.startsWith('Управление пользователями') && this.path === '/users' && this.role() !== 'admin'
      return { count: async () => present ? 1 : 0, waitFor: async () => { if (!present) throw new Error('text-not-visible') } }
    }
    getByRole(role, options = {}) {
      const name = options.name
      const count = () => {
        if (role === 'heading') return ({ '/': 'Дашборд', '/settings': 'Настройки', '/transactions': 'Операции' })[this.path] === name ? 1 : 0
        if (role === 'link' && name === 'Пользователи') return this.role() === 'admin' ? 1 : 0
        if (role === 'button' && name === 'Сохранить') return this.path === '/settings' && this.role() === 'admin' ? 1 : 0
        if (role === 'button' && name === 'Пригласить по email') return 0
        if (role === 'button' && name === 'Добавить') return this.path === '/transactions' && this.role() === 'accountant' ? 1 : 0
        if (role === 'button' && [this.context.company === 'a' ? 'Stage8 Company A' : 'Stage8 Company B', 'Stage8 Company A', 'Stage8 Company B'].includes(name)) return 1
        return 0
      }
      return { count: async () => count(), waitFor: async () => { if (count() < 1) throw new Error('role-not-visible') },
        click: async () => { if (name === 'Stage8 Company A') this.context.company = 'a'; if (name === 'Stage8 Company B') this.context.company = 'b' } }
    }
  }
  const browser = { async newContext() { return new FakeContext() }, async close() { browserClosed++ } }
  const borrowedContext = new FakeContext(true)
  borrowedContext.identity = 'ownerMailbox'; borrowedContext.company = 'a'
  const borrowedPage = new FakePage(borrowedContext)
  borrowedPage.path = '/'; borrowedPage.url = 'http://127.0.0.1:5177/finapp/#/'
  borrowedContext.pages.push(borrowedPage)
  const verifier = createPostFixturePlaywrightUiVerifier({
    chromium: { async launch(options) { assert.deepEqual(options, { headless: false }); return browser } },
    browserBinder: { async bind() { return { action: 'continue' } } },
    secretActions: { async signIn(page, identity) {
      assert.equal(['ownerA', 'ownerB'].includes(identity), true)
      signIns.push(identity)
      page.context.identity = identity; page.context.company = identity === 'ownerB' ? 'b' : 'a'
      page.path = '/'; page.url = 'http://127.0.0.1:5177/finapp/#/'
      return { signedIn: true }
    } },
    borrowVerifiedMailboxSession: async () => ({ page: borrowedPage, context: borrowedContext }),
    waitTimeoutMs: 30,
  })
  return { verifier, signIns, counts: () => ({ browserClosed, contextClosed, borrowedClosed }) }
}

test('post-fixture verifier produces typed evidence for roles, switches, direct URL, offline recovery, reload, and two-tab logout', async () => {
  const value = postUiHarness()
  const result = await value.verifier.run()
  assert.equal(result.status, 'UI_ACCEPTANCE_RECONCILED')
  assert.equal(result.evidence.length, LIVE_PLAYWRIGHT_UI_STEPS.length - 1)
  const copy = { step: 'admin-copy-link', status: 'PASS', observationSha256: h('copy-evidence'),
    initialListSource: 'verified-empty-local-bootstrap' }
  const validated = validateLivePlaywrightUiEvidence([copy, ...result.evidence])
  assert.equal(validated.status, 'PASS'); assert.equal(validated.evidence.length, LIVE_PLAYWRIGHT_UI_STEPS.length)
  assert.throws(() => validateLivePlaywrightUiEvidence(result.evidence))
  assert.throws(() => validateLivePlaywrightUiEvidence([copy, copy, ...result.evidence.slice(1)]))
  assert.deepEqual(value.signIns, ['ownerA', 'ownerB'])
  await value.verifier.close()
  assert.deepEqual(value.counts(), { browserClosed: 1, contextClosed: 2, borrowedClosed: 0 })
})
