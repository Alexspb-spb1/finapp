import { describe, it, expect } from 'vitest'
import { validateDecisions } from './decisions.ts'

const HEX64 = 'a'.repeat(64)

// Default findingType is 'role_mismatch' — compatible with both
// confirm_role and exclude (COMPATIBLE_RESOLUTIONS), so most tests below
// only need to vary `resolution`. Tests exercising `accept_existing` (only
// compatible with `existing_membership_conflict`) or user-level findings
// override `findingType` explicitly.
const validDecision = {
  uid: 'u1', companyId: 'co_a', findingType: 'role_mismatch', evidenceFingerprint: HEX64,
  resolution: 'exclude', reason: 'reviewed manually', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z',
}

describe('validateDecisions — happy paths', () => {
  it('accepts a valid exclude decision', () => {
    const result = validateDecisions([validDecision])
    expect(result.ok).toBe(true)
    expect(result.decisions).toHaveLength(1)
  })

  it('accepts a valid confirm_role decision with a known role', () => {
    const result = validateDecisions([{ ...validDecision, resolution: 'confirm_role', role: 'viewer' }])
    expect(result.ok).toBe(true)
    expect(result.decisions[0]?.role).toBe('viewer')
  })

  it('accepts a valid accept_existing decision', () => {
    const result = validateDecisions([{ ...validDecision, findingType: 'existing_membership_conflict', resolution: 'accept_existing' }])
    expect(result.ok).toBe(true)
  })

  // ── Independent audit fix #3 (2nd round): user-level decisions ─────────
  it('accepts a user-level exclude decision with no companyId at all', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const result = validateDecisions([{ ...userLevel, findingType: 'no_usable_relations' }])
    expect(result.ok).toBe(true)
    expect(result.decisions[0]?.companyId).toBeUndefined()
  })
})

describe('validateDecisions — finding-bound contract (independent audit fixes, 4th round, item 3.1)', () => {
  it('rejects an unknown findingType', () => {
    const result = validateDecisions([{ ...validDecision, findingType: 'not_a_real_finding' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('findingType')
  })

  it('rejects a missing findingType', () => {
    const { findingType: _drop, ...incomplete } = validDecision
    const result = validateDecisions([incomplete])
    expect(result.ok).toBe(false)
  })

  it('rejects a missing evidenceFingerprint', () => {
    const { evidenceFingerprint: _drop, ...incomplete } = validDecision
    const result = validateDecisions([incomplete])
    expect(result.ok).toBe(false)
  })

  it('rejects a non-hex evidenceFingerprint', () => {
    const result = validateDecisions([{ ...validDecision, evidenceFingerprint: 'not-a-hash' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('evidenceFingerprint')
  })

  it('normalizes evidenceFingerprint to lowercase (same discipline as expected-report-sha256)', () => {
    const result = validateDecisions([{ ...validDecision, evidenceFingerprint: HEX64.toUpperCase() }])
    expect(result.ok).toBe(true)
    expect(result.decisions[0]?.evidenceFingerprint).toBe(HEX64)
  })

  // ── "exclude for missing_company не может разрешать role_mismatch" ─────
  it('rejects confirm_role for a findingType that only allows exclude (e.g. missing_company)', () => {
    const result = validateDecisions([{ ...validDecision, findingType: 'missing_company', resolution: 'confirm_role', role: 'admin' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('missing_company')
  })

  it('rejects accept_existing for role_mismatch (only confirm_role/exclude are compatible)', () => {
    const result = validateDecisions([{ ...validDecision, findingType: 'role_mismatch', resolution: 'accept_existing' }])
    expect(result.ok).toBe(false)
  })

  it('rejects confirm_role for existing_membership_conflict (only accept_existing/exclude are compatible)', () => {
    const result = validateDecisions([{ ...validDecision, findingType: 'existing_membership_conflict', resolution: 'confirm_role', role: 'admin' }])
    expect(result.ok).toBe(false)
  })

  it('rejects ANY resolution for malformed_owner_id (never decision-resolvable)', () => {
    const result = validateDecisions([{ ...validDecision, companyId: 'co_a', findingType: 'malformed_owner_id', resolution: 'exclude' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('none')
  })

  it('rejects a company-scoped findingType (e.g. role_mismatch) supplied without companyId', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const result = validateDecisions([userLevel])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('companyId')
  })

  it('rejects a user-level findingType (e.g. no_usable_relations) supplied WITH a companyId', () => {
    const result = validateDecisions([{ ...validDecision, findingType: 'no_usable_relations' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('user-level')
  })

  it('allows the SAME (companyId, uid) pair to carry decisions for two DIFFERENT finding types', () => {
    const result = validateDecisions([
      validDecision,
      { ...validDecision, findingType: 'existing_membership_conflict', resolution: 'accept_existing', evidenceFingerprint: 'b'.repeat(64) },
    ])
    expect(result.ok).toBe(true)
    expect(result.decisions).toHaveLength(2)
  })

  it('rejects a duplicate (identity, findingType) pair even with a different evidenceFingerprint', () => {
    const result = validateDecisions([validDecision, { ...validDecision, evidenceFingerprint: 'b'.repeat(64) }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('duplicate')
  })
})

describe('validateDecisions — rejects invalid/incomplete/duplicate entries', () => {
  it('rejects a non-array payload', () => {
    expect(validateDecisions({}).ok).toBe(false)
  })

  it('rejects a missing required field', () => {
    const { reason: _drop, ...incomplete } = validDecision
    const result = validateDecisions([incomplete])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('reason')
  })

  it('rejects an unknown field (no permissive passthrough)', () => {
    const result = validateDecisions([{ ...validDecision, force: true }])
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown resolution value', () => {
    const result = validateDecisions([{ ...validDecision, resolution: 'force_apply' }])
    expect(result.ok).toBe(false)
  })

  it('rejects confirm_role without a role', () => {
    const result = validateDecisions([{ ...validDecision, resolution: 'confirm_role' }])
    expect(result.ok).toBe(false)
  })

  it('rejects confirm_role with an unknown role', () => {
    const result = validateDecisions([{ ...validDecision, resolution: 'confirm_role', role: 'superadmin' }])
    expect(result.ok).toBe(false)
  })

  it('rejects a role field on a non-confirm_role decision', () => {
    const result = validateDecisions([{ ...validDecision, role: 'admin' }])
    expect(result.ok).toBe(false)
  })

  it('rejects duplicate decisions for the same (companyId, uid, findingType)', () => {
    const result = validateDecisions([validDecision, { ...validDecision, resolution: 'confirm_role', role: 'admin' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('duplicate')
  })

  it('rejects an unparseable reviewedAt', () => {
    const result = validateDecisions([{ ...validDecision, reviewedAt: 'not-a-date' }])
    expect(result.ok).toBe(false)
  })

  it('rejects a user-level (no companyId) decision with resolution confirm_role', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const result = validateDecisions([{ ...userLevel, findingType: 'no_usable_relations', resolution: 'confirm_role', role: 'viewer' }])
    expect(result.ok).toBe(false)
  })

  it('rejects a user-level (no companyId) decision with resolution accept_existing', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const result = validateDecisions([{ ...userLevel, findingType: 'no_usable_relations', resolution: 'accept_existing' }])
    expect(result.ok).toBe(false)
  })

  it('rejects an empty-string companyId (must be omitted entirely for user-level, not blank)', () => {
    const result = validateDecisions([{ ...validDecision, companyId: '' }])
    expect(result.ok).toBe(false)
  })

  it('rejects duplicate user-level decisions for the same (uid, findingType)', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const withFindingType = { ...userLevel, findingType: 'no_usable_relations' as const }
    const result = validateDecisions([withFindingType, { ...withFindingType, reason: 'a different reason' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('duplicate')
  })

  it('a user-level decision and a relation-level decision for the SAME uid do not collide (different namespaces)', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const result = validateDecisions([{ ...userLevel, findingType: 'no_usable_relations' }, validDecision])
    expect(result.ok).toBe(true)
    expect(result.decisions).toHaveLength(2)
  })
})
