// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({
  user: { uid: 'guest' } as { uid: string } | null, status: 'ready', companyId: 'invited',
  read: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), notifyAuth: null as (() => void) | null,
}))
vi.mock('../lib/invitationEntry', () => ({ isInvitationEntry: true }))
vi.mock('../lib/firebase', () => ({ auth: { get currentUser() { return m.user } }, db: {} }))
vi.mock('./authStore', () => ({
  subscribeAuth: (callback: () => void) => { m.notifyAuth = callback },
  authStore: { getAuthDataStatus: () => m.status, getCurrentUser: () => m.user ? { id: m.user.uid } : null,
    getActiveCompanyId: () => m.companyId, canWrite: () => false },
}))
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...segments: string[]) => segments.join('/'),
  getDoc: m.read, setDoc: vi.fn(), onSnapshot: m.watch,
}))
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear()
  m.user = { uid: 'guest' }; m.status = 'ready'; m.companyId = 'invited'
  m.watch.mockReturnValue(m.unwatch)
  localStorage.setItem('finapp_last_company_id', 'unrelated')
  for (const id of ['unrelated', 'invited']) localStorage.setItem(`company_data_${id}`, JSON.stringify({ accounts: [{ id: 'cached-private' }] }))
})
it('does not preload cached financial data on invitation entry or on target init', async () => {
  const reads = vi.spyOn(Storage.prototype, 'getItem')
  const { companyStore } = await import('./companyStore')
  expect(companyStore.accounts).toEqual([])
  m.read.mockResolvedValue({ exists: () => true, data: () => ({ accounts: [{ id: 'server' }] }) })
  await companyStore.init('invited')
  expect(companyStore.accounts).toEqual([{ id: 'server' }])
  expect(reads).not.toHaveBeenCalled()
  reads.mockRestore()
})
it('does not read anything before context readiness or for a different target', async () => {
  const { companyStore } = await import('./companyStore')
  await companyStore.init('other')
  m.status = 'loading'; await companyStore.init('invited')
  expect(m.read).not.toHaveBeenCalled(); expect(m.watch).not.toHaveBeenCalled()
})
it('discards a pending financial load after logout and never installs its listener', async () => {
  const { companyStore } = await import('./companyStore')
  let resolve!: (value: unknown) => void
  m.read.mockReturnValue(new Promise(done => { resolve = done }))
  const pending = companyStore.init('invited')
  m.user = null; m.status = 'signed_out'; m.notifyAuth!()
  resolve({ exists: () => true, data: () => ({ accounts: [{ id: 'late-private' }] }) })
  await pending
  expect(companyStore.accounts).toEqual([]); expect(m.watch).not.toHaveBeenCalled()
})
it('clears data/listener on logout and ignores a queued snapshot callback', async () => {
  const { companyStore } = await import('./companyStore')
  m.read.mockResolvedValue({ exists: () => true, data: () => ({ accounts: [{ id: 'server' }] }) })
  await companyStore.init('invited')
  const snapshot = m.watch.mock.calls[0][1]
  m.user = null; m.status = 'signed_out'; m.notifyAuth!()
  snapshot({ exists: () => true, data: () => ({ accounts: [{ id: 'late-private' }] }) })
  expect(m.unwatch).toHaveBeenCalledTimes(1); expect(companyStore.accounts).toEqual([])
})
