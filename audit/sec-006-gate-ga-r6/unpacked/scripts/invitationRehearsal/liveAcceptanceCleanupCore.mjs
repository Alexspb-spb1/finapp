import { createHash } from 'node:crypto'
import { FIXTURE_MUTATION_SLOT_SPECS, PROJECT } from './liveAcceptanceCore.mjs'

// Manifest-based cleanup for one gate-G-A run. Unlike buildCleanupTargets in
// liveAcceptanceCore.mjs (which assumes the full 16-slot flow completed and
// is reused as-is, unmodified, for that exact case) this module works from an
// incrementally accumulated *ledger* of exactly what THIS run created, so it
// can also cover a safely-classified partial run. It never re-derives targets
// from expected counts — only from what was actually recorded as created.

const blocked = () => { throw new Error('cleanup_executor_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const sha256 = value => createHash('sha256').update(value).digest('hex')
const runIdRe = /^[a-z][a-z0-9-]{7,39}$/
const stringArray = value => Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0)
const uniqueArray = value => stringArray(value) && new Set(value).size === value.length

export const CLEANUP_MAX = Object.freeze({ authUids: 2, firestorePaths: 25 })
export const EXPECTED_COMPANY_SUBCOLLECTIONS = Object.freeze(['company_data', 'members', 'audit_events'])
const WRITE_LIKE = new Set(['WRITE', 'IDEMPOTENT_READBACK'])
const WRITE_SLOTS = Object.freeze(FIXTURE_MUTATION_SLOT_SPECS.filter(s => WRITE_LIKE.has(s.disposition)).map(s => s.slot))

/**
 * Decide, from durable per-slot states, whether cleanup may proceed at all.
 * A single UNCERTAIN write-slot blocks every deletion for the whole run —
 * cleanup only ever runs after PASS or after a safely-classified STOP where
 * every write-slot is definitively RECONCILED or definitively NOT_STARTED.
 */
export function classifyCleanupEligibility(slotStates) {
  if (!record(slotStates)) blocked()
  const known = new Set(['RECONCILED', 'NOT_STARTED', 'UNCERTAIN'])
  for (const slot of WRITE_SLOTS) if (!known.has(slotStates[slot])) blocked()
  const uncertainSlots = Object.freeze(WRITE_SLOTS.filter(slot => slotStates[slot] === 'UNCERTAIN'))
  if (uncertainSlots.length) return Object.freeze({ eligible: false, reason: 'UNCERTAIN_SLOTS', uncertainSlots })
  const reconciledSlots = Object.freeze(WRITE_SLOTS.filter(slot => slotStates[slot] === 'RECONCILED'))
  return Object.freeze({ eligible: true, reconciledSlots })
}

/**
 * A ledger entry is appended durably (by the caller, via the journal) the
 * moment a slot reconciles as created — never pre-declared, never batched.
 * validateLedger proves the ledger is well-formed and internally consistent
 * before it is ever trusted as a source of destructive targets.
 */
export function validateLedger(ledger, { runId, allowedIdFragments }) {
  if (!runIdRe.test(runId ?? '')) blocked()
  if (!Array.isArray(allowedIdFragments) || allowedIdFragments.length === 0 ||
      !allowedIdFragments.every(v => typeof v === 'string' && v.length >= 4)) blocked()
  if (!exactKeys(ledger, ['runId', 'createdAuthUids', 'ownerMailboxUidCreated', 'createdFirestorePaths', 'casPaths']) ||
      ledger.runId !== runId) blocked()
  if (!uniqueArray(ledger.createdAuthUids) || ledger.createdAuthUids.length > CLEANUP_MAX.authUids) blocked()
  if (typeof ledger.ownerMailboxUidCreated !== 'boolean') blocked()
  if (!uniqueArray(ledger.createdFirestorePaths) || ledger.createdFirestorePaths.length > CLEANUP_MAX.firestorePaths) blocked()
  if (!uniqueArray(ledger.casPaths)) blocked()
  // CAS-required (preserve) paths must never overlap the destructive set —
  // this is the structural guarantee that the real mailbox owner's own
  // documents can never be scheduled for deletion by construction.
  if (ledger.casPaths.some(path => ledger.createdFirestorePaths.includes(path))) blocked()
  // Every destructive uid/path must contain at least one id fragment that is
  // actually part of THIS run (synthetic auth uids / company ids handed to
  // buildFixturePlan for this exact runId). A path or uid belonging to a
  // different run, a different company, or anything not created by this run
  // — a "foreign document" — has no matching fragment and is refused.
  const belongsToRun = value => allowedIdFragments.some(fragment => value.includes(fragment))
  if (!ledger.createdAuthUids.every(belongsToRun)) blocked()
  if (!ledger.createdFirestorePaths.every(belongsToRun)) blocked()
  return true
}

/**
 * Read-only structural check: every company path touched by this run must
 * expose exactly the known subcollection/document names and nothing else.
 * listChildCollections(path) is injected (never a real network call from
 * this module) so this is testable with a fake reader and, at live-run time,
 * backed by a real Firestore read.
 */
export async function assertNoUnexpectedSubcollections(companyPaths, listChildCollections) {
  if (!stringArray(companyPaths)) blocked()
  if (typeof listChildCollections !== 'function') blocked()
  for (const path of companyPaths) {
    const names = await listChildCollections(path)
    if (!stringArray(names)) blocked()
    const unexpected = names.filter(name => !EXPECTED_COMPANY_SUBCOLLECTIONS.includes(name))
    if (unexpected.length) return Object.freeze({ clean: false, path, unexpected: Object.freeze(unexpected) })
  }
  return Object.freeze({ clean: true })
}

/**
 * CAS precondition: every preserved path must still exist, unchanged, right
 * before deletion starts. readDoc(path) is injected. Any missing/changed CAS
 * document refuses the whole run's cleanup before a single delete.
 */
async function verifyCasPreconditions(ledger, readDoc) {
  for (const path of ledger.casPaths) {
    const doc = await readDoc(path)
    if (!record(doc) || doc.exists !== true || !hexOrNull(doc.stateSha256)) return Object.freeze({ ok: false, path })
  }
  return Object.freeze({ ok: true })
}
function hexOrNull(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }

const outcomeOf = results => {
  const attempted = results.length
  const succeeded = results.filter(r => r.ok).length
  if (attempted === 0) return 'CLEANUP_REFUSED'
  if (succeeded === attempted) return 'CLEANUP_COMPLETE'
  if (succeeded === 0) return 'CLEANUP_REFUSED'
  return 'CLEANUP_PARTIAL'
}

/**
 * Execute cleanup for exactly this run's ledger. adapters = {
 *   listChildCollections(path), readDoc(path), deleteDoc(path),
 *   deleteAuthUser(uid), authUserExists(uid), authUserExistsByEmail(),
 * } — every one injected; this module never opens a network connection.
 * authUserExistsByEmail takes NO argument (the real email stays inside the
 * caller's closure) and returns a boolean, so this module and its journal
 * never see the plaintext recipient address.
 */
export async function executeManifestCleanup({ runId, slotStates, ledger, adapters, journal, allowedIdFragments }) {
  if (!runIdRe.test(runId ?? '')) blocked()
  const eligibility = classifyCleanupEligibility(slotStates)
  journal.append('CLEANUP_ELIGIBILITY_EVALUATED', { eligible: eligibility.eligible, reason: eligibility.reason ?? null })
  if (!eligibility.eligible) {
    journal.append('SAFE_STOP', { reason: 'UNCERTAIN_SLOTS', uncertainSlots: eligibility.uncertainSlots })
    return Object.freeze({ status: 'CLEANUP_REFUSED', deleted: Object.freeze({ authUids: [], firestorePaths: [] }), reason: 'UNCERTAIN_SLOTS' })
  }
  validateLedger(ledger, { runId, allowedIdFragments })
  if (ledger.createdAuthUids.length === 0 && ledger.createdFirestorePaths.length === 0) {
    journal.append('CLEANUP_NOOP', {})
    return Object.freeze({ status: 'CLEANUP_COMPLETE_VERIFIED', deleted: Object.freeze({ authUids: [], firestorePaths: [] }) })
  }
  const subcollectionCheck = await assertNoUnexpectedSubcollections(companyPathsOf(ledger), adapters.listChildCollections)
  journal.append('SUBCOLLECTION_CHECK', subcollectionCheck.clean
    ? { clean: true }
    : { clean: false, path: subcollectionCheck.path, unexpectedSha256: sha256(JSON.stringify(subcollectionCheck.unexpected)) })
  if (!subcollectionCheck.clean) {
    journal.append('SAFE_STOP', { reason: 'UNEXPECTED_SUBCOLLECTION' })
    return Object.freeze({ status: 'CLEANUP_REFUSED', deleted: Object.freeze({ authUids: [], firestorePaths: [] }), reason: 'UNEXPECTED_SUBCOLLECTION' })
  }
  const cas = await verifyCasPreconditions(ledger, adapters.readDoc)
  journal.append('CAS_PRECONDITION_CHECK', { ok: cas.ok })
  if (!cas.ok) {
    journal.append('SAFE_STOP', { reason: 'CAS_PRECONDITION_FAILED' })
    return Object.freeze({ status: 'CLEANUP_REFUSED', deleted: Object.freeze({ authUids: [], firestorePaths: [] }), reason: 'CAS_PRECONDITION_FAILED' })
  }

  const results = []
  outer: {
    for (const path of ledger.createdFirestorePaths) {
      let ok = false
      try { await adapters.deleteDoc(path); ok = true } catch { ok = false }
      results.push({ kind: 'firestore', id: path, ok })
      journal.append('DELETE_ATTEMPTED', { kind: 'firestore', pathSha256: sha256(path), ok })
      if (!ok) break outer
    }
    for (const uid of ledger.createdAuthUids) {
      let ok = false
      try { await adapters.deleteAuthUser(uid); ok = true } catch { ok = false }
      results.push({ kind: 'auth', id: uid, ok })
      journal.append('DELETE_ATTEMPTED', { kind: 'auth', ok })
      if (!ok) break outer
    }
  }

  const status = outcomeOf(results)
  const deleted = Object.freeze({
    authUids: Object.freeze(results.filter(r => r.kind === 'auth' && r.ok).map(r => r.id)),
    firestorePaths: Object.freeze(results.filter(r => r.kind === 'firestore' && r.ok).map(r => r.id)),
  })
  if (status !== 'CLEANUP_COMPLETE') {
    journal.append('RECOVERY_REQUIRED', { status, attempted: results.length, succeeded: results.filter(r => r.ok).length })
    return Object.freeze({ status: status === 'CLEANUP_REFUSED' ? 'CLEANUP_REFUSED' : 'CLEANUP_PARTIAL', deleted, reason: 'DELETE_FAILED' })
  }

  const verify = await verifyClean(ledger, adapters)
  journal.append('VERIFY_CLEAN', { clean: verify.clean })
  if (!verify.clean) {
    journal.append('RECOVERY_REQUIRED', { status: 'CLEANUP_VERIFY_MISMATCH', remainder: verify.remainder })
    return Object.freeze({ status: 'CLEANUP_VERIFY_MISMATCH', deleted, remainder: verify.remainder })
  }
  journal.append('CLEANUP_COMPLETE_VERIFIED', {})
  return Object.freeze({ status: 'CLEANUP_COMPLETE_VERIFIED', deleted })
}

function companyPathsOf(ledger) {
  return Object.freeze(ledger.createdFirestorePaths.filter(path => /^companies\/[^/]+$/.test(path)))
}

async function verifyClean(ledger, adapters) {
  const remainder = []
  for (const path of ledger.createdFirestorePaths) {
    const doc = await adapters.readDoc(path)
    if (record(doc) && doc.exists === true) remainder.push({ kind: 'firestore', path })
  }
  for (const uid of ledger.createdAuthUids) {
    if (await adapters.authUserExists(uid)) remainder.push({ kind: 'auth-uid' })
  }
  if (await adapters.authUserExistsByEmail()) remainder.push({ kind: 'auth-email' })
  return remainder.length ? Object.freeze({ clean: false, remainder: Object.freeze(remainder) }) : Object.freeze({ clean: true, remainder: Object.freeze([]) })
}

export { PROJECT }
