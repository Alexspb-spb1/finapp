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
import { assertEnvironmentGuard, initFirestore, EnvironmentGuardError, type Environment } from './lib/firebaseAdmin.ts'
import { extractLegacyRelations } from './lib/legacyMapping.ts'
import { validateDecisions } from './lib/decisions.ts'
import { buildPlan } from './lib/planner.ts'
import { readAllUsers, readAllCompanies, readAllExistingMemberships, computeExistingActiveAdmins } from './lib/firestoreReaders.ts'
import { computeRelationSetChecksum, computeDecisionsChecksum, canonicalStringify, sha256Hex, sortRelations } from './lib/checksum.ts'
import { writeReport, printSafeSummary, REPORT_SCHEMA_VERSION, type MembershipBackfillReport, type ReportCounts, type CreatedPathRecord, type WriteFailureRecord } from './lib/report.ts'
import { relationKey, type Decision, type ConfirmedRelation } from './lib/types.ts'

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
    missingCompanies: 0, missingUsers: 0, ownerWithoutAdminMembership: 0, unresolved: 0,
  }
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

  if (environment === 'production' && opts.mode !== 'verify') {
    if (!opts.backupReference || !opts.rollbackReference || !opts.ackMaintenance) {
      console.error('Production requires --backup-reference, --rollback-reference, and --ack-maintenance-readonly.')
      return 3
    }
  }
  // This cycle (SEC-005 Phase A): staging/production execution is not
  // authorized regardless of flags — the guard above proves the CLI WOULD
  // enforce the right preconditions, but no external run happens here.
  if (environment !== 'emulator') {
    console.error(`Refusing to run against --environment ${environment} in this cycle: staging rehearsal and production backfill require separate, explicit authorization (see docs/migrations/MEMBERSHIP_BACKFILL.md).`)
    return 4
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
    return runRollback(db, opts.fromReport!, environment, expectedProjectId, runId, startedAt, opts.reportPath!)
  }

  const [users, companies, existingMemberships] = await Promise.all([
    readAllUsers(db), readAllCompanies(db), readAllExistingMemberships(db),
  ])
  const existingActiveAdmins = computeExistingActiveAdmins(existingMemberships)
  const extraction = extractLegacyRelations(users, companies)
  const plan = buildPlan({ extraction, decisions: decisionsResult.decisions, existingMemberships, existingActiveAdmins })

  const targetRelations = [
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
    unresolved: plan.unresolvedConflicts.length + plan.unresolvedOrphans.length + plan.unresolvedOwnerAnomalies.length + plan.companiesWithoutAdmin.length,
  }

  const createdPaths: CreatedPathRecord[] = []
  const writeFailures: WriteFailureRecord[] = []
  let observedChecksum: string | null = null

  if (opts.mode === 'apply') {
    if (!plan.applyAllowed) {
      console.error(`Apply refused: ${counts.unresolved} unresolved item(s) (conflicts/orphans/owner-anomalies/companies-without-admin). Resolve via --decisions-file and retry.`)
    } else {
      for (const create of plan.plannedCreates) {
        const ref = db.collection('companies').doc(create.companyId).collection('members').doc(create.uid)
        try {
          const now = new Date()
          await ref.create({
            uid: create.uid,
            role: create.role,
            status: create.status,
            createdAt: now,
            updatedAt: now,
            ...(create.invitedBy ? { invitedBy: create.invitedBy } : {}),
          })
          const written = await ref.get()
          createdPaths.push({
            companyId: create.companyId, uid: create.uid, path: ref.path,
            createTimeIso: written.createTime?.toDate().toISOString(),
            updateTimeIso: written.updateTime?.toDate().toISOString(),
          })
          counts.created += 1
        } catch (err) {
          writeFailures.push({ companyId: create.companyId, uid: create.uid, error: err instanceof Error ? err.message : 'unknown error' })
        }
      }
      const readBack = await readAllExistingMemberships(db)
      observedChecksum = computeRelationSetChecksum([
        ...plan.plannedCreates.map(c => {
          const data = readBack.get(relationKey(c.companyId, c.uid))
          return { companyId: c.companyId, uid: c.uid, role: (data?.role as string) ?? c.role, status: (data?.status as string) ?? c.status }
        }),
        ...plan.skipped.map(s => {
          const data = readBack.get(relationKey(s.companyId, s.uid))
          return { companyId: s.companyId, uid: s.uid, role: (data?.role as string) ?? 'unknown', status: (data?.status as string) ?? 'unknown' }
        }),
      ])
    }
  }

  if (opts.mode === 'verify') {
    observedChecksum = computeRelationSetChecksum(targetRelations.map(r => {
      const data = existingMemberships.get(relationKey(r.companyId, r.uid))
      return { companyId: r.companyId, uid: r.uid, role: (data?.role as string) ?? 'MISSING', status: (data?.status as string) ?? 'MISSING' }
    }))
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
    conflicts: plan.unresolvedConflicts,
    orphans: plan.unresolvedOrphans,
    ownerAnomalies: plan.unresolvedOwnerAnomalies,
    plannedCreates: plan.plannedCreates,
    createdPaths,
    writeFailures,
    verification: {
      performed: opts.mode === 'verify',
      matchesTarget: opts.mode === 'verify' ? observedChecksum === targetChecksum : false,
      missing: opts.mode === 'verify' ? targetRelations.filter(r => !existingMemberships.has(relationKey(r.companyId, r.uid))).map(r => ({ companyId: r.companyId, uid: r.uid })) : [],
      differing: [],
    },
    rollbackManifest: createdPaths.map(c => ({ companyId: c.companyId, uid: c.uid, path: c.path })),
  }

  writeReport(opts.reportPath!, REPO_ROOT, report)
  printSafeSummary(report)

  if (opts.mode === 'apply' && !plan.applyAllowed) return 1
  if (opts.mode === 'apply' && writeFailures.length > 0) return 1
  if (opts.mode === 'verify' && !report.verification.matchesTarget) return 1
  return 0
}

async function runRollback(
  db: import('firebase-admin/firestore').Firestore,
  fromReportPath: string,
  environment: Environment,
  projectId: string,
  runId: string,
  startedAt: string,
  reportPath: string,
): Promise<number> {
  let sourceReport: MembershipBackfillReport
  try {
    sourceReport = JSON.parse(readFileSync(fromReportPath, 'utf8')) as MembershipBackfillReport
  } catch {
    console.error('Failed to read/parse --from-report.')
    return 2
  }

  const removed: { companyId: string; uid: string; path: string }[] = []
  const refused: { companyId: string; uid: string; path: string; reason: string }[] = []

  for (const entry of sourceReport.rollbackManifest) {
    const createdRecord = sourceReport.createdPaths.find(c => c.companyId === entry.companyId && c.uid === entry.uid)
    const ref = db.collection('companies').doc(entry.companyId).collection('members').doc(entry.uid)
    const snap = await ref.get()
    if (!snap.exists) { refused.push({ ...entry, reason: 'document no longer exists' }); continue }
    const data = snap.data()!
    if (data.uid !== entry.uid) { refused.push({ ...entry, reason: 'uid no longer matches' }); continue }
    if (data.status !== 'active') { refused.push({ ...entry, reason: 'status changed since backfill' }); continue }
    const createTimeIso = snap.createTime?.toDate().toISOString()
    const updateTimeIso = snap.updateTime?.toDate().toISOString()
    if (!createdRecord?.createTimeIso || createTimeIso !== createdRecord.createTimeIso) {
      refused.push({ ...entry, reason: 'createTime metadata no longer matches the backfill run - possibly recreated' }); continue
    }
    if (!createdRecord?.updateTimeIso || updateTimeIso !== createdRecord.updateTimeIso) {
      refused.push({ ...entry, reason: 'document was modified after the backfill run' }); continue
    }
    await ref.delete()
    removed.push(entry)
  }

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
    conflicts: refused.map(r => ({ companyId: r.companyId, uid: r.uid, reason: 'existing_membership_conflict' as const })),
    orphans: [],
    ownerAnomalies: [],
    plannedCreates: [],
    createdPaths: [],
    writeFailures: [],
    verification: { performed: false, matchesTarget: false, missing: [], differing: [] },
    rollbackManifest: removed,
  }
  writeReport(reportPath, REPO_ROOT, report)
  printSafeSummary(report)
  return refused.length > 0 ? 1 : 0
}

main().then(code => { process.exitCode = code }).catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
