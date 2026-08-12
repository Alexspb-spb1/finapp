import { describe, it, expect } from 'vitest'
import { classifyExistingMembership } from './membershipValidation.ts'

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

  it('differs_or_invalid when the role differs from the candidate', () => {
    const data = { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('differs_or_invalid')
  })

  it('differs_or_invalid when status is not active', () => {
    const data = { uid: 'u1', role: 'admin', status: 'invited', createdAt: ts, updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('differs_or_invalid')
  })

  it('differs_or_invalid on a uid mismatch', () => {
    const data = { uid: 'someone_else', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('differs_or_invalid')
  })

  it('differs_or_invalid on an unknown role value', () => {
    const data = { uid: 'u1', role: 'superadmin', status: 'active', createdAt: ts, updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('differs_or_invalid')
  })

  it('differs_or_invalid on extra/unexpected fields (strict schema)', () => {
    const data = { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts, isAdmin: true }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('differs_or_invalid')
  })

  it('differs_or_invalid when createdAt/updatedAt are not Timestamp-like', () => {
    const data = { uid: 'u1', role: 'admin', status: 'active', createdAt: '2026-01-01', updatedAt: ts }
    expect(classifyExistingMembership('admin', 'u1', data)).toBe('differs_or_invalid')
  })
})
