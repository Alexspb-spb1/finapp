// Classifies an EXISTING companies/{companyId}/members/{uid} document
// against a candidate backfill relation — SEC-005.
//
// Deliberately duck-types Firestore Timestamps (checks for numeric
// seconds/nanoseconds) instead of importing firebase-admin/firestore, so
// this module (and its tests) never need a real Admin SDK instance or the
// emulator — a plain object shaped like a Timestamp is enough to exercise
// every branch.
import { isKnownRole, type Role } from './types.ts'

// Independent audit fix #2: 'differs_but_valid' (a strictly well-formed,
// active, schema-valid membership with a DIFFERENT role than the
// candidate) is now distinct from 'invalid' (uid mismatch, unknown role,
// non-active status, missing/malformed timestamps, or extra fields).
// `accept_existing` may only ever resolve 'differs_but_valid' — 'invalid'
// remains a blocking conflict regardless of any decision (see planner.ts).
export type ExistingMembershipClassification = 'not_found' | 'exact_match' | 'differs_but_valid' | 'invalid'

const ALLOWED_KEYS = new Set(['uid', 'role', 'status', 'createdAt', 'updatedAt', 'invitedBy'])

function isTimestampLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  if (typeof rec.toDate === 'function') return true
  return typeof rec.seconds === 'number' && typeof rec.nanoseconds === 'number'
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
  if (!isTimestampLike(data.createdAt)) return false
  if (!isTimestampLike(data.updatedAt)) return false
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
