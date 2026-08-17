// Versioned JSON report schema + safe stdout summary — SEC-005.
//
// The FULL report (this type) may contain uid/companyId — sensitive
// identifiers per task spec §8 — and is written ONLY to an explicit
// absolute path OUTSIDE the repository (validated by the CLI). Never
// written into the repo, never printed to stdout in full.
import { dirname } from 'node:path'
import { writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  ConflictRecord, OrphanRecord, OwnerAnomalyRecord, PlannedCreate, UnknownUserRecord, MalformedClaimRecord,
  DanglingMembershipRecord,
} from './types.ts'
import type { Environment } from './firebaseAdmin.ts'
import { assertPathOutsideRepo } from './pathSafety.ts'

export const REPORT_SCHEMA_VERSION = 1

export type ReportMode = 'dry-run' | 'apply' | 'verify' | 'rollback-from-report' | 'rollback-from-plan'

export interface ReportCounts {
  usersRead: number
  companiesRead: number
  existingMembershipsRead: number
  candidateRelations: number
  confirmedRelations: number
  plannedCreates: number
  created: number
  skipped: number
  conflicts: number
  missingCompanies: number
  missingUsers: number
  ownerWithoutAdminMembership: number
  unknownUsers: number
  malformedClaims: number
  /** Independent audit fix #3 (3rd round, follow-up correction): existing
   * membership documents that physically exist but reference a missing
   * company/user — always non-decision-resolvable, always counted here. */
  danglingMemberships: number
  unresolved: number
}

export interface VerificationResult {
  performed: boolean
  matchesTarget: boolean
  missing: { companyId: string; uid: string }[]
  differing: { companyId: string; uid: string }[]
}

export interface RollbackManifestEntry {
  companyId: string
  uid: string
  path: string
}

export interface CreatedPathRecord {
  companyId: string
  uid: string
  path: string
  /** create-time metadata snapshot used by rollback's strict precondition check. */
  createTimeIso?: string
  updateTimeIso?: string
}

export interface WriteFailureRecord {
  companyId: string
  uid: string
  error: string
}

/** SEC-005 production preflight — real, VERIFIED production-write
 * preconditions, recorded honestly in the report's safe/audit section.
 * `null` for any mode/environment where a given precondition does not
 * apply (e.g. dry-run/verify never populate any of these — they are
 * read-only and require none of them). Every non-null field here was
 * independently verified against real state (a Firestore read, or a file
 * that was actually read and schema-checked) — never a mere echo of a CLI
 * flag's raw string value. See scripts/lib/productionSafety.ts. */
export interface ProductionSafetyAudit {
  maintenanceMode: { verifiedAt: string; enabledAt: string | null; enabledBy: string | null; taskId: string | null } | null
  /** `membersCount` — independent review fix #1: proves the verified backup
   * actually captured the `members` collection group, not merely that a
   * manifest file existed. `membersChecksum` — final-round fix #5 (third
   * pass): the SOURCE (production export) members checksum, recorded ONLY
   * after `verifyBackupReference()` has already confirmed it exactly
   * equals `restore.membersChecksum` — so its presence here is itself
   * proof the source/restore checksums matched, not just an echo of an
   * unverified manifest field. */
  backupReference: { sha256: string; createdAtUtc: string; membersCount: number; membersChecksum: string } | null
  /** PRE-apply rollback plan reference — a dry-run report whose targetChecksum
   * was cross-checked against this run's own computed target BEFORE any write. */
  rollbackPlanReference: { sha256: string; targetChecksum: string } | null
  /** POST-apply (or post-rollback) artifact: SHA-256 of THIS run's own
   * report file, once written — the durable pointer a subsequent
   * `rollback-from-report` would actually consume. */
  ownReportSha256: string | null
}

/** `--mode rollback-from-plan` only — final-round fix for item 7: the
 * "lost apply-report" emergency scenario no longer falls back to a blind
 * Firestore `import` of the pre-apply backup (which cannot delete anything
 * — see MEMBERSHIP_BACKFILL.md). Instead, candidates are reconstructed from
 * a separately-verified dry-run report's `plannedCreates`, and each one is
 * deleted ONLY if the live document still matches EXACTLY what was
 * planned, under the same `lastUpdateTime` delete precondition
 * `rollback-from-report` uses. This is deliberately weaker evidence than a
 * real apply report's `createdPaths` (no create-time proof this exact run
 * created the document — only that a matching document exists now and
 * nothing else claimed to have planned it) — `null` for every other mode. */
export interface EmergencyReconstructionRefusal {
  companyId: string
  uid: string
  reason: string
}
export interface EmergencyReconstructionAudit {
  sourceDryRunSha256: string
  /** Planned candidates with no live document at all — nothing to delete,
   * not an error (the intended creation may simply never have happened). */
  skippedNotFound: { companyId: string; uid: string }[]
  /** Planned candidates whose live document did NOT exactly match the
   * plan (or failed strict schema validation, or changed concurrently at
   * delete time) — never deleted; refused instead of guessing. */
  refused: EmergencyReconstructionRefusal[]
}

export interface MembershipBackfillReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION
  mode: ReportMode
  environment: Environment
  projectId: string
  sourceGitSha: string
  runId: string
  startedAt: string
  finishedAt: string
  counts: ReportCounts
  sourceChecksum: string
  decisionsChecksum: string
  targetChecksum: string
  observedChecksum: string | null
  /** Independent audit fix #2 (3rd round): non-null when the post-write
   * read-back itself failed (as opposed to an individual document simply
   * being absent, which is captured in `verification.missing`) — an
   * honest signal that `observedChecksum`/`verification` could not be
   * computed at all, distinct from "computed and everything matched". */
  readBackError: string | null
  conflicts: ConflictRecord[]
  orphans: OrphanRecord[]
  ownerAnomalies: OwnerAnomalyRecord[]
  unknownUsers: UnknownUserRecord[]
  malformedClaims: MalformedClaimRecord[]
  /** Independent audit fix #3 (3rd round, follow-up correction): see
   * `DanglingMembershipRecord` — a document that physically exists in
   * Firestore but references a missing company/user. Deliberately never
   * merged into `orphans` above; no decision can ever clear an entry here. */
  danglingMemberships: DanglingMembershipRecord[]
  plannedCreates: PlannedCreate[]
  createdPaths: CreatedPathRecord[]
  writeFailures: WriteFailureRecord[]
  verification: VerificationResult
  rollbackManifest: RollbackManifestEntry[]
  productionSafety: ProductionSafetyAudit
  emergencyReconstruction: EmergencyReconstructionAudit | null
}

/** Refuses any report path that is not absolute, or that resolves (after
 * symlink resolution) inside this repository checkout — the full report
 * must never land in Git. Thin wrapper over the shared
 * assertPathOutsideRepo() (also used for --decisions-file/--from-report). */
export function assertSafeReportPath(reportPath: string, repoRoot: string): void {
  assertPathOutsideRepo('--report-path', reportPath, repoRoot)
}

/** Independent audit fix #2 (3rd round): proves the report destination is
 * actually writable — directory creatable, permissions sufficient —
 * BEFORE the first real Firestore write happens (called early in `main()`,
 * right after path-safety validation). Losing the ability to write the
 * report only after `apply` has already created real documents would
 * leave an unrecoverable audit/rollback gap: the operator would have no
 * record of what was created and no `rollbackManifest` to undo it with.
 * Writes and immediately removes a zero-byte probe file at the exact
 * target path — the same path `writeReport()` will use — so a permissions
 * or filesystem problem is caught here, not after real writes occur. */
export function assertReportPathWritable(reportPath: string, repoRoot: string): void {
  assertSafeReportPath(reportPath, repoRoot)
  mkdirSync(dirname(reportPath), { recursive: true })
  const probePath = `${reportPath}.write-probe-${randomUUID()}`
  writeFileSync(probePath, '', { encoding: 'utf8', mode: 0o600 })
  unlinkSync(probePath)
}

/** Writes the report atomically: the full content is written to a
 * temporary file in the SAME directory (so the subsequent rename stays on
 * one filesystem/volume and is atomic), then renamed into place.
 * Independent audit fix #2 (3rd round) — "make the final report
 * replacement atomic where practical": a crash or interruption mid-write
 * can never leave a truncated/corrupted report at `reportPath` — either
 * the old content (if any) remains, or the complete new content lands,
 * never a partial write. */
export function writeReport(reportPath: string, repoRoot: string, report: MembershipBackfillReport): void {
  assertSafeReportPath(reportPath, repoRoot)
  mkdirSync(dirname(reportPath), { recursive: true })
  const tmpPath = `${reportPath}.tmp-${randomUUID()}`
  writeFileSync(tmpPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmpPath, reportPath)
}

/** Only safe aggregates — project ID, mode, checksums, counts. Never
 * email/name/full documents/tokens/raw uid-company pairs. */
export function printSafeSummary(report: MembershipBackfillReport): void {
  console.log(JSON.stringify({
    mode: report.mode,
    environment: report.environment,
    projectId: report.projectId,
    runId: report.runId,
    counts: report.counts,
    sourceChecksum: report.sourceChecksum,
    decisionsChecksum: report.decisionsChecksum,
    targetChecksum: report.targetChecksum,
    observedChecksum: report.observedChecksum,
    applyAllowed: report.counts.unresolved === 0,
    // Safe by construction: hashes/timestamps/taskId only — never a raw
    // local file path (which could reveal operator filesystem/username
    // structure) and never a Firestore document identifier.
    productionSafety: report.productionSafety,
    // Only COUNTS here, deliberately — unlike productionSafety above,
    // EmergencyReconstructionAudit's skippedNotFound/refused arrays contain
    // companyId/uid (sensitive identifiers per task spec §8), so only their
    // lengths are safe for the stdout summary; the full detail stays in the
    // full report file only.
    emergencyReconstruction: report.emergencyReconstruction === null ? null : {
      sourceDryRunSha256: report.emergencyReconstruction.sourceDryRunSha256,
      skippedNotFoundCount: report.emergencyReconstruction.skippedNotFound.length,
      refusedCount: report.emergencyReconstruction.refused.length,
    },
  }, null, 2))
}
