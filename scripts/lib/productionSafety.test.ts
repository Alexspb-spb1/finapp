// Independent review (production preflight, follow-up round) — unit
// coverage for the REAL, verified production-write preconditions. Uses a
// minimal fake Firestore-shaped stub for the maintenance-mode check (same
// pattern as applyWrites.test.ts) and real temp files for the
// backup/rollback-reference checks — no real emulator or GCP project
// required.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Timestamp } from 'firebase-admin/firestore'
import type { Firestore } from 'firebase-admin/firestore'
import {
  assertMaintenanceModeActive, verifyBackupReference, verifyRollbackPlanReference, sha256OfFile, ProductionSafetyError,
} from './productionSafety.ts'
import { REPORT_SCHEMA_VERSION } from './report.ts'

function makeFakeMaintenanceDb(doc: Record<string, unknown> | undefined | 'throw'): Firestore {
  const db = {
    collection(_name: string) {
      return {
        doc(_id: string) {
          return {
            async get() {
              if (doc === 'throw') throw new Error('simulated read failure')
              return { exists: doc !== undefined, data: () => doc }
            },
          }
        },
      }
    },
  }
  return db as unknown as Firestore
}

function tempFile(name: string, content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sec005-prodsafety-'))
  const path = join(dir, name)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

describe('assertMaintenanceModeActive', () => {
  it('resolves when enabled === true, returning enabledAt/enabledBy/taskId', async () => {
    const ts = Timestamp.now()
    const db = makeFakeMaintenanceDb({ enabled: true, enabledAt: ts, enabledBy: 'alice', taskId: 'SEC-005' })
    const result = await assertMaintenanceModeActive(db)
    expect(result.enabledBy).toBe('alice')
    expect(result.taskId).toBe('SEC-005')
    expect(result.enabledAt).toBe(ts.toDate().toISOString())
    expect(result.verifiedAt).toBeTruthy()
  })

  it('rejects when the document does not exist', async () => {
    const db = makeFakeMaintenanceDb(undefined)
    await expect(assertMaintenanceModeActive(db)).rejects.toThrow(ProductionSafetyError)
  })

  it('rejects when enabled is not exactly true (e.g. false, missing, or a truthy non-boolean)', async () => {
    await expect(assertMaintenanceModeActive(makeFakeMaintenanceDb({ enabled: false }))).rejects.toThrow(ProductionSafetyError)
    await expect(assertMaintenanceModeActive(makeFakeMaintenanceDb({}))).rejects.toThrow(ProductionSafetyError)
    await expect(assertMaintenanceModeActive(makeFakeMaintenanceDb({ enabled: 'true' }))).rejects.toThrow(ProductionSafetyError)
  })

  it('fails CLOSED (rejects) when the Firestore read itself throws — never treated as "maintenance is off"', async () => {
    await expect(assertMaintenanceModeActive(makeFakeMaintenanceDb('throw'))).rejects.toThrow(ProductionSafetyError)
  })
})

describe('verifyBackupReference', () => {
  const validManifest = {
    productionProjectId: 'finapp-prod-10a83',
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    firestore: { exportStatus: 'SUCCESS', membersCount: 3, companiesCount: 2, usersCount: 3, companyDataDocsCount: 2 },
  }

  it('accepts a valid manifest and returns its sha256/createdAtUtc', () => {
    const path = tempFile('manifest.json', validManifest)
    const result = verifyBackupReference(path, 'finapp-prod-10a83')
    expect(result.createdAtUtc).toBe('2026-01-01T00:00:00.000Z')
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a nonexistent path', () => {
    expect(() => verifyBackupReference('/nonexistent/path/manifest.json', 'finapp-prod-10a83')).toThrow(ProductionSafetyError)
  })

  it('rejects invalid JSON', () => {
    const path = tempFile('manifest.json', 'not json')
    expect(() => verifyBackupReference(path, 'finapp-prod-10a83')).toThrow(ProductionSafetyError)
  })

  it('rejects a projectId mismatch', () => {
    const path = tempFile('manifest.json', { ...validManifest, productionProjectId: 'some-other-project' })
    expect(() => verifyBackupReference(path, 'finapp-prod-10a83')).toThrow(ProductionSafetyError)
  })

  it('rejects when firestore.exportStatus is not SUCCESS', () => {
    const path = tempFile('manifest.json', { ...validManifest, firestore: { ...validManifest.firestore, exportStatus: 'FAILED' } })
    expect(() => verifyBackupReference(path, 'finapp-prod-10a83')).toThrow(ProductionSafetyError)
  })

  // ── Independent review fix #1 (collection group `members` must be backed up) ──
  it('rejects a manifest with no firestore.membersCount — the export never captured the members collection group', () => {
    const { membersCount: _drop, ...firestoreWithoutMembers } = validManifest.firestore
    const path = tempFile('manifest.json', { ...validManifest, firestore: firestoreWithoutMembers })
    expect(() => verifyBackupReference(path, 'finapp-prod-10a83')).toThrow(/members/i)
  })
})

describe('verifyRollbackPlanReference', () => {
  const dryRunReport = { schemaVersion: REPORT_SCHEMA_VERSION, mode: 'dry-run', targetChecksum: 'abc123' }

  it('accepts a dry-run report whose targetChecksum matches the expected value', () => {
    const path = tempFile('dry-run.json', dryRunReport)
    const result = verifyRollbackPlanReference(path, 'abc123')
    expect(result.targetChecksum).toBe('abc123')
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a nonexistent path', () => {
    expect(() => verifyRollbackPlanReference('/nonexistent/dry-run.json', 'abc123')).toThrow(ProductionSafetyError)
  })

  it('rejects a report whose mode is not dry-run (e.g. an apply report — closes the circular ROLLBACK_REFERENCE)', () => {
    const path = tempFile('apply.json', { ...dryRunReport, mode: 'apply' })
    expect(() => verifyRollbackPlanReference(path, 'abc123')).toThrow(ProductionSafetyError)
  })

  it('rejects a targetChecksum mismatch — a stale or unrelated dry-run', () => {
    const path = tempFile('dry-run.json', dryRunReport)
    expect(() => verifyRollbackPlanReference(path, 'different-checksum')).toThrow(ProductionSafetyError)
  })
})

describe('sha256OfFile', () => {
  it('computes a stable, deterministic hash of the file contents', () => {
    const path = tempFile('report.json', { a: 1 })
    const first = sha256OfFile(path)
    const second = sha256OfFile(path)
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces a different hash for different content', () => {
    const pathA = tempFile('a.json', { a: 1 })
    const pathB = tempFile('b.json', { a: 2 })
    expect(sha256OfFile(pathA)).not.toBe(sha256OfFile(pathB))
  })
})
