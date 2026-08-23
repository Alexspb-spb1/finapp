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
import { isKnownRole, type Decision, type RelationSourceKind } from './types.ts'
import { validateDecisions } from './decisions.ts'

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

// ── Report findings — deep validation ────────────────────────────────────
//
// Independent audit fixes, 5th round, 2nd follow-up review (this pass): the
// previous version of this validation had three gaps, all confirmed by
// independent negative tests:
//   1. The report's UNRESOLVED finding arrays (`conflicts`/`orphans`/
//      `ownerAnomalies`/`unknownUsers`/`malformedClaims`/`danglingMemberships`/
//      `ownerIdAnomalies`/`staleDecisions`/`unusedDecisions`) were never
//      required or validated at all — a report entirely missing them still
//      passed.
//   2. `resolvedOrphans`' `finding` was only checked for the fields common
//      to every finding type (uid/companyId/reason/evidenceFingerprint) —
//      `OrphanRecord`'s own required fields (`sourceKinds`/`observedRoles`/
//      `hasInvalidRole`/`proposedRole`) were never checked, so an orphan
//      missing all four still passed.
//   3. `decision` objects were checked field-by-field by hand here,
//      independently of `decisions.ts`'s `validateDecisions()` — drifting
//      from the real contract (never rejected unknown fields; never
//      forbade `role` when `resolution !== 'confirm_role'`).
//
// Fixed by: (a) a dedicated shape validator per record type, applied
// uniformly to BOTH the unresolved arrays and each resolved-findings
// array's `finding` (the shape is identical either way — only the
// resolved case additionally pairs it with a `decision`); (b) reusing
// `validateDecisions()` (decisions.ts) for `decision` validation instead
// of a parallel reimplementation, so the two can never drift; (c)
// reconciling every unresolved array's length against its corresponding
// `counts` field, and `resolvedOrphans` against the discovered/unresolved
// orphan counts (the only finding type with an explicit discovered-total
// count field).
const RELATION_SOURCE_KINDS: readonly RelationSourceKind[] = ['users.home', 'users.companies[]', 'companies.ownerId']
const CONFLICT_REASONS = ['role_mismatch', 'invalid_role', 'mixed_role_validity', 'user_id_mismatch', 'owner_role_not_admin', 'existing_membership_conflict'] as const
const ORPHAN_REASONS = ['missing_company', 'missing_user'] as const
const OWNER_ANOMALY_REASONS = ['owner_without_admin_membership'] as const
const UNKNOWN_USER_REASONS = ['no_usable_relations'] as const
const MALFORMED_CLAIM_REASONS = ['malformed_companies_entry', 'companies_field_not_array', 'malformed_company_id'] as const
const DANGLING_MEMBERSHIP_REASONS = ['existing_membership_missing_company', 'existing_membership_missing_user'] as const
const OWNER_ID_ANOMALY_REASONS = ['malformed_owner_id'] as const

function assertOnlyKnownKeys(field: string, index: number, rec: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(rec).filter(k => !allowed.includes(k))
  if (unknown.length > 0) {
    throw new ProductionSafetyError(`${field}[${index}] has unknown field(s): ${unknown.sort().join(', ')}.`)
  }
}
function assertNonEmptyStringField(field: string, index: number, rec: Record<string, unknown>, key: string): void {
  if (!isNonEmptyStringValue(rec[key])) throw new ProductionSafetyError(`${field}[${index}].${key} is missing.`)
}
function assertReasonOneOf(field: string, index: number, rec: Record<string, unknown>, allowed: readonly string[]): void {
  if (typeof rec.reason !== 'string' || !allowed.includes(rec.reason)) {
    throw new ProductionSafetyError(`${field}[${index}].reason is missing or not one of: ${allowed.join(', ')}.`)
  }
}
function assertSha256HexField(field: string, index: number, rec: Record<string, unknown>, key: string): void {
  if (!isSha256HexValue(rec[key])) throw new ProductionSafetyError(`${field}[${index}].${key} is missing or not a valid SHA-256 hex digest.`)
}
function assertBooleanField(field: string, index: number, rec: Record<string, unknown>, key: string): void {
  if (typeof rec[key] !== 'boolean') throw new ProductionSafetyError(`${field}[${index}].${key} must be a boolean.`)
}
function assertRoleArrayField(field: string, index: number, rec: Record<string, unknown>, key: string): void {
  const value = rec[key]
  if (!Array.isArray(value) || !value.every(isKnownRole)) {
    throw new ProductionSafetyError(`${field}[${index}].${key} must be an array of known roles.`)
  }
}
function assertSourceKindArrayField(field: string, index: number, rec: Record<string, unknown>, key: string): void {
  const value = rec[key]
  if (!Array.isArray(value) || !value.every(v => RELATION_SOURCE_KINDS.includes(v as RelationSourceKind))) {
    throw new ProductionSafetyError(`${field}[${index}].${key} must be an array of known source kinds.`)
  }
}
function assertRoleOrNullField(field: string, index: number, rec: Record<string, unknown>, key: string): void {
  const value = rec[key]
  if (value !== null && !isKnownRole(value)) {
    throw new ProductionSafetyError(`${field}[${index}].${key} must be a known role or null.`)
  }
}

const CONFLICT_ALLOWED_KEYS = ['companyId', 'uid', 'reason', 'observedRoles', 'hasInvalidRole', 'sourceKinds', 'evidenceFingerprint']
function validateConflictRecordShape(field: string, index: number, rec: Record<string, unknown>): void {
  assertOnlyKnownKeys(field, index, rec, CONFLICT_ALLOWED_KEYS)
  assertNonEmptyStringField(field, index, rec, 'companyId')
  assertNonEmptyStringField(field, index, rec, 'uid')
  assertReasonOneOf(field, index, rec, CONFLICT_REASONS)
  assertSha256HexField(field, index, rec, 'evidenceFingerprint')
  if (rec.observedRoles !== undefined) assertRoleArrayField(field, index, rec, 'observedRoles')
  if (rec.hasInvalidRole !== undefined) assertBooleanField(field, index, rec, 'hasInvalidRole')
  if (rec.sourceKinds !== undefined) assertSourceKindArrayField(field, index, rec, 'sourceKinds')
}

const ORPHAN_ALLOWED_KEYS = ['companyId', 'uid', 'reason', 'sourceKinds', 'observedRoles', 'hasInvalidRole', 'proposedRole', 'evidenceFingerprint']
function validateOrphanRecordShape(field: string, index: number, rec: Record<string, unknown>): void {
  assertOnlyKnownKeys(field, index, rec, ORPHAN_ALLOWED_KEYS)
  assertNonEmptyStringField(field, index, rec, 'companyId')
  assertNonEmptyStringField(field, index, rec, 'uid')
  assertReasonOneOf(field, index, rec, ORPHAN_REASONS)
  assertSourceKindArrayField(field, index, rec, 'sourceKinds')
  assertRoleArrayField(field, index, rec, 'observedRoles')
  assertBooleanField(field, index, rec, 'hasInvalidRole')
  assertRoleOrNullField(field, index, rec, 'proposedRole')
  assertSha256HexField(field, index, rec, 'evidenceFingerprint')
  // Derived-consistency: `proposedRole` is set if-and-only-if `observedRoles`
  // has exactly one entry AND `hasInvalidRole` is false — see
  // `OrphanRecord`'s own doc comment (types.ts).
  const observedRoles = rec.observedRoles as string[]
  const hasInvalidRole = rec.hasInvalidRole as boolean
  const expectedProposedRole = observedRoles.length === 1 && !hasInvalidRole ? observedRoles[0]! : null
  if (rec.proposedRole !== expectedProposedRole) {
    throw new ProductionSafetyError(`${field}[${index}].proposedRole (${JSON.stringify(rec.proposedRole)}) is inconsistent with observedRoles/hasInvalidRole (expected ${JSON.stringify(expectedProposedRole)}).`)
  }
}

const OWNER_ANOMALY_ALLOWED_KEYS = ['companyId', 'uid', 'reason', 'evidenceFingerprint']
function validateOwnerAnomalyRecordShape(field: string, index: number, rec: Record<string, unknown>): void {
  assertOnlyKnownKeys(field, index, rec, OWNER_ANOMALY_ALLOWED_KEYS)
  assertNonEmptyStringField(field, index, rec, 'companyId')
  assertNonEmptyStringField(field, index, rec, 'uid')
  assertReasonOneOf(field, index, rec, OWNER_ANOMALY_REASONS)
  assertSha256HexField(field, index, rec, 'evidenceFingerprint')
}

const UNKNOWN_USER_ALLOWED_KEYS = ['uid', 'reason', 'evidenceFingerprint']
function validateUnknownUserRecordShape(field: string, index: number, rec: Record<string, unknown>): void {
  assertOnlyKnownKeys(field, index, rec, UNKNOWN_USER_ALLOWED_KEYS)
  assertNonEmptyStringField(field, index, rec, 'uid')
  assertReasonOneOf(field, index, rec, UNKNOWN_USER_REASONS)
  assertSha256HexField(field, index, rec, 'evidenceFingerprint')
}

const MALFORMED_CLAIM_ALLOWED_KEYS = ['uid', 'reason', 'evidenceFingerprint']
function validateMalformedClaimRecordShape(field: string, index: number, rec: Record<string, unknown>): void {
  assertOnlyKnownKeys(field, index, rec, MALFORMED_CLAIM_ALLOWED_KEYS)
  assertNonEmptyStringField(field, index, rec, 'uid')
  assertReasonOneOf(field, index, rec, MALFORMED_CLAIM_REASONS)
  assertSha256HexField(field, index, rec, 'evidenceFingerprint')
}

const DANGLING_MEMBERSHIP_ALLOWED_KEYS = ['companyId', 'uid', 'reason', 'evidenceFingerprint']
function validateDanglingMembershipRecordShape(field: string, index: number, rec: Record<string, unknown>): void {
  assertOnlyKnownKeys(field, index, rec, DANGLING_MEMBERSHIP_ALLOWED_KEYS)
  assertNonEmptyStringField(field, index, rec, 'companyId')
  assertNonEmptyStringField(field, index, rec, 'uid')
  assertReasonOneOf(field, index, rec, DANGLING_MEMBERSHIP_REASONS)
  assertSha256HexField(field, index, rec, 'evidenceFingerprint')
}

const OWNER_ID_ANOMALY_ALLOWED_KEYS = ['companyId', 'reason', 'evidenceFingerprint']
function validateOwnerIdAnomalyRecordShape(field: string, index: number, rec: Record<string, unknown>): void {
  assertOnlyKnownKeys(field, index, rec, OWNER_ID_ANOMALY_ALLOWED_KEYS)
  assertNonEmptyStringField(field, index, rec, 'companyId')
  assertReasonOneOf(field, index, rec, OWNER_ID_ANOMALY_REASONS)
  assertSha256HexField(field, index, rec, 'evidenceFingerprint')
}

type FindingShapeValidator = (field: string, index: number, rec: Record<string, unknown>) => void

interface ResolvedFieldSpec {
  field: 'resolvedConflicts' | 'resolvedOrphans' | 'resolvedOwnerAnomalies' | 'resolvedUnknownUsers' | 'resolvedMalformedClaims'
  validateFinding: FindingShapeValidator
}

const RESOLVED_FIELD_SPECS: readonly ResolvedFieldSpec[] = [
  { field: 'resolvedConflicts', validateFinding: validateConflictRecordShape },
  { field: 'resolvedOrphans', validateFinding: validateOrphanRecordShape },
  { field: 'resolvedOwnerAnomalies', validateFinding: validateOwnerAnomalyRecordShape },
  { field: 'resolvedUnknownUsers', validateFinding: validateUnknownUserRecordShape },
  { field: 'resolvedMalformedClaims', validateFinding: validateMalformedClaimRecordShape },
]

interface UnresolvedFieldSpec {
  field: 'conflicts' | 'orphans' | 'ownerAnomalies' | 'unknownUsers' | 'malformedClaims' | 'danglingMemberships' | 'ownerIdAnomalies'
  validateFinding: FindingShapeValidator
  /** How to compute the expected length from `counts` — a function so
   * `orphans` can sum two fields (`unresolvedMissingCompanies` +
   * `unresolvedMissingUsers`). */
  expectedLength: (counts: Record<string, unknown>) => number
}

const UNRESOLVED_FIELD_SPECS: readonly UnresolvedFieldSpec[] = [
  { field: 'conflicts', validateFinding: validateConflictRecordShape, expectedLength: counts => counts.conflicts as number },
  { field: 'orphans', validateFinding: validateOrphanRecordShape, expectedLength: counts => (counts.unresolvedMissingCompanies as number) + (counts.unresolvedMissingUsers as number) },
  { field: 'ownerAnomalies', validateFinding: validateOwnerAnomalyRecordShape, expectedLength: counts => counts.ownerWithoutAdminMembership as number },
  { field: 'unknownUsers', validateFinding: validateUnknownUserRecordShape, expectedLength: counts => counts.unknownUsers as number },
  { field: 'malformedClaims', validateFinding: validateMalformedClaimRecordShape, expectedLength: counts => counts.malformedClaims as number },
  { field: 'danglingMemberships', validateFinding: validateDanglingMembershipRecordShape, expectedLength: counts => counts.danglingMemberships as number },
  { field: 'ownerIdAnomalies', validateFinding: validateOwnerIdAnomalyRecordShape, expectedLength: counts => counts.ownerIdAnomalies as number },
]

/** Validates one standalone `Decision` (a `staleDecisions`/`unusedDecisions`
 * entry, or the `decision` half of a resolved-findings pair) by delegating
 * to `decisions.ts`'s `validateDecisions()` — the SAME function that
 * validates an operator's `--decisions-file` — so this contract can never
 * drift from the real one (rejects unknown fields, forbids `role` unless
 * `resolution === 'confirm_role'`, checks resolution/findingType
 * compatibility, etc.). Returns the normalized `Decision`. */
function validateDecisionRecord(field: string, index: number, rec: Record<string, unknown>): Decision {
  const result = validateDecisions([rec])
  if (!result.ok) {
    throw new ProductionSafetyError(`${field}[${index}].decision: ${result.errors.map(e => e.message).join('; ')}`)
  }
  return result.decisions[0]!
}

function validateResolvingDecisionRecord(field: string, index: number, decision: Record<string, unknown>, finding: Record<string, unknown>): void {
  const validated = validateDecisionRecord(field, index, decision)

  // Cross-checks: `decision` must genuinely be THE decision that resolved
  // THIS `finding` — matching identity, `findingType === finding.reason`,
  // and `evidenceFingerprint`. `validateDecisionRecord()` above already
  // confirmed `validated.resolution` is compatible with `validated.findingType`
  // itself (via `COMPATIBLE_RESOLUTIONS`, inside `validateDecisions()`) —
  // once `findingType === finding.reason` holds too, that compatibility
  // transfers to `finding.reason`, so no separate check is needed here.
  if (validated.findingType !== finding.reason) {
    throw new ProductionSafetyError(`${field}[${index}]: decision.findingType (${JSON.stringify(validated.findingType)}) does not match finding.reason (${JSON.stringify(finding.reason)}).`)
  }
  if (validated.evidenceFingerprint !== finding.evidenceFingerprint) {
    throw new ProductionSafetyError(`${field}[${index}]: decision.evidenceFingerprint does not match finding.evidenceFingerprint.`)
  }
  if (validated.uid !== finding.uid) {
    throw new ProductionSafetyError(`${field}[${index}]: decision.uid does not match finding.uid.`)
  }
  if (finding.companyId !== undefined) {
    if (validated.companyId !== finding.companyId) {
      throw new ProductionSafetyError(`${field}[${index}]: decision.companyId does not match finding.companyId.`)
    }
  } else if (validated.companyId !== undefined) {
    throw new ProductionSafetyError(`${field}[${index}]: decision.companyId must be absent — the finding it resolves is user-level.`)
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
  // Independent audit fixes, 5th round — DEEPENED across two follow-up
  // reviews: schemaVersion is checked above to be EXACTLY
  // REPORT_SCHEMA_VERSION (3), but earlier versions of this check (a) only
  // verified resolved-findings `finding`/`decision` were present, non-array
  // objects — never their actual content or per-type shape — and (b) never
  // required or validated the report's UNRESOLVED finding arrays at all. A
  // report could omit `conflicts`/`orphans`/`unknownUsers`/`malformedClaims`/
  // etc. entirely, supply a `resolvedOrphans` entry whose `OrphanRecord` was
  // missing `sourceKinds`/`observedRoles`/`hasInvalidRole`/`proposedRole`,
  // or attach a `decision` with an extra unknown field or a forbidden
  // `role` on a non-`confirm_role` resolution — all previously accepted.
  //
  // Fixed by validating BOTH the unresolved arrays and each resolved-
  // findings array's `finding` half against a per-record-type shape
  // validator (`validate*RecordShape()` above — the SAME validator either
  // way, since the shape is identical; only resolved findings additionally
  // pair it with a `decision`), reusing `decisions.ts`'s `validateDecisions()`
  // for every `decision` (so this contract can never drift from the one
  // `--decisions-file` itself is held to), and reconciling every array's
  // length against its corresponding `counts` field.
  for (const spec of UNRESOLVED_FIELD_SPECS) {
    const value = report[spec.field]
    if (!Array.isArray(value)) {
      throw new ProductionSafetyError(`is missing ${spec.field} (required by schema v${REPORT_SCHEMA_VERSION}).`)
    }
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ProductionSafetyError(`${spec.field}[${index}] is not an object.`)
      }
      spec.validateFinding(spec.field, index, entry as Record<string, unknown>)
    })
    const expected = spec.expectedLength(counts)
    if (value.length !== expected) {
      throw new ProductionSafetyError(`${spec.field}.length (${value.length}) does not match the corresponding counts field (expected ${expected}) — the report's finding arrays and counts are internally inconsistent.`)
    }
  }
  for (const field of ['staleDecisions', 'unusedDecisions'] as const) {
    const value = report[field]
    if (!Array.isArray(value)) {
      throw new ProductionSafetyError(`is missing ${field} (required by schema v${REPORT_SCHEMA_VERSION}).`)
    }
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ProductionSafetyError(`${field}[${index}] is not an object.`)
      }
      validateDecisionRecord(field, index, entry as Record<string, unknown>)
    })
    if (value.length !== (counts[field] as number)) {
      throw new ProductionSafetyError(`${field}.length (${value.length}) does not match counts.${field} (${counts[field]}) — internally inconsistent.`)
    }
  }

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
      spec.validateFinding(spec.field, index, finding)
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
