// Mutation checks on gateGaStagingAdapters.mjs itself (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9,
// requirement 5) — proves gateGaStagingAdaptersCoreSelfTest.mjs actually
// exercises the real staging-adapter branches, not just happens to pass.
// Same technique as gateGaOrchestratorMutationChecks.mjs: copy the whole
// scripts/invitationRehearsal directory, apply one deliberate literal
// defect to gateGaStagingAdapters.mjs, rerun gateGaStagingAdaptersCoreSelfTest.mjs
// unmodified against the mutated copy, and require it to now fail.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const MUTANTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-staging-adapters-mutants-'))
const results = []

function copyDir(name) {
  const dest = path.join(MUTANTS_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.cpSync(SRC, dest, { recursive: true })
  return dest
}
function mutate(dir, file, from, to) {
  const f = path.join(dir, file)
  const text = fs.readFileSync(f, 'utf8')
  if (!text.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from.slice(0, 90)}`)
  fs.writeFileSync(f, text.replace(from, () => to))
}
function runSelfTest(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, 'gateGaStagingAdaptersCoreSelfTest.mjs')], { encoding: 'utf8', cwd: dir, timeout: 60_000 })
  const fail = r.stdout.match(/ℹ fail (\d+)/)
  return { exitCode: r.status, fail: fail ? Number(fail[1]) : null }
}
function record(name, detected, detail) {
  results.push({ mutation: name, detected: Boolean(detected), detail })
  console.log(`${detected ? 'DETECTED' : 'NOT DETECTED'} ${name} ${JSON.stringify(detail)}`)
}
function expectFailure(name, dir) {
  const r = runSelfTest(dir)
  record(name, r.exitCode !== 0 || (r.fail !== null && r.fail > 0), r)
}

{
  const dir = copyDir('m1-admin-identity-reverts-to-runtag')
  mutate(dir, 'gateGaStagingAdapters.mjs',
    "const { adminEmail, idempotencyKey } = deriveAdminIdentity(runId)\n      const adminPassword = generatePassword()\n      const signUp = await identity('accounts:signUp', { email: adminEmail, password: adminPassword, returnSecureToken: true })",
    "const adminEmail = `${Date.now()}-admin@example.invalid`\n      const idempotencyKey = `${Date.now()}-idem`\n      const adminPassword = generatePassword()\n      const signUp = await identity('accounts:signUp', { email: adminEmail, password: adminPassword, returnSecureToken: true })")
  expectFailure('M1 createAdminAndCompany reverts to a non-runId-derived (unrecoverable) admin email', dir)
}
{
  const dir = copyDir('m2-reconcile-admin-always-not-found')
  mutate(dir, 'gateGaStagingAdapters.mjs',
    'async reconcileAdminAndCompany({ runId }) {\n      const { adminEmail } = deriveAdminIdentity(runId)\n      const user = await lookupByEmail(adminEmail)',
    'async reconcileAdminAndCompany({ runId }) {\n      void runId\n      const user = null')
  expectFailure('M2 reconcileAdminAndCompany is bypassed (always reports not-found)', dir)
}
{
  const dir = copyDir('m3-reconcile-admin-removed')
  mutate(dir, 'gateGaStagingAdapters.mjs', 'async reconcileAdminAndCompany({ runId }) {', 'async reconcileAdminAndCompanyRENAMED({ runId }) {')
  expectFailure('M3 reconcileAdminAndCompany method removed from the returned adapter object entirely', dir)
}
{
  const dir = copyDir('m4-reconcile-invitation-removed')
  mutate(dir, 'gateGaStagingAdapters.mjs', 'async reconcileInvitation({ companyId, recipient }) {', 'async reconcileInvitationRENAMED({ companyId, recipient }) {')
  expectFailure('M4 reconcileInvitation method removed from the returned adapter object entirely', dir)
}
{
  const dir = copyDir('m5-find-auth-uid-by-email-removed')
  mutate(dir, 'gateGaStagingAdapters.mjs', 'async findAuthUidByEmail(email) {', 'async findAuthUidByEmailRENAMED(email) {')
  expectFailure('M5 findAuthUidByEmail method removed from the returned adapter object entirely', dir)
}
{
  const dir = copyDir('m6-invite-recipient-lockpath-reverts-to-null')
  mutate(dir, 'gateGaStagingAdapters.mjs',
    "const lockId = computeInvitationLockId(companyId, recipient.trim().toLowerCase())\n      return { inviteId: json.result.inviteId, invitationPath: `invitations/${json.result.inviteId}`, lockPath: `invitationLocks/${lockId}`, token: json.result.token }",
    "return { inviteId: json.result.inviteId, invitationPath: `invitations/${json.result.inviteId}`, lockPath: null, token: json.result.token }")
  expectFailure('M6 inviteRecipient reverts to the R8-published lockPath: null bug', dir)
}
{
  const dir = copyDir('m7-firestore-mapvalue-parsing-removed')
  mutate(dir, 'gateGaStagingAdapters.mjs',
    "else if ('mapValue' in value) out[key] = firestoreValueToPlain(value.mapValue.fields)",
    "else if ('mapValue' in value) out[key] = undefined")
  expectFailure('M7 nested Firestore mapValue fields (e.g. the bootstrap receipt\'s result.companyId) are no longer parsed', dir)
}
{
  const dir = copyDir('m8-orphaned-admin-not-detected')
  mutate(dir, 'gateGaStagingAdapters.mjs',
    "const bootstrapDoc = await readDocOrNull(`user_bootstrap/${adminUid}`)\n      if (!bootstrapDoc) return { found: true, orphaned: true, adminUid }",
    "const bootstrapDoc = await readDocOrNull(`user_bootstrap/${adminUid}`)\n      if (false) return { found: true, orphaned: true, adminUid }")
  expectFailure('M8 an orphaned admin (Auth exists, no bootstrap receipt) is no longer detected as orphaned', dir)
}
{
  const dir = copyDir('m9-reconcile-invitation-token-recoverable')
  // A defect where reconcileInvitation is changed to accept a caller-
  // supplied token instead of refusing to ever recover one — proves the
  // self-test actually checks the shape of what reconcileInvitation
  // returns (no `token` field), not just that it returns SOMETHING.
  mutate(dir, 'gateGaStagingAdapters.mjs',
    "return { found: true, inviteId, invitationPath: `invitations/${inviteId}`, lockPath }",
    "return { found: true, inviteId, invitationPath: `invitations/${inviteId}`, lockPath, token: 'forged-token-should-never-exist' }")
  expectFailure('M9 reconcileInvitation is changed to fabricate a recoverable token (never legitimate — the raw token is never persisted)', dir)
}

fs.rmSync(MUTANTS_ROOT, { recursive: true, force: true })
const undetected = results.filter(r => !r.detected)
console.log(`\nSUMMARY total=${results.length} detected=${results.length - undetected.length} undetected=${undetected.length}`)
if (undetected.length) { console.error('UNDETECTED:', undetected.map(r => r.mutation)); process.exitCode = 1 }
