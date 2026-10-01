import { describe, expect, it } from 'vitest'
import { can, capabilitiesOf, CAPABILITIES, type Capability } from './capabilities'

const WRITE_CAPABILITIES: Capability[] = [
  'transaction.create', 'transaction.update', 'transaction.delete',
  'account.manage', 'budget.manage', 'company.settings.manage',
  'member.manage', 'period.close',
]

describe('role to capability mapping', () => {
  it('grants a viewer read only, and no write capability at all', () => {
    expect(can('viewer', 'company.read')).toBe(true)
    for (const capability of WRITE_CAPABILITIES) {
      expect(can('viewer', capability)).toBe(false)
    }
  })

  it('grants an accountant data writes but never settings, members or period close', () => {
    for (const capability of ['transaction.create', 'transaction.update', 'transaction.delete', 'account.manage', 'budget.manage'] as const) {
      expect(can('accountant', capability)).toBe(true)
    }
    for (const capability of ['company.settings.manage', 'member.manage', 'period.close'] as const) {
      expect(can('accountant', capability)).toBe(false)
    }
  })

  it('grants an admin every declared capability', () => {
    for (const capability of CAPABILITIES) {
      expect(can('admin', capability)).toBe(true)
    }
  })

  // The whole point of returning null from getEffectiveRole: no membership
  // must never be silently treated as the lowest real role.
  it.each([null, undefined])('grants nothing for %s role', role => {
    for (const capability of CAPABILITIES) {
      expect(can(role, capability)).toBe(false)
    }
    expect(capabilitiesOf(role)).toEqual([])
  })

  it('is fail-closed for an unknown role value', () => {
    const unknownRole = 'owner' as unknown as Parameters<typeof can>[0]
    for (const capability of CAPABILITIES) {
      expect(can(unknownRole, capability)).toBe(false)
    }
  })

  it('member.manage is admin-only', () => {
    expect(can('admin', 'member.manage')).toBe(true)
    expect(can('accountant', 'member.manage')).toBe(false)
    expect(can('viewer', 'member.manage')).toBe(false)
  })

  it('capabilitiesOf is a strict superset chain viewer < accountant < admin', () => {
    const viewer = capabilitiesOf('viewer')
    const accountant = capabilitiesOf('accountant')
    const admin = capabilitiesOf('admin')
    expect(viewer.every(c => accountant.includes(c))).toBe(true)
    expect(accountant.every(c => admin.includes(c))).toBe(true)
    expect(admin.length).toBeGreaterThan(accountant.length)
    expect(accountant.length).toBeGreaterThan(viewer.length)
  })
})
