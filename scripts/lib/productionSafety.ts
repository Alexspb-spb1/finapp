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
import { REPORT_SCHEMA_VERSION } from './report.ts'

export class ProductionSafetyError extends Error {}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

// ── Maintenance mode ────────────────────────────────────────────────────

export interface MaintenanceModeStatus {
  verifiedAt: string
  /** Always a real timestamp when this function resolves successfully — see
   * below for why this is now REQUIRED, not merely best-effort. */
  enabledAt: string
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
 * (i.e. following the SEC-005 runbook, e.g. scripts/ops/set-maintenance-mode.ts)
 * can ever set it.
 *
 * **`enabledAt` is now a hard requirement** (final-round fix, item 3):
 * `verifyBackupReference()` below needs a real "maintenance was enabled at
 * time T" anchor to prove a given backup manifest was created AFTER
 * maintenance mode went active — a document missing `enabledAt` cannot
 * support that proof, so it is refused here rather than silently degrading
 * to `null` and skipping the freshness check downstream.
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
  const enabledAtRaw = data.enabledAt
  const enabledAtIso = enabledAtRaw !== null && typeof enabledAtRaw === 'object' && typeof (enabledAtRaw as { toDate?: unknown }).toDate === 'function'
    ? (enabledAtRaw as { toDate: () => Date }).toDate().toISOString()
    : null
  if (enabledAtIso === null) {
    throw new ProductionSafetyError('system/maintenance.enabledAt is missing or not a valid Firestore Timestamp — cannot prove maintenance mode was enabled before the backup was taken.')
  }
  return {
    verifiedAt: new Date().toISOString(),
    enabledAt: enabledAtIso,
    enabledBy: typeof data.enabledBy === 'string' ? data.enabledBy : null,
    taskId: typeof data.taskId === 'string' ? data.taskId : null,
  }
}

// ── Backup reference ────────────────────────────────────────────────────

export interface BackupReference {
  path: string
  sha256: string
  createdAtUtc: string
  membersCount: number
  /** The SOURCE (production export) members checksum — verified equal to
   * `restore.membersChecksum` before this reference is ever returned (see
   * below). Recorded in the safe audit section so a reviewer can confirm
   * which exact members snapshot this backup captured, without exposing
   * any raw document content. */
  membersChecksum: string
}

/** Backup manifests older than this can no longer be used as
 * `--backup-reference` for a production apply — a stale backup does not
 * reflect the state Firestore is actually in right now. 24h is a
 * deliberately conservative bound for a single-apply migration window;
 * documented in MEMBERSHIP_BACKFILL.md alongside the runbook step order. */
export const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Verifies `--backup-reference` points to an existing, readable backup
 * manifest (schema: docs/remediation/reports/BASE-003.md §6.1, extended by
 * SEC-005) showing a SUCCESSFUL, complete, freshly-taken Firestore export
 * for the EXACT project this run targets — not merely a non-empty string
 * or a partially-populated JSON file. Final-round fixes #1 and #3:
 *
 * - `firestore.exportOperationId` must identify which export produced
 *   this manifest.
 * - `firestore.collectionIds` must include `"members"`, or
 *   `firestore.scope === 'full'` — a partial export that omitted the
 *   `members` collection group is refused (independent review fix #1).
 * - Every count (`membersCount`/`companiesCount`/`usersCount`/
 *   `companyDataDocsCount`) must be a non-negative integer.
 * - `restore.verificationResult === 'PASS'`, with `restore.membersCount`
 *   matching `firestore.membersCount` and `restore.membersChecksum`
 *   (a valid SHA-256 hex digest) EXACTLY matching `firestore.membersChecksum`
 *   (also required, also a valid SHA-256 hex digest) — the backup must
 *   have actually been restored to an isolated project and its `members`
 *   collection group reproduced there byte-for-byte (checksum match, not
 *   just a matching count, which could hide a doc-for-doc substitution
 *   with the same total — independent review fix #2, strengthened again
 *   in the second final-preflight round to require the checksum match,
 *   not just its presence).
 * - `createdAtUtc` must be a valid timestamp AT OR AFTER
 *   `maintenanceEnabledAtIso` — a backup taken BEFORE maintenance mode was
 *   enabled cannot be trusted as a write-frozen, consistent snapshot
 *   (final-round fix #1: the runbook now enables maintenance mode before
 *   backup, so this is enforceable, not just documented).
 * - `createdAtUtc` must be no older than `MAX_BACKUP_AGE_MS` relative to
 *   `nowIso` (defaults to real "now") — a stale backup is refused.
 */
export function verifyBackupReference(
  path: string,
  expectedProjectId: string,
  maintenanceEnabledAtIso: string,
  nowIso: string = new Date().toISOString(),
): BackupReference {
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
  if (!isValidIsoTimestamp(manifest.createdAtUtc)) {
    throw new ProductionSafetyError('--backup-reference manifest.createdAtUtc is missing or not a valid timestamp.')
  }
  const createdAtUtc = manifest.createdAtUtc as string

  const firestore = manifest.firestore as Record<string, unknown> | undefined
  if (!firestore || typeof firestore !== 'object') {
    throw new ProductionSafetyError('--backup-reference manifest is missing the firestore section.')
  }
  if (typeof firestore.exportOperationId !== 'string' || firestore.exportOperationId.length === 0) {
    throw new ProductionSafetyError('--backup-reference manifest.firestore.exportOperationId is missing — cannot identify which export produced this backup.')
  }
  if (firestore.exportStatus !== 'SUCCESS') {
    throw new ProductionSafetyError('--backup-reference manifest does not show a SUCCESSFUL Firestore export.')
  }
  const collectionIds = firestore.collectionIds
  const isFullScope = firestore.scope === 'full'
  const hasMembers = Array.isArray(collectionIds) && collectionIds.includes('members')
  if (!isFullScope && !hasMembers) {
    throw new ProductionSafetyError('--backup-reference manifest.firestore.collectionIds does not include "members" and firestore.scope is not "full" — the export did not capture the members collection group (independent review fix #1). Re-run the export with --collection-ids including "members", or use a full export.')
  }
  for (const field of ['membersCount', 'companiesCount', 'usersCount', 'companyDataDocsCount'] as const) {
    if (!isNonNegativeInteger(firestore[field])) {
      throw new ProductionSafetyError(`--backup-reference manifest.firestore.${field} must be a non-negative integer.`)
    }
  }
  const membersCount = firestore.membersCount as number

  const restore = manifest.restore as Record<string, unknown> | undefined
  if (!restore || typeof restore !== 'object') {
    throw new ProductionSafetyError('--backup-reference manifest is missing the restore section — restore verification (counts/checksum for members) was never recorded.')
  }
  if (restore.verificationResult !== 'PASS') {
    throw new ProductionSafetyError('--backup-reference manifest.restore.verificationResult is not "PASS" — this backup was never confirmed by a restore-to-isolated-project cycle.')
  }
  if (!isNonNegativeInteger(restore.membersCount)) {
    throw new ProductionSafetyError('--backup-reference manifest.restore.membersCount must be a non-negative integer.')
  }
  if (restore.membersCount !== membersCount) {
    throw new ProductionSafetyError(`--backup-reference manifest.restore.membersCount (${restore.membersCount}) does not match firestore.membersCount (${membersCount}) — the restore cycle did not confirm the backup's own count.`)
  }
  if (typeof firestore.membersChecksum !== 'string' || !SHA256_HEX_PATTERN.test(firestore.membersChecksum)) {
    throw new ProductionSafetyError('--backup-reference manifest.firestore.membersChecksum is missing or not a valid SHA-256 hex digest — the source (production) members checksum was not recorded at export time.')
  }
  if (typeof restore.membersChecksum !== 'string' || !SHA256_HEX_PATTERN.test(restore.membersChecksum)) {
    throw new ProductionSafetyError('--backup-reference manifest.restore.membersChecksum is missing or not a valid SHA-256 hex digest.')
  }
  if (restore.membersChecksum !== firestore.membersChecksum) {
    throw new ProductionSafetyError('--backup-reference manifest.restore.membersChecksum does not match manifest.firestore.membersChecksum — the restore-to-isolated-project cycle did not reproduce the exact same members data the export claimed, only (at best) a matching count.')
  }
  if (!isValidIsoTimestamp(restore.verifiedAtUtc)) {
    throw new ProductionSafetyError('--backup-reference manifest.restore.verifiedAtUtc is missing or not a valid timestamp.')
  }

  if (Date.parse(createdAtUtc) < Date.parse(maintenanceEnabledAtIso)) {
    throw new ProductionSafetyError('--backup-reference manifest.createdAtUtc predates maintenance mode being enabled — a backup taken before maintenance mode was on cannot be trusted as a consistent, write-frozen snapshot.')
  }

  const ageMs = Date.parse(nowIso) - Date.parse(createdAtUtc)
  if (ageMs < 0) {
    throw new ProductionSafetyError('--backup-reference manifest.createdAtUtc is in the future.')
  }
  if (ageMs > MAX_BACKUP_AGE_MS) {
    throw new ProductionSafetyError(`--backup-reference manifest is too old to use (created ${createdAtUtc}, ${Math.round(ageMs / 3_600_000)}h ago, max ${MAX_BACKUP_AGE_MS / 3_600_000}h) — take a fresh backup.`)
  }

  return { path, sha256: sha256Hex(raw), createdAtUtc, membersCount, membersChecksum: firestore.membersChecksum }
}

// ── Strict dry-run report validation (shared) ───────────────────────────

interface PlannedCreateLike {
  companyId: string
  uid: string
  role: string
  status: string
}

export interface StrictDryRunReport {
  path: string
  sha256: string
  targetChecksum: string
  plannedCreates: readonly PlannedCreateLike[]
}

export interface StrictDryRunReportFields {
  sourceGitSha: string
  sourceChecksum: string
  decisionsChecksum: string
  targetChecksum: string
}

/**
 * Pure content validator — no file I/O — shared by `verifyStrictDryRunReport()`
 * below (the normal path/file-based entry point) and by callers that must
 * read the file THEMSELVES first (to hash the raw bytes against an
 * operator-supplied expected checksum BEFORE parsing — see
 * `scripts/backfill-memberships.ts`'s `runRollbackFromPlan()`), so there is
 * no second, redundant file read and no TOCTOU gap between the hash check
 * and the content this function actually validates.
 *
 * Strictly validates that `raw` is a genuine, fully-resolved dry-run
 * report — schemaVersion, `mode === 'dry-run'`, `environment`/`projectId`
 * matching what this run is targeting, a non-empty `sourceGitSha`, all
 * three checksum fields present as valid SHA-256 hex, `counts.unresolved
 * === 0` (final-round fix #4: a minimal forged/partial JSON — e.g.
 * `{mode: 'dry-run', targetChecksum: '...'}` with nothing else — is
 * rejected outright, not merely "close enough"), and that `plannedCreates`
 * has no duplicate `(companyId, uid)` pair (final-round fix #2: a
 * duplicated pair could otherwise be double-counted or produce ambiguous
 * reconstruction candidates for `rollback-from-plan`).
 */
export function validateStrictDryRunReportContent(raw: string, expectedProjectId: string, expectedEnvironment: string): Omit<StrictDryRunReport, 'path' | 'sha256'> & StrictDryRunReportFields {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ProductionSafetyError('is not valid JSON.')
  }
  const report = parsed as Record<string, unknown>

  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new ProductionSafetyError(`has schemaVersion ${JSON.stringify(report.schemaVersion)}, expected ${REPORT_SCHEMA_VERSION}.`)
  }
  if (report.mode !== 'dry-run') {
    throw new ProductionSafetyError(`must be a dry-run report (mode !== "dry-run", got ${JSON.stringify(report.mode)}).`)
  }
  if (report.environment !== expectedEnvironment) {
    throw new ProductionSafetyError(`environment must be ${JSON.stringify(expectedEnvironment)}, got ${JSON.stringify(report.environment)}.`)
  }
  if (report.projectId !== expectedProjectId) {
    throw new ProductionSafetyError(`projectId does not match --project (${expectedProjectId}).`)
  }
  if (typeof report.sourceGitSha !== 'string' || report.sourceGitSha.length === 0) {
    throw new ProductionSafetyError('is missing sourceGitSha.')
  }
  if (expectedEnvironment === 'production' && report.sourceGitSha === 'unknown') {
    throw new ProductionSafetyError('has sourceGitSha "unknown" — the commit that produced this dry-run cannot be traced, which is not acceptable for a production reference (final-round fix #2).')
  }
  for (const field of ['sourceChecksum', 'decisionsChecksum', 'targetChecksum'] as const) {
    const value = report[field]
    if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
      throw new ProductionSafetyError(`.${field} is missing or not a valid SHA-256 hex digest.`)
    }
  }
  const counts = report.counts as Record<string, unknown> | undefined
  if (!counts || typeof counts.unresolved !== 'number') {
    throw new ProductionSafetyError('is missing counts.unresolved.')
  }
  if (counts.unresolved !== 0) {
    throw new ProductionSafetyError(`counts.unresolved is ${counts.unresolved}, expected 0 — this dry-run plan still has unresolved items and cannot be treated as fully approved.`)
  }
  const plannedCreatesRaw = report.plannedCreates
  if (!Array.isArray(plannedCreatesRaw)) {
    throw new ProductionSafetyError('is missing plannedCreates.')
  }
  const seenPairs = new Set<string>()
  const plannedCreates: PlannedCreateLike[] = plannedCreatesRaw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new ProductionSafetyError(`plannedCreates[${index}] is not an object.`)
    }
    const rec = entry as Record<string, unknown>
    for (const field of ['companyId', 'uid', 'role', 'status'] as const) {
      if (typeof rec[field] !== 'string' || (rec[field] as string).length === 0) {
        throw new ProductionSafetyError(`plannedCreates[${index}].${field} is missing.`)
      }
    }
    const pairKey = JSON.stringify([rec.companyId, rec.uid])
    if (seenPairs.has(pairKey)) {
      throw new ProductionSafetyError(`plannedCreates contains a duplicate (companyId, uid) pair at index ${index} — ambiguous, cannot be trusted.`)
    }
    seenPairs.add(pairKey)
    return { companyId: rec.companyId as string, uid: rec.uid as string, role: rec.role as string, status: rec.status as string }
  })

  return {
    sourceGitSha: report.sourceGitSha,
    sourceChecksum: report.sourceChecksum as string,
    decisionsChecksum: report.decisionsChecksum as string,
    targetChecksum: report.targetChecksum as string,
    plannedCreates,
  }
}

/**
 * File-based entry point — reads `path`, then delegates to
 * `validateStrictDryRunReportContent()` above. See that function's doc
 * comment for the full validation contract.
 */
export function verifyStrictDryRunReport(path: string, expectedProjectId: string, expectedEnvironment: string): StrictDryRunReport {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new ProductionSafetyError(`could not be read: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  const content = validateStrictDryRunReportContent(raw, expectedProjectId, expectedEnvironment)
  return { path, sha256: sha256Hex(raw), targetChecksum: content.targetChecksum, plannedCreates: content.plannedCreates }
}

// ── Rollback plan reference (pre-apply) ─────────────────────────────────

export interface RollbackPlanReference {
  path: string
  sha256: string
  targetChecksum: string
}

/**
 * Verifies `--rollback-reference` points to an existing, readable
 * DRY-RUN report (validated by `verifyStrictDryRunReport()` above) whose
 * `sourceGitSha`, `sourceChecksum`, `decisionsChecksum`, AND
 * `targetChecksum` ALL EXACTLY MATCH the CURRENT run's own values —
 * proving the operator reviewed the exact same planned change set, built
 * from the exact same code, the exact same legacy source data, AND the
 * exact same decisions file this apply is about to use — not merely a
 * dry-run that happens to compute the same final `targetChecksum` by
 * coincidence (final-round fix #2: the previous version of this check
 * compared `targetChecksum` alone).
 *
 * Independent review fix #7 ("circular ROLLBACK_REFERENCE"): the apply
 * report — which is what `rollback-from-report` actually consumes —
 * cannot possibly exist yet at the point `apply` is being authorized, so
 * it can never be the PRE-apply reference. This function verifies a
 * reference that genuinely exists before any write (a prior dry-run's
 * report); the executable rollback artifact (the apply report itself,
 * hashed) is recorded separately, AFTER apply, by the caller.
 */
export function verifyRollbackPlanReference(path: string, current: StrictDryRunReportFields, expectedProjectId: string): RollbackPlanReference {
  if (current.sourceGitSha === 'unknown') {
    throw new ProductionSafetyError('--rollback-reference cannot be verified: this run\'s own sourceGitSha is "unknown" — the commit producing this apply cannot be traced, which is not acceptable for production (final-round fix #2).')
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new ProductionSafetyError(`--rollback-reference could not be read: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  let content: ReturnType<typeof validateStrictDryRunReportContent>
  try {
    content = validateStrictDryRunReportContent(raw, expectedProjectId, 'production')
  } catch (err) {
    if (err instanceof ProductionSafetyError) throw new ProductionSafetyError(`--rollback-reference ${err.message}`)
    throw err
  }

  if (content.sourceGitSha !== current.sourceGitSha) {
    throw new ProductionSafetyError(`--rollback-reference sourceGitSha (${content.sourceGitSha}) does not match this run's own sourceGitSha (${current.sourceGitSha}) — the dry-run was built from different code.`)
  }
  if (content.sourceChecksum !== current.sourceChecksum) {
    throw new ProductionSafetyError('--rollback-reference sourceChecksum does not match this run\'s own sourceChecksum — the legacy source data has changed since that dry-run was taken.')
  }
  if (content.decisionsChecksum !== current.decisionsChecksum) {
    throw new ProductionSafetyError('--rollback-reference decisionsChecksum does not match this run\'s own decisionsChecksum — apply must be run with the SAME --decisions-file that produced this dry-run.')
  }
  if (content.targetChecksum !== current.targetChecksum) {
    throw new ProductionSafetyError('--rollback-reference targetChecksum does not match this run\'s computed target — it does not describe the change this apply is about to make (re-run dry-run and supply its report).')
  }
  return { path, sha256: sha256Hex(raw), targetChecksum: content.targetChecksum }
}

// ── Post-apply rollback artifact ────────────────────────────────────────

/** SHA-256 of a file already written to disk (e.g. this run's own apply
 * report) — used to record a durable, tamper-evident pointer to the
 * artifact `rollback-from-report` will actually consume, in the report's
 * own safe/audit section. */
export function sha256OfFile(path: string): string {
  return sha256Hex(readFileSync(path, 'utf8'))
}
