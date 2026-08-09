// SEC-004 — client registration flow tests.
//
// These tests encode the REQUIRED (secure) behavior of authStore.register()/
// completeCompanySetup() after SEC-004: company creation happens only via
// the server `createCompany` callable (mocked here as ../lib/companyApi),
// never via direct client-side setDoc() writes to companies/company_data/
// users, and a callable failure after Auth user creation must surface as
// `setup_incomplete` — never a false `{ ok: true }` and never a local
// admin/company fallback.
//
// Run against the PRE-SEC-004 authStore.ts implementation, every test in
// this file that touches setDoc-avoidance, setup_incomplete, or the
// callCreateCompany idempotency key fails for a verifiable reason (the old
// register() calls setDoc(companies/...)/setDoc(company_data/...)/
// setDoc(users/...) directly, always returns { ok: true } on a Firestore
// write failure, and has no completeCompanySetup()/callCreateCompany at
// all) — see docs/remediation/reports/SEC-004.md for the captured red-run
// output. This file is the actual (green, post-implementation) mandatory
// "Client unit" test suite from the SEC-004 task spec — it is not a
// separate throwaway red-only file.
import { describe, it, expect, vi, beforeEach } from 'vitest'

class FakeLocalStorage {
  private store = new Map<string, string>()
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null }
  setItem(key: string, value: string) { this.store.set(key, value) }
  removeItem(key: string) { this.store.delete(key) }
  clear() { this.store.clear() }
}
;(globalThis as unknown as { localStorage: FakeLocalStorage }).localStorage = new FakeLocalStorage()

class FakeTimestamp {
  seconds: number
  nanoseconds: number
  constructor(seconds: number, nanoseconds: number) {
    this.seconds = seconds
    this.nanoseconds = nanoseconds
  }
}

const { mockAuth, callCreateCompanyMock } = vi.hoisted(() => ({
  mockAuth: { currentUser: null as { uid: string } | null },
  callCreateCompanyMock: vi.fn(),
}))

type AuthStateCallback = (user: { uid: string; email: string | null; displayName: string | null } | null) => void
let authStateCallback: AuthStateCallback | null = null

vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: vi.fn(async (_auth: unknown, email: string, _password: string) => {
    if (email === 'taken@example.test') {
      const err = new Error('exists') as Error & { code: string }
      err.code = 'auth/email-already-in-use'
      throw err
    }
    const uid = 'uid_' + email.replace(/[^a-z0-9]/gi, '_')
    mockAuth.currentUser = { uid }
    return { user: { uid, email } }
  }),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendEmailVerification: vi.fn(async () => undefined),
  onAuthStateChanged: vi.fn((_auth: unknown, cb: AuthStateCallback) => {
    authStateCallback = cb
    return () => { authStateCallback = null }
  }),
}))

const firestoreDocs = new Map<string, unknown>()
const setDocCalls: { path: string; data: unknown }[] = []

vi.mock('firebase/firestore', () => ({
  Timestamp: FakeTimestamp,
  doc: (_db: unknown, ...segments: string[]) => ({ __kind: 'doc', path: segments.join('/') }),
  collection: (_db: unknown, ...segments: string[]) => ({ __kind: 'collection', path: segments.join('/') }),
  query: (base: { path: string }, ...clauses: { field: string; value: unknown }[]) => ({
    __kind: 'query', path: base.path, clauses,
  }),
  where: (field: string, _op: string, value: unknown) => ({ field, value }),
  getDoc: vi.fn(async (ref: { path: string }) => {
    const data = firestoreDocs.get(ref.path)
    const id = ref.path.split('/').pop()!
    return { id, exists: () => data !== undefined, data: () => data }
  }),
  getDocs: vi.fn(async () => ({ docs: [] })),
  setDoc: vi.fn(async (ref: { path: string }, data: unknown) => { setDocCalls.push({ path: ref.path, data }) }),
  updateDoc: vi.fn(async () => undefined),
  deleteDoc: vi.fn(async () => undefined),
  onSnapshot: vi.fn(() => () => {}),
}))

vi.mock('../lib/firebase', () => ({ auth: mockAuth, db: {} }))
vi.mock('../lib/companyApi', () => ({ callCreateCompany: callCreateCompanyMock }))

function setUserDoc(uid: string, data: unknown) { firestoreDocs.set(`users/${uid}`, data) }
function setCompanyDoc(companyId: string, data: unknown) { firestoreDocs.set(`companies/${companyId}`, data) }

const validUser = (uid: string, companyId: string) => ({
  id: uid, name: 'Test User', email: `${uid}@example.test`,
  role: 'admin', companyId, createdAt: '2026-01-01T00:00:00.000Z',
})
const validCompany = (companyId: string, ownerId: string) => ({
  id: companyId, name: 'Test Co', legalType: 'ooo',
  currency: 'RUB', createdAt: '2026-01-01T00:00:00.000Z', ownerId,
})

const registerParams = {
  name: 'Иван Иванов', email: 'new@example.test', password: 'password123',
  companyName: 'Моя Компания', legalType: 'ooo' as const, inn: undefined,
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  firestoreDocs.clear()
  setDocCalls.length = 0
  authStateCallback = null
  mockAuth.currentUser = null
  callCreateCompanyMock.mockReset()
  localStorage.clear()
})

describe('authStore.register — SEC-004 server-side company creation', () => {
  it('email already taken still returns email_taken and never calls the createCompany callable', async () => {
    const { authStore } = await import('./authStore')
    const result = await authStore.register({ ...registerParams, email: 'taken@example.test' })
    expect(result).toEqual({ ok: false, error: 'email_taken' })
    expect(callCreateCompanyMock).not.toHaveBeenCalled()
  })

  it('a successful callable response leads to ok:true and a ready state loaded from Firestore', async () => {
    const { authStore } = await import('./authStore')
    callCreateCompanyMock.mockImplementation(async () => {
      const uid = mockAuth.currentUser!.uid
      const companyId = 'co_server_generated'
      setUserDoc(uid, validUser(uid, companyId))
      setCompanyDoc(companyId, validCompany(companyId, uid))
      return { companyId }
    })

    const result = await authStore.register(registerParams)

    expect(result).toEqual({ ok: true })
    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getCurrentCompany()?.id).toBe('co_server_generated')
  })

  it('registration never writes companies/company_data/users documents directly via setDoc', async () => {
    const { authStore } = await import('./authStore')
    callCreateCompanyMock.mockImplementation(async () => {
      const uid = mockAuth.currentUser!.uid
      const companyId = 'co_server_generated'
      setUserDoc(uid, validUser(uid, companyId))
      setCompanyDoc(companyId, validCompany(companyId, uid))
      return { companyId }
    })

    await authStore.register(registerParams)

    const privilegedWrites = setDocCalls.filter(c =>
      c.path.startsWith('companies/') || c.path.startsWith('company_data/') || c.path.startsWith('users/'))
    expect(privilegedWrites).toEqual([])
  })

  it('a callable failure after Auth user creation returns setup_incomplete, not a false ok:true', async () => {
    const { authStore } = await import('./authStore')
    callCreateCompanyMock.mockRejectedValue(new Error('network error'))

    const result = await authStore.register(registerParams)

    expect(result).toEqual({ ok: false, error: 'setup_incomplete' })
  })

  it('a callable failure never puts the app into the ready state', async () => {
    const { authStore } = await import('./authStore')
    callCreateCompanyMock.mockRejectedValue(new Error('network error'))

    await authStore.register(registerParams)

    expect(authStore.getAuthDataStatus()).not.toBe('ready')
    expect(authStore.getAuthDataStatus()).toBe('setup_incomplete')
  })

  it('a callable failure creates no local admin/company fallback', async () => {
    const { authStore } = await import('./authStore')
    callCreateCompanyMock.mockRejectedValue(new Error('network error'))

    await authStore.register(registerParams)

    expect(authStore.getCurrentUser()).toBeNull()
    expect(authStore.getCurrentCompany()).toBeNull()
  })

  it('an invalid callable response (thrown by the typed API module) is treated as an error, not success', async () => {
    const { authStore } = await import('./authStore')
    // companyApi.callCreateCompany itself throws when the raw response fails
    // its Zod schema — simulated here directly, since callCreateCompany is mocked.
    callCreateCompanyMock.mockRejectedValue(new Error('createCompany: invalid response shape'))

    const result = await authStore.register(registerParams)

    expect(result).toEqual({ ok: false, error: 'setup_incomplete' })
    expect(authStore.getAuthDataStatus()).toBe('setup_incomplete')
  })

  it('retry (completeCompanySetup) after a callable failure does NOT create a second Auth user', async () => {
    const authModule = await import('firebase/auth')
    const { authStore } = await import('./authStore')
    callCreateCompanyMock.mockRejectedValueOnce(new Error('network error'))
    callCreateCompanyMock.mockImplementationOnce(async () => {
      const uid = mockAuth.currentUser!.uid
      const companyId = 'co_retry'
      setUserDoc(uid, validUser(uid, companyId))
      setCompanyDoc(companyId, validCompany(companyId, uid))
      return { companyId }
    })

    const first = await authStore.register(registerParams)
    expect(first).toEqual({ ok: false, error: 'setup_incomplete' })

    const retry = await authStore.completeCompanySetup()
    expect(retry).toEqual({ ok: true })

    expect(authModule.createUserWithEmailAndPassword).toHaveBeenCalledTimes(1)
  })

  it('retry reuses the SAME idempotency key as the original attempt', async () => {
    const { authStore } = await import('./authStore')
    callCreateCompanyMock.mockRejectedValueOnce(new Error('network error'))
    callCreateCompanyMock.mockImplementationOnce(async () => {
      const uid = mockAuth.currentUser!.uid
      const companyId = 'co_retry_key'
      setUserDoc(uid, validUser(uid, companyId))
      setCompanyDoc(companyId, validCompany(companyId, uid))
      return { companyId }
    })

    await authStore.register(registerParams)
    await authStore.completeCompanySetup()

    expect(callCreateCompanyMock).toHaveBeenCalledTimes(2)
    const firstKey = (callCreateCompanyMock.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey
    const secondKey = (callCreateCompanyMock.mock.calls[1][0] as { idempotencyKey: string }).idempotencyKey
    expect(firstKey).toBe(secondKey)
    expect(firstKey).toBeTruthy()
  })

  it('completeCompanySetup with no pending state and no signed-in user returns setup_incomplete without calling the callable', async () => {
    const { authStore } = await import('./authStore')
    const result = await authStore.completeCompanySetup()
    expect(result).toEqual({ ok: false, error: 'setup_incomplete' })
    expect(callCreateCompanyMock).not.toHaveBeenCalled()
  })
})

describe('authStore.completeCompanySetup — independent audit fix #1 (pending state / activeCompanyId lifecycle)', () => {
  it('callable success -> Firestore read failure -> setup_incomplete -> retry with same key -> canonical load success', async () => {
    const { authStore } = await import('./authStore')
    const companyId = 'co_readback_race'
    // The server confirms the SAME companyId both times (idempotent) — only
    // the client's readback of the canonical documents differs.
    callCreateCompanyMock.mockResolvedValue({ companyId })

    // Attempt 1: callable succeeds, but users/{uid} and companies/{companyId}
    // are not yet readable (simulates a transient Firestore read failure /
    // eventual-consistency lag right after the server's commit).
    const first = await authStore.register(registerParams)
    expect(first).toEqual({ ok: false, error: 'setup_incomplete' })
    expect(authStore.getAuthDataStatus()).toBe('setup_incomplete')
    // Not committed as the active company until the canonical load succeeds.
    expect(authStore.getActiveCompanyId()).toBeNull()

    // The documents become readable (e.g. on retry, shortly after).
    const uid = mockAuth.currentUser!.uid
    setUserDoc(uid, validUser(uid, companyId))
    setCompanyDoc(companyId, validCompany(companyId, uid))

    const retry = await authStore.completeCompanySetup()
    expect(retry).toEqual({ ok: true })
    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getCurrentCompany()?.id).toBe(companyId)
    expect(authStore.getActiveCompanyId()).toBe(companyId)

    // Same idempotency key on both attempts — no second Auth user, no
    // second "first company" bootstrap attempt.
    expect(callCreateCompanyMock).toHaveBeenCalledTimes(2)
    const k1 = (callCreateCompanyMock.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey
    const k2 = (callCreateCompanyMock.mock.calls[1][0] as { idempotencyKey: string }).idempotencyKey
    expect(k1).toBe(k2)
  })

  it('activeCompanyId is not committed until the canonical company/profile load succeeds', async () => {
    const { authStore } = await import('./authStore')
    callCreateCompanyMock.mockResolvedValue({ companyId: 'co_not_yet_active' })
    // No documents seeded -> loadReadyStateAfterSetup sees them as not-yet-existing.
    await authStore.register(registerParams)
    expect(authStore.getActiveCompanyId()).toBeNull()
  })

  it('a real data_error from the canonical load is never silently overwritten with setup_incomplete', async () => {
    const { authStore } = await import('./authStore')
    const companyId = 'co_corrupted_profile'
    callCreateCompanyMock.mockImplementation(async () => {
      const uid = mockAuth.currentUser!.uid
      // Fails LegacyUserSchema — missing role/companyId/email/createdAt.
      setUserDoc(uid, { id: uid, name: 'Broken' })
      setCompanyDoc(companyId, validCompany(companyId, uid))
      return { companyId }
    })

    await authStore.register(registerParams)

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    expect(authStore.getAuthDataStatus()).not.toBe('setup_incomplete')
    expect(authStore.getDataError()).not.toBeNull()
  })

  it('a pending setup for uid A cannot be resumed as uid B (shared-device isolation — independent audit fix #3)', async () => {
    const { authStore } = await import('./authStore')
    callCreateCompanyMock.mockRejectedValue(new Error('network error'))

    await authStore.register({ ...registerParams, email: 'userA@example.test' })
    expect(callCreateCompanyMock).toHaveBeenCalledTimes(1)

    // A DIFFERENT user signs in on the same browser (same localStorage),
    // without going through register() — e.g. via authStore.login().
    mockAuth.currentUser = { uid: 'uid_completely_different_userB' }

    const result = await authStore.completeCompanySetup()

    expect(result).toEqual({ ok: false, error: 'setup_incomplete' })
    // The callable must NOT be called again with user A's pending name/company data.
    expect(callCreateCompanyMock).toHaveBeenCalledTimes(1)
  })

  it('after a simulated reload (fresh module load), the SAME uid still finds its resumable pending setup — independent audit fix #2', async () => {
    const { authStore: authStoreBeforeReload } = await import('./authStore')
    callCreateCompanyMock.mockRejectedValue(new Error('network error'))
    await authStoreBeforeReload.register(registerParams)
    const uidBeforeReload = mockAuth.currentUser!.uid

    // Simulate a page reload: fresh module graph, but localStorage persists
    // and Firebase Auth restores the same signed-in uid (mockAuth.currentUser
    // is left as-is — a real reload keeps the Auth session).
    vi.resetModules()
    const { authStore: authStoreAfterReload } = await import('./authStore')

    const resumable = authStoreAfterReload.getResumableSetupSummary()
    expect(resumable).not.toBeNull()
    expect(resumable?.companyName).toBe(registerParams.companyName)

    callCreateCompanyMock.mockImplementationOnce(async () => {
      const companyId = 'co_after_reload'
      setUserDoc(uidBeforeReload, validUser(uidBeforeReload, companyId))
      setCompanyDoc(companyId, validCompany(companyId, uidBeforeReload))
      return { companyId }
    })
    const retryResult = await authStoreAfterReload.completeCompanySetup()
    expect(retryResult).toEqual({ ok: true })
  })
})

describe('authStore.startCompanySetup — resumable re-entry without a new Auth user (independent audit fix #2)', () => {
  it('completes setup for an authenticated user with no pending state, without calling createUserWithEmailAndPassword', async () => {
    const authModule = await import('firebase/auth')
    const { authStore } = await import('./authStore')
    mockAuth.currentUser = { uid: 'uid_already_authenticated' }
    callCreateCompanyMock.mockImplementation(async () => {
      const companyId = 'co_started_fresh'
      setUserDoc('uid_already_authenticated', validUser('uid_already_authenticated', companyId))
      setCompanyDoc(companyId, validCompany(companyId, 'uid_already_authenticated'))
      return { companyId }
    })

    const result = await authStore.startCompanySetup({
      ownerName: 'Пётр Петров', companyName: 'Новая Компания', legalType: 'ip',
    })

    expect(result).toEqual({ ok: true })
    expect(authModule.createUserWithEmailAndPassword).not.toHaveBeenCalled()
    expect(callCreateCompanyMock).toHaveBeenCalledTimes(1)
  })

  it('re-submitting startCompanySetup twice does not create a second Auth account or a second company (idempotency handled server-side, but the client never re-authenticates)', async () => {
    const authModule = await import('firebase/auth')
    const { authStore } = await import('./authStore')
    mockAuth.currentUser = { uid: 'uid_resubmit' }
    let calls = 0
    callCreateCompanyMock.mockImplementation(async () => {
      calls += 1
      const companyId = 'co_resubmit'
      setUserDoc('uid_resubmit', validUser('uid_resubmit', companyId))
      setCompanyDoc(companyId, validCompany(companyId, 'uid_resubmit'))
      return { companyId }
    })

    await authStore.startCompanySetup({ ownerName: 'A', companyName: 'B', legalType: 'ooo' })
    await authStore.startCompanySetup({ ownerName: 'A', companyName: 'B', legalType: 'ooo' })

    expect(authModule.createUserWithEmailAndPassword).not.toHaveBeenCalled()
    expect(calls).toBe(2) // each explicit re-submit is a new bootstrap attempt (fresh key) — server-side bootstrap idempotency (functions/test/emulator/createCompany.test.ts) is what collapses this to one company, not the client
  })

  it('getResumableSetupSummary returns null when there is no pending state for the current uid', async () => {
    const { authStore } = await import('./authStore')
    mockAuth.currentUser = { uid: 'uid_fresh_no_pending' }
    expect(authStore.getResumableSetupSummary()).toBeNull()
  })

  it('getResumableSetupSummary returns the pending summary after a failed register() for the same uid', async () => {
    const { authStore } = await import('./authStore')
    callCreateCompanyMock.mockRejectedValue(new Error('network error'))
    await authStore.register(registerParams)
    const summary = authStore.getResumableSetupSummary()
    expect(summary).toEqual({ companyName: registerParams.companyName, legalType: registerParams.legalType })
  })
})

describe('authStore — missing profile no longer triggers local admin auto-recovery (SEC-004)', () => {
  it('a signed-in user with no users/{uid} document lands in setup_incomplete, not ready — and no doc is auto-created', async () => {
    const { authStore } = await import('./authStore')
    // No users/{uid} document seeded — simulates an orphaned Auth account
    // (e.g. interrupted registration on a different device/session).
    authStateCallback?.({ uid: 'uid_orphan', email: 'orphan@example.test', displayName: null })
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(authStore.getAuthDataStatus()).toBe('setup_incomplete')
    expect(authStore.getCurrentUser()).toBeNull()
    expect(authStore.getCurrentCompany()).toBeNull()
    const privilegedWrites = setDocCalls.filter(c =>
      c.path.startsWith('companies/') || c.path.startsWith('company_data/') || c.path.startsWith('users/'))
    expect(privilegedWrites).toEqual([])
  })
})
