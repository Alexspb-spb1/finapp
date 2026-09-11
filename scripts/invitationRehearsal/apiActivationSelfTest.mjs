import test from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT } from './inventoryCore.mjs'
import { SERVICE, PROJECT_URL, SERVICE_URL, BILLING_URL, activationTransport, persistJournal, runFunctionsApi, operationUrl } from './apiActivationCore.mjs'

const head = 'c'.repeat(40)
const options = { mode: 'inspect', project: PROJECT, service: SERVICE, expectedHead: head, env: {} }
const clean = () => ({ head, status: '' })
const secret = 'MUST_NOT_APPEAR_IN_REPORT'
const fixture = state => ({ name: `projects/12345/services/${SERVICE}`, state, config: { name: SERVICE, usage: { requirements: ['serviceusage.googleapis.com/billing-enabled', 'serviceusage.googleapis.com/tos/cloud'] }, documentation: secret }, unknown: secret })
function harness(service = fixture('DISABLED')) {
  const calls = []
  const events = []
  let auth = 0
  let posts = 0
  return { calls, events, auth: () => auth, posts: () => posts, run: override => runFunctionsApi({
    options, gitState: clean, authorize: async () => { auth++ },
    persist: async event => { events.push(structuredClone(event)) },
    sleep: async () => {}, allowOperation: () => {},
    post: async () => { posts++; service.state = 'ENABLED'; return { name: 'operations/acf.test-123', done: true } },
    get: async (url, fields) => {
      calls.push({ url, fields })
      if (url === PROJECT_URL) return { projectId: PROJECT, projectNumber: '12345' }
      if (url === BILLING_URL) return { projectId: PROJECT, billingEnabled: true }
      assert.equal(url, SERVICE_URL)
      return service
    }, ...override,
  }) }
}

test('only explicit supported mode for exact project/service and clean reviewed HEAD reaches auth', async () => {
  for (const override of [
    { options: { ...options, mode: 'deploy' } },
    { options: { ...options, mode: undefined } },
    { options: { ...options, service: 'cloudbuild.googleapis.com' } },
    { options: { ...options, project: 'finapp-prod-10a83' } },
    { options: { ...options, env: { firebase_token: secret } } },
    { gitState: () => ({ head, status: ' M file' }) },
    { gitState: () => ({ head: 'd'.repeat(40), status: '' }) },
  ]) {
    const h = harness()
    await assert.rejects(h.run(override))
    assert.equal(h.auth(), 0)
    assert.equal(h.calls.length, 0)
  }
})

test('fresh projected metadata is read for enabled and disabled states without any activation request', async () => {
  for (const state of ['ENABLED', 'DISABLED']) {
    const h = harness(fixture(state))
    const report = await h.run()
    assert.deepEqual(h.calls.map(call => call.url), [PROJECT_URL, SERVICE_URL])
    assert.equal(h.calls[1].fields, 'name,state,config(name,usage(requirements))')
    assert.equal(report.beforeState, state)
    assert.equal(report.observedAfterState, null)
    assert.equal(report.activationAttempted, false)
    assert.equal(h.posts(), 0)
    assert.ok(!JSON.stringify(report).includes(secret))
  }
})

test('wrong metadata identity, unknown state, and malformed requirements fail closed', async () => {
  for (const service of [
    { ...fixture('DISABLED'), name: `projects/other/services/${SERVICE}` },
    { ...fixture('DISABLED'), config: { name: 'other.googleapis.com' } },
    fixture('DISABLING'),
    { ...fixture('DISABLED'), config: { name: SERVICE, usage: { requirements: [secret + '@mail.invalid'] } } },
  ]) await assert.rejects(harness(service).run())
  const report = await harness({ name: `projects/12345/services/${SERVICE}`, state: 'DISABLED', config: { name: SERVICE } }).run()
  assert.equal(report.usageRequirementsReported, false)
  assert.equal(report.activationAttempted, false)
})

test('API/auth errors and post-request HEAD changes cannot produce a success report', async () => {
  const h = harness()
  await assert.rejects(h.run({ authorize: async () => { throw new Error(secret) } }))
  assert.equal(h.calls.length, 0)
  await assert.rejects(h.run({ get: async () => { throw new Error(secret) } }))
  let reads = 0
  await assert.rejects(h.run({ gitState: () => ({ head: ++reads === 1 ? head : 'd'.repeat(40), status: '' }) }))
})

test('inspect transport blocks service mutations, unregistered operation polls and arbitrary GETs', async () => {
  const calls = []
  const { fetch } = activationTransport(async (input, init) => { calls.push({ input, init }); return { ok: true } }, 'inspect')
  await fetch(PROJECT_URL)
  await fetch(SERVICE_URL, { redirect: 'follow', headers: { Authorization: secret } })
  await fetch('https://www.googleapis.com/oauth2/v3/token', { method: 'POST', body: secret })
  assert.ok(calls.every(call => call.init.redirect === 'error'))
  for (const [url, method] of [
    [`${SERVICE_URL}:enable`, 'POST'], [`${SERVICE_URL}:disable`, 'POST'],
    [SERVICE_URL, 'PATCH'], [SERVICE_URL.replace(SERVICE, 'cloudbuild.googleapis.com'), 'GET'],
    [SERVICE_URL.replace(PROJECT, 'finapp-prod-10a83'), 'GET'],
    ['https://serviceusage.googleapis.com/v1/operations/abc', 'GET'],
    ['https://evil.invalid', 'GET'],
    ['https://www.googleapis.com/oauth2/v3/token?extra=yes', 'POST'],
  ]) await assert.rejects(fetch(url, { method }))
  assert.equal(calls.length, 3)
})

test('enable transport dispatches exactly once even when native fetch times out and a library retries', async () => {
  let dispatches = 0
  const transport = activationTransport(async (_url, init) => {
    dispatches++
    assert.equal(init.redirect, 'error')
    throw new Error('premature close')
  }, 'enable')
  await assert.rejects(transport.fetch(`${SERVICE_URL}:enable`, { method: 'POST' }))
  await assert.rejects(transport.fetch(`${SERVICE_URL}:enable`, { method: 'POST' }))
  assert.equal(dispatches, 1)
  assert.throws(() => transport.allowOperation('https://evil.invalid'))
  assert.throws(() => operationUrl('operations/../projects/other'))
  const guarded = activationTransport(async () => { dispatches++; return {} }, 'enable', () => { throw new Error('HEAD changed') })
  await assert.rejects(guarded.fetch(`${SERVICE_URL}:enable`, { method: 'POST' }))
  assert.equal(dispatches, 1)
})

test('enable preflight checks billing, journals before dispatch and verifies enabled postcondition', async () => {
  const h = harness()
  const report = await h.run({ options: { ...options, mode: 'enable' } })
  assert.equal(report.status, 'FUNCTIONS_API_ENABLED_VERIFIED')
  assert.equal(report.activationAttempted, true)
  assert.equal(h.posts(), 1)
  assert.deepEqual(h.calls.map(call => call.url), [PROJECT_URL, SERVICE_URL, BILLING_URL, SERVICE_URL, SERVICE_URL])
  assert.deepEqual(h.events.map(event => event.status), ['API_ENABLE_PREFLIGHT_VERIFIED', 'API_ENABLE_REQUEST_MAY_BE_SENT', 'API_ENABLE_OPERATION_RECEIVED', 'FUNCTIONS_API_ENABLED_VERIFIED'])
  assert.ok(!JSON.stringify(h.events).includes(secret))
})

test('already enabled, unknown requirements and disabled billing never POST', async () => {
  const already = harness(fixture('ENABLED'))
  assert.equal((await already.run({ options: { ...options, mode: 'enable' } })).status, 'FUNCTIONS_API_ALREADY_ENABLED')
  assert.equal(already.posts(), 0)
  const raced = harness()
  let serviceReads = 0
  const racedResult = await raced.run({ options: { ...options, mode: 'enable' }, get: async url => {
    if (url === PROJECT_URL) return { projectId: PROJECT, projectNumber: '12345' }
    if (url === BILLING_URL) return { projectId: PROJECT, billingEnabled: true }
    return fixture(++serviceReads === 1 ? 'DISABLED' : 'ENABLED')
  } })
  assert.equal(racedResult.status, 'FUNCTIONS_API_ALREADY_ENABLED')
  assert.equal(racedResult.beforeState, 'DISABLED')
  assert.equal(racedResult.observedAfterState, 'ENABLED')
  assert.equal(raced.posts(), 0)
  const unknown = fixture('DISABLED')
  unknown.config.usage.requirements = ['unknown/terms']
  const unsupported = harness(unknown)
  assert.equal((await unsupported.run({ options: { ...options, mode: 'enable' } })).status, 'API_ENABLE_BLOCKED_REQUIREMENTS')
  assert.equal(unsupported.posts(), 0)
  const h = harness()
  const report = await h.run({ options: { ...options, mode: 'enable' }, get: async url => {
    if (url === PROJECT_URL) return { projectId: PROJECT, projectNumber: '12345' }
    if (url === BILLING_URL) return { projectId: PROJECT, billingEnabled: false }
    return fixture('DISABLED')
  } })
  assert.equal(report.status, 'API_ENABLE_BLOCKED_BILLING')
  assert.equal(h.posts(), 0)
})

test('unknown POST outcome is journaled without retries; failing journal prevents dispatch', async () => {
  let posts = 0
  const h = harness()
  const report = await h.run({ options: { ...options, mode: 'enable' }, post: async () => { posts++; throw new Error(secret) } })
  assert.equal(posts, 1)
  assert.equal(report.status, 'API_ENABLE_UNCERTAIN')
  assert.equal(report.beforeState, 'DISABLED')
  assert.equal(report.observedAfterState, null)
  assert.equal(Object.hasOwn(report, 'state'), false)
  assert.equal(h.events.at(-1).status, 'API_ENABLE_UNCERTAIN')
  assert.ok(!JSON.stringify(h.events).includes(secret))
  const noJournal = harness()
  await assert.rejects(noJournal.run({ options: { ...options, mode: 'enable' }, persist: async () => { throw new Error('disk full') } }))
  assert.equal(noJournal.posts(), 0)
})

test('LRO polls only registered operation; success/failure/exhaustion preserve reference without another POST', async () => {
  for (const outcome of ['success', 'failure', 'timeout']) {
    const h = harness()
    const operation = 'operations/acf.test-123'
    let posts = 0
    let polls = 0
    let allowed
    const result = await h.run({
      options: { ...options, mode: 'enable' },
      allowOperation: name => { allowed = name },
      post: async () => { posts++; return { name: operation } },
      get: async url => {
        if (url === PROJECT_URL) return { projectId: PROJECT, projectNumber: '12345' }
        if (url === BILLING_URL) return { projectId: PROJECT, billingEnabled: true }
        if (url === operationUrl(operation)) {
          assert.equal(allowed, operation)
          polls++
          return { name: operation, ...(outcome === 'timeout' ? {} : { done: true }), ...(outcome === 'failure' ? { error: { code: 7, message: secret } } : {}) }
        }
        assert.equal(url, SERVICE_URL)
        return fixture(posts && outcome === 'success' ? 'ENABLED' : 'DISABLED')
      },
    })
    assert.equal(posts, 1)
    assert.equal(result.operation, operation)
    assert.equal(polls, outcome === 'timeout' ? 12 : 1)
    assert.equal(result.status, { success: 'FUNCTIONS_API_ENABLED_VERIFIED', failure: 'API_ENABLE_OPERATION_FAILED', timeout: 'API_ENABLE_UNCERTAIN' }[outcome])
    assert.ok(!JSON.stringify(h.events).includes(secret))
  }
})

test('HEAD change immediately before POST blocks dispatch', async () => {
  const h = harness()
  let reads = 0
  await assert.rejects(h.run({ options: { ...options, mode: 'enable' }, gitState: () => ({ head: ++reads < 3 ? head : 'e'.repeat(40), status: '' }) }))
  assert.equal(h.posts(), 0)
})

test('journal checks UTF-8 bytes and fsync; short writes stop before dispatch', async () => {
  let syncs = 0
  persistJournal(5, { text: 'проверка' }, {
    writeSync: (_fd, bytes) => { assert.ok(Buffer.isBuffer(bytes)); return bytes.length },
    fsyncSync: () => { syncs++ },
  })
  assert.equal(syncs, 1)
  for (const written of [bytes => bytes.length - 1, () => 0]) {
    const h = harness()
    await assert.rejects(h.run({ options: { ...options, mode: 'enable' }, persist: event => persistJournal(5, event, {
      writeSync: (_fd, bytes) => written(bytes),
      fsyncSync: () => { syncs++ },
    }) }))
    assert.equal(syncs, 1)
    assert.equal(h.posts(), 0)
  }
})
