// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../types/auth'

const mocks = vi.hoisted(() => ({
  context: {
    user: null as User | null,
    company: null as { id: string } | null,
    activeCompanyId: null as string | null,
    status: 'ready',
    // The global legacy role must not authorize an unrelated company.
    isAdmin: true,
    role: 'admin' as 'viewer' | 'accountant' | 'admin' | null,
  },
  auth: { currentUser: null as { uid: string } | null },
  getCompanyUsers: vi.fn(),
  updateUser: vi.fn(),
  resetPassword: vi.fn(),
  getCompanyRoster: vi.fn<() => Array<{ uid: string; role: 'viewer' | 'accountant' | 'admin'; status: 'active' | 'disabled' | 'invited'; name: string | null; email: string | null }>>(() => []),
  getCompanyRosterError: vi.fn<() => string | null>(() => null),
  loadCompanyRoster: vi.fn(async () => {}),
  reloadCompanyRoster: vi.fn(async () => {}),
  removeMember: vi.fn(),
  changeMemberRole: vi.fn(),
  disableMember: vi.fn(),
  restoreMember: vi.fn(),
}))

vi.mock('../hooks/useAuth', () => ({ useAuth: () => mocks.context }))
vi.mock('../lib/firebase', () => ({ auth: mocks.auth }))
vi.mock('../store/authStore', () => ({ authStore: {
  getCompanyUsers: mocks.getCompanyUsers,
  updateUser: mocks.updateUser,
  resetPassword: mocks.resetPassword,
  // SEC-007/SEC-011: member management is server-side and the roster is
  // canonical. `removeUser` no longer exists on the store.
  getCompanyRoster: mocks.getCompanyRoster,
  getCompanyRosterError: mocks.getCompanyRosterError,
  loadCompanyRoster: mocks.loadCompanyRoster,
  reloadCompanyRoster: mocks.reloadCompanyRoster,
  removeMember: mocks.removeMember,
  changeMemberRole: mocks.changeMemberRole,
  disableMember: mocks.disableMember,
  restoreMember: mocks.restoreMember,
} }))
// Exercise the parent scope boundary without re-testing callable behavior.
// A child-owned transient value exposes whether React preserves an old scope.
vi.mock('../components/invitations/InvitationManagement', () => ({
  default: function InvitationStub({ companyId, sessionUid }: { companyId: string; sessionUid: string }) {
    const [link, setLink] = useState(false)
    return <section data-testid="invitations" data-company={companyId} data-session={sessionUid}>
      <button onClick={() => setLink(true)}>Show transient invitation</button>
      {link && <output>Previous scope invitation link</output>}
    </section>
  },
}))

import Users from './Users'

const user = (id = 'uid_admin'): User => ({
  id, name: id, email: `${id}@example.test`, role: 'admin', companyId: 'co_home',
  createdAt: '2026-01-01T00:00:00.000Z',
  companies: [{ companyId: 'co_other', role: 'admin' }],
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(mocks.context, {
    user: user(), company: { id: 'co_home' }, activeCompanyId: 'co_home', status: 'ready',
  })
  mocks.auth.currentUser = { uid: 'uid_admin' }
  mocks.context.role = 'admin'; mocks.context.isAdmin = true
  mocks.getCompanyRoster.mockReturnValue([roster('uid_admin','admin'), roster('uid_colleague','viewer')])
  mocks.getCompanyRosterError.mockReturnValue(null)
  mocks.updateUser.mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render() { act(() => root.render(<Users />)) }
function click(element: Element | null) {
  expect(element).not.toBeNull()
  act(() => element!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
function openTransientUi() {
  click(container.querySelector('[data-testid="invitations"] button'))
  click(container.querySelector('button[title="Изменить роль"]'))
  expect(container.textContent).toContain('Previous scope invitation link')
  expect(container.querySelector('form')).not.toBeNull()
}

const roster = (uid: string, role: 'viewer' | 'accountant' | 'admin', status: 'active' | 'disabled' | 'invited' = 'active') =>
  ({ uid, role, status, name: uid, email: `${uid}@example.test` })

describe('Users invitation management scope', () => {
  it('opens invitation management with the confirmed active company and session', () => {
    mocks.context.company = { id: 'co_other' }
    mocks.context.activeCompanyId = 'co_other'
    // Legacy profile role is deliberately viewer: it must not matter.
    mocks.context.user = { ...user(), role: 'viewer' }
    render()
    expect(container.querySelector('[data-testid="invitations"]')?.getAttribute('data-company')).toBe('co_other')
    expect(container.querySelector('[data-testid="invitations"]')?.getAttribute('data-session')).toBe('uid_admin')
    expect(mocks.loadCompanyRoster).toHaveBeenCalledWith('co_other')
  })

  it.each(['loading', 'signed_out', 'data_error'])('hides all privileged UI while status is %s', status => {
    mocks.context.status = status
    render()
    expect(container.querySelector('[data-testid="invitations"]')).toBeNull()
    expect(mocks.loadCompanyRoster).not.toHaveBeenCalled()
  })

  it.each([null, { uid: 'uid_other_session' }])('hides stale profile data when the Firebase session is %j', currentUser => {
    mocks.auth.currentUser = currentUser
    render()
    expect(container.querySelector('[data-testid="invitations"]')).toBeNull()
    expect(mocks.loadCompanyRoster).not.toHaveBeenCalled()
  })

  // SEC-007 R1: the gate is the CANONICAL role of the active company. The
  // legacy profile below claims admin of co_home and admin of co_other; none
  // of it may open the screen.
  it.each(['viewer', 'accountant', null] as const)('stays closed for canonical role %s', role => {
    mocks.context.role = role
    mocks.context.isAdmin = false
    mocks.context.company = { id: 'co_other' }
    mocks.context.activeCompanyId = 'co_other'
    render()
    expect(container.querySelector('[data-testid="invitations"]')).toBeNull()
    expect(mocks.loadCompanyRoster).not.toHaveBeenCalled()
  })

  it('opens for a canonical admin of a SECONDARY company', () => {
    // The legacy profile names co_home as the primary company; the canonical
    // role for the active co_other is what decides.
    mocks.context.user = { ...user(), companies: [] }
    mocks.context.company = { id: 'co_other' }
    mocks.context.activeCompanyId = 'co_other'
    mocks.context.role = 'admin'
    render()
    expect(container.querySelector('[data-testid="invitations"]')).not.toBeNull()
  })

  it('immediately removes transient UI when a switch starts and metadata still belongs to the old company', () => {
    render()
    openTransientUi()
    mocks.context.activeCompanyId = 'co_other'
    render()
    expect(container.querySelector('[data-testid="invitations"]')).toBeNull()
    expect(container.querySelector('form')).toBeNull()
    expect(container.textContent).not.toContain('Previous scope invitation link')

    mocks.context.company = { id: 'co_other' }
    render()
    expect(container.querySelector('[data-testid="invitations"]')?.getAttribute('data-company')).toBe('co_other')
    expect(container.textContent).not.toContain('Previous scope invitation link')
    expect(container.querySelector('form')).toBeNull()
  })

  it.each(['company', 'session'])('remounts transient state on a direct confirmed %s change', scope => {
    render()
    openTransientUi()
    if (scope === 'company') {
      mocks.context.company = { id: 'co_other' }
      mocks.context.activeCompanyId = 'co_other'
    } else {
      mocks.context.user = user('uid_next')
      mocks.auth.currentUser = { uid: 'uid_next' }
    }
    render()
    expect(container.querySelector('[data-testid="invitations"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Previous scope invitation link')
    expect(container.querySelector('form')).toBeNull()
  })

  it('edits an existing member without an add-user or administrator-set password form', () => {
    render()
    expect(container.textContent).not.toContain('Добавить пользователя')
    expect(container.querySelector('input[type="password"]')).toBeNull()
    const colleague = Array.from(container.querySelectorAll('li')).find(row => row.textContent?.includes('uid_colleague'))!
    click(colleague.querySelector('button[title="Изменить роль"]'))
    expect(container.querySelector('form')).not.toBeNull()
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(container.textContent).toContain('Отправить письмо для сброса пароля')
  })
})