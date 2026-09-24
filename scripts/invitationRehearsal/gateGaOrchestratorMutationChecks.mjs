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
    "runId = faults.reuseRunId ? PRIOR_RUN_IDS[0] : generateRunId()\n      claimRunId(runId, { claimedDir, project, sourceHead })",
    "runId = faults.reuseRunId ? PRIOR_RUN_IDS[0] : generateRunId()")
  expectFailure('M1 orchestrator stops calling claimRunId before external creation', dir)
}
{
  const dir = copyDir('m2-skip-recipient-guard')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'recipientPreflight = await adapters.recipientPreflight(recipient)\n    if (resume) {',
    'recipientPreflight = { recipientSha256: ownerConfirmedRecipientSha256, absent: true }\n    if (resume) {')
  expectFailure('M2 recipient guard (adapter consultation) disabled', dir)
}
{
  // R6: a FRESH run must still require the recipient to be absent — only a
  // resumed run may skip that check (it is resuming its OWN earlier
  // registration). This mutation makes the "absent" requirement skippable
  // even on a fresh run, letting a fresh run silently target a recipient
  // whose Auth account already exists for an unrelated reason.
  const dir = copyDir('m14-fresh-run-skips-absent-requirement')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'if (resume) {\n      // On resume the recipient',
    'if (true) {\n      // On resume the recipient')
  expectFailure('M14 a fresh (non-resume) run no longer requires the recipient to be absent from Auth', dir)
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
  // R6: legacyCleanupApproved is the ONLY thing that may authorize legacy
  // deletion — this mutation makes an eligible-but-UNAPPROVED residual fall
  // through into the real deletion branch anyway (a genuine "acts without
  // the owner's explicit legacy-cleanup approval" defect).
  const dir = copyDir('m7-legacy-cleanup-skips-approval-gate')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    '} else if (!legacyCleanupApproved) {',
    '} else if (false) {')
  expectFailure('M7 legacy cleanup no longer requires explicit legacyCleanupApproved (would act on an eligible-but-unapproved residual)', dir)
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
          recipientUid, expectedEmail: normalizedRecipient,
          deadlineMs: faults.verificationTimeout ? 1 : verificationDeadlineMs,
          intervalMs: faults.verificationTimeout ? 1 : verificationIntervalMs,
        })`,
    'const poll = { verified: true, attempts: 0 }')
  expectFailure('M9 owner-in-the-loop Auth verification poll is bypassed (always treated as already verified)', dir)
}
{
  // R6: expectedEmail is what makes pollForVerification's EMAIL_MISMATCH
  // check possible at all — without it, a verified:true report for a
  // completely different email address (only the uid happening to match)
  // would be silently accepted.
  const dir = copyDir('m11-drop-expected-email')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'recipientUid, expectedEmail: normalizedRecipient,\n          deadlineMs:',
    'recipientUid,\n          deadlineMs:')
  expectFailure('M11 expectedEmail is no longer passed to the verification poll (email mismatch would go undetected)', dir)
}
{
  // R6: the FINAL decision must independently exclude PENDING_APPROVAL from
  // "legacy clean" — distinct from M7 (which bypasses the gate that decides
  // whether cleanup RUNS at all). This mutation leaves that gate intact but
  // makes the final PASS decision treat a legitimately-PENDING_APPROVAL
  // outcome as clean anyway.
  const dir = copyDir('m12-legacy-pending-approval-counted-as-clean')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    "const legacyClean = legacyCleanupResult.status === 'NOT_APPLICABLE' || legacyCleanupResult.status === 'CLEANUP_COMPLETE_VERIFIED'",
    'const legacyClean = true')
  expectFailure('M12 a PENDING_APPROVAL legacy residual is silently counted as clean in the final PASS decision', dir)
}
{
  // R6: a resume from the CLAIMED phase (admin/company creation never
  // confirmed complete) must refuse, not attempt to create a second,
  // possibly-duplicate admin/company. This mutation removes that refusal,
  // letting the resumed process fall through into a fresh createAdminAndCompany
  // attempt — caught by the self-test's zero-adapter-calls assertion.
  const dir = copyDir('m13-resume-from-claimed-retries-blindly')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    "if (resumedFromPhase === 'CLAIMED') {",
    "if (false && resumedFromPhase === 'CLAIMED') {")
  expectFailure('M13 resume from an indeterminate CLAIMED phase no longer refuses — it retries admin creation blindly', dir)
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
    'const intent = claimOrResumeEmailIntent({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256, verifyFileAcl })',
    'const intent = { fresh: true, checkpoint: null }')
  expectFailure('M10 durable email checkpoint (indeterminate-refusal + resume, no re-send) is bypassed', dir)
}
{
  // R7: the private-directory ACL lockdown must actually run before any
  // checkpoint/manifest write — this mutation removes the call entirely.
  // Detected by the self-test's own ACL test, which supplies a
  // deliberately-throwing ensureAcl stub and expects it to be consulted.
  const dir = copyDir('m15-skip-acl-check')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    "ensureAcl({ dir: claimedDir })\n    if (checkpointDir !== claimedDir) ensureAcl({ dir: checkpointDir })",
    'void 0')
  expectFailure('M15 the private-directory ACL lockdown is no longer consulted before any checkpoint/manifest write', dir)
}
{
  // R7: recordRegisteredRecipient is what makes recipientUid durably
  // recoverable BEFORE the send attempt — without this call, markEmailSent
  // has no pre-registered uid to confirm against and refuses (fail-closed),
  // breaking the positive end-to-end flow.
  const dir = copyDir('m16-skip-record-registered-recipient')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    "recordRegisteredRecipient({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256, recipientUid, verifyFileAcl })",
    'void 0')
  expectFailure('M16 recipientUid is no longer durably recorded before the send attempt (the R7 crash-between-register-and-send window regresses)', dir)
}
{
  // R7: resume must refuse a manifest claimed under a DIFFERENT sourceHead
  // — without this check, a resume approved for one reviewed commit could
  // silently continue a run claimed under a different, unreviewed one.
  const dir = copyDir('m17-skip-source-head-check-on-resume')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'manifest.project !== project || manifest.profile !== profile || manifest.sourceHead !== sourceHead ||\n        manifest.recipientSha256 !== ownerConfirmedRecipientSha256',
    'manifest.project !== project || manifest.profile !== profile ||\n        manifest.recipientSha256 !== ownerConfirmedRecipientSha256')
  expectFailure('M17 resume no longer verifies the manifest was claimed under the SAME sourceHead', dir)
}

{
  // R8: resume from CLAIMED must actually perform the narrow, real
  // reconciliation lookup — this mutation makes it always report "nothing
  // found", even when the admin/company genuinely exist externally,
  // silently losing track of a real, disposable resource that would then
  // never be cleaned up.
  const dir = copyDir('m18-admin-reconcile-always-not-found')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'const reconciled = await adapters.reconcileAdminAndCompany({ runId })',
    'const reconciled = { found: false }')
  expectFailure('M18 admin/company reconciliation on resume from CLAIMED is bypassed (always reports not-found)', dir)
}
{
  // R8: an orphaned admin Auth account (company never created) must be
  // added to the ledger and cleaned up — this mutation disables that
  // branch entirely, so a real, disposable Auth account it just found is
  // never queued for deletion.
  const dir = copyDir('m19-orphaned-admin-not-cleaned-up')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'if (reconciled.orphaned) {',
    'if (false && reconciled.orphaned) {')
  expectFailure('M19 an orphaned admin Auth account found on resume is no longer added to the cleanup ledger', dir)
}
{
  // R8: the invitation-lock reconciliation on a resume from ADMIN_CREATED
  // must actually perform its narrow, real lookup — this mutation makes
  // it always report "nothing found", so an invitation that really was
  // created externally (and can never be safely resumed, since the raw
  // token is never persisted) is silently left uncleaned.
  const dir = copyDir('m20-invite-reconcile-always-not-found')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'const reconciledInvite = await adapters.reconcileInvitation({ companyId: admin.companyId, recipient })',
    'const reconciledInvite = { found: false }')
  expectFailure('M20 invitation reconciliation on resume from ADMIN_CREATED is bypassed (always reports not-found)', dir)
}
{
  // R8: when a MAY_BE_SENT checkpoint has no recorded recipientUid, the
  // narrow exact-email lookup is what recovers a real, already-created
  // Auth account from the window between registerRecipient() returning
  // and the checkpoint durably recording it. This mutation makes the
  // lookup always report "not found", leaving that real account both
  // unrecorded AND uncleaned.
  const dir = copyDir('m21-recipient-uid-reconcile-always-not-found')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    'const discovered = await adapters.findAuthUidByEmail(recipient)',
    'const discovered = { uid: null }')
  expectFailure('M21 recipientUid recovery-by-email for an indeterminate MAY_BE_SENT checkpoint is bypassed', dir)
}
{
  // R8: a reconciled invitation's lock document must be added to the
  // ledger too (not just the invitation document itself) — otherwise
  // module A's cleanup executor refuses the whole cleanup (an id fragment
  // it doesn't recognize), which this mutation exposes as a hard failure
  // rather than a clean, verified cleanup.
  const dir = copyDir('m22-reconciled-invite-lock-not-ledgered')
  mutate(dir, 'gateGaOrchestratorCore.mjs',
    `        allowedIdFragments.push(reconciledInvite.inviteId)
        ledger.createdFirestorePaths.push(reconciledInvite.invitationPath)
        if (reconciledInvite.lockPath) {
          allowedIdFragments.push(reconciledInvite.lockPath.split('/').at(-1))
          ledger.createdFirestorePaths.push(reconciledInvite.lockPath)
        }`,
    `        allowedIdFragments.push(reconciledInvite.inviteId)
        ledger.createdFirestorePaths.push(reconciledInvite.invitationPath)`)
  expectFailure('M22 a reconciled invitation\'s lock document is no longer added to the cleanup ledger', dir)
}

fs.rmSync(MUTANTS_ROOT, { recursive: true, force: true })
const undetected = results.filter(r => !r.detected)
console.log(`\nSUMMARY total=${results.length} detected=${results.length - undetected.length} undetected=${undetected.length}`)
if (undetected.length) { console.error('UNDETECTED:', undetected.map(r => r.mutation)); process.exitCode = 1 }
