import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createGateGaOrchestratedRuntime, parseCodeSha256Sums, verifyPackageIntegrity } from './gateGaStagingRuntime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const sha256 = v => createHash('sha256').update(v).digest('hex')
const HEAD = 'c84f7837bdbc0a27fea698080c779d273e8e15bb'

// --- requirement 5: the real staging entrypoint must call the new
// orchestrated runtime, never the historical plan-only one, directly. This
// is a source-level (mutation-catching) assertion: it fails the moment
// liveAcceptanceExecutor.mjs's execute() is changed to resolve
// createConcreteLiveAcceptanceRuntime as its top-level runtime again, or to
// stop resolving createGateGaOrchestratedRuntime at all. ---
test('the real staging entrypoint calls the new orchestrated runtime and never the historical plan-only runtime directly', () => {
  const entrypointSource = fs.readFileSync(path.join(HERE, 'liveAcceptanceExecutor.mjs'), 'utf8')
  // Strip line/block comments before checking for the historical symbol —
  // this file's own header comment legitimately NAMES that symbol to
  // document that it is no longer used; only live code (an import or a
  // call) may never reference it.
  const codeOnly = entrypointSource
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(entrypointSource.includes('gateGaStagingRuntime.mjs'), 'entrypoint must import gateGaStagingRuntime.mjs')
  assert.ok(entrypointSource.includes('createGateGaOrchestratedRuntime'), 'entrypoint must call createGateGaOrchestratedRuntime')
  assert.equal(codeOnly.includes('createConcreteLiveAcceptanceRuntime'), false,
    'entrypoint must never resolve the historical plan-only runtime as its top-level runtime (live code, not comments)')
  assert.equal(codeOnly.includes('buildCleanupPlanOnly'), false,
    'entrypoint must never reference the historical plan-only cleanup path (live code, not comments)')

  const cliCoreSource = fs.readFileSync(path.join(HERE, 'liveAcceptanceExecutorCliCore.mjs'), 'utf8')
  assert.ok(cliCoreSource.includes("cleanupAuthorized !== true"), 'approval validator must require real cleanup authorization, not merely allow it')
  assert.ok(cliCoreSource.includes('GATE_GA_TASK'), 'approval validator must bind to the gate-G-A task name, not the historical one')
})

// --- R5 requirement 9: the historical staging completeVerification
// throw-stub (the confirmed real blocker — it always threw, so no staging
// run could ever reach PASS) must be gone from the live staging adapter
// source, replaced by the real checkVerification/signInRecipient contract
// that the polling-based orchestrator actually calls. ---
test('the staging adapter source no longer contains the completeVerification throw-stub', () => {
  const stagingAdaptersSource = fs.readFileSync(path.join(HERE, 'gateGaStagingAdapters.mjs'), 'utf8')
  assert.equal(stagingAdaptersSource.includes('completeVerification'), false,
    'staging adapters must never define the historical always-throwing completeVerification stub again')
  assert.ok(stagingAdaptersSource.includes('checkVerification'), 'staging adapters must implement checkVerification for owner-in-the-loop polling')
  assert.ok(stagingAdaptersSource.includes('signInRecipient'), 'staging adapters must implement signInRecipient for post-verification token refresh')
})

// --- R6 requirement 1: recipientPreflight must use the admin-level OAuth
// REST lookup (projects/{PROJECT}/accounts:lookup via the guarded
// firebase-tools session), never the client API-key accounts:lookup
// endpoint (identitytoolkit.googleapis.com/v1/accounts:lookup?key=...),
// which only ever resolves the CALLER's own account from an idToken and
// does not support an arbitrary `email` array — the confirmed real bug
// fixed in this package. This isolates recipientPreflight's own function
// body (not the whole file, since `rest.post(...accounts:lookup...)` is
// legitimately used by OTHER functions in this file) and asserts it alone
// never calls the bare `identity(...)` helper. ---
test('recipientPreflight uses the admin OAuth accounts:lookup endpoint, never the client API-key one', () => {
  const stagingAdaptersSource = fs.readFileSync(path.join(HERE, 'gateGaStagingAdapters.mjs'), 'utf8')
  const match = /async recipientPreflight\(recipient\) \{([\s\S]*?)\n    \},/.exec(stagingAdaptersSource)
  assert.ok(match, 'recipientPreflight function body must be found in the staging adapter source')
  const body = match[1]
  assert.equal(/\bidentity\(/.test(body), false,
    'recipientPreflight must never call the client API-key identity() helper (it does not support arbitrary-email lookup)')
  assert.ok(/rest\.post\(`https:\/\/identitytoolkit\.googleapis\.com\/v1\/projects\/\$\{PROJECT\}\/accounts:lookup`/.test(body),
    'recipientPreflight must call the admin-level projects/{PROJECT}/accounts:lookup endpoint via the guarded OAuth REST client')
})

test('parseCodeSha256Sums parses standard sha256sum-format lines and rejects malformed ones', () => {
  const text = `${'a'.repeat(64)}  path/one.mjs\n${'b'.repeat(64)} *path/two.mjs\n`
  const parsed = parseCodeSha256Sums(text)
  assert.equal(parsed['path/one.mjs'], 'a'.repeat(64))
  assert.equal(parsed['path/two.mjs'], 'b'.repeat(64))
  assert.throws(() => parseCodeSha256Sums('not a valid line\n'))
  assert.throws(() => parseCodeSha256Sums(''))
})

function withTempPackage(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-package-integrity-'))
  try {
    const sums = []
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content)
      sums.push(`${sha256(content)}  ${name}`)
    }
    fs.writeFileSync(path.join(dir, 'CODE-SHA256SUMS.txt'), `${sums.join('\n')}\n`)
    return fn(dir)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('verifyPackageIntegrity passes on an untampered package and fails on a modified or missing file', () => {
  withTempPackage({ 'a.mjs': 'console.log(1)\n', 'b.mjs': 'console.log(2)\n' }, dir => {
    assert.equal(verifyPackageIntegrity({ packageDir: dir, io: fs }).ok, true)
    fs.writeFileSync(path.join(dir, 'a.mjs'), 'console.log(999)\n')
    const tampered = verifyPackageIntegrity({ packageDir: dir, io: fs })
    assert.equal(tampered.ok, false)
    assert.ok(tampered.mismatches.some(m => m.file === 'a.mjs' && m.reason === 'HASH_MISMATCH'))
  })
  withTempPackage({ 'a.mjs': 'console.log(1)\n' }, dir => {
    fs.rmSync(path.join(dir, 'a.mjs'))
    const missing = verifyPackageIntegrity({ packageDir: dir, io: fs })
    assert.equal(missing.ok, false)
    assert.ok(missing.mismatches.some(m => m.file === 'a.mjs' && m.reason === 'MISSING'))
  })
})

// --- requirement 4: the exact staging CLI path (createGateGaOrchestratedRuntime.run),
// proven with dependency-injected stubs — no network, no staging, no emulator. ---
test('createGateGaOrchestratedRuntime.run: package-integrity check runs before any adapter is built (no network before the seam check)', async () => {
  await withTempPackage({ 'x.mjs': 'x\n' }, async dir => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-repo-'))
    try {
      // Corrupt the package after CODE-SHA256SUMS.txt was written for it.
      fs.writeFileSync(path.join(dir, 'x.mjs'), 'tampered\n')
      let stagingBuilt = false
      const runtime = createGateGaOrchestratedRuntime({
        repoRoot, packageDir: dir, io: fs,
        buildStagingAdapters: async () => { stagingBuilt = true; return {} },
      })
      const paths = { '--journal': path.join(repoRoot, 'j.jsonl'), '--out': path.join(repoRoot, 'o.json') }
      await assert.rejects(() => runtime.run({
        parsed: { '--profile': 'staging', '--project': 'finapp-staging', '--expected-head': HEAD, '--recipient': 'a@example.invalid', '--recipient-confirmed-sha256': sha256('a@example.invalid') },
        paths, approval: {}, recheckHead: async () => true,
      }))
      assert.equal(stagingBuilt, false, 'no adapter (no network) may be built once the local package-integrity check has failed')
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }) }
  })
})

test('createGateGaOrchestratedRuntime.run: staging profile dispatches to buildStagingAdapters only, never buildEmulatorFirebaseHandles', async () => {
  await withTempPackageForOrchestrator(async dir => {
    const repoRoot = dir
    let stagingCalls = 0, emulatorCalls = 0
    const runtime = createGateGaOrchestratedRuntime({
      repoRoot, packageDir: dir, io: fs,
      buildStagingAdapters: async () => { stagingCalls++; return fakeAdapters() },
      buildEmulatorFirebaseHandles: async () => { emulatorCalls++; return {} },
    })
    const paths = { '--journal': path.join(dir, 'j.jsonl'), '--out': path.join(dir, 'o.json') }
    const recipient = 'owner-confirmed@example.invalid'
    const result = await runtime.run({
      parsed: { '--profile': 'staging', '--project': 'finapp-staging', '--expected-head': HEAD, '--recipient': recipient, '--recipient-confirmed-sha256': sha256(recipient.trim().toLowerCase()) },
      paths, approval: {}, recheckHead: async () => true,
    })
    assert.equal(stagingCalls, 1)
    assert.equal(emulatorCalls, 0)
    assert.equal(result.status, 'PASS')
    assert.equal(fs.existsSync(paths['--out']), true)
    const written = JSON.parse(fs.readFileSync(paths['--out'], 'utf8'))
    assert.equal(written.status, 'PASS')
  })
})

test('createGateGaOrchestratedRuntime.run: emulator profile dispatches to buildEmulatorFirebaseHandles only, never buildStagingAdapters', async () => {
  await withTempPackageForOrchestrator(async dir => {
    let stagingCalls = 0, emulatorCalls = 0
    const runtime = createGateGaOrchestratedRuntime({
      repoRoot: dir, packageDir: dir, io: fs,
      buildStagingAdapters: async () => { stagingCalls++; return {} },
      // Handles with no real db/auth: the orchestrator's own recipient-guard
      // try/catch (module E's fail-closed path) turns the resulting adapter
      // error into a clean SAFE_STOP, not a crash — dispatch routing is
      // still fully proven by which builder ran. A full real PASS through
      // this exact dispatch is proven separately, for real, by
      // gateGaIntegrationSuite.mjs (same createGateGaEmulatorAdapters, real
      // emulators).
      buildEmulatorFirebaseHandles: async () => { emulatorCalls++; return { runTag: 'ignored' } },
    })
    const paths = { '--journal': path.join(dir, 'j2.jsonl'), '--out': path.join(dir, 'o2.json') }
    const recipient = 'owner-confirmed@example.invalid'
    const result = await runtime.run({
      parsed: { '--profile': 'emulator', '--project': 'demo-finapp', '--expected-head': HEAD, '--recipient': recipient, '--recipient-confirmed-sha256': sha256(recipient.trim().toLowerCase()) },
      paths, approval: {}, recheckHead: async () => true,
    })
    assert.equal(result.status, 'SAFE_STOP')
    assert.equal(emulatorCalls, 1)
    assert.equal(stagingCalls, 0)
  })
})

test('createGateGaOrchestratedRuntime.run: unknown profile is refused before any adapter is built', async () => {
  await withTempPackageForOrchestrator(async dir => {
    let built = false
    const runtime = createGateGaOrchestratedRuntime({
      repoRoot: dir, packageDir: dir, io: fs,
      buildStagingAdapters: async () => { built = true; return {} },
      buildEmulatorFirebaseHandles: async () => { built = true; return {} },
    })
    const paths = { '--journal': path.join(dir, 'j3.jsonl'), '--out': path.join(dir, 'o3.json') }
    await assert.rejects(() => runtime.run({
      parsed: { '--profile': 'production', '--project': 'finapp-prod-10a83', '--expected-head': HEAD, '--recipient': 'a@example.invalid', '--recipient-confirmed-sha256': sha256('a@example.invalid') },
      paths, approval: {}, recheckHead: async () => true,
    }))
    assert.equal(built, false)
  })
})

// --- shared fixtures ------------------------------------------------------

function fakeAdapters() {
  const fsState = new Map(), authState = new Set()
  let verified = false
  const put = (p, v) => fsState.set(p, v)
  return {
    async probeReadiness() { return { ready: true, httpStatus: 401, verdict: 'ready' } },
    async recipientPreflight(recipient) { return { project: 'finapp-staging', recipientSha256: sha256(recipient.trim().toLowerCase()), absent: true } },
    async createAdminAndCompany() {
      const companyId = 'co-fake-1'
      put(`companies/${companyId}`, {}); put(`company_data/${companyId}`, {}); put(`companies/${companyId}/members/admin-1`, {})
      put('users/admin-1', {}); put('user_bootstrap/admin-1', {}); authState.add('admin-1')
      return { adminUid: 'admin-1', companyId, memberPath: `companies/${companyId}/members/admin-1`, dataPath: `company_data/${companyId}`, profilePath: 'users/admin-1', bootstrapPath: 'user_bootstrap/admin-1', adminIdToken: 'tok' }
    },
    async inviteRecipient() { put('invitations/inv-1', {}); return { inviteId: 'inv-1', invitationPath: 'invitations/inv-1', lockPath: null, token: 'tok-1' } },
    async registerRecipient() { put('users/recipient-1', {}); authState.add('recipient-1'); verified = false; return { recipientUid: 'recipient-1', idToken: 'tok', profilePath: 'users/recipient-1' } },
    async sendVerificationEmail() { verified = true; return { dispatched: true, oobCode: 'oob' } },
    async checkVerification({ recipientUid }) { return { uid: recipientUid, email: 'owner-confirmed@example.invalid', emailVerified: Boolean(verified) } },
    async signInRecipient() { return { idToken: 'tok2' } },
    async acceptInvite() { put('companies/co-fake-1/audit_events/ev-1', {}); return { ok: true, companyId: 'co-fake-1' } },
    async readCompanyRoleFor() { return { role: 'accountant' } },
    async auditEventCount() { return fsState.has('companies/co-fake-1/audit_events/ev-1') ? 1 : 0 },
    async memberUpdatedAtMs() { return 1 },
    async findAuditEventPaths() { return ['companies/co-fake-1/audit_events/ev-1'] },
    async listChildCollections() { return ['members', 'audit_events'] },
    async readDoc(p) { return { exists: fsState.has(p), stateSha256: fsState.has(p) ? '11'.repeat(32) : null } },
    async deleteDoc(p) { fsState.delete(p) },
    async deleteAuthUser(uid) { authState.delete(uid) },
    async authUserExists(uid) { return authState.has(uid) },
    async authUserExistsByEmail() { return false },
    async legacyInventory() { return { ownerAAuth: { exists: false, uid: null }, ownerBAuth: { exists: false }, bootstrap: { exists: false, ownerUid: null }, companies: [] } },
    legacyAdapters: { async listChildCollections() { return [] }, async readDoc() { return { exists: false, stateSha256: null } }, async deleteDoc() {}, async deleteAuthUser() {}, async authUserExists() { return false }, async authUserExistsByEmail() { return false } },
  }
}

async function withTempPackageForOrchestrator(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-orchestrator-cli-'))
  try {
    const files = { 'seam.mjs': 'seam\n' }
    const sums = Object.entries(files).map(([name, content]) => `${sha256(content)}  ${name}`)
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
    fs.writeFileSync(path.join(dir, 'CODE-SHA256SUMS.txt'), `${sums.join('\n')}\n`)
    return await fn(dir)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
