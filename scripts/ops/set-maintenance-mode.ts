#!/usr/bin/env node
// SEC-005 production preflight, final round, item 8 — a REAL, testable
// operator script for enabling/disabling maintenance mode
// (system/maintenance), reusing the SAME environment/project/cycle-
// execution guards as scripts/backfill-memberships.ts.
//
// Production remains UNCONDITIONALLY refused via
// assertCycleExecutionAllowed() — this script does not, and structurally
// cannot, weaken that gate; it exists so the maintenance-mode mechanism
// itself is real, exercised by tests, and ready for the day a genuine
// PRODUCTION_ACTION_APPROVED grant removes that block. Until then this
// only actually writes against --environment emulator|staging.
//
// See docs/migrations/MEMBERSHIP_BACKFILL.md, "Maintenance/read-only mode"
// and "Future production execution" — this is Step 2/Step 6 of that
// runbook (create maintenance doc / enable BEFORE backup, disable only
// AFTER verify).
import process from 'node:process'
import { FieldValue } from 'firebase-admin/firestore'
import { parseMaintenanceModeCliArgs, MaintenanceModeCliArgError } from './maintenanceModeCli.ts'
import { assertEnvironmentGuard, assertCycleExecutionAllowed, initFirestore, EnvironmentGuardError, CycleExecutionError } from '../lib/firebaseAdmin.ts'

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

  // Same unconditional production refusal as the main migration tool —
  // deliberately reused, not reimplemented, so there is exactly ONE place
  // in this codebase that decides whether production is authorized this
  // cycle.
  try {
    assertCycleExecutionAllowed(opts.environment)
  } catch (err) {
    if (err instanceof CycleExecutionError) { console.error(`Refusing to run against --environment ${opts.environment}: ${err.message}`); return 4 }
    throw err
  }

  const db = initFirestore(expectedProjectId)
  const ref = db.collection('system').doc('maintenance')

  if (opts.action === 'enable') {
    // Full overwrite (not merge) — a fresh --enable must never inherit
    // stale reason/taskId/enabledBy fields from a previous maintenance
    // cycle on the same document.
    await ref.set({
      enabled: true,
      enabledAt: FieldValue.serverTimestamp(),
      enabledBy: opts.operator,
      reason: opts.reason,
      taskId: opts.taskId,
    })
  } else {
    // merge:true deliberately PRESERVES the historical enabledAt/enabledBy/
    // reason/taskId fields for audit — only `enabled` flips, plus a
    // disabledAt/disabledBy pair is added.
    await ref.set({
      enabled: false,
      disabledAt: FieldValue.serverTimestamp(),
      disabledBy: opts.operator,
    }, { merge: true })
  }

  console.log(JSON.stringify({ action: opts.action, environment: opts.environment, projectId: expectedProjectId, enabled: opts.action === 'enable' }, null, 2))
  return 0
}

main().then(code => { process.exitCode = code }).catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
