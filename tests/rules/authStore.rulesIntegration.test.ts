// The REAL authStore running against the REAL firestore.rules (Firestore
// emulator) — SEC-011 R3 / PR #28 audit findings 1–3 end to end.
//
// src/store/authStore.companyAccess.test.ts proves the store's logic against a
// stand-in that *simulates* the Rules' decisions. That leaves a gap: if the
// stand-in and the real Rules ever disagree, both suites stay green. This file
// closes it by wiring the unmodified store to a Firestore handle whose every
// read is judged by the actual rules file, as a real signed-in user.
//
// Only the Firebase *Auth* module is stubbed (to capture the listener and
// drive sign-ins) and the callables (not part of this contract). Nothing about
// Firestore is mocked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { deleteDoc, doc, setDoc, type Firestore } from 'firebase/firestore'

// authStore reads localStorage at module load; the default environment here is
// Node, so provide a minimal in-memory one before it is imported.
class FakeLocalStorage {
  private store = new Map<string, string>()
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null }
  setItem(key: string, value: string) { this.store.set(key, value) }
  removeItem(key: string) { this.store.delete(key) }
  clear() { this.store.clear() }
}
;(globalThis as unknown as { localStorage: FakeLocalStorage }).localStorage = new FakeLocalStorage()

const holder = vi.hoisted(() => ({
  auth: { currentUser: null as { uid: string } | null },
  db: null as unknown,
  listener: null as ((user: { uid: string } | null) => Promise<void>) | null,
  remove: vi.fn(),
  disable: vi.fn(),
}))

vi.mock('../../src/lib/invitationEntry', () => ({ isInvitationEntry: false }))
vi.mock('../../src/lib/firebase', () => ({
  get auth() { return holder.auth },
  get db() { return holder.db },
  functions: {},
}))
vi.mock('../../src/lib/companyApi', () => ({ callCreateCompany: vi.fn() }))
vi.mock('../../src/lib/inviteAcceptanceApi', () => ({ confirmCompanyAccess: vi.fn() }))
vi.mock('../../src/lib/memberApi', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/lib/memberApi')>(),
  memberApi: {
    listMembers: vi.fn(async () => []), changeRole: vi.fn(), restore: vi.fn(),
    disable: holder.disable, remove: holder.remove,
  },
}))
vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: vi.fn(), signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(), sendPasswordResetEmail: vi.fn(), sendEmailVerification: vi.fn(),
  onAuthStateChanged: (_auth: unknown, callback: typeof holder.listener) => { holder.listener = callback },
}))

const PROJECT_ID = 'demo-finapp-authstore-rules'
let testEnv: RulesTestEnvironment

const UID = 'uid_integration_user'
const CO_A = 'integrationCompanyA'
const CO_B = 'integrationCompanyB'

type Role = 'viewer' | 'accountant' | 'admin'
type Status = 'active' | 'disabled' | 'invited'

async function seed(fn: (db: Firestore) => Promise<void>) {
  await testEnv.withSecurityRulesDisabled(async ctx => { await fn(ctx.firestore() as unknown as Firestore) })
}
const seedProfile = (companyId: string, extra: string[] = []) => seed(async db => {
  await setDoc(doc(db, 'users', UID), {
    id: UID, name: 'Integration User', email: 'integration@example.test', role: 'admin', companyId,
    companies: extra.map(id => ({ companyId: id, role: 'admin' })), createdAt: '2026-01-01T00:00:00.000Z',
  })
})
const seedCompany = (id: string, opts: { ownerId?: string } = {}) => seed(async db => {
  await setDoc(doc(db, 'companies', id), {
    id, name: `Company ${id}`, legalType: 'ooo', currency: 'RUB',
    createdAt: '2026-01-01T00:00:00.000Z', ownerId: opts.ownerId ?? 'someone_else',
  })
})
const seedMembership = (id: string, role: Role = 'admin', status: Status = 'active') => seed(async db => {
  await setDoc(doc(db, 'companies', id, 'members', UID), {
    uid: UID, role, status,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  })
})
const removeMembership = (id: string) => seed(async db => { await deleteDoc(doc(db, 'companies', id, 'members', UID)) })

let authStore: typeof import('../../src/store/authStore').authStore
const companyIds = () => authStore.getAllCompanies().map(company => company.id).sort()

/** Signs in through the real listener, as UID, with a Firestore handle that
 * the real Rules judge. Each call is a fresh Auth session object. */
async function signIn() {
  holder.db = testEnv.authenticatedContext(UID).firestore()
  holder.auth.currentUser = { uid: UID }
  await holder.listener!(holder.auth.currentUser)
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  })
})
afterAll(async () => { await testEnv.cleanup() })

beforeEach(async () => {
  await testEnv.clearFirestore()
  vi.resetModules()
  holder.remove.mockReset(); holder.disable.mockReset()
  holder.auth.currentUser = null
  localStorage.clear()
  authStore = (await import('../../src/store/authStore')).authStore
})

describe('authStore against the real Rules: a lost company never breaks the rest of the login', () => {
  it('healthy user with two companies signs in — proving no browser users query remains', async () => {
    await seedProfile(CO_A, [CO_B])
    await seedCompany(CO_A); await seedCompany(CO_B)
    await seedMembership(CO_A); await seedMembership(CO_B, 'viewer')
    await signIn()

    // A users query would be refused by the real Rules and show up as data_error.
    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getDataError()).toBeNull()
    expect(companyIds()).toEqual([CO_A, CO_B])
    expect(authStore.getEffectiveRole()).toBe('admin')
  })

  it('finding 3: removed from B, still a member of A — login opens A, B is gone', async () => {
    await seedProfile(CO_A, [CO_B])
    await seedCompany(CO_A); await seedCompany(CO_B)
    await seedMembership(CO_A); await seedMembership(CO_B)
    await removeMembership(CO_B)
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe(CO_A)
    expect(companyIds()).toEqual([CO_A])
    expect(authStore.getEffectiveRole()).toBe('admin')
  })

  it.each(['disabled', 'invited'] as const)('finding 3: %s in B — A keeps working, B unavailable', async status => {
    await seedProfile(CO_A, [CO_B])
    await seedCompany(CO_A); await seedCompany(CO_B)
    await seedMembership(CO_A); await seedMembership(CO_B, 'admin', status)
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(companyIds()).toEqual([CO_A])
  })

  it('finding 3: a stored active company that was removed falls back safely and is forgotten', async () => {
    await seedProfile(CO_A, [CO_B])
    await seedCompany(CO_A); await seedCompany(CO_B)
    await seedMembership(CO_A)
    localStorage.setItem('finapp_active_company', CO_B)
    vi.resetModules()
    authStore = (await import('../../src/store/authStore')).authStore
    await signIn()

    expect(authStore.getActiveCompanyId()).toBe(CO_A)
    expect(companyIds()).toEqual([CO_A])
    expect(localStorage.getItem('finapp_active_company')).toBeNull()
  })

  it('removed from the home company: a company listed only in companies[] still opens', async () => {
    await seedProfile(CO_B, [CO_A])
    await seedCompany(CO_A); await seedCompany(CO_B)
    await seedMembership(CO_A)
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe(CO_A)
  })

  it('removed everywhere: strict no_access, nothing stale, no error', async () => {
    await seedProfile(CO_A, [CO_B])
    await seedCompany(CO_A); await seedCompany(CO_B)
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('no_access')
    expect(authStore.getDataError()).toBeNull()
    expect(authStore.getCurrentCompany()).toBeNull()
    expect(authStore.getAllCompanies()).toEqual([])
    expect(authStore.getActiveCompanyId()).toBeNull()
    expect(authStore.getEffectiveRole()).toBeNull()
  })

  it('finding 2 end to end: ownerId plus legacy fields without a membership give no company', async () => {
    await seedProfile(CO_A, [CO_B])
    await seedCompany(CO_A, { ownerId: UID }); await seedCompany(CO_B, { ownerId: UID })
    await signIn()

    expect(authStore.getAuthDataStatus()).toBe('no_access')
    expect(authStore.getAllCompanies()).toEqual([])
    expect(authStore.getCurrentCompany()).toBeNull()
  })

  it('a removed former owner stops seeing the company on the next load', async () => {
    await seedProfile(CO_A)
    await seedCompany(CO_A, { ownerId: UID })
    await seedMembership(CO_A)
    await signIn()
    expect(authStore.getAuthDataStatus()).toBe('ready')

    await removeMembership(CO_A)
    await signIn()
    expect(authStore.getAuthDataStatus()).toBe('no_access')
    expect(authStore.getCurrentCompany()).toBeNull()
  })
})

describe('authStore against the real Rules: switching and self-removal', () => {
  it('switching to a company removed in the meantime is refused and pruned', async () => {
    await seedProfile(CO_A, [CO_B])
    await seedCompany(CO_A); await seedCompany(CO_B)
    await seedMembership(CO_A); await seedMembership(CO_B)
    await signIn()
    expect(companyIds()).toEqual([CO_A, CO_B])

    await removeMembership(CO_B)
    await authStore.switchCompany(CO_B)

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe(CO_A)
    expect(companyIds()).toEqual([CO_A])
    expect(authStore.getEffectiveRole()).toBe('admin')
  })

  it('a normal switch loads that company\'s own canonical role', async () => {
    await seedProfile(CO_A, [CO_B])
    await seedCompany(CO_A); await seedCompany(CO_B)
    await seedMembership(CO_A, 'admin'); await seedMembership(CO_B, 'viewer')
    await signIn()

    await authStore.switchCompany(CO_B)
    expect(authStore.getActiveCompanyId()).toBe(CO_B)
    expect(authStore.getEffectiveRole()).toBe('viewer')
  })

  it('removing yourself from the active company moves you to another one', async () => {
    await seedProfile(CO_A, [CO_B])
    await seedCompany(CO_A); await seedCompany(CO_B)
    await seedMembership(CO_A); await seedMembership(CO_B)
    await signIn()
    await authStore.switchCompany(CO_B)

    holder.remove.mockImplementationOnce(async () => { await removeMembership(CO_B); return { changed: true } })
    await authStore.removeMember(CO_B, UID)

    expect(authStore.getAuthDataStatus()).toBe('ready')
    expect(authStore.getActiveCompanyId()).toBe(CO_A)
    expect(companyIds()).toEqual([CO_A])
  })
})
