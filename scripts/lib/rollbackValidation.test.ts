import { describe, it, expect } from 'vitest'
import { validateSourceReportForRollback } from './rollbackValidation.ts'
import { REPORT_SCHEMA_VERSION } from './report.ts'

const expected = { environment: 'emulator' as const, projectId: 'demo-finapp' }

function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: 'apply',
    environment: 'emulator',
    projectId: 'demo-finapp',
    rollbackManifest: [{ companyId: 'co_a', uid: 'u1', path: 'companies/co_a/members/u1' }],
    createdPaths: [{ companyId: 'co_a', uid: 'u1', path: 'companies/co_a/members/u1', createTimeIso: '2026-01-01T00:00:00.000Z', updateTimeIso: '2026-01-01T00:00:00.000Z' }],
    plannedCreates: [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }],
    ...overrides,
  }
}

describe('validateSourceReportForRollback — accepts a valid apply report', () => {
  it('produces one validated entry with expected role/status/timestamps', () => {
    const result = validateSourceReportForRollback(validReport(), expected)
    expect(result.ok).toBe(true)
    expect(result.entries).toEqual([{
      companyId: 'co_a', uid: 'u1', path: 'companies/co_a/members/u1',
      expectedRole: 'admin', expectedStatus: 'active',
      createTimeIso: '2026-01-01T00:00:00.000Z', updateTimeIso: '2026-01-01T00:00:00.000Z',
    }])
  })
})

describe('validateSourceReportForRollback — rejects tampered/wrong-project reports without producing any entries', () => {
  it('rejects a non-object payload', () => {
    expect(validateSourceReportForRollback(null, expected).ok).toBe(false)
    expect(validateSourceReportForRollback('not an object', expected).ok).toBe(false)
  })

  it('rejects the wrong schemaVersion', () => {
    const result = validateSourceReportForRollback(validReport({ schemaVersion: 999 }), expected)
    expect(result.ok).toBe(false)
    expect(result.entries).toEqual([])
  })

  it('rejects mode !== apply (e.g. a dry-run or verify report)', () => {
    const result = validateSourceReportForRollback(validReport({ mode: 'dry-run' }), expected)
    expect(result.ok).toBe(false)
  })

  it('rejects an environment mismatch', () => {
    const result = validateSourceReportForRollback(validReport({ environment: 'staging' }), expected)
    expect(result.ok).toBe(false)
  })

  it('rejects a projectId mismatch (report from a different/wrong project)', () => {
    const result = validateSourceReportForRollback(validReport({ projectId: 'some-other-project' }), expected)
    expect(result.ok).toBe(false)
  })

  it('rejects a manifest entry with a non-canonical path', () => {
    const result = validateSourceReportForRollback(validReport({
      rollbackManifest: [{ companyId: 'co_a', uid: 'u1', path: 'companies/co_a/members/u1/extra' }],
    }), expected)
    expect(result.ok).toBe(false)
  })

  it('rejects duplicate (companyId, uid) pairs in the manifest', () => {
    const result = validateSourceReportForRollback(validReport({
      rollbackManifest: [
        { companyId: 'co_a', uid: 'u1', path: 'companies/co_a/members/u1' },
        { companyId: 'co_a', uid: 'u1', path: 'companies/co_a/members/u1' },
      ],
    }), expected)
    expect(result.ok).toBe(false)
  })

  it('rejects a manifest entry with no matching createdPaths record', () => {
    const result = validateSourceReportForRollback(validReport({ createdPaths: [] }), expected)
    expect(result.ok).toBe(false)
  })

  it('rejects a manifest entry whose createdPaths record is missing timestamp metadata', () => {
    const result = validateSourceReportForRollback(validReport({
      createdPaths: [{ companyId: 'co_a', uid: 'u1', path: 'companies/co_a/members/u1' }],
    }), expected)
    expect(result.ok).toBe(false)
  })

  it('rejects a manifest entry with no matching plannedCreates record', () => {
    const result = validateSourceReportForRollback(validReport({ plannedCreates: [] }), expected)
    expect(result.ok).toBe(false)
  })

  it('rejects a manifest entry whose plannedCreates record has an unknown role', () => {
    const result = validateSourceReportForRollback(validReport({
      plannedCreates: [{ companyId: 'co_a', uid: 'u1', role: 'superadmin', status: 'active' }],
    }), expected)
    expect(result.ok).toBe(false)
  })

  it('rejects when rollbackManifest is missing/not an array', () => {
    const result = validateSourceReportForRollback(validReport({ rollbackManifest: 'not-an-array' }), expected)
    expect(result.ok).toBe(false)
  })
})
