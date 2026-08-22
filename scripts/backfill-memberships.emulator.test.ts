// Real Firestore Emulator proof for scripts/backfill-memberships.ts —
// SEC-005. Every test here spawns the ACTUAL CLI as a child process (the
// same way an operator would run it) against the real Firestore Emulator —
// no mock-only evidence for apply/idempotency/rollback (task requirement).
//
// Run only via `npm run test:migration` (`firebase emulators:exec --project
// demo-finapp --only firestore "vitest run scripts --no-file-parallelism"`),
// which sets FIRESTORE_EMULATOR_HOST/GCLOUD_PROJECT for this process
// automatically. `--no-file-parallelism` matters here specifically because
// scripts/ops/set-maintenance-mode.emulator.test.ts ALSO wipes this same
// shared `demo-finapp` project in its own beforeEach — running both files
// in parallel worker threads (vitest's default) lets their wipes race each
// other and produces spurious failures unrelated to any real code defect.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore'
import type { MembershipBackfillReport } from './lib/report.ts'
import { sha256Hex, computeFindingFingerprint } from './lib/checksum.ts'
import type { Decision, FindingType } from './lib/types.ts'

/** Builds a well-formed Decision for these end-to-end fixtures — defaults
 * to a placeholder findingType/evidenceFingerprint that is always VALID
 * (passes decisions.ts's schema/compatibility checks) but matches nothing
 * in a real plan, so a decision only needs its real findingType/evidence
 * overridden when the test specifically depends on it being HONORED. */
function decision(overrides: Partial<Decision> & { uid: string }): Decision {
  return {
    findingType: 'existing_membership_conflict' as FindingType,
    evidenceFingerprint: computeFindingFingerprint({}),
    resolution: 'exclude',
    reason: 'test decision',
    reviewedBy: 'alice',
    reviewedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const PROJECT_ID = 'demo-finapp'
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** Final-round fix #6: --mode rollback-from-report now requires
 * --expected-report-sha256, computed the SAME way the CLI itself does
 * (sha256Hex over the raw file bytes) — so tests can supply the correct
 * value and actually exercise the DOWNSTREAM structural validation, rather
 * than being rejected earlier by the integrity check itself. */
function sha256OfReportFile(path: string): string {
  return sha256Hex(readFileSync(path, 'utf8'))
}

let db: Firestore

beforeAll(() => {
  const app = getApps().length > 0 ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID })
  db = getFirestore(app)
})

// The CLI always reads the FULL users/companies/members collections (that's
// its real, production behavior — it has no per-run scoping). Without
// clearing between tests, one test's leftover seed data would be picked up
// by the next test's apply and inflate/interfere with its counts. The
// Firestore Emulator's clear-data endpoint gives each test a clean slate —
// this is also what proves "no fixture residue after emulator tests"
// (task requirement).
beforeEach(async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' })
})

function reportPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sec005-report-'))
  return join(dir, 'report.json')
}

function decisionsFile(decisions: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'sec005-decisions-'))
  const path = join(dir, 'decisions.json')
  writeFileSync(path, JSON.stringify(decisions))
  return path
}

interface CliResult { code: number; stdout: string; stderr: string; report: MembershipBackfillReport | undefined }

function runCli(args: string[]): CliResult {
  const result = spawnSync('node', ['scripts/backfill-memberships.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
  })
  const reportPathArg = args[args.indexOf('--report-path') + 1]
  let report: MembershipBackfillReport | undefined
  if (reportPathArg && existsSync(reportPathArg)) {
    report = JSON.parse(readFileSync(reportPathArg, 'utf8')) as MembershipBackfillReport
  }
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, report }
}

function baseArgs(mode: string, extra: string[] = []): string[] {
  return ['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', mode, ...extra]
}

/** Like runCli(), but with an explicit env object instead of inheriting
 * process.env verbatim — needed for the staging/production authorization
 * tests below, since `firebase emulators:exec` (which runs this whole
 * suite) sets FIRESTORE_EMULATOR_HOST/GCLOUD_PROJECT on this process,
 * which would otherwise make assertEnvironmentGuard() refuse a
 * --environment production invocation for an unrelated reason (ambiguous
 * emulator-host / project-ID conflict) before ever reaching the
 * cycle-authorization gate this test actually targets. */
function runCliWithEnv(args: string[], env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync('node', ['scripts/backfill-memberships.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  })
  const reportPathArg = args[args.indexOf('--report-path') + 1]
  let report: MembershipBackfillReport | undefined
  if (reportPathArg && existsSync(reportPathArg)) {
    report = JSON.parse(readFileSync(reportPathArg, 'utf8')) as MembershipBackfillReport
  }
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, report }
}

async function seedUser(uid: string, data: Record<string, unknown>): Promise<void> {
  await db.collection('users').doc(uid).set(data)
}
async function seedCompany(companyId: string, data: Record<string, unknown> = {}): Promise<void> {
  await db.collection('companies').doc(companyId).set(data)
}
async function seedExistingMembership(companyId: string, uid: string, data: Record<string, unknown>): Promise<void> {
  await db.collection('companies').doc(companyId).collection('members').doc(uid).set(data)
}
async function getMembership(companyId: string, uid: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection('companies').doc(companyId).collection('members').doc(uid).get()
  return snap.exists ? snap.data() : undefined
}

function uniqueId(label: string): string {
  return `${label}_${randomUUID().replace(/-/g, '')}`
}

describe('backfill-memberships CLI — real Firestore Emulator', { timeout: 20_000 }, () => {
  it('no --mode flag defaults to dry-run and writes zero documents', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })

    const args = ['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath()]
    const result = runCli(args)

    expect(result.report?.mode).toBe('dry-run')
    expect(await getMembership(companyId, uid)).toBeUndefined()
  })

  it('apply migrates a valid primary (home) legacy membership', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(0)
    expect(result.report?.counts.created).toBe(1)
    const membership = await getMembership(companyId, uid)
    expect(membership).toMatchObject({ uid, role: 'admin', status: 'active' })
    expect(membership?.createdAt).toBeInstanceOf(Timestamp)
    expect(membership?.updatedAt).toBeInstanceOf(Timestamp)
    expect('invitedBy' in (membership ?? {})).toBe(false) // never invented
  })

  it('a company with only a viewer and no admin blocks the ENTIRE apply — zero documents written', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'viewer' })

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(1)
    expect(result.report?.counts.created).toBe(0)
    expect(await getMembership(companyId, uid)).toBeUndefined()
  })

  it('an unknown legacy role never becomes admin — apply refuses and creates nothing', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'superadmin' })

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(1)
    expect(result.report?.counts.created).toBe(0)
    expect(await getMembership(companyId, uid)).toBeUndefined()
  })

  it('a missing company never creates a membership document', async () => {
    const uid = uniqueId('u'); const ghostCompanyId = uniqueId('co_ghost')
    await seedUser(uid, { companyId: ghostCompanyId, role: 'admin' })

    const result = runCli(baseArgs('apply'))
    // The unresolved orphan alone blocks apply — but even so, nothing for
    // a nonexistent company could ever be written.
    expect(await getMembership(ghostCompanyId, uid)).toBeUndefined()
    expect(result.report?.counts.missingCompanies).toBeGreaterThanOrEqual(1)
  })

  it('an owner without a confirmed admin membership does NOT get auto-admin', async () => {
    const ownerUid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId, { ownerId: ownerUid })
    await seedUser(ownerUid, {}) // exists, but no companyId/role claim at all

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(1)
    expect(await getMembership(companyId, ownerUid)).toBeUndefined()
    expect(result.report?.counts.ownerWithoutAdminMembership).toBeGreaterThanOrEqual(1)
  })

  it('an existing exactly-matching membership is skipped, not rewritten', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const now = Timestamp.now()
    await seedExistingMembership(companyId, uid, { uid, role: 'admin', status: 'active', createdAt: now, updatedAt: now })

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(0)
    expect(result.report?.counts.created).toBe(0)
    expect(result.report?.counts.skipped).toBeGreaterThanOrEqual(1)
    const membership = await getMembership(companyId, uid)
    expect((membership?.createdAt as Timestamp).isEqual(now)).toBe(true) // untouched
  })

  it('an existing DIFFERING membership is never overwritten — apply refuses', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const now = Timestamp.now()
    await seedExistingMembership(companyId, uid, { uid, role: 'viewer', status: 'active', createdAt: now, updatedAt: now })

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(1)
    const membership = await getMembership(companyId, uid)
    expect(membership?.role).toBe('viewer') // untouched
  })

  it('a valid confirm_role decision resolves a role conflict and creates the confirmed membership', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin', companies: [{ companyId, role: 'viewer' }] })

    const roleMismatchEvidence = { sourceKinds: ['users.companies[]', 'users.home'], observedRoles: ['admin', 'viewer'], hasInvalidRole: false }
    const decisions = decisionsFile([decision({ uid, companyId, findingType: 'role_mismatch', evidenceFingerprint: computeFindingFingerprint(roleMismatchEvidence), resolution: 'confirm_role', role: 'admin', reason: 'checked with owner' })])
    const result = runCli(baseArgs('apply', ['--decisions-file', decisions]))

    expect(result.code).toBe(0)
    expect(result.report?.counts.created).toBe(1)
    expect((await getMembership(companyId, uid))?.role).toBe('admin')
  })

  it('an invalid decisions file is rejected before any Firestore write', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const decisions = decisionsFile([decision({ uid, companyId, findingType: 'role_mismatch', evidenceFingerprint: computeFindingFingerprint({}), resolution: 'bogus_resolution' as Decision['resolution'], reason: 'x' })])

    const result = runCli(baseArgs('apply', ['--decisions-file', decisions]))

    expect(result.code).toBe(2)
    expect(await getMembership(companyId, uid)).toBeUndefined()
  })

  it('a project ID that does not match --environment is refused before any Firestore I/O', async () => {
    const args = ['--environment', 'emulator', '--project', 'not-demo-finapp', '--report-path', reportPath(), '--mode', 'apply']
    const result = runCli(args)
    expect(result.code).toBe(3)
    expect(result.report).toBeUndefined() // no report even written — refused before doing anything
  })

  it('repeated apply with the same source data creates 0 new docs, changes 0, and preserves timestamps (idempotency)', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })

    const first = runCli(baseArgs('apply'))
    expect(first.report?.counts.created).toBe(1)
    const afterFirst = await getMembership(companyId, uid)

    const second = runCli(baseArgs('apply'))
    expect(second.code).toBe(0)
    expect(second.report?.counts.created).toBe(0)
    expect(second.report?.counts.skipped).toBeGreaterThanOrEqual(1)
    const afterSecond = await getMembership(companyId, uid)
    expect((afterSecond?.createdAt as Timestamp).isEqual(afterFirst!.createdAt as Timestamp)).toBe(true)
    expect((afterSecond?.updatedAt as Timestamp).isEqual(afterFirst!.updatedAt as Timestamp)).toBe(true)

    expect(first.report?.targetChecksum).toBe(second.report?.targetChecksum)
  })

  it('verify detects a membership document that was deleted after apply', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    runCli(baseArgs('apply'))
    await db.collection('companies').doc(companyId).collection('members').doc(uid).delete()

    const result = runCli(baseArgs('verify'))

    expect(result.code).toBe(1)
    expect(result.report?.verification.matchesTarget).toBe(false)
    expect(result.report?.verification.missing).toContainEqual({ companyId, uid })
  })

  it('rollback-from-report removes only the documents created by that run', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const applyReportPath = reportPath()
    const applyResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', applyReportPath, '--mode', 'apply'])
    expect(applyResult.report?.counts.created).toBe(1)
    expect(await getMembership(companyId, uid)).toBeDefined()

    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', applyReportPath, '--expected-report-sha256', sha256OfReportFile(applyReportPath)])

    expect(rollbackResult.code).toBe(0)
    expect(await getMembership(companyId, uid)).toBeUndefined()
  })

  it('rollback refuses to delete a document that was modified after the backfill run', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const applyReportPath = reportPath()
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', applyReportPath, '--mode', 'apply'])

    // Simulate a post-backfill modification (e.g. a real admin change).
    await db.collection('companies').doc(companyId).collection('members').doc(uid).set({ uid, role: 'viewer', status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() })

    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', applyReportPath, '--expected-report-sha256', sha256OfReportFile(applyReportPath)])

    expect(rollbackResult.code).toBe(1)
    expect(await getMembership(companyId, uid)).toBeDefined() // NOT deleted
  })

  // ── Final-round fix #6: --expected-report-sha256 verified before any parsing/I/O ──
  it('rollback refuses a --from-report that does not match --expected-report-sha256 (tampered or wrong file), before any parsing', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const applyReportPath = reportPath()
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', applyReportPath, '--mode', 'apply'])
    expect(await getMembership(companyId, uid)).toBeDefined()

    const wrongHash = '0'.repeat(64)
    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', applyReportPath, '--expected-report-sha256', wrongHash])

    expect(rollbackResult.code).toBe(3)
    expect(await getMembership(companyId, uid)).toBeDefined() // NOT deleted
  })

  it('rollback refuses a --from-report that was tampered AFTER being hashed — even a single byte change is caught', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const applyReportPath = reportPath()
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', applyReportPath, '--mode', 'apply'])
    const expectedHash = sha256OfReportFile(applyReportPath)

    // Tamper AFTER computing the hash the operator would have recorded —
    // simulates a swapped/edited report file.
    const tampered = JSON.parse(readFileSync(applyReportPath, 'utf8')) as MembershipBackfillReport
    ;(tampered as unknown as Record<string, unknown>).projectId = 'a-different-project'
    writeFileSync(applyReportPath, JSON.stringify(tampered))

    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', applyReportPath, '--expected-report-sha256', expectedHash])

    expect(rollbackResult.code).toBe(3)
    expect(await getMembership(companyId, uid)).toBeDefined() // NOT deleted
  })

  // ── Independent audit fix #1 ─────────────────────────────────────────────
  it('a company with NO relations at all still blocks apply if it has no admin', async () => {
    const companyId = uniqueId('co')
    await seedCompany(companyId) // nobody references this company at all

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(1)
    expect(result.report?.counts.created).toBe(0)
  })

  it('a CORRUPTED existing "admin" document does not satisfy the last-admin gate', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    const now = Timestamp.now()
    // Extra field makes this document invalid per the strict validator —
    // it must never count as a protecting admin.
    await seedExistingMembership(companyId, uid, { uid, role: 'admin', status: 'active', createdAt: now, updatedAt: now, tampered: true })

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(1)
    expect(result.report?.counts.created).toBe(0)
  })

  // ── Independent audit fix #2 ─────────────────────────────────────────────
  it('accept_existing does NOT resolve a corrupted existing membership (extra field)', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const now = Timestamp.now()
    await seedExistingMembership(companyId, uid, { uid, role: 'admin', status: 'active', createdAt: now, updatedAt: now, hacked: true })
    const decisions = decisionsFile([decision({ uid, companyId, findingType: 'existing_membership_conflict', evidenceFingerprint: computeFindingFingerprint({ existingRole: 'admin' }), resolution: 'accept_existing', reason: 'trying to force it through' })])

    const result = runCli(baseArgs('apply', ['--decisions-file', decisions]))

    expect(result.code).toBe(1)
  })

  it('accept_existing does NOT resolve a DISABLED existing membership', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const now = Timestamp.now()
    await seedExistingMembership(companyId, uid, { uid, role: 'admin', status: 'disabled', createdAt: now, updatedAt: now })
    const decisions = decisionsFile([decision({ uid, companyId, findingType: 'existing_membership_conflict', evidenceFingerprint: computeFindingFingerprint({ existingRole: 'admin' }), resolution: 'accept_existing', reason: 'trying to force it through' })])

    const result = runCli(baseArgs('apply', ['--decisions-file', decisions]))

    expect(result.code).toBe(1)
  })

  it('accept_existing DOES resolve a strictly-valid existing membership with a merely different role', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const now = Timestamp.now()
    await seedExistingMembership(companyId, uid, { uid, role: 'accountant', status: 'active', createdAt: now, updatedAt: now })
    const decisions = decisionsFile([decision({ uid, companyId, findingType: 'existing_membership_conflict', evidenceFingerprint: computeFindingFingerprint({ existingRole: 'accountant' }), resolution: 'accept_existing', reason: 'existing role is correct, legacy is stale' })])

    // NOTE: this company now has zero admin (existing role is accountant) —
    // the last-admin gate still legitimately blocks apply. This test only
    // proves accept_existing itself is accepted for the relation in
    // question (no existing_membership_conflict for that pair), by
    // inspecting the report's conflicts list directly.
    const result = runCli(baseArgs('apply', ['--decisions-file', decisions]))
    expect(result.report?.conflicts.some(c => c.reason === 'existing_membership_conflict')).toBe(false)
  })

  // ── Independent audit fix #3 ─────────────────────────────────────────────
  it('a tampered rollback source report (wrong projectId) is rejected without deleting anything', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const applyReportPath = reportPath()
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', applyReportPath, '--mode', 'apply'])
    expect(await getMembership(companyId, uid)).toBeDefined()

    const tampered = JSON.parse(readFileSync(applyReportPath, 'utf8')) as MembershipBackfillReport
    ;(tampered as unknown as Record<string, unknown>).projectId = 'a-different-project'
    const tamperedPath = reportPath()
    const tamperedContent = JSON.stringify(tampered)
    writeFileSync(tamperedPath, tamperedContent)

    // Hash the TAMPERED content itself — proves the integrity check passes
    // (the operator's recorded hash matches what's on disk) and it is the
    // DOWNSTREAM structural validation (wrong projectId) that refuses this,
    // not the integrity check from the previous test.
    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', tamperedPath, '--expected-report-sha256', sha256Hex(tamperedContent)])

    expect(rollbackResult.code).toBe(2)
    expect(await getMembership(companyId, uid)).toBeDefined() // NOT deleted
  })

  it('a rollback source report with mode !== apply is rejected without deleting anything', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const applyReportPath = reportPath()
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', applyReportPath, '--mode', 'apply'])

    const tampered = JSON.parse(readFileSync(applyReportPath, 'utf8')) as MembershipBackfillReport
    ;(tampered as unknown as Record<string, unknown>).mode = 'dry-run'
    const tamperedPath = reportPath()
    const tamperedContent = JSON.stringify(tampered)
    writeFileSync(tamperedPath, tamperedContent)

    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', tamperedPath, '--expected-report-sha256', sha256Hex(tamperedContent)])

    expect(rollbackResult.code).toBe(2)
    expect(await getMembership(companyId, uid)).toBeDefined() // NOT deleted
  })

  // ── Final-round fix #7: rollback-from-plan (emergency reconstruction, no blind import) ──
  describe('rollback-from-plan (emergency lost-apply-report reconstruction)', () => {
    it('deletes a live document that exactly matches the dry-run plan\'s planned candidate', async () => {
      const uid = uniqueId('u'); const companyId = uniqueId('co')
      await seedCompany(companyId)
      await seedUser(uid, { companyId, role: 'admin' })

      const dryRunPath = reportPath()
      const dryRunResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', dryRunPath, '--mode', 'dry-run'])
      expect(dryRunResult.report?.plannedCreates).toHaveLength(1)

      const applyResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'apply'])
      expect(applyResult.report?.counts.created).toBe(1)
      expect(await getMembership(companyId, uid)).toBeDefined()

      // Simulate the apply report being lost — only the dry-run report
      // (produced BEFORE apply, structurally identical to a genuine
      // --rollback-reference) survives.
      const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-plan', '--from-plan', dryRunPath, '--ack-emergency-reconstruction', '--expected-plan-sha256', sha256OfReportFile(dryRunPath)])

      expect(result.code).toBe(0)
      expect(await getMembership(companyId, uid)).toBeUndefined()
      expect(result.report?.emergencyReconstruction?.refused).toHaveLength(0)
      expect(result.report?.emergencyReconstruction?.skippedNotFound).toHaveLength(0)
    })

    it('skips (does not error on) a planned candidate with no live document — nothing to delete', async () => {
      const uid = uniqueId('u'); const companyId = uniqueId('co')
      await seedCompany(companyId)
      await seedUser(uid, { companyId, role: 'admin' })

      const dryRunPath = reportPath()
      runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', dryRunPath, '--mode', 'dry-run'])
      // Deliberately do NOT apply — the planned candidate was never created.

      const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-plan', '--from-plan', dryRunPath, '--ack-emergency-reconstruction', '--expected-plan-sha256', sha256OfReportFile(dryRunPath)])

      expect(result.code).toBe(0)
      expect(result.report?.emergencyReconstruction?.skippedNotFound).toEqual([{ companyId, uid }])
      expect(result.report?.emergencyReconstruction?.refused).toHaveLength(0)
    })

    it('refuses (never deletes) a live document whose role no longer matches the plan', async () => {
      const uid = uniqueId('u'); const companyId = uniqueId('co')
      await seedCompany(companyId)
      await seedUser(uid, { companyId, role: 'admin' })

      const dryRunPath = reportPath()
      runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', dryRunPath, '--mode', 'dry-run'])
      runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'apply'])
      expect(await getMembership(companyId, uid)).toBeDefined()

      // A real admin changed the role after apply — the live document no
      // longer exactly matches what the dry-run planned.
      const now = Timestamp.now()
      await db.collection('companies').doc(companyId).collection('members').doc(uid).set({ uid, role: 'viewer', status: 'active', createdAt: now, updatedAt: now })

      const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-plan', '--from-plan', dryRunPath, '--ack-emergency-reconstruction', '--expected-plan-sha256', sha256OfReportFile(dryRunPath)])

      expect(result.code).toBe(1)
      expect(result.report?.emergencyReconstruction?.refused).toHaveLength(1)
      expect(await getMembership(companyId, uid)).toBeDefined() // NOT deleted
    })

    it('refuses a --from-plan that is an apply report, not a dry-run report', async () => {
      const uid = uniqueId('u'); const companyId = uniqueId('co')
      await seedCompany(companyId)
      await seedUser(uid, { companyId, role: 'admin' })
      const applyReportPath = reportPath()
      runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', applyReportPath, '--mode', 'apply'])
      expect(await getMembership(companyId, uid)).toBeDefined()

      const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-plan', '--from-plan', applyReportPath, '--ack-emergency-reconstruction', '--expected-plan-sha256', sha256OfReportFile(applyReportPath)])

      expect(result.code).toBe(2)
      expect(await getMembership(companyId, uid)).toBeDefined() // NOT deleted — refused before any I/O
    })

    it('refuses a --from-plan dry-run report that still has unresolved items', async () => {
      const uid = uniqueId('u'); const companyId = uniqueId('co')
      await seedCompany(companyId)
      await seedUser(uid, { companyId, role: 'admin' })
      await seedUser(uniqueId('u2'), { companyId, role: 'bogus-unknown-role' })

      const dryRunPath = reportPath()
      const dryRunResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', dryRunPath, '--mode', 'dry-run'])
      expect(dryRunResult.report?.counts.unresolved).toBeGreaterThan(0)

      const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-plan', '--from-plan', dryRunPath, '--ack-emergency-reconstruction', '--expected-plan-sha256', sha256OfReportFile(dryRunPath)])

      expect(result.code).toBe(2)
    })

    // ── Final-round fix #1 (second round): --expected-plan-sha256 verified before any parsing/I/O ──
    it('refuses a FULL, well-formed dry-run report (with a matching EXISTING live membership) when --expected-plan-sha256 is wrong — zero Firestore reads/deletes', async () => {
      const uid = uniqueId('u'); const companyId = uniqueId('co')
      await seedCompany(companyId)
      await seedUser(uid, { companyId, role: 'admin' })

      const dryRunPath = reportPath()
      runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', dryRunPath, '--mode', 'dry-run'])
      runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'apply'])
      // A real, existing membership document now sits in Firestore, exactly
      // matching what the dry-run's plannedCreates describes.
      const before = await getMembership(companyId, uid)
      expect(before).toBeDefined()

      const wrongHash = '0'.repeat(64)
      const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-plan', '--from-plan', dryRunPath, '--ack-emergency-reconstruction', '--expected-plan-sha256', wrongHash])

      expect(result.code).toBe(3)
      // Proves the reconstruction loop (which reads then possibly deletes
      // each planned candidate) never ran at all: emergencyReconstruction
      // stays null (only ever populated AFTER the loop completes), not an
      // empty-but-present object.
      expect(result.report?.emergencyReconstruction).toBeNull()
      const after = await getMembership(companyId, uid)
      expect(after).toEqual(before) // byte-for-byte unchanged — never read-then-rewritten, never deleted
    })

    it('refuses a --from-plan tampered AFTER being hashed — even a single byte change is caught before parsing', async () => {
      const uid = uniqueId('u'); const companyId = uniqueId('co')
      await seedCompany(companyId)
      await seedUser(uid, { companyId, role: 'admin' })

      const dryRunPath = reportPath()
      runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', dryRunPath, '--mode', 'dry-run'])
      runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'apply'])
      const expectedHash = sha256OfReportFile(dryRunPath)

      // Tamper AFTER computing the hash the operator would have recorded.
      const tampered = JSON.parse(readFileSync(dryRunPath, 'utf8')) as MembershipBackfillReport
      ;(tampered as unknown as Record<string, unknown>).targetChecksum = '1'.repeat(64)
      writeFileSync(dryRunPath, JSON.stringify(tampered))

      const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-plan', '--from-plan', dryRunPath, '--ack-emergency-reconstruction', '--expected-plan-sha256', expectedHash])

      expect(result.code).toBe(3)
      expect(result.report?.emergencyReconstruction).toBeNull()
      expect(await getMembership(companyId, uid)).toBeDefined() // NOT deleted
    })
  })

  // ── Independent audit fix #5 ─────────────────────────────────────────────
  it('an invalid (in-repo) --report-path is refused and leaves zero writes', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const inRepoPath = join(REPO_ROOT, 'docs', `sec005-should-not-be-written-${randomUUID()}.json`)

    const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', inRepoPath, '--mode', 'apply'])

    expect(result.code).toBe(2)
    expect(existsSync(inRepoPath)).toBe(false)
    expect(await getMembership(companyId, uid)).toBeUndefined()
  })

  it('a --decisions-file INSIDE the repository is rejected before any Firestore I/O', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const inRepoDecisions = join(REPO_ROOT, 'package.json') // any real file inside the repo

    const result = runCli(baseArgs('apply', ['--decisions-file', inRepoDecisions]))

    expect(result.code).toBe(2)
    expect(await getMembership(companyId, uid)).toBeUndefined()
  })

  // ── Independent audit fix #6 ─────────────────────────────────────────────
  it('a user with no usable legacy relation is surfaced as unknown, not silently ignored', async () => {
    const uid = uniqueId('u')
    await seedUser(uid, { name: 'no legacy relation at all' })

    const result = runCli(baseArgs('dry-run'))

    expect(result.report?.unknownUsers).toContainEqual(expect.objectContaining({ uid, reason: 'no_usable_relations' }))
    expect(result.report?.counts.unknownUsers).toBeGreaterThanOrEqual(1)
  })

  it('a mixed valid+invalid role claim for the same pair becomes a conflict, not an auto-confirmed relation', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin', companies: [{ companyId, role: 'not-a-real-role' }] })

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(1)
    expect(result.report?.conflicts.some(c => c.reason === 'mixed_role_validity')).toBe(true)
    expect(await getMembership(companyId, uid)).toBeUndefined()
  })

  // ── Independent audit fix #7 ─────────────────────────────────────────────
  it('a "members" document NOT nested directly under companies/{companyId} is ignored entirely', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    // A foreign 'members' subcollection nested one level too deep — same
    // collectionGroup id ('members'), wrong overall path shape.
    await db.collection('companies').doc(companyId).collection('not_members_directly').doc('x').collection('members').doc(uid).set({
      uid, role: 'admin', status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    })

    const result = runCli(baseArgs('apply'))

    // The foreign document must not be picked up as an "existing" admin
    // membership, so the real (correct) path still needed a create.
    expect(result.code).toBe(0)
    expect(result.report?.counts.created).toBe(1)
    expect(result.report?.counts.existingMembershipsRead).toBe(0)
  })

  // ── Independent audit (2nd round) fix #1 ─────────────────────────────────
  it('verify returns a non-zero exit code when an existing membership is corrupted, even if role/status happen to match', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    runCli(baseArgs('apply'))
    expect(await getMembership(companyId, uid)).toBeDefined()

    // Corrupt the just-created document in place — right role/status, extra field.
    await seedExistingMembership(companyId, uid, { uid, role: 'admin', status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), injected: true })

    const result = runCli(baseArgs('verify'))

    // A fresh verify re-plans from scratch: the corrupted document is
    // re-classified by classifyExistingMembership() as 'invalid' BEFORE it
    // could ever become a target relation, so it surfaces as a blocking
    // existing_membership_conflict (not as an observedState `differing`
    // entry, which only ever applies to relations that WERE part of the
    // target). Either way, verify must refuse — proven here via the
    // conflict route; observedState's own schema-strict `differing` path is
    // proven directly and exhaustively in observedState.test.ts.
    expect(result.code).toBe(1)
    expect(result.report?.verification.matchesTarget).toBe(false)
    expect(result.report?.conflicts).toContainEqual(expect.objectContaining({ companyId, uid, reason: 'existing_membership_conflict' }))
  })

  it('verify cannot pass with an unresolved conflict, even when target and observed are both empty (no false PASS via empty-checksum equality)', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    // Two different valid roles for the same pair -> unresolved role_mismatch conflict.
    // Nothing is ever planned for this pair, so target relations stay empty
    // and nothing was ever applied, so observed relations stay empty too —
    // an empty-array checksum would trivially "match" without the
    // plan.applyAllowed gate.
    await seedUser(uid, { companyId, role: 'admin', companies: [{ companyId, role: 'viewer' }] })

    const result = runCli(baseArgs('verify'))

    expect(result.code).toBe(1)
    expect(result.report?.verification.matchesTarget).toBe(false)
    expect(result.report?.conflicts.some(c => c.reason === 'role_mismatch')).toBe(true)
  })

  // ── Independent audit (2nd round) fix #2 ─────────────────────────────────
  it('a plain {seconds,nanoseconds} admin document (not a real Timestamp) does not satisfy the last-admin gate', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    // A hand-crafted JSON-shaped "Timestamp" — exactly what a real Timestamp
    // serializes to, but never actually written by the Admin SDK's own
    // Timestamp type. Firestore happily stores it as a plain map.
    const fakeTs = { seconds: 1700000000, nanoseconds: 0 }
    await seedExistingMembership(companyId, uid, { uid, role: 'admin', status: 'active', createdAt: fakeTs, updatedAt: fakeTs })

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(1)
    expect(result.report?.counts.created).toBe(0)
  })

  // ── Independent audit (2nd round) fix #3 ─────────────────────────────────
  it('an unknown user (no usable legacy relation) blocks BOTH apply and verify until acknowledged', async () => {
    const uid = uniqueId('u')
    await seedUser(uid, { name: 'no legacy relation at all' })

    const applyResult = runCli(baseArgs('apply'))
    expect(applyResult.code).toBe(1)
    expect(applyResult.report?.unknownUsers).toContainEqual(expect.objectContaining({ uid, reason: 'no_usable_relations' }))

    const verifyResult = runCli(baseArgs('verify'))
    expect(verifyResult.code).toBe(1)
    expect(verifyResult.report?.verification.matchesTarget).toBe(false)
  })

  it('a user-level exclude decision unblocks apply for an acknowledged unknown user', async () => {
    const uid = uniqueId('u')
    await seedUser(uid, { name: 'no legacy relation at all' })
    const decisions = decisionsFile([decision({ uid, companyId: undefined, findingType: 'no_usable_relations', evidenceFingerprint: computeFindingFingerprint({}), resolution: 'exclude', reason: 'confirmed dead account' })])

    const result = runCli(baseArgs('apply', ['--decisions-file', decisions]))

    expect(result.code).toBe(0)
    expect(result.report?.unknownUsers).toEqual([])
  })

  it('a malformed companies[] entry blocks apply until acknowledged', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    // A usable primary claim PLUS a malformed companies[] entry — this user
    // is not "unknown" (has a usable claim), but the malformed entry alone
    // must still block apply.
    await seedUser(uid, { companyId, role: 'admin', companies: [{ role: 'viewer' }] }) // missing companyId in the entry

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(1)
    expect(result.report?.malformedClaims).toContainEqual(expect.objectContaining({ uid, reason: 'malformed_companies_entry' }))
    expect(await getMembership(companyId, uid)).toBeUndefined()
  })

  // ── Independent audit (2nd round) fix #4 ─────────────────────────────────
  it('an id-mismatched user with NO usable claims is surfaced as unknown, not silently dropped', async () => {
    const uid = uniqueId('u')
    await seedUser(uid, { id: 'someone_else', name: 'id mismatch, no companyId/companies[] at all' })

    const result = runCli(baseArgs('dry-run'))

    expect(result.report?.unknownUsers).toContainEqual(expect.objectContaining({ uid, reason: 'no_usable_relations' }))
  })

  // ── Independent audit fixes, 4th round, item 3.1: a decision's resolution
  // must be COMPATIBLE with its findingType — confirm_role is never valid
  // for missing_company (an orphan can only ever be excluded, never role-
  // confirmed into existence). This is now enforced at decisions-file
  // VALIDATION time (exit 2), not silently ignored deep inside buildPlan(). ──
  it('a decisions file attempting confirm_role for a missing_company orphan is rejected outright (exit 2), before any Firestore write', async () => {
    const uid = uniqueId('u'); const ghostCompanyId = uniqueId('co_ghost')
    await seedUser(uid, { id: 'someone_else', companyId: ghostCompanyId, role: 'admin' })
    const decisions = decisionsFile([decision({ uid, companyId: ghostCompanyId, findingType: 'missing_company', evidenceFingerprint: computeFindingFingerprint({}), resolution: 'confirm_role', role: 'admin', reason: 'trying to force it through anyway' })])

    const result = runCli(baseArgs('apply', ['--decisions-file', decisions]))

    expect(result.code).toBe(2)
    expect(result.report).toBeUndefined() // rejected before any report was even written
    expect(await getMembership(ghostCompanyId, uid)).toBeUndefined()
  })

  it('a user_id_mismatch claim referencing a MISSING company stays a missing_company orphan (never silently promoted to a conflict)', async () => {
    const uid = uniqueId('u'); const ghostCompanyId = uniqueId('co_ghost')
    await seedUser(uid, { id: 'someone_else', companyId: ghostCompanyId, role: 'admin' })

    const result = runCli(baseArgs('dry-run'))

    expect(result.report?.orphans).toContainEqual(expect.objectContaining({ companyId: ghostCompanyId, uid, reason: 'missing_company' }))
    expect(result.report?.conflicts.some(c => c.reason === 'user_id_mismatch')).toBe(false)
  })

  // ── Independent audit (2nd round) fix #5 ─────────────────────────────────
  it('changing a confirm_role decision from admin to viewer changes decisionsChecksum in the real report', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin', companies: [{ companyId, role: 'viewer' }] })

    const roleMismatchEvidence = { sourceKinds: ['users.companies[]', 'users.home'], observedRoles: ['admin', 'viewer'], hasInvalidRole: false }
    const roleMismatchFingerprint = computeFindingFingerprint(roleMismatchEvidence)
    const adminDecisions = decisionsFile([decision({ uid, companyId, findingType: 'role_mismatch', evidenceFingerprint: roleMismatchFingerprint, resolution: 'confirm_role', role: 'admin', reason: 'checked with owner' })])
    const viewerDecisions = decisionsFile([decision({ uid, companyId, findingType: 'role_mismatch', evidenceFingerprint: roleMismatchFingerprint, resolution: 'confirm_role', role: 'viewer', reason: 'checked with owner' })])

    const adminResult = runCli(baseArgs('dry-run', ['--decisions-file', adminDecisions]))
    const viewerResult = runCli(baseArgs('dry-run', ['--decisions-file', viewerDecisions]))

    expect(adminResult.report?.decisionsChecksum).not.toBe(viewerResult.report?.decisionsChecksum)
  })

  // ── Independent audit (2nd round) fix #6 ─────────────────────────────────
  it('a companyId/uid pair containing "::" does not collide with a different pair across the pipeline end-to-end', async () => {
    const uid = `u::${uniqueId('x')}`
    const companyId = `co::${uniqueId('y')}`
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })

    const result = runCli(baseArgs('apply'))

    expect(result.code).toBe(0)
    expect(result.report?.counts.created).toBe(1)
    const membership = await getMembership(companyId, uid)
    expect(membership).toMatchObject({ uid, role: 'admin', status: 'active' })
  })

  // ── Independent audit (2nd round) fix #7 ─────────────────────────────────
  // NOTE: a full re-planning `verify` run re-classifies ANY schema-corrupted
  // existing document as 'invalid' in classifyExistingMembership() BEFORE it
  // could ever reach a target relation — so end-to-end it surfaces as an
  // existing_membership_conflict, not as computeObservedState's `differing`
  // (which only applies to a relation that WAS part of the target). Both
  // routes are legitimate and both make verify refuse; observedState's own
  // schema-strict `differing`/checksum behavior is proven directly and
  // exhaustively at the unit level in observedState.test.ts.
  it('an observed membership with the correct role/status but a WRONG uid does not pass verify', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    runCli(baseArgs('apply'))

    // Overwrite with a document that has the right role/status but a
    // corrupted uid field — simulating a document tampered with directly.
    await seedExistingMembership(companyId, uid, { uid: 'someone_else', role: 'admin', status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() })

    const result = runCli(baseArgs('verify'))

    expect(result.code).toBe(1)
    expect(result.report?.verification.matchesTarget).toBe(false)
    expect(result.report?.conflicts).toContainEqual(expect.objectContaining({ companyId, uid, reason: 'existing_membership_conflict' }))
  })

  it('an observed membership with the correct role/status but an EXTRA field does not pass verify', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    runCli(baseArgs('apply'))

    await seedExistingMembership(companyId, uid, { uid, role: 'admin', status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), backdoor: true })

    const result = runCli(baseArgs('verify'))

    expect(result.code).toBe(1)
    expect(result.report?.verification.matchesTarget).toBe(false)
    expect(result.report?.conflicts).toContainEqual(expect.objectContaining({ companyId, uid, reason: 'existing_membership_conflict' }))
  })

  // ── Independent audit (3rd round) fix #1 — rollback manifest completeness ──
  it('rollback rejects a report where ONE of TWO manifest entries was removed, and leaves BOTH documents untouched', async () => {
    const uid1 = uniqueId('u'); const companyId1 = uniqueId('co')
    const uid2 = uniqueId('u'); const companyId2 = uniqueId('co')
    await seedCompany(companyId1)
    await seedCompany(companyId2)
    await seedUser(uid1, { companyId: companyId1, role: 'admin' })
    await seedUser(uid2, { companyId: companyId2, role: 'admin' })

    const applyReportPath = reportPath()
    const applyResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', applyReportPath, '--mode', 'apply'])
    expect(applyResult.code).toBe(0)
    expect(applyResult.report?.counts.created).toBe(2)
    expect(await getMembership(companyId1, uid1)).toBeDefined()
    expect(await getMembership(companyId2, uid2)).toBeDefined()

    // Tamper: drop ONE of the two rollbackManifest entries, but leave
    // createdPaths (and counts.created) showing both were created — the
    // exact bug the review flagged.
    const tampered = JSON.parse(readFileSync(applyReportPath, 'utf8')) as MembershipBackfillReport
    tampered.rollbackManifest = tampered.rollbackManifest.filter(m => m.uid !== uid2)
    expect(tampered.rollbackManifest).toHaveLength(1)
    expect(tampered.createdPaths).toHaveLength(2)
    const tamperedPath = reportPath()
    const tamperedContent = JSON.stringify(tampered)
    writeFileSync(tamperedPath, tamperedContent)

    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', tamperedPath, '--expected-report-sha256', sha256Hex(tamperedContent)])

    expect(rollbackResult.code).toBe(2)
    // BOTH documents remain — not even the one WITH a manifest entry was
    // deleted, because the whole report was rejected before any I/O.
    expect(await getMembership(companyId1, uid1)).toBeDefined()
    expect(await getMembership(companyId2, uid2)).toBeDefined()
  })

  // ── Independent audit (3rd round) fix #3 — existing orphaned membership integrity ──
  // Independent audit (3rd round follow-up correction): these dangling
  // documents are reported in `report.danglingMemberships`, a SEPARATE
  // list from `report.orphans` (legacy-source orphans), and — unlike
  // `orphans` — nothing in a decisions file can ever clear an entry here.
  it('an existing membership under a NONEXISTENT company blocks apply and verify with zero writes', async () => {
    const uid = uniqueId('u'); const ghostCompanyId = uniqueId('co_ghost')
    // The company document itself is never created — only the membership doc.
    await seedExistingMembership(ghostCompanyId, uid, { uid, role: 'viewer', status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() })

    const applyResult = runCli(baseArgs('apply'))
    expect(applyResult.code).toBe(1)
    expect(applyResult.report?.counts.created).toBe(0)
    expect(applyResult.report?.danglingMemberships).toContainEqual(expect.objectContaining({ companyId: ghostCompanyId, uid, reason: 'existing_membership_missing_company' }))

    const verifyResult = runCli(baseArgs('verify'))
    expect(verifyResult.code).toBe(1)
    expect(verifyResult.report?.verification.matchesTarget).toBe(false)
  })

  it('an existing admin membership whose uid has NO user document blocks apply and verify with zero writes', async () => {
    const companyId = uniqueId('co'); const ghostUid = uniqueId('u_ghost')
    await seedCompany(companyId)
    // The admin membership doc exists and is otherwise strictly valid, but
    // users/{ghostUid} is never created.
    await seedExistingMembership(companyId, ghostUid, { uid: ghostUid, role: 'admin', status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() })

    const applyResult = runCli(baseArgs('apply'))
    expect(applyResult.code).toBe(1)
    expect(applyResult.report?.counts.created).toBe(0)
    expect(applyResult.report?.danglingMemberships).toContainEqual(expect.objectContaining({ companyId, uid: ghostUid, reason: 'existing_membership_missing_user' }))
    // The dangling admin membership must not have satisfied the last-admin
    // gate for this (otherwise real) company.
    expect(applyResult.report?.counts.unresolved).toBeGreaterThanOrEqual(1)

    const verifyResult = runCli(baseArgs('verify'))
    expect(verifyResult.code).toBe(1)
    expect(verifyResult.report?.verification.matchesTarget).toBe(false)
  })

  // ── Required test #2 (this round): the exact fail-open scenario from the review ──
  it('a company with a valid real admin PLUS a dangling missing-user admin membership stays blocked even with a pair-level exclude decision', async () => {
    const companyId = uniqueId('co')
    const realAdminUid = uniqueId('u_real'); const ghostUid = uniqueId('u_ghost')
    await seedCompany(companyId)
    await seedUser(realAdminUid, { companyId, role: 'admin' }) // a REAL, valid admin — the company is NOT otherwise short an admin
    // A second, dangling admin membership whose uid has no users/{uid} doc.
    await seedExistingMembership(companyId, ghostUid, { uid: ghostUid, role: 'admin', status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() })

    const decisions = decisionsFile([decision({ uid: ghostUid, companyId, resolution: 'exclude', reason: 'trying to acknowledge the dangling doc away' })])

    const applyResult = runCli(baseArgs('apply', ['--decisions-file', decisions]))
    expect(applyResult.code).toBe(1)
    expect(applyResult.report?.counts.created).toBe(0)
    expect(applyResult.report?.danglingMemberships).toContainEqual(expect.objectContaining({ companyId, uid: ghostUid, reason: 'existing_membership_missing_user' }))
    expect(await getMembership(companyId, realAdminUid)).toBeUndefined() // nothing written at all
    expect(await getMembership(companyId, ghostUid)).toBeDefined() // the dangling doc is untouched, still there

    const verifyResult = runCli(baseArgs('verify', ['--decisions-file', decisions]))
    expect(verifyResult.code).toBe(1)
    expect(verifyResult.report?.verification.matchesTarget).toBe(false)
  })

  // ── Independent audit (3rd round) fix #4 — collision-free deterministic ordering ──
  it('plannedCreates ordering is deterministic end-to-end for companyId/uid pairs that collide under string concatenation', async () => {
    const suffix = uniqueId('x')
    const companyA = `a${suffix}`; const uidBc = `bc${suffix}`
    const companyAb = `ab${suffix}`; const uidC = `c${suffix}`
    await seedCompany(companyA)
    await seedCompany(companyAb)
    await seedUser(uidBc, { companyId: companyA, role: 'viewer' })
    await seedUser(uidC, { companyId: companyAb, role: 'viewer' })
    // Both companies need an admin to pass the last-admin gate — seed one each.
    const adminA = uniqueId('admin'); const adminAb = uniqueId('admin')
    await seedUser(adminA, { companyId: companyA, role: 'admin' })
    await seedUser(adminAb, { companyId: companyAb, role: 'admin' })

    const result = runCli(baseArgs('dry-run'))

    expect(result.code).toBe(0)
    const pairs = result.report?.plannedCreates.map(c => `${c.companyId}/${c.uid}`) ?? []
    const bcIndex = pairs.indexOf(`${companyA}/${uidBc}`)
    const cIndex = pairs.indexOf(`${companyAb}/${uidC}`)
    expect(bcIndex).toBeGreaterThanOrEqual(0)
    expect(cIndex).toBeGreaterThanOrEqual(0)
    expect(bcIndex).not.toBe(cIndex) // both present as distinct entries, never collapsed/collided
  })

  // ── SEC-005 staging authorization (EXTERNAL_ACTION_APPROVED: SEC-005 /
  // ENVIRONMENT: staging) + production dry-run authorization
  // (PRODUCTION_PREFLIGHT_APPROVED: SEC-005 — "deploy maintenance
  // protection, create+verify backup, read-only dry-run"; "Backfill/apply
  // пока запрещён"). ─────────────────────────────────────────────────────
  //
  // NOTE on scope: these tests prove the CLI's CONTROL FLOW, not a live
  // staging/production connection — per the task's own "emulator only; no
  // staging/production access in the automated test suite" constraint,
  // nothing here ever attempts a real network call to a real GCP project.
  // `--environment production` with a non-dry-run mode is refused by
  // assertCycleExecutionAllowed() BEFORE initFirestore() is ever called,
  // so THAT direction is safe to prove fully end-to-end via the real CLI
  // binary with zero risk of any real I/O. Two directions are deliberately
  // NOT proven via the real CLI binary here, because doing so would let
  // the process proceed toward a real (or credential-failing) Firestore
  // connection attempt, which is out of scope for an automated test run:
  // "staging is allowed past the gate" (any mode), and, as of the
  // production dry-run grant, "production dry-run is allowed past the
  // gate" — both are proven directly and exhaustively at the unit level
  // instead (`scripts/lib/firebaseAdmin.test.ts`,
  // `assertCycleExecutionAllowed`) — the exact function this gate is
  // implemented with. The real, authorized production dry-run itself is
  // run manually, once, outside this automated suite — see
  // `docs/remediation/reports/SEC-005.md` for its anonymized result.
  it('production apply is refused (exit 4) even WITH every production-approval flag supplied — unconditional, no bypass', () => {
    const { FIRESTORE_EMULATOR_HOST: _emulatorHost, GCLOUD_PROJECT: _gcloudProject, GOOGLE_CLOUD_PROJECT: _googleCloudProject, ...envWithoutEmulator } = process.env

    // --backup-reference/--rollback-reference are now real filesystem
    // paths (final-round fix: strictly verified, not opaque honor-system
    // IDs) — path-safety validation (assertPathOutsideRepo) runs on them
    // BEFORE assertCycleExecutionAllowed(), so they must be absolute paths
    // outside the repo even though this test never expects them to be
    // read (production apply is refused before that point regardless).
    const result = runCliWithEnv([
      '--environment', 'production', '--project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83',
      '--backup-reference', reportPath(), '--rollback-reference', reportPath(), '--ack-maintenance-readonly',
      '--report-path', reportPath(), '--apply',
    ], envWithoutEmulator)

    expect(result.code).toBe(4)
    expect(result.stderr).toMatch(/PRODUCTION_ACTION_APPROVED/)
    // No report is even written — refused before any I/O, including the
    // report-writability probe having anything to report about.
  })

  it('production is refused (exit 4) even for --mode verify (which skips the backup-reference flag requirement)', () => {
    const { FIRESTORE_EMULATOR_HOST: _emulatorHost, GCLOUD_PROJECT: _gcloudProject, GOOGLE_CLOUD_PROJECT: _googleCloudProject, ...envWithoutEmulator } = process.env

    const result = runCliWithEnv([
      '--environment', 'production', '--project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83',
      '--report-path', reportPath(), '--mode', 'verify',
    ], envWithoutEmulator)

    expect(result.code).toBe(4)
  })

  it.each(['rollback-from-report', 'rollback-from-plan'] as const)(
    'production %s is refused (exit 4) — apply/backfill remains explicitly forbidden, only read-only dry-run is authorized',
    mode => {
      const { FIRESTORE_EMULATOR_HOST: _emulatorHost, GCLOUD_PROJECT: _gcloudProject, GOOGLE_CLOUD_PROJECT: _googleCloudProject, ...envWithoutEmulator } = process.env

      const result = runCliWithEnv([
        '--environment', 'production', '--project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83',
        '--report-path', reportPath(), '--mode', mode,
        ...(mode === 'rollback-from-report' ? ['--from-report', reportPath(), '--expected-report-sha256', '0'.repeat(64)] : []),
        ...(mode === 'rollback-from-plan' ? ['--from-plan', reportPath(), '--expected-plan-sha256', '0'.repeat(64), '--ack-emergency-reconstruction'] : []),
      ], envWithoutEmulator)

      expect(result.code).toBe(4)
    },
  )
})
