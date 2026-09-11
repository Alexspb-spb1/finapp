// @vitest-environment jsdom
// SEC-007 R1 regression suite. Each block below pins one finding from the
// independent review of PR #28.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../types/auth'

type Role = 'viewer' | 'accountant' | 'admin'
type Status = 'active' | 'disabled' | 'invited'

const mocks = vi.hoisted(() => ({
  context: {
    user: { id: 'me', name: 'Me', email: 'me@example.test', role: 'admin', companyId: 'co', createdAt: '2026-01-01T00:00:00.000Z' } as User,
    company: { id: 'co' } as { id: string } | null,
    activeCompanyId: 'co' as string | null,
    status: 'ready',
    isAdmin: true,
    role: 'admin' as Role | null,
  },
  auth: { currentUser: { uid: 'me' } as { uid: string } | null },
  getCompanyUsers: vi.fn(() => []),
  getCompanyRoster: vi.fn(),
  getCompanyRosterError: vi.fn(() => null as string | null),
  loadCompanyRoster: vi.fn(async () => {}),
  reloadCompanyRoster: vi.fn(async () => {}),
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
  getCompanyRoster: mocks.getCompanyRoster,
  getCompanyRosterError: mocks.getCompanyRosterError,
  loadCompanyRoster: mocks.loadCompanyRoster,
  reloadCompanyRoster: mocks.reloadCompanyRoster,
  updateUser: mocks.updateUser,
  resetPassword: mocks.resetPassword,
  removeMember: mocks.removeMember,
  changeMemberRole: mocks.changeMemberRole,
  disableMember: mocks.disableMember,
  restoreMember: mocks.restoreMember,
} }))
vi.mock('../components/invitations/InvitationManagement', () => ({ default: () => null }))

const Users = (await import('./Users')).default

const member = (uid: string, role: Role, status: Status = 'active', name: string | null = uid) =>
  ({ uid, role, status, name, email: name ? `${uid}@example.test` : null })

let container: HTMLDivElement
let root: Root

const render = () => act(() => { root.render(<Users />) })
const click = (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  act(() => { (el as HTMLElement).click() })
}
const clickAsync = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
}
const rowOf = (uid: string) =>
  [...container.querySelectorAll('li')].find(li => li.textContent?.includes(uid))
const button = (title: string, scope: Element | Document = container) =>
  scope.querySelector(`button[title="${title}"]`)

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.context.role = 'admin'
  mocks.context.isAdmin = true
  mocks.context.status = 'ready'
  mocks.context.company = { id: 'co' }
  mocks.context.activeCompanyId = 'co'
  mocks.auth.currentUser = { uid: 'me' }
  mocks.getCompanyRosterError.mockReturnValue(null)
  mocks.getCompanyRoster.mockReturnValue([member('me', 'admin'), member('mate', 'viewer')])
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

// ── Finding 1: canonical roster is the source of the member list ──────────
describe('canonical roster', () => {
  it('loads the roster for the active company instead of querying legacy profiles', () => {
    render()
    expect(mocks.loadCompanyRoster).toHaveBeenCalledWith('co')
    expect(mocks.getCompanyUsers).not.toHaveBeenCalled()
  })

  it('lists a secondary-company member who has no legacy profile fields for this company', () => {
    mocks.getCompanyRoster.mockReturnValue([member('me', 'admin'), member('guest', 'accountant')])
    render()
    expect(rowOf('guest')).toBeTruthy()
    expect(button('Изменить роль', rowOf('guest')!)).toBeTruthy()
  })

  it('drops a member as soon as the roster no longer contains them', () => {
    render()
    expect(rowOf('mate')).toBeTruthy()
    mocks.getCompanyRoster.mockReturnValue([member('me', 'admin')])
    render()
    expect(rowOf('mate')).toBeFalsy()
  })

  it('shows a member with no profile document using their uid', () => {
    mocks.getCompanyRoster.mockReturnValue([member('me', 'admin'), member('ghost', 'viewer', 'active', null)])
    render()
    expect(rowOf('ghost')).toBeTruthy()
  })

  it('surfaces a roster read failure instead of showing an empty company', () => {
    mocks.getCompanyRoster.mockReturnValue([])
    mocks.getCompanyRosterError.mockReturnValue('Не удалось выполнить действие.')
    render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Не удалось выполнить действие')
    expect(container.textContent).not.toContain('Участники не найдены')
  })

  it('shows the canonical role even when the legacy profile role differs', () => {
    mocks.context.user = { ...mocks.context.user, role: 'viewer' } as User
    mocks.getCompanyRoster.mockReturnValue([member('me', 'admin'), member('mate', 'accountant')])
    render()
    expect(rowOf('mate')?.textContent).toContain('Бухгалтер')
  })

  it('marks disabled and invited members', () => {
    mocks.getCompanyRoster.mockReturnValue([
      member('me', 'admin'), member('off', 'viewer', 'disabled'), member('pending', 'viewer', 'invited'),
    ])
    render()
    expect(rowOf('off')?.textContent).toContain('доступ отключён')
    expect(rowOf('pending')?.textContent).toContain('приглашение не принято')
  })
})

// ── Finding 2: role form seeded from the canonical role; no no-op call ────
describe('role form', () => {
  it('opens with the canonical role preselected', () => {
    mocks.getCompanyRoster.mockReturnValue([member('me', 'admin'), member('mate', 'accountant')])
    render()
    click(button('Изменить роль', rowOf('mate')!))
    const selected = [...container.querySelectorAll('form button[type="button"]')]
      .find(b => b.className.includes('border-indigo-400'))
    expect(selected?.textContent).toBe('Бухгалтер')
  })

  it('saving without changing the role calls no callable at all', async () => {
    render()
    click(button('Изменить роль', rowOf('mate')!))
    await clickAsync([...container.querySelectorAll('button')].find(b => b.textContent === 'Сохранить'))

    expect(mocks.changeMemberRole).not.toHaveBeenCalled()
    expect(container.querySelector('form')).toBeNull()
  })

  it('sends exactly the newly chosen role', async () => {
    mocks.changeMemberRole.mockResolvedValue({ changed: true })
    render()
    click(button('Изменить роль', rowOf('mate')!))
    click([...container.querySelectorAll('form button[type="button"]')].find(b => b.textContent === 'Администратор'))
    await clickAsync([...container.querySelectorAll('button')].find(b => b.textContent === 'Сохранить'))

    expect(mocks.changeMemberRole).toHaveBeenCalledWith('co', 'mate', 'admin')
    expect(mocks.reloadCompanyRoster).toHaveBeenCalledWith('co')
  })

  it('keeps the dialog open and shows the refusal when the server rejects', async () => {
    const { MemberApiError } = await import('../lib/memberApi')
    mocks.changeMemberRole.mockRejectedValue(new MemberApiError('last_admin'))
    render()
    click(button('Изменить роль', rowOf('mate')!))
    // Must be a DIFFERENT role from the member's current one, otherwise the
    // no-op path short-circuits before any callable is made.
    click([...container.querySelectorAll('form button[type="button"]')].find(b => b.textContent === 'Администратор'))
    await clickAsync([...container.querySelectorAll('button')].find(b => b.textContent === 'Сохранить'))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('последнего администратора')
    expect(container.querySelector('form')).not.toBeNull()
  })
})

// ── Finding 3: all four operations reachable from the UI ──────────────────
describe('member operations', () => {
  it('disables an active member', async () => {
    mocks.disableMember.mockResolvedValue({ changed: true })
    render()
    await clickAsync(button('Отключить доступ', rowOf('mate')!))
    expect(mocks.disableMember).toHaveBeenCalledWith('co', 'mate')
  })

  it('restores a disabled member and offers no disable control for them', async () => {
    mocks.getCompanyRoster.mockReturnValue([member('me', 'admin'), member('mate', 'viewer', 'disabled')])
    mocks.restoreMember.mockResolvedValue({ changed: true })
    render()
    expect(button('Отключить доступ', rowOf('mate')!)).toBeNull()
    await clickAsync(button('Восстановить доступ', rowOf('mate')!))
    expect(mocks.restoreMember).toHaveBeenCalledWith('co', 'mate')
  })

  it('removes a member after confirmation', async () => {
    mocks.removeMember.mockResolvedValue({ changed: true })
    render()
    click(button('Убрать из компании', rowOf('mate')!))
    await clickAsync([...container.querySelectorAll('button')].find(b => b.textContent === 'Удалить'))
    expect(mocks.removeMember).toHaveBeenCalledWith('co', 'mate')
  })

  it('shows a row-level refusal without claiming the action succeeded', async () => {
    const { MemberApiError } = await import('../lib/memberApi')
    mocks.disableMember.mockRejectedValue(new MemberApiError('last_admin'))
    render()
    await clickAsync(button('Отключить доступ', rowOf('mate')!))
    expect(rowOf('mate')?.querySelector('[role="alert"]')?.textContent).toContain('последнего администратора')
  })

  it('never leaks an SDK message on a network failure', async () => {
    mocks.removeMember.mockRejectedValue(new Error('FirebaseError: internal uid=secret'))
    render()
    click(button('Убрать из компании', rowOf('mate')!))
    await clickAsync([...container.querySelectorAll('button')].find(b => b.textContent === 'Удалить'))
    const alert = container.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('Не удалось выполнить действие')
    expect(alert).not.toContain('uid=secret')
  })
})

// ── Findings 4 and 5: capability gating, fail-closed on a null role ───────
describe('capability gating', () => {
  it.each(['viewer', 'accountant'] as const)('hides every member control from a %s', role => {
    mocks.context.role = role
    mocks.context.isAdmin = false
    render()
    // The page gate itself closes for a non-admin.
    expect(container.textContent).toContain('доступно администратору')
    expect(button('Убрать из компании')).toBeNull()
    expect(button('Отключить доступ')).toBeNull()
    expect(button('Изменить роль')).toBeNull()
  })

  it('closes entirely when there is no canonical role', () => {
    mocks.context.role = null
    mocks.context.isAdmin = false
    render()
    expect(container.textContent).toContain('доступно администратору')
    expect(mocks.loadCompanyRoster).not.toHaveBeenCalled()
  })
})
