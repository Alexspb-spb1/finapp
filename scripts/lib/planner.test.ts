import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { buildPlan } from './planner.ts'
import { relationKey, type LegacyExtractionResult, type Decision, type ConflictRecord, type OrphanRecord, type OwnerAnomalyRecord, type UnknownUserRecord, type MalformedClaimRecord } from './types.ts'
import { computeFindingFingerprint } from './checksum.ts'

const ts = Timestamp.now()

function emptyExtraction(): LegacyExtractionResult {
  return { confirmed: [], conflicts: [], orphans: [], ownerAnomalies: [], unknownUsers: [], malformedClaims: [], ownerIdAnomalies: [] }
}

// ── Fixture builders — compute evidenceFingerprint the SAME way
// legacyMapping.ts/planner.ts do, so a `decision()` built to match a given
// finding fixture actually matches under the real identity+findingType+
// fingerprint rule (independent audit fixes, 4th round, item 3.1). ────────

function roleMismatchConflict(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  const observedRoles = overrides.observedRoles ?? ['admin', 'viewer']
  const sourceKinds = overrides.sourceKinds ?? ['users.home']
  const evidenceFingerprint = computeFindingFingerprint({ sourceKinds, observedRoles, hasInvalidRole: false })
  return { companyId: 'co_a', uid: 'u1', reason: 'role_mismatch', observedRoles, sourceKinds, evidenceFingerprint, ...overrides }
}

function invalidRoleConflict(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  const sourceKinds = overrides.sourceKinds ?? ['users.home']
  const evidenceFingerprint = computeFindingFingerprint({ sourceKinds, hasInvalidRole: true })
  return { companyId: 'co_a', uid: 'u1', reason: 'invalid_role', hasInvalidRole: true, sourceKinds, evidenceFingerprint, ...overrides }
}

function orphan(overrides: Partial<OrphanRecord> = {}): OrphanRecord {
  const sourceKinds = overrides.sourceKinds ?? ['users.home']
  const observedRoles = overrides.observedRoles ?? []
  const hasInvalidRole = overrides.hasInvalidRole ?? false
  const proposedRole = overrides.proposedRole ?? null
  const evidence = { sourceKinds, observedRoles, hasInvalidRole }
  const evidenceFingerprint = computeFindingFingerprint(evidence)
  return { companyId: 'co_ghost', uid: 'u1', reason: 'missing_company', sourceKinds, observedRoles, hasInvalidRole, proposedRole, evidenceFingerprint, ...overrides }
}

function ownerAnomaly(overrides: Partial<OwnerAnomalyRecord> = {}): OwnerAnomalyRecord {
  return { companyId: 'co_a', uid: 'owner1', reason: 'owner_without_admin_membership', evidenceFingerprint: computeFindingFingerprint({}), ...overrides }
}

function unknownUser(overrides: Partial<UnknownUserRecord> = {}): UnknownUserRecord {
  return { uid: 'u_orphan', reason: 'no_usable_relations', evidenceFingerprint: computeFindingFingerprint({}), ...overrides }
}

function malformedClaim(overrides: Partial<MalformedClaimRecord> = {}): MalformedClaimRecord {
  return { uid: 'u1', reason: 'malformed_companies_entry', evidenceFingerprint: computeFindingFingerprint({}), ...overrides }
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    uid: 'u1', companyId: 'co_a', findingType: 'role_mismatch', evidenceFingerprint: computeFindingFingerprint({}),
    resolution: 'exclude', reason: 'reviewed manually', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
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
    expect(plan.unresolvedConflicts).toHaveLength(1)
    expect(plan.unresolvedConflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' })
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
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_a', findingType: 'existing_membership_conflict',
      evidenceFingerprint: computeFindingFingerprint({ existingRole: 'accountant' }),
      resolution: 'accept_existing', reason: 'existing role is correct',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.skipped).toEqual([{ companyId: 'co_a', uid: 'u1' }])
    expect(plan.unresolvedConflicts).toEqual([])
  })

  it('accept_existing does NOT apply when the evidenceFingerprint is stale (existing role changed since the decision was written)', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'accountant', status: 'active', createdAt: ts, updatedAt: ts }]])
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_a', findingType: 'existing_membership_conflict',
      // Stale: decision was written when the existing role was 'viewer', not 'accountant'.
      evidenceFingerprint: computeFindingFingerprint({ existingRole: 'viewer' }),
      resolution: 'accept_existing', reason: 'existing role is correct',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.staleDecisions).toHaveLength(1)
    expect(plan.unresolvedConflicts).toHaveLength(1)
    expect(plan.applyAllowed).toBe(false)
  })

  it('accept_existing NEVER resolves an existing membership with an unknown role — stays a blocking conflict', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'superadmin', status: 'active', createdAt: ts, updatedAt: ts }]])
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_a', findingType: 'existing_membership_conflict',
      evidenceFingerprint: computeFindingFingerprint({ existingRole: 'superadmin' }),
      resolution: 'accept_existing', reason: 'trying to force it',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.skipped).toEqual([])
    expect(plan.unresolvedConflicts).toHaveLength(1)
    expect(plan.unresolvedConflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' })
    expect(plan.applyAllowed).toBe(false)
  })

  it('accept_existing NEVER resolves an existing membership with a DISABLED (inactive) status', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'disabled', createdAt: ts, updatedAt: ts }]])
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_a', findingType: 'existing_membership_conflict',
      evidenceFingerprint: computeFindingFingerprint({ existingRole: 'admin' }),
      resolution: 'accept_existing', reason: 'trying to force it',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.skipped).toEqual([])
    expect(plan.unresolvedConflicts).toHaveLength(1)
    expect(plan.unresolvedConflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' })
  })

  it('accept_existing NEVER resolves an existing membership with a uid mismatch', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'someone_else', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }]])
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_a', findingType: 'existing_membership_conflict',
      evidenceFingerprint: computeFindingFingerprint({ existingRole: 'admin' }),
      resolution: 'accept_existing', reason: 'trying to force it',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.unresolvedConflicts).toHaveLength(1)
    expect(plan.unresolvedConflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' })
  })

  it('accept_existing NEVER resolves an existing membership with missing timestamps', () => {
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
    }
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'viewer', status: 'active' }]])
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_a', findingType: 'existing_membership_conflict',
      evidenceFingerprint: computeFindingFingerprint({ existingRole: 'viewer' }),
      resolution: 'accept_existing', reason: 'trying to force it',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.unresolvedConflicts).toHaveLength(1)
    expect(plan.unresolvedConflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', reason: 'existing_membership_conflict' })
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

describe('buildPlan — manual decisions (finding-bound contract, independent audit fixes 4th round item 3.1)', () => {
  it('a confirm_role decision resolves an unresolved role conflict and appears in the plan', () => {
    const conflict = roleMismatchConflict()
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), conflicts: [conflict] }
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_a', findingType: 'role_mismatch', evidenceFingerprint: conflict.evidenceFingerprint,
      resolution: 'confirm_role', role: 'admin', reason: 'checked with owner',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.unresolvedConflicts).toEqual([])
    expect(plan.plannedCreates).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }])
    expect(plan.applyAllowed).toBe(true)
  })

  it('an exclude decision drops the conflict without creating a membership', () => {
    const conflict = invalidRoleConflict()
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), conflicts: [conflict] }
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_a', findingType: 'invalid_role', evidenceFingerprint: conflict.evidenceFingerprint,
      resolution: 'exclude', reason: 'ex-employee',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.unresolvedConflicts).toEqual([])
    expect(plan.plannedCreates).toEqual([])
  })

  it('an invalid/incompatible decision resolution leaves the conflict unresolved (no permissive fallback)', () => {
    // decisions.ts's COMPATIBLE_RESOLUTIONS would normally reject this
    // combination at file-validation time; buildPlan() defensively
    // double-checks it too (redundant, independent defense).
    const conflict = roleMismatchConflict()
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), conflicts: [conflict] }
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_a', findingType: 'role_mismatch', evidenceFingerprint: conflict.evidenceFingerprint,
      resolution: 'accept_existing', reason: 'n/a',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.unresolvedConflicts).toHaveLength(1)
    expect(plan.applyAllowed).toBe(false)
  })

  it('an unresolved orphan blocks apply until acknowledged via an exclude decision', () => {
    const orphanRecord = orphan()
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), orphans: [orphanRecord] }
    const blocked = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(blocked.applyAllowed).toBe(false)

    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_ghost', findingType: 'missing_company', evidenceFingerprint: orphanRecord.evidenceFingerprint,
      resolution: 'exclude', reason: 'known dangling reference',
    })]
    const acknowledged = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(acknowledged.unresolvedOrphans).toEqual([])
    expect(acknowledged.applyAllowed).toBe(true)
  })

  // ── Required regression test #1 (task spec §4.1) ────────────────────────
  it('an exclude decision for missing_company does NOT resolve a later role_mismatch for the SAME (companyId, uid) pair', () => {
    const orphanRecord = orphan({ companyId: 'co_a', uid: 'u1' })
    const excludeDecision: Decision = decision({
      uid: 'u1', companyId: 'co_a', findingType: 'missing_company', evidenceFingerprint: orphanRecord.evidenceFingerprint,
      resolution: 'exclude', reason: 'company did not exist last time',
    })
    // The company now exists, and the SAME pair is a role_mismatch conflict
    // instead — a structurally different finding at the SAME identity.
    const conflict = roleMismatchConflict({ companyId: 'co_a', uid: 'u1' })
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), conflicts: [conflict] }
    const plan = buildPlan({
      extraction, decisions: [excludeDecision], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    // The old missing_company exclude must NOT silently resolve role_mismatch.
    expect(plan.unresolvedConflicts).toHaveLength(1)
    expect(plan.applyAllowed).toBe(false)
    // And the old decision, never matched by any CURRENT finding, is reported unused.
    expect(plan.unusedDecisions).toEqual([excludeDecision])
  })

  it('owner-without-admin-membership blocks apply until decided', () => {
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), ownerAnomalies: [ownerAnomaly()] }
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['owner1']),
    })
    expect(plan.applyAllowed).toBe(false)
    expect(plan.unresolvedOwnerAnomalies).toHaveLength(1)
  })

  // ── Independent audit fix #4 (2nd round) ────────────────────────────────
  it('confirm_role is refused (stays unresolved) when the target company no longer exists', () => {
    const conflict = roleMismatchConflict({ companyId: 'co_gone' })
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), conflicts: [conflict] }
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: 'co_gone', findingType: 'role_mismatch', evidenceFingerprint: conflict.evidenceFingerprint,
      resolution: 'confirm_role', role: 'admin', reason: 'checked with owner',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']), // co_gone NOT in allCompanyIds
    })
    expect(plan.unresolvedConflicts).toEqual([conflict])
    expect(plan.plannedCreates).toEqual([])
    expect(plan.applyAllowed).toBe(false)
  })

  it('confirm_role is refused (stays unresolved) when the target user no longer exists', () => {
    const anomaly = ownerAnomaly({ uid: 'owner_gone' })
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), ownerAnomalies: [anomaly] }
    const decisions: Decision[] = [decision({
      uid: 'owner_gone', companyId: 'co_a', findingType: 'owner_without_admin_membership', evidenceFingerprint: anomaly.evidenceFingerprint,
      resolution: 'confirm_role', role: 'admin', reason: 'checked with owner',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(), // owner_gone NOT in allUserIds
    })
    expect(plan.unresolvedOwnerAnomalies).toEqual([anomaly])
    expect(plan.applyAllowed).toBe(false)
  })
})

describe('buildPlan — unknown users (independent audit fix #6, 1st round; blocking as of 2nd round fix #3)', () => {
  it('a user with no usable relation is surfaced as unknown and BLOCKS apply', () => {
    const record = unknownUser({ uid: 'u_orphan' })
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), unknownUsers: [record] }
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u_orphan']),
    })
    expect(plan.unknownUsers).toEqual([record])
    expect(plan.applyAllowed).toBe(false)
  })

  it('a user already covered by a valid existing canonical membership is NOT reported as unknown', () => {
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), unknownUsers: [unknownUser({ uid: 'u_covered' })] }
    const existing = new Map([[relationKey('co_a', 'u_covered'), { uid: 'u_covered', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u_covered']),
    })
    expect(plan.unknownUsers).toEqual([])
  })

  it('a user with only a CORRUPTED existing membership is still reported as unknown', () => {
    const record = unknownUser({ uid: 'u_corrupt' })
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), unknownUsers: [record] }
    const existing = new Map([[relationKey('co_a', 'u_corrupt'), { uid: 'u_corrupt', role: 'viewer', status: 'invited', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u_corrupt']),
    })
    expect(plan.unknownUsers).toEqual([record])
  })

  // ── Independent audit fix #3 (2nd round) ──────────────────────────────
  it('a user-level exclude decision (no companyId) acknowledges an unknown user and unblocks apply', () => {
    const record = unknownUser({ uid: 'u_orphan' })
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), unknownUsers: [record] }
    const decisions: Decision[] = [decision({
      uid: 'u_orphan', companyId: undefined, findingType: 'no_usable_relations', evidenceFingerprint: record.evidenceFingerprint,
      resolution: 'exclude', reason: 'confirmed dead account, no relation to migrate',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u_orphan']),
    })
    expect(plan.unknownUsers).toEqual([])
    expect(plan.applyAllowed).toBe(true)
  })

  it('a relation-level decision for a DIFFERENT uid does not accidentally acknowledge an unknown user', () => {
    const record = unknownUser({ uid: 'u_orphan' })
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), unknownUsers: [record] }
    const decisions: Decision[] = [decision({
      uid: 'u_other', companyId: 'co_a', findingType: 'role_mismatch', evidenceFingerprint: computeFindingFingerprint({}),
      resolution: 'exclude', reason: 'unrelated',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u_orphan', 'u_other']),
    })
    expect(plan.unknownUsers).toEqual([record])
    expect(plan.applyAllowed).toBe(false)
    // The unrelated decision matched no current finding — reported unused.
    expect(plan.unusedDecisions).toHaveLength(1)
  })

  // ── Required regression test #3 ──────────────────────────────────────
  it('an unused decision (no matching finding at all) blocks apply and is reported', () => {
    const decisions: Decision[] = [decision({
      uid: 'u_nonexistent', companyId: 'co_nonexistent', findingType: 'role_mismatch',
      evidenceFingerprint: computeFindingFingerprint({}), resolution: 'exclude', reason: 'stale decision',
    })]
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(),
    })
    expect(plan.unusedDecisions).toEqual(decisions)
    expect(plan.applyAllowed).toBe(false)
  })
})

describe('buildPlan — malformed claims (independent audit fix #3, 2nd round: now BLOCKING)', () => {
  it('malformedClaims from extraction block apply until acknowledged', () => {
    const record = malformedClaim()
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), malformedClaims: [record] }
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(plan.malformedClaims).toEqual([record])
    expect(plan.applyAllowed).toBe(false)
  })

  it('a user-level exclude decision acknowledges a malformed claim and unblocks apply', () => {
    const record = malformedClaim()
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), malformedClaims: [record] }
    const decisions: Decision[] = [decision({
      uid: 'u1', companyId: undefined, findingType: 'malformed_companies_entry', evidenceFingerprint: record.evidenceFingerprint,
      resolution: 'exclude', reason: 'source data fixed manually, safe to ignore this run',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(plan.malformedClaims).toEqual([])
    expect(plan.applyAllowed).toBe(true)
  })

  // ── Required regression test #7 ──────────────────────────────────────
  it('a companies_field_not_array anomaly stays blocking even when the same user ALSO has a valid home relation', () => {
    const record = malformedClaim({ uid: 'u1', reason: 'companies_field_not_array' })
    const extraction: LegacyExtractionResult = {
      ...emptyExtraction(),
      confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }],
      malformedClaims: [record],
    }
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']),
    })
    expect(plan.malformedClaims).toEqual([record])
    expect(plan.plannedCreates).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }])
    expect(plan.applyAllowed).toBe(false)
  })
})

// ── Required regression test #8 ────────────────────────────────────────
describe('buildPlan — owner-id anomalies (independent audit fixes, 4th round, item 3.4)', () => {
  it('a malformed companies.ownerId is always blocking and never decision-resolvable', () => {
    const anomaly = { companyId: 'co_a', reason: 'malformed_owner_id' as const, evidenceFingerprint: computeFindingFingerprint({}) }
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), ownerIdAnomalies: [anomaly] }
    const decisions: Decision[] = [decision({
      uid: 'anyone', companyId: 'co_a', findingType: 'malformed_owner_id', evidenceFingerprint: anomaly.evidenceFingerprint,
      resolution: 'exclude', reason: 'trying to acknowledge it away',
    })]
    const plan = buildPlan({
      extraction, decisions, existingMemberships: new Map(),
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['anyone']),
    })
    expect(plan.ownerIdAnomalies).toEqual([anomaly])
    expect(plan.applyAllowed).toBe(false)
  })
})

// ── Independent audit fix #3 (3rd round, follow-up correction) ─────────
describe('buildPlan — existing membership integrity is BLOCKING and NEVER decision-resolvable (independent audit fix #3, 3rd round follow-up)', () => {
  it('an existing membership under a NONEXISTENT company is surfaced in danglingMemberships, never unresolvedOrphans', () => {
    const existing = new Map([[relationKey('co_ghost', 'u1'), { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']), // co_ghost NOT in allCompanyIds
    })
    expect(plan.danglingMemberships).toContainEqual(expect.objectContaining({ companyId: 'co_ghost', uid: 'u1', reason: 'existing_membership_missing_company' }))
    expect(plan.unresolvedOrphans).toEqual([]) // NOT the legacy-orphan list
    expect(plan.applyAllowed).toBe(false)
  })

  it('an existing membership under a nonexistent company does NOT suppress an unknownUsers entry for the same uid', () => {
    const record = unknownUser({ uid: 'u1' })
    const extraction: LegacyExtractionResult = { ...emptyExtraction(), unknownUsers: [record] }
    const existing = new Map([[relationKey('co_ghost', 'u1'), { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction, decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(plan.unknownUsers).toEqual([record])
  })

  it('an existing admin membership whose uid has NO users/{uid} document is surfaced in danglingMemberships', () => {
    const existing = new Map([[relationKey('co_a', 'u_ghost'), { uid: 'u_ghost', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }]])
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions: [], existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(), // u_ghost NOT in allUserIds
    })
    expect(plan.danglingMemberships).toContainEqual(expect.objectContaining({ companyId: 'co_a', uid: 'u_ghost', reason: 'existing_membership_missing_user' }))
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
    const decisions: Decision[] = [decision({
      // NOTE: DanglingMembershipReason ('existing_membership_missing_user'/
      // '...missing_company') is deliberately NOT part of FindingType — a
      // dangling membership is never decision-resolvable, so buildPlan()
      // never even looks up a decision for it (Step 7 consults no decision
      // index at all). `existing_membership_conflict` here is just any
      // valid FindingType, chosen to prove that point — its specific value
      // is irrelevant to this test's outcome.
      uid: 'u_ghost', companyId: 'co_a', findingType: 'existing_membership_conflict', evidenceFingerprint: computeFindingFingerprint({}),
      resolution: 'exclude', reason: 'trying to acknowledge the dangling doc away',
    })]
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions, existingMemberships: existing,
      existingActiveAdmins: new Map([['co_a', new Set(['u_real_admin'])]]),
      allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u_real_admin']), // u_ghost NOT in allUserIds
    })
    expect(plan.companiesWithoutAdmin).toEqual([])
    expect(plan.danglingMemberships).toContainEqual(expect.objectContaining({ companyId: 'co_a', uid: 'u_ghost', reason: 'existing_membership_missing_user' }))
    expect(plan.applyAllowed).toBe(false)
  })

  it('a user-level exclude decision (matching the dangling uid) also cannot clear a dangling membership', () => {
    const existing = new Map([
      [relationKey('co_a', 'u_real_admin'), { uid: 'u_real_admin', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }],
      [relationKey('co_ghost', 'u_ghost'), { uid: 'u_ghost', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }],
    ])
    const decisions: Decision[] = [decision({
      uid: 'u_ghost', companyId: undefined, findingType: 'no_usable_relations', evidenceFingerprint: computeFindingFingerprint({}),
      resolution: 'exclude', reason: 'trying the user-level route instead',
    })]
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions, existingMemberships: existing,
      existingActiveAdmins: new Map([['co_a', new Set(['u_real_admin'])]]),
      allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u_real_admin', 'u_ghost']), // co_ghost NOT in allCompanyIds
    })
    expect(plan.danglingMemberships).toContainEqual(expect.objectContaining({ companyId: 'co_ghost', uid: 'u_ghost', reason: 'existing_membership_missing_company' }))
    expect(plan.applyAllowed).toBe(false)
  })

  it('BOTH a pair-level exclude AND a user-level exclude together still cannot clear a dangling membership under a missing company', () => {
    const existing = new Map([[relationKey('co_ghost', 'u1'), { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const decisions: Decision[] = [
      decision({ uid: 'u1', companyId: 'co_ghost', findingType: 'existing_membership_conflict', evidenceFingerprint: computeFindingFingerprint({}), resolution: 'exclude', reason: 'pair-level attempt' }),
      decision({ uid: 'u1', companyId: undefined, findingType: 'no_usable_relations', evidenceFingerprint: computeFindingFingerprint({}), resolution: 'exclude', reason: 'user-level attempt too', reviewedBy: 'bob', reviewedAt: '2026-01-01T00:00:01.000Z' }),
    ]
    const plan = buildPlan({
      extraction: emptyExtraction(), decisions, existingMemberships: existing,
      existingActiveAdmins: new Map(), allCompanyIds: new Set(), allUserIds: new Set(['u1']),
    })
    expect(plan.danglingMemberships).toContainEqual(expect.objectContaining({ companyId: 'co_ghost', uid: 'u1', reason: 'existing_membership_missing_company' }))
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
