import { describe, expect, it } from 'vitest'
import { canOpenInvitationManagement as allowed } from './invitationAccess'
import type { User } from '../types/auth'

// The legacy profile deliberately claims admin of `home` and viewer of
// `other`. SEC-007 R1: none of that decides anything any more — the canonical
// role passed as the last argument does.
const admin: User = { id: 'admin-a', name: 'Test', email: 'admin@example.test',
  companyId: 'home', role: 'admin', createdAt: '2026-09-06T00:00:00Z',
  companies: [{ companyId: 'other', role: 'viewer' }] }

describe('invitation management access bridge', () => {
  it('opens for the canonical admin of the active company', () => {
    expect(allowed(admin, 'home', 'home', 'ready', 'admin-a', 'admin')).toBe(true)
    // Secondary company where the canonical role is admin: allowed, even
    // though the legacy array says viewer.
    expect(allowed(admin, 'other', 'other', 'ready', 'admin-a', 'admin')).toBe(true)
  })

  it.each(['viewer', 'accountant'] as const)('stays closed for a canonical %s', role => {
    // Legacy profile says admin of `home`; canonical role wins.
    expect(allowed(admin, 'home', 'home', 'ready', 'admin-a', role)).toBe(false)
  })

  it('stays closed when there is no canonical role at all', () => {
    expect(allowed(admin, 'home', 'home', 'ready', 'admin-a', null)).toBe(false)
  })

  it('denies transition, logout, error, foreign session and company mismatch', () => {
    for (const status of ['loading', 'signed_out', 'data_error', 'setup_incomplete']) {
      expect(allowed(admin, 'home', 'home', status, 'admin-a', 'admin')).toBe(false)
    }
    expect(allowed(admin, 'home', 'other', 'ready', 'admin-a', 'admin')).toBe(false)
    expect(allowed(admin, 'home', 'home', 'ready', 'different', 'admin')).toBe(false)
    expect(allowed(admin, 'home', 'home', 'ready', null, 'admin')).toBe(false)
    expect(allowed(null, 'home', 'home', 'ready', 'admin-a', 'admin')).toBe(false)
    expect(allowed(admin, null, null, 'ready', 'admin-a', 'admin')).toBe(false)
  })
})
