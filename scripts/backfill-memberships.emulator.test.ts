// Real Firestore Emulator proof for scripts/backfill-memberships.ts —
// SEC-005. Every test here spawns the ACTUAL CLI as a child process (the
// same way an operator would run it) against the real Firestore Emulator —
// no mock-only evidence for apply/idempotency/rollback (task requirement).
//
// Run only via `npm run test:migration` (`firebase emulators:exec --project
// demo-finapp --only firestore "vitest run scripts"`), which sets
// FIRESTORE_EMULATOR_HOST/GCLOUD_PROJECT for this process automatically.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore'
import type { MembershipBackfillReport } from './lib/report.ts'

const PROJECT_ID = 'demo-finapp'
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

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

    const decisions = decisionsFile([{ uid, companyId, resolution: 'confirm_role', role: 'admin', reason: 'checked with owner', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }])
    const result = runCli(baseArgs('apply', ['--decisions-file', decisions]))

    expect(result.code).toBe(0)
    expect(result.report?.counts.created).toBe(1)
    expect((await getMembership(companyId, uid))?.role).toBe('admin')
  })

  it('an invalid decisions file is rejected before any Firestore write', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const decisions = decisionsFile([{ uid, companyId, resolution: 'bogus_resolution', reason: 'x', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }])

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

    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', applyReportPath])

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

    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', applyReportPath])

    expect(rollbackResult.code).toBe(1)
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
    const decisions = decisionsFile([{ uid, companyId, resolution: 'accept_existing', reason: 'trying to force it through', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }])

    const result = runCli(baseArgs('apply', ['--decisions-file', decisions]))

    expect(result.code).toBe(1)
  })

  it('accept_existing does NOT resolve a DISABLED existing membership', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const now = Timestamp.now()
    await seedExistingMembership(companyId, uid, { uid, role: 'admin', status: 'disabled', createdAt: now, updatedAt: now })
    const decisions = decisionsFile([{ uid, companyId, resolution: 'accept_existing', reason: 'trying to force it through', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }])

    const result = runCli(baseArgs('apply', ['--decisions-file', decisions]))

    expect(result.code).toBe(1)
  })

  it('accept_existing DOES resolve a strictly-valid existing membership with a merely different role', async () => {
    const uid = uniqueId('u'); const companyId = uniqueId('co')
    await seedCompany(companyId)
    await seedUser(uid, { companyId, role: 'admin' })
    const now = Timestamp.now()
    await seedExistingMembership(companyId, uid, { uid, role: 'accountant', status: 'active', createdAt: now, updatedAt: now })
    const decisions = decisionsFile([{ uid, companyId, resolution: 'accept_existing', reason: 'existing role is correct, legacy is stale', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }])

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
    writeFileSync(tamperedPath, JSON.stringify(tampered))

    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', tamperedPath])

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
    writeFileSync(tamperedPath, JSON.stringify(tampered))

    const rollbackResult = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--report-path', reportPath(), '--mode', 'rollback-from-report', '--from-report', tamperedPath])

    expect(rollbackResult.code).toBe(2)
    expect(await getMembership(companyId, uid)).toBeDefined() // NOT deleted
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

    expect(result.report?.unknownUsers).toContainEqual({ uid, reason: 'no_usable_relations' })
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
})
