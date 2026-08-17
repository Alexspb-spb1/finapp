// Independent review (production preflight, final round) — unit coverage
// for the REAL, strictly-verified production-write preconditions. Uses a
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
  assertMaintenanceModeActive, verifyBackupReference, verifyRollbackPlanReference, verifyStrictDryRunReport,
  validateStrictDryRunReportContent, sha256OfFile, ProductionSafetyError, MAX_BACKUP_AGE_MS,
} from './productionSafety.ts'
import { REPORT_SCHEMA_VERSION } from './report.ts'

const PROJECT_ID = 'finapp-prod-10a83'
const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)
const HEX64_C = 'c'.repeat(64)
const MAINTENANCE_ENABLED_AT = '2026-01-01T00:00:00.000Z'
const FRESH_NOW = '2026-01-01T02:00:00.000Z' // 2h after maintenance enabled

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
  it('resolves when enabled === true with a real Timestamp enabledAt, returning enabledAt/enabledBy/taskId', async () => {
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

  // ── Final-round fix: enabledAt is now a hard requirement ───────────────
  it('rejects when enabled === true but enabledAt is missing — cannot anchor the backup-freshness check', async () => {
    const db = makeFakeMaintenanceDb({ enabled: true, enabledBy: 'alice', taskId: 'SEC-005' })
    await expect(assertMaintenanceModeActive(db)).rejects.toThrow(/enabledAt/)
  })

  it('rejects when enabledAt is a plain object, not a real Timestamp', async () => {
    const db = makeFakeMaintenanceDb({ enabled: true, enabledAt: { seconds: 1, nanoseconds: 0 } })
    await expect(assertMaintenanceModeActive(db)).rejects.toThrow(ProductionSafetyError)
  })
})

describe('verifyBackupReference', () => {
  const validManifest = {
    productionProjectId: PROJECT_ID,
    createdAtUtc: '2026-01-01T01:00:00.000Z', // 1h after maintenance enabled, 1h before "now"
    firestore: {
      exportOperationId: 'op-12345',
      exportStatus: 'SUCCESS',
      collectionIds: ['users', 'companies', 'company_data', 'members'],
      membersCount: 3, companiesCount: 2, usersCount: 3, companyDataDocsCount: 2,
      membersChecksum: HEX64_A,
    },
    restore: {
      verificationResult: 'PASS',
      membersCount: 3,
      membersChecksum: HEX64_A,
      verifiedAtUtc: '2026-01-01T01:30:00.000Z',
    },
  }

  it('accepts a valid manifest and returns its sha256/createdAtUtc/membersCount', () => {
    const path = tempFile('manifest.json', validManifest)
    const result = verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)
    expect(result.createdAtUtc).toBe(validManifest.createdAtUtc)
    expect(result.membersCount).toBe(3)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts a full-scope export with no collectionIds array at all', () => {
    const path = tempFile('manifest.json', {
      ...validManifest,
      firestore: { ...validManifest.firestore, collectionIds: undefined, scope: 'full' },
    })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).not.toThrow()
  })

  it('rejects a nonexistent path', () => {
    expect(() => verifyBackupReference('/nonexistent/path/manifest.json', PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
  })

  it('rejects invalid JSON', () => {
    const path = tempFile('manifest.json', 'not json')
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
  })

  it('rejects a projectId mismatch', () => {
    const path = tempFile('manifest.json', { ...validManifest, productionProjectId: 'some-other-project' })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
  })

  it('rejects when firestore.exportStatus is not SUCCESS', () => {
    const path = tempFile('manifest.json', { ...validManifest, firestore: { ...validManifest.firestore, exportStatus: 'FAILED' } })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
  })

  it('rejects a manifest missing firestore.exportOperationId', () => {
    const { exportOperationId: _drop, ...firestoreWithout } = validManifest.firestore
    const path = tempFile('manifest.json', { ...validManifest, firestore: firestoreWithout })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(/exportOperationId/)
  })

  // ── Independent review fix #1 (collection group `members` must be backed up) ──
  it('rejects a manifest whose collectionIds omits "members" and scope is not full', () => {
    const path = tempFile('manifest.json', {
      ...validManifest,
      firestore: { ...validManifest.firestore, collectionIds: ['users', 'companies', 'company_data'] },
    })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(/members/i)
  })

  it.each(['membersCount', 'companiesCount', 'usersCount', 'companyDataDocsCount'] as const)(
    'rejects a non-integer or negative firestore.%s',
    field => {
      const badPath = tempFile(`bad-${field}.json`, { ...validManifest, firestore: { ...validManifest.firestore, [field]: -1 } })
      expect(() => verifyBackupReference(badPath, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
      const floatPath = tempFile(`float-${field}.json`, { ...validManifest, firestore: { ...validManifest.firestore, [field]: 1.5 } })
      expect(() => verifyBackupReference(floatPath, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
    },
  )

  // ── Independent review fix #2 (restore verification for members) ───────
  it('rejects a manifest with no restore section at all', () => {
    const { restore: _drop, ...withoutRestore } = validManifest
    const path = tempFile('manifest.json', withoutRestore)
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(/restore/i)
  })

  it('rejects when restore.verificationResult is not PASS', () => {
    const path = tempFile('manifest.json', { ...validManifest, restore: { ...validManifest.restore, verificationResult: 'FAIL' } })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
  })

  it('rejects when restore.membersCount does not match firestore.membersCount', () => {
    const path = tempFile('manifest.json', { ...validManifest, restore: { ...validManifest.restore, membersCount: 999 } })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
  })

  it('rejects when restore.membersChecksum is missing', () => {
    const path = tempFile('manifest.json', { ...validManifest, restore: { ...validManifest.restore, membersChecksum: '' } })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
  })

  // ── Final-round fix #3 (second round): source AND restore members checksum, exact equality ──
  it('rejects when firestore.membersChecksum (the source/production checksum) is missing', () => {
    const { membersChecksum: _drop, ...firestoreWithout } = validManifest.firestore
    const path = tempFile('manifest.json', { ...validManifest, firestore: firestoreWithout })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(/membersChecksum/)
  })

  it('rejects when firestore.membersChecksum is not a valid 64-hex SHA-256', () => {
    const path = tempFile('manifest.json', { ...validManifest, firestore: { ...validManifest.firestore, membersChecksum: 'not-a-real-hash' } })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
  })

  it('rejects when restore.membersChecksum is not a valid 64-hex SHA-256 (even if non-empty)', () => {
    const path = tempFile('manifest.json', { ...validManifest, restore: { ...validManifest.restore, membersChecksum: 'not-a-real-hash' } })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(ProductionSafetyError)
  })

  it('rejects when restore.membersChecksum does not EXACTLY equal firestore.membersChecksum (both valid hex, but different)', () => {
    const path = tempFile('manifest.json', { ...validManifest, restore: { ...validManifest.restore, membersChecksum: HEX64_B } })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(/membersChecksum/)
  })

  it('accepts when firestore.membersChecksum and restore.membersChecksum are exactly equal, valid hex', () => {
    const path = tempFile('manifest.json', validManifest)
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).not.toThrow()
  })

  // ── Final-round fix #1 (backup must postdate maintenance mode enable) ──
  it('rejects a backup created BEFORE maintenance mode was enabled', () => {
    const path = tempFile('manifest.json', { ...validManifest, createdAtUtc: '2025-12-31T23:00:00.000Z' })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).toThrow(/maintenance/i)
  })

  it('accepts a backup created exactly AT the maintenance-enabled instant', () => {
    const path = tempFile('manifest.json', { ...validManifest, createdAtUtc: MAINTENANCE_ENABLED_AT })
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, FRESH_NOW)).not.toThrow()
  })

  // ── Final-round fix #1 (backup freshness) ───────────────────────────────
  it('rejects a stale backup older than MAX_BACKUP_AGE_MS', () => {
    const staleNow = new Date(Date.parse(validManifest.createdAtUtc) + MAX_BACKUP_AGE_MS + 1).toISOString()
    const path = tempFile('manifest.json', validManifest)
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, staleNow)).toThrow(/old/i)
  })

  it('rejects a manifest whose createdAtUtc is in the future relative to now', () => {
    const path = tempFile('manifest.json', validManifest)
    const pastNow = '2025-01-01T00:00:00.000Z'
    expect(() => verifyBackupReference(path, PROJECT_ID, MAINTENANCE_ENABLED_AT, pastNow)).toThrow(/future/i)
  })
})

describe('verifyStrictDryRunReport', () => {
  const validDryRun = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: 'dry-run',
    environment: 'production',
    projectId: PROJECT_ID,
    sourceGitSha: 'abc123def',
    sourceChecksum: HEX64_A,
    decisionsChecksum: HEX64_B,
    targetChecksum: HEX64_C,
    counts: { unresolved: 0 },
    plannedCreates: [{ companyId: 'co1', uid: 'u1', role: 'admin', status: 'active' }],
  }

  it('accepts a genuine, fully-resolved dry-run report', () => {
    const path = tempFile('dry-run.json', validDryRun)
    const result = verifyStrictDryRunReport(path, PROJECT_ID, 'production')
    expect(result.targetChecksum).toBe(HEX64_C)
    expect(result.plannedCreates).toEqual([{ companyId: 'co1', uid: 'u1', role: 'admin', status: 'active' }])
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a minimal forged JSON with only mode+targetChecksum', () => {
    const path = tempFile('fake.json', { mode: 'dry-run', targetChecksum: HEX64_C })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(ProductionSafetyError)
  })

  it('rejects a nonexistent path', () => {
    expect(() => verifyStrictDryRunReport('/nonexistent/dry-run.json', PROJECT_ID, 'production')).toThrow(ProductionSafetyError)
  })

  it('rejects the wrong schemaVersion', () => {
    const path = tempFile('dry-run.json', { ...validDryRun, schemaVersion: 999 })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(ProductionSafetyError)
  })

  it('rejects a non-dry-run mode (e.g. an apply report)', () => {
    const path = tempFile('apply.json', { ...validDryRun, mode: 'apply' })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(ProductionSafetyError)
  })

  it('rejects an environment mismatch', () => {
    const path = tempFile('dry-run.json', { ...validDryRun, environment: 'staging' })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(ProductionSafetyError)
  })

  it('rejects a projectId mismatch', () => {
    const path = tempFile('dry-run.json', { ...validDryRun, projectId: 'wrong-project' })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(ProductionSafetyError)
  })

  it('rejects a missing sourceGitSha', () => {
    const path = tempFile('dry-run.json', { ...validDryRun, sourceGitSha: '' })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(ProductionSafetyError)
  })

  it.each(['sourceChecksum', 'decisionsChecksum', 'targetChecksum'] as const)(
    'rejects a non-hex or malformed %s',
    field => {
      const path = tempFile(`bad-${field}.json`, { ...validDryRun, [field]: 'not-a-real-hash' })
      expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(ProductionSafetyError)
    },
  )

  it('rejects counts.unresolved !== 0 — a plan that is not fully approved', () => {
    const path = tempFile('dry-run.json', { ...validDryRun, counts: { unresolved: 1 } })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(/unresolved/)
  })

  it('rejects a missing counts object entirely', () => {
    const { counts: _drop, ...withoutCounts } = validDryRun
    const path = tempFile('dry-run.json', withoutCounts)
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(ProductionSafetyError)
  })

  it('rejects plannedCreates entries missing a required field', () => {
    const path = tempFile('dry-run.json', { ...validDryRun, plannedCreates: [{ companyId: 'co1', uid: 'u1', role: 'admin' }] })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(/plannedCreates/)
  })

  it('accepts an empty plannedCreates array (nothing was planned)', () => {
    const path = tempFile('dry-run.json', { ...validDryRun, plannedCreates: [] })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).not.toThrow()
  })

  // ── Final-round fix #2 (second round): plannedCreates pair uniqueness ──
  it('rejects plannedCreates containing a duplicate (companyId, uid) pair', () => {
    const path = tempFile('dry-run.json', {
      ...validDryRun,
      plannedCreates: [
        { companyId: 'co1', uid: 'u1', role: 'admin', status: 'active' },
        { companyId: 'co1', uid: 'u1', role: 'viewer', status: 'active' },
      ],
    })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(/duplicate/)
  })

  it('accepts plannedCreates with distinct pairs sharing a companyId or uid individually', () => {
    const path = tempFile('dry-run.json', {
      ...validDryRun,
      plannedCreates: [
        { companyId: 'co1', uid: 'u1', role: 'admin', status: 'active' },
        { companyId: 'co1', uid: 'u2', role: 'viewer', status: 'active' },
        { companyId: 'co2', uid: 'u1', role: 'viewer', status: 'active' },
      ],
    })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).not.toThrow()
  })

  // ── Final-round fix #2 (second round): sourceGitSha "unknown" refused for production ──
  it('rejects sourceGitSha "unknown" when expectedEnvironment is production', () => {
    const path = tempFile('dry-run.json', { ...validDryRun, sourceGitSha: 'unknown' })
    expect(() => verifyStrictDryRunReport(path, PROJECT_ID, 'production')).toThrow(/unknown/)
  })

  it('allows sourceGitSha "unknown" when expectedEnvironment is NOT production (e.g. emulator)', () => {
    const path = tempFile('dry-run.json', { ...validDryRun, environment: 'emulator', projectId: 'demo-finapp', sourceGitSha: 'unknown' })
    expect(() => verifyStrictDryRunReport(path, 'demo-finapp', 'emulator')).not.toThrow()
  })
})

describe('validateStrictDryRunReportContent', () => {
  const validDryRun = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: 'dry-run',
    environment: 'production',
    projectId: PROJECT_ID,
    sourceGitSha: 'abc123def',
    sourceChecksum: HEX64_A,
    decisionsChecksum: HEX64_B,
    targetChecksum: HEX64_C,
    counts: { unresolved: 0 },
    plannedCreates: [{ companyId: 'co1', uid: 'u1', role: 'admin', status: 'active' }],
  }

  it('returns all four checksum/sha fields plus plannedCreates, given raw content directly (no file I/O)', () => {
    const result = validateStrictDryRunReportContent(JSON.stringify(validDryRun), PROJECT_ID, 'production')
    expect(result).toEqual({
      sourceGitSha: 'abc123def',
      sourceChecksum: HEX64_A,
      decisionsChecksum: HEX64_B,
      targetChecksum: HEX64_C,
      plannedCreates: [{ companyId: 'co1', uid: 'u1', role: 'admin', status: 'active' }],
    })
  })

  it('rejects invalid JSON content', () => {
    expect(() => validateStrictDryRunReportContent('not json', PROJECT_ID, 'production')).toThrow(ProductionSafetyError)
  })
})

describe('verifyRollbackPlanReference', () => {
  const validDryRun = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: 'dry-run',
    environment: 'production',
    projectId: PROJECT_ID,
    sourceGitSha: 'abc123def',
    sourceChecksum: HEX64_A,
    decisionsChecksum: HEX64_B,
    targetChecksum: HEX64_C,
    counts: { unresolved: 0 },
    plannedCreates: [],
  }
  const currentRun = { sourceGitSha: 'abc123def', sourceChecksum: HEX64_A, decisionsChecksum: HEX64_B, targetChecksum: HEX64_C }

  it('accepts a dry-run report whose sourceGitSha/sourceChecksum/decisionsChecksum/targetChecksum ALL match the current run exactly', () => {
    const path = tempFile('dry-run.json', validDryRun)
    const result = verifyRollbackPlanReference(path, currentRun, PROJECT_ID)
    expect(result.targetChecksum).toBe(HEX64_C)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a nonexistent path', () => {
    expect(() => verifyRollbackPlanReference('/nonexistent/dry-run.json', currentRun, PROJECT_ID)).toThrow(ProductionSafetyError)
  })

  it('rejects a report whose mode is not dry-run (e.g. an apply report — closes the circular ROLLBACK_REFERENCE)', () => {
    const path = tempFile('apply.json', { ...validDryRun, mode: 'apply' })
    expect(() => verifyRollbackPlanReference(path, currentRun, PROJECT_ID)).toThrow(ProductionSafetyError)
  })

  it('rejects a targetChecksum mismatch — a stale or unrelated dry-run', () => {
    const path = tempFile('dry-run.json', validDryRun)
    expect(() => verifyRollbackPlanReference(path, { ...currentRun, targetChecksum: HEX64_B }, PROJECT_ID)).toThrow(ProductionSafetyError)
  })

  it('rejects a dry-run with unresolved items even if the checksum matches', () => {
    const path = tempFile('dry-run.json', { ...validDryRun, counts: { unresolved: 2 } })
    expect(() => verifyRollbackPlanReference(path, currentRun, PROJECT_ID)).toThrow(/unresolved/)
  })

  // ── Final-round fix #2 (second round): link rollback-reference to the CURRENT plan exactly ──
  it('rejects a sourceGitSha mismatch — the dry-run was built from different code', () => {
    const path = tempFile('dry-run.json', validDryRun)
    expect(() => verifyRollbackPlanReference(path, { ...currentRun, sourceGitSha: 'different-sha' }, PROJECT_ID)).toThrow(/sourceGitSha/)
  })

  it('rejects a sourceChecksum mismatch — legacy source data changed since the dry-run', () => {
    const path = tempFile('dry-run.json', validDryRun)
    expect(() => verifyRollbackPlanReference(path, { ...currentRun, sourceChecksum: HEX64_C }, PROJECT_ID)).toThrow(/sourceChecksum/)
  })

  it('rejects a decisionsChecksum mismatch — apply must use the SAME --decisions-file as the dry-run', () => {
    const path = tempFile('dry-run.json', validDryRun)
    expect(() => verifyRollbackPlanReference(path, { ...currentRun, decisionsChecksum: HEX64_C }, PROJECT_ID)).toThrow(/decisionsChecksum/)
  })

  it('rejects when the CURRENT run\'s own sourceGitSha is "unknown" — refuses before even reading --rollback-reference\'s content', () => {
    const path = tempFile('dry-run.json', validDryRun)
    expect(() => verifyRollbackPlanReference(path, { ...currentRun, sourceGitSha: 'unknown' }, PROJECT_ID)).toThrow(/unknown/)
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
