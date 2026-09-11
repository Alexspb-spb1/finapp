// @vitest-environment jsdom
//
// SEC-007 R2 — late responses must never write canonical state.
//
// Both the membership read and the roster callable are asynchronous, so a
// slow answer for company A (or for a previous session) can arrive after the
// user has switched to B or signed out. Every test below resolves the losing
// request LAST, deterministically, using deferred promises — no timers, no
// ordering luck.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User as FirebaseUser } from 'firebase/auth'

const m = vi.hoisted(() => ({
  auth: { currentUser: null as FirebaseUser | null },
  listMembers: vi.fn(),
  getDoc: vi.fn(),
  listener: null as ((user: FirebaseUser | null) => Promise<void>) | null,
}))

vi.mock('../lib/invitationEntry', () => ({ isInvitationEntry: false }))
vi.mock('../lib/firebase', () => ({ auth: m.auth, db: {}, functions: {} }))
vi.mock('../lib/companyApi', () => ({ callCreateCompany: vi.fn() }))
vi.mock('../lib/inviteAcceptanceApi', () => ({ confirmCompanyAccess: vi.fn() }))
vi.mock('../lib/memberApi', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/memberApi')>(),
  memberApi: {
    listMembers: m.listMembers,
    changeRole: vi.fn(), disable: vi.fn(), restore: vi.fn(), remove: vi.fn(),
  },
}))
vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: vi.fn(), signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(), sendPasswordResetEmail: vi.fn(), sendEmailVerification: vi.fn(),
  onAuthStateChanged: (_a: unknown, cb: typeof m.listener) => { m.listener = cb },
}))
vi.mock('firebase/firestore', async importOriginal => ({
  ...await importOriginal<typeof import('firebase/firestore')>(),
  doc: (_db: unknown, ...segments: string[]) => segments.join('/'),
  collection: (_db: unknown, ...segments: string[]) => segments.join('/'),
  getDoc: m.getDoc,
  getDocFromServer: vi.fn(),
  getDocs: vi.fn(async () => ({ docs: [] })),
  query: (...args: unknown[]) => args,
  where: (...args: unknown[]) => args,
  setDoc: vi.fn(), updateDoc: vi.fn(),
}))

const { Timestamp } = await import('firebase/firestore')

/** A promise whose settlement this test controls exactly. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const member = (uid: string, role: 'viewer' | 'accountant' | 'admin' = 'admin') =>
  ({ uid, role, status: 'active' as const, name: uid, email: `${uid}@example.test` })

const membershipDoc = (uid: string, role: 'viewer' | 'accountant' | 'admin' = 'admin') => ({
  exists: () => true,
  data: () => ({
    uid, role, status: 'active',
    createdAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z')),
    updatedAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z')),
  }),
})

const sessionA = { uid: 'user_a', emailVerified: true } as FirebaseUser
const sessionB = { uid: 'user_b', emailVerified: true } as FirebaseUser

let authStore: typeof import('./authStore').authStore

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  localStorage.clear()
  m.auth.currentUser = sessionA
  m.getDoc.mockResolvedValue({ exists: () => false })
  m.listMembers.mockResolvedValue([])
  authStore = (await import('./authStore')).authStore
  // The app always has an active company before any roster load; without it
  // effectiveActiveCompanyId() is null and every request is correctly stale.
  await authStore.switchCompany('co_a')
  m.listMembers.mockClear()
  m.getDoc.mockClear()
})

/** Firebase ignores its first onAuthStateChanged(null) during init, so a real
 * logout needs two. */
async function signOut() {
  await m.listener!(null)
  await m.listener!(null)
}

describe('roster: late responses cannot overwrite newer state', () => {
  it('A started, switched to B, B resolved, A resolved last: B data survives', async () => {
    const a = deferred<ReturnType<typeof member>[]>()
    const b = deferred<ReturnType<typeof member>[]>()
    m.listMembers.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)

    // Company A roster request starts.
    const loadA = authStore.reloadCompanyRoster('co_a')
    // The user switches to company B before A answers.
    await authStore.switchCompany('co_b')
    const loadB = authStore.reloadCompanyRoster('co_b')

    b.resolve([member('b_member')])
    await loadB
    expect(authStore.getCompanyRoster().map(x => x.uid)).toEqual(['b_member'])

    // The stale answer for A arrives last and must change nothing.
    a.resolve([member('a_member')])
    await loadA
    expect(authStore.getCompanyRoster().map(x => x.uid)).toEqual(['b_member'])
  })

  it('a late ERROR from the old company does not clobber the new company roster', async () => {
    const a = deferred<ReturnType<typeof member>[]>()
    const b = deferred<ReturnType<typeof member>[]>()
    m.listMembers.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)

    const loadA = authStore.reloadCompanyRoster('co_a')
    await authStore.switchCompany('co_b')
    const loadB = authStore.reloadCompanyRoster('co_b')

    b.resolve([member('b_member')])
    await loadB

    a.reject(new Error('network died for the old company'))
    await loadA

    expect(authStore.getCompanyRoster().map(x => x.uid)).toEqual(['b_member'])
    expect(authStore.getCompanyRosterError()).toBeNull()
  })

  it('a response for a signed-out session never reappears after login as someone else', async () => {
    const a = deferred<ReturnType<typeof member>[]>()
    m.listMembers.mockReturnValueOnce(a.promise)

    const loadA = authStore.reloadCompanyRoster('co_a')

    // Session A signs out, session B signs in on the same active company.
    m.auth.currentUser = null
    await signOut()
    m.auth.currentUser = sessionB

    a.resolve([member('a_member')])
    await loadA

    expect(authStore.getCompanyRoster()).toEqual([])
    expect(authStore.getCompanyRosterError()).toBeNull()
  })

  it('the same uid signing in again is still a different session', async () => {
    const a = deferred<ReturnType<typeof member>[]>()
    m.listMembers.mockReturnValueOnce(a.promise)
    const loadA = authStore.reloadCompanyRoster('co_a')

    // A fresh Firebase user object for the SAME uid — a new sign-in.
    m.auth.currentUser = { uid: 'user_a', emailVerified: true } as FirebaseUser

    a.resolve([member('a_member')])
    await loadA
    expect(authStore.getCompanyRoster()).toEqual([])
  })

  it('getCompanyRoster hides a roster belonging to a different active company', async () => {
    m.listMembers.mockResolvedValueOnce([member('a_member')])
    await authStore.reloadCompanyRoster('co_a')
    expect(authStore.getCompanyRoster().map(x => x.uid)).toEqual(['a_member'])

    // Switching invalidates it immediately, before any new load completes.
    await authStore.switchCompany('co_b')
    expect(authStore.getCompanyRoster()).toEqual([])
    expect(authStore.getCompanyRosterError()).toBeNull()
  })
})

describe('membership/role: late responses cannot grant a stale role', () => {
  it('a late membership for the old company does not set the role of the new one', async () => {
    const a = deferred<ReturnType<typeof membershipDoc>>()
    m.getDoc.mockReturnValueOnce(a.promise)

    // Start a membership read for company A, then switch away.
    const loadA = authStore.reloadCanonicalMembership('co_a')
    await authStore.switchCompany('co_b')

    a.resolve(membershipDoc('user_a', 'admin'))
    await loadA

    expect(authStore.getActiveMembership()).toBeNull()
    expect(authStore.getEffectiveRole()).toBeNull()
    expect(authStore.isAdmin()).toBe(false)
  })

  it('a late membership from a previous session does not restore a role after logout', async () => {
    const a = deferred<ReturnType<typeof membershipDoc>>()
    m.getDoc.mockReturnValueOnce(a.promise)

    const loadA = authStore.reloadCanonicalMembership('co_a')
    m.auth.currentUser = null
    await signOut()

    a.resolve(membershipDoc('user_a', 'admin'))
    await loadA

    expect(authStore.getEffectiveRole()).toBeNull()
    expect(authStore.getActiveMembership()).toBeNull()
  })

  it('a late membership ERROR does not clear a role that has since loaded', async () => {
    const stale = deferred<ReturnType<typeof membershipDoc>>()
    m.getDoc.mockReturnValueOnce(stale.promise)

    const staleLoad = authStore.reloadCanonicalMembership('co_a')
    // switchCompany reads the company document itself, so the membership
    // answer for B is queued only after that read has been consumed.
    await authStore.switchCompany('co_b')
    m.getDoc.mockResolvedValueOnce(membershipDoc('user_a', 'admin'))
    await authStore.reloadCanonicalMembership('co_b')
    expect(authStore.getActiveMembership()?.role).toBe('admin')

    stale.reject(new Error('old read failed'))
    await staleLoad

    expect(authStore.getActiveMembership()?.role).toBe('admin')
  })
})
