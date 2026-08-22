// Deterministic checksums for the SEC-005 membership backfill tool.
//
// Requirements (see docs/migrations/MEMBERSHIP_BACKFILL.md): SHA-256, over
// canonical JSON (recursively key-sorted), with a fixed sort order
// (companyId, then uid) so the SAME logical set of relations always
// produces the SAME checksum regardless of Firestore query result order.
// Timestamps are explicitly EXCLUDED from the logical checksum — they are
// server-assigned and not part of "did the intended set of relations get
// created", which is what this checksum is meant to prove.
import { createHash } from 'node:crypto'
import { splitRelationKey, type Decision, type LegacyExtractionResult } from './types.ts'
import { isStrictlyValidActiveMembership } from './membershipValidation.ts'

/** Recursively sorts object keys so two structurally-equal values with
 * different key insertion order serialize identically. Arrays keep their
 * given order — callers must sort arrays explicitly before calling this. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeysDeep(source[key])
    return sorted
  }
  return value
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export interface LogicalRelation {
  companyId: string
  uid: string
  role: string
  status: string
  invitedBy?: string
  /** Independent audit fix #7 (2nd round): whether the document this
   * relation was derived from passed strict canonical-schema validation
   * (see membershipValidation.ts's isStrictlyValidActiveMembership). Target
   * relations (the intended state) are always schema-valid by construction
   * and omit this field (defaults to `true`); OBSERVED relations set it
   * explicitly so a document with matching role/status but a corrupted
   * schema (wrong uid, missing/fake timestamps, extra fields) still
   * produces a checksum that differs from the target's. */
  schemaValid?: boolean
}

/** Sorts by companyId then uid — the ONE fixed order every checksum in this
 * tool uses, independent of the order Firestore happened to return results
 * in for a given run. */
export function sortRelations<T extends { companyId: string; uid: string }>(relations: readonly T[]): T[] {
  return [...relations].sort((a, b) => {
    if (a.companyId !== b.companyId) return a.companyId < b.companyId ? -1 : 1
    if (a.uid !== b.uid) return a.uid < b.uid ? -1 : 1
    return 0
  })
}

/** Checksum over a logical set of membership relations — role/status/invitedBy
 * only, deliberately excluding createdAt/updatedAt (server timestamps,
 * never part of "is this the intended target state"). */
export function computeRelationSetChecksum(relations: readonly LogicalRelation[]): string {
  const canonical = sortRelations(relations).map(r => ({
    companyId: r.companyId,
    uid: r.uid,
    role: r.role,
    status: r.status,
    invitedBy: r.invitedBy ?? null,
    schemaValid: r.schemaValid ?? true,
  }))
  return sha256Hex(canonicalStringify(canonical))
}

/** Deterministic fingerprint over a finding's NORMALIZED evidence only
 * (never identity — callers match `companyId`/`uid`/`findingType`
 * separately) — independent audit fixes, 4th round, item 3.1. Every field
 * that could change the meaning/safety of resolving the finding must be
 * included by the caller in `evidence`; changing any one of them changes
 * the fingerprint and makes any decision recorded against the old
 * fingerprint stale. */
export function computeFindingFingerprint(evidence: Record<string, unknown>): string {
  return sha256Hex(canonicalStringify(evidence))
}

/** Sorts an array of `{ uid, ... }` objects by uid — used for the several
 * finding-record lists below that are keyed by uid alone (no companyId). */
function sortByUid<T extends { uid: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
}

export interface SourceStateInput {
  extraction: LegacyExtractionResult
  /** key = relationKey(companyId, uid); every EXISTING
   * companies/{companyId}/members/{uid} document read this run. */
  existingMemberships: ReadonlyMap<string, Record<string, unknown>>
  allCompanyIds: ReadonlySet<string>
  allUserIds: ReadonlySet<string>
}

/**
 * The FULL, normalized source-state fingerprint — independent audit fixes,
 * 4th round, item 3.2. Deliberately broader than `computeSourceChecksum()`
 * (backfill-memberships.ts), which only ever covered `extraction.confirmed`
 * and therefore could not prove the rest of the migration-relevant source
 * (conflicts, orphans, owner/malformed anomalies, which users/companies
 * exist, existing membership documents) had not changed between two runs.
 *
 * Deterministically covers exactly what task spec 3.2 requires: confirmed
 * relations WITH their source kinds; conflicts with reason + normalized
 * observed-role/invalid-role/source-kind evidence; orphans with normalized
 * source-kind evidence; owner anomalies; unknown users; malformed
 * claims/source anomalies (including the company-scoped `ownerId`
 * anomaly); the SET of company/user IDs that currently exist (not their
 * content — a company's unrelated fields cannot silently change this
 * checksum); and a normalized projection of existing membership documents
 * (companyId, uid, role, status, schema-validity) — never their raw,
 * unrelated Firestore fields, and never printed anywhere (this function
 * only ever returns a hex digest).
 */
export function computeFullSourceStateChecksum(input: SourceStateInput): string {
  const { extraction, existingMemberships, allCompanyIds, allUserIds } = input

  const confirmed = sortRelations(extraction.confirmed).map(r => ({
    companyId: r.companyId, uid: r.uid, role: r.role, sources: [...r.sources].sort(),
  }))
  const conflicts = sortRelations(extraction.conflicts).map(c => ({
    companyId: c.companyId, uid: c.uid, reason: c.reason, evidenceFingerprint: c.evidenceFingerprint,
  }))
  const orphans = sortRelations(extraction.orphans).map(o => ({
    companyId: o.companyId, uid: o.uid, reason: o.reason, evidenceFingerprint: o.evidenceFingerprint,
  }))
  const ownerAnomalies = sortRelations(extraction.ownerAnomalies).map(a => ({
    companyId: a.companyId, uid: a.uid, reason: a.reason, evidenceFingerprint: a.evidenceFingerprint,
  }))
  const unknownUsers = sortByUid(extraction.unknownUsers).map(u => ({
    uid: u.uid, reason: u.reason, evidenceFingerprint: u.evidenceFingerprint,
  }))
  const malformedClaims = sortByUid(extraction.malformedClaims).map(m => ({
    uid: m.uid, reason: m.reason, evidenceFingerprint: m.evidenceFingerprint,
  }))
  const ownerIdAnomalies = [...extraction.ownerIdAnomalies]
    .sort((a, b) => (a.companyId < b.companyId ? -1 : a.companyId > b.companyId ? 1 : 0))
    .map(o => ({ companyId: o.companyId, reason: o.reason, evidenceFingerprint: o.evidenceFingerprint }))

  const companyIds = Array.from(allCompanyIds).sort()
  const userIds = Array.from(allUserIds).sort()

  const existingMembershipsNormalized = Array.from(existingMemberships.entries())
    .map(([key, data]) => {
      const [companyId, uid] = splitRelationKey(key)
      return {
        companyId,
        uid,
        role: typeof data.role === 'string' ? data.role : null,
        status: typeof data.status === 'string' ? data.status : null,
        schemaValid: isStrictlyValidActiveMembership(uid, data),
      }
    })
    .sort((a, b) => (a.companyId !== b.companyId ? (a.companyId < b.companyId ? -1 : 1) : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))

  return sha256Hex(canonicalStringify({
    confirmed, conflicts, orphans, ownerAnomalies, unknownUsers, malformedClaims, ownerIdAnomalies,
    companyIds, userIds, existingMemberships: existingMembershipsNormalized,
  }))
}

/** Checksum over the FULL normalized decision — independent audit fix #5
 * (2nd round): every field that can change the meaning of a decision
 * (`uid`, `companyId`, `resolution`, `role`, `reason`, `reviewedBy`,
 * `reviewedAt`) is included explicitly; changing ANY one of them changes
 * the checksum. Sorting is by the canonical JSON representation of each
 * normalized decision itself (not a partial composite key), so it is fully
 * deterministic and order-independent even when many decisions share the
 * same (companyId, uid, resolution) — which cannot happen for a valid
 * decisions file (duplicates are rejected), but the checksum must not rely
 * on that invariant to stay well-defined. */
export function computeDecisionsChecksum(decisions: readonly Decision[]): string {
  const canonical = decisions.map(d => ({
    uid: d.uid,
    companyId: d.companyId ?? null,
    findingType: d.findingType,
    evidenceFingerprint: d.evidenceFingerprint,
    resolution: d.resolution,
    role: d.role ?? null,
    reason: d.reason,
    reviewedBy: d.reviewedBy,
    reviewedAt: d.reviewedAt,
  }))
  const sorted = canonical
    .map(c => canonicalStringify(c))
    .sort()
    .map(s => JSON.parse(s) as unknown)
  return sha256Hex(canonicalStringify(sorted))
}
