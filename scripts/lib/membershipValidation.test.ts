import { describe, it, expect } from 'vitest'
import { classifyExistingMembership, isStrictlyValidActiveMembership } from './membershipValidation.ts'

const ts = { seconds: 1000, nanoseconds: 0 }

describe('classifyExistingMembership', () => {
  it('not_found when no document exists', () => {
    expect(classifyExistingMembership('admin', 'u1', undefined)).toBe('not_found')
  })

  it('exact_match for a strictly valid, matching, active document', () => {
    const data = { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('exact_match')
  })

  it('exact_match tolerates an optional invitedBy', () => {
    const data = { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts, invitedBy: 'other_uid' }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('exact_match')
  })

  // ── Independent audit fix #2: differs_but_valid vs invalid ─────────────
  it('differs_but_valid when the role differs but the document is otherwise strictly valid and active', () => {
    const data = { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('differs_but_valid')
  })

  it('invalid (never differs_but_valid) when status is not active', () => {
    const data = { uid: 'u1', role: 'admin', status: 'invited', createdAt: ts, updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('invalid')
  })

  it('invalid on a uid mismatch', () => {
    const data = { uid: 'someone_else', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('invalid')
  })

  it('invalid on an unknown role value', () => {
    const data = { uid: 'u1', role: 'superadmin', status: 'active', createdAt: ts, updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('invalid')
  })

  it('invalid on extra/unexpected fields (strict schema)', () => {
    const data = { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts, isAdmin: true }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('invalid')
  })

  it('invalid when createdAt/updatedAt are not Timestamp-like', () => {
    const data = { uid: 'u1', role: 'admin', status: 'active', createdAt: '2026-01-01', updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('invalid')
  })

  it('invalid when timestamps are entirely missing', () => {
    const data = { uid: 'u1', role: 'viewer', status: 'active' }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('invalid')
  })
})

describe('isStrictlyValidActiveMembership', () => {
  it('true for a strictly valid active membership regardless of role', () => {
    expect(isStrictlyValidActiveMembership('u1', { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts })).toBe(true)
    expect(isStrictlyValidActiveMembership('u1', { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts })).toBe(true)
  })

  it('false when data is undefined', () => {
    expect(isStrictlyValidActiveMembership('u1', undefined)).toBe(false)
  })

  it('false for a corrupted (extra-field) document — never counts as a protecting admin', () => {
    expect(isStrictlyValidActiveMembership('u1', { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts, hacked: true })).toBe(false)
  })

  it('false for a non-active status', () => {
    expect(isStrictlyValidActiveMembership('u1', { uid: 'u1', role: 'admin', status: 'disabled', createdAt: ts, updatedAt: ts })).toBe(false)
  })
})
