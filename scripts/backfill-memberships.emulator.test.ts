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

describe('backfill-memberships CLI — real Firestore Emulator', () => {
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
})
