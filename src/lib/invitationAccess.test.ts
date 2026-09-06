import { describe, expect, it } from 'vitest'
import { canOpenInvitationManagement as allowed } from './invitationAccess'
import type { User } from '../types/auth'

const admin: User = { id: 'admin-a', name: 'Test', email: 'admin@example.test',
  companyId: 'home', role: 'admin', createdAt: '2026-09-06T00:00:00Z',
  companies: [{ companyId: 'other', role: 'viewer' }] }

describe('invitation management access bridge', () => {
  it('accepts exact ready company and session, without inheriting home admin', () => {
    expect(allowed(admin, 'home', 'home', 'ready', 'admin-a')).toBe(true)
    expect(allowed(admin, 'other', 'other', 'ready', 'admin-a')).toBe(false)
    expect(allowed(admin, 'unknown', 'unknown', 'ready', 'admin-a')).toBe(false)
    expect(allowed({ ...admin, companies: [{ companyId: 'other', role: 'admin' }] },
      'other', 'other', 'ready', 'admin-a')).toBe(true)
  })
  it('denies transition, logout, error, foreign session, and duplicate memberships', () => {
    for (const status of ['loading', 'signed_out', 'data_error', 'setup_incomplete']) {
      expect(allowed(admin, 'home', 'home', status, 'admin-a')).toBe(false)
    }
    expect(allowed(admin, 'home', 'other', 'ready', 'admin-a')).toBe(false)
    expect(allowed(admin, 'home', 'home', 'ready', 'different')).toBe(false)
    expect(allowed(admin, 'home', 'home', 'ready', null)).toBe(false)
    expect(allowed(null, 'home', 'home', 'ready', 'admin-a')).toBe(false)
    expect(allowed({ ...admin, companies: [
      { companyId: 'other', role: 'admin' }, { companyId: 'other', role: 'viewer' },
    ] }, 'other', 'other', 'ready', 'admin-a')).toBe(false)
  })
})
