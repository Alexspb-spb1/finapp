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
  DanglingMembershipRecord, OwnerIdAnomalyRecord, Decision,
} from './types.ts'
import type { Environment } from './firebaseAdmin.ts'
import { assertPathOutsideRepo } from './pathSafety.ts'

/** Bumped 1 -> 2 for independent audit fixes, 4th round, item 3.3: v1
 * discarded a finding's originating evidence (source kind, observed roles,
 * invalid-role flag) at the moment an `OrphanRecord`/`ConflictRecord`/etc.
 * was created — making it structurally impossible to determine, from a
 * saved report alone, whether e.g. a `missing_company` orphan came from
 * `users.home`, `users.companies[]`, or both. v2 reports carry that
 * evidence (via each record's `evidenceFingerprint` plus the new
 * `sourceKinds`/`observedRoles`/`hasInvalidRole` fields already present on
 * the record types themselves — see types.ts), plus the new
 * `ownerIdAnomalies`/`staleDecisions`/`unusedDecisions` sections and the
 * full source-state checksum (`sourceStateChecksum` — see checksum.ts's
 * computeFullSourceStateChecksum()). A v1 report can never satisfy any of
 * this — `validateStrictDryRunReportContent()`/`validateSourceReportForRollback()`
 * (productionSafety.ts / rollbackValidation.ts) now reject `schemaVersion
 * !== 2` outright, with a clear "re-run against the current tool" error,
 * rather than attempting to interpret a v1 report's different shape.
 *
 * Bumped 2 -> 3 for independent audit fixes, 5th round: `OrphanRecord` now
 * also carries `observedRoles`/`hasInvalidRole`/`proposedRole` (v2 baked
 * these into `evidenceFingerprint` but never exposed them on the record
 * itself, so a human reading the report could not see WHICH role(s) were
 * actually observed for an orphan); `counts` now distinguishes DISCOVERED
 * totals (`missingCompanies`/`missingUsers` — every orphan ever found,
 * including ones a decision excluded) from UNRESOLVED-only counts
 * (`unresolvedMissingCompanies`/`unresolvedMissingUsers`); and the report
 * now records RESOLVED findings (`resolvedConflicts`/`resolvedOrphans`/
 * `resolvedOwnerAnomalies`/`resolvedUnknownUsers`/`resolvedMalformedClaims`,
 * each paired with the decision that resolved it) — v2 only ever recorded
 * the UNRESOLVED subset, so a finding a decision successfully excluded or
 * confirmed left zero trace in the report, breaking the audit trail.
 *
 * Bumped 3 -> 4 for independent audit fixes, 5th round, 4th follow-up
 * review: `plan.companiesWithoutAdmin.length` (a company with zero active
 * admin — existing or planned — after this run) was already summed into
 * `counts.unresolved` and already blocked `applyAllowed`, but had no
 * dedicated `counts.companiesWithoutAdmin` field and no corresponding
 * array anywhere in the report — a reviewer could see the last-admin gate
 * had blocked something, but never WHICH company, from the report alone.
 * `counts.companiesWithoutAdmin` and the private
 * `companiesWithoutAdmin: string[]` field close that gap. A v3 (or
 * earlier) report can never satisfy either — `validateStrictDryRunReportContent()`
 * rejects `schemaVersion !== 4` outright, with a message explicit that a
 * NEW dry-run against the current tool is required (never attempts to
 * interpret an older report's different shape). */
export const REPORT_SCHEMA_VERSION = 4

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
  /** DISCOVERED total — every `missing_company`/`missing_user` orphan found
   * this run, INCLUDING ones a decision already excluded. Independent
   * audit fixes, 5th round, item 3: kept separate from
   * `unresolvedMissingCompanies`/`unresolvedMissingUsers` below (which are
   * the actually-still-blocking subset) — conflating the two previously
   * made a perfectly valid "1 missing_company, correctly excluded,
   * unresolved: 0" report look internally inconsistent. */
  missingCompanies: number
  missingUsers: number
  /** UNRESOLVED-only counterpart to `missingCompanies` above — post-decision,
   * contributes to `unresolved`. Independent audit fixes, 5th round, item 3. */
  unresolvedMissingCompanies: number
  unresolvedMissingUsers: number
  ownerWithoutAdminMembership: number
  /** Companies whose PROJECTED final state (existing active admins +
   * planned admin creates) has zero active admin — always blocking, never
   * decision-resolvable (only creating/confirming an admin membership for
   * the company clears it). Independent audit fixes, 5th round, 4th
   * follow-up review — previously summed into `counts.unresolved` with no
   * dedicated count or corresponding array anywhere in the report. */
  companiesWithoutAdmin: number
  unknownUsers: number
  malformedClaims: number
  /** Independent audit fix #3 (3rd round, follow-up correction): existing
   * membership documents that physically exist but reference a missing
   * company/user — always non-decision-resolvable, always counted here. */
  danglingMemberships: number
  /** `companies/{companyId}.ownerId` present but not a usable string —
   * always non-decision-resolvable. Independent audit fixes, 4th round,
   * item 3.4. */
  ownerIdAnomalies: number
  /** Decisions whose (identity, findingType) matched a current finding but
   * whose evidenceFingerprint did not — always blocking. Independent audit
   * fixes, 4th round, item 3.1. */
  staleDecisions: number
  /** Decisions that matched no current finding at all — always blocking.
   * Independent audit fixes, 4th round, item 3.1. */
  unusedDecisions: number
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
  /** Full normalized source-state fingerprint — checksum.ts's
   * computeFullSourceStateChecksum(). Independent audit fixes, 4th round,
   * item 3.2: broader than `sourceChecksum` (which only ever covered
   * `extraction.confirmed`) — covers everything migration-relevant:
   * conflicts/orphans/anomalies with their evidence, which users/companies
   * exist, and normalized existing-membership state. */
  sourceStateChecksum: string
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
  /** Independent audit fixes, 4th round, item 3.4 — see
   * `OwnerIdAnomalyRecord`. Never decision-resolvable. */
  ownerIdAnomalies: OwnerIdAnomalyRecord[]
  /** Independent audit fixes, 5th round, 4th follow-up review — private
   * companion to `counts.companiesWithoutAdmin`: the actual companyIds the
   * last-admin gate blocked on (`plan.companiesWithoutAdmin`), sorted,
   * never duplicated. Never printed to the safe stdout summary (contains
   * companyId, same sensitivity as `conflicts`/`orphans`/etc. above) —
   * only its count reaches stdout, via `counts`. */
  companiesWithoutAdmin: string[]
  /** Independent audit fixes, 4th round, item 3.1 — decisions whose
   * (identity, findingType) matched a current finding but whose
   * `evidenceFingerprint` did not. */
  staleDecisions: Decision[]
  /** Independent audit fixes, 4th round, item 3.1 — decisions that matched
   * no current finding at all. */
  unusedDecisions: Decision[]
  /** Findings that WERE successfully resolved this run, each paired with
   * the decision that resolved it — independent audit fixes, 5th round,
   * item 4. Previously, `conflicts`/`orphans`/`ownerAnomalies`/
   * `unknownUsers`/`malformedClaims` above only ever held the UNRESOLVED
   * subset (`plan.unresolvedConflicts` etc.) — a finding a decision
   * successfully excluded or confirmed left ZERO trace anywhere in the
   * report, breaking the audit trail (what was found, and what happened to
   * it, could not both be reconstructed from the report alone). These
   * fields close that gap; they are never printed to the safe stdout
   * summary (contain companyId/uid, same sensitivity as the unresolved
   * lists). */
  resolvedConflicts: { finding: ConflictRecord; decision: Decision }[]
  resolvedOrphans: { finding: OrphanRecord; decision: Decision }[]
  resolvedOwnerAnomalies: { finding: OwnerAnomalyRecord; decision: Decision }[]
  resolvedUnknownUsers: { finding: UnknownUserRecord; decision: Decision }[]
  resolvedMalformedClaims: { finding: MalformedClaimRecord; decision: Decision }[]
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
    sourceStateChecksum: report.sourceStateChecksum,
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
