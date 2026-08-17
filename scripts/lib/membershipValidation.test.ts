import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { classifyExistingMembership, isStrictlyValidActiveMembership } from './membershipValidation.ts'

// Independent audit fix #2 (2nd round): "valid" fixtures MUST use a real
// firebase-admin/firestore Timestamp instance now — a plain
// {seconds,nanoseconds} object is no longer accepted (see the dedicated
// "real Timestamp enforcement" describe block below for the negative case).
const ts = Timestamp.now()

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

  // ── Independent audit fix #2 (1st round): differs_but_valid vs invalid ──
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

// ── Independent audit fix #2 (2nd round): real Timestamp enforcement ──────
describe('isStrictlyValidActiveMembership — rejects anything that is not a REAL firebase-admin Timestamp', () => {
  it('false for a plain {seconds, nanoseconds} map — the exact shape a real Timestamp serializes to, but not one', () => {
    const plainMap = { seconds: 1000, nanoseconds: 0 }
    expect(isStrictlyValidActiveMembership('u1', { uid: 'u1', role: 'admin', status: 'active', createdAt: plainMap, updatedAt: ts })).toBe(false)
  })

  it('false for an object with a FORGED toDate() function — duck-typing must never be enough', () => {
    const forged = { seconds: 1000, nanoseconds: 0, toDate: () => new Date() }
    expect(isStrictlyValidActiveMembership('u1', { uid: 'u1', role: 'admin', status: 'active', createdAt: forged, updatedAt: ts })).toBe(false)
  })

  it('true only when BOTH createdAt and updatedAt are real Timestamp instances', () => {
    expect(isStrictlyValidActiveMembership('u1', { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts })).toBe(true)
    expect(isStrictlyValidActiveMembership('u1', { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: { seconds: 1, nanoseconds: 0 } })).toBe(false)
  })
})
