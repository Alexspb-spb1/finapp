// @vitest-environment jsdom
//
// SEC-011 R3 / PR #28 audit finding 3 — losing ONE company must never break
// the user's whole login, and legacy profile fields must never decide which
// companies a user has.
//
// The Firestore stand-in below reproduces the DECISIONS of the real Rules
// (firestore.rules after SEC-011 R3), not just their data: a company document
// and a membership document are readable only by an ACTIVE canonical member of
// that company, everything else raises `permission-denied`. That is the exact
// failure that used to reject Promise.all in the bootstrap and turn the whole
// app into data_error after a single remove/disable. There is no users query:
// any getDocs call is a test failure.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User as FirebaseUser } from 'firebase/auth'
import { Timestamp } from 'firebase/firestore'

type Role = 'viewer' | 'accountant' | 'admin'
type Status = 'active' | 'disabled' | 'invited'
const STAMP = Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z'))

const m = vi.hoisted(() => ({
  auth: { currentUser: null as FirebaseUser | null },
  listener: null as ((user: FirebaseUser | null) => Promise<void>) | null,
  getDocs: vi.fn(),
  setDoc: vi.fn(),
  signOut: vi.fn(),
  removeMember: vi.fn(),
  disableMember: vi.fn(),
  listMembers: vi.fn(),
}))

vi.mock('../lib/invitationEntry', () => ({ isInvitationEntry: false }))
vi.mock('../lib/firebase', () => ({ auth: m.auth, db: {}, functions: {} }))
vi.mock('../lib/companyApi', () => ({ callCreateCompany: vi.fn() }))
vi.mock('../lib/inviteAcceptanceApi', () => ({ confirmCompanyAccess: vi.fn() }))
vi.mock('../lib/memberApi', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/memberApi')>(),
  memberApi: {
    listMembers: m.listMembers, changeRole: vi.fn(), restore: vi.fn(),
    disable: m.disableMember, remove: m.removeMember,
  },
}))
vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: vi.fn(), signInWithEmailAndPassword: vi.fn(),
  signOut: m.signOut, sendPasswordResetEmail: vi.fn(), sendEmailVerification: vi.fn(),
  onAuthStateChanged: (_a: unknown, cb: typeof m.listener) => { m.listener = cb },
}))

// ── The fake Firestore ──────────────────────────────────────────────────────
const docs = new Map<string, unknown>()
/** path -> promise the response is held behind (the answer itself is fixed at
 * request time, so a held response is genuinely STALE when it is released). */
const holds = new Map<string, Promise<void>>()
const reads: string[] = []

/** When true the fake lets an own membership document AND the company document
 * be read whatever the membership status — i.e. the Rules gate is bypassed at
 * both layers — so a test can prove the CLIENT independently refuses a
 * membership that is not `active` (defence in depth). */
let leakNonActiveMembershipReads = false

const denied = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' })
const unavailable = () => Object.assign(new Error('The service is currently unavailable.'), { code: 'unavailable' })
/** path -> thrown error, to simulate transient failures. */
const failures = new Map<string, () => Error>()

function isActiveMember(companyId: string, uid: string): boolean {
  const own = docs.get(`companies/${companyId}/members/${uid}`) as { uid?: string; status?: string; role?: string } | undefined
  return own !== undefined && own.uid === uid && own.status === 'active' && ['viewer', 'accountant', 'admin'].includes(own.role ?? '')
}

/** Mirrors firestore.rules: users self-only; company + members readable by an
 * active canonical member only. */
function allowed(path: string, uid: string): boolean {
  const parts = path.split('/')
  if (parts[0] === 'users' && parts.length === 2) return parts[1] === uid
  if (parts[0] === 'companies' && parts.length === 2) return leakNonActiveMembershipReads || isActiveMember(parts[1], uid)
  if (parts[0] === 'companies' && parts[2] === 'members' && parts.length === 4) {
    return leakNonActiveMembershipReads ? parts[3] === uid : isActiveMember(parts[1], uid)
  }
  return false
}

vi.mock('firebase/firestore', async importOriginal => ({
  ...await importOriginal<typeof import('firebase/firestore')>(),
  doc: (_db: unknown, ...segments: string[]) => segments.join('/'),
  collection: (_db: unknown, ...segments: string[]) => segments.join('/'),
  query: (...args: unknown[]) => args,
  where: (...args: unknown[]) => args,
  getDocs: m.getDocs,
  setDoc: m.setDoc,
  updateDoc: vi.fn(),
  getDocFromServer: vi.fn(),
  getDoc: async (path: string) => {
    reads.push(path)
    const uid = m.auth.currentUser?.uid ?? ''
    // The answer is decided NOW, against the data as it is at request time.
    const failure = failures.get(path)
    let outcome: { error: Error } | { data: unknown }
    if (failure) outcome = { error: failure() }
    else if (!allowed(path, uid)) outcome = { error: denied() }
    else outcome = { data: docs.get(path) }
    const hold = holds.get(path)
    if (hold) await hold
    if ('error' in outcome) throw outcome.error
    return { id: path.split('/').pop(), exists: () => outcome.data !== undefined, data: () => outcome.data }
  },
}))

// ── Fixtures ────────────────────────────────────────────────────────────────
const UID = 'user_1'
const sessionOf = (uid: string) => ({ uid, emailVerified: true }) as FirebaseUser

const profile = (companyId: string, extra: string[] = [], overrides: Record<string, unknown> = {}) => ({
  id: UID, name: 'Test User', email: 'user_1@example.test', role: 'admin', companyId,
  companies: extra.map(id => ({ companyId: id, role: 'admin' })),
  createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
})
const company = (id: string, ownerId = 'someone_else') => ({
  id, name: `Company ${id}`, legalType: 'ooo', currency: 'RUB', createdAt: '2026-01-01T00:00:00.000Z', ownerId,
})
const membership = (uid: string, role: Role = 'admin', status: Status = 'active') =>
  ({ uid, role, status, createdAt: STAMP, updatedAt: STAMP })

function seedCompany(id: string, opts: { member?: Role | false; status?: Status; ownerId?: string } = {}) {
  docs.set(`companies/${id}`, company(id, opts.ownerId))
  if (opts.member !== false) docs.set(`companies/${id}/members/${UID}`, membership(UID, opts.member ?? 'admin', opts.status ?? 'active'))
}
function seedProfile(companyId: string, extra: string[] = [], overrides: Record<string, unknown> = {}) {
  docs.set(`users/${UID}`, profile(companyId, extra, overrides))
}
const removeMembership = (id: string) => docs.delete(`companies/${id}/members/${UID}`)
const setStatus = (id: string, status: Status) => docs.set(`companies/${id}/members/${UID}`, membership(UID, 'admin', status))

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

let authStore: typeof import('./authStore').authStore

async function importStore() {
  authStore = (await import('./authStore')).authStore
}
/** Signs the user in through the real Auth listener and waits for it. */
async function signIn() {
  m.auth.currentUser = sessionOf(UID)
  await m.listener!(m.auth.currentUser)
}
const companyIds = () => authStore.getAllCompanies().map(c => c.id).sort()

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  localStorage.clear()
  docs.clear(); holds.clear(); failures.clear(); reads.length = 0
  leakNonActiveMembershipReads = false
  m.auth.currentUser = null
  m.getDocs.mockImplementation(async () => { throw denied() })
  m.listMembers.mockResolvedValue([])
  m.removeMember.mockResolvedValue({ changed: true })
  m.disableMember.mockResolvedValue({ changed: true })
})

describe('bootstrap: a lost company never breaks the rest of the login', () => {
  it('1. member of A and B, removed from B: the next login opens A and B is gone', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    removeMembership('co_b')
    await importStore()
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getDataError()).toBeNull()
    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(authStore.getCurrentCompany()?.id).toBe('co_a')
    expect(companyIds()).toEqual(['co_a'])
    expect(authStore.getEffectiveRole()).toBe('admin')
  })

  it('1b. the removed company is the legacy HOME company: A (listed only in companies[]) still opens', async () => {
    seedProfile('co_b', ['co_a'])
    seedCompany('co_a'); seedCompany('co_b')
    removeMembership('co_b')
    await importStore()
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(companyIds()).toEqual(['co_a'])
    expect(authStore.getEffectiveRole()).toBe('admin')
  })

  it('2. disabled in B: A keeps working and B is unavailable', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b', { status: 'disabled' })
    await importStore()
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(companyIds()).toEqual(['co_a'])
  })

  it('2b. an invited (not yet active) membership does not make the company available', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b', { status: 'invited' })
    await importStore()
    await signIn()

    expect(companyIds()).toEqual(['co_a'])
  })

  it.each(['remove', 'disable'] as const)(
    '3. stored activeCompanyId=B after %s resets safely to an available company',
    async how => {
      seedProfile('co_a', ['co_b'])
      seedCompany('co_a'); seedCompany('co_b')
      if (how === 'remove') removeMembership('co_b'); else setStatus('co_b', 'disabled')
      localStorage.setItem('finapp_active_company', 'co_b')
      await importStore()
      await signIn()

      expect(authStore.getAuthDataStatus()).toBe('ready')
      expect(authStore.getActiveCompanyId()).toBe('co_a')
      expect(authStore.getCurrentCompany()?.id).toBe('co_a')
      expect(companyIds()).toEqual(['co_a'])
      // The dead preference is forgotten, so it cannot come back on its own.
      expect(localStorage.getItem('finapp_active_company')).toBeNull()
    },
  )

  it('3b. a still-valid stored active company is kept', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    localStorage.setItem('finapp_active_company', 'co_b')
    await importStore()
    await signIn()

    expect(authStore.getActiveCompanyId()).toBe('co_b')
    expect(companyIds()).toEqual(['co_a', 'co_b'])
    expect(localStorage.getItem('finapp_active_company')).toBe('co_b')
  })

  it('4. losing B touches neither the Auth session nor the membership of A', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a', { member: 'accountant' }); seedCompany('co_b')
    removeMembership('co_b')
    await importStore()
    await signIn()

    expect(m.signOut).not.toHaveBeenCalled()
    expect(m.auth.currentUser?.uid).toBe(UID)
    expect(authStore.getCurrentUser()?.id).toBe(UID)
    // A's canonical membership is exactly as it was, and drives the role.
    expect(docs.get(`companies/co_a/members/${UID}`)).toMatchObject({ uid: UID, role: 'accountant', status: 'active' })
    expect(authStore.getEffectiveRole()).toBe('accountant')
    expect(authStore.getActiveMembership()?.role).toBe('accountant')
  })

  it('does no browser users query at all — the roster is the server callable', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    await importStore()
    await signIn()

    expect(m.getDocs).not.toHaveBeenCalled()
    expect(reads.some(path => path.startsWith('users/') && path !== `users/${UID}`)).toBe(false)
  })

  it('a transient failure on B does not lose B\'s stored preference and does not break A', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    failures.set(`companies/co_b/members/${UID}`, unavailable)
    localStorage.setItem('finapp_active_company', 'co_b')
    await importStore()
    await signIn()

    // Unknown access is treated as no access for THIS load...
    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(companyIds()).toEqual(['co_a'])
    // ...but is not proof of removal, so the preference survives for next time.
    expect(localStorage.getItem('finapp_active_company')).toBe('co_b')
  })

  it('access that vanishes between the membership read and the company read is no_access, not an error', async () => {
    seedProfile('co_a')
    seedCompany('co_a')
    // The membership reads as active, but by the time the company document is
    // read the Rules already refuse it (membership removed in between).
    failures.set('companies/co_a', denied)
    await importStore()
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('no_access')
    expect(authStore.getDataError()).toBeNull()
    expect(authStore.getCurrentCompany()).toBeNull()
    expect(authStore.getEffectiveRole()).toBeNull()
  })

  it('a company document that is unreadable for a transient reason is skipped when another company works', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    failures.set('companies/co_a', unavailable)
    await importStore()
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe('co_b')
    expect(companyIds()).toEqual(['co_b'])
  })

  it('every company document unreadable for a transient reason is an error, not "no access"', async () => {
    seedProfile('co_a')
    seedCompany('co_a')
    failures.set('companies/co_a', unavailable)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await importStore()
    await signIn()
    errorSpy.mockRestore()

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    expect(authStore.getEffectiveRole()).toBeNull()
  })

  it('when EVERY company is unreadable for a transient reason it is an error, not "no access"', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    failures.set(`companies/co_a/members/${UID}`, unavailable)
    failures.set(`companies/co_b/members/${UID}`, unavailable)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await importStore()
    await signIn()
    errorSpy.mockRestore()

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    expect(authStore.getCurrentCompany()).toBeNull()
    expect(authStore.getEffectiveRole()).toBeNull()
  })
})

describe('no active membership: a strict no-access state', () => {
  it('6. a user with no active memberships gets no_access, not stale data and not an error', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a', { member: false }); seedCompany('co_b', { status: 'disabled' })
    await importStore()
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('no_access')
    expect(authStore.getDataError()).toBeNull()
    expect(authStore.getCurrentCompany()).toBeNull()
    expect(authStore.getAllCompanies()).toEqual([])
    expect(authStore.getActiveCompanyId()).toBeNull()
    expect(authStore.getActiveMembership()).toBeNull()
    expect(authStore.getEffectiveRole()).toBeNull()
    expect(authStore.isAdmin()).toBe(false)
    expect(authStore.canWrite()).toBe(false)
    expect(authStore.getCompanyRoster()).toEqual([])
    // The signed-in user is still known, so the UI can offer a way out.
    expect(authStore.getCurrentUser()?.id).toBe(UID)
    expect(m.signOut).not.toHaveBeenCalled()
  })

  it('6b. losing the LAST company replaces a previously ready state — nothing stale survives', async () => {
    seedProfile('co_a')
    seedCompany('co_a')
    await importStore()
    await signIn()
    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getEffectiveRole()).toBe('admin')

    removeMembership('co_a')
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('no_access')
    expect(authStore.getCurrentCompany()).toBeNull()
    expect(authStore.getAllCompanies()).toEqual([])
    expect(authStore.getEffectiveRole()).toBeNull()
    expect(authStore.getActiveCompanyId()).toBeNull()
  })

  it('6c. access that comes back (membership restored) is picked up by the next load', async () => {
    seedProfile('co_a')
    seedCompany('co_a', { member: false })
    await importStore()
    await signIn()
    expect(authStore.getAuthDataStatus()).toBe('no_access')

    docs.set(`companies/co_a/members/${UID}`, membership(UID, 'viewer'))
    await signIn()
    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getEffectiveRole()).toBe('viewer')
  })

  it('7. legacy role/companyId/companies[] and ownerId without an active membership give no company', async () => {
    seedProfile('co_x', ['co_y'], { role: 'admin' })
    seedCompany('co_x', { member: false, ownerId: UID })
    seedCompany('co_y', { member: false, ownerId: UID })
    await importStore()
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('no_access')
    expect(authStore.getAllCompanies()).toEqual([])
    expect(authStore.getCurrentCompany()).toBeNull()
    expect(authStore.getActiveCompanyId()).toBeNull()
    expect(authStore.getEffectiveRole()).toBeNull()
    expect(authStore.isAdmin()).toBe(false)
  })

  it('7b. a legacy admin role on the profile never outranks the canonical role', async () => {
    seedProfile('co_a', [], { role: 'admin' })
    seedCompany('co_a', { member: 'viewer' })
    await importStore()
    await signIn()

    expect(authStore.getEffectiveRole()).toBe('viewer')
    expect(authStore.isAdmin()).toBe(false)
  })

  it('a company with an active membership but no legacy mention is not discovered (legacy remains the discovery hint until the migration)', async () => {
    seedProfile('co_a')
    seedCompany('co_a'); seedCompany('co_hidden')
    await importStore()
    await signIn()

    expect(companyIds()).toEqual(['co_a'])
  })
})

describe('late responses never restore a company that is gone', () => {
  it('5. a slow first load whose COMPANY-DOCUMENT read for B succeeded before the removal cannot resurrect B', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    await importStore()

    // First (slow) bootstrap: both memberships read as active, then its read of
    // the B company document is held — carrying a SUCCESS answer fixed now.
    const hold = deferred()
    holds.set('companies/co_b', hold.promise)
    m.auth.currentUser = sessionOf(UID)
    const slow = m.listener!(m.auth.currentUser)
    await vi.waitFor(() => expect(reads).toContain('companies/co_b'))

    // B is removed; a second, fresh bootstrap finds that and completes.
    removeMembership('co_b')
    holds.delete('companies/co_b')
    await m.listener!(m.auth.currentUser)
    expect(companyIds()).toEqual(['co_a'])

    // The stale success for B is released last and must change nothing.
    hold.release()
    await slow

    expect(companyIds()).toEqual(['co_a'])
    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(authStore.getCurrentCompany()?.id).toBe('co_a')
  })

  it('5a. a slow first load whose MEMBERSHIP read for B said "active" cannot resurrect B after a newer load found it removed', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    await importStore()

    // First (slow) bootstrap: its membership read for B is held — and the
    // answer it will eventually deliver says "active".
    const hold = deferred()
    holds.set(`companies/co_b/members/${UID}`, hold.promise)
    m.auth.currentUser = sessionOf(UID)
    const slow = m.listener!(m.auth.currentUser)
    // The held request must really be in flight (and its answer fixed as
    // "active") BEFORE the data changes — otherwise the slow load would simply
    // read the new data and prove nothing.
    await vi.waitFor(() => expect(reads).toContain(`companies/co_b/members/${UID}`))

    // B is removed; a second, fresh bootstrap sees that and completes.
    removeMembership('co_b')
    holds.delete(`companies/co_b/members/${UID}`)
    await m.listener!(m.auth.currentUser)
    expect(companyIds()).toEqual(['co_a'])

    // Now the stale answer is released, last.
    hold.release()
    await slow

    expect(companyIds()).toEqual(['co_a'])
    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(authStore.getCurrentCompany()?.id).toBe('co_a')
  })

  it('5b. a slow switch to B that is superseded by a switch back to A cannot make B current', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    await importStore()
    await signIn()

    const hold = deferred()
    holds.set(`companies/co_b/members/${UID}`, hold.promise)
    const toB = authStore.switchCompany('co_b')
    // The user changes their mind before B answers.
    holds.delete(`companies/co_b/members/${UID}`)
    await authStore.switchCompany('co_a')
    expect(authStore.getActiveCompanyId()).toBe('co_a')

    hold.release()
    await toB

    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(authStore.getCurrentCompany()?.id).toBe('co_a')
    expect(authStore.getEffectiveRole()).toBe('admin')
    expect(authStore.getActiveMembership()?.uid).toBe(UID)
  })

  it('5c. a load that started before a logout cannot sign the user back in', async () => {
    seedProfile('co_a')
    seedCompany('co_a')
    await importStore()
    const hold = deferred()
    holds.set(`companies/co_a/members/${UID}`, hold.promise)
    m.auth.currentUser = sessionOf(UID)
    const slow = m.listener!(m.auth.currentUser)
    await vi.waitFor(() => expect(reads).toContain(`companies/co_a/members/${UID}`))

    // Real logout: Firebase ignores the first null during init, so two.
    m.auth.currentUser = null
    await m.listener!(null)
    await m.listener!(null)
    hold.release()
    await slow

    expect(authStore.getAuthDataStatus()).toBe('signed_out')
    expect(authStore.getCurrentUser()).toBeNull()
    expect(authStore.getAllCompanies()).toEqual([])
    expect(authStore.getEffectiveRole()).toBeNull()
  })

  it('5d. a load that started for one Auth session cannot apply to the next one', async () => {
    seedProfile('co_a')
    seedCompany('co_a')
    await importStore()
    const hold = deferred()
    holds.set(`companies/co_a/members/${UID}`, hold.promise)
    m.auth.currentUser = sessionOf(UID)
    const slow = m.listener!(m.auth.currentUser)
    // The slow request is in flight, with its answer ("admin") already fixed.
    await vi.waitFor(() => expect(reads).toContain(`companies/co_a/members/${UID}`))

    // Same uid, a brand-new Firebase user object: a different session.
    holds.delete(`companies/co_a/members/${UID}`)
    docs.set(`companies/co_a/members/${UID}`, membership(UID, 'viewer'))
    m.auth.currentUser = sessionOf(UID)
    await m.listener!(m.auth.currentUser)
    expect(authStore.getEffectiveRole()).toBe('viewer')

    hold.release()
    await slow
    // The slow one would have said "admin"; it must not have landed.
    expect(authStore.getEffectiveRole()).toBe('viewer')
  })
})

describe('company switching', () => {
  it('switches to another accessible company and loads that company\'s own role', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a', { member: 'admin' }); seedCompany('co_b', { member: 'viewer' })
    await importStore()
    await signIn()
    expect(authStore.getEffectiveRole()).toBe('admin')

    await authStore.switchCompany('co_b')

    expect(authStore.getActiveCompanyId()).toBe('co_b')
    expect(authStore.getCurrentCompany()?.id).toBe('co_b')
    expect(authStore.getEffectiveRole()).toBe('viewer')
    expect(localStorage.getItem('finapp_active_company')).toBe('co_b')
    expect(m.getDocs).not.toHaveBeenCalled()
  })

  it('a company removed AFTER the list was built is refused at switch time and pruned from the switcher', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    await importStore()
    await signIn()
    expect(companyIds()).toEqual(['co_a', 'co_b'])

    removeMembership('co_b')
    await authStore.switchCompany('co_b')

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(authStore.getCurrentCompany()?.id).toBe('co_a')
    expect(companyIds()).toEqual(['co_a'])
    expect(authStore.getEffectiveRole()).toBe('admin')
    expect(localStorage.getItem('finapp_active_company')).toBeNull()
  })

  it('a company that is not in the switcher cannot be selected at all', async () => {
    seedProfile('co_a')
    seedCompany('co_a'); seedCompany('co_other')
    await importStore()
    await signIn()
    const before = reads.length

    await authStore.switchCompany('co_other')

    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(reads.length).toBe(before)
  })

  it('removing YOURSELF from the active company drops you into another one', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    await importStore()
    await signIn()
    await authStore.switchCompany('co_b')
    expect(authStore.getActiveCompanyId()).toBe('co_b')

    // The server removes the caller's own membership in B.
    m.removeMember.mockImplementationOnce(async () => { removeMembership('co_b'); return { changed: true } })
    await authStore.removeMember('co_b', UID)

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe('co_a')
    expect(companyIds()).toEqual(['co_a'])
    expect(authStore.getEffectiveRole()).toBe('admin')
  })

  it('disabling YOURSELF in your only company ends in no_access, not in stale admin rights', async () => {
    seedProfile('co_a')
    seedCompany('co_a')
    await importStore()
    await signIn()

    m.disableMember.mockImplementationOnce(async () => { setStatus('co_a', 'disabled'); return { changed: true } })
    await authStore.disableMember('co_a', UID)

    expect(authStore.getAuthDataStatus()).toBe('no_access')
    expect(authStore.getEffectiveRole()).toBeNull()
    expect(authStore.getCurrentCompany()).toBeNull()
  })

  it('managing SOMEONE ELSE does not re-resolve your own company access', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    await importStore()
    await signIn()
    const beforeCompanyReads = reads.filter(p => p === 'companies/co_b').length

    await authStore.removeMember('co_a', 'someone_else')

    expect(reads.filter(p => p === 'companies/co_b').length).toBe(beforeCompanyReads)
    expect(authStore.getActiveCompanyId()).toBe('co_a')
  })
})

describe('data integrity is still fail-closed', () => {
  it('a corrupted company document of an accessible company is a data_error, never a silent skip', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    docs.set('companies/co_b', { id: 'co_b', name: 'Broken' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await importStore()
    await signIn()
    errorSpy.mockRestore()

    expect(authStore.getAuthDataStatus()).toBe('data_error')
    expect(authStore.getAllCompanies()).toEqual([])
    expect(authStore.getEffectiveRole()).toBeNull()
  })

  it('a corrupted membership counts as no access to that company only', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    docs.set(`companies/co_b/members/${UID}`, { uid: UID, role: 'superuser', status: 'active', createdAt: STAMP, updatedAt: STAMP })
    await importStore()
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(companyIds()).toEqual(['co_a'])
  })

  it.each(['disabled', 'invited'] as const)(
    'defence in depth: a %s membership that the Rules WOULD let through is still refused by the client',
    async status => {
      leakNonActiveMembershipReads = true
      seedProfile('co_a', ['co_b'])
      seedCompany('co_a'); seedCompany('co_b', { status })
      await importStore()
      await signIn()

      expect(reads).toContain(`companies/co_b/members/${UID}`)
      expect(companyIds()).toEqual(['co_a'])
      expect(authStore.getActiveCompanyId()).toBe('co_a')
    },
  )

  it('a membership whose uid disagrees with its document id counts as no access', async () => {
    seedProfile('co_a', ['co_b'])
    seedCompany('co_a'); seedCompany('co_b')
    docs.set(`companies/co_b/members/${UID}`, membership('uid_someone_else'))
    await importStore()
    await signIn()

    expect(companyIds()).toEqual(['co_a'])
  })
})
