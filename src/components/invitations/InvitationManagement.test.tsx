// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const transport = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../lib/firebase', () => ({ functions: {} }))
vi.mock('firebase/functions', () => ({ httpsCallable: (_functions: unknown, name: string) => (input: unknown) => transport.run(name, input) }))
import InvitationManagement from './InvitationManagement'
import type { InvitationListItem } from '../../lib/invitationApi'

const time = Date.parse('2026-09-06T12:00:00.000Z')
const token = 's'.repeat(43)
const link = { inviteId: 'i-1', token, expiresAtUtc: '2026-09-13T12:00:00.000Z' }
const fixture = (overrides: Partial<InvitationListItem> = {}): InvitationListItem => ({
  inviteId: 'i-1', emailNormalized: 'person@example.test', role: 'viewer', status: 'pending',
  createdAtUtc: '2026-09-06T11:00:00.000Z', expiresAtUtc: link.expiresAtUtc,
  resendCount: 0, lastSentAtUtc: null, createdBy: 'admin', ...overrides,
})
const page = (items: InvitationListItem[] = [], nextCursor: string | null = null) => ({ data: { items, nextCursor } })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let root: Root
let container: HTMLDivElement
const button = (text: string) => {
  const found = [...container.querySelectorAll('button')].find(node => node.textContent === text)
  if (!found) throw new Error(`Button missing: ${text}`)
  return found
}
const click = (text: string) => act(async () => { button(text).click() })
const render = (companyId = 'company-a', sessionUid = 'uid-a') => act(async () => { root.render(<InvitationManagement companyId={companyId} sessionUid={sessionUid} />) })
async function fillEmail(email: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=email]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, email)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function create() { await click('Пригласить по email'); await fillEmail('person@example.test'); await click('Создать приглашение') }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(time); transport.run.mockReset(); transport.run.mockResolvedValue(page())
  // Vitest normalizes Vite's BASE_URL to '/'; model the deployed vite.config
  // basename explicitly while exercising the component's default URL builder.
  vi.stubEnv('BASE_URL', '/finapp/')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
describe('invitation management', () => {
  it('requires successful server list, shows loading/empty/error and disables controls after failed refresh', async () => {
    const pending = deferred<ReturnType<typeof page>>()
    transport.run.mockReturnValueOnce(pending.promise)
    await render()
    expect(container.textContent).toContain('Загрузка приглашений')
    expect(button('Пригласить по email').disabled).toBe(true)
    await act(async () => pending.resolve(page()))
    expect(container.textContent).toContain('Приглашений пока нет')
    expect(button('Пригласить по email').disabled).toBe(false)
    transport.run.mockRejectedValueOnce(new Error('sensitive-sdk-message'))
    await click('Обновить список')
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Не удалось выполнить запрос')
    expect(container.textContent).not.toContain('sensitive-sdk-message')
    expect(button('Пригласить по email').disabled).toBe(true)
  })
  it('paginates via callable with current company and opaque cursor', async () => {
    transport.run.mockResolvedValueOnce(page([fixture()], 'opaque_next')).mockResolvedValueOnce(page([fixture({ inviteId: 'i-2', emailNormalized: 'next@example.test' })]))
    await render(); await click('Показать ещё')
    expect(transport.run).toHaveBeenNthCalledWith(2, 'listInvitations', { companyId: 'company-a', pageSize: 20, cursor: 'opaque_next' })
    expect(container.textContent).toContain('person@example.test'); expect(container.textContent).toContain('next@example.test')
  })
  it('creates only email/role, guards duplicate click and keeps a copyable fragment link only until close', async () => {
    const creation = deferred<{ data: typeof link }>()
    transport.run.mockImplementation((name: string) => name === 'inviteMember' ? creation.promise : Promise.resolve(page()))
    const local = vi.spyOn(Storage.prototype, 'setItem')
    await render(); await click('Пригласить по email'); await fillEmail('Person@Example.test')
    const submit = button('Создать приглашение')
    await act(async () => { submit.click(); submit.click() })
    expect(transport.run.mock.calls.filter(args => args[0] === 'inviteMember')).toHaveLength(1)
    expect(transport.run).toHaveBeenCalledWith('inviteMember', { companyId: 'company-a', email: 'person@example.test', role: 'accountant' })
    expect(container.querySelector('input[type=password]')).toBeNull()
    await act(async () => creation.resolve({ data: link }))
    const value = container.querySelector<HTMLInputElement>('input[readonly]')!.value
    expect(new URL(value).pathname).toBe('/finapp/accept-invite/i-1')
    expect(new URL(value).search).toBe(''); expect(new URL(value).hash).toBe(`#token=${token}`)
    await click('Копировать ссылку'); expect(navigator.clipboard.writeText).toHaveBeenCalledWith(value)
    await click('Закрыть'); expect(container.querySelector('[role=dialog]')).toBeNull()
    await click('Пригласить по email'); expect(container.innerHTML).not.toContain(token)
    expect(local).not.toHaveBeenCalled()
  })
  it('asks confirmation before cancellation and refreshes after server success', async () => {
    transport.run.mockResolvedValueOnce(page([fixture()])).mockResolvedValueOnce({ data: { inviteId: 'i-1', revokedAtUtc: new Date(time).toISOString() } }).mockResolvedValueOnce(page([fixture({ status: 'revoked' })]))
    await render(); await click('Отменить приглашение')
    expect(transport.run).toHaveBeenCalledTimes(1)
    await click('Подтвердить отмену')
    expect(transport.run).toHaveBeenCalledWith('cancelInvite', { companyId: 'company-a', inviteId: 'i-1' })
    expect(container.textContent).toContain('Отменено'); expect(container.querySelector('[role=dialog]')).toBeNull()
  })
  it('invalidates management after a server permission error and recovers only through successful refresh', async () => {
    transport.run.mockResolvedValueOnce(page([fixture()]))
      .mockRejectedValueOnce({ details: { appCode: 'insufficient_role' }, message: token })
      .mockResolvedValueOnce(page([fixture()]))
    await render(); await click('Отменить приглашение'); await click('Подтвердить отмену')
    expect(container.textContent).toContain('только администратор компании')
    expect(container.textContent).not.toContain(token)
    expect(button('Отменить приглашение').disabled).toBe(true)
    expect(button('Пригласить по email').disabled).toBe(true)
    await click('Обновить список'); expect(button('Пригласить по email').disabled).toBe(false)
  })
  it('clears a newly minted link if the required list refresh fails', async () => {
    transport.run.mockResolvedValueOnce(page()).mockResolvedValueOnce({ data: link }).mockRejectedValueOnce(new Error('network failure'))
    await render(); await create()
    expect(container.querySelector('[role=dialog]')).toBeNull(); expect(container.innerHTML).not.toContain(token)
    expect(button('Пригласить по email').disabled).toBe(true)
    expect(container.textContent).toContain('Если ссылка была создана')
  })
  it('keeps keyboard focus in a dialog and clears its content on Escape', async () => {
    await render(); await click('Пригласить по email')
    const input = container.querySelector('input[type=email]')!
    expect(document.activeElement).toBe(input)
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })))
    expect(document.activeElement).toBe(button('Закрыть'))
    await act(async () => button('Закрыть').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role=dialog]')).toBeNull()
  })
  it('shows expiry/limit/cooldown, enables at exact 60 seconds and rotates expired pending links', async () => {
    transport.run.mockResolvedValue(page([fixture({ createdAtUtc: new Date(time - 59_000).toISOString(), expiresAtUtc: new Date(time - 1000).toISOString() })]))
    await render(); expect(container.textContent).toContain('Срок истёк'); expect(button('Новая ссылка').disabled).toBe(true)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(button('Новая ссылка').disabled).toBe(false)
    await click('Новая ссылка'); expect(container.textContent).toContain('Прежняя ссылка перестанет работать')
    transport.run.mockResolvedValueOnce({ data: link }).mockResolvedValueOnce(page([fixture({ resendCount: 5 })]))
    await click('Создать новую ссылку')
    expect(transport.run).toHaveBeenCalledWith('resendInvite', { companyId: 'company-a', inviteId: 'i-1' })
    await click('Закрыть'); expect(container.textContent).toContain('Лимит исчерпан'); expect(button('Новая ссылка').disabled).toBe(true)
  })
  it.each(['company', 'session'])('ignores stale list success/error when %s changes and clears previous dialogs', async changed => {
    const old = deferred<ReturnType<typeof page>>()
    transport.run.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([fixture({ emailNormalized: 'new@example.test' })]))
    await render(); await render(changed === 'company' ? 'company-b' : 'company-a', changed === 'session' ? 'uid-b' : 'uid-a')
    await act(async () => old.resolve(page([fixture({ emailNormalized: 'old@example.test' })])))
    expect(container.textContent).toContain('new@example.test'); expect(container.textContent).not.toContain('old@example.test')
    await click('Пригласить по email'); await render('company-c', 'uid-c')
    expect(container.querySelector('[role=dialog]')).toBeNull()
  })
  it('discards late tokens after closing or changing context while create is pending', async () => {
    const pending = deferred<{ data: typeof link }>()
    transport.run.mockImplementation((name: string) => name === 'inviteMember' ? pending.promise : Promise.resolve(page()))
    await render(); await create(); await click('Закрыть')
    await act(async () => pending.resolve({ data: link }))
    expect(container.querySelector('[role=dialog]')).toBeNull(); expect(container.innerHTML).not.toContain(token)
    const next = deferred<{ data: typeof link }>()
    transport.run.mockImplementation((name: string) => name === 'inviteMember' ? next.promise : Promise.resolve(page()))
    await create(); await render('company-b', 'uid-b')
    await act(async () => next.resolve({ data: link }))
    expect(container.querySelector('[role=dialog]')).toBeNull(); expect(container.innerHTML).not.toContain(token)
  })
  it('ignores old-session errors and clears displayed token on logout/unmount', async () => {
    const pending = deferred<ReturnType<typeof page>>()
    transport.run.mockReturnValueOnce(pending.promise).mockResolvedValue(page())
    await render(); await render('company-b', 'uid-b')
    await act(async () => pending.reject(new Error('old-session-error')))
    expect(container.querySelector('[role=alert]')).toBeNull()
    transport.run.mockImplementation((name: string) => Promise.resolve(name === 'inviteMember' ? { data: link } : page()))
    await create(); expect(container.querySelector('input[readonly]')).not.toBeNull()
    await act(async () => root.render(null)); expect(container.innerHTML).toBe('')
  })
  it('does not reuse a server authorization result from the first StrictMode effect', async () => {
    const first = deferred<ReturnType<typeof page>>()
    const second = deferred<ReturnType<typeof page>>()
    transport.run.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await act(async () => root.render(<StrictMode><InvitationManagement companyId="c" sessionUid="u" /></StrictMode>))
    await act(async () => first.resolve(page([fixture()])))
    expect(button('Пригласить по email').disabled).toBe(true)
    await act(async () => second.resolve(page()))
    expect(button('Пригласить по email').disabled).toBe(false); expect(container.textContent).not.toContain('person@example.test')
  })
})
