// Single CLI command driving the gate-G-A orchestrator through the positive
// E2E case and every required integration negative scenario, all against
// the real local Functions+Firestore+Auth emulators (never staging/
// production). Prints one JSON line per scenario plus a final summary.
import { runOnce } from './gateGaEmulatorE2E.mjs'

const scenarios = []
function expect(name, predicate, extract) {
  return async () => {
    let detail
    try {
      const outcome = await predicate()
      detail = extract ? extract(outcome) : outcome
    } catch (error) {
      detail = { __pass: false, threw: error.message }
    }
    const pass = detail?.__pass === true
    scenarios.push({ name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
  }
}

async function main() {
  await expect('positive-e2e-full-flow', () => runOnce(), ({ result, independentRemainder }) => ({
    __pass: result.status === 'PASS' && independentRemainder.length === 0 && result.emailsSent === 1,
    status: result.status, emailsSent: result.emailsSent, remainder: independentRemainder.length,
  }))()

  await expect('reused-run-id', () => runOnce({ faults: { reuseRunId: true } }), ({ result }) => ({
    __pass: result.status === 'SAFE_STOP' && result.reason === 'RUN_ID_REFUSED',
    status: result.status, reason: result.reason,
  }))()

  await expect('existing-recipient', () => runOnce({ existingRecipientSeed: true }), ({ result }) => ({
    __pass: result.status === 'SAFE_STOP' && result.reason === 'RECIPIENT_REFUSED',
    status: result.status, reason: result.reason,
  }))()

  await expect('stop-before-first-creation', () => runOnce({ faults: { stopBeforeCreation: true } }), ({ result, independentRemainder }) => ({
    __pass: result.status === 'SAFE_STOP' && result.cleanup.status === 'CLEANUP_COMPLETE_VERIFIED' && independentRemainder.length === 0,
    status: result.status, cleanupStatus: result.cleanup.status,
  }))()

  await expect('stop-after-partial-creation', () => runOnce({ faults: { stopAfterPartial: true } }), ({ result, independentRemainder }) => ({
    __pass: result.status === 'SAFE_STOP' && result.cleanup.status === 'CLEANUP_COMPLETE_VERIFIED' && independentRemainder.length === 0,
    status: result.status, cleanupStatus: result.cleanup.status, deleted: result.cleanup.deleted,
  }))()

  await expect('foreign-document-in-ledger', () => runOnce({ faults: { foreignDocument: true } }), ({ result }) => ({
    __pass: result.cleanup.status === 'CLEANUP_REFUSED',
    cleanupStatus: result.cleanup.status, reason: result.cleanup.reason,
  }))()

  await expect('unexpected-subcollection', () => runOnce({ faults: { unexpectedSubcollection: true } }), ({ result }) => ({
    __pass: result.cleanup.status === 'CLEANUP_REFUSED' && result.cleanup.reason === 'UNEXPECTED_SUBCOLLECTION',
    cleanupStatus: result.cleanup.status, reason: result.cleanup.reason,
  }))()

  await expect('tampered-manifest-runid', () => runOnce({ faults: { tamperedManifest: true } }), ({ result }) => ({
    __pass: result.cleanup.status === 'CLEANUP_REFUSED',
    cleanupStatus: result.cleanup.status,
  }))()

  await expect('single-delete-failure-then-partial', () => runOnce({ faults: { deleteFailure: 2 } }), ({ result }) => ({
    __pass: result.cleanup.status === 'CLEANUP_PARTIAL' && result.cleanup.deleted.firestorePaths.length === 1,
    cleanupStatus: result.cleanup.status, deleted: result.cleanup.deleted,
  }))()

  await expect('verify-clean-catches-silent-delete-failure', () => runOnce({ faults: { verifyCleanFailure: true } }), ({ result, independentRemainder }) => ({
    __pass: result.cleanup.status === 'CLEANUP_VERIFY_MISMATCH',
    cleanupStatus: result.cleanup.status, remainderFromModule: result.cleanup.remainder, independentRemainder,
  }))()

  await expect('legacy-residual-matches-and-is-cleaned', () => runOnce({ seedLegacy: 'match', legacyCleanupApproved: true }), ({ result, independentRemainder }) => ({
    __pass: result.legacyResidual.eligible === true && result.legacyCleanup.status === 'CLEANUP_COMPLETE_VERIFIED' &&
      independentRemainder.filter(r => r.scope === 'legacy').length === 0,
    eligible: result.legacyResidual.eligible, legacyCleanupStatus: result.legacyCleanup.status,
  }))()

  await expect('legacy-residual-does-not-match-manifest-no-action', () => runOnce({ seedLegacy: 'mismatch', legacyCleanupApproved: true }), ({ result, independentRemainder }) => ({
    __pass: result.legacyResidual.eligible === false && result.legacyCleanup.status === 'NOT_APPLICABLE' &&
      independentRemainder.filter(r => r.scope === 'legacy-preserved-check').length === 0,
    eligible: result.legacyResidual.eligible, reasons: result.legacyResidual.reasons, legacyCleanupStatus: result.legacyCleanup.status,
  }))()

  await expect('corrupted-journal-marker-detectable', () => runOnce({ faults: { corruptedJournal: true } }), ({ result }) => ({
    __pass: result.journal.every(e => e.details?.corruptedMarker === true) && result.journal.length > 0,
    // Stronger, unit-level proof that a genuinely malformed journal (bad
    // sequence, unknown status, non-newline-terminated bytes) is rejected by
    // the shared journal state machine lives in
    // gateGaAdditionalNegativeSelfTest.mjs (reused, not duplicated here).
    journalLength: result.journal.length,
  }))()

  const failed = scenarios.filter(s => !s.pass)
  console.log(`\nSUMMARY total=${scenarios.length} pass=${scenarios.length - failed.length} fail=${failed.length}`)
  if (failed.length) { console.error('FAILED SCENARIOS:', failed.map(s => s.name)); process.exitCode = 1 }
}

main().catch(error => { console.error('SUITE_ERROR', error); process.exitCode = 1 })
