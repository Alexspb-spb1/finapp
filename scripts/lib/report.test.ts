import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertReportPathWritable, writeReport, printSafeSummary, REPORT_SCHEMA_VERSION, type MembershipBackfillReport } from './report.ts'
import { UnsafePathError } from './pathSafety.ts'

const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

function minimalReport(overrides: Partial<MembershipBackfillReport> = {}): MembershipBackfillReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: 'dry-run',
    environment: 'emulator',
    projectId: 'demo-finapp',
    sourceGitSha: 'abc123',
    runId: 'run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    counts: {
      usersRead: 0, companiesRead: 0, existingMembershipsRead: 0, candidateRelations: 0,
      confirmedRelations: 0, plannedCreates: 0, created: 0, skipped: 0, conflicts: 0,
      missingCompanies: 0, missingUsers: 0, unresolvedMissingCompanies: 0, unresolvedMissingUsers: 0,
      ownerWithoutAdminMembership: 0,
      unknownUsers: 0, malformedClaims: 0, danglingMemberships: 0,
      ownerIdAnomalies: 0, staleDecisions: 0, unusedDecisions: 0, unresolved: 0,
    },
    sourceChecksum: 'x', sourceStateChecksum: 'w', decisionsChecksum: 'y', targetChecksum: 'z', observedChecksum: null,
    readBackError: null,
    conflicts: [], orphans: [], ownerAnomalies: [], unknownUsers: [], malformedClaims: [], danglingMemberships: [],
    ownerIdAnomalies: [], staleDecisions: [], unusedDecisions: [],
    resolvedConflicts: [], resolvedOrphans: [], resolvedOwnerAnomalies: [], resolvedUnknownUsers: [], resolvedMalformedClaims: [],
    plannedCreates: [], createdPaths: [], writeFailures: [],
    verification: { performed: false, matchesTarget: false, missing: [], differing: [] },
    rollbackManifest: [],
    productionSafety: { maintenanceMode: null, backupReference: null, rollbackPlanReference: null, ownReportSha256: null },
    emergencyReconstruction: null,
    ...overrides,
  }
}

// ── Independent audit fix #2 (3rd round) ────────────────────────────────
describe('assertReportPathWritable', () => {
  it('accepts a genuinely writable external path and leaves no probe file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec005-report-writable-'))
    const reportPath = join(dir, 'report.json')
    expect(() => assertReportPathWritable(reportPath, REPO_ROOT)).not.toThrow()
    expect(existsSync(reportPath)).toBe(false) // only a probe was written, then removed
    expect(readdirSync(dir)).toEqual([]) // no leftover probe file
  })

  it('rejects a path inside the repository (delegates to the same path-safety check as writeReport)', () => {
    const reportPath = join(REPO_ROOT, 'docs', `sec005-writable-probe-${Date.now()}.json`)
    expect(() => assertReportPathWritable(reportPath, REPO_ROOT)).toThrow(UnsafePathError)
    expect(existsSync(reportPath)).toBe(false) // rejected before any write was attempted
  })

  it('accepts a path whose parent directory does not exist yet (creates it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec005-report-writable-'))
    const nested = join(dir, 'nested', 'deeper')
    const reportPath = join(nested, 'report.json')
    expect(() => assertReportPathWritable(reportPath, REPO_ROOT)).not.toThrow()
    expect(existsSync(nested)).toBe(true)
  })
})

describe('writeReport — atomic replacement', () => {
  it('writes the full report content and leaves no temp file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec005-report-atomic-'))
    const reportPath = join(dir, 'report.json')
    writeReport(reportPath, REPO_ROOT, minimalReport())
    expect(existsSync(reportPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as MembershipBackfillReport
    expect(parsed.runId).toBe('run-1')
    const remaining = readdirSync(dir)
    expect(remaining).toEqual(['report.json']) // no .tmp-* file left over
  })

  it('a second write to the same path fully replaces the first (no merge, no corruption)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec005-report-atomic-'))
    const reportPath = join(dir, 'report.json')
    writeReport(reportPath, REPO_ROOT, minimalReport({ runId: 'run-1' }))
    writeReport(reportPath, REPO_ROOT, minimalReport({ runId: 'run-2' }))
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as MembershipBackfillReport
    expect(parsed.runId).toBe('run-2')
    expect(readdirSync(dir)).toEqual(['report.json'])
  })
})

// ── Final-round fix #5 (third pass): productionSafety.backupReference.membersChecksum ──
describe('productionSafety.backupReference.membersChecksum', () => {
  const HEX64 = 'a'.repeat(64)

  it('round-trips through writeReport/readback unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec005-report-members-checksum-'))
    const reportPath = join(dir, 'report.json')
    const report = minimalReport({
      productionSafety: {
        maintenanceMode: null,
        backupReference: { sha256: 'b'.repeat(64), createdAtUtc: '2026-01-01T00:00:00.000Z', membersCount: 3, membersChecksum: HEX64 },
        rollbackPlanReference: null,
        ownReportSha256: null,
      },
    })
    writeReport(reportPath, REPO_ROOT, report)
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as MembershipBackfillReport
    expect(parsed.productionSafety.backupReference?.membersChecksum).toBe(HEX64)
  })

  it('is included in the safe stdout summary (printSafeSummary) alongside the rest of productionSafety', () => {
    const report = minimalReport({
      productionSafety: {
        maintenanceMode: null,
        backupReference: { sha256: 'b'.repeat(64), createdAtUtc: '2026-01-01T00:00:00.000Z', membersCount: 3, membersChecksum: HEX64 },
        rollbackPlanReference: null,
        ownReportSha256: null,
      },
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printSafeSummary(report)
    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string) as { productionSafety: MembershipBackfillReport['productionSafety'] }
    expect(printed.productionSafety.backupReference?.membersChecksum).toBe(HEX64)
    logSpy.mockRestore()
  })
})
