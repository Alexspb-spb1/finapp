// SEC-005 production preflight — REAL, verified preconditions for a
// production WRITE operation (apply / rollback-from-report).
//
// Deliberately separate from firebaseAdmin.ts's assertCycleExecutionAllowed(),
// which still unconditionally refuses 'production' regardless of anything
// in this module — none of this has any effect while that block remains
// in place (independent review requirement: "Production-gate пока оставить
// безусловно закрытым"). This module exists so the mechanism is fully
// built, unit-tested, and ready for the day a genuine
// PRODUCTION_ACTION_APPROVED grant removes that unconditional block.
//
// Every check here replaces an "honor system" flag (a CLI flag that was
// only ever checked for non-empty-string presence) with something that is
// actually read back and verified — per the independent review finding
// that "принять окно риска" (accepting the risk window) is not an
// acceptable design for this tool.
import { readFileSync } from 'node:fs'
import type { Firestore } from 'firebase-admin/firestore'
import { sha256Hex } from './checksum.ts'

export class ProductionSafetyError extends Error {}

// ── Maintenance mode ────────────────────────────────────────────────────

export interface MaintenanceModeStatus {
  verifiedAt: string
  enabledAt: string | null
  enabledBy: string | null
  taskId: string | null
}

/**
 * Reads `system/maintenance` via the SAME Firestore client used for the
 * migration itself and refuses (fail-closed — including on any read
 * error, exactly like functions/src/lib/authz.ts's
 * requireActiveMember()/requireNotInMaintenanceMode()) unless
 * `enabled === true`. This is a REAL, live check against the actual
 * database state at the moment of the call — not a CLI flag the operator
 * merely asserts. `system/maintenance` is never client-writable
 * (firestore.rules has no `allow write` rule for it — falls through to
 * the deny-by-default catch-all), so only an operator using the Admin SDK
 * (i.e. following the SEC-005 runbook) can ever set it.
 */
export async function assertMaintenanceModeActive(db: Firestore): Promise<MaintenanceModeStatus> {
  let snap
  try {
    snap = await db.collection('system').doc('maintenance').get()
  } catch (err) {
    throw new ProductionSafetyError(`Could not read system/maintenance — refusing (fail-closed): ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  if (!snap.exists) {
    throw new ProductionSafetyError('system/maintenance does not exist — maintenance mode has not been enabled.')
  }
  const data = snap.data()!
  if (data.enabled !== true) {
    throw new ProductionSafetyError('system/maintenance.enabled is not true — maintenance mode is not active.')
  }
  const enabledAt = data.enabledAt
  return {
    verifiedAt: new Date().toISOString(),
    enabledAt: enabledAt !== null && typeof enabledAt === 'object' && typeof (enabledAt as { toDate?: unknown }).toDate === 'function'
      ? (enabledAt as { toDate: () => Date }).toDate().toISOString()
      : null,
    enabledBy: typeof data.enabledBy === 'string' ? data.enabledBy : null,
    taskId: typeof data.taskId === 'string' ? data.taskId : null,
  }
}

// ── Backup reference ────────────────────────────────────────────────────

export interface BackupReference {
  path: string
  sha256: string
  createdAtUtc: string
}

/**
 * Verifies `--backup-reference` points to an existing, readable backup
 * manifest (schema: docs/remediation/reports/BASE-003.md §6.1) showing a
 * SUCCESSFUL Firestore export for the EXACT project this run targets —
 * not merely a non-empty string. Independent review fix #1: the manifest
 * itself must show `members` was included in the export's
 * `--collection-ids` (or that a full/unscoped export was used) — this
 * function checks the manifest's `firestore.membersCount` field is
 * present (a manifest produced by the corrected backup procedure always
 * sets it; an old-style manifest that never captured `members` at all
 * will be missing it and is refused here).
 */
export function verifyBackupReference(path: string, expectedProjectId: string): BackupReference {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new ProductionSafetyError(`--backup-reference could not be read: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ProductionSafetyError('--backup-reference is not valid JSON.')
  }
  const manifest = parsed as Record<string, unknown>
  if (manifest.productionProjectId !== expectedProjectId) {
    throw new ProductionSafetyError(`--backup-reference manifest.productionProjectId does not match --project (${expectedProjectId}).`)
  }
  const firestore = manifest.firestore as Record<string, unknown> | undefined
  if (!firestore || firestore.exportStatus !== 'SUCCESS') {
    throw new ProductionSafetyError('--backup-reference manifest does not show a SUCCESSFUL Firestore export.')
  }
  if (typeof firestore.membersCount !== 'number') {
    throw new ProductionSafetyError('--backup-reference manifest is missing firestore.membersCount — the backup export did not include the members collection group (independent review fix #1). Re-run the export with --collection-ids including "members", or a full export.')
  }
  if (typeof manifest.createdAtUtc !== 'string') {
    throw new ProductionSafetyError('--backup-reference manifest is missing createdAtUtc.')
  }
  return { path, sha256: sha256Hex(raw), createdAtUtc: manifest.createdAtUtc }
}

// ── Rollback plan reference (pre-apply) ─────────────────────────────────

export interface RollbackPlanReference {
  path: string
  sha256: string
  targetChecksum: string
}

/**
 * Verifies `--rollback-reference` points to an existing, readable
 * DRY-RUN report whose OWN `targetChecksum` matches the CURRENT run's
 * computed target — proving the operator reviewed the exact same planned
 * change set this apply is about to attempt, not a stale or unrelated
 * dry-run.
 *
 * Independent review fix #7 ("circular ROLLBACK_REFERENCE"): the apply
 * report — which is what `rollback-from-report` actually consumes —
 * cannot possibly exist yet at the point `apply` is being authorized, so
 * it can never be the PRE-apply reference. This function verifies a
 * reference that genuinely exists before any write (a prior dry-run's
 * report); the executable rollback artifact (the apply report itself,
 * hashed) is recorded separately, AFTER apply, by the caller.
 */
export function verifyRollbackPlanReference(path: string, expectedTargetChecksum: string): RollbackPlanReference {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new ProductionSafetyError(`--rollback-reference could not be read: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ProductionSafetyError('--rollback-reference is not valid JSON.')
  }
  const report = parsed as Record<string, unknown>
  if (report.mode !== 'dry-run') {
    throw new ProductionSafetyError(`--rollback-reference must point to a dry-run report (mode !== "dry-run", got ${JSON.stringify(report.mode)}).`)
  }
  if (typeof report.targetChecksum !== 'string' || report.targetChecksum !== expectedTargetChecksum) {
    throw new ProductionSafetyError('--rollback-reference targetChecksum does not match this run\'s computed target — it does not describe the change this apply is about to make (re-run dry-run and supply its report).')
  }
  return { path, sha256: sha256Hex(raw), targetChecksum: report.targetChecksum }
}

// ── Post-apply rollback artifact ────────────────────────────────────────

/** SHA-256 of a file already written to disk (e.g. this run's own apply
 * report) — used to record a durable, tamper-evident pointer to the
 * artifact `rollback-from-report` will actually consume, in the report's
 * own safe/audit section. */
export function sha256OfFile(path: string): string {
  return sha256Hex(readFileSync(path, 'utf8'))
}
