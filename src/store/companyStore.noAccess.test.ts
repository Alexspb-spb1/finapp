// @vitest-environment jsdom
// SEC-011 R3 — when the signed-in user loses every company, the financial
// store must drop the data (and the live listener) of the company they were
// removed from, and must not try anything else instead.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  user: { uid: 'u1' } as { uid: string } | null,
  status: 'ready', companyId: 'co_a' as string | null,
  read: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), notifyAuth: null as (() => void) | null,
}))
vi.mock('../lib/invitationEntry', () => ({ isInvitationEntry: false }))
vi.mock('../lib/firebase', () => ({ auth: { get currentUser() { return m.user } }, db: {} }))
vi.mock('./authStore', () => ({
  subscribeAuth: (callback: () => void) => { m.notifyAuth = callback },
  authStore: {
    getAuthDataStatus: () => m.status,
    getCurrentUser: () => (m.user ? { id: m.user.uid } : null),
    getActiveCompanyId: () => m.companyId,
    canWrite: () => true, isAdmin: () => true,
  },
}))
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...segments: string[]) => segments.join('/'),
  getDoc: m.read, setDoc: vi.fn(), onSnapshot: m.watch,
}))

const companyData = (accountId: string) => ({ accounts: [{ id: accountId }], _savedAt: 1 })

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear()
  m.user = { uid: 'u1' }; m.status = 'ready'; m.companyId = 'co_a'
  m.watch.mockReturnValue(m.unwatch)
})

describe('companyStore and the no-access state', () => {
  it('drops the data and the listener of the lost company and opens nothing else', async () => {
    const { companyStore } = await import('./companyStore')
    m.read.mockResolvedValue({ exists: () => true, data: () => companyData('a-private') })
    await companyStore.init('co_a')
    expect(companyStore.accounts).toEqual([{ id: 'a-private' }])
    expect(m.watch).toHaveBeenCalledTimes(1)
    const readsBefore = m.read.mock.calls.length

    // The user is now removed everywhere: no active company, status no_access.
    m.status = 'no_access'; m.companyId = null
    m.notifyAuth!()

    expect(companyStore.accounts).toEqual([])
    expect(m.unwatch).toHaveBeenCalledTimes(1)
    // And in particular it does NOT fall back to opening company_data/<uid>.
    expect(m.read.mock.calls.length).toBe(readsBefore)
    expect(m.read.mock.calls.some(call => call[0] === 'company_data/u1')).toBe(false)
  })

  it('a load still in flight when access is lost never publishes its late answer', async () => {
    const { companyStore } = await import('./companyStore')
    let resolve!: (value: unknown) => void
    m.read.mockReturnValue(new Promise(done => { resolve = done }))
    const pending = companyStore.init('co_a')

    m.status = 'no_access'; m.companyId = null
    m.notifyAuth!()
    resolve({ exists: () => true, data: () => companyData('late-private') })
    await pending

    expect(companyStore.accounts).toEqual([])
    expect(m.watch).not.toHaveBeenCalled()
  })

  it('a load for the previous company cannot overwrite the next one after a switch', async () => {
    const { companyStore } = await import('./companyStore')
    let resolveA!: (value: unknown) => void
    m.read.mockReturnValueOnce(new Promise(done => { resolveA = done }))
    const loadA = companyStore.init('co_a')

    m.read.mockResolvedValueOnce({ exists: () => true, data: () => companyData('b-data') })
    await companyStore.init('co_b')
    expect(companyStore.accounts).toEqual([{ id: 'b-data' }])

    resolveA({ exists: () => true, data: () => companyData('a-late') })
    await loadA
    expect(companyStore.accounts).toEqual([{ id: 'b-data' }])
    expect(m.watch).toHaveBeenCalledTimes(1)
  })

  it('opens the new company once access comes back', async () => {
    const { companyStore } = await import('./companyStore')
    m.status = 'no_access'; m.companyId = null
    m.notifyAuth!()
    expect(m.read).not.toHaveBeenCalled()

    m.status = 'ready'; m.companyId = 'co_b'
    m.read.mockResolvedValue({ exists: () => true, data: () => companyData('b-data') })
    m.notifyAuth!()
    await vi.waitFor(() => expect(companyStore.accounts).toEqual([{ id: 'b-data' }]))
  })
})
