import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { PROJECT, DATABASE } from './inventoryCore.mjs'
import { CALLABLES as BASELINE_CALLABLES, URLS, checkFunction } from './deploymentCheckCore.mjs'
import {
  TASK, MEMBER_MANAGEMENT_CALLABLES, ALL_CALLABLES,
  EXPECTED_BASELINE_RECEIPT_SHA256,
  validateBaselineReceiptProvenance, checkMemberManagementFunction, run13FunctionDeploymentCheck,
} from './gateGaDeploymentCheck13Core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const HEAD = 'a'.repeat(40)
const SECRET = 'DO_NOT_PERSIST_PRIVATE_CONFIG_TOKEN_OR_PERSONAL_DATA'
const options = { project: PROJECT, expectedHead: HEAD, env: {} }
const clean = () => ({ head: HEAD, status: '' })

function providerFunction(name, revisionSuffix = '00001-abc') {
  return {
    name: `projects/${PROJECT}/locations/us-central1/functions/${name}`, state: 'ACTIVE', environment: 'GEN_2',
    buildConfig: {
      runtime: 'nodejs22', entryPoint: name,
      build: 'projects/12345/locations/us-central1/builds/11111111-2222-3333-4444-555555555555',
      source: { storageSource: { bucket: SECRET, object: `${name}-${SECRET}`, generation: '123456789' } },
      sourceProvenance: { resolvedStorageSource: { object: `${name}-${SECRET}-prov` } },
      environmentVariables: { PRIVATE: SECRET },
    },
    serviceConfig: {
      availableMemory: '256Mi', availableCpu: '1', maxInstanceRequestConcurrency: 1,
      maxInstanceCount: 1, timeoutSeconds: 60, revision: `${name.toLowerCase()}-${revisionSuffix}`,
      environmentVariables: { PRIVATE: SECRET }, secretEnvironmentVariables: [{ secret: SECRET }],
      serviceAccountEmail: SECRET, uri: `https://example.invalid/?token=${SECRET}`,
    },
  }
}

// Test-scoped synthetic baseline receipt (its own sha256/sourceHead — never
// the real pinned production EXPECTED_BASELINE_RECEIPT_SHA256/
// EXPECTED_BASELINE_SOURCE_HEAD) so the full drift-comparison path can be
// exercised without needing to reconstruct the real, redacted GCS source
// objects the real pinned receipt's hashes were originally computed from.
const TEST_SOURCE_HEAD = 'b'.repeat(40)
function testReceiptFunctionFrom(name) {
  const checked = checkFunction(providerFunction(name), '12345')
  return {
    name: checked.name, state: 'ACTIVE', generation: 2, runtime: 'nodejs22', region: 'us-central1',
    revision: checked.revision, build: checked.build,
    sourceReferenceSha256: checked.sourceReferenceSha256, sourceProvenanceSha256: checked.sourceProvenanceSha256,
  }
}
function testReceiptBytes() {
  const receipt = {
    task: 'SEC-006 Stage 8', mode: 'postflight', status: 'DEPLOYMENT_METADATA_VERIFIED', project: PROJECT,
    sourceHead: TEST_SOURCE_HEAD, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:03.000Z',
    billingEnabled: true, database: { name: DATABASE, type: 'FIRESTORE_NATIVE', locationId: 'eur3' },
    functions: BASELINE_CALLABLES.map(testReceiptFunctionFrom),
    deploymentAllowlist: [...BASELINE_CALLABLES], excludedFromDeployment: ['authzProbe'],
  }
  return Buffer.from(JSON.stringify(receipt))
}
const TEST_RECEIPT_BYTES = testReceiptBytes()
const TEST_RECEIPT_SHA256 = sha256(TEST_RECEIPT_BYTES)

function fixtures() {
  return {
    project: { projectId: PROJECT, projectNumber: '12345', unknown: SECRET },
    billing: { projectId: PROJECT, billingEnabled: true, billingAccountName: SECRET },
    database: { name: DATABASE, locationId: 'eur3', type: 'FIRESTORE_NATIVE', unknown: SECRET },
    functionsV1: {},
    functionsV2: { functions: ALL_CALLABLES.map(name => providerFunction(name)) },
  }
}
function harness(data = fixtures(), overrides = {}) {
  const calls = []; let authorizations = 0
  const execute = extra => run13FunctionDeploymentCheck({
    options, gitState: clean, authorize: async () => { authorizations++ },
    get: async spec => {
      calls.push(spec)
      const kind = Object.keys(URLS).find(key => URLS[key] === spec.url)
      assert(kind)
      return data[kind]
    },
    baselineReceiptBytes: TEST_RECEIPT_BYTES, commitIsReachable: true,
    expectedReceiptSha256: TEST_RECEIPT_SHA256, expectedSourceHead: TEST_SOURCE_HEAD,
    ...overrides, ...extra,
  })
  return { execute, calls, authorizations: () => authorizations }
}

test('positive: 13 functions (8 baseline no-drift + 5 member-management) verified in one pass', async () => {
  const h = harness()
  const result = await h.execute()
  assert.equal(result.status, 'DEPLOYMENT_METADATA_VERIFIED_13FN')
  assert.equal(result.task, TASK)
  assert.equal(result.functions.length, 13)
  const baseline = result.functions.filter(f => f.family === 'baseline')
  const memberMgmt = result.functions.filter(f => f.family === 'member-management')
  assert.equal(baseline.length, 8); assert.equal(memberMgmt.length, 5)
  for (const f of memberMgmt) assert.ok(MEMBER_MANAGEMENT_CALLABLES.some(name => f.name.endsWith(`/${name}`)))
  for (const f of baseline) assert.equal(f.driftCheckedAgainstSourceHead, TEST_SOURCE_HEAD)
  assert.equal(h.authorizations(), 1)
  assert.equal(h.calls.length, 5)
  assert(!JSON.stringify(result).includes(SECRET))
})

test('missing one baseline function blocks', async () => {
  const data = fixtures()
  data.functionsV2 = { functions: ALL_CALLABLES.filter(n => n !== 'acceptInvite').map(name => providerFunction(name)) }
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('missing one member-management function blocks', async () => {
  const data = fixtures()
  data.functionsV2 = { functions: ALL_CALLABLES.filter(n => n !== 'removeMember').map(name => providerFunction(name)) }
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('a 14th, unexpected function blocks', async () => {
  const data = fixtures()
  data.functionsV2 = { functions: [...ALL_CALLABLES.map(name => providerFunction(name)), providerFunction('unexpectedFn')] }
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('exactly 13 functions but with one unexpected/foreign name (not in either allowlist) blocks', async () => {
  const data = fixtures()
  const functions = ALL_CALLABLES.filter(n => n !== 'acceptInvite').map(name => providerFunction(name))
  functions.push(providerFunction('someOtherFunction'))
  data.functionsV2 = { functions }
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('14 total (all 13 required once, plus one extra duplicate) blocks', async () => {
  const data = fixtures()
  data.functionsV2 = { functions: [...ALL_CALLABLES.map(name => providerFunction(name)), providerFunction('acceptInvite')] }
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('13 total but with an internal duplicate (one name twice, another required name missing) blocks', async () => {
  const data = fixtures()
  data.functionsV2 = {
    functions: ALL_CALLABLES.filter(n => n !== 'acceptInvite').map(name => providerFunction(name))
      .concat(providerFunction('removeMember')),
  }
  assert.equal(data.functionsV2.functions.length, ALL_CALLABLES.length)
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('baseline revision drift against the receipt blocks', async () => {
  const data = fixtures()
  data.functionsV2 = {
    functions: ALL_CALLABLES.map(name => name === 'acceptInvite' ? providerFunction(name, '00002-xyz') : providerFunction(name)),
  }
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('baseline source drift (unchanged revision, different underlying source) against the receipt blocks', async () => {
  const data = fixtures()
  const drifted = providerFunction('acceptInvite')
  drifted.buildConfig.source.storageSource.object = 'a-different-object-path'
  data.functionsV2 = { functions: ALL_CALLABLES.map(name => name === 'acceptInvite' ? drifted : providerFunction(name)) }
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('member-management function with wrong resource shape blocks', async () => {
  const data = fixtures()
  const wrong = providerFunction('removeMember')
  wrong.serviceConfig.availableMemory = '512Mi'
  data.functionsV2 = { functions: ALL_CALLABLES.map(name => name === 'removeMember' ? wrong : providerFunction(name)) }
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('member-management function with wrong runtime blocks', async () => {
  const data = fixtures()
  const wrong = providerFunction('disableMember')
  wrong.buildConfig.runtime = 'nodejs20'
  data.functionsV2 = { functions: ALL_CALLABLES.map(name => name === 'disableMember' ? wrong : providerFunction(name)) }
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('member-management function in wrong GEN1/state blocks', async () => {
  const data = fixtures()
  const wrong = providerFunction('restoreMember')
  wrong.state = 'DEPLOYING'
  data.functionsV2 = { functions: ALL_CALLABLES.map(name => name === 'restoreMember' ? wrong : providerFunction(name)) }
  await assert.rejects(harness(data).execute(), /deployment_check_13fn_blocked/)
})

test('tampered receipt bytes (SHA-256 mismatch) block before any network call', async () => {
  const tampered = Buffer.concat([TEST_RECEIPT_BYTES, Buffer.from(' ')])
  const h = harness(fixtures(), { baselineReceiptBytes: tampered })
  await assert.rejects(h.execute(), /deployment_check_13fn_blocked/)
  assert.equal(h.calls.length, 0); assert.equal(h.authorizations(), 0)
})

test('receipt sourceHead not reachable in git history blocks before any network call', async () => {
  const h = harness(fixtures(), { commitIsReachable: false })
  await assert.rejects(h.execute(), /deployment_check_13fn_blocked/)
  assert.equal(h.calls.length, 0); assert.equal(h.authorizations(), 0)
})

test('receipt whose recorded sourceHead does not match the pinned expected value blocks', async () => {
  const wrongHeadReceipt = JSON.parse(TEST_RECEIPT_BYTES.toString('utf8'))
  wrongHeadReceipt.sourceHead = 'c'.repeat(40)
  const bytes = Buffer.from(JSON.stringify(wrongHeadReceipt))
  const h = harness(fixtures(), { baselineReceiptBytes: bytes, expectedReceiptSha256: sha256(bytes) })
  await assert.rejects(h.execute(), /deployment_check_13fn_blocked/)
})

test('a receipt with a duplicated function name is rejected by provenance validation alone', () => {
  const receipt = JSON.parse(TEST_RECEIPT_BYTES.toString('utf8'))
  receipt.functions[1] = { ...receipt.functions[0] }
  const bytes = Buffer.from(JSON.stringify(receipt))
  assert.throws(() => validateBaselineReceiptProvenance({
    bytes, commitIsReachable: true, expectedReceiptSha256: sha256(bytes), expectedSourceHead: TEST_SOURCE_HEAD,
  }), /deployment_check_13fn_blocked/)
})

test('a receipt with 9 entries (all 8 required once, plus one extra duplicate appended) is rejected by provenance validation alone', () => {
  const receipt = JSON.parse(TEST_RECEIPT_BYTES.toString('utf8'))
  receipt.functions.push({ ...receipt.functions[0] })
  assert.equal(receipt.functions.length, BASELINE_CALLABLES.length + 1)
  const bytes = Buffer.from(JSON.stringify(receipt))
  assert.throws(() => validateBaselineReceiptProvenance({
    bytes, commitIsReachable: true, expectedReceiptSha256: sha256(bytes), expectedSourceHead: TEST_SOURCE_HEAD,
  }), /deployment_check_13fn_blocked/)
})

test('a receipt missing one baseline function entry is rejected by provenance validation alone', () => {
  const receipt = JSON.parse(TEST_RECEIPT_BYTES.toString('utf8'))
  receipt.functions.pop()
  const bytes = Buffer.from(JSON.stringify(receipt))
  assert.throws(() => validateBaselineReceiptProvenance({
    bytes, commitIsReachable: true, expectedReceiptSha256: sha256(bytes), expectedSourceHead: TEST_SOURCE_HEAD,
  }), /deployment_check_13fn_blocked/)
})

test('the real, checked-in baseline receipt fixture matches its pinned production provenance exactly', () => {
  const bytes = fs.readFileSync(path.join(HERE, 'testFixtures/stage8-deployment-postflight-ab1bd67.json'))
  assert.equal(sha256(bytes), EXPECTED_BASELINE_RECEIPT_SHA256)
  const byName = validateBaselineReceiptProvenance({ bytes, commitIsReachable: true })
  assert.equal(byName.size, BASELINE_CALLABLES.length)
  for (const name of BASELINE_CALLABLES) assert.ok(byName.has(name))
})

test('the real fixture is refused when its pinned commit is reported unreachable', () => {
  const bytes = fs.readFileSync(path.join(HERE, 'testFixtures/stage8-deployment-postflight-ab1bd67.json'))
  assert.throws(() => validateBaselineReceiptProvenance({ bytes, commitIsReachable: false }), /deployment_check_13fn_blocked/)
})

test('checkMemberManagementFunction accepts only the 5 named member-management functions, never a baseline one', () => {
  for (const name of MEMBER_MANAGEMENT_CALLABLES) {
    const checked = checkMemberManagementFunction(providerFunction(name), '12345')
    assert.equal(checked.runtime, 'nodejs22'); assert.equal(checked.resources.minInstances, 0)
  }
  assert.throws(() => checkMemberManagementFunction(providerFunction('acceptInvite'), '12345'))
})

test('reviewed HEAD, clean checkout and safe environment are required before credentials', async () => {
  for (const change of [
    { options: { ...options, project: 'foreign' } },
    { options: { ...options, expectedHead: 'main' } },
    { gitState: () => ({ head: HEAD, status: ' M source.ts' }) },
    { gitState: () => ({ head: 'z'.repeat(40), status: '' }) },
    ...['FIREBASE_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'FIREBASE_AUTH_EMULATOR_HOST', 'DEBUG']
      .map(key => ({ options: { ...options, env: { [key]: SECRET } } })),
  ]) {
    const h = harness()
    await assert.rejects(h.execute(change))
    assert.equal(h.authorizations(), 0); assert.equal(h.calls.length, 0)
  }
})
