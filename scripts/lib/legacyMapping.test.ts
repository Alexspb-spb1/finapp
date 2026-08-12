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
    expect(result.conflicts).toEqual([{ companyId: 'co_a', uid: 'u1', reason: 'role_mismatch', observedRoles: ['admin', 'viewer'] }])
  })
})

describe('extractLegacyRelations — unknown/corrupt role', () => {
  it('never turns an unknown role into admin (or anything else)', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'superadmin' })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([])
    expect(result.conflicts).toEqual([{ companyId: 'co_a', uid: 'u1', reason: 'invalid_role' }])
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
    expect(result.orphans).toEqual([{ companyId: 'co_ghost', uid: 'u1', reason: 'missing_company' }])
  })
})

describe('extractLegacyRelations — missing user (via ownerId)', () => {
  it('an ownerId with no corresponding users/{uid} doc becomes a missing_user orphan', () => {
    const result = extractLegacyRelations([], [company('co_a', { ownerId: 'ghost_uid' })])
    expect(result.orphans).toEqual([{ companyId: 'co_a', uid: 'ghost_uid', reason: 'missing_user' }])
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
    expect(result.ownerAnomalies).toEqual([{ companyId: 'co_a', uid: 'owner_uid', reason: 'owner_without_admin_membership' }])
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
    expect(result.conflicts).toEqual([{ companyId: 'co_a', uid: 'owner_uid', reason: 'owner_role_not_admin', observedRoles: ['viewer'] }])
  })
})

describe('extractLegacyRelations — internal id mismatch', () => {
  it('a users/{uid} doc whose internal id field does not match the doc ID is a conflict, not a confirmed relation', () => {
    const result = extractLegacyRelations(
      [user('u1', { id: 'someone_else', companyId: 'co_a', role: 'admin' })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([])
    expect(result.conflicts).toEqual([{ companyId: 'co_a', uid: 'u1', reason: 'user_id_mismatch' }])
  })

  it('a matching internal id is not a conflict', () => {
    const result = extractLegacyRelations([user('u1', { id: 'u1', companyId: 'co_a', role: 'admin' })], [company('co_a')])
    expect(result.confirmed).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }])
  })
})

describe('extractLegacyRelations — malformed companies[] entries', () => {
  it('ignores a companies[] entry with no companyId rather than crashing or guessing', () => {
    const result = extractLegacyRelations(
      [user('u1', { companyId: 'co_a', role: 'admin', companies: [{ role: 'viewer' }, 'not-an-object', null] })],
      [company('co_a')],
    )
    expect(result.confirmed).toEqual([{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }])
  })
})
