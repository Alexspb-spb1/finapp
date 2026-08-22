#!/usr/bin/env node
// SEC-005 — safe membership backfill CLI.
//
// Migrates legacy users/{uid}.role|companyId|companies[] and
// companies/{companyId}.ownerId into canonical
// companies/{companyId}/members/{uid} documents (ADR-001), with dry-run as
// the default, explicit environment/project guards, create-only writes, a
// versioned JSON report with checksums, and report-driven rollback.
//
// See docs/migrations/MEMBERSHIP_BACKFILL.md for the full walkthrough,
// CLI reference, and safety model.
import process from 'node:process'
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { parseCliArgs, CliArgError } from './lib/cli.ts'
import { assertEnvironmentGuard, assertCycleExecutionAllowed, initFirestore, EnvironmentGuardError, CycleExecutionError, type Environment } from './lib/firebaseAdmin.ts'
import { extractLegacyRelations } from './lib/legacyMapping.ts'
import { validateDecisions } from './lib/decisions.ts'
import { buildPlan } from './lib/planner.ts'
import { readAllUsers, readAllCompanies, readAllExistingMemberships, computeExistingActiveAdmins } from './lib/firestoreReaders.ts'
import { computeRelationSetChecksum, computeDecisionsChecksum, computeFullSourceStateChecksum, computeFindingFingerprint, canonicalStringify, sha256Hex, sortRelations } from './lib/checksum.ts'
import { assertPathOutsideRepo, UnsafePathError } from './lib/pathSafety.ts'
import { validateSourceReportForRollback } from './lib/rollbackValidation.ts'
import { computeObservedState, type TargetRelation } from './lib/observedState.ts'
import { createPlannedRelations, readBackObservedState } from './lib/applyWrites.ts'
import {
  writeReport, assertReportPathWritable, printSafeSummary, REPORT_SCHEMA_VERSION,
  type MembershipBackfillReport, type ReportCounts, type CreatedPathRecord, type WriteFailureRecord, type ProductionSafetyAudit,
  type EmergencyReconstructionAudit,
} from './lib/report.ts'
import {
  assertMaintenanceModeActive, verifyBackupReference, verifyRollbackPlanReference, sha256OfFile, ProductionSafetyError,
} from './lib/productionSafety.ts'
import { runEmergencyReconstruction } from './lib/emergencyReconstruction.ts'
import { assertCleanTrackedSourceRevision, realSourceRevisionDeps, SourceRevisionError } from './lib/sourceRevision.ts'
import { relationKey, type Decision, type ConfirmedRelation } from './lib/types.ts'
import type { CliOptions } from './lib/cli.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readSourceGitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function readDecisionsFile(path: string | undefined): { decisions: Decision[]; checksum: string } {
  if (!path) return { decisions: [], checksum: computeDecisionsChecksum([]) }
  if (!existsSync(path)) {
    throw new CliArgError('--decisions-file does not exist (path withheld from logs).')
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new CliArgError('--decisions-file is not valid JSON.')
  }
  const result = validateDecisions(raw)
  if (!result.ok) {
    const messages = result.errors.map(e => `  [${e.index}] ${e.message}`).join('\n')
    throw new CliArgError(`--decisions-file failed validation:\n${messages}`)
  }
  return { decisions: result.decisions, checksum: computeDecisionsChecksum(result.decisions) }
}

function emptyCounts(): ReportCounts {
  return {
    usersRead: 0, companiesRead: 0, existingMembershipsRead: 0, candidateRelations: 0,
    confirmedRelations: 0, plannedCreates: 0, created: 0, skipped: 0, conflicts: 0,
    missingCompanies: 0, missingUsers: 0, ownerWithoutAdminMembership: 0,
    unknownUsers: 0, malformedClaims: 0, danglingMemberships: 0,
    ownerIdAnomalies: 0, staleDecisions: 0, unusedDecisions: 0, unresolved: 0,
  }
}

function emptyProductionSafety(): ProductionSafetyAudit {
  return { maintenanceMode: null, backupReference: null, rollbackPlanReference: null, ownReportSha256: null }
}

function computeSourceChecksum(confirmed: readonly ConfirmedRelation[]): string {
  const canonical = sortRelations(confirmed).map(r => ({ companyId: r.companyId, uid: r.uid, role: r.role }))
  return sha256Hex(canonicalStringify(canonical))
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  let opts
  try {
    opts = parseCliArgs(args)
  } catch (err) {
    if (err instanceof CliArgError) { console.error(`Argument error: ${err.message}`); return 2 }
    throw err
  }

  // Independent audit fix #5: every path this tool will ever read from or
  // write to outside Firestore itself is validated as an absolute path
  // OUTSIDE the repository checkout BEFORE any credential acquisition or
  // Firestore I/O — including --decisions-file and --from-report, not just
  // --report-path. A single invalid path here means ZERO writes happen.
  // Final-round fix #5: --backup-reference/--rollback-reference/--from-plan
  // went straight to readFileSync() in productionSafety.ts without this
  // check — closed here, before any credential acquisition/Firestore I/O,
  // same as every other path flag.
  try {
    assertPathOutsideRepo('--report-path', opts.reportPath!, REPO_ROOT)
    if (opts.decisionsFile) assertPathOutsideRepo('--decisions-file', opts.decisionsFile, REPO_ROOT)
    if (opts.fromReport) assertPathOutsideRepo('--from-report', opts.fromReport, REPO_ROOT)
    if (opts.fromPlan) assertPathOutsideRepo('--from-plan', opts.fromPlan, REPO_ROOT)
    if (opts.backupReference) assertPathOutsideRepo('--backup-reference', opts.backupReference, REPO_ROOT)
    if (opts.rollbackReference) assertPathOutsideRepo('--rollback-reference', opts.rollbackReference, REPO_ROOT)
    // Independent audit fix #2 (3rd round): prove the report destination is
    // actually writable BEFORE any credential acquisition or Firestore
    // I/O — losing the ability to write the report only AFTER apply has
    // already created (or rollback has already deleted) real documents
    // would leave an unrecoverable audit/rollback gap.
    assertReportPathWritable(opts.reportPath!, REPO_ROOT)
  } catch (err) {
    if (err instanceof UnsafePathError) { console.error(`Path safety: ${err.message}`); return 2 }
    if (err instanceof Error) { console.error(`Report path is not writable: ${err.message}`); return 2 }
    throw err
  }

  const environment: Environment = opts.environment
  let expectedProjectId: string
  try {
    expectedProjectId = assertEnvironmentGuard({
      environment,
      cliProjectId: opts.project,
      envProjectId: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT,
      firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
      confirmProjectId: opts.confirmProject,
    })
  } catch (err) {
    if (err instanceof EnvironmentGuardError) { console.error(`Environment guard: ${err.message}`); return 3 }
    throw err
  }

  // Independent review fix #6 (production preflight, follow-up round):
  // mode-specific production requirements. `dry-run`/`verify` are strictly
  // read-only and require NONE of backup-reference/rollback-reference/
  // maintenance-mode — the previous version of this check required them
  // for every mode except `verify` (so `dry-run` incorrectly demanded a
  // backup reference for an operation that writes nothing). `apply` and
  // `rollback-from-report` are the only modes that write to production;
  // their specific, VERIFIED (not merely present) requirements are
  // enforced later — for `apply`, once targetChecksum is known (see
  // below); for `rollback-from-report`, inside runRollback().
  // SEC-005: staging execution is explicitly authorized this cycle
  // (EXTERNAL_ACTION_APPROVED: SEC-005 / ENVIRONMENT: staging, granted by
  // the repository owner) — emulator and staging both proceed past this
  // gate for any mode. Production is authorized ONLY for --mode dry-run
  // (PRODUCTION_PREFLIGHT_APPROVED: SEC-005 — "deploy maintenance
  // protection, create+verify backup, read-only dry-run"; "Backfill/apply
  // пока запрещён") — assertCycleExecutionAllowed() refuses every other
  // production mode regardless of the flags checked just above; no
  // broader PRODUCTION_ACTION_APPROVED grant for an actual backfill has
  // been given this cycle.
  try {
    assertCycleExecutionAllowed(environment, opts.mode)
  } catch (err) {
    if (err instanceof CycleExecutionError) { console.error(`Refusing to run against --environment ${environment}: ${err.message}`); return 4 }
    throw err
  }

  let decisionsResult
  try {
    decisionsResult = readDecisionsFile(opts.decisionsFile)
  } catch (err) {
    if (err instanceof CliArgError) { console.error(`Decisions file error: ${err.message}`); return 2 }
    throw err
  }

  // Independent audit fixes, 4th round, item 3.5: `git rev-parse HEAD`
  // alone (readSourceGitSha() below) proves only which commit is checked
  // out — not that the working tree still matches it. For a production
  // dry-run (and any future production apply, once authorized), the
  // reported `sourceGitSha` must be a COMPLETE, honest description of the
  // code that actually ran — verified fail-closed, BEFORE credential
  // acquisition (initFirestore()) or any Firestore I/O. Not applied to
  // emulator/staging: only production is asked to prove this by task spec.
  let verifiedProductionSourceGitSha: string | undefined
  if (environment === 'production') {
    try {
      verifiedProductionSourceGitSha = assertCleanTrackedSourceRevision(realSourceRevisionDeps(REPO_ROOT)).sourceGitSha
    } catch (err) {
      if (err instanceof SourceRevisionError) { console.error(`Source revision: ${err.message}`); return 3 }
      throw err
    }
  }

  const runId = randomUUID()
  const startedAt = new Date().toISOString()
  const db = initFirestore(expectedProjectId)

  if (opts.mode === 'rollback-from-report') {
    return runRollback(db, opts.fromReport!, environment, expectedProjectId, runId, startedAt, opts.reportPath!, opts)
  }

  if (opts.mode === 'rollback-from-plan') {
    return runRollbackFromPlan(db, opts.fromPlan!, environment, expectedProjectId, runId, startedAt, opts.reportPath!, opts)
  }

  const [users, companies, existingMemberships] = await Promise.all([
    readAllUsers(db), readAllCompanies(db), readAllExistingMemberships(db),
  ])
  const allCompanyIds = new Set(companies.map(c => c.docId))
  const allUserIds = new Set(users.map(u => u.docId))
  // Independent audit fix #3 (3rd round): an admin membership whose uid has
  // no users/{uid} document must never satisfy the last-admin gate.
  const existingActiveAdmins = computeExistingActiveAdmins(existingMemberships, allUserIds)
  const extraction = extractLegacyRelations(users, companies)
  const plan = buildPlan({ extraction, decisions: decisionsResult.decisions, existingMemberships, existingActiveAdmins, allCompanyIds, allUserIds })

  const targetRelations: TargetRelation[] = [
    ...plan.plannedCreates.map(c => ({ companyId: c.companyId, uid: c.uid, role: c.role, status: c.status })),
    ...plan.skipped.map(s => {
      const existing = existingMemberships.get(relationKey(s.companyId, s.uid))
      return { companyId: s.companyId, uid: s.uid, role: (existing?.role as string) ?? 'unknown', status: 'active' }
    }),
  ]
  const targetChecksum = computeRelationSetChecksum(targetRelations)
  const sourceChecksum = computeSourceChecksum(extraction.confirmed)
  const sourceStateChecksum = computeFullSourceStateChecksum({ extraction, existingMemberships, allCompanyIds, allUserIds })
  const sourceGitSha = verifiedProductionSourceGitSha ?? readSourceGitSha()

  const counts: ReportCounts = {
    usersRead: users.length,
    companiesRead: companies.length,
    existingMembershipsRead: existingMemberships.size,
    candidateRelations: extraction.confirmed.length + extraction.conflicts.length,
    confirmedRelations: extraction.confirmed.length,
    plannedCreates: plan.plannedCreates.length,
    created: 0,
    skipped: plan.skipped.length,
    conflicts: plan.unresolvedConflicts.length,
    missingCompanies: extraction.orphans.filter(o => o.reason === 'missing_company').length,
    missingUsers: extraction.orphans.filter(o => o.reason === 'missing_user').length,
    ownerWithoutAdminMembership: plan.unresolvedOwnerAnomalies.length,
    unknownUsers: plan.unknownUsers.length,
    malformedClaims: plan.malformedClaims.length,
    danglingMemberships: plan.danglingMemberships.length,
    ownerIdAnomalies: plan.ownerIdAnomalies.length,
    staleDecisions: plan.staleDecisions.length,
    unusedDecisions: plan.unusedDecisions.length,
    unresolved: plan.unresolvedConflicts.length + plan.unresolvedOrphans.length + plan.unresolvedOwnerAnomalies.length + plan.companiesWithoutAdmin.length + plan.unknownUsers.length + plan.malformedClaims.length + plan.danglingMemberships.length + plan.ownerIdAnomalies.length + plan.staleDecisions.length + plan.unusedDecisions.length,
  }

  let createdPaths: CreatedPathRecord[] = []
  let writeFailures: WriteFailureRecord[] = []
  let observedChecksum: string | null = null
  let missing: { companyId: string; uid: string }[] = []
  let differing: { companyId: string; uid: string }[] = []
  let readBackError: string | null = null
  let productionSafety: ProductionSafetyAudit = emptyProductionSafety()

  if (opts.mode === 'apply') {
    if (!plan.applyAllowed) {
      console.error(`Apply refused: ${counts.unresolved} unresolved item(s) (conflicts/orphans/owner-anomalies/companies-without-admin/dangling-memberships/owner-id-anomalies/stale-decisions/unused-decisions). Resolve via --decisions-file and retry — dangling memberships and owner-id anomalies require repairing the underlying data, no decision can clear them; stale/unused decisions require an updated decisions file matching the CURRENT findings' evidenceFingerprint.`)
    } else {
      // Independent review fix #5/6/7 (production preflight, follow-up
      // round) + final-round fixes #1/#3/#4: for a PRODUCTION apply, verify
      // (not merely accept as present) maintenance mode, backup-reference,
      // and rollback-reference — in THAT order. Maintenance is checked
      // FIRST, deliberately: its `enabledAt` is what verifyBackupReference()
      // uses to prove the backup was actually taken AFTER maintenance mode
      // went active (final-round fix #1 — the runbook now requires
      // maintenance to be enabled BEFORE backup runs, so this ordering is
      // enforced here, not just documented). Any failure refuses before a
      // single write — `--ack-maintenance-readonly` remains required too,
      // as an explicit additional human acknowledgement on top of the real
      // check, not a substitute for it.
      let productionSafetyOk = true
      if (environment === 'production') {
        try {
          if (!opts.ackMaintenance) throw new ProductionSafetyError('--ack-maintenance-readonly is required for a production apply.')
          const maintenance = await assertMaintenanceModeActive(db)
          if (!opts.backupReference) throw new ProductionSafetyError('--backup-reference is required for a production apply.')
          const backupRef = verifyBackupReference(opts.backupReference, expectedProjectId, maintenance.enabledAt)
          if (!opts.rollbackReference) throw new ProductionSafetyError('--rollback-reference is required for a production apply.')
          // Independent audit fixes, 4th round, item 3.6: an independently
          // saved --expected-plan-sha256 is now required for a production
          // apply too (previously only rollback-from-plan required it) —
          // checked against --rollback-reference's raw bytes BEFORE parsing,
          // inside verifyRollbackPlanReference() itself.
          if (!opts.expectedPlanSha256) throw new ProductionSafetyError('--expected-plan-sha256 is required for a production apply (verified against --rollback-reference before any parsing).')
          const rollbackPlanRef = verifyRollbackPlanReference(
            opts.rollbackReference,
            opts.expectedPlanSha256,
            { sourceGitSha, sourceChecksum, decisionsChecksum: decisionsResult.checksum, targetChecksum, plannedCreates: plan.plannedCreates },
            expectedProjectId,
          )
          productionSafety = {
            maintenanceMode: maintenance,
            backupReference: { sha256: backupRef.sha256, createdAtUtc: backupRef.createdAtUtc, membersCount: backupRef.membersCount, membersChecksum: backupRef.membersChecksum },
            rollbackPlanReference: { sha256: rollbackPlanRef.sha256, targetChecksum: rollbackPlanRef.targetChecksum },
            ownReportSha256: null,
          }
        } catch (err) {
          if (err instanceof ProductionSafetyError) { console.error(`Production safety: ${err.message}`); productionSafetyOk = false } else throw err
        }
      }

      if (environment === 'production' && !productionSafetyOk) return 3

      // Independent audit fix #2 (3rd round): success is captured directly
      // from each create()'s own WriteResult (applyWrites.ts) — no
      // follow-up get() that could turn a successful create into a
      // reported "write failure". createdPaths/counts.created below are
      // therefore durable the instant this call returns, regardless of
      // what happens next (including the read-back below failing).
      const writeResult = await createPlannedRelations(db, plan.plannedCreates)
      createdPaths = writeResult.createdPaths
      writeFailures = writeResult.writeFailures
      counts.created = createdPaths.length

      // Independent audit fix #4 (2nd round, unchanged): read back REAL
      // current state — a document that failed to write is a genuine
      // MISSING entry in this checksum, never silently treated as if it
      // had the expected role/status.
      //
      // Independent audit fix #2 (3rd round): the read-back itself is now
      // wrapped (applyWrites.ts's readBackObservedState) so a failure IN
      // the read-back call can never erase the createdPaths/counts.created
      // captured just above, and can never prevent writeReport() below
      // from running — it is recorded honestly via `readBackError` instead.
      const readBack = await readBackObservedState(db, targetRelations)
      if (readBack.ok) {
        observedChecksum = readBack.observedChecksum
        missing = readBack.missing
        differing = readBack.differing
      } else {
        readBackError = readBack.error
      }
    }
  }

  if (opts.mode === 'verify') {
    const observed = computeObservedState(targetRelations, existingMemberships)
    observedChecksum = observed.observedChecksum
    missing = observed.missing
    differing = observed.differing
  }

  const report: MembershipBackfillReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: opts.mode,
    environment,
    projectId: expectedProjectId,
    sourceGitSha,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    counts,
    sourceChecksum,
    sourceStateChecksum,
    decisionsChecksum: decisionsResult.checksum,
    targetChecksum,
    observedChecksum,
    readBackError,
    conflicts: plan.unresolvedConflicts,
    orphans: plan.unresolvedOrphans,
    ownerAnomalies: plan.unresolvedOwnerAnomalies,
    unknownUsers: plan.unknownUsers,
    malformedClaims: plan.malformedClaims,
    danglingMemberships: plan.danglingMemberships,
    ownerIdAnomalies: plan.ownerIdAnomalies,
    staleDecisions: plan.staleDecisions,
    unusedDecisions: plan.unusedDecisions,
    plannedCreates: plan.plannedCreates,
    createdPaths,
    writeFailures,
    verification: {
      performed: opts.mode === 'verify',
      // Independent audit fix #1 (2nd round): matchesTarget can no longer be
      // "true" purely because two checksums happen to be equal (which is
      // trivially true for two EMPTY target/observed sets — e.g. a company
      // with an unresolved conflict and nothing else touched it). It now
      // requires, simultaneously: the plan is fully resolved
      // (plan.applyAllowed — which itself now also requires zero unknown
      // users/malformed claims, see planner.ts), zero missing/differing
      // entries, AND the checksums matching. `differing` itself is now also
      // schema-strict (observedState.ts), so a corrupted document can never
      // pass even if its role/status happen to match textually.
      matchesTarget: plan.applyAllowed && observedChecksum !== null && observedChecksum === targetChecksum && missing.length === 0 && differing.length === 0,
      missing,
      differing,
    },
    rollbackManifest: createdPaths.map(c => ({ companyId: c.companyId, uid: c.uid, path: c.path })),
    productionSafety,
    emergencyReconstruction: null,
  }

  writeReport(opts.reportPath!, REPO_ROOT, report)
  printSafeSummary(report)

  // Independent review fix #7 (production preflight, follow-up round):
  // the POST-apply rollback artifact. `ownReportSha256` cannot be embedded
  // IN the report itself (the report's own bytes would need to already
  // contain the hash of those same bytes — self-referential) — instead,
  // the hash of the file exactly as written is computed by reading it back
  // and printed as an explicit, separate line, for the operator to record
  // as THIS run's ROLLBACK_REFERENCE going forward (what a subsequent
  // `--mode rollback-from-report --from-report <this path>` will consume).
  // Final-round fix #5: printed for EVERY environment, not just production
  // — `rollback-from-report` now requires `--expected-report-sha256`
  // unconditionally (item 6 of the previous round), so an emulator/staging
  // apply needs this line too; gating it to production only would leave
  // the emulator/staging walkthrough unable to actually follow its own
  // documented rollback command.
  if (opts.mode === 'apply' && createdPaths.length > 0) {
    console.log(`Apply report SHA-256 (record this as the ROLLBACK_REFERENCE for this run): ${sha256OfFile(opts.reportPath!)}`)
  }

  if (opts.mode === 'apply' && !plan.applyAllowed) return 1
  if (opts.mode === 'apply' && writeFailures.length > 0) return 1
  // Independent audit fix #2 (3rd round): an explicit, named check — the
  // read-back itself failing must produce a non-zero exit even though
  // `observedChecksum !== targetChecksum` below would already be true in
  // this case (observedChecksum stays null) — this makes the intent
  // unambiguous rather than relying on that as an implicit side effect.
  if (opts.mode === 'apply' && readBackError !== null) return 1
  if (opts.mode === 'apply' && observedChecksum !== targetChecksum) return 1
  if (opts.mode === 'verify' && !report.verification.matchesTarget) return 1
  return 0
}

/** Deletes ONE rollback entry using Firestore's `lastUpdateTime` delete
 * precondition (independent audit fix #3) — the get()-then-delete() gap is
 * closed atomically: if the document changes between our read and the
 * delete call, the precondition fails and the delete is refused, never
 * silently succeeding against a document that changed underneath it. */
async function rollbackOneEntry(
  db: import('firebase-admin/firestore').Firestore,
  entry: import('./lib/rollbackValidation.ts').ValidatedRollbackEntry,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ref = db.collection('companies').doc(entry.companyId).collection('members').doc(entry.uid)
  const snap = await ref.get()
  if (!snap.exists) return { ok: false, reason: 'document no longer exists' }
  const data = snap.data()!
  if (data.uid !== entry.uid) return { ok: false, reason: 'uid no longer matches' }
  if (data.role !== entry.expectedRole) return { ok: false, reason: 'role no longer matches the backfill run' }
  if (data.status !== entry.expectedStatus) return { ok: false, reason: 'status changed since the backfill run' }
  const createTimeIso = snap.createTime?.toDate().toISOString()
  const updateTimeIso = snap.updateTime?.toDate().toISOString()
  if (createTimeIso !== entry.createTimeIso) return { ok: false, reason: 'createTime metadata no longer matches the backfill run' }
  if (updateTimeIso !== entry.updateTimeIso) return { ok: false, reason: 'document was modified after the backfill run' }

  try {
    await ref.delete({ lastUpdateTime: snap.updateTime! })
    return { ok: true }
  } catch {
    // The lastUpdateTime precondition failed — the document was modified
    // (or deleted+recreated) in the window between our read and this
    // delete call. Refuse, never delete.
    return { ok: false, reason: 'concurrent modification detected at delete time' }
  }
}

async function runRollback(
  db: import('firebase-admin/firestore').Firestore,
  fromReportPath: string,
  environment: Environment,
  projectId: string,
  runId: string,
  startedAt: string,
  reportPath: string,
  opts: CliOptions,
): Promise<number> {
  let sourceReportRawText: string
  try {
    sourceReportRawText = readFileSync(fromReportPath, 'utf8')
  } catch {
    console.error('Failed to read --from-report.')
    return 2
  }

  // Final-round fix #6: verify --from-report's integrity via the
  // operator-supplied SHA-256 (recorded when apply printed "Apply report
  // SHA-256...") BEFORE any parsing or Firestore I/O — a tampered or
  // swapped report is refused here, before the structural validation
  // below even runs. --expected-report-sha256 is required by
  // parseCliArgs() for this mode, so opts.expectedReportSha256 is always
  // defined here.
  const actualReportSha256 = sha256Hex(sourceReportRawText)
  if (actualReportSha256 !== opts.expectedReportSha256) {
    console.error(`Rollback refused: --from-report content does not match --expected-report-sha256 (expected ${opts.expectedReportSha256}, got ${actualReportSha256}) — the report may have been tampered with, corrupted, or is the wrong file.`)
    const report: MembershipBackfillReport = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      mode: 'rollback-from-report',
      environment,
      projectId,
      sourceGitSha: readSourceGitSha(),
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: emptyCounts(),
      sourceChecksum: '', sourceStateChecksum: '', decisionsChecksum: '', targetChecksum: '', observedChecksum: null, readBackError: null,
      conflicts: [], orphans: [], ownerAnomalies: [], unknownUsers: [], malformedClaims: [], danglingMemberships: [],
      ownerIdAnomalies: [], staleDecisions: [], unusedDecisions: [],
      plannedCreates: [], createdPaths: [], writeFailures: [],
      verification: { performed: false, matchesTarget: false, missing: [], differing: [] },
      rollbackManifest: [],
      productionSafety: emptyProductionSafety(),
      emergencyReconstruction: null,
    }
    writeReport(reportPath, REPO_ROOT, report)
    printSafeSummary(report)
    return 3
  }

  let sourceReportRaw: unknown
  try {
    sourceReportRaw = JSON.parse(sourceReportRawText)
  } catch {
    console.error('Failed to parse --from-report as JSON.')
    return 2
  }

  // Independent audit fix #3: full runtime validation of the source report
  // (schemaVersion, mode==='apply', environment/project match, unique
  // canonical manifest paths, cross-referenced against createdPaths AND
  // plannedCreates) BEFORE any Firestore read/delete is attempted. Any
  // structural problem rejects the entire rollback — zero deletions.
  const validated = validateSourceReportForRollback(sourceReportRaw, { environment, projectId })
  if (!validated.ok) {
    console.error(`Rollback refused: source report failed validation:\n${validated.errors.map(e => `  ${e}`).join('\n')}`)
    const report: MembershipBackfillReport = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      mode: 'rollback-from-report',
      environment,
      projectId,
      sourceGitSha: readSourceGitSha(),
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: emptyCounts(),
      sourceChecksum: '', sourceStateChecksum: '', decisionsChecksum: '', targetChecksum: '', observedChecksum: null, readBackError: null,
      conflicts: [], orphans: [], ownerAnomalies: [], unknownUsers: [], malformedClaims: [], danglingMemberships: [],
      ownerIdAnomalies: [], staleDecisions: [], unusedDecisions: [],
      plannedCreates: [], createdPaths: [], writeFailures: [],
      verification: { performed: false, matchesTarget: false, missing: [], differing: [] },
      rollbackManifest: [],
      productionSafety: emptyProductionSafety(),
      emergencyReconstruction: null,
    }
    writeReport(reportPath, REPO_ROOT, report)
    printSafeSummary(report)
    return 2
  }

  // Independent review fix #5/6 (production preflight, follow-up round):
  // rollback-from-report also WRITES (deletes) production documents, so
  // it needs the same real, verified maintenance-mode check as apply —
  // `rollback-from-report` does NOT require --backup-reference/
  // --rollback-reference (--from-report already IS the operative
  // reference for this operation), but it does require
  // --ack-maintenance-readonly AND a live, verified `system/maintenance`
  // read confirming maintenance mode is actually active right now.
  let productionSafety = emptyProductionSafety()
  if (environment === 'production') {
    try {
      if (!opts.ackMaintenance) throw new ProductionSafetyError('--ack-maintenance-readonly is required for a production rollback.')
      const maintenance = await assertMaintenanceModeActive(db)
      productionSafety = { ...emptyProductionSafety(), maintenanceMode: maintenance }
    } catch (err) {
      if (!(err instanceof ProductionSafetyError)) throw err
      console.error(`Production safety: ${err.message}`)
      const report: MembershipBackfillReport = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        mode: 'rollback-from-report',
        environment,
        projectId,
        sourceGitSha: readSourceGitSha(),
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        counts: emptyCounts(),
        sourceChecksum: '', sourceStateChecksum: '', decisionsChecksum: '', targetChecksum: '', observedChecksum: null, readBackError: null,
        conflicts: [], orphans: [], ownerAnomalies: [], unknownUsers: [], malformedClaims: [], danglingMemberships: [],
        ownerIdAnomalies: [], staleDecisions: [], unusedDecisions: [],
        plannedCreates: [], createdPaths: [], writeFailures: [],
        verification: { performed: false, matchesTarget: false, missing: [], differing: [] },
        rollbackManifest: [],
        productionSafety: emptyProductionSafety(),
        emergencyReconstruction: null,
      }
      writeReport(reportPath, REPO_ROOT, report)
      printSafeSummary(report)
      return 3
    }
  }

  const removed: { companyId: string; uid: string; path: string }[] = []
  const refused: { companyId: string; uid: string; path: string; reason: string }[] = []

  for (const entry of validated.entries) {
    const result = await rollbackOneEntry(db, entry)
    if (result.ok) removed.push({ companyId: entry.companyId, uid: entry.uid, path: entry.path })
    else refused.push({ companyId: entry.companyId, uid: entry.uid, path: entry.path, reason: result.reason })
  }

  const sourceReport = sourceReportRaw as MembershipBackfillReport
  const report: MembershipBackfillReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: 'rollback-from-report',
    environment,
    projectId,
    sourceGitSha: readSourceGitSha(),
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    counts: { ...emptyCounts(), created: 0, skipped: 0, conflicts: refused.length, unresolved: refused.length },
    sourceChecksum: sourceReport.sourceChecksum,
    sourceStateChecksum: sourceReport.sourceStateChecksum,
    decisionsChecksum: sourceReport.decisionsChecksum,
    targetChecksum: sourceReport.targetChecksum,
    observedChecksum: null,
    readBackError: null,
    conflicts: refused.map(r => ({ companyId: r.companyId, uid: r.uid, reason: 'existing_membership_conflict' as const, evidenceFingerprint: computeFindingFingerprint({ rollbackRefusalReason: r.reason }) })),
    orphans: [],
    ownerAnomalies: [],
    unknownUsers: [],
    malformedClaims: [],
    danglingMemberships: [],
    ownerIdAnomalies: [],
    staleDecisions: [],
    unusedDecisions: [],
    plannedCreates: [],
    createdPaths: [],
    writeFailures: [],
    verification: { performed: false, matchesTarget: false, missing: [], differing: [] },
    rollbackManifest: removed,
    productionSafety,
    emergencyReconstruction: null,
  }
  writeReport(reportPath, REPO_ROOT, report)
  printSafeSummary(report)
  return refused.length > 0 ? 1 : 0
}

/**
 * `--mode rollback-from-plan` — final-round fix #7 ("no blind import").
 * Emergency, LAST-RESORT recovery for exactly one scenario: the actual
 * apply report has been lost, so `rollback-from-report` (the primary,
 * preferred rollback mechanism) cannot be used at all. This never falls
 * back to a Firestore `import` of the pre-apply backup — `import` cannot
 * delete anything (see MEMBERSHIP_BACKFILL.md, "Production rollback"), so
 * it could never undo the *creation* apply performed.
 *
 * This function is a thin CLI-orchestration wrapper — the actual
 * integrity-check → structural-validation → maintenance-check →
 * Firestore-reads/deletes sequence lives in
 * `scripts/lib/emergencyReconstruction.ts`'s `runEmergencyReconstruction()`
 * (final-round fix #1, third pass — extracted specifically so that ORDER
 * is directly unit-testable with a read-counting fake Firestore, since
 * this file cannot itself be `import`ed by a unit test without executing
 * the whole CLI via its own module-level `main()` call below). See that
 * module's doc comment for the full per-candidate contract (exact match
 * required, strict schema validation, `lastUpdateTime` delete
 * precondition, REFUSED never guessed at). If no verified dry-run report
 * exists either, the operator has no automated path at all —
 * MEMBERSHIP_BACKFILL.md's "Emergency scenario: apply-report lost"
 * documents this as an honest BLOCKED / manual-recovery case, not
 * something this function pretends to solve.
 */
async function runRollbackFromPlan(
  db: import('firebase-admin/firestore').Firestore,
  fromPlanPath: string,
  environment: Environment,
  projectId: string,
  runId: string,
  startedAt: string,
  reportPath: string,
  opts: CliOptions,
): Promise<number> {
  function baseReport(): MembershipBackfillReport {
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      mode: 'rollback-from-plan',
      environment,
      projectId,
      sourceGitSha: readSourceGitSha(),
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: emptyCounts(),
      sourceChecksum: '', sourceStateChecksum: '', decisionsChecksum: '', targetChecksum: '', observedChecksum: null, readBackError: null,
      conflicts: [], orphans: [], ownerAnomalies: [], unknownUsers: [], malformedClaims: [], danglingMemberships: [],
      ownerIdAnomalies: [], staleDecisions: [], unusedDecisions: [],
      plannedCreates: [], createdPaths: [], writeFailures: [],
      verification: { performed: false, matchesTarget: false, missing: [], differing: [] },
      rollbackManifest: [],
      productionSafety: emptyProductionSafety(),
      emergencyReconstruction: null,
    }
  }

  // Delegated to scripts/lib/emergencyReconstruction.ts — see that
  // module's doc comment for exactly why (the safety-critical operation
  // order needs to be unit-testable with a read-counting fake Firestore,
  // which this CLI file's own module-level main() call prevents).
  const result = await runEmergencyReconstruction({
    db, fromPlanPath, environment, projectId,
    expectedPlanSha256: opts.expectedPlanSha256,
    ackMaintenance: opts.ackMaintenance,
  })

  if (!result.ok) {
    console.error(`Emergency reconstruction refused: ${result.errorMessage}`)
    const report = baseReport()
    writeReport(reportPath, REPO_ROOT, report)
    printSafeSummary(report)
    return result.exitCode
  }

  const { removed, skippedNotFound, refused, sourceDryRunSha256, targetChecksum, maintenanceMode } = result.outcome
  const emergencyReconstruction: EmergencyReconstructionAudit = { sourceDryRunSha256, skippedNotFound, refused }
  const productionSafety: ProductionSafetyAudit = maintenanceMode === null
    ? emptyProductionSafety()
    : { ...emptyProductionSafety(), maintenanceMode }

  const report: MembershipBackfillReport = {
    ...baseReport(),
    counts: { ...emptyCounts(), conflicts: refused.length, unresolved: refused.length },
    targetChecksum,
    conflicts: refused.map(r => ({ companyId: r.companyId, uid: r.uid, reason: 'existing_membership_conflict' as const, evidenceFingerprint: computeFindingFingerprint({ rollbackRefusalReason: r.reason }) })),
    rollbackManifest: removed,
    productionSafety,
    emergencyReconstruction,
  }
  writeReport(reportPath, REPO_ROOT, report)
  printSafeSummary(report)
  return refused.length > 0 ? 1 : 0
}

main().then(code => { process.exitCode = code }).catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
