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
import { isKnownRole, COMPATIBLE_RESOLUTIONS, type FindingType, type DecisionResolution } from './types.ts'

export class ProductionSafetyError extends Error {}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function isNonEmptyStringValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSha256HexValue(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value)
}

// ── Resolved-findings audit trail — deep validation ─────────────────────
//
// Independent audit fixes, 5th round (2nd follow-up review of the round's
// own fix): the previous version of this validation only checked that
// `finding`/`decision` were present, non-array objects — it never checked
// their CONTENT, so `{finding: {}, decision: {}}` passed as a "resolved"
// finding, and a report could claim `missingCompanies: 1,
// unresolvedMissingCompanies: 0` while `resolvedOrphans: []` (the orphan
// simply vanished — neither unresolved nor accounted for as resolved).
// Fixed by (1) validating `finding`'s shape against the specific record
// type each field carries, (2) validating `decision`'s shape against
// `Decision`, (3) cross-checking that `decision` is genuinely THE decision
// that resolved THIS `finding` — identity (uid/companyId),
// `findingType === finding.reason`, `evidenceFingerprint` equality, and
// resolution/finding-type compatibility (`COMPATIBLE_RESOLUTIONS`) — and
// (4) reconciling `counts.missingCompanies`/`missingUsers` (discovered
// totals) against `counts.unresolvedMissingCompanies`/`unresolvedMissingUsers`
// PLUS the matching subset of `resolvedOrphans` (the only finding type
// with an explicit discovered-total count field — see report.ts's
// `ReportCounts` doc comments; conflicts/ownerAnomalies/unknownUsers/
// malformedClaims only ever expose an unresolved-only count, so there is
// no discovered total to reconcile for those).
const CONFLICT_REASONS = ['role_mismatch', 'invalid_role', 'mixed_role_validity', 'user_id_mismatch', 'owner_role_not_admin', 'existing_membership_conflict'] as const
const ORPHAN_REASONS = ['missing_company', 'missing_user'] as const
const OWNER_ANOMALY_REASONS = ['owner_without_admin_membership'] as const
const UNKNOWN_USER_REASONS = ['no_usable_relations'] as const
const MALFORMED_CLAIM_REASONS = ['malformed_companies_entry', 'companies_field_not_array', 'malformed_company_id'] as const
const DECISION_RESOLUTIONS: readonly DecisionResolution[] = ['confirm_role', 'accept_existing', 'exclude']

interface ResolvedFieldSpec {
  field: 'resolvedConflicts' | 'resolvedOrphans' | 'resolvedOwnerAnomalies' | 'resolvedUnknownUsers' | 'resolvedMalformedClaims'
  requiresCompanyId: boolean
  allowedReasons: readonly string[]
}

const RESOLVED_FIELD_SPECS: readonly ResolvedFieldSpec[] = [
  { field: 'resolvedConflicts', requiresCompanyId: true, allowedReasons: CONFLICT_REASONS },
  { field: 'resolvedOrphans', requiresCompanyId: true, allowedReasons: ORPHAN_REASONS },
  { field: 'resolvedOwnerAnomalies', requiresCompanyId: true, allowedReasons: OWNER_ANOMALY_REASONS },
  { field: 'resolvedUnknownUsers', requiresCompanyId: false, allowedReasons: UNKNOWN_USER_REASONS },
  { field: 'resolvedMalformedClaims', requiresCompanyId: false, allowedReasons: MALFORMED_CLAIM_REASONS },
]

function validateResolvedFindingRecord(field: string, index: number, finding: Record<string, unknown>, spec: ResolvedFieldSpec): void {
  if (!isNonEmptyStringValue(finding.uid)) {
    throw new ProductionSafetyError(`${field}[${index}].finding.uid is missing.`)
  }
  if (spec.requiresCompanyId) {
    if (!isNonEmptyStringValue(finding.companyId)) {
      throw new ProductionSafetyError(`${field}[${index}].finding.companyId is missing.`)
    }
  } else if (finding.companyId !== undefined) {
    throw new ProductionSafetyError(`${field}[${index}].finding.companyId must be absent — this finding type is user-level (no company target).`)
  }
  if (typeof finding.reason !== 'string' || !spec.allowedReasons.includes(finding.reason)) {
    throw new ProductionSafetyError(`${field}[${index}].finding.reason is missing or not a valid reason for ${field} (expected one of: ${spec.allowedReasons.join(', ')}).`)
  }
  if (!isSha256HexValue(finding.evidenceFingerprint)) {
    throw new ProductionSafetyError(`${field}[${index}].finding.evidenceFingerprint is missing or not a valid SHA-256 hex digest.`)
  }
}

function validateResolvingDecisionRecord(field: string, index: number, decision: Record<string, unknown>, finding: Record<string, unknown>): void {
  if (!isNonEmptyStringValue(decision.uid)) {
    throw new ProductionSafetyError(`${field}[${index}].decision.uid is missing.`)
  }
  if (decision.companyId !== undefined && !isNonEmptyStringValue(decision.companyId)) {
    throw new ProductionSafetyError(`${field}[${index}].decision.companyId is present but not a non-empty string.`)
  }
  if (typeof decision.findingType !== 'string' || decision.findingType.length === 0) {
    throw new ProductionSafetyError(`${field}[${index}].decision.findingType is missing.`)
  }
  if (!isSha256HexValue(decision.evidenceFingerprint)) {
    throw new ProductionSafetyError(`${field}[${index}].decision.evidenceFingerprint is missing or not a valid SHA-256 hex digest.`)
  }
  if (typeof decision.resolution !== 'string' || !DECISION_RESOLUTIONS.includes(decision.resolution as DecisionResolution)) {
    throw new ProductionSafetyError(`${field}[${index}].decision.resolution is missing or not a known resolution.`)
  }
  if (!isNonEmptyStringValue(decision.reason)) {
    throw new ProductionSafetyError(`${field}[${index}].decision.reason is missing.`)
  }
  if (!isNonEmptyStringValue(decision.reviewedBy)) {
    throw new ProductionSafetyError(`${field}[${index}].decision.reviewedBy is missing.`)
  }
  if (!isValidIsoTimestamp(decision.reviewedAt)) {
    throw new ProductionSafetyError(`${field}[${index}].decision.reviewedAt is missing or not a valid timestamp.`)
  }
  if (decision.resolution === 'confirm_role' && !isKnownRole(decision.role)) {
    throw new ProductionSafetyError(`${field}[${index}].decision.role is required and must be a known role when resolution is confirm_role.`)
  }

  // Cross-checks: `decision` must genuinely be THE decision that resolved
  // THIS `finding` — matching every field the real finding-bound-decision
  // contract (decisions.ts / planner.ts) itself requires, not merely two
  // independently-valid-looking objects placed next to each other.
  if (decision.findingType !== finding.reason) {
    throw new ProductionSafetyError(`${field}[${index}]: decision.findingType (${JSON.stringify(decision.findingType)}) does not match finding.reason (${JSON.stringify(finding.reason)}).`)
  }
  if (decision.evidenceFingerprint !== finding.evidenceFingerprint) {
    throw new ProductionSafetyError(`${field}[${index}]: decision.evidenceFingerprint does not match finding.evidenceFingerprint.`)
  }
  if (decision.uid !== finding.uid) {
    throw new ProductionSafetyError(`${field}[${index}]: decision.uid does not match finding.uid.`)
  }
  if (finding.companyId !== undefined) {
    if (decision.companyId !== finding.companyId) {
      throw new ProductionSafetyError(`${field}[${index}]: decision.companyId does not match finding.companyId.`)
    }
  } else if (decision.companyId !== undefined) {
    throw new ProductionSafetyError(`${field}[${index}]: decision.companyId must be absent — the finding it resolves is user-level.`)
  }
  const compatibleResolutions = COMPATIBLE_RESOLUTIONS[finding.reason as FindingType] ?? []
  if (!compatibleResolutions.includes(decision.resolution as DecisionResolution)) {
    throw new ProductionSafetyError(`${field}[${index}]: decision.resolution (${JSON.stringify(decision.resolution)}) is not compatible with finding.reason (${JSON.stringify(finding.reason)}).`)
  }
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
  // Final-round fix #4 (third pass): a restore cannot have been verified
  // before the backup it restores was even created, and it cannot have
  // been verified in the future relative to right now — either would mean
  // the timestamps are fabricated/inconsistent, not merely "unusual".
  if (Date.parse(restore.verifiedAtUtc as string) < Date.parse(createdAtUtc)) {
    throw new ProductionSafetyError('--backup-reference manifest.restore.verifiedAtUtc predates manifest.createdAtUtc — the restore cannot have been verified before the backup it restores was even created.')
  }
  if (Date.parse(restore.verifiedAtUtc as string) > Date.parse(nowIso)) {
    throw new ProductionSafetyError('--backup-reference manifest.restore.verifiedAtUtc is in the future relative to now.')
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
  /** Independent audit fixes, 5th round, item 1: the full source-state
   * fingerprint (`computeFullSourceStateChecksum()`, checksum.ts) — broader
   * than `sourceChecksum` (which only ever covers `extraction.confirmed`).
   * Now REQUIRED and compared for a `--rollback-reference`, closing the gap
   * where a production `apply` accepted a report whose confirmed-relations
   * checksum matched but whose conflicts/orphans/anomalies/existing-membership
   * state had silently changed. */
  sourceStateChecksum: string
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
  for (const field of ['sourceChecksum', 'sourceStateChecksum', 'decisionsChecksum', 'targetChecksum'] as const) {
    const value = report[field]
    if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
      throw new ProductionSafetyError(`.${field} is missing or not a valid SHA-256 hex digest.`)
    }
  }
  // Independent audit fixes, 4th round, item 3.6: every count in the report
  // must be a non-negative integer (a negative or fractional count can
  // never legitimately arise from this tool and signals a hand-edited or
  // corrupted report), and `counts.plannedCreates` must equal the actual
  // length of the `plannedCreates` array below — a mismatch means the
  // counts and the array disagree about what this plan actually contains.
  const counts = report.counts as Record<string, unknown> | undefined
  if (!counts || typeof counts !== 'object') {
    throw new ProductionSafetyError('is missing counts.')
  }
  for (const field of [
    'usersRead', 'companiesRead', 'existingMembershipsRead', 'candidateRelations', 'confirmedRelations',
    'plannedCreates', 'created', 'skipped', 'conflicts', 'missingCompanies', 'missingUsers',
    'unresolvedMissingCompanies', 'unresolvedMissingUsers',
    'ownerWithoutAdminMembership', 'unknownUsers', 'malformedClaims', 'danglingMemberships',
    'ownerIdAnomalies', 'staleDecisions', 'unusedDecisions', 'unresolved',
  ] as const) {
    if (!isNonNegativeInteger(counts[field])) {
      throw new ProductionSafetyError(`counts.${field} must be a non-negative integer.`)
    }
  }
  if (counts.unresolved !== 0) {
    throw new ProductionSafetyError(`counts.unresolved is ${counts.unresolved}, expected 0 — this dry-run plan still has unresolved items and cannot be treated as fully approved.`)
  }
  // Independent audit fixes, 5th round, item 3: `missingCompanies`/
  // `missingUsers` are DISCOVERED totals (every orphan found, including
  // ones a decision already excluded) — they legitimately stay nonzero
  // even when `unresolved === 0`. The consistency check below must sum
  // only the genuinely UNRESOLVED-only counts:
  // `unresolvedMissingCompanies`/`unresolvedMissingUsers` (post-decision),
  // never the discovered totals — the 4th-round version of this check
  // wrongly summed the discovered totals and rejected a perfectly valid
  // "1 missing_company, correctly excluded, unresolved: 0" report.
  const unresolvedComponents = ['conflicts', 'unresolvedMissingCompanies', 'unresolvedMissingUsers', 'ownerWithoutAdminMembership', 'unknownUsers', 'malformedClaims', 'danglingMemberships', 'ownerIdAnomalies', 'staleDecisions', 'unusedDecisions'] as const
  const unresolvedSum = unresolvedComponents.reduce((sum, field) => sum + (counts[field] as number), 0)
  if (unresolvedSum !== 0) {
    throw new ProductionSafetyError(`counts.unresolved is 0 but the sum of its component counts (${unresolvedComponents.join(', ')}) is ${unresolvedSum} — internally inconsistent, refusing.`)
  }
  // Independent audit fixes, 5th round (review of the 5th round's own
  // fix), item 3, DEEPENED by a 2nd follow-up review: schemaVersion is
  // checked above to be EXACTLY REPORT_SCHEMA_VERSION (3), but the
  // previous version of this check only verified `finding`/`decision`
  // were present, non-array objects — never their actual content. A
  // report could claim `missingCompanies: 1, unresolvedMissingCompanies: 0`
  // while `resolvedOrphans: []` (the orphan simply vanished, unaccounted
  // for either way), or supply `resolvedOrphans: [{finding: {}, decision:
  // {}}]` (structurally present, semantically empty). See
  // `validateResolvedFindingRecord()`/`validateResolvingDecisionRecord()`
  // above for the full per-field/cross-field contract now enforced: each
  // `finding` validated against its record type's real shape, each
  // `decision` validated against `Decision`'s real shape, and —
  // decisively — `decision` cross-checked to be genuinely THE decision
  // that resolved THIS `finding` (matching identity, `findingType ===
  // finding.reason`, `evidenceFingerprint`, and resolution/finding-type
  // compatibility via `COMPATIBLE_RESOLUTIONS`).
  const resolvedFindingsByField: Record<ResolvedFieldSpec['field'], { finding: Record<string, unknown>; decision: Record<string, unknown> }[]> =
    { resolvedConflicts: [], resolvedOrphans: [], resolvedOwnerAnomalies: [], resolvedUnknownUsers: [], resolvedMalformedClaims: [] }
  for (const spec of RESOLVED_FIELD_SPECS) {
    const value = report[spec.field]
    if (!Array.isArray(value)) {
      throw new ProductionSafetyError(`is missing ${spec.field} (required by schema v${REPORT_SCHEMA_VERSION}'s resolved-findings audit trail).`)
    }
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ProductionSafetyError(`${spec.field}[${index}] is not an object.`)
      }
      const rec = entry as Record<string, unknown>
      if (!rec.finding || typeof rec.finding !== 'object' || Array.isArray(rec.finding)) {
        throw new ProductionSafetyError(`${spec.field}[${index}].finding is missing.`)
      }
      if (!rec.decision || typeof rec.decision !== 'object' || Array.isArray(rec.decision)) {
        throw new ProductionSafetyError(`${spec.field}[${index}].decision is missing.`)
      }
      const finding = rec.finding as Record<string, unknown>
      const decision = rec.decision as Record<string, unknown>
      validateResolvedFindingRecord(spec.field, index, finding, spec)
      validateResolvingDecisionRecord(spec.field, index, decision, finding)
      resolvedFindingsByField[spec.field].push({ finding, decision })
    })
  }
  // Discovered/unresolved/resolved reconciliation — orphans are the only
  // finding type with an explicit discovered-total count field
  // (`missingCompanies`/`missingUsers`; conflicts/ownerAnomalies/
  // unknownUsers/malformedClaims only ever expose an unresolved-only
  // count — see report.ts's `ReportCounts` doc comments — so there is no
  // discovered total to reconcile those against).
  const resolvedMissingCompanies = resolvedFindingsByField.resolvedOrphans.filter(r => r.finding.reason === 'missing_company').length
  const resolvedMissingUsers = resolvedFindingsByField.resolvedOrphans.filter(r => r.finding.reason === 'missing_user').length
  if (counts.missingCompanies !== (counts.unresolvedMissingCompanies as number) + resolvedMissingCompanies) {
    throw new ProductionSafetyError(`counts.missingCompanies (${counts.missingCompanies}) does not equal unresolvedMissingCompanies (${counts.unresolvedMissingCompanies}) + resolved missing_company orphans in resolvedOrphans (${resolvedMissingCompanies}) — discovered/unresolved/resolved orphan counts are internally inconsistent.`)
  }
  if (counts.missingUsers !== (counts.unresolvedMissingUsers as number) + resolvedMissingUsers) {
    throw new ProductionSafetyError(`counts.missingUsers (${counts.missingUsers}) does not equal unresolvedMissingUsers (${counts.unresolvedMissingUsers}) + resolved missing_user orphans in resolvedOrphans (${resolvedMissingUsers}) — discovered/unresolved/resolved orphan counts are internally inconsistent.`)
  }
  const plannedCreatesRaw = report.plannedCreates
  if (!Array.isArray(plannedCreatesRaw)) {
    throw new ProductionSafetyError('is missing plannedCreates.')
  }
  if (plannedCreatesRaw.length !== counts.plannedCreates) {
    throw new ProductionSafetyError(`counts.plannedCreates (${counts.plannedCreates}) does not match the actual length of plannedCreates (${plannedCreatesRaw.length}).`)
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
    // Independent audit fixes, 4th round, item 3.6: "роли принимаются
    // только из KNOWN_ROLES" / "status для создаваемых membership — только
    // active" — the v1 validator only checked these were non-empty
    // strings, accepting any arbitrary role/status value.
    if (!isKnownRole(rec.role)) {
      throw new ProductionSafetyError(`plannedCreates[${index}].role is not a known role.`)
    }
    if (rec.status !== 'active') {
      throw new ProductionSafetyError(`plannedCreates[${index}].status must be "active".`)
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
    sourceStateChecksum: report.sourceStateChecksum as string,
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

/** Deterministic, order-independent structural equality of two
 * `plannedCreates` sets — independent audit fixes, 4th round, item 3.6:
 * "`plannedCreates` должны совпадать с текущим планом точно и
 * детерминированно, а не только через четыре checksum-поля". A checksum
 * match already implies this (same underlying canonical serialization),
 * but a DIRECT structural comparison is asserted independently, so a future
 * change to how the checksum is computed can never silently weaken this
 * specific guarantee. */
function plannedCreatesExactlyMatch(a: readonly PlannedCreateLike[], b: readonly PlannedCreateLike[]): boolean {
  if (a.length !== b.length) return false
  const canonicalize = (list: readonly PlannedCreateLike[]) =>
    [...list]
      .map(p => JSON.stringify({ companyId: p.companyId, uid: p.uid, role: p.role, status: p.status }))
      .sort()
  const canonA = canonicalize(a)
  const canonB = canonicalize(b)
  return canonA.every((v, i) => v === canonB[i])
}

export interface VerifiedRollbackPlanFile {
  path: string
  sha256: string
  content: Omit<StrictDryRunReport, 'path' | 'sha256'> & StrictDryRunReportFields
}

/**
 * PHASE A — independent audit fixes, 5th round, item 2. Reads
 * `--rollback-reference`, verifies its raw bytes against
 * `--expected-plan-sha256`, and structurally validates its content
 * (`validateStrictDryRunReportContent()`) — and NOTHING ELSE. Deliberately
 * takes NO `Firestore`/`db` parameter and performs NO comparison against
 * "the current run" — it is structurally impossible for this function to
 * touch Firestore, which is the strongest available proof that a
 * tampered/wrong plan produces zero credential acquisition and zero
 * Firestore I/O, not merely a claim in a comment.
 *
 * The 4th round's `verifyRollbackPlanReference()` did this same hash+
 * structural-validation work, but ONLY as the first few lines of a single
 * function that the caller invoked AFTER `initFirestore()` and AFTER
 * reading `users`/`companies`/`companies/{companyId}/members` — so in practice the
 * hash check ran well after real Firestore I/O had already happened for
 * `apply`. The caller (`scripts/backfill-memberships.ts`) now calls THIS
 * function BEFORE `initFirestore()` for a production `apply`; the
 * comparison against the current run's own computed values happens
 * separately, in `matchRollbackPlanAgainstCurrent()` below, AFTER the plan
 * is computed.
 */
export function verifyRollbackPlanFileIntegrity(
  path: string,
  expectedPlanSha256: string,
  expectedProjectId: string,
): VerifiedRollbackPlanFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new ProductionSafetyError(`--rollback-reference could not be read: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  // Independent audit fixes, 4th/5th round: the SHA-256 the operator
  // independently saved for this plan (`--expected-plan-sha256`) is checked
  // against the RAW BYTES of `--rollback-reference` BEFORE any JSON
  // parsing — and, as of the 5th round, this whole function runs BEFORE
  // credential acquisition or Firestore I/O for a production `apply`. A
  // tampered or swapped plan produces zero reads and zero writes.
  const actualPlanSha256 = sha256Hex(raw)
  if (actualPlanSha256 !== expectedPlanSha256) {
    throw new ProductionSafetyError(`--rollback-reference content does not match --expected-plan-sha256 (expected ${expectedPlanSha256}, got ${actualPlanSha256}) — the plan may have been tampered with, corrupted, or is the wrong file.`)
  }

  let content: ReturnType<typeof validateStrictDryRunReportContent>
  try {
    content = validateStrictDryRunReportContent(raw, expectedProjectId, 'production')
  } catch (err) {
    if (err instanceof ProductionSafetyError) throw new ProductionSafetyError(`--rollback-reference ${err.message}`)
    throw err
  }

  return { path, sha256: actualPlanSha256, content }
}

export interface ProductionApplyPreflightOpts {
  ackMaintenance: boolean
  backupReference: string | undefined
  rollbackReference: string | undefined
  expectedPlanSha256: string | undefined
}

export interface ProductionApplyPreflightDeps<TDb> {
  /** Phase A above — real caller passes `verifyRollbackPlanFileIntegrity`
   * itself; a test passes a spy/fake to observe call count and arguments. */
  verifyPlanFile: (path: string, expectedPlanSha256: string, expectedProjectId: string) => VerifiedRollbackPlanFile
  /** Stands in for credential acquisition + Firestore client construction
   * (`initFirestore()` in `scripts/backfill-memberships.ts`). Invoked ONLY
   * after `verifyPlanFile` succeeds — never before, never on a throw. */
  acquireFirestore: () => TDb
}

/**
 * Independent audit fixes, 5th round (review of the 5th round's own fix) —
 * the "additional" finding: a wrong `--expected-plan-sha256` producing zero
 * credential acquisition / Firestore I/O was previously provable only by
 * reading `backfill-memberships.ts`'s source text (a textual `indexOf()`
 * ordering check) plus `verifyRollbackPlanFileIntegrity()`'s own lack of a
 * `db` parameter. Neither is an EXECUTABLE proof that the real orchestration
 * — flag presence checks, then plan-file verification, and ONLY THEN
 * credential acquisition — actually holds.
 *
 * This function IS the exact preflight `scripts/backfill-memberships.ts`'s
 * `main()` runs for a production `apply` (main() calls this, not a parallel
 * reimplementation of its body) — so a test that injects a counting fake
 * for `deps.acquireFirestore` and gives it a wrong plan hash, and observes
 * the fake was called zero times, is testing REAL behavior, not asserting
 * that JS `throw` skips subsequent statements (see
 * `scripts/lib/productionSafety.test.ts`, "runProductionApplyPreflight").
 */
export function runProductionApplyPreflight<TDb>(
  opts: ProductionApplyPreflightOpts,
  expectedProjectId: string,
  deps: ProductionApplyPreflightDeps<TDb>,
): { verified: VerifiedRollbackPlanFile; db: TDb } {
  if (!opts.ackMaintenance) throw new ProductionSafetyError('--ack-maintenance-readonly is required for a production apply.')
  if (!opts.backupReference) throw new ProductionSafetyError('--backup-reference is required for a production apply.')
  if (!opts.rollbackReference) throw new ProductionSafetyError('--rollback-reference is required for a production apply.')
  if (!opts.expectedPlanSha256) throw new ProductionSafetyError('--expected-plan-sha256 is required for a production apply (verified against --rollback-reference before any parsing, credential acquisition, or Firestore I/O).')
  const verified = deps.verifyPlanFile(opts.rollbackReference, opts.expectedPlanSha256, expectedProjectId)
  const db = deps.acquireFirestore()
  return { verified, db }
}

/**
 * PHASE B — pure, no I/O of any kind (not even file reads — `verified` was
 * already produced by Phase A above). Compares an ALREADY-verified plan
 * file's content against the CURRENT run's own computed values:
 * `sourceGitSha`, `sourceChecksum`, `sourceStateChecksum` (independent
 * audit fixes, 5th round, item 1 — the full source-state fingerprint, not
 * only the confirmed-relations-only `sourceChecksum`), `decisionsChecksum`,
 * `targetChecksum`, ALL must match exactly, AND `plannedCreates` must match
 * via direct structural comparison (4th round, item 3.6) — proving the
 * operator reviewed the exact same planned change set, built from the
 * exact same code, the exact same legacy source AND existing-Firestore
 * state, and the exact same decisions file this apply is about to use.
 *
 * Independent review fix #7 ("circular ROLLBACK_REFERENCE"): the apply
 * report — which is what `rollback-from-report` actually consumes —
 * cannot possibly exist yet at the point `apply` is being authorized, so
 * it can never be the PRE-apply reference. This function verifies a
 * reference that genuinely exists before any write (a prior dry-run's
 * report); the executable rollback artifact (the apply report itself,
 * hashed) is recorded separately, AFTER apply, by the caller.
 */
export function matchRollbackPlanAgainstCurrent(
  verified: VerifiedRollbackPlanFile,
  current: StrictDryRunReportFields & { plannedCreates: readonly PlannedCreateLike[] },
): RollbackPlanReference {
  if (current.sourceGitSha === 'unknown') {
    throw new ProductionSafetyError('--rollback-reference cannot be verified: this run\'s own sourceGitSha is "unknown" — the commit producing this apply cannot be traced, which is not acceptable for production (final-round fix #2).')
  }
  const content = verified.content

  if (content.sourceGitSha !== current.sourceGitSha) {
    throw new ProductionSafetyError(`--rollback-reference sourceGitSha (${content.sourceGitSha}) does not match this run's own sourceGitSha (${current.sourceGitSha}) — the dry-run was built from different code.`)
  }
  if (content.sourceChecksum !== current.sourceChecksum) {
    throw new ProductionSafetyError('--rollback-reference sourceChecksum does not match this run\'s own sourceChecksum — the legacy source data has changed since that dry-run was taken.')
  }
  // Independent audit fixes, 5th round, item 1: the BROADER source-state
  // checksum must also match — closes the gap where `sourceChecksum`
  // (confirmed relations only) matched but conflicts/orphans/anomalies/
  // existing-membership state had silently changed since the reference
  // dry-run.
  if (content.sourceStateChecksum !== current.sourceStateChecksum) {
    throw new ProductionSafetyError('--rollback-reference sourceStateChecksum does not match this run\'s own sourceStateChecksum — migration-relevant Firestore state (conflicts/orphans/anomalies/existing memberships) has changed since that dry-run was taken.')
  }
  if (content.decisionsChecksum !== current.decisionsChecksum) {
    throw new ProductionSafetyError('--rollback-reference decisionsChecksum does not match this run\'s own decisionsChecksum — apply must be run with the SAME --decisions-file that produced this dry-run.')
  }
  if (content.targetChecksum !== current.targetChecksum) {
    throw new ProductionSafetyError('--rollback-reference targetChecksum does not match this run\'s computed target — it does not describe the change this apply is about to make (re-run dry-run and supply its report).')
  }
  // Independent audit fixes, 4th round, item 3.6: direct structural
  // comparison, not merely reliance on targetChecksum having matched above.
  if (!plannedCreatesExactlyMatch(content.plannedCreates, current.plannedCreates)) {
    throw new ProductionSafetyError('--rollback-reference plannedCreates does not exactly match this run\'s own planned creates — refusing despite matching checksums.')
  }
  return { path: verified.path, sha256: verified.sha256, targetChecksum: content.targetChecksum }
}

// ── Post-apply rollback artifact ────────────────────────────────────────

/** SHA-256 of a file already written to disk (e.g. this run's own apply
 * report) — used to record a durable, tamper-evident pointer to the
 * artifact `rollback-from-report` will actually consume, in the report's
 * own safe/audit section. */
export function sha256OfFile(path: string): string {
  return sha256Hex(readFileSync(path, 'utf8'))
}
