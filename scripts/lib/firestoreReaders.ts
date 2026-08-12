// Firestore read helpers for scripts/backfill-memberships.ts — SEC-005.
// Thin wrappers around the Admin SDK so the orchestration logic in the
// entry point stays readable; all DOMAIN logic (extraction/planning) lives
// in the pure modules and is tested without these.
import type { Firestore } from 'firebase-admin/firestore'
import { relationKey, splitRelationKey, type RawUserDoc, type RawCompanyDoc } from './types.ts'

export async function readAllUsers(db: Firestore): Promise<RawUserDoc[]> {
  const snap = await db.collection('users').get()
  return snap.docs.map(doc => ({ docId: doc.id, data: doc.data() }))
}

export async function readAllCompanies(db: Firestore): Promise<RawCompanyDoc[]> {
  const snap = await db.collection('companies').get()
  return snap.docs.map(doc => ({ docId: doc.id, data: doc.data() }))
}

/** All existing companies/{companyId}/members/{uid} documents, across every
 * company, via a single collectionGroup query (no composite index required
 * for an unfiltered read). */
export async function readAllExistingMemberships(db: Firestore): Promise<Map<string, Record<string, unknown>>> {
  const snap = await db.collectionGroup('members').get()
  const result = new Map<string, Record<string, unknown>>()
  for (const doc of snap.docs) {
    const companyId = doc.ref.parent.parent?.id
    if (!companyId) continue // defensive: a 'members' collection not nested under companies/{id} is not this app's data
    result.set(relationKey(companyId, doc.id), doc.data())
  }
  return result
}

/** companyId -> set of uids with a schema-valid, active, admin membership —
 * used only for the last-admin-per-company projection, never as a source of
 * candidate relations. */
export function computeExistingActiveAdmins(existingMemberships: ReadonlyMap<string, Record<string, unknown>>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const entry of existingMemberships) {
    const key = entry[0]
    const data = entry[1]
    const parts = splitRelationKey(key)
    const companyId = parts[0]
    const uid = parts[1]
    if (data.uid !== uid) continue
    if (data.role !== 'admin') continue
    if (data.status !== 'active') continue
    if (!result.has(companyId)) result.set(companyId, new Set())
    result.get(companyId)!.add(uid)
  }
  return result
}
