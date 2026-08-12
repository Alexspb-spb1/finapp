// Classifies an EXISTING companies/{companyId}/members/{uid} document
// against a candidate backfill relation — SEC-005.
//
// Deliberately duck-types Firestore Timestamps (checks for numeric
// seconds/nanoseconds) instead of importing firebase-admin/firestore, so
// this module (and its tests) never need a real Admin SDK instance or the
// emulator — a plain object shaped like a Timestamp is enough to exercise
// every branch.
import { isKnownRole, type Role } from './types.ts'

export type ExistingMembershipClassification = 'not_found' | 'exact_match' | 'differs_or_invalid'

const ALLOWED_KEYS = new Set(['uid', 'role', 'status', 'createdAt', 'updatedAt', 'invitedBy'])

function isTimestampLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  if (typeof rec.toDate === 'function') return true
  return typeof rec.seconds === 'number' && typeof rec.nanoseconds === 'number'
}

/**
 * `existingData` is `undefined` when no document exists at that path.
 * A candidate backfill relation is always `status: 'active'` (rule 10 — the
 * backfill never creates anything else), so ANY other existing status is
 * `differs_or_invalid`, never a match.
 */
export function classifyExistingMembership(candidateRole: Role, uid: string, existingData: Record<string, unknown> | undefined): ExistingMembershipClassification {
  if (existingData === undefined) return 'not_found'

  const keys = Object.keys(existingData)
  if (keys.some(k => !ALLOWED_KEYS.has(k))) return 'differs_or_invalid'
  if (existingData.uid !== uid) return 'differs_or_invalid'
  if (!isKnownRole(existingData.role)) return 'differs_or_invalid'
  if (existingData.role !== candidateRole) return 'differs_or_invalid'
  if (existingData.status !== 'active') return 'differs_or_invalid'
  if (!isTimestampLike(existingData.createdAt)) return 'differs_or_invalid'
  if (!isTimestampLike(existingData.updatedAt)) return 'differs_or_invalid'
  if (existingData.invitedBy !== undefined && (typeof existingData.invitedBy !== 'string' || existingData.invitedBy.length === 0)) return 'differs_or_invalid'

  return 'exact_match'
}
