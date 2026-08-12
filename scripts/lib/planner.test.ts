import { describe, it, expect } from 'vitest'
import { buildPlan } from './planner.ts'
import { relationKey, type LegacyExtractionResult, type Decision } from './types.ts'

const ts = { seconds: 1, nanoseconds: 0 }

function emptyExtraction(): LegacyExtractionResult {
  return { confirmed: [], conflicts: [], orphans: [], ownerAnomalies: [] }
}

describe('buildPlan — existing membership reconciliation', () => {
  it('skips an existing membership that already exactly matches the candidate', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({ extraction, decisions: [], existingMemberships: existing, existingActiveAdmins: new Map([['co_a', new Set(['u1'])]]) })
    expect(plan.plannedCreates).toEqual([])
    expect(plan.skipped).toEqual([{ companyId: 'co_a', uid: 'u1' }])
    expect(plan.applyAllowed).toBe(true)
  })

  it('never overwrites an existing membership that differs — surfaces as an unresolved conflict', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({ extraction, decisions: [], existingMemberships: existing, existingActiveAdmins: new Map() })
    expect(plan.plannedCreates).toEqual([])
    expect(plan.unresolvedConflicts).toEqual([{ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' }])
    expect(plan.applyAllowed).toBe(false)
  })

  it('a corrupted existing membership is also never overwritten', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts, extra: 1 }]])
    const plan = buildPlan({ extraction, decisions: [], existingMemberships: existing, existingActiveAdmins: new Map() })
    expect(plan.plannedCreates).toEqual([])
    expect(plan.unresolvedConflicts[0]?.reason).toBe('existing_membership_conflict')
  })
})

describe('buildPlan — last-admin-per-company gate', () => {
  it('a company with no projected active admin blocks the ENTIRE apply, before any writes', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'viewer', sources: ['users.home'] }],
    }
    const plan = buildPlan({ extraction, decisions: [], existingMemberships: new Map(), existingActiveAdmins: new Map() })
    expect(plan.companiesWithoutAdmin).toEqual(['co_a'])
    expect(plan.applyAllowed).toBe(false)
    // The viewer relation itself is still a valid, non-conflicting planned create —
    // it's the WHOLE apply that is blocked, not this one relation individually.
    expect(plan.plannedCreates).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'viewer', status: 'active' }])
  })

  it('an existing active admin satisfies the gate without any planned admin create', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u2', role: 'viewer', sources: ['users.home'] }],
    }
    const plan = buildPlan({ extraction, decisions: [], existingMemberships: new Map(), existingActiveAdmins: new Map([['co_a', new Set(['u1'])]]) })
    expect(plan.companiesWithoutAdmin).toEqual([])
    expect(plan.applyAllowed).toBe(true)
  })

  it('a planned admin create satisfies the gate', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const plan = buildPlan({ extraction, decisions: [], existingMemberships: new Map(), existingActiveAdmins: new Map() })
    expect(plan.companiesWithoutAdmin).toEqual([])
    expect(plan.applyAllowed).toBe(true)
  })
})

describe('buildPlan — manual decisions', () => {
  it('a confirm_role decision resolves an unresolved role conflict and appears in the plan', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      conflicts: [{ companyId: 'co_a', uid: 'u1', reason: 'role_mismatch', observedRoles: ['admin', 'viewer'] }],
    }
    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_a', resolution: 'confirm_role', role: 'admin', reason: 'checked with owner', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({ extraction, decisions, existingMemberships: new Map(), existingActiveAdmins: new Map() })
    expect(plan.unresolvedConflicts).toEqual([])
    expect(plan.plannedCreates).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }])
    expect(plan.applyAllowed).toBe(true)
  })

  it('an exclude decision drops the conflict without creating a membership', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      conflicts: [{ companyId: 'co_a', uid: 'u1', reason: 'invalid_role' }],
    }
    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_a', resolution: 'exclude', reason: 'ex-employee', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({ extraction, decisions, existingMemberships: new Map(), existingActiveAdmins: new Map() })
    expect(plan.unresolvedConflicts).toEqual([])
    expect(plan.plannedCreates).toEqual([])
  })

  it('an invalid/incompatible decision resolution leaves the conflict unresolved (no permissive fallback)', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      conflicts: [{ companyId: 'co_a', uid: 'u1', reason: 'role_mismatch', observedRoles: ['admin', 'viewer'] }],
    }
    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_a', resolution: 'accept_existing', reason: 'n/a', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({ extraction, decisions, existingMemberships: new Map(), existingActiveAdmins: new Map() })
    expect(plan.unresolvedConflicts).toHaveLength(1)
    expect(plan.applyAllowed).toBe(false)
  })

  it('an unresolved orphan blocks apply until acknowledged via an exclude decision', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      orphans: [{ companyId: 'co_ghost', uid: 'u1', reason: 'missing_company' }],
    }
    const blocked = buildPlan({ extraction, decisions: [], existingMemberships: new Map(), existingActiveAdmins: new Map() })
    expect(blocked.applyAllowed).toBe(false)

    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_ghost', resolution: 'exclude', reason: 'known dangling reference', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const acknowledged = buildPlan({ extraction, decisions, existingMemberships: new Map(), existingActiveAdmins: new Map() })
    expect(acknowledged.unresolvedOrphans).toEqual([])
    expect(acknowledged.applyAllowed).toBe(true)
  })

  it('owner-without-admin-membership blocks apply until decided', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      ownerAnomalies: [{ companyId: 'co_a', uid: 'owner1', reason: 'owner_without_admin_membership' }],
    }
    const plan = buildPlan({ extraction, decisions: [], existingMemberships: new Map(), existingActiveAdmins: new Map() })
    expect(plan.applyAllowed).toBe(false)
    expect(plan.unresolvedOwnerAnomalies).toHaveLength(1)
  })
})
