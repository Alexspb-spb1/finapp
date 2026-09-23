// Mutation checks on the orchestrator SEAM itself (the sequencing logic in
// gateGaOrchestratorCore.mjs), as distinct from gateGaMutationChecks.mjs
// (which mutates the individual A/B/C/E modules). Same technique: copy the
// whole scripts/invitationRehearsal directory, apply one deliberate literal
// defect to gateGaOrchestratorCore.mjs, rerun gateGaOrchestratorSelfTest.mjs
// unmodified against the mutated copy, and require it to now fail.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const MUTANTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-orchestrator-mutants-'))
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
  const r = spawnSync(process.execPath, [path.join(dir, 'gateGaOrchestratorSelfTest.mjs')], { encoding: 'utf8', cwd: dir, timeout: 60_000 })
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
  const dir = copyDir('m1-skip-run-id-claim')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    "runId = faults.reuseRunId ? PRIOR_RUN_IDS[0] : generateRunId()\n    claimRunId(runId, { claimedDir, project, sourceHead })",
    "runId = faults.reuseRunId ? PRIOR_RUN_IDS[0] : generateRunId()")
  expectFailure('M1 orchestrator stops calling claimRunId before external creation', dir)
}
{
  const dir = copyDir('m2-skip-recipient-guard')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'recipientPreflight = await adapters.recipientPreflight(recipient)\n    assertOwnerConfirmedRecipient(recipientPreflight, ownerConfirmedRecipientSha256)',
    'recipientPreflight = { recipientSha256: ownerConfirmedRecipientSha256, absent: true }')
  expectFailure('M2 recipient guard (adapter consultation) disabled', dir)
}
{
  const dir = copyDir('m3-skip-cleanup-call')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'cleanupResult = await executeManifestCleanup({\n      runId, slotStates, ledger, adapters: cleanupAdapters, journal, allowedIdFragments,\n    })',
    "cleanupResult = { status: 'CLEANUP_COMPLETE_VERIFIED', deleted: { authUids: [], firestorePaths: [] } }")
  expectFailure('M3 cleanup of the current run is skipped entirely (result faked instead of executed)', dir)
}
{
  const dir = copyDir('m4-fake-verify-clean')
  // executeManifestCleanup itself performs verify-clean; simulate the seam
  // skipping it by accepting ANY cleanup outcome (including a real mismatch)
  // as sufficient for the final PASS decision.
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    "const currentClean = cleanupResult.status === 'CLEANUP_COMPLETE_VERIFIED'",
    'const currentClean = true')
  expectFailure('M4 verify-clean outcome is ignored for the final PASS decision', dir)
}
{
  const dir = copyDir('m5-no-cleanup-after-stop')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'let cleanupResult\n  try {\n    cleanupResult = await executeManifestCleanup({',
    "let cleanupResult = { status: 'NOT_APPLICABLE', deleted: { authUids: [], firestorePaths: [] } }\n  if (flowOutcome.status === 'PASS') try {\n    cleanupResult = await executeManifestCleanup({")
  expectFailure('M5 cleanup no longer runs after a safely-classified STOP, only after PASS', dir)
}
{
  const dir = copyDir('m6-pass-with-residual')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    "const finalStatus = flowPassed && currentClean && legacyClean && emailCountOk ? 'PASS' : 'SAFE_STOP'",
    "const finalStatus = flowPassed ? 'PASS' : 'SAFE_STOP'")
  expectFailure('M6 final PASS no longer requires current-run cleanup/verify-clean or a bounded email count', dir)
}
{
  const dir = copyDir('m7-legacy-cleanup-skips-eligibility')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'if (legacyEvaluation.eligible && faults.confirmLegacyCleanup) {',
    'if (faults.confirmLegacyCleanup) {')
  expectFailure('M7 legacy cleanup no longer requires the strict eligibility match (would act on a non-matching residual)', dir)
}
{
  const dir = copyDir('m8-allow-two-emails')
  // Surgical: removes only the emailsSent===1 clause from the FINAL decision
  // (leaving cleanup/legacy checks intact) — distinct from M6, which removes
  // the whole clause set. The early in-flow guard is deliberately redundant
  // defense-in-depth with this final one; only removing both proves the
  // property is no longer enforced at all.
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    "if (emailsSent !== 1) blocked('email_count_not_exactly_one')",
    'void 0')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    "const finalStatus = flowPassed && currentClean && legacyClean && emailCountOk ? 'PASS' : 'SAFE_STOP'",
    "const finalStatus = flowPassed && currentClean && legacyClean ? 'PASS' : 'SAFE_STOP'")
  expectFailure('M8 more than one email dispatch is no longer rejected (both the in-flow and final guards removed)', dir)
}
{
  // R5: the bounded owner-in-the-loop Auth poll is what actually proves the
  // owner clicked the real verification link — without it, "verification"
  // becomes a no-op and PASS no longer means anything about the recipient's
  // Auth state. Removing it must be caught by the timeout and
  // wrong-uid/wrong-email negative scenarios in the self-test.
  const dir = copyDir('m9-skip-verification-poll')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    `const poll = await pollForVerification({
          checkAuth: uid => adapters.checkVerification({ recipientUid: uid }),
          recipientUid, deadlineMs: faults.verificationTimeout ? 1 : verificationDeadlineMs,
          intervalMs: faults.verificationTimeout ? 1 : verificationIntervalMs,
        })`,
    'const poll = { verified: true, attempts: 0 }')
  expectFailure('M9 owner-in-the-loop Auth verification poll is bypassed (always treated as already verified)', dir)
}
{
  // R5: claimOrResumeEmailIntent's durable, exclusive checkpoint is the only
  // thing making "at most one email, ever, for this recipient" a filesystem
  // fact rather than a runtime counter. Forcing every call to look "fresh"
  // removes both the indeterminate-state refusal and the resume path —
  // a restarted process would silently register and email the recipient a
  // second time.
  const dir = copyDir('m10-skip-email-checkpoint-resume')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'const intent = claimOrResumeEmailIntent({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256 })',
    'const intent = { fresh: true, checkpoint: null }')
  expectFailure('M10 durable email checkpoint (indeterminate-refusal + resume, no re-send) is bypassed', dir)
}

fs.rmSync(MUTANTS_ROOT, { recursive: true, force: true })
const undetected = results.filter(r => !r.detected)
console.log(`\nSUMMARY total=${results.length} detected=${results.length - undetected.length} undetected=${undetected.length}`)
if (undetected.length) { console.error('UNDETECTED:', undetected.map(r => r.mutation)); process.exitCode = 1 }
