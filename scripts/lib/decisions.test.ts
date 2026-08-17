import { describe, it, expect } from 'vitest'
import { validateDecisions } from './decisions.ts'

const validDecision = {
  uid: 'u1', companyId: 'co_a', resolution: 'exclude', reason: 'reviewed manually', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z',
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
    const result = validateDecisions([{ ...validDecision, resolution: 'accept_existing' }])
    expect(result.ok).toBe(true)
  })

  // ── Independent audit fix #3 (2nd round): user-level decisions ─────────
  it('accepts a user-level exclude decision with no companyId at all', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const result = validateDecisions([userLevel])
    expect(result.ok).toBe(true)
    expect(result.decisions[0]?.companyId).toBeUndefined()
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

  it('rejects duplicate decisions for the same (companyId, uid) pair', () => {
    const result = validateDecisions([validDecision, { ...validDecision, resolution: 'accept_existing' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('duplicate')
  })

  it('rejects an unparseable reviewedAt', () => {
    const result = validateDecisions([{ ...validDecision, reviewedAt: 'not-a-date' }])
    expect(result.ok).toBe(false)
  })

  it('rejects a user-level (no companyId) decision with resolution confirm_role', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const result = validateDecisions([{ ...userLevel, resolution: 'confirm_role', role: 'viewer' }])
    expect(result.ok).toBe(false)
  })

  it('rejects a user-level (no companyId) decision with resolution accept_existing', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const result = validateDecisions([{ ...userLevel, resolution: 'accept_existing' }])
    expect(result.ok).toBe(false)
  })

  it('rejects an empty-string companyId (must be omitted entirely for user-level, not blank)', () => {
    const result = validateDecisions([{ ...validDecision, companyId: '' }])
    expect(result.ok).toBe(false)
  })

  it('rejects duplicate user-level decisions for the same uid', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const result = validateDecisions([userLevel, { ...userLevel, reason: 'a different reason' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('duplicate')
  })

  it('a user-level decision and a relation-level decision for the SAME uid do not collide (different namespaces)', () => {
    const { companyId: _drop, ...userLevel } = validDecision
    const result = validateDecisions([userLevel, { ...validDecision, resolution: 'accept_existing' }])
    expect(result.ok).toBe(true)
    expect(result.decisions).toHaveLength(2)
  })
})
