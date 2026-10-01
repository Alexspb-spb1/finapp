// @vitest-environment jsdom
// SEC-011 R3 — a signed-in user with no ACTIVE membership anywhere must get a
// dedicated no-access screen instead of the application shell, and that screen
// must offer a way out and a way to re-check.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  auth: { isAuthenticated: true, loading: false, status: 'ready' as string },
  refreshCompanyAccess: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
}))

vi.mock('../../hooks/useAuth', () => ({ useAuth: () => m.auth }))
vi.mock('../../store/authStore', () => ({
  authStore: { refreshCompanyAccess: m.refreshCompanyAccess, logout: m.logout },
}))
vi.mock('react-router-dom', () => ({
  Navigate: ({ to }: { to: string }) => <span data-testid="redirect">{to}</span>,
}))

const ProtectedRoute = (await import('./ProtectedRoute')).default

let container: HTMLDivElement
let root: Root
const render = () => act(() => {
  root.render(<ProtectedRoute><main data-testid="app">application shell</main></ProtectedRoute>)
})
const buttonByText = (text: string) =>
  [...container.querySelectorAll('button')].find(button => button.textContent?.includes(text))

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(m.auth, { isAuthenticated: true, loading: false, status: 'ready' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ProtectedRoute and the no-access state', () => {
  it('renders the application for a ready user', () => {
    render()
    expect(container.querySelector('[data-testid="app"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders the no-access screen — and NOT the application — for status no_access', () => {
    m.auth.status = 'no_access'
    render()
    expect(container.querySelector('[data-testid="app"]')).toBeNull()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Нет доступа к компании')
    expect(container.querySelector('[data-testid="redirect"]')).toBeNull()
  })

  it('still redirects an unauthenticated visitor to /login rather than showing no-access', () => {
    Object.assign(m.auth, { isAuthenticated: false, status: 'signed_out' })
    render()
    expect(container.querySelector('[data-testid="redirect"]')?.textContent).toBe('/login')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('"Проверить снова" re-resolves company access, "Выйти" signs out', async () => {
    m.auth.status = 'no_access'
    render()

    await act(async () => { buttonByText('Проверить снова')!.click() })
    expect(m.refreshCompanyAccess).toHaveBeenCalledTimes(1)
    expect(m.logout).not.toHaveBeenCalled()

    await act(async () => { buttonByText('Выйти')!.click() })
    expect(m.logout).toHaveBeenCalledTimes(1)
  })

  it('the re-check button is disabled while a check is running', async () => {
    m.auth.status = 'no_access'
    let finish!: () => void
    m.refreshCompanyAccess.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    render()

    await act(async () => { buttonByText('Проверить снова')!.click() })
    expect((buttonByText('Проверить снова') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { finish() })
    expect((buttonByText('Проверить снова') as HTMLButtonElement).disabled).toBe(false)
  })
})
