import { createHash } from 'node:crypto'

// Everything known in plaintext, locally, about the 2026-09-11 interrupted
// Stage 8 run — sourced only from the already-existing private recovery
// stream `stage8-live-f9f82cf-result.json.recovery.jsonl` (seq 10,
// RECOVERY_REQUIRED.recoveryManifest), never from a fresh network read. The
// actual Firestore document id of "Company A" was never persisted in
// plaintext anywhere (only its hash, via the separate sanitized
// reconciliation result) — it can only be resolved by a live, read-only
// query matched against every field below, at gate-execution time, never
// during this offline preparation.
export const LEGACY_KNOWN = Object.freeze({
  runId: 'stage8-mtww3p0r-1ae5cb84b43c285e',
  ownerAUid: 'stage8-mtww3p0r-1ae5cb84b43c285e-ownerA',
  ownerBUid: 'stage8-mtww3p0r-1ae5cb84b43c285e-ownerB', // planned, NOT_STARTED — must not exist
  ownerMailboxSha256: '50c83bec2a6e80ad0b8f817a6421fb4d3f1138ccc0da54f601de92d2437abf4f',
  idempotencyKey: 'gCi5575BfggkoSnnTI8KNm5u_NRqKIqgrbWvp17imPo',
  ownerName: 'Stage8 Owner A',
  companyName: 'Stage8 Company A',
  legalType: 'ooo',
  sourceHead: 'f9f82cf090f90a6011720c9eedce1a6f27ba77e6',
  sourceEvidence: 'stage8-live-f9f82cf-result.json.recovery.jsonl#seq10',
})
// company_data is a top-level sibling collection (company_data/{companyId}),
// not a subcollection of companies/{companyId} — confirmed against the real
// compiled functions/src/index.ts createCompany transaction (gate-G-A R3
// emulator integration). Only members/audit_events are true subcollections.
export const EXPECTED_SUBCOLLECTIONS = Object.freeze(['members', 'audit_events'])

const blocked = () => { throw new Error('legacy_residual_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')

// The exact, structural spec of the read-only calls the live gate G-A
// executor must run before considering ANY legacy deletion — data, not
// action. Namespaced entirely separately from the new run's own ledger.
export function planLegacyInventory() {
  return Object.freeze({
    namespace: 'stage8-legacy-residual',
    reads: Object.freeze([
      Object.freeze({ kind: 'auth-by-uid', uid: LEGACY_KNOWN.ownerAUid }),
      Object.freeze({ kind: 'auth-by-uid', uid: LEGACY_KNOWN.ownerBUid }),
      Object.freeze({ kind: 'firestore-doc', path: `user_bootstrap/${LEGACY_KNOWN.ownerAUid}` }),
      Object.freeze({
        kind: 'firestore-query', collection: 'companies',
        where: Object.freeze([['ownerUid', '==', LEGACY_KNOWN.ownerAUid]]),
      }),
    ]),
  })
}

/**
 * inventory shape (all injected, read-only, gathered live at gate-execution
 * time — never during this offline preparation):
 * {
 *   ownerAAuth: { exists, uid },
 *   ownerBAuth: { exists },
 *   bootstrap: { exists, ownerUid },
 *   companies: [{ id, name, ownerUid, ownerName, legalType,
 *                  idempotencyKeySha256, companyDataExists, subcollections: [names...],
 *                  members: [{ uid, role }], auditEvents: [{ action }] }],
 * }
 * Returns eligible:true ONLY on an exact, total match to LEGACY_KNOWN with
 * nothing extra anywhere. Eligibility is necessary but never sufficient —
 * the caller must still require a separate explicit owner confirmation
 * before deleting anything; this function never deletes and is never wired
 * to do so.
 */
export function evaluateLegacyResidual(inventory) {
  if (!record(inventory) || !Array.isArray(inventory.companies)) blocked()
  const reasons = []
  if (!record(inventory.ownerAAuth) || inventory.ownerAAuth.exists !== true || inventory.ownerAAuth.uid !== LEGACY_KNOWN.ownerAUid) {
    reasons.push('OWNER_A_AUTH_MISMATCH')
  }
  if (!record(inventory.ownerBAuth) || inventory.ownerBAuth.exists !== false) {
    reasons.push('OWNER_B_UNEXPECTEDLY_PRESENT')
  }
  if (!record(inventory.bootstrap) || inventory.bootstrap.exists !== true || inventory.bootstrap.ownerUid !== LEGACY_KNOWN.ownerAUid) {
    reasons.push('BOOTSTRAP_MISMATCH')
  }
  if (inventory.companies.length !== 1) reasons.push('COMPANY_COUNT_NOT_EXACTLY_ONE')
  const idempotencyKeySha256 = sha256(LEGACY_KNOWN.idempotencyKey)
  const company = inventory.companies[0]
  if (inventory.companies.length === 1) {
    if (!record(company) || company.name !== LEGACY_KNOWN.companyName || company.ownerUid !== LEGACY_KNOWN.ownerAUid ||
        company.ownerName !== LEGACY_KNOWN.ownerName || company.legalType !== LEGACY_KNOWN.legalType ||
        company.idempotencyKeySha256 !== idempotencyKeySha256) {
      reasons.push('COMPANY_FIELDS_MISMATCH')
    } else if (company.companyDataExists !== true) {
      reasons.push('COMPANY_DATA_DOCUMENT_MISSING')
    } else {
      const subs = Array.isArray(company.subcollections) ? [...company.subcollections].sort() : null
      if (!subs || JSON.stringify(subs) !== JSON.stringify([...EXPECTED_SUBCOLLECTIONS].sort())) reasons.push('UNEXPECTED_SUBCOLLECTIONS')
      const members = Array.isArray(company.members) ? company.members : null
      if (!members || members.length !== 1 || members[0].uid !== LEGACY_KNOWN.ownerAUid || members[0].role !== 'admin') {
        reasons.push('UNEXPECTED_MEMBERS')
      }
      const events = Array.isArray(company.auditEvents) ? company.auditEvents : null
      if (!events || events.length !== 1 || events[0].action !== 'company_created') reasons.push('UNEXPECTED_AUDIT_EVENTS')
    }
  }

  if (reasons.length) return Object.freeze({ eligible: false, reasons: Object.freeze(reasons) })

  return Object.freeze({
    eligible: true,
    reasons: Object.freeze([]),
    // Only resolvable at live-execution time; this function never invents
    // or guesses the id — the caller supplies exactly what it read.
    deleteTargets: Object.freeze({
      authUids: Object.freeze([LEGACY_KNOWN.ownerAUid]),
      firestorePaths: Object.freeze([
        `companies/${company.id}`,
        `company_data/${company.id}`,
        `companies/${company.id}/members/${LEGACY_KNOWN.ownerAUid}`,
        `companies/${company.id}/audit_events/${company.auditEvents[0].id}`,
        `user_bootstrap/${LEGACY_KNOWN.ownerAUid}`,
      ]),
    }),
  })
}

export function legacyEvidenceSummary(evaluation) {
  return Object.freeze({
    namespace: 'stage8-legacy-residual',
    runId: LEGACY_KNOWN.runId,
    eligible: evaluation.eligible,
    reasons: evaluation.reasons,
    targetCountSha256: evaluation.eligible
      ? sha256(JSON.stringify([evaluation.deleteTargets.authUids.length, evaluation.deleteTargets.firestorePaths.length]))
      : null,
  })
}
