#!/usr/bin/env node
// SEC-005 production preflight, final round, item 8 — a REAL, testable
// operator script for enabling/disabling maintenance mode
// (system/maintenance), reusing the SAME environment/project/cycle-
// execution guards as scripts/backfill-memberships.ts.
//
// Production execution gate round: `maintenance-enable`/`maintenance-disable`
// are now explicit, typed actions passed to assertCycleExecutionAllowed()
// (see scripts/lib/firebaseAdmin.ts) — production is authorized for both
// under the PRODUCTION_ACTION_APPROVED: SEC-005 grant covering the full
// controlled cycle. This script does not, and structurally cannot, widen
// that grant itself — it only ever asks the gate whether the SPECIFIC
// action it is about to attempt is authorized, exactly like
// backfill-memberships.ts does for its own modes.
//
// Hardened for production admission (this round): every write to
// system/maintenance happens inside a Firestore transaction (atomic
// read-modify-write — a concurrent modification aborts and retries rather
// than silently racing); `--enable` refuses (does not overwrite) an
// already-enabled record, so a second accidental `--enable` can never
// reset `enabledAt` or discard the existing reason/taskId/enabledBy audit
// trail; `--disable` refuses to touch a maintenance record belonging to a
// DIFFERENT `--task-id` than the one supplied, and disabling an
// already-disabled SEC-005 record is a safe, idempotent no-op. For
// `--environment production`, `--task-id` must be exactly `SEC-005` — the
// only task currently granted a production maintenance-mode authorization.
//
// See docs/migrations/MEMBERSHIP_BACKFILL.md, "Maintenance/read-only mode"
// and "Future production execution" — this is Step 2/Step 6 of that
// runbook (create maintenance doc / enable BEFORE backup, disable only
// AFTER verify).
import process from 'node:process'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { parseMaintenanceModeCliArgs, MaintenanceModeCliArgError } from './maintenanceModeCli.ts'
import { assertEnvironmentGuard, assertCycleExecutionAllowed, initFirestore, EnvironmentGuardError, CycleExecutionError } from '../lib/firebaseAdmin.ts'

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
 * disable another task's maintenance window, even accidentally. Disabling
 * a record that does not exist, or one that already has `enabled ===
 * false` (and the SAME taskId), is a safe, idempotent no-op — `changed:
 * false` with a `noopReason`, never an error. Also a single Firestore
 * transaction, for the same concurrent-modification safety as
 * `transactionalEnable()`.
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

async function main(): Promise<number> {
  let opts
  try {
    opts = parseMaintenanceModeCliArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof MaintenanceModeCliArgError) { console.error(`Argument error: ${err.message}`); return 2 }
    throw err
  }

  let expectedProjectId: string
  try {
    expectedProjectId = assertEnvironmentGuard({
      environment: opts.environment,
      cliProjectId: opts.project,
      envProjectId: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT,
      firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
      confirmProjectId: opts.confirmProject,
    })
  } catch (err) {
    if (err instanceof EnvironmentGuardError) { console.error(`Environment guard: ${err.message}`); return 3 }
    throw err
  }

  // The SAME cycle-execution gate scripts/backfill-memberships.ts uses —
  // deliberately reused, not reimplemented, so there is exactly ONE place
  // in this codebase that decides whether a given (environment, action)
  // pair is authorized this cycle. Checked BEFORE initFirestore() (any
  // credential acquisition) and BEFORE any Firestore I/O, same as every
  // other cycle-execution check in this tool.
  try {
    assertCycleExecutionAllowed(opts.environment, opts.action === 'enable' ? 'maintenance-enable' : 'maintenance-disable')
  } catch (err) {
    if (err instanceof CycleExecutionError) { console.error(`Refusing to run against --environment ${opts.environment}: ${err.message}`); return 4 }
    throw err
  }

  const db = initFirestore(expectedProjectId)

  let result: MaintenanceTransitionResult
  try {
    result = opts.action === 'enable'
      ? await transactionalEnable(db, { reason: opts.reason!, taskId: opts.taskId!, operator: opts.operator! })
      : await transactionalDisable(db, { taskId: opts.taskId!, operator: opts.operator! })
  } catch (err) {
    if (err instanceof MaintenanceModeStateError) { console.error(`Maintenance mode: ${err.message}`); return 1 }
    throw err
  }

  console.log(JSON.stringify({
    action: opts.action,
    environment: opts.environment,
    projectId: expectedProjectId,
    enabled: opts.action === 'enable',
    changed: result.changed,
    ...(result.noopReason ? { noopReason: result.noopReason } : {}),
  }, null, 2))
  return 0
}

main().then(code => { process.exitCode = code }).catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
