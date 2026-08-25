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
// and "Production execution" — this is Step 2/Step 6 of that runbook
// (enable BEFORE backup, disable only AFTER verify).
//
// Audit-fix round, item 1: this file is now a PURE CLI entrypoint — it
// parses argv and calls main() unconditionally at import time (see the
// bottom of this file), which is exactly the behavior that made it unsafe
// to import from a test runner. The actual transaction logic
// (transactionalEnable/transactionalDisable/MaintenanceModeStateError) now
// lives in the side-effect-free ./maintenanceModeTransaction.ts, which
// tests import directly instead of importing this file.
import process from 'node:process'
import { parseMaintenanceModeCliArgs, MaintenanceModeCliArgError } from './maintenanceModeCli.ts'
import { transactionalEnable, transactionalDisable, MaintenanceModeStateError, type MaintenanceTransitionResult } from './maintenanceModeTransaction.ts'
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
