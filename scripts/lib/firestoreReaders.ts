// Firestore read helpers for scripts/backfill-memberships.ts — SEC-005.
// Thin wrappers around the Admin SDK so the orchestration logic in the
// entry point stays readable; all DOMAIN logic (extraction/planning) lives
// in the pure modules and is tested without these.
import type { Firestore } from 'firebase-admin/firestore'
import { relationKey, splitRelationKey, type RawUserDoc, type RawCompanyDoc } from './types.ts'
import { isStrictlyValidActiveMembership } from './membershipValidation.ts'

export async function readAllUsers(db: Firestore): Promise<RawUserDoc[]> {
  const snap = await db.collection('users').get()
  return snap.docs.map(doc => ({ docId: doc.id, data: doc.data() }))
}

export async function readAllCompanies(db: Firestore): Promise<RawCompanyDoc[]> {
  const snap = await db.collection('companies').get()
  return snap.docs.map(doc => ({ docId: doc.id, data: doc.data() }))
}

/** All existing companies/{companyId}/members/{uid} documents. Independent
 * audit fix #7: uses collectionGroup('members') only as a broad candidate
 * scan, then STRICTLY validates each result's full document path is
 * exactly 4 segments `companies/{companyId}/members/{uid}` — a foreign
 * `members` subcollection anywhere else in Firestore (e.g. nested deeper,
 * or under a different top-level collection) is discarded and can never
 * influence planning, checksums, or the admin gate. */
export async function readAllExistingMemberships(db: Firestore): Promise<Map<string, Record<string, unknown>>> {
  const snap = await db.collectionGroup('members').get()
  const result = new Map<string, Record<string, unknown>>()
  for (const doc of snap.docs) {
    const segments = doc.ref.path.split('/')
    if (segments.length !== 4 || segments[0] !== 'companies' || segments[2] !== 'members') continue
    const companyId = segments[1]!
    const uid = segments[3]!
    if (uid !== doc.id) continue // defensive — should be unreachable, path segment IS doc.id
    result.set(relationKey(companyId, uid), doc.data())
  }
  return result
}

/** companyId -> set of uids with a STRICTLY schema-valid, active, admin
 * membership — used only for the last-admin-per-company projection, never
 * as a source of candidate relations. Independent audit fix #1: reuses the
 * same strict validator as candidate reconciliation, so a corrupted
 * document (extra fields, unknown role, non-active status, malformed
 * timestamps, uid mismatch) can never count as a protecting admin. */
export function computeExistingActiveAdmins(existingMemberships: ReadonlyMap<string, Record<string, unknown>>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const entry of existingMemberships) {
    const key = entry[0]
    const data = entry[1]
    const [companyId, uid] = splitRelationKey(key)
    if (!isStrictlyValidActiveMembership(uid, data)) continue
    if (data.role !== 'admin') continue
    if (!result.has(companyId)) result.set(companyId, new Set())
    result.get(companyId)!.add(uid)
  }
  return result
}
