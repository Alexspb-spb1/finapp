// Classifies an EXISTING companies/{companyId}/members/{uid} document
// against a candidate backfill relation — SEC-005.
//
// Independent audit (2nd round) fix #2: this module used to duck-type
// Firestore Timestamps (any object with numeric seconds/nanoseconds, or
// even an object with a toDate() function of ANY shape) as valid — which
// meant a hand-crafted `{ seconds, nanoseconds }` plain object, or a
// forged object with a fake `toDate()`, was indistinguishable from a real
// server-assigned Timestamp. Only a real `firebase-admin/firestore`
// `Timestamp` instance is accepted now. Importing the `Timestamp` CLASS
// does not require an initialized Admin SDK app or network access — it is
// a plain value type (`Timestamp.now()`, `new Timestamp(...)` work with no
// app) — so this module (and its tests) still never need a real Firestore
// connection or the emulator.
import { Timestamp } from 'firebase-admin/firestore'
import { isKnownRole, type Role } from './types.ts'

// Independent audit fix #2: 'differs_but_valid' (a strictly well-formed,
// active, schema-valid membership with a DIFFERENT role than the
// candidate) is now distinct from 'invalid' (uid mismatch, unknown role,
// non-active status, missing/malformed timestamps, or extra fields).
// `accept_existing` may only ever resolve 'differs_but_valid' — 'invalid'
// remains a blocking conflict regardless of any decision (see planner.ts).
export type ExistingMembershipClassification = 'not_found' | 'exact_match' | 'differs_but_valid' | 'invalid'

const ALLOWED_KEYS = new Set(['uid', 'role', 'status', 'createdAt', 'updatedAt', 'invitedBy'])

function isRealTimestamp(value: unknown): boolean {
  return value instanceof Timestamp
}

/** True only for a document that is a strictly well-formed, ACTIVE,
 * schema-valid canonical membership FOR THIS uid — independent of which
 * role it holds. Reused both by classifyExistingMembership() (candidate
 * reconciliation) and by callers that need to know "is this an
 * unconditionally trustworthy active membership" (e.g. the last-admin
 * gate — a corrupted document must never count as an admin). */
export function isStrictlyValidActiveMembership(uid: string, data: Record<string, unknown> | undefined): boolean {
  if (data === undefined) return false
  const keys = Object.keys(data)
  if (keys.some(k => !ALLOWED_KEYS.has(k))) return false
  if (data.uid !== uid) return false
  if (!isKnownRole(data.role)) return false
  if (data.status !== 'active') return false
  if (!isRealTimestamp(data.createdAt)) return false
  if (!isRealTimestamp(data.updatedAt)) return false
  if (data.invitedBy !== undefined && (typeof data.invitedBy !== 'string' || data.invitedBy.length === 0)) return false
  return true
}

/**
 * `existingData` is `undefined` when no document exists at that path.
 * A candidate backfill relation is always `status: 'active'` (rule 10 — the
 * backfill never creates anything else).
 */
export function classifyExistingMembership(candidateRole: Role, uid: string, existingData: Record<string, unknown> | undefined): ExistingMembershipClassification {
  if (existingData === undefined) return 'not_found'
  if (!isStrictlyValidActiveMembership(uid, existingData)) return 'invalid'
  return existingData.role === candidateRole ? 'exact_match' : 'differs_but_valid'
}
