import test from 'node:test'
import assert from 'node:assert/strict'
import { DATABASE, PROJECT, ENDPOINTS, guard, guardCliAccount, guardedFetch, inventory, requestSpec, rulesHash, sanitizeAuth, sanitizeFunction } from './inventoryCore.mjs'

const HEAD = 'a'.repeat(40)
const options = { project: PROJECT, expectedHead: HEAD, env: {} }
const clean = () => ({ head: HEAD, status: '' })
const releaseName = `projects/${PROJECT}/rulesets/aaa-bbb`
const secret = 'DO_NOT_LOG_THIS_SECRET_EMAIL_OR_TOKEN'
function fixtures() {
  return {
    project: { projectId: PROJECT, projectNumber: '12345' },
    database: { name: DATABASE, locationId: 'eur3', type: 'FIRESTORE_NATIVE' },
    functionsV1: {},
    functionsV2: { functions: [{ name: `projects/${PROJECT}/locations/us-central1/functions/acceptInvite`, state: 'ACTIVE', buildConfig: { runtime: 'nodejs22', source: { storageSource: { bucket: secret, object: secret } }, environmentVariables: { PASSWORD: secret } }, serviceConfig: { revision: 'acceptinvite-00001-abc', environmentVariables: { PASSWORD: secret }, secretEnvironmentVariables: [{ secret }] } }] },
    release: { name: `projects/${PROJECT}/releases/cloud.firestore`, rulesetName: releaseName },
    ruleset: { name: releaseName, source: { files: [{ content: 'rules_version = "2";\n' }] } },
    indexes: { indexes: [{ name: `${DATABASE}/collectionGroups/invitations/indexes/abc`, state: 'READY', queryScope: 'COLLECTION', fields: [{ fieldPath: 'companyId', order: 'ASCENDING' }] }] },
    fields: {},
    auth: { name: 'projects/12345/config', authorizedDomains: ['localhost', 'finapp-staging.firebaseapp.com'], signIn: { email: { enabled: true, passwordRequired: true } }, notification: { smtp: { password: secret }, emailTemplates: { body: secret } }, monitoring: { secret } },
  }
}
function harness(data = fixtures()) {
  const calls = []
  let authCalls = 0
  return {
    calls, authCalls: () => authCalls,
    run: overrides => inventory({
      options, gitState: clean, localRules: () => 'rules_version = "2";\r\n',
      authorize: async () => { authCalls++ },
      get: async spec => {
        calls.push(spec)
        assert.equal(spec.method, 'GET')
        assert.ok(spec.path.includes(PROJECT))
        const kind = spec.path === `/v1/${releaseName}` ? 'ruleset' : Object.keys(ENDPOINTS).find(key => ENDPOINTS[key][1] === spec.path)
        assert.ok(kind)
        return data[kind]
      },
      ...overrides,
    }),
  }
}

test('wrong target, SHA, dirty state and unsafe environment fail before auth and GET', async () => {
  for (const override of [
    { options: { ...options, project: 'finapp-prod-10a83' } },
    { options: { ...options, project: 'some-other-project' } },
    { options: { ...options, expectedHead: 'main' } },
    { gitState: () => ({ head: 'b'.repeat(40), status: '' }) },
    { gitState: () => ({ head: HEAD, status: '?? unpublished.mjs' }) },
    ...['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN_URL', 'NODE_TLS_REJECT_UNAUTHORIZED', 'DEBUG'].map(key => ({ options: { ...options, env: { [key]: secret } } })),
  ]) {
    const h = harness()
    await assert.rejects(h.run(override), /inventory_blocked/)
    assert.equal(h.authCalls(), 0)
    assert.equal(h.calls.length, 0)
  }
})

test('only exact staging GET endpoint paths are generated; dynamic Rules path cannot escape', () => {
  for (const key of Object.keys(ENDPOINTS)) {
    const spec = requestSpec(key)
    assert.equal(spec.method, 'GET')
    assert.match(spec.origin, /^https:\/\/[a-z]+\.googleapis\.com$/)
    assert.ok(spec.path.includes(PROJECT))
  }
  for (const name of ['projects/finapp-prod-10a83/rulesets/abc', `${releaseName}/../../users`, 'https://evil.invalid', '']) {
    assert.throws(() => requestSpec('ruleset', undefined, name))
  }
  for (const key of ['deploy', 'accounts', 'documents', 'delete', 'createFunction']) assert.throws(() => requestSpec(key))
  assert.equal(requestSpec('functionsV2').queryParams.filter, 'environment="GEN_2"')
})

test('Windows lowercase and mixed-case environment overrides block before auth and requests', async () => {
  for (const env of [
    { firebase_token: secret },
    { FireBase_ToKen: secret },
    { google_application_credentials: secret },
    { Firebase_Token_Url: 'https://evil.invalid' },
    { firebase_auth_emulator_host: 'localhost:9099' },
    { Node_Tls_Reject_Unauthorized: '0' },
    { google_cloud_quota_project: 'finapp-prod-10a83' },
    { Google_Cloud_Quota_Project: 'other-project' },
    { GOOGLE_CLOUD_QUOTA_PROJECT: PROJECT, google_cloud_quota_project: 'other-project' },
  ]) {
    const h = harness()
    await assert.rejects(h.run({ options: { ...options, env } }), /inventory_blocked/)
    assert.equal(h.authCalls(), 0)
    assert.equal(h.calls.length, 0)
  }
  assert.doesNotThrow(() => guard({ ...options, ...clean(), env: { Google_Cloud_Quota_Project: PROJECT } }))
})

test('CLI session requires a refresh token even when a cached access token is currently valid', () => {
  for (const account of [undefined, {}, { user: {} }, { user: {}, tokens: {} },
    { user: {}, tokens: { access_token: secret, expires_at: Date.now() + 3600000 } },
    { user: {}, tokens: { refresh_token: '' } }, { user: {}, tokens: { refresh_token: '   ' } }]) {
    assert.throws(() => guardCliAccount(account), /inventory_blocked/)
  }
  assert.doesNotThrow(() => guardCliAccount({ user: {}, tokens: { refresh_token: secret, expires_at: 0 } }))
})

test('transport rejects arbitrary origins/verbs and forces redirect:error for metadata and OAuth refresh', async () => {
  const calls = []
  const fetch = guardedFetch(async (input, options) => { calls.push({ input, options }); return { ok: true } })
  const url = `${ENDPOINTS.auth[0]}${ENDPOINTS.auth[1]}`
  await fetch(url, { headers: { Authorization: secret }, redirect: 'follow' })
  await fetch('https://www.googleapis.com/oauth2/v3/token', { method: 'POST', body: secret })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.options.redirect === 'error'))
  for (const [target, options] of [
    ['https://evil.invalid', {}],
    [url.replace(PROJECT, 'finapp-prod-10a83'), {}],
    [url, { method: 'PATCH' }],
    ['https://www.googleapis.com/oauth2/v3/token?redirect=evil', { method: 'POST' }],
    [url.replace('https://', 'http://'), {}],
    [url.replace('https://', 'https://user@'), {}],
  ]) await assert.rejects(fetch(target, options))
  assert.equal(calls.length, 2)
  const projections = ['functionsV1', 'functionsV2', 'auth'].map(kind => requestSpec(kind).queryParams.fields)
  assert.ok(projections.every(fields => fields && !/environmentVariables|secretEnvironmentVariables|notification/.test(fields)))
})

test('inventory performs real simulated observers/requests and emits only sanitized metadata, never claims rollback verified', async () => {
  const h = harness()
  const result = await h.run()
  assert.equal(h.authCalls(), 1)
  assert.equal(h.calls.length, 9)
  const output = JSON.stringify(result)
  assert.ok(!output.includes(secret))
  assert.ok(!output.includes('environmentVariables'))
  assert.ok(!output.includes('smtp'))
  assert.equal(result.functions[0].revision, 'acceptinvite-00001-abc')
  assert.equal(result.functions[0].sourceReferencePresent, true)
  assert.equal(result.functions[0].rollbackArtifactAvailability, 'NOT_VERIFIED')
  assert.equal(result.auth.emailPasswordEnabled, true)
  assert.equal(result.rules.matches, true)
  assert.equal(result.writesReady, false)
})

test('missing Auth fields, source references and Rules mismatch remain unknown/blocked for writes', async () => {
  const data = fixtures()
  delete data.auth.signIn
  delete data.functionsV2.functions[0].buildConfig.source
  data.ruleset.source.files[0].content = 'different rules'
  const result = await harness(data).run()
  assert.equal(result.auth.emailPasswordEnabled, null)
  assert.equal(result.functions[0].sourceReferencePresent, false)
  assert.equal(result.rules.matches, false)
  assert.equal(result.writesReady, false)
})

test('pagination includes later pages and rejects repeated tokens/unreachable regions', async () => {
  const h = harness()
  const specs = []
  const base = fixtures()
  const result = await h.run({ get: async spec => {
    specs.push(spec)
    const key = spec.path === `/v1/${releaseName}` ? 'ruleset' : Object.keys(ENDPOINTS).find(key => ENDPOINTS[key][1] === spec.path)
    if (key === 'functionsV2' && !spec.queryParams.pageToken) return { nextPageToken: secret }
    return base[key]
  } })
  assert.equal(specs.length, 10)
  assert.equal(result.functions.length, 1)
  assert.ok(!JSON.stringify(result).includes(secret))
  for (const response of [{ nextPageToken: secret }, { unreachable: ['us-central1'] }, { functions: 'malformed' }]) {
    const data = fixtures()
    data.functionsV2 = response
    await assert.rejects(harness(data).run(), /inventory_blocked/)
  }
})

test('auth failure makes no inventory request; API failures and changed checkout do not return success', async () => {
  const h = harness()
  await assert.rejects(h.run({ authorize: async () => { throw new Error('access unavailable') } }))
  assert.equal(h.calls.length, 0)
  await assert.rejects(h.run({ get: async () => { throw new Error(secret) } }))
  let snapshots = 0
  await assert.rejects(h.run({ gitState: () => ({ head: ++snapshots === 1 ? HEAD : 'b'.repeat(40), status: '' }) }))
})

test('cross-project API responses and malformed Auth domains fail closed', async () => {
  assert.throws(() => sanitizeFunction({ name: 'projects/other/locations/us-central1/functions/acceptInvite' }, 2))
  assert.throws(() => sanitizeAuth({ name: 'projects/other/config', authorizedDomains: [] }, '12345'))
  assert.throws(() => sanitizeAuth({ name: `projects/${PROJECT}/config`, authorizedDomains: ['mail@example.com'] }))
  const data = fixtures()
  data.database.name = 'projects/finapp-prod-10a83/databases/(default)'
  await assert.rejects(harness(data).run())
  data.database.name = DATABASE
  data.release.rulesetName = 'projects/other/rulesets/aaa'
  await assert.rejects(harness(data).run())
})

test('canonical Rules hashing preserves meaningful differences', () => {
  assert.equal(rulesHash('a\r\nb\r'), rulesHash('a\nb\n'))
  assert.notEqual(rulesHash('a\nb'), rulesHash('a\n b'))
  assert.doesNotThrow(() => guard({ ...options, ...clean() }))
})
