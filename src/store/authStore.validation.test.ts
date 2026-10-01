// authStore-level integration tests for the SEC-002 boundary-parsing wiring.
// Split out from src/schemas/*.test.ts because these tests exercise the
// STORE's behavior around a corrupted document (data_error state, in-memory
// state clearing, atomic list handling) rather than the schemas themselves.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Default vitest environment here is Node, not jsdom — authStore.ts reads
// localStorage at module load (activeCompanyId). Minimal in-memory stub.
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

type AuthStateCallback = (user: { uid: string; email: string | null; displayName: string | null } | null) => void
let authStateCallback: AuthStateCallback | null = null

vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendEmailVerification: vi.fn(),
  onAuthStateChanged: vi.fn((_auth: unknown, cb: AuthStateCallback) => {
    authStateCallback = cb
    return () => { authStateCallback = null }
  }),
}))

// Firestore doc/collection/query/where are pure "path descriptor" builders in
// this mock — getDoc below reads from `firestoreDocs` keyed by the same
// descriptor, so each test controls exactly what a given path resolves to
// without touching a real Firestore/emulator instance. There is no users
// query any more (SEC-011 R3): getDocs fails the test if anything calls it.
const firestoreDocs = new Map<string, unknown>()

vi.mock('firebase/firestore', () => ({
  Timestamp: FakeTimestamp,
  doc: (_db: unknown, ...segments: string[]) => ({ __kind: 'doc', path: segments.join('/') }),
  collection: (_db: unknown, ...segments: string[]) => ({ __kind: 'collection', path: segments.join('/') }),
  query: (base: { path: string }, ...clauses: { field: string; value: unknown }[]) => ({
    __kind: 'query',
    path: base.path,
    clauses,
  }),
  where: (field: string, _op: string, value: unknown) => ({ field, value }),
  getDoc: vi.fn(async (ref: { path: string }) => {
    const data = firestoreDocs.get(ref.path)
    const id = ref.path.split('/').pop()!
    return { id, exists: () => data !== undefined, data: () => data }
  }),
  getDocs: vi.fn(async () => { throw new Error('the browser users query no longer exists') }),
  setDoc: vi.fn(async () => undefined),
  updateDoc: vi.fn(async () => undefined),
  deleteDoc: vi.fn(async () => undefined),
  onSnapshot: vi.fn(() => () => {}),
}))

vi.mock('../lib/firebase', () => ({
  auth: {},
  db: {},
}))

function setUserDoc(uid: string, data: unknown) {
  firestoreDocs.set(`users/${uid}`, data)
}
function setCompanyDoc(companyId: string, data: unknown) {
  firestoreDocs.set(`companies/${companyId}`, data)
}
// SEC-011 R3: a company is usable only through the user's own ACTIVE canonical
// membership, so every fixture that expects a working company seeds one.
function setMembership(companyId: string, uid: string, status: 'active' | 'disabled' = 'active') {
  firestoreDocs.set(`companies/${companyId}/members/${uid}`, {
    uid, role: 'admin', status,
    createdAt: new FakeTimestamp(1, 0), updatedAt: new FakeTimestamp(1, 0),
  })
}

async function triggerSignIn(uid: string) {
  authStateCallback?.({ uid, email: `${uid}@example.test`, displayName: null })
  // Let the async onAuthStateChanged handler's microtasks/Promise.all resolve.
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

const validUser = (uid: string, companyId: string) => ({
  id: uid, name: 'Test User', email: `${uid}@example.test`,
  role: 'admin', companyId, createdAt: '2026-01-01T00:00:00.000Z',
})
const validCompany = (companyId: string) => ({
  id: companyId, name: 'Test Co', legalType: 'ooo',
  currency: 'RUB', createdAt: '2026-01-01T00:00:00.000Z', ownerId: 'uid_owner',
})

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  firestoreDocs.clear()
  authStateCallback = null
})

describe('authStore — data_error on corrupted documents', () => {
  it('notifies only company-selection subscribers at switch start, deferring general auth notification until metadata is loaded', async () => {
    const { authStore, subscribeAuth, subscribeCompanySelection } = await import('./authStore')
    setUserDoc('uid_1', { ...validUser('uid_1', 'co_a'), companies: [{ companyId: 'co_b', role: 'admin' }] })
    setCompanyDoc('co_a', validCompany('co_a'))
    setCompanyDoc('co_b', validCompany('co_b'))
    setMembership('co_a', 'uid_1')
    setMembership('co_b', 'uid_1')
    await triggerSignIn('uid_1')

    const snapshots: { activeCompanyId: string | null; companyId: string | undefined }[] = []
    const generalSnapshots: { activeCompanyId: string | null; companyId: string | undefined }[] = []
    const unsubscribeSelection = subscribeCompanySelection(() => snapshots.push({
      activeCompanyId: authStore.getActiveCompanyId(),
      companyId: authStore.getCurrentCompany()?.id,
    }))
    const unsubscribe = subscribeAuth(() => generalSnapshots.push({
      activeCompanyId: authStore.getActiveCompanyId(),
      companyId: authStore.getCurrentCompany()?.id,
    }))
    const switching = authStore.switchCompany('co_b')
    try {
      // Deliberately assert before awaiting the asynchronous switch. This
      // mismatch lets Users unmount sensitive old-company UI immediately.
      expect(snapshots).toEqual([{ activeCompanyId: 'co_b', companyId: 'co_a' }])
      // companyStore also subscribes to general auth changes. An early shared
      // notification must not let it initialize financial data with mixed scope.
      expect(generalSnapshots).toEqual([])
      await switching
      expect(generalSnapshots).toEqual([{ activeCompanyId: 'co_b', companyId: 'co_b' }])
    } finally {
      unsubscribe()
      unsubscribeSelection()
      await switching
    }
  })

  it('does not expose the retired administrative REST signup method', async () => {
    const { authStore } = await import('./authStore')
    expect(authStore).not.toHaveProperty('inviteUser')
  })

  it('valid profile + company + active membership resolves to ready', async () => {
    const { authStore } = await import('./authStore')
    setUserDoc('uid_1', validUser('uid_1', 'co_a'))
    setCompanyDoc('co_a', validCompany('co_a'))
    setMembership('co_a', 'uid_1')

    await triggerSignIn('uid_1')

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getDataError()).toBeNull()
    expect(authStore.getCurrentUser()?.id).toBe('uid_1')
    // Only the signed-in user's own profile is held; colleagues come from the
    // canonical roster, never from a browser users query.
    expect(authStore.getCompanyUsers('co_a')).toHaveLength(1)
  })

  it('a corrupted own profile document produces data_error and clears state', async () => {
    const { authStore } = await import('./authStore')
    setUserDoc('uid_1', { id: 'uid_1', name: 'Test User' }) // missing role/companyId/email/createdAt

    await triggerSignIn('uid_1')

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    expect(authStore.getDataError()?.code).toBe('data_error')
    expect(authStore.getCurrentUser()).toBeNull()
    expect(authStore.getCurrentCompany()).toBeNull()
    expect(authStore.getCompanyUsers('co_a')).toEqual([])
  })

  it('an unknown role in the own profile document is rejected, never upgraded', async () => {
    const { authStore } = await import('./authStore')
    setUserDoc('uid_1', { ...validUser('uid_1', 'co_a'), role: 'superadmin' })

    await triggerSignIn('uid_1')

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    expect(authStore.getCurrentUser()).toBeNull()
  })

  it('ONE corrupted company among several fails the load atomically — no partially-trusted company list', async () => {
    const { authStore } = await import('./authStore')
    setUserDoc('uid_1', { ...validUser('uid_1', 'co_a'), companies: [{ companyId: 'co_b', role: 'admin' }] })
    setCompanyDoc('co_a', validCompany('co_a'))
    setCompanyDoc('co_b', { id: 'co_b', name: 'Broken' }) // missing required fields
    setMembership('co_a', 'uid_1')
    setMembership('co_b', 'uid_1')

    await triggerSignIn('uid_1')

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    // Not a partially-trusted list: the whole result is empty/cleared, not
    // "the one valid company, minus the broken one".
    expect(authStore.getAllCompanies()).toEqual([])
    expect(authStore.getCompanyUsers('co_a')).toEqual([])
    expect(authStore.getCurrentUser()).toBeNull()
  })

  it('a corrupted company document produces data_error and clears state', async () => {
    const { authStore } = await import('./authStore')
    setUserDoc('uid_1', validUser('uid_1', 'co_a'))
    setCompanyDoc('co_a', { id: 'co_a', name: 'Test Co' }) // missing legalType/currency/createdAt/ownerId
    setMembership('co_a', 'uid_1')

    await triggerSignIn('uid_1')

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    expect(authStore.getCurrentCompany()).toBeNull()
    expect(authStore.getCurrentUser()).toBeNull()
  })

  it('a document id mismatch (uid does not match users/{uid}) is rejected', async () => {
    const { authStore } = await import('./authStore')
    // Stored under uid_1 but the document's own `id` field claims uid_2.
    setUserDoc('uid_1', validUser('uid_2', 'co_a'))

    await triggerSignIn('uid_1')

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    expect(authStore.getDataError()?.issues.some(i => i.includes('document_id_mismatch'))).toBe(true)
  })

  it('data_error never logs the corrupted document values', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { authStore } = await import('./authStore')
    const secretEmail = 'leaked-secret@internal.example.test'
    setUserDoc('uid_1', { ...validUser('uid_1', 'co_a'), email: secretEmail, role: 'superadmin' })

    await triggerSignIn('uid_1')

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    const loggedText = errorSpy.mock.calls.map(args => JSON.stringify(args)).join('\n')
    expect(loggedText).not.toContain(secretEmail)
    errorSpy.mockRestore()
  })

  it('signing out clears state and reports signed_out, not data_error', async () => {
    const { authStore } = await import('./authStore')
    setUserDoc('uid_1', validUser('uid_1', 'co_a'))
    setCompanyDoc('co_a', validCompany('co_a'))
    setMembership('co_a', 'uid_1')
    await triggerSignIn('uid_1')
    expect(authStore.getAuthDataStatus()).toBe('ready')

    // The module's "first null" init guard (see authStore.ts) is already
    // consumed by the prior sign-in above, so this null goes straight to
    // the "real logout" branch.
    authStateCallback?.(null)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(authStore.getAuthDataStatus()).toBe('signed_out')
    expect(authStore.getDataError()).toBeNull()
    expect(authStore.getCurrentUser()).toBeNull()
  })

  it('data_error atomically clears the FULL privileged context — including allUserCompanies and activeCompanyId (independent review finding #1)', async () => {
    const { authStore, subscribeAuth } = await import('./authStore')

    // Step 1: successful sign-in with a home company AND one additional
    // (multi-company) membership, so activeCompanyId and allUserCompanies
    // are both non-empty afterwards.
    setUserDoc('uid_1', {
      ...validUser('uid_1', 'co_a'),
      companies: [{ companyId: 'co_b', role: 'admin' }],
    })
    setCompanyDoc('co_a', validCompany('co_a'))
    setCompanyDoc('co_b', validCompany('co_b'))
    setMembership('co_a', 'uid_1')
    setMembership('co_b', 'uid_1')

    await triggerSignIn('uid_1')

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(authStore.getAllCompanies().map(c => c.id).sort()).toEqual(['co_a', 'co_b'])

    // Step 2: the NEXT load of the same signed-in user's profile document
    // is corrupted (e.g. a concurrent bad write). Re-triggering the auth
    // listener with the same uid simulates this (token refresh, tab focus).
    setUserDoc('uid_1', { id: 'uid_1', name: 'Broken' })

    const seenDuringNotify: { activeCompanyId: string | null; allCompanies: unknown[] }[] = []
    const unsub = subscribeAuth(() => {
      seenDuringNotify.push({
        activeCompanyId: authStore.getActiveCompanyId(),
        allCompanies: authStore.getAllCompanies(),
      })
    })

    await triggerSignIn('uid_1')
    unsub()

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    expect(authStore.getCurrentUser()).toBeNull()
    expect(authStore.getCurrentCompany()).toBeNull()
    expect(authStore.getCompanyUsers('co_a')).toEqual([])
    // The two fields the independent review flagged as NOT being cleared:
    expect(authStore.getAllCompanies()).toEqual([])
    expect(authStore.getActiveCompanyId()).toBeNull()

    // No subscriber notification observed the stale pre-data_error context —
    // the clear must happen before notify(), not after.
    expect(seenDuringNotify.length).toBeGreaterThan(0)
    for (const snapshot of seenDuringNotify) {
      expect(snapshot.activeCompanyId).toBeNull()
      expect(snapshot.allCompanies).toEqual([])
    }
  })
})
