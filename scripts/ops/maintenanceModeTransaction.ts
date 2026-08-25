// Import-safe module for scripts/ops/set-maintenance-mode.ts's
// system/maintenance state-machine transitions — SEC-005 production
// execution gate audit-fix round, item 1.
//
// This module has NO side effects at import time: no `main()` call, no
// process.argv reading, no process.exitCode assignment. It exists
// specifically so tests (and any future caller) can import
// transactionalEnable()/transactionalDisable() directly without dragging in
// set-maintenance-mode.ts's CLI entrypoint, which unconditionally parses
// argv and calls process.exit-equivalent logic on import — importing THAT
// module from a test runner (whose own process.argv is the test runner's,
// not a valid maintenance-mode invocation) previously printed an "Argument
// error" and set process.exitCode = 2 as a side effect of the import alone.
import { FieldValue, type Firestore } from 'firebase-admin/firestore'

export class MaintenanceModeStateError extends Error {}

export interface MaintenanceTransitionResult {
  changed: boolean
  /** Human-readable, safe-to-log reason a no-op transition was still
   * successful (idempotent disable, nothing to disable) — never set for
   * `changed: true`, which is self-explanatory. */
  noopReason?: string
}

/**
 * `--enable`: allowed only when `system/maintenance` does not exist yet, or
 * exists with `enabled === false` (verifiably, strictly disabled — not
 * merely "not `true`", so a malformed/corrupted existing document is
 * refused rather than silently overwritten). Runs as a single Firestore
 * transaction — a concurrent writer changing the document between the
 * read and this write aborts the transaction (Firestore retries it
 * automatically against the new state), so two concurrent `--enable`
 * calls can never both believe they "won" against a stale read.
 */
export async function transactionalEnable(
  db: Firestore,
  opts: { reason: string; taskId: string; operator: string },
): Promise<MaintenanceTransitionResult> {
  const ref = db.collection('system').doc('maintenance')
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (snap.exists) {
      const data = snap.data()!
      if (data.enabled !== false) {
        throw new MaintenanceModeStateError('system/maintenance is already enabled (or in an unverifiable state) — refusing to overwrite, which would reset enabledAt and discard the existing reason/taskId/enabledBy audit trail. Disable it first if you intend to start a new maintenance window.')
      }
    }
    // Full overwrite (not merge) — a fresh --enable must never inherit
    // stale reason/taskId/enabledBy fields from a previous maintenance
    // cycle on the same document.
    tx.set(ref, {
      enabled: true,
      enabledAt: FieldValue.serverTimestamp(),
      enabledBy: opts.operator,
      reason: opts.reason,
      taskId: opts.taskId,
    })
    return { changed: true }
  })
}

/**
 * `--disable`: allowed only against a maintenance record whose own
 * `taskId` field exactly matches `opts.taskId` — a caller can never
 * disable another task's maintenance window, even accidentally.
 *
 * After the taskId check, exactly two `enabled` states are meaningful:
 * `enabled === true` (disable it) or `enabled === false` (already
 * disabled — idempotent no-op). Any other value for `enabled` — missing
 * entirely, `null`, a string, a number, an object — is NOT treated as
 * "assume enabled" or "assume disabled"; it is an unverifiable state and
 * is refused outright (`MaintenanceModeStateError`, document untouched),
 * the same fail-closed posture `transactionalEnable()` already takes for
 * a non-boolean-false `enabled` on an existing document.
 *
 * Disabling a record that does not exist at all is a separate, safe,
 * idempotent no-op (`changed: false`) — there is no document to be in an
 * unverifiable state, so there is nothing to fail closed against.
 *
 * Also a single Firestore transaction, for the same concurrent-
 * modification safety as `transactionalEnable()`.
 */
export async function transactionalDisable(
  db: Firestore,
  opts: { taskId: string; operator: string },
): Promise<MaintenanceTransitionResult> {
  const ref = db.collection('system').doc('maintenance')
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) {
      return { changed: false, noopReason: 'system/maintenance does not exist — nothing to disable.' }
    }
    const data = snap.data()!
    if (data.taskId !== opts.taskId) {
      throw new MaintenanceModeStateError(`system/maintenance belongs to a different task than ${JSON.stringify(opts.taskId)} — refusing to disable another task's maintenance record.`)
    }
    if (data.enabled === false) {
      return { changed: false, noopReason: `system/maintenance is already disabled for task ${opts.taskId} — idempotent no-op.` }
    }
    if (data.enabled !== true) {
      throw new MaintenanceModeStateError(`system/maintenance has an unverifiable "enabled" field (${JSON.stringify(data.enabled)}) — neither strictly true nor strictly false — refusing to disable a record whose current state cannot be confirmed.`)
    }
    // merge:true deliberately PRESERVES the historical enabledAt/enabledBy/
    // reason/taskId fields for audit — only `enabled` flips, plus a
    // disabledAt/disabledBy pair is added.
    tx.set(ref, {
      enabled: false,
      disabledAt: FieldValue.serverTimestamp(),
      disabledBy: opts.operator,
    }, { merge: true })
    return { changed: true }
  })
}
