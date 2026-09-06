// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: { id: 'uid_admin', companyId: 'co_a', role: 'admin' },
  company: { id: 'co_a' },
  activeCompanyId: 'co_a',
  listener: null as (() => void) | null,
  selectionListener: null as (() => void) | null,
}))

vi.mock('../store/authStore', () => ({
  authStore: {
    getCurrentUser: () => state.user,
    getCurrentCompany: () => state.company,
    getActiveCompanyId: () => state.activeCompanyId,
    getAuthDataStatus: () => 'ready',
    getDataError: () => null,
    getEffectiveRole: () => 'admin',
    getAllCompanies: () => [state.company],
  },
  subscribeAuth: (listener: () => void) => {
    state.listener = listener
    return () => { state.listener = null }
  },
  subscribeCompanySelection: (listener: () => void) => {
    state.selectionListener = listener
    return () => { state.selectionListener = null }
  },
}))

import { useAuth } from './useAuth'

it('rerenders on the separate selection signal when only activeCompanyId changes and general auth does not notify', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const observed: { activeCompanyId: string | null; companyId: string | undefined; loading: boolean }[] = []
  function Probe() {
    const context = useAuth()
    observed.push({ activeCompanyId: context.activeCompanyId, companyId: context.company?.id, loading: context.loading })
    return <output>{context.activeCompanyId}/{context.company?.id}</output>
  }
  try {
    act(() => root.render(<Probe />))
    // Complete initial loading and settle repeated identical notifications.
    // Otherwise loading=true -> false can mask the missing company-id state.
    act(() => state.listener!())
    act(() => state.listener!())
    expect(observed.at(-1)?.loading).toBe(false)
    expect(container.textContent).toBe('co_a/co_a')
    const rendersBeforeSwitch = observed.length
    const previousUser = state.user
    const previousCompany = state.company

    state.activeCompanyId = 'co_b'
    act(() => state.selectionListener!())

    expect(state.user).toBe(previousUser)
    expect(state.company).toBe(previousCompany)
    expect(observed.length).toBeGreaterThan(rendersBeforeSwitch)
    // This observable mismatch is what lets Users unmount the previous
    // invitation UI before the company's asynchronous metadata load ends.
    expect(container.textContent).toBe('co_b/co_a')
    expect(observed.at(-1)).toEqual({ activeCompanyId: 'co_b', companyId: 'co_a', loading: false })
  } finally {
    act(() => root.unmount())
    container.remove()
    state.activeCompanyId = 'co_a'
  }
  expect(state.listener).toBeNull()
  expect(state.selectionListener).toBeNull()
})
