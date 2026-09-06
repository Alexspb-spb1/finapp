// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import type { User } from 'firebase/auth'
const m = vi.hoisted(() => ({
  auth: { currentUser: null as User | null }, read: vi.fn(), legacyRead: vi.fn(), write: vi.fn(),
  access: vi.fn(), listener: null as ((user: User | null) => Promise<void>) | null,
}))
vi.mock('../lib/invitationEntry', () => ({ isInvitationEntry: true }))
vi.mock('../lib/firebase', () => ({ auth: m.auth, db: {}, functions: {} }))
vi.mock('../lib/companyApi', () => ({ callCreateCompany: vi.fn() }))
vi.mock('../lib/inviteAcceptanceApi', () => ({ confirmCompanyAccess: m.access }))
vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: vi.fn(), signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(), sendPasswordResetEmail: vi.fn(), sendEmailVerification: vi.fn(),
  onAuthStateChanged: (_auth: unknown, callback: typeof m.listener) => { m.listener = callback },
}))
vi.mock('firebase/firestore', async importOriginal => ({
  ...await importOriginal<typeof import('firebase/firestore')>(),
  doc: (_db: unknown, ...segments: string[]) => segments.join('/'),
  getDocFromServer: m.read, getDoc: m.legacyRead, getDocs: m.legacyRead,
  setDoc: m.write, updateDoc: m.write, deleteDoc: m.write,
}))
const profile = { id: 'user', email: 'user@example.test', name: 'User', role: 'admin', companyId: 'home',
  companies: [{ companyId: 'invited', role: 'viewer' }], createdAt: '2026-09-06T00:00:00.000Z' }
const company = { id: 'invited', name: 'Invited', legalType: 'ooo', currency: 'RUB', ownerId: 'owner', createdAt: profile.createdAt }
const snap = (data: unknown) => ({ exists: () => data !== undefined, data: () => data })
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear()
  m.auth.currentUser = { uid: 'user', emailVerified: true } as User
  m.access.mockResolvedValue({ companyId: 'invited', uid: 'user', role: 'viewer' })
  m.read.mockImplementation(async (path: string) => snap(path === 'users/user' ? profile : company))
})
it('invitation Auth events do no legacy reads or recovery writes', async () => {
  const { authStore } = await import('./authStore')
  await m.listener!(m.auth.currentUser)
  expect(m.legacyRead).not.toHaveBeenCalled(); expect(m.read).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled()
  expect(authStore.getAuthDataStatus()).toBe('loading')
})
it('confirms exact membership before readback; selects invited viewer without home admin fallback', async () => {
  const { authStore } = await import('./authStore')
  await authStore.activateAcceptedCompany('invited', m.auth.currentUser!)
  expect(m.access.mock.invocationCallOrder[0]).toBeLessThan(m.read.mock.invocationCallOrder[0])
  expect(m.read.mock.calls.map(call => call[0])).toEqual(['users/user', 'companies/invited', 'companies/home'])
  expect(authStore.getEffectiveRole()).toBe('viewer')
  expect(authStore.getActiveCompanyId()).toBe('invited')
  expect(m.write).not.toHaveBeenCalled()
})
it('access failure cannot unlock context or attempt readback', async () => {
  m.access.mockRejectedValue(new Error('offline'))
  const { authStore } = await import('./authStore')
  await expect(authStore.activateAcceptedCompany('invited', m.auth.currentUser!)).rejects.toThrow()
  expect(m.read).not.toHaveBeenCalled(); expect(authStore.getCurrentUser()).toBeNull()
})
it.each([undefined, { ...company, id: 'other' }])('missing/malformed company never triggers recovery', async data => {
  m.read.mockImplementation(async (path: string) => snap(path === 'users/user' ? profile : data))
  const { authStore } = await import('./authStore')
  await expect(authStore.activateAcceptedCompany('invited', m.auth.currentUser!)).rejects.toThrow()
  expect(authStore.getCurrentUser()).toBeNull(); expect(m.write).not.toHaveBeenCalled()
})
it('bridge mismatch fails closed rather than inheriting primary role', async () => {
  m.read.mockImplementation(async (path: string) => snap(path === 'users/user' ? { ...profile, companies: [] } : company))
  const { authStore } = await import('./authStore')
  await expect(authStore.activateAcceptedCompany('invited', m.auth.currentUser!)).rejects.toThrow()
  expect(authStore.getCurrentUser()).toBeNull()
})
it('logout during access confirmation discards late results', async () => {
  let resolve!: (value: unknown) => void
  m.access.mockReturnValue(new Promise(done => { resolve = done }))
  const { authStore } = await import('./authStore')
  const pending = authStore.activateAcceptedCompany('invited', m.auth.currentUser!)
  m.auth.currentUser = null; await m.listener!(null)
  resolve({ companyId: 'invited', uid: 'user', role: 'viewer' })
  await expect(pending).rejects.toThrow()
  expect(m.read).not.toHaveBeenCalled(); expect(authStore.getCurrentUser()).toBeNull()
})
it('different session during readback discards even a successful response', async () => {
  let resolve!: (value: unknown) => void
  m.read.mockReturnValueOnce(new Promise(done => { resolve = done })).mockResolvedValueOnce(snap(company))
  const { authStore } = await import('./authStore')
  const pending = authStore.activateAcceptedCompany('invited', m.auth.currentUser!)
  await vi.waitFor(() => expect(m.read).toHaveBeenCalledTimes(2))
  m.auth.currentUser = { uid: 'other', emailVerified: true } as User; await m.listener!(m.auth.currentUser)
  resolve(snap(profile))
  await expect(pending).rejects.toThrow(); expect(authStore.getCurrentUser()).toBeNull()
})
