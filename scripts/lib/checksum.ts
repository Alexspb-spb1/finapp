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
  }))
  return sha256Hex(canonicalStringify(canonical))
}

/** Checksum over the raw decisions array (order-independent — sorted by
 * companyId,uid,resolution before hashing) — used to prove which decisions
 * file content backed a given run without embedding the file itself. */
export function computeDecisionsChecksum(decisions: readonly { companyId: string; uid: string; resolution: string }[]): string {
  const sorted = [...decisions].sort((a, b) => {
    const ka = `${a.companyId} ${a.uid} ${a.resolution}`
    const kb = `${b.companyId} ${b.uid} ${b.resolution}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return sha256Hex(canonicalStringify(sorted))
}
