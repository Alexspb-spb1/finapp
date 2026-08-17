import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { buildPlan } from './planner.ts'
import { relationKey, type LegacyExtractionResult, type Decision } from './types.ts'

const ts = Timestamp.now()

function emptyExtraction(): LegacyExtractionResult {
  return { confirmed: [], conflicts: [], orphans: [], ownerAnomalies: [], unknownUsers: [], malformedClaims: [] }
}

describe('buildPlan — existing membership reconciliation', () => {
  it('skips an existing membership that already exactly matches the candidate', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map([['co_a', new Set(['u1'])]]), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
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
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.plannedCreates).toEqual([])
    expect(plan.unresolvedConflicts).toEqual([{ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' }])
    expect(plan.applyAllowed).toBe(false)
  })

  it('a corrupted (extra-field) existing membership is also never overwritten', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts, extra: 1 }]])
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.plannedCreates).toEqual([])
    expect(plan.unresolvedConflicts[0]?.reason).toBe('existing_membership_conflict')
  })

  // ── Independent audit fix #2 (1st round) ────────────────────────────────
  it('accept_existing resolves a differs-but-VALID existing membership (different role, otherwise well-formed active doc)', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'accountant', status: 'active', createdAt: ts, updatedAt: ts }]])
    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_a', resolution: 'accept_existing', reason: 'existing role is correct', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.skipped).toEqual([{ companyId: 'co_a', uid: 'u1' }])
    expect(plan.unresolvedConflicts).toEqual([])
  })

  it('accept_existing NEVER resolves an existing membership with an unknown role — stays a blocking conflict', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'superadmin', status: 'active', createdAt: ts, updatedAt: ts }]])
    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_a', resolution: 'accept_existing', reason: 'trying to force it', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.skipped).toEqual([])
    expect(plan.unresolvedConflicts).toEqual([{ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' }])
    expect(plan.applyAllowed).toBe(false)
  })

  it('accept_existing NEVER resolves an existing membership with a DISABLED (inactive) status', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'disabled', createdAt: ts, updatedAt: ts }]])
    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_a', resolution: 'accept_existing', reason: 'trying to force it', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.skipped).toEqual([])
    expect(plan.unresolvedConflicts).toEqual([{ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' }])
  })

  it('accept_existing NEVER resolves an existing membership with a uid mismatch', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'someone_else', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }]])
    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_a', resolution: 'accept_existing', reason: 'trying to force it', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.unresolvedConflicts).toEqual([{ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' }])
  })

  it('accept_existing NEVER resolves an existing membership with missing timestamps', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'viewer', status: 'active' }]])
    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_a', resolution: 'accept_existing', reason: 'trying to force it', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.unresolvedConflicts).toEqual([{ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' }])
  })

  // ── Independent audit fix #2 (2nd round) ────────────────────────────────
  it('a plain {seconds,nanoseconds} object standing in for a Timestamp does NOT satisfy the last-admin gate', () => {
    const fakeTs = { seconds: 1, nanoseconds: 0 }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'active', createdAt: fakeTs, updatedAt: fakeTs }]])
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(),
    })
    // existingActiveAdmins is computed upstream by firestoreReaders.ts using
    // the real Timestamp check — simulated here by NOT including co_a in
    // the map, proving the gate depends on that strict computation.
    expect(plan.companiesWithoutAdmin).toEqual(['co_a'])
    expect(plan.applyAllowed).toBe(false)
  })
})

describe('buildPlan — last-admin gate covers EVERY existing company (independent audit fix #1)', () => {
  it('a company with NO relations at all and no admin blocks apply, even though nothing else touches it', () => {
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_untouched']), allUserIds: new Set(),
    })
    expect(plan.companiesWithoutAdmin).toEqual(['co_untouched'])
    expect(plan.applyAllowed).toBe(false)
  })

  it('a company with an existing but CORRUPTED admin document does not pass the gate', () => {
    // existingActiveAdmins is computed upstream (firestoreReaders.ts) using
    // the strict validator — a corrupted admin never makes it into this
    // map in the first place. Simulate that here: the map has no entry for
    // co_a even though a (corrupted) admin-shaped doc exists in
    // existingMemberships, proving the gate relies on the STRICT set, not
    // on existingMemberships directly.
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts, extra: 'corrupt' }]])
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(),
    })
    expect(plan.companiesWithoutAdmin).toEqual(['co_a'])
    expect(plan.applyAllowed).toBe(false)
  })

  it('a company with no legacy relation but a valid existing admin passes the gate', () => {
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map([['co_a', new Set(['u1'])]]), allCompanyIds: new Set(['co_a']), allUserIds: new Set(),
    })
    expect(plan.companiesWithoutAdmin).toEqual([])
    expect(plan.applyAllowed).toBe(true)
  })

  it('a company with only a viewer and no admin blocks the ENTIRE apply, before any writes', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'viewer', sources: ['users.home'] }],
    }
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.companiesWithoutAdmin).toEqual(['co_a'])
    expect(plan.applyAllowed).toBe(false)
    expect(plan.plannedCreates).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'viewer', status: 'active' }])
  })

  it('an existing active admin satisfies the gate without any planned admin create', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u2', role: 'viewer', sources: ['users.home'] }],
    }
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map([['co_a', new Set(['u1'])]]), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u2']),
    })
    expect(plan.companiesWithoutAdmin).toEqual([])
    expect(plan.applyAllowed).toBe(true)
  })

  it('a planned admin create satisfies the gate', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
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
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
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
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.unresolvedConflicts).toEqual([])
    expect(plan.plannedCreates).toEqual([])
  })

  it('an invalid/incompatible decision resolution leaves the conflict unresolved (no permissive fallback)', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      conflicts: [{ companyId: 'co_a', uid: 'u1', reason: 'role_mismatch', observedRoles: ['admin', 'viewer'] }],
    }
    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_a', resolution: 'accept_existing', reason: 'n/a', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.unresolvedConflicts).toHaveLength(1)
    expect(plan.applyAllowed).toBe(false)
  })

  it('an unresolved orphan blocks apply until acknowledged via an exclude decision', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      orphans: [{ companyId: 'co_ghost', uid: 'u1', reason: 'missing_company' }],
    }
    const blocked = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(blocked.applyAllowed).toBe(false)

    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_ghost', resolution: 'exclude', reason: 'known dangling reference', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const acknowledged = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(acknowledged.unresolvedOrphans).toEqual([])
    expect(acknowledged.applyAllowed).toBe(true)
  })

  it('owner-without-admin-membership blocks apply until decided', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      ownerAnomalies: [{ companyId: 'co_a', uid: 'owner1', reason: 'owner_without_admin_membership' }],
    }
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['owner1']),
    })
    expect(plan.applyAllowed).toBe(false)
    expect(plan.unresolvedOwnerAnomalies).toHaveLength(1)
  })

  // ── Independent audit fix #4 (2nd round) ────────────────────────────────
  it('confirm_role is refused (stays unresolved) when the target company no longer exists', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      conflicts: [{ companyId: 'co_gone', uid: 'u1', reason: 'role_mismatch', observedRoles: ['admin', 'viewer'] }],
    }
    const decisions: Decision[] = [{ uid: 'u1', companyId: 'co_gone', resolution: 'confirm_role', role: 'admin', reason: 'checked with owner', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']), // co_gone NOT in allCompanyIds
    })
    expect(plan.unresolvedConflicts).toEqual([{ companyId: 'co_gone', uid: 'u1', reason: 'role_mismatch', observedRoles: ['admin', 'viewer'] }])
    expect(plan.plannedCreates).toEqual([])
    expect(plan.applyAllowed).toBe(false)
  })

  it('confirm_role is refused (stays unresolved) when the target user no longer exists', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      ownerAnomalies: [{ companyId: 'co_a', uid: 'owner_gone', reason: 'owner_without_admin_membership' }],
    }
    const decisions: Decision[] = [{ uid: 'owner_gone', companyId: 'co_a', resolution: 'confirm_role', role: 'admin', reason: 'checked with owner', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(), // owner_gone NOT in allUserIds
    })
    expect(plan.unresolvedOwnerAnomalies).toEqual([{ companyId: 'co_a', uid: 'owner_gone', reason: 'owner_without_admin_membership' }])
    expect(plan.applyAllowed).toBe(false)
  })
})

describe('buildPlan — unknown users (independent audit fix #6, 1st round; blocking as of 2nd round fix #3)', () => {
  it('a user with no usable relation is surfaced as unknown and BLOCKS apply', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      unknownUsers: [{ uid: 'u_orphan', reason: 'no_usable_relations' }],
    }
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u_orphan']),
    })
    expect(plan.unknownUsers).toEqual([{ uid: 'u_orphan', reason: 'no_usable_relations' }])
    expect(plan.applyAllowed).toBe(false)
  })

  it('a user already covered by a valid existing canonical membership is NOT reported as unknown', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      unknownUsers: [{ uid: 'u_covered', reason: 'no_usable_relations' }],
    }
    const existing = new Map([[relationKey('co_a', 'u_covered'), { uid: 'u_covered', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u_covered']),
    })
    expect(plan.unknownUsers).toEqual([])
  })

  it('a user with only a CORRUPTED existing membership is still reported as unknown', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      unknownUsers: [{ uid: 'u_corrupt', reason: 'no_usable_relations' }],
    }
    const existing = new Map([[relationKey('co_a', 'u_corrupt'), { uid: 'u_corrupt', role: 'viewer', status: 'invited', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u_corrupt']),
    })
    expect(plan.unknownUsers).toEqual([{ uid: 'u_corrupt', reason: 'no_usable_relations' }])
  })

  // ── Independent audit fix #3 (2nd round) ──────────────────────────────
  it('a user-level exclude decision (no companyId) acknowledges an unknown user and unblocks apply', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      unknownUsers: [{ uid: 'u_orphan', reason: 'no_usable_relations' }],
    }
    const decisions: Decision[] = [{ uid: 'u_orphan', resolution: 'exclude', reason: 'confirmed dead account, no relation to migrate', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u_orphan']),
    })
    expect(plan.unknownUsers).toEqual([])
    expect(plan.applyAllowed).toBe(true)
  })

  it('a relation-level decision for a DIFFERENT uid does not accidentally acknowledge an unknown user', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      unknownUsers: [{ uid: 'u_orphan', reason: 'no_usable_relations' }],
    }
    const decisions: Decision[] = [{ uid: 'u_other', companyId: 'co_a', resolution: 'exclude', reason: 'unrelated', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u_orphan', 'u_other']),
    })
    expect(plan.unknownUsers).toEqual([{ uid: 'u_orphan', reason: 'no_usable_relations' }])
    expect(plan.applyAllowed).toBe(false)
  })
})

describe('buildPlan — malformed claims (independent audit fix #3, 2nd round: now BLOCKING)', () => {
  it('malformedClaims from extraction block apply until acknowledged', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      malformedClaims: [{ uid: 'u1', reason: 'malformed_companies_entry' }],
    }
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(plan.malformedClaims).toEqual([{ uid: 'u1', reason: 'malformed_companies_entry' }])
    expect(plan.applyAllowed).toBe(false)
  })

  it('a user-level exclude decision acknowledges a malformed claim and unblocks apply', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      malformedClaims: [{ uid: 'u1', reason: 'malformed_companies_entry' }],
    }
    const decisions: Decision[] = [{ uid: 'u1', resolution: 'exclude', reason: 'source data fixed manually, safe to ignore this run', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(plan.malformedClaims).toEqual([])
    expect(plan.applyAllowed).toBe(true)
  })
})

// ── Independent audit fix #3 (3rd round, follow-up correction): existing
// membership integrity is now reported via the SEPARATE, never-decision-
// resolvable `danglingMemberships` list — not `unresolvedOrphans`. The
// original version of this step (fixed once already this round) reused
// `unresolvedOrphans` and let a relation-level `exclude` decision remove
// the entry, which meant `applyAllowed` could become `true` — and `verify`
// could report success — while the dangling document still physically
// existed in Firestore. This describe block covers the corrected behavior.
describe('buildPlan — existing membership integrity is BLOCKING and NEVER decision-resolvable (independent audit fix #3, 3rd round follow-up)', () => {
  it('an existing membership under a NONEXISTENT company is surfaced in danglingMemberships, never unresolvedOrphans', () => {
    const existing = new Map([[relationKey('co_ghost', 'u1'), { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']), // co_ghost NOT in allCompanyIds
    })
    expect(plan.danglingMemberships).toContainEqual({ companyId: 'co_ghost', uid: 'u1', reason: 'existing_membership_missing_company' })
    expect(plan.unresolvedOrphans).toEqual([]) // NOT the legacy-orphan list
    expect(plan.applyAllowed).toBe(false)
  })

  it('an existing membership under a nonexistent company does NOT suppress an unknownUsers entry for the same uid', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      unknownUsers: [{ uid: 'u1', reason: 'no_usable_relations' }],
    }
    const existing = new Map([[relationKey('co_ghost', 'u1'), { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(plan.unknownUsers).toEqual([{ uid: 'u1', reason: 'no_usable_relations' }])
  })

  it('an existing admin membership whose uid has NO users/{uid} document is surfaced in danglingMemberships', () => {
    const existing = new Map([[relationKey('co_a', 'u_ghost'), { uid: 'u_ghost', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(), // u_ghost NOT in allUserIds
    })
    expect(plan.danglingMemberships).toContainEqual({ companyId: 'co_a', uid: 'u_ghost', reason: 'existing_membership_missing_user' })
    expect(plan.unresolvedOrphans).toEqual([])
    expect(plan.applyAllowed).toBe(false)
  })

  it('a valid-looking existing membership whose company AND user both exist is NOT flagged as dangling', () => {
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.danglingMemberships).toEqual([])
  })

  it('an already-invalid (corrupted schema) existing membership is not additionally reported by this integrity check', () => {
    // Corrupted on its own terms (extra field) AND under a missing company —
    // this step only concerns documents that are otherwise strictly valid;
    // an already-invalid document is simply untrusted everywhere already.
    const existing = new Map([[relationKey('co_ghost', 'u1'), { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts, extra: true }]])
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(plan.danglingMemberships).toEqual([])
  })

  // ── Required test #1 (exact fail-open scenario from the review) ────────
  it('a company with a valid real admin PLUS a dangling missing-user membership: a pair-level exclude for the dangling pair still leaves applyAllowed === false', () => {
    const existing = new Map([
      [relationKey('co_a', 'u_real_admin'), { uid: 'u_real_admin', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }],
      [relationKey('co_a', 'u_ghost'), { uid: 'u_ghost', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }],
    ])
    const decisions: Decision[] = [{ uid: 'u_ghost', companyId: 'co_a', resolution: 'exclude', reason: 'trying to acknowledge the dangling doc away', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions, existingMemberships: existing,
      // The real admin (u_real_admin) DOES satisfy the gate — computed
      // upstream by firestoreReaders.ts exactly as it would be in the real
      // pipeline (u_ghost excluded from this map because it's not in
      // allUserIds; u_real_admin included because it is).
      existingActiveAdmins: new Map([['co_a', new Set(['u_real_admin'])]]),
      allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u_real_admin']), // u_ghost NOT in allUserIds
    })
    // The company DOES have a valid admin, so the last-admin gate alone
    // would not have blocked this — proving the ONLY thing keeping
    // applyAllowed false is danglingMemberships being un-clearable.
    expect(plan.companiesWithoutAdmin).toEqual([])
    expect(plan.danglingMemberships).toContainEqual({ companyId: 'co_a', uid: 'u_ghost', reason: 'existing_membership_missing_user' })
    expect(plan.applyAllowed).toBe(false)
  })

  it('a user-level exclude decision (matching the dangling uid) also cannot clear a dangling membership', () => {
    const existing = new Map([
      [relationKey('co_a', 'u_real_admin'), { uid: 'u_real_admin', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }],
      [relationKey('co_ghost', 'u_ghost'), { uid: 'u_ghost', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }],
    ])
    const decisions: Decision[] = [{ uid: 'u_ghost', resolution: 'exclude', reason: 'trying the user-level route instead', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' }]
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions, existingMemberships: existing,
      existingActiveAdmins: new Map([['co_a', new Set(['u_real_admin'])]]),
      allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u_real_admin', 'u_ghost']), // co_ghost NOT in allCompanyIds
    })
    expect(plan.danglingMemberships).toContainEqual({ companyId: 'co_ghost', uid: 'u_ghost', reason: 'existing_membership_missing_company' })
    expect(plan.applyAllowed).toBe(false)
  })

  it('BOTH a pair-level exclude AND a user-level exclude together still cannot clear a dangling membership under a missing company', () => {
    const existing = new Map([[relationKey('co_ghost', 'u1'), { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const decisions: Decision[] = [
      { uid: 'u1', companyId: 'co_ghost', resolution: 'exclude', reason: 'pair-level attempt', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z' },
      { uid: 'u1', resolution: 'exclude', reason: 'user-level attempt too', reviewedBy: 'bob', reviewedAt: '2026-01-01T00:00:01.000Z' },
    ]
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(plan.danglingMemberships).toContainEqual({ companyId: 'co_ghost', uid: 'u1', reason: 'existing_membership_missing_company' })
    expect(plan.applyAllowed).toBe(false)
  })
})

// ── Independent audit fix #4 (3rd round): collision-free deterministic ordering ──
describe('buildPlan — plannedCreates/skipped ordering is collision-free and deterministic (independent audit fix #4, 3rd round)', () => {
  it('companyId="a",uid="bc" and companyId="ab",uid="c" sort correctly regardless of input order (concatenation collision)', () => {
    const extractionForward: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [
        { companyId: 'a', uid: 'bc', role: 'viewer', sources: ['users.home'] },
        { companyId: 'ab', uid: 'c', role: 'viewer', sources: ['users.home'] },
      ],
    }
    const forward = buildPlan({
      extraction: extractionForward, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map([['a', new Set(['admin1'])], ['ab', new Set(['admin1'])]]),
      allCompanyIds: new Set(['a', 'ab']), allUserIds: new Set(['bc', 'c']),
    })
    expect(forward.plannedCreates.map(c => `${c.companyId}/${c.uid}`)).toEqual(['a/bc', 'ab/c'])

    const extractionReversed: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [
        { companyId: 'ab', uid: 'c', role: 'viewer', sources: ['users.home'] },
        { companyId: 'a', uid: 'bc', role: 'viewer', sources: ['users.home'] },
      ],
    }
    const reversed = buildPlan({
      extraction: extractionReversed, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map([['a', new Set(['admin1'])], ['ab', new Set(['admin1'])]]),
      allCompanyIds: new Set(['a', 'ab']), allUserIds: new Set(['bc', 'c']),
    })
    expect(reversed.plannedCreates.map(c => `${c.companyId}/${c.uid}`)).toEqual(['a/bc', 'ab/c'])
  })

  it('skipped relations sort the same way, regardless of input order', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [
        { companyId: 'ab', uid: 'c', role: 'viewer', sources: ['users.home'] },
        { companyId: 'a', uid: 'bc', role: 'viewer', sources: ['users.home'] },
      ],
    }
    const existing = new Map([
      [relationKey('ab', 'c'), { uid: 'c', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }],
      [relationKey('a', 'bc'), { uid: 'bc', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }],
    ])
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map([['a', new Set(['admin1'])], ['ab', new Set(['admin1'])]]),
      allCompanyIds: new Set(['a', 'ab']), allUserIds: new Set(['bc', 'c']),
    })
    expect(plan.skipped.map(s => `${s.companyId}/${s.uid}`)).toEqual(['a/bc', 'ab/c'])
  })
})
