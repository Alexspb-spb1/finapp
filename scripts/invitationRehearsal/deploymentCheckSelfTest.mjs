import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PROJECT, DATABASE } from './inventoryCore.mjs'
import { CALLABLES, URLS, FIELDS, deploymentTransport, requestSpec, runDeploymentCheck, checkFunction } from './deploymentCheckCore.mjs'

const HEAD = 'a'.repeat(40), SECRET = 'DO_NOT_PERSIST_PRIVATE_CONFIG_TOKEN_OR_PERSONAL_DATA'
const options = { mode: 'preflight', project: PROJECT, expectedHead: HEAD, env: {} }
const clean = () => ({ head: HEAD, status: '' })
function providerFunction(name = 'acceptInvite') {
  return {
    name: `projects/${PROJECT}/locations/us-central1/functions/${name}`, state: 'ACTIVE', environment: 'GEN_2',
    buildConfig: {
      runtime: 'nodejs22', entryPoint: name,
      build: `projects/12345/locations/us-central1/builds/11111111-2222-3333-4444-555555555555`,
      source: { storageSource: { bucket: SECRET, object: SECRET, generation: '123456789' } },
      sourceProvenance: { resolvedStorageSource: { object: SECRET } },
      environmentVariables: { PRIVATE: SECRET },
    },
    serviceConfig: {
      availableMemory: '256Mi', availableCpu: '1', maxInstanceRequestConcurrency: 1,
      maxInstanceCount: 1, timeoutSeconds: 60, revision: `${name.toLowerCase()}-00001-abc`,
      environmentVariables: { PRIVATE: SECRET }, secretEnvironmentVariables: [{ secret: SECRET }],
      serviceAccountEmail: SECRET, uri: `https://example.invalid/?token=${SECRET}`,
    },
  }
}
function fixtures(mode = 'preflight') {
  return {
    project: { projectId: PROJECT, projectNumber: '12345', unknown: SECRET },
    billing: { projectId: PROJECT, billingEnabled: true, billingAccountName: SECRET },
    database: { name: DATABASE, locationId: 'eur3', type: 'FIRESTORE_NATIVE', unknown: SECRET },
    functionsV1: {},
    functionsV2: mode === 'postflight' ? { functions: CALLABLES.map(providerFunction) } : {},
  }
}
function harness(mode = 'preflight', data = fixtures(mode)) {
  const calls = []; let authorizations = 0
  const execute = overrides => runDeploymentCheck({
    options: { ...options, mode }, gitState: clean,
    authorize: async () => { authorizations++ },
    get: async spec => {
      calls.push(spec)
      const kind = Object.keys(URLS).find(key => URLS[key] === spec.url)
      assert(kind); assert.equal(spec.queryParams.fields, FIELDS[kind])
      return data[kind]
    }, ...overrides,
  })
  return { execute, calls, authorizations: () => authorizations }
}
function asUrl(kind, token) {
  const spec = requestSpec(kind, token), url = new URL(spec.url)
  for (const [key, value] of Object.entries(spec.queryParams)) url.searchParams.set(key, value)
  return url
}

test('preflight checks billing and eur3 database before accepting empty V1/V2', async () => {
  const h = harness(), result = await h.execute()
  assert.equal(result.status, 'DEPLOYMENT_PREFLIGHT_VERIFIED')
  assert.deepEqual(result.functions, []); assert.equal(result.billingEnabled, true)
  assert.deepEqual(h.calls.map(value => value.url), [URLS.project, URLS.billing, URLS.database, URLS.functionsV1, URLS.functionsV2])
  assert.equal(result.cloudMutations, 0); assert.equal(result.callableInvocations, 0)
  assert(!JSON.stringify(result).includes(SECRET))
})

test('false, missing, null or malformed billing never proceeds to database or deployment', async () => {
  for (const billing of [null, {}, { projectId: PROJECT }, { projectId: PROJECT, billingEnabled: false },
    { projectId: PROJECT, billingEnabled: 'true' }, { projectId: PROJECT, billingEnabled: 1 }, { projectId: 'foreign', billingEnabled: true }]) {
    const data = fixtures(); data.billing = billing
    const h = harness('preflight', data)
    await assert.rejects(h.execute(), /deployment_check_blocked/)
    assert.deepEqual(h.calls.map(value => value.url), [URLS.project, URLS.billing])
  }
})

test('reviewed SHA, clean checkout, mode, target and safe environment are required before credentials', async () => {
  for (const change of [
    { options: { ...options, project: 'foreign' } }, { options: { ...options, mode: 'deploy' } },
    { options: { ...options, expectedHead: 'main' } }, { gitState: () => ({ head: HEAD, status: ' M source.ts' }) },
    { gitState: () => ({ head: 'b'.repeat(40), status: '' }) },
    ...['FIREBASE_TOKEN','firebase_token','GOOGLE_APPLICATION_CREDENTIALS','NODE_OPTIONS','FIREBASE_AUTH_EMULATOR_HOST','DEBUG'].map(key => ({ options: { ...options, env: { [key]: SECRET } } })),
  ]) {
    const h = harness(); await assert.rejects(h.execute(change))
    assert.equal(h.authorizations(), 0); assert.equal(h.calls.length, 0)
  }
})

test('project identity and database baseline drift stop metadata acceptance', async () => {
  for (const change of [
    { project: { projectId: 'foreign', projectNumber: '12345' } },
    { project: { projectId: PROJECT, projectNumber: 'not-number' } },
    { database: { name: DATABASE, locationId: 'nam5', type: 'FIRESTORE_NATIVE' } },
    { database: { name: DATABASE, locationId: 'eur3', type: 'DATASTORE_MODE' } },
    { database: { name: 'projects/foreign/databases/(default)', locationId: 'eur3', type: 'FIRESTORE_NATIVE' } },
  ]) await assert.rejects(harness('preflight', { ...fixtures(), ...change }).execute())
})

test('preflight refuses any existing generation1 or generation2 endpoint', async () => {
  for (const kind of ['functionsV1','functionsV2']) {
    const data = fixtures(); data[kind] = { functions: [providerFunction()] }
    await assert.rejects(harness('preflight', data).execute())
  }
})

test('postflight verifies eight actual API descriptors and emits only safe recovery metadata', async () => {
  const result = await harness('postflight').execute()
  assert.equal(result.status, 'DEPLOYMENT_METADATA_VERIFIED')
  assert.equal(result.functions.length, 8)
  assert.deepEqual(result.excludedFromDeployment, ['authzProbe'])
  for (const entry of result.functions) {
    assert.equal(entry.runtime, 'nodejs22'); assert.equal(entry.resources.minInstances, 0)
    assert.match(entry.revision, /-00001-abc$/)
    assert.match(entry.build, /^projects\/12345\/locations\/us-central1\/builds\//)
    assert.match(entry.sourceReferenceSha256, /^[a-f0-9]{64}$/)
    assert.match(entry.sourceProvenanceSha256, /^[a-f0-9]{64}$/)
    assert.equal(entry.rollbackArtifactAvailability, 'NOT_VERIFIED')
  }
  assert(!JSON.stringify(result).includes(SECRET))
  assert(!JSON.stringify(result).includes('environmentVariables'))
  assert(!JSON.stringify(result).includes('billingAccountName'))
  assert.equal(result.realEmailDeliveryVerified, false)
})

test('protobuf omitted minInstanceCount and explicit zero mean scale-to-zero; other shapes fail', () => {
  const value = providerFunction()
  assert.equal(checkFunction(value, '12345').resources.minInstances, 0)
  value.serviceConfig.minInstanceCount = 0
  assert.equal(checkFunction(value, '12345').resources.minInstances, 0)
  for (const min of [null, '0', -1, 1, false, undefined]) {
    value.serviceConfig.minInstanceCount = min
    assert.throws(() => checkFunction(value, '12345'))
  }
})

test('every runtime cap and callable identity must match actual v2 service semantics', () => {
  for (const [field, wrong] of [
    ['availableMemory','512Mi'], ['availableMemory','256MiB'], ['availableCpu',1], ['availableCpu','2'],
    ['maxInstanceRequestConcurrency',80], ['maxInstanceCount',2], ['timeoutSeconds',30], ['timeoutSeconds','60'],
  ]) {
    const value = providerFunction(); value.serviceConfig[field] = wrong
    assert.throws(() => checkFunction(value, '12345'))
  }
  for (const change of [
    { state: 'DEPLOYING' }, { state: 'FAILED' }, { environment: 'GEN_1' },
    { name: `projects/foreign/locations/us-central1/functions/acceptInvite` },
    { name: `projects/${PROJECT}/locations/europe-west1/functions/acceptInvite` },
    { buildConfig: { ...providerFunction().buildConfig, runtime: 'nodejs20' } },
    { buildConfig: { ...providerFunction().buildConfig, entryPoint: 'authzProbe' } },
  ]) assert.throws(() => checkFunction({ ...providerFunction(), ...change }, '12345'))
})

test('missing, duplicate, extra, authzProbe and generation1 functions block postflight', async () => {
  for (const edit of [
    rows => rows.slice(1), rows => [...rows.slice(1), rows[1]],
    rows => [...rows, providerFunction('authzProbe')], rows => [...rows.slice(1), providerFunction('authzProbe')],
  ]) {
    const data = fixtures('postflight'); data.functionsV2.functions = edit(data.functionsV2.functions)
    await assert.rejects(harness('postflight', data).execute())
  }
  const data = fixtures('postflight'); data.functionsV1 = { functions: [{ name: 'unexpected' }] }
  await assert.rejects(harness('postflight', data).execute())
})

test('untrusted recovery references cannot escape staging metadata or enter output', () => {
  for (const edit of [
    value => { value.serviceConfig.revision = SECRET },
    value => { value.serviceConfig.revision = 'otherfunction-00001-abc' },
    value => { value.buildConfig.build = 'projects/foreign/locations/us-central1/builds/11111111-2222-3333-4444-555555555555' },
    value => { value.buildConfig.build = `https://evil.invalid/?token=${SECRET}` },
    value => { value.buildConfig.source = {} },
    value => { value.buildConfig.source = null },
  ]) { const value = providerFunction(); edit(value); assert.throws(() => checkFunction(value, '12345')) }
})

test('pagination finds exact complete eight endpoints across pages', async () => {
  const data = fixtures('postflight'), h = harness('postflight', data), calls = []
  const result = await h.execute({ get: async spec => {
    calls.push(spec)
    const kind = Object.keys(URLS).find(key => URLS[key] === spec.url)
    if (kind !== 'functionsV2') return data[kind]
    return spec.queryParams.pageToken ? { functions: data.functionsV2.functions.slice(3) } : { functions: data.functionsV2.functions.slice(0,3), nextPageToken: 'next-page' }
  } })
  assert.equal(result.functions.length, 8)
  assert.equal(calls.filter(value => value.url === URLS.functionsV2).length, 2)
})

test('unreachable regions, malformed pages, duplicate tokens and unbounded pagination fail', async () => {
  for (const bad of [null, { functions: null }, { unreachable: ['europe-west1'] }, { unreachable: 'unknown' }, { nextPageToken: null }, { nextPageToken: 1 }]) {
    const data = fixtures(); data.functionsV2 = bad
    await assert.rejects(harness('preflight', data).execute())
  }
  for (const infinite of [false,true]) {
    const data = fixtures(); let pages = 0
    const h = harness()
    await assert.rejects(h.execute({ get: async spec => {
      const kind = Object.keys(URLS).find(key => URLS[key] === spec.url)
      if (kind === 'functionsV2') return { nextPageToken: infinite ? `page-${++pages}` : 'same-page' }
      return data[kind]
    } }))
    assert(pages <= 10)
  }
})

test('guard runs again after successful reads; changed checkout cannot issue verified report', async () => {
  let reads = 0
  await assert.rejects(harness().execute({ gitState: () => ({ head: HEAD, status: ++reads === 1 ? '' : ' M source.ts' }) }))
  assert.equal(reads, 2)
})

test('transport allows only exact projected GETs and normal OAuth refresh; disables redirects', async () => {
  const calls = [], fetch = deploymentTransport(async (input, init) => { calls.push({ input, init }); return { ok: true } })
  for (const kind of Object.keys(URLS)) await fetch(asUrl(kind), { method: 'GET' })
  await fetch(asUrl('functionsV2','opaque-page'), { method: 'GET' })
  await fetch('https://www.googleapis.com/oauth2/v3/token', { method: 'POST', body: SECRET })
  assert.equal(calls.length, 7)
  for (const call of calls) { assert.equal(call.init.redirect, 'error'); assert(call.init.signal instanceof AbortSignal) }
})

test('transport blocks mutations, activation, records, configuration, source download and unsafe URLs', async () => {
  let dispatched = 0
  const fetch = deploymentTransport(async () => { dispatched++ })
  const variants = [
    [URLS.billing, 'PUT'], [URLS.functionsV2, 'POST'], [URLS.functionsV2, 'DELETE'],
    [`https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/cloudfunctions.googleapis.com:enable`, 'POST'],
    [`https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`, 'GET'],
    [`https://firestore.googleapis.com/v1/${DATABASE}/documents/users`, 'GET'],
    ['https://storage.googleapis.com/source/archive.zip','GET'],
    ['https://evil.invalid/metadata','GET'], ['https://www.googleapis.com/oauth2/v3/token?debug=1','POST'],
    [String(asUrl('billing')).replace('https://','https://user:password@'),'GET'],
    [String(asUrl('billing'))+'#fragment','GET'],
    [String(asUrl('billing'))+'&fields=billingAccountName','GET'],
    [String(asUrl('billing')).replace('projectId%2CbillingEnabled','*'),'GET'],
    [String(asUrl('functionsV2'))+'&alt=media','GET'],
  ]
  for (const [url, method] of variants) await assert.rejects(fetch(url,{ method }))
  assert.equal(dispatched, 0)
})

test('transport applies request budget even to refresh and bounds page token', async () => {
  let count = 0
  const fetch = deploymentTransport(async () => { count++ })
  for (let i = 0; i < 40; i++) await fetch(asUrl('billing'))
  await assert.rejects(fetch(asUrl('billing'))); assert.equal(count, 40)
  for (const token of ['', null, 1, 'a'.repeat(4097)]) assert.throws(() => requestSpec('functionsV2',token))
  assert.throws(() => requestSpec('billing','page'))
})

test('native CLI help and invalid arguments do not load credentials or disclose provider details', () => {
  const script = fileURLToPath(new URL('./deploymentCheck.mjs', import.meta.url))
  const help = spawnSync(process.execPath, [script,'--help'], { encoding:'utf8',env:{ ...process.env,FIREBASE_TOKEN:SECRET } })
  assert.equal(help.status,0); assert(!help.stdout.includes(SECRET))
  const bad = spawnSync(process.execPath, [script,'--mode','deploy'], { encoding:'utf8',env:{ ...process.env,FIREBASE_TOKEN:SECRET } })
  assert.equal(bad.status,2); assert.match(bad.stderr,/DEPLOYMENT_CHECK_BLOCKED/)
  assert(!bad.stderr.includes(SECRET)); assert(!bad.stderr.includes('Error:'))
})
