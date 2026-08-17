// Firestore write orchestration for apply mode — SEC-005, independent
// audit fix #2 (3rd round).
//
// Extracted into its own module, separate from the CLI entry point, so
// "create succeeded, subsequent read/read-back failed" is directly
// testable against a minimal fake Firestore stub — no real emulator
// required — and so backfill-memberships.ts stays a thin orchestrator.
import type { Firestore } from 'firebase-admin/firestore'
import type { PlannedCreate } from './types.ts'
import type { CreatedPathRecord, WriteFailureRecord } from './report.ts'
import { readAllExistingMemberships } from './firestoreReaders.ts'
import { computeObservedState, type TargetRelation, type ObservedState } from './observedState.ts'

export interface ApplyWritesResult {
  createdPaths: CreatedPathRecord[]
  writeFailures: WriteFailureRecord[]
}

/**
 * Creates every planned relation as a create-only write.
 *
 * Independent audit fix #2 (3rd round): the previous implementation called
 * `ref.create()` and then `ref.get()` inside the SAME try/catch — a
 * successful create followed by a failed metadata read was recorded as a
 * write FAILURE and dropped from `createdPaths`/`rollbackManifest`
 * entirely, even though the document genuinely existed in Firestore from
 * that point on (an operator using that report to reconcile or roll back
 * would never even know it was there).
 *
 * This version determines success SOLELY from `DocumentReference.create()`'s
 * own `WriteResult` — there is no follow-up `get()` call in this function
 * at all, so there is no "read that could fail and erase a known-successful
 * create" here. `writeResult.writeTime` IS the document's create AND
 * update time for a freshly created document (Firestore assigns both to
 * the same commit timestamp on creation) — so it is both accurate and
 * unconditionally durable: nothing that happens after a successful
 * `create()` call can cause that document's `createdPaths` entry to be
 * lost.
 */
export async function createPlannedRelations(
  db: Firestore,
  plannedCreates: readonly PlannedCreate[],
): Promise<ApplyWritesResult> {
  const createdPaths: CreatedPathRecord[] = []
  const writeFailures: WriteFailureRecord[] = []

  for (const create of plannedCreates) {
    const ref = db.collection('companies').doc(create.companyId).collection('members').doc(create.uid)
    try {
      const now = new Date()
      const writeResult = await ref.create({
        uid: create.uid,
        role: create.role,
        status: create.status,
        createdAt: now,
        updatedAt: now,
        ...(create.invitedBy ? { invitedBy: create.invitedBy } : {}),
      })
      const writeTimeIso = writeResult.writeTime.toDate().toISOString()
      createdPaths.push({
        companyId: create.companyId,
        uid: create.uid,
        path: ref.path,
        createTimeIso: writeTimeIso,
        updateTimeIso: writeTimeIso,
      })
    } catch (err) {
      writeFailures.push({ companyId: create.companyId, uid: create.uid, error: err instanceof Error ? err.message : 'unknown error' })
    }
  }

  return { createdPaths, writeFailures }
}

export type ReadBackResult =
  | ({ ok: true } & ObservedState)
  | { ok: false; error: string }

/**
 * Reads back current Firestore state and computes the observed
 * checksum/missing/differing state — wrapped so a failure DURING the
 * read-back itself (a transient Firestore error, a dropped connection) is
 * reported as an explicit `{ ok: false }` result instead of an uncaught
 * rejection. Without this wrapper, such a failure would propagate past
 * `main()`'s only try/catch (the top-level one at the bottom of
 * backfill-memberships.ts) and the process would exit WITHOUT ever calling
 * `writeReport()` — losing the entire report, including the
 * `createdPaths`/`rollbackManifest` entries for documents that were
 * already durably created via `createPlannedRelations()` above. With this
 * wrapper, the caller can still write a report (reporting the read-back
 * failure honestly, with a non-zero exit) that preserves everything known
 * to be true so far.
 */
export async function readBackObservedState(
  db: Firestore,
  targetRelations: readonly TargetRelation[],
): Promise<ReadBackResult> {
  let readBack: Map<string, Record<string, unknown>>
  try {
    readBack = await readAllExistingMemberships(db)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' }
  }
  const observed = computeObservedState(targetRelations, readBack)
  return { ok: true, ...observed }
}
