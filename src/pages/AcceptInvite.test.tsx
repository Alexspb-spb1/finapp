// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from 'firebase/auth'

const mocks = vi.hoisted(() => ({
  auth: { currentUser: null as User | null }, listener: null as ((user: User | null) => void) | null,
  context: { inviteId: 'invite-1', token: 's'.repeat(43) as string | null },
  preview: vi.fn(), accept: vi.fn(), clear: vi.fn(), login: vi.fn(), register: vi.fn(),
  send: vi.fn(), reload: vi.fn(), refresh: vi.fn(), signOut: vi.fn(),
}))
vi.mock('../lib/firebase', () => ({ auth: mocks.auth }))
vi.mock('../bootstrap/inviteTokenBootstrap', () => ({
  getInviteContext: () => mocks.context,
  clearInviteToken: () => { mocks.clear(); mocks.context = { ...mocks.context, token: null } },
}))
vi.mock('../lib/inviteAcceptanceApi', () => ({
  preview: mocks.preview, accept: mocks.accept, inviteAcceptanceError: () => 'Запрос не выполнен. Повторите позже.',
}))
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, listener: (user: User | null) => void) => {
    mocks.listener = listener; queueMicrotask(() => listener(mocks.auth.currentUser));
    return () => { mocks.listener = null }
  },
  signInWithEmailAndPassword: mocks.login, createUserWithEmailAndPassword: mocks.register,
  sendEmailVerification: mocks.send, reload: mocks.reload, getIdToken: mocks.refresh, signOut: mocks.signOut,
}))
import AcceptInvite from './AcceptInvite'

let root: Root
let container: HTMLDivElement
let onAccepted = vi.fn<(companyId: string, user: User) => Promise<void>>()
const user = (verified = true) => ({ uid: 'invitee', email: 'person@example.test', emailVerified: verified }) as User
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find(node => node.textContent === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
const click = (label: string) => act(async () => { button(label).click() })
const render = () => act(async () => { root.render(<AcceptInvite inviteId="invite-1" onAccepted={onAccepted} />) })
async function authEvent(value: User | null) { await act(async () => { mocks.auth.currentUser = value; mocks.listener?.(value) }) }
async function fill(type: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`input[type=${type}]`)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.context = { inviteId: 'invite-1', token: 's'.repeat(43) }; mocks.auth.currentUser = null
  mocks.preview.mockResolvedValue({ maskedEmail: 'p***@example.test', companyDisplayName: 'Компания', roleLabel: 'Бухгалтер', expiresAt: '2026-09-13T00:00:00Z' })
  mocks.accept.mockResolvedValue({ companyId: 'company-b' }); mocks.reload.mockResolvedValue(undefined); mocks.refresh.mockResolvedValue('id-token')
  mocks.send.mockResolvedValue(undefined); mocks.signOut.mockImplementation(async () => { mocks.auth.currentUser = null; mocks.listener?.(null) })
  onAccepted = vi.fn<(companyId: string, user: User) => Promise<void>>().mockResolvedValue(undefined)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() })

describe('invitation acceptance boundary', () => {
  it('previews masked details without exposing or persisting a capability and preserves it on initial signed-out event', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    await render()
    expect(container.textContent).toContain('p***@example.test')
    expect(container.innerHTML).not.toContain('s'.repeat(43))
    expect(storage).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
    storage.mockRestore()
  })
  it('fails closed before requests for missing or wrong-context token', async () => {
    mocks.context.token = null; await render()
    expect(mocks.preview).not.toHaveBeenCalled(); expect(container.textContent).toContain('Откройте исходную ссылку')
    expect(container.querySelector('form')).toBeNull()
  })
  it('uses normal invitation registration without company registration or automatic mail', async () => {
    const account = user(false)
    mocks.register.mockImplementation(async () => { mocks.auth.currentUser = account; mocks.listener?.(account); return { user: account } })
    await render(); await click('Создать аккаунт'); await fill('email', 'person@example.test'); await fill('password', 'own-password')
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(mocks.register).toHaveBeenCalledWith(mocks.auth, 'person@example.test', 'own-password')
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.accept).not.toHaveBeenCalled()
    expect(container.querySelector('input[type=password]')).toBeNull()
  })
  it('reloads and force-refreshes verified identity before acceptance and clears token only after confirmed access', async () => {
    const account = user(); mocks.auth.currentUser = account
    const open = deferred<void>(); onAccepted.mockReturnValue(open.promise)
    await render(); await click('Принять приглашение')
    expect(mocks.reload).toHaveBeenCalledWith(account); expect(mocks.refresh).toHaveBeenCalledWith(account, true)
    expect(mocks.reload.mock.invocationCallOrder[0]).toBeLessThan(mocks.refresh.mock.invocationCallOrder[0])
    expect(mocks.refresh.mock.invocationCallOrder[0]).toBeLessThan(mocks.accept.mock.invocationCallOrder[0])
    expect(onAccepted).toHaveBeenCalledWith('company-b', account); expect(mocks.clear).not.toHaveBeenCalled()
    await act(async () => open.resolve()); expect(mocks.clear).toHaveBeenCalledOnce()
  })
  it('requires verification after refreshed Auth state, then accepts after explicit confirmation', async () => {
    const account = user(false); mocks.auth.currentUser = account
    await render(); await click('Я подтвердил email')
    expect(mocks.refresh).toHaveBeenCalledWith(account, true); expect(mocks.accept).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Email ещё не подтверждён')
    Object.assign(account, { emailVerified: true })
    await click('Я подтвердил email'); expect(mocks.accept).toHaveBeenCalledOnce()
  })
  it('sends verification only explicitly and prevents immediate resend', async () => {
    mocks.auth.currentUser = user(false); await render(); await click('Отправить письмо подтверждения')
    expect(mocks.send).toHaveBeenCalledOnce(); expect(container.textContent).toContain('60 с')
    expect(container.querySelector<HTMLButtonElement>('[data-verification-send]')!.disabled).toBe(true)
  })
  it('retains token on preview-used failure and permits same-user idempotent retry after access failure', async () => {
    mocks.auth.currentUser = user(); mocks.preview.mockRejectedValue(new Error('used secret')); onAccepted.mockRejectedValueOnce(new Error('access missing'))
    await render(); await click('Принять приглашение')
    expect(mocks.clear).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('access missing')
    await click('Принять приглашение'); expect(mocks.accept).toHaveBeenCalledTimes(2); expect(mocks.clear).toHaveBeenCalledOnce()
  })
  it('blocks duplicate acceptance and discards completion after another tab signs out', async () => {
    mocks.auth.currentUser = user(); const reload = deferred<void>(); mocks.reload.mockReturnValue(reload.promise)
    await render(); const submit = button('Принять приглашение')
    await act(async () => { submit.click(); submit.click() }); expect(mocks.reload).toHaveBeenCalledOnce()
    await authEvent(null); await act(async () => reload.resolve())
    expect(mocks.accept).not.toHaveBeenCalled(); expect(onAccepted).not.toHaveBeenCalled()
    expect(mocks.clear).toHaveBeenCalledOnce(); expect(container.textContent).toContain('Откройте исходную ссылку')
  })
  it('discards acceptance result after session identity changes', async () => {
    mocks.auth.currentUser = user(); const pending = deferred<{ companyId: string }>(); mocks.accept.mockReturnValue(pending.promise)
    await render(); await click('Принять приглашение'); await authEvent({ ...user(), uid: 'other' } as User)
    await act(async () => pending.resolve({ companyId: 'company-b' }))
    expect(onAccepted).not.toHaveBeenCalled(); expect(mocks.clear).toHaveBeenCalledOnce()
  })
  it('explicit logout clears memory before SDK completion and closes invitation flow', async () => {
    mocks.auth.currentUser = user(); await render(); await click('Выйти')
    expect(mocks.clear).toHaveBeenCalledOnce(); expect(mocks.signOut).toHaveBeenCalledWith(mocks.auth)
    expect(container.textContent).toContain('Откройте исходную ссылку')
  })
  it('keeps the capability through normal login and requires an explicit acceptance click', async () => {
    const account = user()
    mocks.login.mockImplementation(async () => { mocks.auth.currentUser = account; mocks.listener?.(account); return { user: account } })
    await render(); await fill('email', 'person@example.test'); await fill('password', 'my-password')
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(mocks.login).toHaveBeenCalledWith(mocks.auth, 'person@example.test', 'my-password')
    expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled()
    expect(button('Принять приглашение').disabled).toBe(false)
  })
  it('discards completion after unmount without erasing the capability prematurely', async () => {
    mocks.auth.currentUser = user(); const pending = deferred<{ companyId: string }>(); mocks.accept.mockReturnValue(pending.promise)
    await render(); await click('Принять приглашение')
    await act(async () => { root.render(null) })
    await act(async () => pending.resolve({ companyId: 'company-b' }))
    expect(onAccepted).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled()
  })
  it('clears capability after confirmed access even when the parent opens another boundary', async () => {
    mocks.auth.currentUser = user(); const pending = deferred<void>(); onAccepted.mockReturnValue(pending.promise)
    await render(); await click('Принять приглашение'); await act(async () => { root.render(null) })
    expect(mocks.clear).not.toHaveBeenCalled()
    await act(async () => pending.resolve()); expect(mocks.clear).toHaveBeenCalledOnce()
  })
  it('never sends accept after logout during forced token refresh', async () => {
    mocks.auth.currentUser = user(); const pending = deferred<string>(); mocks.refresh.mockReturnValue(pending.promise)
    await render(); await click('Принять приглашение'); await authEvent(null)
    await act(async () => pending.resolve('stale-id-token'))
    expect(mocks.accept).not.toHaveBeenCalled(); expect(onAccepted).not.toHaveBeenCalled()
  })
})
