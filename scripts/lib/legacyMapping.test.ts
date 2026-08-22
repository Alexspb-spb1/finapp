import { describe, it, expect } from 'vitest'
import { extractLegacyRelations } from './legacyMapping.ts'
import type { RawUserDoc, RawCompanyDoc } from './types.ts'

function user(docId: string, data: Record<string, unknown>): RawUserDoc { return { docId, data } }
function company(docId: string, data: Record<string, unknown> = {}): RawCompanyDoc { return { docId, data } }

describe('extractLegacyRelations — primary/home membership', () => {
  it('migrates a valid primary (home) membership', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin' })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }])
    expect(result.conflicts).toEqual([])
  })
})

describe('extractLegacyRelations — companies[] multi-company', () => {
  it('creates correct multi-company memberships from companies[]', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin', companies: [{ companyId: 'co_b', role: 'viewer' }] })],
      [company('co_a'), company('co_b')],
    )
    const byCompany = Object.fromEntries(result.confirmed.map(r => [r.companyId, r.role]))
    expect(byCompany).toEqual({ co_a: 'admin', co_b: 'viewer' })
  })
})

describe('extractLegacyRelations — deduplication', () => {
  it('dedupes identical duplicate sources with the same role', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin', companies: [{ companyId: 'co_a', role: 'admin' }] })],
      [company('co_a')],
    )
    expect(result.confirmed).toHaveLength(1)
    expect(result.confirmed[0]!.sources.sort()).toEqual(['users.companies[]', 'users.home'])
    expect(result.conflicts).toEqual([])
  })
})

describe('extractLegacyRelations — role conflicts', () => {
  it('does not auto-resolve a role conflict from two different sources', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin', companies: [{ companyId: 'co_a', role: 'viewer' }] })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([])
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', reason: 'role_mismatch', observedRoles: ['admin', 'viewer'] })
  })

  // ── Independent audit fixes, 4th round, item 3.3: evidence now carries source kinds ──
  it('a role_mismatch conflict records both contributing source kinds', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin', companies: [{ companyId: 'co_a', role: 'viewer' }] })],
      [company('co_a')],
    )
    expect(result.conflicts[0]?.sourceKinds).toEqual(['users.companies[]', 'users.home'])
    expect(result.conflicts[0]?.hasInvalidRole).toBeUndefined()
    expect(result.conflicts[0]?.evidenceFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('two different observed-role sets produce two different evidenceFingerprints', () => {
    const a = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin', companies: [{ companyId: 'co_a', role: 'viewer' }] })],
      [company('co_a')],
    )
    const b = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin', companies: [{ companyId: 'co_a', role: 'accountant' }] })],
      [company('co_a')],
    )
    expect(a.conflicts[0]?.evidenceFingerprint).not.toBe(b.conflicts[0]?.evidenceFingerprint)
  })
})

describe('extractLegacyRelations — unknown/corrupt role', () => {
  it('never turns an unknown role into admin (or anything else)', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'superadmin' })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([])
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', reason: 'invalid_role', hasInvalidRole: true, sourceKinds: ['users.home'] })
  })

  it('treats an empty-string role the same way', () => {
    const result = extractLegacyRelations([user('u1', { companyId: 'co_a', role: '' })], [company('co_a')])
    expect(result.confirmed).toEqual([])
    expect(result.conflicts[0]?.reason).toBe('invalid_role')
  })

  it('treats a missing role field the same way', () => {
    const result = extractLegacyRelations([user('u1', { companyId: 'co_a' })], [company('co_a')])
    expect(result.confirmed).toEqual([])
    expect(result.conflicts[0]?.reason).toBe('invalid_role')
  })
})

describe('extractLegacyRelations — missing company', () => {
  it('a relation referencing a nonexistent company becomes an orphan, never a membership', () => {
    const result = extractLegacyRelations([user('u1', { companyId: 'co_ghost', role: 'admin' })], [])
    expect(result.confirmed).toEqual([])
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0]).toMatchObject({ companyId: 'co_ghost', uid: 'u1', reason: 'missing_company', sourceKinds: ['users.home'] })
    expect(result.orphans[0]?.evidenceFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  // ── Independent audit fixes, 4th round, item 3.3: orphan evidence carries source kind + attempted role ──
  it('an orphan sourced from BOTH users.home and users.companies[] records both kinds', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_ghost', role: 'admin', companies: [{ companyId: 'co_ghost', role: 'admin' }] })],
      [],
    )
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0]?.sourceKinds).toEqual(['users.companies[]', 'users.home'])
  })

  it('changing the attempted role on an otherwise-identical orphan claim changes its evidenceFingerprint', () => {
    const a = extractLegacyRelations([user('u1', { companyId: 'co_ghost', role: 'admin' })], [])
    const b = extractLegacyRelations([user('u1', { companyId: 'co_ghost', role: 'viewer' })], [])
    expect(a.orphans[0]?.evidenceFingerprint).not.toBe(b.orphans[0]?.evidenceFingerprint)
  })

  it('changing the source kind (users.home -> users.companies[]) on an otherwise-identical orphan claim changes its evidenceFingerprint', () => {
    const a = extractLegacyRelations([user('u1', { companyId: 'co_ghost', role: 'admin' })], [])
    const b = extractLegacyRelations([user('u1', { companies: [{ companyId: 'co_ghost', role: 'admin' }] })], [])
    expect(a.orphans[0]?.evidenceFingerprint).not.toBe(b.orphans[0]?.evidenceFingerprint)
  })
})

describe('extractLegacyRelations — missing user (via ownerId)', () => {
  it('an ownerId with no corresponding users/{uid} doc becomes a missing_user orphan', () => {
    const result = extractLegacyRelations([], [company('co_a', { ownerId: 'ghost_uid' })])
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0]).toMatchObject({ companyId: 'co_a', uid: 'ghost_uid', reason: 'missing_user', sourceKinds: ['companies.ownerId'] })
    expect(result.ownerAnomalies).toEqual([])
  })
})

describe('extractLegacyRelations — owner without confirmed admin membership', () => {
  it('an owner with no membership claim at all for that company is an owner anomaly, not an auto-admin', () => {
    const result = extractLegacyRelations(
      [user('owner_uid', { companyId: 'co_other', role: 'admin' })],
      [company('co_a', { ownerId: 'owner_uid' }), company('co_other')],
    )
    expect(result.confirmed.some(r => r.companyId === 'co_a')).toBe(false)
    expect(result.ownerAnomalies).toHaveLength(1)
    expect(result.ownerAnomalies[0]).toMatchObject({ companyId: 'co_a', uid: 'owner_uid', reason: 'owner_without_admin_membership' })
  })

  it('an owner with a confirmed admin membership is accepted with no anomaly', () => {
    const result = extractLegacyRelations(
      [user('owner_uid', { companyId: 'co_a', role: 'admin' })],
      [company('co_a', { ownerId: 'owner_uid' })],
    )
    expect(result.confirmed).toEqual([{ companyId: 'co_a', uid: 'owner_uid', role: 'admin', sources: ['users.home'] }])
    expect(result.ownerAnomalies).toEqual([])
    expect(result.conflicts).toEqual([])
  })

  it('an owner with a confirmed NON-admin role is a conflict, never silently upgraded', () => {
    const result = extractLegacyRelations(
      [user('owner_uid', { companyId: 'co_a', role: 'viewer' })],
      [company('co_a', { ownerId: 'owner_uid' })],
    )
    expect(result.confirmed).toEqual([])
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'owner_uid', reason: 'owner_role_not_admin', observedRoles: ['viewer'] })
  })
})

describe('extractLegacyRelations — internal id mismatch', () => {
  it('a users/{uid} doc whose internal id field does not match the doc ID is a conflict, not a confirmed relation', () => {
    const result = extractLegacyRelations(
      [user('u1', { id: 'someone_else', companyId: 'co_a', role: 'admin' })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([])
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', reason: 'user_id_mismatch', sourceKinds: ['users.home'] })
  })

  it('a matching internal id is not a conflict', () => {
    const result = extractLegacyRelations([user('u1', { id: 'u1', companyId: 'co_a', role: 'admin' })], [company('co_a')])
    expect(result.confirmed).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }])
  })

  // ── Independent audit fix #4 (2nd round) ────────────────────────────────
  it('an id-mismatched document referencing a MISSING company stays a missing_company orphan, never a user_id_mismatch conflict', () => {
    const result = extractLegacyRelations(
      [user('u1', { id: 'someone_else', companyId: 'co_ghost', role: 'admin' })],
      [], // co_ghost does not exist
    )
    expect(result.confirmed).toEqual([])
    expect(result.conflicts).toEqual([])
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0]).toMatchObject({ companyId: 'co_ghost', uid: 'u1', reason: 'missing_company' })
  })

  it('a mixed id-mismatched document with one claim at an existing company and one at a missing company splits correctly', () => {
    const result = extractLegacyRelations(
      [user('u1', { id: 'someone_else', companyId: 'co_a', role: 'admin', companies: [{ companyId: 'co_ghost', role: 'viewer' }] })],
      [company('co_a')],
    )
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', reason: 'user_id_mismatch' })
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0]).toMatchObject({ companyId: 'co_ghost', uid: 'u1', reason: 'missing_company' })
  })

  it('an id-mismatched document with NO usable claims at all does not silently disappear — reported as unknown', () => {
    const result = extractLegacyRelations(
      [user('u1', { id: 'someone_else', name: 'no companyId, no companies[]' })],
      [],
    )
    expect(result.conflicts).toEqual([])
    expect(result.orphans).toEqual([])
    expect(result.unknownUsers).toHaveLength(1)
    expect(result.unknownUsers[0]).toMatchObject({ uid: 'u1', reason: 'no_usable_relations' })
  })
})

describe('extractLegacyRelations — malformed companies[] entries (independent audit fix #6)', () => {
  it('does not crash or guess on a companies[] entry with no companyId — and reports it, never silently drops it', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin', companies: [{ role: 'viewer' }, 'not-an-object', null] })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }])
    expect(result.malformedClaims).toHaveLength(1)
    expect(result.malformedClaims[0]).toMatchObject({ uid: 'u1', reason: 'malformed_companies_entry' })
  })

  it('a user whose ONLY companies[] entries are malformed still gets a malformedClaims record', () => {
    const result = extractLegacyRelations(
      [user('u1', { companies: [{ role: 'viewer' }] })],
      [],
    )
    expect(result.malformedClaims).toHaveLength(1)
    expect(result.malformedClaims[0]).toMatchObject({ uid: 'u1', reason: 'malformed_companies_entry' })
  })
})

// ── Independent audit fixes, 4th round, item 3.4: fail-closed for corrupted
// legacy containers — previously silently ignored entirely. ────────────────
describe('extractLegacyRelations — fail-closed source anomalies (independent audit fixes, 4th round, item 3.4)', () => {
  it('users.companies present but NOT an array is a blocking malformedClaims anomaly (companies_field_not_array)', () => {
    const result = extractLegacyRelations([user('u1', { companies: 'not-an-array' })], [])
    expect(result.malformedClaims).toHaveLength(1)
    expect(result.malformedClaims[0]).toMatchObject({ uid: 'u1', reason: 'companies_field_not_array' })
  })

  it('companies_field_not_array is reported EVEN WHEN the same user has another valid claim', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin', companies: 'not-an-array' })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }])
    expect(result.malformedClaims).toHaveLength(1)
    expect(result.malformedClaims[0]).toMatchObject({ uid: 'u1', reason: 'companies_field_not_array' })
  })

  it('users.companyId present but NOT a usable string is a blocking malformedClaims anomaly (malformed_company_id)', () => {
    const result = extractLegacyRelations([user('u1', { companyId: 12345, role: 'admin' })], [])
    expect(result.malformedClaims).toHaveLength(1)
    expect(result.malformedClaims[0]).toMatchObject({ uid: 'u1', reason: 'malformed_company_id' })
  })

  it('malformed_company_id is reported EVEN WHEN the same user has another valid claim via companies[]', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: '', role: 'admin', companies: [{ companyId: 'co_a', role: 'viewer' }] })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'viewer', sources: ['users.companies[]'] }])
    expect(result.malformedClaims).toHaveLength(1)
    expect(result.malformedClaims[0]).toMatchObject({ uid: 'u1', reason: 'malformed_company_id' })
  })

  it('a single user can produce BOTH malformed_company_id and companies_field_not_array simultaneously', () => {
    const result = extractLegacyRelations([user('u1', { companyId: 999, companies: {} })], [])
    const reasons = result.malformedClaims.map(m => m.reason).sort()
    expect(reasons).toEqual(['companies_field_not_array', 'malformed_company_id'])
  })

  it('companies.ownerId present but NOT a usable string is a blocking, never decision-resolvable ownerIdAnomaly', () => {
    const result = extractLegacyRelations([], [company('co_a', { ownerId: 12345 })])
    expect(result.ownerIdAnomalies).toHaveLength(1)
    expect(result.ownerIdAnomalies[0]).toMatchObject({ companyId: 'co_a', reason: 'malformed_owner_id' })
    expect(result.orphans).toEqual([])
    expect(result.ownerAnomalies).toEqual([])
  })

  it('companies.ownerId simply ABSENT (not present at all) is not an anomaly', () => {
    const result = extractLegacyRelations([], [company('co_a', {})])
    expect(result.ownerIdAnomalies).toEqual([])
    expect(result.ownerAnomalies).toEqual([])
    expect(result.orphans).toEqual([])
  })
})

describe('extractLegacyRelations — mixed valid+invalid role claims for the same pair (independent audit fix #6)', () => {
  it('a pair with one VALID and one INVALID role claim becomes a conflict, never an auto-confirmed relation', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin', companies: [{ companyId: 'co_a', role: 'not-a-real-role' }] })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([])
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', reason: 'mixed_role_validity', observedRoles: ['admin'], hasInvalidRole: true })
  })
})

describe('extractLegacyRelations — users with no usable relation at all (independent audit fix #6)', () => {
  it('a user document with neither companyId nor companies[] is reported as an unknown user', () => {
    const result = extractLegacyRelations([user('u1', { name: 'no legacy relation at all' })], [])
    expect(result.unknownUsers).toHaveLength(1)
    expect(result.unknownUsers[0]).toMatchObject({ uid: 'u1', reason: 'no_usable_relations' })
    expect(result.confirmed).toEqual([])
    expect(result.conflicts).toEqual([])
    expect(result.orphans).toEqual([])
  })

  it('a user document with only malformed companies[] entries (no companyId, no valid entries) is ALSO an unknown user', () => {
    const result = extractLegacyRelations([user('u1', { companies: ['not-an-object'] })], [])
    expect(result.unknownUsers).toHaveLength(1)
    expect(result.unknownUsers[0]).toMatchObject({ uid: 'u1', reason: 'no_usable_relations' })
  })

  it('a user with at least one usable claim (even if it becomes an orphan) is NOT reported as unknown', () => {
    const result = extractLegacyRelations([user('u1', { companyId: 'co_ghost', role: 'admin' })], [])
    expect(result.unknownUsers).toEqual([])
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0]).toMatchObject({ companyId: 'co_ghost', uid: 'u1', reason: 'missing_company' })
  })
})
