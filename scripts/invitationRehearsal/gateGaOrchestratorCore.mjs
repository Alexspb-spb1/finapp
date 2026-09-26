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
//
// FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8: true run-level resume. A
// durable run manifest (gateGaRunManifestCore.mjs) is claimed BEFORE the
// first external write and updated at each confirmed phase boundary
// (admin+company created, invitation created) — a killed/restarted process
// invoked with `resume:true` continues the SAME run (same runId, same
// admin/company/invite identifiers, same ledger) instead of creating a
// second, orphaned set of resources. From the 'INVITED' phase onward the
// existing (R5) email checkpoint drives the rest of the resumable flow.
//
// R8: closes the remaining real windows between an external adapter call
// RETURNING (the effect is now real and confirmed) and this file's own
// durable local write recording it. Each window is closed by narrow,
// exact, read-only reconciliation keyed only by identifiers this exact
// run already deterministically owns — never a blind retry, never a
// broad scan: admin Auth + company (adapters.reconcileAdminAndCompany,
// keyed by the run's own deterministic adminUid and the fixed
// user_bootstrap/{adminUid} receipt), invitation (adapters.reconcileInvitation,
// keyed by the deterministic invitationLocks/{lockId} for
// (companyId, emailNormalized) — the raw token is never persisted, so a
// found invitation is always reconciled-then-cleaned-up, never resumed
// into accept), and the recipient's Auth uid (adapters.findAuthUidByEmail,
// keyed by the single owner-confirmed recipient email). Every reconciled
// external resource is added to the ledger before any decision is made,
// so cleanup below can never miss it — "not yet confirmed locally" is
// never treated as "not created".
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  assertRunIdAllowed, claimRunId, generateRunId, readClaim, PRIOR_RUN_IDS,
} from './liveAcceptanceRunIdCore.mjs'
import { claimRunManifest, readRunManifest, updateRunManifest, runManifestPathFor } from './gateGaRunManifestCore.mjs'
import { executeManifestCleanup } from './liveAcceptanceCleanupCore.mjs'
import { FIXTURE_MUTATION_SLOT_SPECS } from './liveAcceptanceCore.mjs'
import {
  evaluateLegacyResidual, legacyEvidenceSummary, planLegacyInventory,
} from './stage8LegacyResidualCore.mjs'
import { assertOwnerConfirmedRecipient } from './gateGaRecipientCore.mjs'
import {
  claimOrResumeEmailIntent, recordRegisteredRecipient, markEmailSent, markEmailVerified, pollForVerification, checkpointPathFor,
} from './gateGaEmailVerificationCore.mjs'
import { ensurePrivateDirectoryAcl, verifyPrivateFileAcl } from './gateGaPrivateDirAclCore.mjs'

// gate-G-A default verification wait: 10 minutes, polled every 5 seconds —
// bounded, never indefinite. Overridable only for tests
// (verificationDeadlineMs/verificationIntervalMs).
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

// R9: an independent review of R8 found the staging adapter shipped with a
// real gap — the orchestrator itself never checked, before any external
// call, that the supplied adapter actually implements the full contract it
// depends on (in particular the three R8 recovery methods). A staging
// build missing reconcileAdminAndCompany would previously have crashed
// deep inside the resume flow, AFTER real Auth/Firestore resources may
// already have been created — never before. This gate makes a missing
// method a fail-closed SAFE_STOP with zero external calls of any kind,
// the very first thing the orchestrator checks.
const REQUIRED_ADAPTER_METHODS = Object.freeze([
  'probeReadiness', 'recipientPreflight',
  'createAdminAndCompany', 'reconcileAdminAndCompany',
  'inviteRecipient', 'reconcileInvitation',
  'registerRecipient', 'findAuthUidByEmail',
  'sendVerificationEmail', 'checkVerification', 'signInRecipient', 'acceptInvite',
  'readCompanyRoleFor', 'auditEventCount', 'memberUpdatedAtMs', 'findAuditEventPaths',
  'listChildCollections', 'readDoc', 'deleteDoc', 'deleteAuthUser',
  'authUserExists', 'authUserExistsByEmail', 'legacyInventory',
])
const REQUIRED_LEGACY_ADAPTER_METHODS = Object.freeze([
  'listChildCollections', 'readDoc', 'deleteDoc', 'deleteAuthUser', 'authUserExists', 'authUserExistsByEmail',
])

export function assertAdapterContract(adapters) {
  if (!record(adapters)) blocked('adapter_contract_missing:*')
  const missing = REQUIRED_ADAPTER_METHODS.filter(name => typeof adapters[name] !== 'function')
  if (!record(adapters.legacyAdapters)) missing.push('legacyAdapters')
  else missing.push(...REQUIRED_LEGACY_ADAPTER_METHODS.filter(name => typeof adapters.legacyAdapters[name] !== 'function').map(name => `legacyAdapters.${name}`))
  if (missing.length) blocked(`adapter_contract_missing:${missing.join(',')}`)
  return true
}

function emptyLedger(runId) {
  return { runId, createdAuthUids: [], ownerMailboxUidCreated: false, createdFirestorePaths: [], casPaths: [] }
}

/**
 * Runs the full gate-G-A sequence. `adapters` supplies every effectful
 * operation (never a real network call from within this file itself):
 * {
 *   probeReadiness(fn) -> {ready, httpStatus, verdict},
 *   recipientPreflight(recipient) -> {project, recipientSha256, absent},
 *   createAdminAndCompany() -> {adminUid, companyId, memberPath, dataPath, profilePath, bootstrapPath, adminIdToken},
 *   inviteRecipient({companyId, adminIdToken, recipient}) -> {inviteId, invitationPath, lockPath, token},
 *   registerRecipient({recipient, password}) -> {recipientUid, idToken, profilePath},
 *   sendVerificationEmail({idToken}) -> {dispatched: boolean},
 *   checkVerification({recipientUid}) -> {uid, email, emailVerified} (read-only, polled),
 *   signInRecipient({recipient, password}) -> {idToken} (fresh token after verification — also used on resume),
 *   acceptInvite({idToken, inviteId, token}) -> {ok, companyId},
 *   readCompanyRoleFor({recipientUid, companyId}) -> {role},
 *   listChildCollections(path), readDoc(path), deleteDoc(path), deleteAuthUser(uid),
 *   authUserExists(uid), authUserExistsByEmail(),
 *   legacyInventory(plan) -> the injected shape evaluateLegacyResidual expects,
 *   legacyAdapters: same shape as top-level cleanup adapters, scoped to legacy paths,
 * }
 * `faults` triggers the specific negative-scenario branches (see gate-G-A R3
 * package §3 for the exact list); every fault is opt-in and defaults to off.
 * `resume:true` continues a previously claimed run from its durable run
 * manifest instead of starting a fresh one (see gateGaRunManifestCore.mjs).
 * `legacyCleanupApproved:true` is the ONLY thing that may ever authorize
 * legacy-residual deletion — bound by the caller to the reviewed approval
 * document, never to an internal test-only flag.
 */
export async function runGateGaOrchestrator({
  profile, project, seamExpectedHashes, readFile, recipient, ownerConfirmedRecipientSha256,
  adapters, faults = {}, claimedDir, sourceHead, journal = makeJournal(),
  checkpointDir = claimedDir,
  verificationDeadlineMs = DEFAULT_VERIFICATION_DEADLINE_MS,
  verificationIntervalMs = DEFAULT_VERIFICATION_INTERVAL_MS,
  onOwnerActionRequired = () => {},
  // R7/R8: fired at precise points in the flow, used ONLY by real-process
  // crash-window tests (gateGaCrashWindowsCliTest.mjs) to kill the process
  // at an exact, reproducible point; never used to change any production
  // behavior. Points AFTER the corresponding durable write (proving the
  // NEXT step resumes cleanly): 'ADMIN_CREATED', 'RECIPIENT_REGISTERED',
  // 'EMAIL_SENT_PENDING_CHECKPOINT' (after the send adapter call returns,
  // before markEmailSent durably records it). Points BEFORE the
  // corresponding durable write (proving RECONCILIATION of an
  // already-real-but-unrecorded external effect):
  // 'ADMIN_AUTH_CREATED_PRE_COMPANY' (fired inside
  // adapters.createAdminAndCompany, between the admin Auth account being
  // created and the company being created), 'ADMIN_AND_COMPANY_CREATED_PRE_MANIFEST',
  // 'INVITE_CREATED_PRE_MANIFEST', 'RECIPIENT_REGISTERED_PRE_UID_CHECKPOINT'.
  onInternalCheckpoint = () => {},
  resume = false,
  legacyCleanupApproved = false,
  // Injectable (real implementations by default) so unit tests never incur
  // real Windows PowerShell ACL calls — proven for real by
  // gateGaPrivateDirAclSelfTest.mjs and by the real emulator/CLI E2E runs,
  // which never override these.
  ensureAcl = ensurePrivateDirectoryAcl,
  verifyFileAcl = verifyPrivateFileAcl,
}) {
  if (profile !== 'staging' && profile !== 'emulator') blocked('bad_profile')
  const normalizedRecipient = typeof recipient === 'string' ? recipient.trim().toLowerCase() : recipient
  journal.append('PRECONDITIONS_STARTED', { profile, project, resume })

  // --- -1. adapter contract: every required method (including the three R9 recovery
  // methods) must be present BEFORE anything else — a missing method is fail-closed,
  // zero external calls, zero Auth/Firestore resources created ------------------------
  try {
    assertAdapterContract(adapters)
    journal.append('ADAPTER_CONTRACT_VERIFIED', {})
  } catch (error) {
    journal.append('ADAPTER_CONTRACT_REFUSED', { reason: error.message })
    return safeStop(journal, 'ADAPTER_CONTRACT_REFUSED', { reason: error.message })
  }

  // --- 0. preflight: seam file integrity ------------------------------------------------
  const integrity = await verifySeamIntegrity(seamExpectedHashes, readFile)
  journal.append('SEAM_INTEGRITY_CHECKED', { ok: integrity.ok, mismatchCount: integrity.mismatches.length })
  if (!integrity.ok) return safeStop(journal, 'SEAM_INTEGRITY_MISMATCH', { mismatches: integrity.mismatches })

  // --- 0.5 private-directory ACL: locked down BEFORE any checkpoint/manifest write, and
  // therefore before any Auth user is ever created or any email is ever sent ------------
  try {
    ensureAcl({ dir: claimedDir })
    if (checkpointDir !== claimedDir) ensureAcl({ dir: checkpointDir })
    journal.append('PRIVATE_DIR_ACL_VERIFIED', {})
  } catch (error) {
    journal.append('PRIVATE_DIR_ACL_REFUSED', { reason: error.message })
    return safeStop(journal, 'PRIVATE_DIR_ACL_REFUSED', { reason: error.message })
  }

  // --- 1. run-id + durable run manifest --------------------------------------------------
  // Resume is validated ENTIRELY from local disk state, before any adapter
  // call of any kind (not even a read) — a missing or corrupted manifest, a
  // missing or mismatched run-id claim, or a manifest that does not match
  // THIS invocation's project/profile/recipient is refused here, with zero
  // new writes.
  let runId, ledger, admin, invite, resumedFromPhase = null
  if (resume) {
    let manifest
    try {
      manifest = readRunManifest({ claimedDir })
    } catch (error) {
      journal.append('RESUME_REFUSED', { reason: error.message })
      return safeStop(journal, 'RESUME_STATE_CORRUPT', { reason: error.message })
    }
    if (!manifest) {
      journal.append('RESUME_REFUSED', { reason: 'no_run_manifest' })
      return safeStop(journal, 'RESUME_STATE_MISSING', {})
    }
    if (manifest.project !== project || manifest.profile !== profile || manifest.sourceHead !== sourceHead ||
        manifest.recipientSha256 !== ownerConfirmedRecipientSha256) {
      journal.append('RESUME_REFUSED', { reason: 'run_manifest_mismatch' })
      return safeStop(journal, 'RESUME_STATE_MISMATCH', { runId: manifest.runId })
    }
    try { verifyFileAcl({ filePath: runManifestPathFor({ claimedDir }) }) } catch (error) {
      journal.append('RESUME_REFUSED', { reason: `run_manifest_acl:${error.message}` })
      return safeStop(journal, 'PRIVATE_DIR_ACL_REFUSED', { reason: error.message, runId: manifest.runId })
    }
    let claim
    try {
      claim = readClaim(path.join(claimedDir, `run-id-claim-${manifest.runId}.json`))
    } catch (error) {
      journal.append('RESUME_REFUSED', { reason: `run_id_claim_missing_or_corrupt:${error.message}` })
      return safeStop(journal, 'RESUME_STATE_CORRUPT', { runId: manifest.runId })
    }
    if (claim.runId !== manifest.runId) {
      journal.append('RESUME_REFUSED', { reason: 'run_id_claim_mismatch' })
      return safeStop(journal, 'RESUME_STATE_MISMATCH', { runId: manifest.runId })
    }
    runId = manifest.runId
    ledger = structuredClone(manifest.ledger)
    admin = manifest.admin
    invite = manifest.invite
    resumedFromPhase = manifest.phase
    journal.append('RUN_RESUMED', { runIdSha256: sha256(runId), phase: manifest.phase })
  } else {
    try {
      runId = faults.reuseRunId ? PRIOR_RUN_IDS[0] : generateRunId()
      claimRunId(runId, { claimedDir, project, sourceHead })
      journal.append('RUN_ID_CLAIMED', { runIdSha256: sha256(runId) })
      claimRunManifest({ claimedDir, runId, project, profile, recipientSha256: ownerConfirmedRecipientSha256, sourceHead, verifyFileAcl })
    } catch (error) {
      journal.append('RUN_ID_REFUSED', { reason: error.message })
      return safeStop(journal, 'RUN_ID_REFUSED', { reason: error.message })
    }
    ledger = emptyLedger(runId)
    admin = null
    invite = null
  }
  // Fragments grow as real (often server-random, e.g. Firestore auto-ids)
  // identifiers become known during the flow — a path/uid only ever enters
  // the destructive ledger in the same step that discovers its fragment.
  const allowedIdFragments = [runId]
  if (admin) allowedIdFragments.push(admin.adminUid, admin.companyId)
  if (invite) { allowedIdFragments.push(invite.inviteId); if (invite.lockPath) allowedIdFragments.push(invite.lockPath.split('/').at(-1)) }

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
    if (resume) {
      // On resume the recipient's Auth account may legitimately already
      // exist — created by THIS run's own earlier registerRecipient call,
      // before the process was killed. Module E's "must be absent" rule
      // exists to stop a FRESH run from hijacking or reusing an unrelated
      // pre-existing account; it does not apply here, because resume was
      // only reached at all after step 1 verified this exact run's own
      // manifest and run-id claim. The confirmed-recipient hash binding is
      // still fully re-checked — only "absent" is skipped.
      if (recipientPreflight.recipientSha256 !== ownerConfirmedRecipientSha256) blocked('recipient_confirmation_mismatch_on_resume')
    } else {
      assertOwnerConfirmedRecipient(recipientPreflight, ownerConfirmedRecipientSha256)
    }
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
      if (resumedFromPhase === 'CLAIMED') {
        // R8: admin+company creation was never confirmed complete by a
        // durable manifest write, but that does NOT mean nothing external
        // happened — createAdminAndCompany() may have created the admin
        // Auth account, or the company, or both, before the process was
        // killed. Recover by NARROW, EXACT, read-only lookup of the
        // identifiers this exact run deterministically owns (never a
        // blind retry, never a broad scan) and either reconcile the same
        // resource or prove there is truly nothing to clean up.
        const reconciled = await adapters.reconcileAdminAndCompany({ runId })
        if (!reconciled.found) {
          journal.append('RESUME_RECONCILE_ADMIN_NOT_FOUND', {})
          throw new Error('resume_indeterminate_before_admin_created_confirmed_absent')
        }
        if (reconciled.orphaned) {
          // Admin Auth exists, but the fixed user_bootstrap/{adminUid}
          // receipt does not — createCompany's single transaction never
          // committed, so the company was provably never created. The
          // admin account is real and disposable: add it to THIS run's
          // ledger so cleanup below removes it, then stop — never guess
          // forward past an unconfirmed company creation.
          allowedIdFragments.push(reconciled.adminUid)
          ledger.createdAuthUids.push(reconciled.adminUid)
          journal.append('RESUME_RECONCILE_ADMIN_ORPHANED', { adminUidSha256: sha256(reconciled.adminUid) })
          throw new Error('resume_reconciled_orphaned_admin_cleaned_up')
        }
        // Both admin and company are confirmed real and belong to this
        // exact run (adminUid is deterministic from this run's own
        // runTag) — safe to reconcile and continue the same flow a fresh
        // run would take from here, after durably closing the gap this
        // time.
        allowedIdFragments.push(reconciled.adminUid, reconciled.companyId)
        ledger.createdAuthUids.push(reconciled.adminUid)
        ledger.createdFirestorePaths.push(`companies/${reconciled.companyId}`, reconciled.dataPath, reconciled.memberPath, reconciled.profilePath, reconciled.bootstrapPath)
        const { adminIdToken: _reconciledAdminIdToken, ...adminForManifest } = reconciled
        admin = reconciled
        updateRunManifest({ claimedDir, fromPhase: 'CLAIMED', patch: { phase: 'ADMIN_CREATED', admin: adminForManifest, ledger }, verifyFileAcl })
        journal.append('RESUME_RECONCILE_ADMIN_RECOVERED', { companyIdSha256: sha256(reconciled.companyId) })
        // Deliberately NOT reassigning resumedFromPhase here: it stays
        // 'CLAIMED', so the invite-reconciliation check below (gated on
        // resumedFromPhase === 'ADMIN_CREATED') correctly stays inactive —
        // invite creation was never attempted by ANY process yet in this
        // scenario, so there is nothing to reconcile; it proceeds straight
        // to a normal fresh invite creation a few lines down.
      }

      if (admin) {
        slotStates.createOwnerAAuth = 'RECONCILED'; slotStates.createCompanyA = 'RECONCILED'
        journal.append('ADMIN_AND_COMPANY_RESUMED', { companyIdSha256: sha256(admin.companyId) })
      } else {
        const created = await adapters.createAdminAndCompany({ runId, onInternalCheckpoint })
        allowedIdFragments.push(created.adminUid, created.companyId)
        ledger.createdAuthUids.push(created.adminUid)
        ledger.createdFirestorePaths.push(`companies/${created.companyId}`, created.dataPath, created.memberPath, created.profilePath, created.bootstrapPath)
        slotStates.createOwnerAAuth = 'RECONCILED'; slotStates.createCompanyA = 'RECONCILED'
        journal.append('ADMIN_AND_COMPANY_CREATED', { companyIdSha256: sha256(created.companyId) })
        // Persist BEFORE anything else external happens — the manifest never
        // stores the ephemeral adminIdToken (not needed past invite creation,
        // and never durably persisted on principle).
        const { adminIdToken: _adminIdToken, ...adminForManifest } = created
        await onInternalCheckpoint('ADMIN_AND_COMPANY_CREATED_PRE_MANIFEST')
        admin = created
        updateRunManifest({ claimedDir, fromPhase: 'CLAIMED', patch: { phase: 'ADMIN_CREATED', admin: adminForManifest, ledger }, verifyFileAcl })
        await onInternalCheckpoint('ADMIN_CREATED')
      }

      if (resumedFromPhase === 'ADMIN_CREATED' && !invite) {
        // R8: same recovery philosophy — inviteMember may have already
        // completed externally. invitationLocks/{lockId} is deterministic
        // from (companyId, emailNormalized), so a single point-read (never
        // a scan) either proves nothing was created, or finds the exact
        // invitation this run's own earlier attempt created. The raw
        // token is never persisted anywhere (SEC-006 design), so a found
        // invitation can never be safely resumed into accept — the only
        // correct move is to treat it as this run's own and clean it up.
        const reconciledInvite = await adapters.reconcileInvitation({ companyId: admin.companyId, recipient })
        if (!reconciledInvite.found) {
          journal.append('RESUME_RECONCILE_INVITE_NOT_FOUND', {})
          throw new Error('resume_indeterminate_before_invite_created_confirmed_absent')
        }
        allowedIdFragments.push(reconciledInvite.inviteId)
        ledger.createdFirestorePaths.push(reconciledInvite.invitationPath)
        if (reconciledInvite.lockPath) {
          allowedIdFragments.push(reconciledInvite.lockPath.split('/').at(-1))
          ledger.createdFirestorePaths.push(reconciledInvite.lockPath)
        }
        journal.append('RESUME_RECONCILE_INVITE_FOUND_NO_TOKEN', { inviteIdSha256: sha256(reconciledInvite.inviteId) })
        throw new Error('resume_reconciled_invite_no_token_cleanup')
      }

      if (invite) {
        slotStates.createMailboxFinalInvite = 'RECONCILED'
        journal.append('INVITATION_RESUMED', { inviteIdSha256: sha256(invite.inviteId) })
      } else {
        const created = await adapters.inviteRecipient({ companyId: admin.companyId, adminIdToken: admin.adminIdToken, recipient })
        allowedIdFragments.push(created.inviteId)
        ledger.createdFirestorePaths.push(created.invitationPath)
        if (created.lockPath) {
          allowedIdFragments.push(created.lockPath.split('/').at(-1))
          ledger.createdFirestorePaths.push(created.lockPath)
        }
        slotStates.createMailboxFinalInvite = 'RECONCILED'
        journal.append('INVITATION_CREATED', { inviteIdSha256: sha256(created.inviteId) })
        await onInternalCheckpoint('INVITE_CREATED_PRE_MANIFEST')
        invite = created
        updateRunManifest({ claimedDir, fromPhase: 'ADMIN_CREATED', patch: { phase: 'INVITED', invite, ledger }, verifyFileAcl })
      }

      if (faults.stopAfterPartial) {
        flowOutcome = { status: 'SAFE_STOP', reason: 'FAULT_STOP_AFTER_PARTIAL' }
      } else {
        // --- owner-in-the-loop email verification --------------------------
        // An indeterminate prior attempt is simulated for tests by seeding a
        // real MAY_BE_SENT checkpoint file before this call, exactly as a
        // crashed prior process would have left one — never by branching on
        // a fault flag here.
        const intent = claimOrResumeEmailIntent({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256, verifyFileAcl })

        if (!intent.fresh && intent.checkpoint.status === 'MAY_BE_SENT') {
          // A prior attempt's outcome is unknown. Never send again, never
          // guess whether the email was actually dispatched. But if
          // registration was durably confirmed before the crash
          // (recipientUid known — R7's recordRegisteredRecipient), that
          // Auth account is real and disposable: add it to THIS run's
          // cleanup ledger so it gets deleted below — no created external
          // state is ever left outside the ledger, even from this window.
          let recipientUidKnown = intent.checkpoint.recipientUid
          if (!recipientUidKnown) {
            // R8: recipientUid may be missing not because registration
            // never happened, but because the crash landed between
            // registerRecipient() returning and recordRegisteredRecipient()
            // durably writing it. Narrow, exact recovery by the single
            // owner-confirmed recipient email (never a broad search) closes
            // this window: if the Auth account is real, record it durably
            // now (so this gap can never reopen for this recipient) before
            // treating it the same as an already-known recipientUid.
            const discovered = await adapters.findAuthUidByEmail(recipient)
            if (discovered.uid) {
              recordRegisteredRecipient({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256, recipientUid: discovered.uid, verifyFileAcl })
              recipientUidKnown = discovered.uid
              journal.append('RESUME_RECONCILE_RECIPIENT_UID_RECOVERED', {})
            }
          }
          if (recipientUidKnown) {
            allowedIdFragments.push(recipientUidKnown)
            ledger.createdAuthUids.push(recipientUidKnown)
            ledger.createdFirestorePaths.push(`users/${recipientUidKnown}`)
          }
          journal.append('EMAIL_SEND_INDETERMINATE', { recipientUidKnown: Boolean(recipientUidKnown) })
          throw new Error('email_send_indeterminate')
        }

        let recipientUid, freshIdTokenForAccept
        const recipientPassword = intent.checkpoint.recipientPassword
        const checkpointFilePath = checkpointPathFor({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256 })
        if (intent.fresh) {
          const registered = await adapters.registerRecipient({ recipient, password: recipientPassword })
          recipientUid = registered.recipientUid
          allowedIdFragments.push(recipientUid)
          ledger.createdAuthUids.push(recipientUid)
          ledger.createdFirestorePaths.push(registered.profilePath)
          slotStates.createOwnerMailboxAuth = 'RECONCILED'
          journal.append('RECIPIENT_REGISTERED', {})
          await onInternalCheckpoint('RECIPIENT_REGISTERED_PRE_UID_CHECKPOINT')

          // Durably record the uid BEFORE any send attempt (R7): a crash
          // between this write and the send call is now recoverable — a
          // resumed process sees a known recipientUid immediately (via the
          // indeterminate branch above) and can clean it up without ever
          // guessing or leaving it outside the ledger.
          recordRegisteredRecipient({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256, recipientUid, verifyFileAcl })
          await onInternalCheckpoint('RECIPIENT_REGISTERED')

          journal.append('EMAIL_MAY_BE_SENT', {})
          const sent = await adapters.sendVerificationEmail({ idToken: registered.idToken })
          if (sent.dispatched) emailsSent++
          journal.append('EMAIL_SENT', { dispatched: sent.dispatched })
          await onInternalCheckpoint('EMAIL_SENT_PENDING_CHECKPOINT')
          if (faults.doubleSendEmail) {
            const second = await adapters.sendVerificationEmail({ idToken: registered.idToken })
            if (second.dispatched) emailsSent++
            journal.append('EMAIL_SENT', { dispatched: second.dispatched, fault: 'doubleSendEmail' })
          }
          if (emailsSent !== 1) blocked('email_count_not_exactly_one')
          markEmailSent({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256, recipientUid, verifyFileAcl })
          await onOwnerActionRequired({ recipientSha256: recipientPreflight.recipientSha256 })
        } else {
          // Resume: a checkpoint already recorded SENT (or VERIFIED) for
          // this exact recipient in an earlier process — the Auth account
          // already exists; never call registerRecipient or send again.
          recipientUid = intent.checkpoint.recipientUid
          allowedIdFragments.push(recipientUid)
          ledger.createdAuthUids.push(recipientUid)
          ledger.createdFirestorePaths.push(`users/${recipientUid}`)
          slotStates.createOwnerMailboxAuth = 'RECONCILED'
          verifyFileAcl({ filePath: checkpointFilePath })
          journal.append('EMAIL_RESUMED_FROM_CHECKPOINT', { status: intent.checkpoint.status })
        }

        journal.append('VERIFICATION_POLL_STARTED', {})
        const poll = await pollForVerification({
          checkAuth: uid => adapters.checkVerification({ recipientUid: uid }),
          recipientUid, expectedEmail: normalizedRecipient,
          deadlineMs: faults.verificationTimeout ? 1 : verificationDeadlineMs,
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
        markEmailVerified({ checkpointDir, recipientSha256: recipientPreflight.recipientSha256, verifyFileAcl })
        journal.append('VERIFICATION_COMPLETE', {})

        const signedIn = await adapters.signInRecipient({ recipient, password: recipientPassword })
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

        for (const path_ of await adapters.findAuditEventPaths(admin.companyId)) if (!ledger.createdFirestorePaths.includes(path_)) ledger.createdFirestorePaths.push(path_)
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
  // legacyCleanupApproved is bound by the caller to the reviewed approval
  // document (never a test-only fault flag in production code paths) — an
  // eligible-but-unapproved residual is neither cleaned nor silently treated
  // as "clean": it gets its own distinct status, PENDING_APPROVAL, which the
  // final decision below explicitly excludes from a full PASS.
  let legacyCleanupResult
  if (!legacyEvaluation.eligible) {
    legacyCleanupResult = { status: 'NOT_APPLICABLE' }
    journal.append('LEGACY_CLEANUP_SKIPPED', { eligible: false, approved: Boolean(legacyCleanupApproved) })
  } else if (!legacyCleanupApproved) {
    legacyCleanupResult = { status: 'PENDING_APPROVAL' }
    journal.append('LEGACY_CLEANUP_PENDING_APPROVAL', { eligible: true })
  } else {
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
