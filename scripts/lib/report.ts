// Versioned JSON report schema + safe stdout summary — SEC-005.
//
// The FULL report (this type) may contain uid/companyId — sensitive
// identifiers per task spec §8 — and is written ONLY to an explicit
// absolute path OUTSIDE the repository (validated by the CLI). Never
// written into the repo, never printed to stdout in full.
import { isAbsolute, dirname } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import type {
  ConflictRecord, OrphanRecord, OwnerAnomalyRecord, PlannedCreate,
} from './types.ts'
import type { Environment } from './firebaseAdmin.ts'

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
  conflicts: ConflictRecord[]
  orphans: OrphanRecord[]
  ownerAnomalies: OwnerAnomalyRecord[]
  plannedCreates: PlannedCreate[]
  createdPaths: CreatedPathRecord[]
  writeFailures: WriteFailureRecord[]
  verification: VerificationResult
  rollbackManifest: RollbackManifestEntry[]
}

export class ReportPathError extends Error {}

/** Refuses any report path that is not absolute, or that resolves inside
 * this repository checkout — the full report must never land in Git. */
export function assertSafeReportPath(reportPath: string, repoRoot: string): void {
  if (!isAbsolute(reportPath)) {
    throw new ReportPathError('--report-path must be an absolute path.')
  }
  const normalizedRepo = repoRoot.replace(/\\/g, '/').replace(/\/$/, '')
  const normalizedReport = reportPath.replace(/\\/g, '/')
  if (normalizedReport === normalizedRepo || normalizedReport.startsWith(`${normalizedRepo}/`)) {
    throw new ReportPathError('--report-path must be OUTSIDE the repository checkout.')
  }
}

export function writeReport(reportPath: string, repoRoot: string, report: MembershipBackfillReport): void {
  assertSafeReportPath(reportPath, repoRoot)
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 })
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
