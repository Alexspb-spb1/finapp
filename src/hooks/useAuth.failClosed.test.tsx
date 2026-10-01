// @vitest-environment jsdom
// SEC-007 R1, finding 5: an absent canonical role must be the MOST
// restrictive state. The previous implementation derived readOnly from
// `role === 'viewer'` and canWrite from `role !== 'viewer'`, so role === null
// — "no usable membership at all" — produced readOnly:false and
// canWrite:true, and the UI offered write controls to someone with no access.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  role: null as 'viewer' | 'accountant' | 'admin' | null,
  status: 'ready' as string,
  getEffectiveRole: vi.fn(),
}))

vi.mock('../store/authStore', () => ({
  authStore: {
    getCurrentUser: () => ({ id: 'me' }),
    getCurrentCompany: () => ({ id: 'co' }),
    getActiveCompanyId: () => 'co',
    getAllCompanies: () => [],
    getAuthDataStatus: () => mocks.status,
    getDataError: () => null,
    getEffectiveRole: mocks.getEffectiveRole,
  },
  subscribeAuth: () => () => {},
  subscribeCompanySelection: () => () => {},
}))

const { useAuth } = await import('./useAuth')

let container: HTMLDivElement
let root: Root
// The hook output is rendered into the DOM and read back from there: the
// React compiler lint rule forbids a component writing to any binding
// declared outside it, so capturing into a variable is not an option.
function Probe() {
  const auth = useAuth()
  return <output data-testid="flags">{JSON.stringify({
    role: auth.role, readOnly: auth.readOnly, canWrite: auth.canWrite,
    isAdmin: auth.isAdmin, isAuthenticated: auth.isAuthenticated,
  })}</output>
}

function observed() {
  return JSON.parse(container.querySelector('[data-testid="flags"]')!.textContent!) as {
    role: string | null; readOnly: boolean; canWrite: boolean
    isAdmin: boolean; isAuthenticated: boolean
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.status = 'ready'
  mocks.getEffectiveRole.mockImplementation(() => mocks.role)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const render = () => act(() => { root.render(<Probe />) })

describe('useAuth permission flags', () => {
  it('treats a missing canonical role as read-only with no write or admin rights', () => {
    mocks.role = null
    render()
    expect(observed().role).toBeNull()
    expect(observed().readOnly).toBe(true)
    expect(observed().canWrite).toBe(false)
    expect(observed().isAdmin).toBe(false)
  })

  it('gives a viewer read-only access', () => {
    mocks.role = 'viewer'
    render()
    expect(observed().readOnly).toBe(true)
    expect(observed().canWrite).toBe(false)
    expect(observed().isAdmin).toBe(false)
  })

  it('gives an accountant write access but not admin', () => {
    mocks.role = 'accountant'
    render()
    expect(observed().readOnly).toBe(false)
    expect(observed().canWrite).toBe(true)
    expect(observed().isAdmin).toBe(false)
  })

  it('gives an admin full access', () => {
    mocks.role = 'admin'
    render()
    expect(observed().readOnly).toBe(false)
    expect(observed().canWrite).toBe(true)
    expect(observed().isAdmin).toBe(true)
  })

  it.each(['admin', 'accountant', 'viewer', null] as const)('stays fail-closed on data_error with role %s', role => {
    mocks.role = role
    mocks.status = 'data_error'
    render()
    expect(observed().readOnly).toBe(true)
    expect(observed().canWrite).toBe(false)
    expect(observed().isAdmin).toBe(false)
    expect(observed().isAuthenticated).toBe(false)
  })
})
