// gate-G-A orchestrator core: wires modules A (cleanup), B (run-id guard),
// C (legacy residual), E (recipient preflight) around the SEC-006 invitation
// flow behind one state machine. Two profiles:
//   - 'staging': structural wiring only in this codebase revision — the
//     actual staging network calls remain the existing, unmodified,
//     already-reviewed executeApprovedLiveRuntime path (liveAcceptanceExecutorCliCore.mjs),
//     never touched by this file. Nothing in 'staging' profile makes a
//     network call from THIS module.
//   - 'emulator': real callable/Firestore/Auth-emulator adapters (injected,
//     never staging/production), used for the E2E proof and integration
//     negative-scenario suite. No browser automation here — the UI layer is
//     unchanged, already-reviewed, separately unit-tested code
//     (liveAcceptancePlaywrightCore.mjs) and is not re-driven by this file;
//     this orchestrator proves the callable/Firestore/Auth-level flow plus
//     the new A/B/C/E modules for real, against a real (local) backend.
import { createHash, randomBytes } from 'node:crypto'
import {
  assertRunIdAllowed, claimRunId, generateRunId, PRIOR_RUN_IDS,
} from './liveAcceptanceRunIdCore.mjs'
import { executeManifestCleanup } from './liveAcceptanceCleanupCore.mjs'
import { FIXTURE_MUTATION_SLOT_SPECS } from './liveAcceptanceCore.mjs'
import {
  evaluateLegacyResidual, legacyEvidenceSummary, planLegacyInventory,
} from './stage8LegacyResidualCore.mjs'
import { assertOwnerConfirmedRecipient } from './gateGaRecipientCore.mjs'
import {
  claimOrResumeEmailIntent, markEmailSent, markEmailVerified, pollForVerification,
} from './gateGaEmailVerificationCore.mjs'

// gate-G-A (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R5) default verification
// wait: 10 minutes, polled every 5 seconds — bounded, never indefinite.
// Overridable only for tests (verificationDeadlineMs/verificationIntervalMs).
const DEFAULT_VERIFICATION_DEADLINE_MS = 10 * 60 * 1000
const DEFAULT_VERIFICATION_INTERVAL_MS = 5 * 1000

const blocked = reason => { throw new Error(`gate_ga_orchestrator_blocked:${reason ?? ''}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function makeJournal(events = []) {
  const list = [...events]
  return {
    events: list,
    append(status, details) {
      const entry = { seq: list.length, status, at: new Date().toISOString(), details: structuredClone(details ?? {}) }
      list.push(entry)
      return entry
    },
    serialize() { return `${list.map(e => JSON.stringify(e)).join('\n')}\n` },
  }
}

/** Fail-closed self-integrity preflight: every seam file must hash to what
 * this orchestrator expects. A tampered/reverted module is refused before
 * anything else runs. `expected` is {relativePath: sha256hex}; `readFile` is
 * injected (local disk read only, never network). */
export async function verifySeamIntegrity(expected, readFile) {
  if (!record(expected) || Object.keys(expected).length === 0) blocked('empty_expected_set')
  const mismatches = []
  for (const [file, expectedHash] of Object.entries(expected)) {
    const bytes = await readFile(file)
    const actual = sha256(bytes)
    if (actual !== expectedHash) mismatches.push({ file, expectedHash, actual })
  }
  return mismatches.length ? Object.freeze({ ok: false, mismatches: Object.freeze(mismatches) }) : Object.freeze({ ok: true, mismatches: Object.freeze([]) })
}

const CURRENT_LEDGER_KEYS = ['runId', 'createdAuthUids', 'ownerMailboxUidCreated', 'createdFirestorePaths', 'casPaths']
function emptyLedger(runId) {
  return { runId, createdAuthUids: [], ownerMailboxUidCreated: false, createdFirestorePaths: [], casPaths: [] }
}

/**
 * Runs the full gate-G-A sequence. `adapters` supplies every effectful
 * operation (never a real network call from within this file itself):
 * {
 *   probeReadiness(fn) -> {ready, httpStatus, verdict},
 *   recipientLookup: {getProject, lookupAccount, getProfile, allowProfile},
 *   createAdminAndCompany() -> {adminUid, companyId, memberPath, dataPath},
 *   inviteRecipient({companyId, adminUid, recipient}) -> {inviteId, invitationPath, lockPath},
 *   registerRecipient({recipient}) -> {recipientUid, idToken, profilePath},
 *   sendVerificationEmail({idToken}) -> {dispatched: boolean},
 *   checkVerification({recipientUid}) -> {uid, email, emailVerified} (read-only, polled),
 *   signInRecipient({recipient}) -> {idToken} (fresh token after verification — also used on resume),
 *   acceptInvite({idToken, inviteId, token}) -> {ok, companyId},
 *   readCompanyRoleFor({recipientUid, companyId}) -> {role},
 *   listChildCollections(path), readDoc(path), deleteDoc(path), deleteAuthUser(uid),
 *   authUserExists(uid), authUserExistsByEmail(),
 *   legacyInventory(plan) -> the injected shape evaluateLegacyResidual expects,
 *   legacyAdapters: same shape as top-level cleanup adapters, scoped to legacy paths,
 * }
 * `faults` triggers the specific negative-scenario branches (see gate-G-A R3
 * package §3 for the exact list); every fault is opt-in and defaults to off.
 */
export async function runGateGaOrchestrator({
  profile, project, seamExpectedHashes, readFile, recipient, ownerConfirmedRecipientSha256,
  adapters, faults = {}, claimedDir, sourceHead, journal = makeJournal(),
  checkpointDir = claimedDir,
  verificationDeadlineMs = DEFAULT_VERIFICATION_DEADLINE_MS,
  verificationIntervalMs = DEFAULT_VERIFICATION_INTERVAL_MS,
  onOwnerActionRequired = () => {},
}) {
  if (profile !== 'staging' && profile !== 'emulator') blocked('bad_profile')
  journal.append('PRECONDITIONS_STARTED', { profile, project })

  // --- 0. preflight: seam file integrity ------------------------------------------------
  const integrity = await verifySeamIntegrity(seamExpectedHashes, readFile)
  journal.append('SEAM_INTEGRITY_CHECKED', { ok: integrity.ok, mismatchCount: integrity.mismatches.length })
  if (!integrity.ok) return safeStop(journal, 'SEAM_INTEGRITY_MISMATCH', { mismatches: integrity.mismatches })

  // --- 1. run-id: generate + exclusive claim --------------------------------------------
  let runId
  try {
    runId = faults.reuseRunId ? PRIOR_RUN_IDS[0] : generateRunId()
    claimRunId(runId, { claimedDir, project, sourceHead })
    journal.append('RUN_ID_CLAIMED', { runIdSha256: sha256(runId) })
  } catch (error) {
    journal.append('RUN_ID_REFUSED', { reason: error.message })
    return safeStop(journal, 'RUN_ID_REFUSED', { reason: error.message })
  }
  // Fragments grow as real (often server-random, e.g. Firestore auto-ids)
  // identifiers become known during the flow — a path/uid only ever enters
  // the destructive ledger in the same step that discovers its fragment.
  const allowedIdFragments = [runId]

  // --- 2. recipient preflight -------------------------------------------------------------
  let recipientPreflight
  try {
    // adapters.recipientPreflight resolves {recipientSha256, absent, project}
    // for the active profile — the staging profile's adapter is expected to
    // delegate to gateGaRecipientCore.resolveRecipientPreflight (fixed,
    // non-configurable PROJECT='finapp-staging'); the emulator profile's
    // adapter performs the equivalent check against demo-finapp. Either way,
    // the actual policy gate below (assertOwnerConfirmedRecipient) is the
    // same profile-independent function from module E.
    recipientPreflight = await adapters.recipientPreflight(recipient)
    assertOwnerConfirmedRecipient(recipientPreflight, ownerConfirmedRecipientSha256)
    journal.append('RECIPIENT_CONFIRMED', { recipientSha256: recipientPreflight.recipientSha256 })
  } catch (error) {
    journal.append('RECIPIENT_REFUSED', { reason: error.message })
    return safeStop(journal, 'RECIPIENT_REFUSED', { reason: error.message, runId })
  }

  // --- 3. legacy residual: read-only inventory + evaluation (no deletion yet) ------------
  const legacyPlan = planLegacyInventory()
  const legacyInventory = await adapters.legacyInventory(legacyPlan)
  const legacyEvaluation = evaluateLegacyResidual(legacyInventory)
  journal.append('LEGACY_RESIDUAL_EVALUATED', legacyEvidenceSummary(legacyEvaluation))

  // --- 4. readiness ------------------------------------------------------------------------
  const readinessTargets = ['createCompany', 'inviteMember', 'acceptInvite', 'getCompanyAccess']
  const readiness = []
  for (const fn of readinessTargets) readiness.push({ fn, ...(await adapters.probeReadiness(fn)) })
  const allReady = readiness.every(r => r.ready === true)
  journal.append('READINESS_CHECKED', { allReady, readiness })
  if (!allReady) return safeStop(journal, 'READINESS_NOT_SATISFIED', { readiness, runId })

  // --- 5. full flow ------------------------------------------------------------------------
  let ledger = emptyLedger(runId)
  // gate-G-A's simplified flow (see file header) only ever exercises 6 of
  // the 16 historical Stage-8 slots; every other slot is genuinely
  // NOT_STARTED (never attempted), which is exactly what
  // classifyCleanupEligibility (module A) requires to see for every slot it
  // knows about — this default map, not a subset, is what keeps that shared
  // eligibility gate meaningful across both the full historical flow and
  // this simplified one.
  const slotStates = Object.fromEntries(FIXTURE_MUTATION_SLOT_SPECS
    .filter(s => s.disposition === 'WRITE' || s.disposition === 'IDEMPOTENT_READBACK')
    .map(s => [s.slot, 'NOT_STARTED']))
  let emailsSent = 0
  let flowOutcome = { status: 'NOT_STARTED' }

  if (!faults.stopBeforeCreation) {
    try {
      const admin = await adapters.createAdminAndCompany()
      allowedIdFragments.push(admin.adminUid, admin.companyId)
      ledger.createdAuthUids.push(admin.adminUid)
      ledger.createdFirestorePaths.push(`companies/${admin.companyId}`, admin.dataPath, admin.memberPath, admin.profilePath, admin.bootstrapPath)
      slotStates.createOwnerAAuth = 'RECONCILED'; slotStates.createCompanyA = 'RECONCILED'
      journal.append('ADMIN_AND_COMPANY_CREATED', { companyIdSha256: sha256(admin.companyId) })

      const invite = await adapters.inviteRecipient({ companyId: admin.companyId, adminIdToken: admin.adminIdToken, recipient })
      allowedIdFragments.push(invite.inviteId)
      ledger.createdFirestorePaths.push(invite.invitationPath)
      if (invite.lockPath) {
        allowedIdFragments.push(invite.lockPath.split('/').at(-1))
        ledger.createdFirestorePaths.push(invite.lockPath)
      }
      slotStates.createMailboxFinalInvite = 'RECONCILED'
      journal.append('INVITATION_CREATED', { inviteIdSha256: sha256(invite.inviteId) })

      if (faults.stopAfterPartial) {
        flowOutcome = { status: 'SAFE_STOP', reason: 'FAULT_STOP_AFTER_PARTIAL' }
      } else {
        // --- owner-in-the-loop email verification (R5) ------------------
        // An indeterminate prior attempt is simulated for tests by seeding a
        // real MAY_BE_SENT checkpoint file before this call, exactly as a
        // crashed prior process would have left one — never by branching on
        // a fault flag here.
        const intent = claimOrResumeEmailIntent({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256 })

        if (!intent.fresh && intent.checkpoint.status === 'MAY_BE_SENT') {
          // A prior attempt's outcome is unknown. Never send again, never
          // guess whether the recipient Auth account exists — leave it for
          // manual recovery from this evidence; cleanup below still runs for
          // whatever THIS run's ledger already confirmed (admin/company/invite).
          journal.append('EMAIL_SEND_INDETERMINATE', {})
          throw new Error('email_send_indeterminate')
        }

        let recipientUid, freshIdTokenForAccept
        if (intent.fresh) {
          const registered = await adapters.registerRecipient({ recipient })
          recipientUid = registered.recipientUid
          allowedIdFragments.push(recipientUid)
          ledger.createdAuthUids.push(recipientUid)
          ledger.createdFirestorePaths.push(registered.profilePath)
          slotStates.createOwnerMailboxAuth = 'RECONCILED'
          journal.append('RECIPIENT_REGISTERED', {})

          // The durable, exclusive claim already happened above (`intent`,
          // written before registerRecipient even ran) — that write, not
          // this send call, is what makes "at most one email, ever" a
          // filesystem fact rather than a runtime counter.
          journal.append('EMAIL_MAY_BE_SENT', {})
          const sent = await adapters.sendVerificationEmail({ idToken: registered.idToken })
          if (sent.dispatched) emailsSent++
          journal.append('EMAIL_SENT', { dispatched: sent.dispatched })
          if (faults.doubleSendEmail) {
            const second = await adapters.sendVerificationEmail({ idToken: registered.idToken })
            if (second.dispatched) emailsSent++
            journal.append('EMAIL_SENT', { dispatched: second.dispatched, fault: 'doubleSendEmail' })
          }
          if (emailsSent !== 1) blocked('email_count_not_exactly_one')
          markEmailSent({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256, recipientUid })
          onOwnerActionRequired({ recipientSha256: recipientPreflight.recipientSha256 })
        } else {
          // Resume: a checkpoint already recorded SENT (or VERIFIED) for
          // this exact recipient in an earlier process — the Auth account
          // already exists; never call registerRecipient or send again.
          recipientUid = intent.checkpoint.recipientUid
          allowedIdFragments.push(recipientUid)
          ledger.createdAuthUids.push(recipientUid)
          ledger.createdFirestorePaths.push(`users/${recipientUid}`)
          slotStates.createOwnerMailboxAuth = 'RECONCILED'
          journal.append('EMAIL_RESUMED_FROM_CHECKPOINT', { status: intent.checkpoint.status })
        }

        journal.append('VERIFICATION_POLL_STARTED', {})
        const poll = await pollForVerification({
          checkAuth: uid => adapters.checkVerification({ recipientUid: uid }),
          recipientUid, deadlineMs: faults.verificationTimeout ? 1 : verificationDeadlineMs,
          intervalMs: faults.verificationTimeout ? 1 : verificationIntervalMs,
        })
        journal.append('VERIFICATION_POLL_FINISHED', { verified: poll.verified, reason: poll.reason ?? null, attempts: poll.attempts })
        if (!poll.verified) {
          // Timeout, UID/email mismatch, or a polling error already thrown
          // out of pollForVerification (fail-closed) — either way, no
          // accept is attempted; cleanup of whatever this run created still
          // runs below (module A), unaffected by verification never landing.
          throw new Error(`verification_not_completed:${poll.reason ?? 'unknown'}`)
        }
        markEmailVerified({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256 })
        journal.append('VERIFICATION_COMPLETE', {})

        const signedIn = await adapters.signInRecipient({ recipient })
        freshIdTokenForAccept = signedIn.idToken

        const auditCountBeforeAccept = await adapters.auditEventCount(admin.companyId)
        const accepted = await adapters.acceptInvite({ idToken: freshIdTokenForAccept, inviteId: invite.inviteId, token: invite.token })
        if (!accepted.ok || accepted.companyId !== admin.companyId) blocked('accept_failed')
        slotStates.acceptMailboxFinalInvite = 'RECONCILED'

        const roleCheck = await adapters.readCompanyRoleFor({ recipientUid, companyId: admin.companyId })
        if (roleCheck.role !== 'accountant') blocked('company_role_mismatch')
        const memberUpdatedAtAfterAccept = await adapters.memberUpdatedAtMs(admin.companyId, recipientUid)
        journal.append('ACCEPTED', { companyIdSha256: sha256(accepted.companyId), role: roleCheck.role })

        const auditCountAfterAccept = await adapters.auditEventCount(admin.companyId)
        if (auditCountAfterAccept !== auditCountBeforeAccept + 1) blocked('accept_did_not_write_exactly_one_audit_event')

        const replay = await adapters.acceptInvite({ idToken: freshIdTokenForAccept, inviteId: invite.inviteId, token: invite.token })
        if (!replay.ok || replay.companyId !== admin.companyId) blocked('replay_failed')
        const auditCountAfterReplay = await adapters.auditEventCount(admin.companyId)
        const memberUpdatedAtAfterReplay = await adapters.memberUpdatedAtMs(admin.companyId, recipientUid)
        if (auditCountAfterReplay !== auditCountAfterAccept || memberUpdatedAtAfterReplay !== memberUpdatedAtAfterAccept) blocked('replay_not_idempotent')
        slotStates.replayMailboxFinalInvite = 'RECONCILED'
        journal.append('REPLAY_IDEMPOTENT_CONFIRMED', { auditCountAfterAccept, auditCountAfterReplay })

        for (const path of await adapters.findAuditEventPaths(admin.companyId)) if (!ledger.createdFirestorePaths.includes(path)) ledger.createdFirestorePaths.push(path)
        ledger.ownerMailboxUidCreated = true
        flowOutcome = { status: 'PASS', companyId: admin.companyId, role: roleCheck.role }
      }
    } catch (error) {
      journal.append('FLOW_FAILED', { reason: error.message })
      flowOutcome = { status: 'SAFE_STOP', reason: error.message }
    }
  } else {
    journal.append('STOP_BEFORE_CREATION', {})
    flowOutcome = { status: 'SAFE_STOP', reason: 'FAULT_STOP_BEFORE_CREATION' }
  }

  // --- 5b. journal corruption fault (only meaningful for the negative-scenario suite) ----
  if (faults.corruptedJournal) journal.append('CORRUPTED_MARKER', { __corrupted: true })

  // --- 5c. adversarial ledger tampering for negative scenarios ---------------------------
  if (faults.foreignDocument) ledger = { ...ledger, createdFirestorePaths: [...ledger.createdFirestorePaths, 'companies/not-this-runs-company/company_data/data'] }
  // A tampered manifest whose runId no longer matches the claimed run-id —
  // the same class of attack the unit suite proves against buildCleanupTargets/
  // validateCleanupTargets (module A's other, independently-rebuilt path);
  // here it is proven against the ledger path this orchestrator actually uses.
  if (faults.tamperedManifest) ledger = { ...ledger, runId: `${runId}-tampered` }
  if (faults.unexpectedSubcollection) await adapters.seedUnexpectedSubcollection?.(ledger)

  // --- 6. cleanup of the CURRENT run — runs after PASS or after a safely-classified STOP --
  // authUserExistsByEmail is called with zero arguments by module A by
  // design (the plaintext recipient must never appear in its journal) — bind
  // it to THIS run's recipient here, in the orchestrator's own closure,
  // never inside module A itself.
  let cleanupAdapters = { ...adapters, authUserExistsByEmail: () => adapters.authUserExistsByEmail(recipient) }
  if (faults.deleteFailure) cleanupAdapters = withNthDeleteFailure(cleanupAdapters, faults.deleteFailure)
  if (faults.verifyCleanFailure) cleanupAdapters = withSilentlyIneffectiveFirstDelete(cleanupAdapters)
  let cleanupResult
  try {
    cleanupResult = await executeManifestCleanup({
      runId, slotStates, ledger, adapters: cleanupAdapters, journal, allowedIdFragments,
    })
  } catch (error) {
    journal.append('CLEANUP_THREW', { reason: error.message })
    cleanupResult = { status: 'CLEANUP_REFUSED', deleted: { authUids: [], firestorePaths: [] }, reason: error.message }
  }

  // --- 7. legacy residual: SEPARATE cleanup + verify-clean, never mixed with the above ----
  let legacyCleanupResult = { status: 'NOT_APPLICABLE' }
  if (legacyEvaluation.eligible && faults.confirmLegacyCleanup) {
    const legacyLedger = {
      runId: 'stage8-legacy-residual', createdAuthUids: legacyEvaluation.deleteTargets.authUids,
      ownerMailboxUidCreated: false, createdFirestorePaths: legacyEvaluation.deleteTargets.firestorePaths, casPaths: [],
    }
    const legacyStates = Object.fromEntries(Object.keys(slotStates).map(k => [k, 'RECONCILED']))
    const legacyJournal = makeJournal()
    legacyCleanupResult = await executeManifestCleanup({
      runId: 'stage8-legacy-residual', slotStates: legacyStates, ledger: legacyLedger,
      adapters: adapters.legacyAdapters, journal: legacyJournal,
      allowedIdFragments: [
        legacyEvaluation.deleteTargets.authUids[0],
        legacyEvaluation.deleteTargets.firestorePaths[0].split('/').at(-1),
      ],
    })
    journal.append('LEGACY_CLEANUP_DONE', { status: legacyCleanupResult.status })
  } else {
    journal.append('LEGACY_CLEANUP_SKIPPED', { eligible: legacyEvaluation.eligible, confirmed: Boolean(faults.confirmLegacyCleanup) })
  }

  // --- 8. final PASS / SAFE_STOP decision -------------------------------------------------
  const currentClean = cleanupResult.status === 'CLEANUP_COMPLETE_VERIFIED'
  const legacyClean = legacyCleanupResult.status === 'NOT_APPLICABLE' || legacyCleanupResult.status === 'CLEANUP_COMPLETE_VERIFIED'
  const flowPassed = flowOutcome.status === 'PASS'
  // <= 1, not === 1: a THIS-run send is already required to be exactly one
  // (blocked() above, inside the fresh branch, before flowOutcome can ever
  // become PASS) — 0 is the correct and required value on a resumed run
  // (process restarted after a prior process's send; the durable checkpoint,
  // not this run's counter, is what proves at most one email was ever sent
  // for this recipient). Only guards against a future code path reaching
  // PASS after sending more than once in a single run.
  const emailCountOk = emailsSent <= 1
  const finalStatus = flowPassed && currentClean && legacyClean && emailCountOk ? 'PASS' : 'SAFE_STOP'
  journal.append('FINAL_DECISION', { finalStatus, flowStatus: flowOutcome.status, cleanupStatus: cleanupResult.status, legacyCleanupStatus: legacyCleanupResult.status, emailsSent })

  return Object.freeze({
    status: finalStatus,
    runId,
    flowOutcome: Object.freeze(flowOutcome),
    cleanup: Object.freeze(cleanupResult),
    legacyResidual: Object.freeze(legacyEvaluation),
    legacyCleanup: Object.freeze(legacyCleanupResult),
    emailsSent,
    journal: journal.events,
  })
}

function safeStop(journal, reason, details) {
  journal.append('SAFE_STOP', { reason, ...details })
  return Object.freeze({
    status: 'SAFE_STOP', reason, runId: details?.runId ?? null,
    flowOutcome: Object.freeze({ status: 'NOT_STARTED' }),
    cleanup: Object.freeze({ status: 'NOT_APPLICABLE', deleted: Object.freeze({ authUids: [], firestorePaths: [] }) }),
    legacyResidual: Object.freeze({ eligible: false, reasons: Object.freeze(['NOT_EVALUATED']) }),
    legacyCleanup: Object.freeze({ status: 'NOT_APPLICABLE' }),
    emailsSent: 0,
    journal: journal.events,
  })
}

function withNthDeleteFailure(adapters, n) {
  let count = 0
  return { ...adapters, async deleteDoc(path) { count++; if (count === n) throw new Error('injected_delete_failure'); return adapters.deleteDoc(path) } }
}

// Simulates a delete call that reports success (throws nothing) but did not
// actually remove the document — the only way verify-clean itself, not the
// delete-failure path, can be the thing that catches a real leftover.
function withSilentlyIneffectiveFirstDelete(adapters) {
  let first = true
  return { ...adapters, async deleteDoc(path) { if (first) { first = false; return } return adapters.deleteDoc(path) } }
}

export { PRIOR_RUN_IDS }
