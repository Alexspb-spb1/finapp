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

export type ReportMode = 'dry-run' | 'apply' | 'verify' | 'rollback-from-report'

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
  }, null, 2))
}
