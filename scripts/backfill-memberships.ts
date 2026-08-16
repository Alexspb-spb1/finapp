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
import { computeRelationSetChecksum, computeDecisionsChecksum, canonicalStringify, sha256Hex, sortRelations } from './lib/checksum.ts'
import { assertPathOutsideRepo, UnsafePathError } from './lib/pathSafety.ts'
import { validateSourceReportForRollback } from './lib/rollbackValidation.ts'
import { computeObservedState, type TargetRelation } from './lib/observedState.ts'
import { createPlannedRelations, readBackObservedState } from './lib/applyWrites.ts'
import {
  writeReport, assertReportPathWritable, printSafeSummary, REPORT_SCHEMA_VERSION,
  type MembershipBackfillReport, type ReportCounts, type CreatedPathRecord, type WriteFailureRecord, type ProductionSafetyAudit,
} from './lib/report.ts'
import {
  assertMaintenanceModeActive, verifyBackupReference, verifyRollbackPlanReference, sha256OfFile, ProductionSafetyError,
} from './lib/productionSafety.ts'
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
    unknownUsers: 0, malformedClaims: 0, danglingMemberships: 0, unresolved: 0,
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
  try {
    assertPathOutsideRepo('--report-path', opts.reportPath!, REPO_ROOT)
    if (opts.decisionsFile) assertPathOutsideRepo('--decisions-file', opts.decisionsFile, REPO_ROOT)
    if (opts.fromReport) assertPathOutsideRepo('--from-report', opts.fromReport, REPO_ROOT)
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
  // gate. Production remains UNCONDITIONALLY refused: assertCycleExecutionAllowed()
  // never lets 'production' through, regardless of the flags checked just
  // above — no PRODUCTION_ACTION_APPROVED grant has been given this cycle.
  try {
    assertCycleExecutionAllowed(environment)
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

  const runId = randomUUID()
  const startedAt = new Date().toISOString()
  const db = initFirestore(expectedProjectId)

  if (opts.mode === 'rollback-from-report') {
    return runRollback(db, opts.fromReport!, environment, expectedProjectId, runId, startedAt, opts.reportPath!, opts)
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
    unresolved: plan.unresolvedConflicts.length + plan.unresolvedOrphans.length + plan.unresolvedOwnerAnomalies.length + plan.companiesWithoutAdmin.length + plan.unknownUsers.length + plan.malformedClaims.length + plan.danglingMemberships.length,
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
      console.error(`Apply refused: ${counts.unresolved} unresolved item(s) (conflicts/orphans/owner-anomalies/companies-without-admin/dangling-memberships). Resolve via --decisions-file and retry — dangling memberships require repairing the underlying data, no decision can clear them.`)
    } else {
      // Independent review fix #5/6/7 (production preflight, follow-up
      // round): for a PRODUCTION apply, verify (not merely accept as
      // present) backup-reference, rollback-reference (pre-apply plan,
      // cross-checked against THIS run's own targetChecksum — see
      // productionSafety.ts for why this resolves the circular
      // ROLLBACK_REFERENCE problem), and that maintenance mode is
      // ACTUALLY active right now (a real Firestore read, not an honor-
      // system flag). Any failure refuses before a single write —
      // `--ack-maintenance-readonly` remains required too, as an explicit
      // additional human acknowledgement on top of the real check, not a
      // substitute for it.
      let productionSafetyOk = true
      if (environment === 'production') {
        try {
          if (!opts.backupReference) throw new ProductionSafetyError('--backup-reference is required for a production apply.')
          const backupRef = verifyBackupReference(opts.backupReference, expectedProjectId)
          if (!opts.rollbackReference) throw new ProductionSafetyError('--rollback-reference is required for a production apply.')
          const rollbackPlanRef = verifyRollbackPlanReference(opts.rollbackReference, targetChecksum)
          if (!opts.ackMaintenance) throw new ProductionSafetyError('--ack-maintenance-readonly is required for a production apply.')
          const maintenance = await assertMaintenanceModeActive(db)
          productionSafety = {
            maintenanceMode: maintenance,
            backupReference: { sha256: backupRef.sha256, createdAtUtc: backupRef.createdAtUtc },
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
    sourceGitSha: readSourceGitSha(),
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    counts,
    sourceChecksum,
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
  if (opts.mode === 'apply' && environment === 'production' && createdPaths.length > 0) {
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
  let sourceReportRaw: unknown
  try {
    sourceReportRaw = JSON.parse(readFileSync(fromReportPath, 'utf8'))
  } catch {
    console.error('Failed to read/parse --from-report.')
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
      sourceChecksum: '', decisionsChecksum: '', targetChecksum: '', observedChecksum: null, readBackError: null,
      conflicts: [], orphans: [], ownerAnomalies: [], unknownUsers: [], malformedClaims: [], danglingMemberships: [],
      plannedCreates: [], createdPaths: [], writeFailures: [],
      verification: { performed: false, matchesTarget: false, missing: [], differing: [] },
      rollbackManifest: [],
      productionSafety: emptyProductionSafety(),
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
        sourceChecksum: '', decisionsChecksum: '', targetChecksum: '', observedChecksum: null, readBackError: null,
        conflicts: [], orphans: [], ownerAnomalies: [], unknownUsers: [], malformedClaims: [], danglingMemberships: [],
        plannedCreates: [], createdPaths: [], writeFailures: [],
        verification: { performed: false, matchesTarget: false, missing: [], differing: [] },
        rollbackManifest: [],
        productionSafety: emptyProductionSafety(),
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
    decisionsChecksum: sourceReport.decisionsChecksum,
    targetChecksum: sourceReport.targetChecksum,
    observedChecksum: null,
    readBackError: null,
    conflicts: refused.map(r => ({ companyId: r.companyId, uid: r.uid, reason: 'existing_membership_conflict' as const })),
    orphans: [],
    ownerAnomalies: [],
    unknownUsers: [],
    malformedClaims: [],
    danglingMemberships: [],
    plannedCreates: [],
    createdPaths: [],
    writeFailures: [],
    verification: { performed: false, matchesTarget: false, missing: [], differing: [] },
    rollbackManifest: removed,
    productionSafety,
  }
  writeReport(reportPath, REPO_ROOT, report)
  printSafeSummary(report)
  return refused.length > 0 ? 1 : 0
}

main().then(code => { process.exitCode = code }).catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
