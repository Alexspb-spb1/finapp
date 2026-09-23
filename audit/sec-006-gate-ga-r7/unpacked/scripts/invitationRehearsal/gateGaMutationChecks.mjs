// Controlled local mutations for the gate-G-A additions (run-id guard, manifest
// cleanup, legacy-residual evaluator, recipient preflight). Each mutant is a
// COPY of scripts/invitationRehearsal with one deliberate, literal-text defect
// (originals are never edited); detection = the corresponding self-test file,
// re-run unmodified against the mutated copy, now fails where it previously
// passed 100%. Mirrors the technique already used and reviewed for the M1
// rev8 package (tests/mutation-checks.mjs there). Copies live under a temp
// directory and are removed afterwards; only this summary is kept.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const MUTANTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-mutants-'))
const results = []

function copyDir(name) {
  const dest = path.join(MUTANTS_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.cpSync(SRC, dest, { recursive: true })
  return dest
}
function mutate(dir, file, from, to) {
  const f = path.join(dir, file)
  const text = fs.readFileSync(f, 'utf8')
  if (!text.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from.slice(0, 80)}`)
  fs.writeFileSync(f, text.replace(from, () => to))
}
function runSelfTest(dir, file) {
  const r = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8', cwd: dir, timeout: 60_000 })
  const passMatch = r.stdout.match(/# pass (\d+)/) ?? r.stdout.match(/ℹ pass (\d+)/)
  const failMatch = r.stdout.match(/# fail (\d+)/) ?? r.stdout.match(/ℹ fail (\d+)/)
  return {
    exitCode: r.status,
    pass: passMatch ? Number(passMatch[1]) : null,
    fail: failMatch ? Number(failMatch[1]) : null,
    stdoutTail: r.stdout.slice(-800),
  }
}
function record(name, mutationDetected, detail) {
  results.push({ mutation: name, detected: Boolean(mutationDetected), detail })
  console.log(`${mutationDetected ? 'DETECTED' : 'NOT DETECTED'} ${name} ${JSON.stringify(detail)}`)
}
function expectFailure(name, dir, selfTestFile) {
  const r = runSelfTest(dir, selfTestFile)
  const detected = r.exitCode !== 0 || (r.fail !== null && r.fail > 0)
  record(name, detected, { exitCode: r.exitCode, pass: r.pass, fail: r.fail })
}

// --- run-id guard ----------------------------------------------------------
{
  const dir = copyDir('m1-drop-prior-run-id-check')
  mutate(dir, 'liveAcceptanceRunIdCore.mjs',
    'const forbidden = new Set([...PRIOR_RUN_IDS, ...extraForbidden])\n  if (forbidden.has(runId)) blocked()',
    'const forbidden = new Set([...PRIOR_RUN_IDS, ...extraForbidden])')
  expectFailure('M1 run-id guard forgets to actually forbid PRIOR_RUN_IDS', dir, 'liveAcceptanceRunIdSelfTest.mjs')
}
{
  const dir = copyDir('m2-drop-namespace-collision-check')
  mutate(dir, 'liveAcceptanceRunIdCore.mjs',
    'const names = listExistingNamesSync(claimedDir)\n  if (names.some(name => name.includes(runId))) blocked()',
    'const names = listExistingNamesSync(claimedDir)')
  expectFailure('M2 run-id guard stops checking for an existing manifest/evidence namespace collision', dir, 'liveAcceptanceRunIdSelfTest.mjs')
}
{
  const dir = copyDir('m3-claim-skips-pre-check')
  mutate(dir, 'liveAcceptanceRunIdCore.mjs',
    'export function claimRunId(runId, { claimedDir, project, sourceHead, now = () => new Date() } = {}) {\n  assertRunIdAllowed(runId, { claimedDir })',
    'export function claimRunId(runId, { claimedDir, project, sourceHead, now = () => new Date() } = {}) {\n  void 0')
  expectFailure('M3 claimRunId stops re-checking assertRunIdAllowed before writing the durable claim', dir, 'liveAcceptanceRunIdSelfTest.mjs')
}

// --- manifest cleanup --------------------------------------------------------
{
  const dir = copyDir('m4-cleanup-ignores-uncertain')
  mutate(dir, 'liveAcceptanceCleanupCore.mjs',
    "const uncertainSlots = Object.freeze(WRITE_SLOTS.filter(slot => slotStates[slot] === 'UNCERTAIN'))\n  if (uncertainSlots.length) return Object.freeze({ eligible: false, reason: 'UNCERTAIN_SLOTS', uncertainSlots })",
    "const uncertainSlots = Object.freeze([])")
  expectFailure('M4 cleanup eligibility stops blocking on UNCERTAIN write-slots', dir, 'liveAcceptanceCleanupSelfTest.mjs')
}
{
  const dir = copyDir('m5-cleanup-drops-cas-overlap-check')
  mutate(dir, 'liveAcceptanceCleanupCore.mjs',
    'if (ledger.casPaths.some(path => ledger.createdFirestorePaths.includes(path))) blocked()',
    'if (false) blocked()')
  expectFailure('M5 cleanup ledger validator stops rejecting a CAS/destructive path overlap', dir, 'liveAcceptanceCleanupSelfTest.mjs')
}
{
  const dir = copyDir('m6-cleanup-drops-foreign-doc-check')
  mutate(dir, 'liveAcceptanceCleanupCore.mjs',
    'if (!ledger.createdAuthUids.every(belongsToRun)) blocked()\n  if (!ledger.createdFirestorePaths.every(belongsToRun)) blocked()',
    '// namespace ownership check removed')
  expectFailure('M6 cleanup ledger validator stops rejecting a foreign (out-of-namespace) document', dir, 'liveAcceptanceCleanupSelfTest.mjs')
}
{
  const dir = copyDir('m7-cleanup-ignores-unexpected-subcollection')
  mutate(dir, 'liveAcceptanceCleanupCore.mjs',
    "const unexpected = names.filter(name => !EXPECTED_COMPANY_SUBCOLLECTIONS.includes(name))\n    if (unexpected.length) return Object.freeze({ clean: false, path, unexpected: Object.freeze(unexpected) })",
    "const unexpected = []")
  expectFailure('M7 cleanup stops refusing on an unexpected company subcollection', dir, 'liveAcceptanceCleanupSelfTest.mjs')
}
{
  const dir = copyDir('m8-verify-clean-always-reports-clean')
  mutate(dir, 'liveAcceptanceCleanupCore.mjs',
    'return remainder.length ? Object.freeze({ clean: false, remainder: Object.freeze(remainder) }) : Object.freeze({ clean: true, remainder: Object.freeze([]) })',
    'return Object.freeze({ clean: true, remainder: Object.freeze([]) })')
  expectFailure('M8 verify-clean stops detecting a real leftover document/Auth account', dir, 'liveAcceptanceCleanupSelfTest.mjs')
}
{
  const dir = copyDir('m9-cleanup-continues-after-delete-failure')
  mutate(dir, 'liveAcceptanceCleanupCore.mjs',
    "results.push({ kind: 'firestore', id: path, ok })\n      journal.append('DELETE_ATTEMPTED', { kind: 'firestore', pathSha256: sha256(path), ok })\n      if (!ok) break outer",
    "results.push({ kind: 'firestore', id: path, ok })\n      journal.append('DELETE_ATTEMPTED', { kind: 'firestore', pathSha256: sha256(path), ok })")
  expectFailure('M9 cleanup keeps deleting after a delete already failed instead of stopping immediately', dir, 'liveAcceptanceCleanupSelfTest.mjs')
}

// --- legacy residual (2026-09-11) -------------------------------------------
{
  const dir = copyDir('m10-legacy-ignores-owner-b-present')
  mutate(dir, 'stage8LegacyResidualCore.mjs',
    "if (!record(inventory.ownerBAuth) || inventory.ownerBAuth.exists !== false) {\n    reasons.push('OWNER_B_UNEXPECTEDLY_PRESENT')\n  }",
    '// owner-B presence check removed')
  expectFailure('M10 legacy-residual evaluator stops noticing an unexpectedly present owner-B Auth account', dir, 'stage8LegacyResidualSelfTest.mjs')
}
{
  const dir = copyDir('m11-legacy-ignores-unexpected-subcollections')
  mutate(dir, 'stage8LegacyResidualCore.mjs',
    "if (!subs || JSON.stringify(subs) !== JSON.stringify([...EXPECTED_SUBCOLLECTIONS].sort())) reasons.push('UNEXPECTED_SUBCOLLECTIONS')",
    '// subcollection check removed')
  expectFailure('M11 legacy-residual evaluator stops rejecting unexpected subcollections', dir, 'stage8LegacyResidualSelfTest.mjs')
}

// --- recipient preflight -----------------------------------------------------
{
  const dir = copyDir('m12-recipient-skips-absence-requirement')
  mutate(dir, 'gateGaRecipientCore.mjs',
    "if (typeof ownerConfirmedSha256 !== 'string' || ownerConfirmedSha256 !== preflight.recipientSha256) blocked()\n  if (preflight.absent !== true) blocked('recipient must be absent from staging Auth before any invitation/email')",
    "if (typeof ownerConfirmedSha256 !== 'string' || ownerConfirmedSha256 !== preflight.recipientSha256) blocked()")
  expectFailure('M12 recipient guard stops requiring the recipient to be absent from staging Auth before sending', dir, 'gateGaRecipientSelfTest.mjs')
}

fs.rmSync(MUTANTS_ROOT, { recursive: true, force: true })

const undetected = results.filter(r => !r.detected)
console.log(`\nSUMMARY total=${results.length} detected=${results.length - undetected.length} undetected=${undetected.length}`)
if (undetected.length) {
  console.error('UNDETECTED MUTATIONS:', undetected.map(r => r.mutation))
  process.exitCode = 1
}
