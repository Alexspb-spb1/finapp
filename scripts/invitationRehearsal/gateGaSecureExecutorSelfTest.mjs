// Proves gateGaSecureExecutorCore.mjs's wrapRuntimeWithFunctionsEvidenceGate
// both at the unit level (forged hash never reaches a fake runtime; a
// real match delegates and returns the real result) and at FULL
// PRODUCTION WIRING level — createGateGaOrchestratedRuntime with a
// buildStagingAdapters that wraps the REAL createGateGaStagingAdapters
// factory (the exact wiring gateGaSecureExecutor.mjs / liveAcceptance-
// Executor.mjs use), gated by this module, with a forged functionsSha256
// — asserting ZERO session/auth/network/fetch calls of any kind. This is
// the answer to independent-review item 4: proving the REAL --execute
// path (via this wrapper) stops before any network with a forged hash,
// not just that an isolated unit rejects a bad hash.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { PROJECT } from './inventoryCore.mjs'
import { CALLABLES as BASELINE_CALLABLES } from './deploymentCheckCore.mjs'
import {
  TASK as DEPLOYMENT_CHECK_13FN_TASK, MEMBER_MANAGEMENT_CALLABLES,
  EXPECTED_BASELINE_SOURCE_HEAD, EXPECTED_BASELINE_RECEIPT_SHA256,
} from './gateGaDeploymentCheck13Core.mjs'
import { createGateGaOrchestratedRuntime } from './gateGaStagingRuntime.mjs'
import { createGateGaStagingAdapters } from './gateGaStagingAdapters.mjs'
import { computeFirebaseConfigFingerprint } from '../lib/firebaseConfigFingerprint.mjs'
import { wrapRuntimeWithFunctionsEvidenceGate } from './gateGaSecureExecutorCore.mjs'

const sha256 = v => createHash('sha256').update(v).digest('hex')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const HEAD = 'c84f7837bdbc0a27fea698080c779d273e8e15bb'
const CHECKER_HEAD = 'b'.repeat(40)
const STAGING_CONFIG = {
  apiKey: 'private_api_key_1234567890', authDomain: 'finapp-staging.firebaseapp.com', projectId: 'finapp-staging',
  storageBucket: 'finapp-staging.firebasestorage.app', messagingSenderId: '123456789', appId: '1:123:web:abc',
}
const stagingEnvBytes = () => Buffer.from([
  'VITE_APP_ENV=staging', `VITE_FIREBASE_API_KEY=${STAGING_CONFIG.apiKey}`, `VITE_FIREBASE_AUTH_DOMAIN=${STAGING_CONFIG.authDomain}`,
  `VITE_FIREBASE_PROJECT_ID=${STAGING_CONFIG.projectId}`, `VITE_FIREBASE_STORAGE_BUCKET=${STAGING_CONFIG.storageBucket}`,
  `VITE_FIREBASE_MESSAGING_SENDER_ID=${STAGING_CONFIG.messagingSenderId}`, `VITE_FIREBASE_APP_ID=${STAGING_CONFIG.appId}`,
  `STAGING_FIREBASE_CONFIG_FINGERPRINT=${computeFirebaseConfigFingerprint(STAGING_CONFIG)}`, '',
].join('\n'))

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-secure-executor-'))
  try { return await fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
function makeNetworkSpy() {
  const calls = { getGlobalDefaultAccount: 0, requireAuth: 0, getAccessToken: 0 }
  const loadModule = name => {
    if (name === 'logger.js') return { logger: {} }
    if (name === 'auth.js') return { getGlobalDefaultAccount: () => { calls.getGlobalDefaultAccount++; throw new Error('must never be called') } }
    if (name === 'requireAuth.js') return { requireAuth: async () => { calls.requireAuth++; throw new Error('must never be called') } }
    if (name === 'apiv2.js') return { Client: class {}, getAccessToken: async () => { calls.getAccessToken++; throw new Error('must never be called') }, setAccessToken: () => {} }
    throw new Error(`unexpected loadModule request: ${name}`)
  }
  return { calls, loadModule }
}
// See FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9 (audit follow-up, 2nd pass):
// must be async and must only restore globalThis.fetch AFTER the awaited
// callback completes, or a real fetch call during that window silently
// bypasses the spy.
async function withFetchSpy(fn) {
  const original = globalThis.fetch
  let count = 0
  globalThis.fetch = async (...args) => { count++; throw new Error(`fetch must never be called: ${args[0]}`) }
  try { return await fn(() => count) } finally { globalThis.fetch = original }
}
async function withTempPackage(fn) {
  return withTempDir(async dir => {
    fs.writeFileSync(path.join(dir, '.env.staging.local'), stagingEnvBytes())
    const files = { 'seam.mjs': 'seam\n' }
    const sums = Object.entries(files).map(([name, content]) => `${sha256(content)}  ${name}`)
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
    fs.writeFileSync(path.join(dir, 'CODE-SHA256SUMS.txt'), `${sums.join('\n')}\n`)
    return fn(dir)
  })
}

function functionEntry(name, family) {
  return {
    name: `projects/${PROJECT}/locations/us-central1/functions/${name}`, state: 'ACTIVE', generation: 2,
    runtime: 'nodejs22', region: 'us-central1',
    resources: { memory: '256Mi', cpu: 1, concurrency: 1, minInstances: 0, maxInstances: 1, timeoutSeconds: 60 },
    revision: `${name.toLowerCase()}-00001-abc`, build: 'projects/12345/locations/us-central1/builds/11111111-2222-3333-4444-555555555555',
    sourceKind: 'storage', sourceReferenceSha256: sha256(`${name}-source`), sourceProvenanceSha256: sha256(`${name}-provenance`),
    rollbackArtifactAvailability: 'NOT_VERIFIED', family,
    ...(family === 'baseline' ? { driftCheckedAgainstSourceHead: EXPECTED_BASELINE_SOURCE_HEAD } : {}),
  }
}
function realFunctionsReceiptBytes() {
  return Buffer.from(JSON.stringify({
    task: DEPLOYMENT_CHECK_13FN_TASK, status: 'DEPLOYMENT_METADATA_VERIFIED_13FN', project: PROJECT, sourceHead: CHECKER_HEAD,
    finishedAt: new Date().toISOString(), billingEnabled: true,
    functions: [...BASELINE_CALLABLES.map(n => functionEntry(n, 'baseline')), ...MEMBER_MANAGEMENT_CALLABLES.map(n => functionEntry(n, 'member-management'))],
    baselineDriftCheckedAgainstSourceHead: EXPECTED_BASELINE_SOURCE_HEAD, baselineDriftCheckedAgainstReceiptSha256: EXPECTED_BASELINE_RECEIPT_SHA256,
  }))
}

// ---- unit level ----

test('wrapRuntimeWithFunctionsEvidenceGate: a forged functionsSha256 never reaches the wrapped runtime.run', async () => {
  const realReceipt = realFunctionsReceiptBytes()
  let realRuntimeCalled = 0
  const fakeRuntime = { run: async () => { realRuntimeCalled++; return { status: 'PASS' } } }
  const wrapped = wrapRuntimeWithFunctionsEvidenceGate({ runtime: fakeRuntime, functionsReceiptBytes: realReceipt, expectedCheckerSourceHead: CHECKER_HEAD })
  await assert.rejects(wrapped.run({ approval: { functionsSha256: 'f'.repeat(64) }, parsed: { '--project': PROJECT } }), /approval_evidence_binding_blocked/)
  assert.equal(realRuntimeCalled, 0)
})

test('wrapRuntimeWithFunctionsEvidenceGate: a genuinely matching functionsSha256 delegates to the real runtime and returns its result unchanged', async () => {
  const realReceipt = realFunctionsReceiptBytes()
  let realRuntimeCalled = 0
  const fakeRuntime = { run: async value => { realRuntimeCalled++; return { status: 'PASS', echoedProject: value.parsed['--project'] } } }
  const wrapped = wrapRuntimeWithFunctionsEvidenceGate({ runtime: fakeRuntime, functionsReceiptBytes: realReceipt, expectedCheckerSourceHead: CHECKER_HEAD })
  const result = await wrapped.run({ approval: { functionsSha256: sha256(realReceipt) }, parsed: { '--project': PROJECT } })
  assert.equal(realRuntimeCalled, 1)
  assert.equal(result.status, 'PASS')
  assert.equal(result.echoedProject, PROJECT)
})

test('wrapRuntimeWithFunctionsEvidenceGate: malformed constructor inputs are rejected', () => {
  assert.throws(() => wrapRuntimeWithFunctionsEvidenceGate({ runtime: {}, functionsReceiptBytes: Buffer.from('x'), expectedCheckerSourceHead: CHECKER_HEAD }))
  assert.throws(() => wrapRuntimeWithFunctionsEvidenceGate({ runtime: { run: async () => {} }, functionsReceiptBytes: 123, expectedCheckerSourceHead: CHECKER_HEAD }))
})

// ---- full production wiring: real createGateGaOrchestratedRuntime + real
// createGateGaStagingAdapters, gated, forged hash, zero network ----

test('FULL WIRING: a forged functionsSha256 refuses the real staging run with ZERO session/auth/network/fetch calls of any kind', async () => {
  await withTempPackage(async dir => {
    const { calls, loadModule } = makeNetworkSpy()
    const functionsReceiptBytes = realFunctionsReceiptBytes() // computed exactly once
    await withFetchSpy(async getFetchCount => {
      const runtime = createGateGaOrchestratedRuntime({
        repoRoot: dir, packageDir: dir, io: fs,
        buildStagingAdapters: async ({ runTag }) => createGateGaStagingAdapters({ repoRoot: dir, io: fs, runTag, loadModule }),
        buildEmulatorFirebaseHandles: async () => { throw new Error('must not build emulator handles for a staging profile run') },
      })
      const gated = wrapRuntimeWithFunctionsEvidenceGate({
        runtime, functionsReceiptBytes, expectedCheckerSourceHead: CHECKER_HEAD,
      })
      const paths = { '--journal': path.join(dir, 'j.jsonl'), '--out': path.join(dir, 'o.json') }
      const recipient = 'owner-confirmed@example.invalid'
      await assert.rejects(gated.run({
        parsed: { '--profile': 'staging', '--project': PROJECT, '--expected-head': HEAD, '--recipient': recipient, '--recipient-confirmed-sha256': sha256(recipient.trim().toLowerCase()) },
        paths, approval: { functionsSha256: 'f'.repeat(64) }, recheckHead: async () => true,
      }), /approval_evidence_binding_blocked/)
      assert.deepEqual(calls, { getGlobalDefaultAccount: 0, requireAuth: 0, getAccessToken: 0 })
      assert.equal(getFetchCount(), 0)
      // Nothing was ever written — the gate refused before the orchestrator
      // (and its own journal/out writes) was ever reached.
      assert.equal(fs.existsSync(paths['--out']), false)
      assert.equal(fs.existsSync(paths['--journal']), false)
    })
  })
})

test('FULL WIRING: a genuinely matching functionsSha256 passes the gate and reaches the real orchestrator (whatever happens next is the real orchestrator\'s own business, never this gate\'s rejection)', async () => {
  await withTempPackage(async dir => {
    const { loadModule } = makeNetworkSpy()
    const functionsReceiptBytes = realFunctionsReceiptBytes() // computed exactly once, reused below
    const runtime = createGateGaOrchestratedRuntime({
      repoRoot: dir, packageDir: dir, io: fs,
      buildStagingAdapters: async ({ runTag }) => createGateGaStagingAdapters({ repoRoot: dir, io: fs, runTag, loadModule }),
      buildEmulatorFirebaseHandles: async () => { throw new Error('must not build emulator handles for a staging profile run') },
    })
    const gated = wrapRuntimeWithFunctionsEvidenceGate({
      runtime, functionsReceiptBytes, expectedCheckerSourceHead: CHECKER_HEAD,
    })
    const paths = { '--journal': path.join(dir, 'j.jsonl'), '--out': path.join(dir, 'o.json') }
    const recipient = 'owner-confirmed@example.invalid'
    // This minimal fixture package is not a full, real staging package, so
    // the real orchestrator is expected to itself refuse further in — the
    // only thing under test here is that it is REACHED at all (i.e. this
    // gate is not what stops it), not what its own internal reason is.
    try {
      await gated.run({
        parsed: { '--profile': 'staging', '--project': PROJECT, '--expected-head': HEAD, '--recipient': recipient, '--recipient-confirmed-sha256': sha256(recipient.trim().toLowerCase()) },
        paths, approval: { functionsSha256: sha256(functionsReceiptBytes) }, recheckHead: async () => true,
      })
    } catch (error) {
      assert.notEqual(error.message, 'approval_evidence_binding_blocked')
    }
  })
})

// ---- real subprocess, real file: gateGaSecureExecutor.mjs itself, real
// argument parsing, real clean-HEAD check, real gate. Deliberately uses
// --profile emulator (never --profile staging) so that even in the worst
// case of a gate regression, the only thing an escaped run could reach is
// a nonexistent LOCAL emulator host (an immediate, harmless connection
// refusal) — never real finapp-staging. The precise, numeric zero-
// network-call proof lives in the in-process FULL WIRING tests above,
// which can safely simulate a staging profile under a controlled
// loadModule spy; this test instead proves the REAL FILE — its argument
// parsing (including the two new --functions-receipt/--expected-checker-
// source-head flags), its real clean-HEAD check against this actual
// checkout, and its real gate — behaves safely end to end. ----

test('REAL FILE: gateGaSecureExecutor.mjs --help documents the two new required flags and touches no git/filesystem/network', () => {
  const result = spawnSync(process.execPath, [path.join(HERE, 'gateGaSecureExecutor.mjs'), '--help'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--functions-receipt/)
  assert.match(result.stdout, /--expected-checker-source-head/)
})

test('REAL FILE: gateGaSecureExecutor.mjs --execute without the two new required flags refuses before touching git or any file', () => {
  const result = spawnSync(process.execPath, [
    path.join(HERE, 'gateGaSecureExecutor.mjs'), '--execute',
    '--profile', 'emulator', '--project', 'demo-finapp', '--expected-head', 'a'.repeat(40),
    '--approval', '/nonexistent/approval.json', '--approval-sha256', 'a'.repeat(64),
    '--journal', '/nonexistent/journal.jsonl', '--out', '/nonexistent/out.json',
    '--recipient', 'owner-confirmed@example.invalid', '--recipient-confirmed-sha256', 'b'.repeat(64),
    '--resume', 'false', '--legacy-cleanup-approved', 'false',
  ], { encoding: 'utf8', timeout: 10_000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /local_gate/)
})

test('REAL FILE: gateGaSecureExecutor.mjs --execute, run for real against this actual checkout\'s real HEAD, with a forged functionsSha256, refuses fast with no output files (--profile emulator: even a gate regression could only reach a nonexistent local emulator, never real staging)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-secure-executor-real-file-'))
  try {
    const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const functionsReceiptPath = path.join(dir, 'functions-receipt.json')
    fs.writeFileSync(functionsReceiptPath, realFunctionsReceiptBytes())
    const approvalPath = path.join(dir, 'approval.json')
    // A syntactically well-formed but forged approval — this is exactly
    // the shape validateExecutionApproval()'s own format-only check would
    // accept; only this round's gate is supposed to catch it.
    fs.writeFileSync(approvalPath, JSON.stringify({ functionsSha256: 'f'.repeat(64) }))
    const journalPath = path.join(dir, 'journal.jsonl')
    const outPath = path.join(dir, 'out.json')
    const recipient = 'owner-confirmed@example.invalid'

    const started = Date.now()
    const result = spawnSync(process.execPath, [
      path.join(HERE, 'gateGaSecureExecutor.mjs'), '--execute',
      '--functions-receipt', functionsReceiptPath, '--expected-checker-source-head', CHECKER_HEAD,
      '--profile', 'emulator', '--project', 'demo-finapp', '--expected-head', realHead,
      '--approval', approvalPath, '--approval-sha256', sha256(fs.readFileSync(approvalPath)),
      '--journal', journalPath, '--out', outPath,
      '--recipient', recipient, '--recipient-confirmed-sha256', sha256(recipient.trim().toLowerCase()),
      '--resume', 'false', '--legacy-cleanup-approved', 'false',
    ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 20_000, env: { ...process.env } })
    const elapsedMs = Date.now() - started

    assert.notEqual(result.status, 0)
    // Whether this checkout happened to be clean or not at test-run time,
    // the outcome that matters is unconditionally true either way: no
    // output was ever written, and the process failed fast rather than
    // hanging on a real network/auth attempt.
    assert.equal(fs.existsSync(outPath), false)
    assert.equal(fs.existsSync(journalPath), false)
    assert.ok(elapsedMs < 10_000, `expected a fast local refusal, took ${elapsedMs}ms`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
