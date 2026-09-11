// @vitest-environment jsdom
// SEC-007/SEC-010 — the Users page must gate member management on the ACTIVE
// company's capability and must never present a failed server call as success.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../types/auth'

const mocks = vi.hoisted(() => ({
  context: {
    user: { id: 'me', name: 'Me', email: 'me@example.test', role: 'admin', companyId: 'co', createdAt: '2026-01-01T00:00:00.000Z' } as User,
    company: { id: 'co' } as { id: string } | null,
    activeCompanyId: 'co' as string | null,
    status: 'ready',
    isAdmin: true,
    role: 'admin' as 'admin' | 'accountant' | 'viewer' | null,
  },
  auth: { currentUser: { uid: 'me' } as { uid: string } | null },
  getCompanyUsers: vi.fn(),
  getCompanyMemberships: vi.fn(),
  updateUser: vi.fn(),
  resetPassword: vi.fn(),
  removeMember: vi.fn(),
  changeMemberRole: vi.fn(),
  disableMember: vi.fn(),
  restoreMember: vi.fn(),
}))

vi.mock('../hooks/useAuth', () => ({ useAuth: () => mocks.context }))
vi.mock('../lib/firebase', () => ({ auth: mocks.auth }))
vi.mock('../store/authStore', () => ({ authStore: {
  getCompanyUsers: mocks.getCompanyUsers,
  getCompanyMemberships: mocks.getCompanyMemberships,
  updateUser: mocks.updateUser,
  resetPassword: mocks.resetPassword,
  removeMember: mocks.removeMember,
  changeMemberRole: mocks.changeMemberRole,
  disableMember: mocks.disableMember,
  restoreMember: mocks.restoreMember,
} }))
vi.mock('../components/invitations/InvitationManagement', () => ({
  default: () => null,
}))

const Users = (await import('./Users')).default

const colleague: User = {
  id: 'mate', name: 'Mate', email: 'mate@example.test',
  role: 'viewer', companyId: 'co', createdAt: '2026-01-01T00:00:00.000Z',
}

const membership = (uid: string, role: 'viewer' | 'accountant' | 'admin', status: 'active' | 'disabled' = 'active') => ({
  uid, role, status, createdAt: new Date(), updatedAt: new Date(),
})

let container: HTMLDivElement
let root: Root

function render() {
  act(() => { root.render(<Users />) })
}

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.context.role = 'admin'
  mocks.context.isAdmin = true
  mocks.getCompanyUsers.mockReturnValue([mocks.context.user, colleague])
  mocks.getCompanyMemberships.mockReturnValue([membership('me', 'admin'), membership('mate', 'viewer')])
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const removeButtons = () => [...container.querySelectorAll('button')]
  .filter(b => b.getAttribute('title') === 'Убрать из компании')

describe('Users member management', () => {
  it('shows the remove control to an admin of the active company', () => {
    render()
    expect(removeButtons()).toHaveLength(1)
  })

  it.each(['viewer', 'accountant'] as const)('hides member controls from a %s', role => {
    mocks.context.role = role
    mocks.context.isAdmin = false
    render()
    expect(removeButtons()).toHaveLength(0)
  })

  it('hides member controls when there is no usable membership at all', () => {
    mocks.context.role = null
    mocks.context.isAdmin = false
    render()
    expect(removeButtons()).toHaveLength(0)
  })

  it('shows the canonical role, not the legacy profile role', () => {
    // Legacy profile says viewer; canonical membership says accountant.
    mocks.getCompanyMemberships.mockReturnValue([membership('me', 'admin'), membership('mate', 'accountant')])
    render()
    expect(container.textContent).toContain('Бухгалтер')
  })

  it('marks a disabled member in the list', () => {
    mocks.getCompanyMemberships.mockReturnValue([membership('me', 'admin'), membership('mate', 'viewer', 'disabled')])
    render()
    expect(container.textContent).toContain('доступ отключён')
  })

  it('marks a listed profile that has no canonical membership', () => {
    mocks.getCompanyMemberships.mockReturnValue([membership('me', 'admin')])
    render()
    expect(container.textContent).toContain('нет доступа')
  })

  it('calls removeMember for the active company and closes on success', async () => {
    mocks.removeMember.mockResolvedValue({ changed: true })
    render()
    act(() => { removeButtons()[0].click() })
    const confirm = [...container.querySelectorAll('button')].find(b => b.textContent === 'Удалить')!
    await act(async () => { confirm.click() })

    expect(mocks.removeMember).toHaveBeenCalledWith('co', 'mate')
    expect(container.textContent).not.toContain('Убрать из компании?')
  })

  it('shows the server refusal and keeps the dialog open instead of implying success', async () => {
    const { MemberApiError } = await import('../lib/memberApi')
    mocks.removeMember.mockRejectedValue(new MemberApiError('last_admin'))
    render()
    act(() => { removeButtons()[0].click() })
    const confirm = [...container.querySelectorAll('button')].find(b => b.textContent === 'Удалить')!
    await act(async () => { confirm.click() })

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Нельзя убрать последнего администратора')
    // Still open: the user must see that nothing happened.
    expect(container.textContent).toContain('Убрать из компании?')
  })

  it('shows a safe message for a network failure', async () => {
    mocks.removeMember.mockRejectedValue(new Error('FirebaseError: internal uid=secret'))
    render()
    act(() => { removeButtons()[0].click() })
    const confirm = [...container.querySelectorAll('button')].find(b => b.textContent === 'Удалить')!
    await act(async () => { confirm.click() })

    const alert = container.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('Не удалось выполнить действие')
    expect(alert).not.toContain('uid=secret')
  })
})
