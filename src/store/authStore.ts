import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  sendEmailVerification,
} from 'firebase/auth'
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, where,
} from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { callCreateCompany } from '../lib/companyApi'
import type { User, Company } from '../types/auth'
import { parseLegacyUserDocument, type DataError } from '../schemas/auth'
import { parseCompanyDocument } from '../schemas/company'

// ── In-memory state ──────────────────────────────────────────────────────────
let currentUser:    User    | null = null
let currentCompany: Company | null = null
let companyUsers:   User[]         = []
let allUserCompanies: Company[]    = []

// Observable data status — see src/hooks/useAuth.ts. `data_error` means a
// Firestore document failed schema validation (see src/schemas/auth.ts,
// src/schemas/company.ts); it is deliberately NOT recoverable by falling
// back to a default role or a partially-loaded list (CLAUDE.md §6.2).
// `setup_incomplete` — SEC-004: the Firebase Auth user exists, but the
// server-side `createCompany` setup has not (yet) succeeded. Distinct from
// `data_error` (a corrupted/invalid EXISTING document) — this is an
// incomplete-but-recoverable state with a safe retry (authStore.completeCompanySetup()).
export type AuthDataStatus = 'loading' | 'ready' | 'signed_out' | 'data_error' | 'setup_incomplete'
let authDataStatus: AuthDataStatus = 'loading'
let lastDataError: DataError | null = null

/** Any document at the users/companies boundary failed validation (or its
 * document ID didn't match its own uid/id field). Clear ALL privileged
 * in-memory state instead of continuing with a partially-loaded/corrupted
 * result — never substitute a default role. This must clear the FULL
 * context (including allUserCompanies/activeCompanyId, not just
 * currentUser/currentCompany/companyUsers) — otherwise a stale company
 * list or active company id could keep being returned via the public
 * getters/useAuth() after a data_error (independent review finding #1
 * on SEC-002 PR #9). All clears happen before notify() so no subscriber
 * ever observes an intermediate/stale state. */
function setDataErrorState(error: DataError) {
  console.error('[authStore] data_error:', error.source, error.issues)
  currentUser = null; currentCompany = null; companyUsers = []
  allUserCompanies = []
  activeCompanyId = null
  localStorage.removeItem(LS_ACTIVE_COMPANY)
  authDataStatus = 'data_error'
  lastDataError = error
  notify()
}

/** Parses a list of users/{uid} documents. Fails the WHOLE list on the first
 * invalid entry — a corrupted record is never silently dropped while the
 * rest of the list is kept ("partially trusted list"). */
function parseLegacyUsersList(
  docs: { id: string; data: () => unknown }[],
): { ok: true; data: User[] } | { ok: false; error: DataError } {
  const users: User[] = []
  for (const d of docs) {
    const parsed = parseLegacyUserDocument(d.id, d.data())
    if (!parsed.ok) return parsed
    users.push(parsed.data)
  }
  return { ok: true, data: users }
}

/** Same all-or-nothing contract as parseLegacyUsersList, for companies/{id}
 * documents. Non-existent snapshots are skipped (that is normal — a
 * membership entry pointing at a company that hasn't loaded yet — not
 * corruption); an EXISTING document that fails validation fails the list. */
function parseCompanyDocsList(
  snaps: { id: string; exists: () => boolean; data: () => unknown }[],
): { ok: true; data: Company[] } | { ok: false; error: DataError } {
  const companies: Company[] = []
  for (const s of snaps) {
    if (!s.exists()) continue
    const parsed = parseCompanyDocument(s.id, s.data())
    if (!parsed.ok) return parsed
    companies.push(parsed.data)
  }
  return { ok: true, data: companies }
}

// Active company may differ from user.companyId when user switches company
const LS_ACTIVE_COMPANY = 'finapp_active_company'
let activeCompanyId: string | null = localStorage.getItem(LS_ACTIVE_COMPANY)

// Prevents recovery code from firing while register() is still writing Firestore docs
let _registrationInProgress = false

export type AuthError = 'email_taken' | 'invalid_credentials' | 'user_not_found' | 'setup_incomplete'

// ── SEC-004: resumable registration state (no password, no tokens) ────────
const LS_PENDING_SETUP = 'finapp_pending_setup'

interface PendingCompanySetup {
  idempotencyKey: string
  ownerName: string
  companyName: string
  legalType: 'ooo' | 'ip'
  inn?: string
}

function savePendingSetup(pending: PendingCompanySetup) {
  localStorage.setItem(LS_PENDING_SETUP, JSON.stringify(pending))
}

function loadPendingSetup(): PendingCompanySetup | null {
  const raw = localStorage.getItem(LS_PENDING_SETUP)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCompanySetup> | null
    if (!parsed || typeof parsed.idempotencyKey !== 'string' || !parsed.idempotencyKey) return null
    if (typeof parsed.ownerName !== 'string' || typeof parsed.companyName !== 'string') return null
    if (parsed.legalType !== 'ooo' && parsed.legalType !== 'ip') return null
    return {
      idempotencyKey: parsed.idempotencyKey,
      ownerName: parsed.ownerName,
      companyName: parsed.companyName,
      legalType: parsed.legalType,
      inn: typeof parsed.inn === 'string' ? parsed.inn : undefined,
    }
  } catch {
    return null
  }
}

function clearPendingSetup() {
  localStorage.removeItem(LS_PENDING_SETUP)
}

/** Loads the canonical profile/company from Firestore (never fabricated
 * client-side) after the server has confirmed company creation. Returns
 * false — without throwing — on any read/parse failure; callers must treat
 * that as setup_incomplete, never as a reason to fall back to local state. */
async function loadReadyStateAfterSetup(uid: string, companyId: string): Promise<boolean> {
  let userSnap, companySnap
  try {
    userSnap = await getDoc(doc(db, 'users', uid))
    companySnap = await getDoc(doc(db, 'companies', companyId))
  } catch {
    return false
  }
  if (!userSnap.exists() || !companySnap.exists()) return false

  const parsedProfile = parseLegacyUserDocument(uid, userSnap.data())
  if (!parsedProfile.ok) { setDataErrorState(parsedProfile.error); return false }
  const parsedCompany = parseCompanyDocument(companyId, companySnap.data())
  if (!parsedCompany.ok) { setDataErrorState(parsedCompany.error); return false }

  currentUser = parsedProfile.data
  currentCompany = parsedCompany.data
  companyUsers = [currentUser]
  allUserCompanies = [currentCompany]
  authDataStatus = 'ready'
  lastDataError = null
  notify()
  return true
}

// ── Pub/sub ──────────────────────────────────────────────────────────────────
type Listener = () => void
const listeners = new Set<Listener>()
function notify() { listeners.forEach(fn => fn()) }

export function subscribeAuth(fn: Listener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ── Default categories (reused for recovery) ──────────────────────────────────
const DEFAULT_CATEGORIES_AUTH = [
  { id: 'cat_inc1', name: 'Выручка от клиентов', type: 'income',   icon: 'TrendingUp',     color: '#22c55e' },
  { id: 'cat_inc2', name: 'Прочие доходы',        type: 'income',   icon: 'BarChart2',      color: '#10b981' },
  { id: 'cat_inc3', name: 'Займы полученные',      type: 'income',   icon: 'Banknote',       color: '#6ee7b7' },
  { id: 'cat_exp1', name: 'Зарплата',              type: 'expense',  icon: 'Users',          color: '#ef4444' },
  { id: 'cat_exp2', name: 'Аренда',                type: 'expense',  icon: 'Building2',      color: '#f97316' },
  { id: 'cat_exp3', name: 'Реклама и маркетинг',   type: 'expense',  icon: 'Megaphone',      color: '#a855f7' },
  { id: 'cat_exp4', name: 'Закупка товаров',        type: 'expense',  icon: 'Package',        color: '#3b82f6' },
  { id: 'cat_exp5', name: 'Налоги',                type: 'expense',  icon: 'Landmark',       color: '#64748b' },
  { id: 'cat_exp6', name: 'Связь и интернет',      type: 'expense',  icon: 'Wifi',           color: '#06b6d4' },
  { id: 'cat_exp7', name: 'Командировки',          type: 'expense',  icon: 'Plane',          color: '#8b5cf6' },
  { id: 'cat_tr1',  name: 'Внутренний перевод',    type: 'transfer', icon: 'ArrowLeftRight', color: '#94a3b8' },
]

// ── Firebase Auth listener (fires on every tab/device) ────────────────────────
//
// IMPORTANT: Firebase fires onAuthStateChanged(null) on the very FIRST call
// during page initialization — BEFORE it has checked storage for cached credentials.
// We ignore this first null to prevent premature logout redirects.
// The truly-not-logged-in case is handled by auth.authStateReady().
let _firstNullConsumed = false

onAuthStateChanged(auth, async firebaseUser => {
  if (!firebaseUser) {
    if (!_firstNullConsumed) {
      // This may be Firebase's temporary null during init — skip it.
      // auth.authStateReady() below will handle the truly-logged-out case.
      _firstNullConsumed = true
      return
    }
    // Real logout (user explicitly signed out, or token expired)
    currentUser = null; currentCompany = null; companyUsers = []
    authDataStatus = 'signed_out'
    lastDataError = null
    notify()
    return
  }

  // User is authenticated — mark first-null as consumed
  _firstNullConsumed = true

  try {
    const userSnap = await getDoc(doc(db, 'users', firebaseUser.uid))

    if (!userSnap.exists()) {
      if (_registrationInProgress) {
        // register()/completeCompanySetup() is still running — it will call notify() itself
        return
      }
      // users/{uid} is missing for an authenticated user (e.g. an
      // interrupted registration, or a genuinely orphaned Auth account).
      // SEC-004: this used to silently create a local admin+company
      // fallback here — any Firestore hiccup (or even a normal first
      // sign-in before registration finished) granted admin over a brand
      // new company. Company/profile creation is now EXCLUSIVELY the
      // server `createCompany` callable (src/lib/companyApi.ts) — there is
      // no safe local substitute. Surface setup_incomplete so the UI can
      // offer authStore.completeCompanySetup() as a safe retry instead.
      currentUser = null; currentCompany = null; companyUsers = []
      allUserCompanies = []
      activeCompanyId = null
      localStorage.removeItem(LS_ACTIVE_COMPANY)
      authDataStatus = 'setup_incomplete'
      lastDataError = null
      notify()
      return
    }

    const parsedProfile = parseLegacyUserDocument(firebaseUser.uid, userSnap.data())
    if (!parsedProfile.ok) { setDataErrorState(parsedProfile.error); return }
    currentUser = parsedProfile.data

    // Validate activeCompanyId belongs to this user — clear it if it's from a different account
    const validCompanyIds = [
      currentUser.companyId,
      ...(currentUser.companies ?? []).map(m => m.companyId),
    ]
    if (activeCompanyId && !validCompanyIds.includes(activeCompanyId)) {
      activeCompanyId = null
      localStorage.removeItem(LS_ACTIVE_COMPANY)
    }

    // Resolve active company: last switched, else home
    const resolvedActiveId = activeCompanyId ?? currentUser.companyId
    if (!activeCompanyId) activeCompanyId = currentUser.companyId

    // Collect all company IDs this user belongs to
    const memberIds = [
      currentUser.companyId,
      ...( (currentUser.companies ?? []).map(m => m.companyId).filter(id => id !== currentUser!.companyId) ),
    ]

    const [companySnap, usersSnap, ...extraSnaps] = await Promise.all([
      getDoc(doc(db, 'companies', resolvedActiveId)),
      getDocs(query(collection(db, 'users'), where('companyId', '==', resolvedActiveId))),
      ...memberIds.filter(id => id !== resolvedActiveId).map(id => getDoc(doc(db, 'companies', id))),
    ])

    if (!companySnap.exists()) {
      // companies/{companyId} is missing — auto-create it
      const now = new Date().toISOString()
      const recoveredCompany: Company = {
        id: resolvedActiveId, name: 'Моя компания', legalType: 'ip',
        currency: 'RUB', createdAt: now, ownerId: currentUser.id,
      }
      currentCompany = recoveredCompany

      try {
        await Promise.all([
          setDoc(doc(db, 'companies',    resolvedActiveId), recoveredCompany),
          setDoc(doc(db, 'company_data', resolvedActiveId), {
            accounts: [], categories: DEFAULT_CATEGORIES_AUTH, counterparties: [],
            transactions: [], projects: [], rules: [],
          }),
        ])
        console.log('[authStore] Auto-recovered missing company doc:', resolvedActiveId)
      } catch (recoveryErr) {
        console.warn('[authStore] Company recovery write failed (will use localStorage fallback):', recoveryErr)
      }
    } else {
      const parsedCompany = parseCompanyDocument(resolvedActiveId, companySnap.data())
      if (!parsedCompany.ok) { setDataErrorState(parsedCompany.error); return }
      currentCompany = parsedCompany.data
    }

    const parsedUsers = parseLegacyUsersList(usersSnap.docs)
    if (!parsedUsers.ok) { setDataErrorState(parsedUsers.error); return }
    companyUsers = parsedUsers.data

    // Build list of all companies user belongs to
    const parsedExtraCompanies = parseCompanyDocsList(extraSnaps)
    if (!parsedExtraCompanies.ok) { setDataErrorState(parsedExtraCompanies.error); return }
    allUserCompanies = [
      ...(currentCompany ? [currentCompany] : []),
      ...parsedExtraCompanies.data,
    ]
    authDataStatus = 'ready'
    lastDataError = null
  } catch (err) {
    console.error('[authStore] onAuthStateChanged error:', err)
    currentUser = null; currentCompany = null; companyUsers = []
    authDataStatus = 'data_error'
    lastDataError = { code: 'data_error', source: 'onAuthStateChanged', issues: ['unexpected_error'] }
  }
  notify()
})

// For the truly-not-logged-in case: useAuth.ts has a 3-second fallback timer
// that calls setLoading(false). That timer is enough to handle the redirect.
// We intentionally do NOT call notify() here to avoid premature redirects
// while Firestore reads are still in flight after authStateReady resolves.

// ── Default company data (new registrations) ──────────────────────────────────
const DEFAULT_CATEGORIES = [
  { id: 'cat_inc1', name: 'Выручка от клиентов', type: 'income',   icon: 'TrendingUp',     color: '#22c55e' },
  { id: 'cat_inc2', name: 'Прочие доходы',        type: 'income',   icon: 'BarChart2',      color: '#10b981' },
  { id: 'cat_inc3', name: 'Займы полученные',      type: 'income',   icon: 'Banknote',       color: '#6ee7b7' },
  { id: 'cat_exp1', name: 'Зарплата',              type: 'expense',  icon: 'Users',          color: '#ef4444' },
  { id: 'cat_exp2', name: 'Аренда',                type: 'expense',  icon: 'Building2',      color: '#f97316' },
  { id: 'cat_exp3', name: 'Реклама и маркетинг',   type: 'expense',  icon: 'Megaphone',      color: '#a855f7' },
  { id: 'cat_exp4', name: 'Закупка товаров',        type: 'expense',  icon: 'Package',        color: '#3b82f6' },
  { id: 'cat_exp5', name: 'Налоги',                type: 'expense',  icon: 'Landmark',       color: '#64748b' },
  { id: 'cat_exp6', name: 'Связь и интернет',      type: 'expense',  icon: 'Wifi',           color: '#06b6d4' },
  { id: 'cat_exp7', name: 'Командировки',          type: 'expense',  icon: 'Plane',          color: '#8b5cf6' },
  { id: 'cat_tr1',  name: 'Внутренний перевод',    type: 'transfer', icon: 'ArrowLeftRight', color: '#94a3b8' },
]

// ── Store ─────────────────────────────────────────────────────────────────────
export const authStore = {

  // ── Register new company owner ────────────────────────────────────────────
  // SEC-004: company/profile creation happens EXCLUSIVELY server-side (see
  // functions/src/index.ts createCompany). This only (1) creates the
  // Firebase Auth user, (2) sends the verification email, then delegates to
  // completeCompanySetup() — which also powers the UI's retry path, so a
  // network/server failure here and a retry click go through the exact same
  // code (and the exact same idempotency key).
  async register(params: {
    name: string; email: string; password: string
    companyName: string; legalType: 'ooo' | 'ip'; inn?: string
  }): Promise<{ ok: true } | { ok: false; error: AuthError }> {
    let cred: Awaited<ReturnType<typeof createUserWithEmailAndPassword>>
    try {
      _registrationInProgress = true
      cred = await createUserWithEmailAndPassword(auth, params.email, params.password)
      // Регистрация без подтверждения email позволяла завести аккаунт на
      // чужой адрес без владения им. Письмо не блокирует использование
      // приложения — только помечает адрес как неподтверждённый.
      sendEmailVerification(cred.user).catch(err =>
        console.warn('[register] sendEmailVerification failed:', err))
    } catch (e) {
      _registrationInProgress = false
      const code = (e as { code?: string } | null)?.code
      if (code === 'auth/email-already-in-use') return { ok: false, error: 'email_taken' }
      return { ok: false, error: 'invalid_credentials' }
    }

    // crypto.randomUUID() idempotency key — generated ONCE per registration
    // attempt and persisted (without the password) so a retry after a
    // network/server failure reuses it instead of minting a new one, which
    // is what lets the server's SEC-004 bootstrap-idempotency mechanism
    // recognize a retry as the SAME attempt.
    savePendingSetup({
      idempotencyKey: crypto.randomUUID(),
      ownerName: params.name,
      companyName: params.companyName,
      legalType: params.legalType,
      inn: params.inn,
    })

    return authStore.completeCompanySetup()
  },

  // ── Complete or retry the server-side company setup ───────────────────────
  // Called by register() right after Auth user creation, and again by the
  // UI's retry button after a setup_incomplete result. NEVER creates a new
  // Firebase Auth user and never touches the password — it only re-sends the
  // SAME pending idempotency key/payload to the server `createCompany`
  // callable. A failure here must not fall back to any local admin/company
  // state — see loadReadyStateAfterSetup(), which only ever reads the
  // canonical Firestore documents the server itself wrote.
  async completeCompanySetup(): Promise<{ ok: true } | { ok: false; error: AuthError }> {
    const pending = loadPendingSetup()
    if (!auth.currentUser || !pending) {
      _registrationInProgress = false
      authDataStatus = 'setup_incomplete'
      lastDataError = null
      notify()
      return { ok: false, error: 'setup_incomplete' }
    }

    try {
      const response = await callCreateCompany(pending)
      clearPendingSetup()
      activeCompanyId = response.companyId
      localStorage.setItem(LS_ACTIVE_COMPANY, response.companyId)

      const loaded = await loadReadyStateAfterSetup(auth.currentUser.uid, response.companyId)
      _registrationInProgress = false
      if (!loaded) {
        authDataStatus = 'setup_incomplete'
        notify()
        return { ok: false, error: 'setup_incomplete' }
      }
      return { ok: true }
    } catch (e) {
      console.error('[register] createCompany failed (auth succeeded):', e)
      _registrationInProgress = false
      authDataStatus = 'setup_incomplete'
      lastDataError = null
      notify()
      return { ok: false, error: 'setup_incomplete' }
    }
  },

  // ── Login ─────────────────────────────────────────────────────────────────
  async login(email: string, password: string): Promise<{ ok: true } | { ok: false; error: AuthError }> {
    try {
      await signInWithEmailAndPassword(auth, email, password)
      return { ok: true }
    } catch {
      return { ok: false, error: 'invalid_credentials' }
    }
  },

  // ── Logout ────────────────────────────────────────────────────────────────
  async logout() {
    activeCompanyId = null
    localStorage.removeItem(LS_ACTIVE_COMPANY)
    await signOut(auth)
  },

  // ── Reset password ────────────────────────────────────────────────────────
  async resetPassword(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await sendPasswordResetEmail(auth, email)
      return { ok: true }
    } catch {
      return { ok: false, error: 'user_not_found' }
    }
  },

  // ── Getters ───────────────────────────────────────────────────────────────
  getCurrentUser()    { return currentUser },
  getCurrentCompany() { return currentCompany },
  getCompanyUsers(_companyId: string) { return companyUsers },
  getSession()        { return auth.currentUser ? { userId: auth.currentUser.uid, companyId: currentUser?.companyId ?? '', expiresAt: '' } : null },
  getAuthDataStatus(): AuthDataStatus { return authDataStatus },
  getDataError(): DataError | null { return lastDataError },

  // ── Invite user (REST API — keeps current admin session) ──────────────────
  async inviteUser(params: {
    name: string; email: string; password: string
    role: User['role']; companyId: string
  }): Promise<{ ok: true } | { ok: false; error: AuthError }> {
    try {
      const apiKey = import.meta.env.VITE_FIREBASE_API_KEY
      const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: params.email, password: params.password, returnSecureToken: false }),
        },
      )
      const data = await resp.json()
      if (!resp.ok) {
        if (data?.error?.message?.includes('EMAIL_EXISTS')) return { ok: false, error: 'email_taken' }
        return { ok: false, error: 'invalid_credentials' }
      }

      const uid: string = data.localId
      const user: User = {
        id: uid, name: params.name, email: params.email.toLowerCase(),
        role: params.role, companyId: params.companyId, createdAt: new Date().toISOString(),
      }
      await setDoc(doc(db, 'users', uid), user)

      // Refresh company users list
      const snap = await getDocs(query(collection(db, 'users'), where('companyId', '==', params.companyId)))
      const parsedUsers = parseLegacyUsersList(snap.docs)
      if (!parsedUsers.ok) {
        // The invite write above already succeeded — report it as such —
        // but the refreshed list itself is corrupted: don't trust or apply
        // it (no partial/partially-trusted list), surface data_error instead.
        setDataErrorState(parsedUsers.error)
        return { ok: true }
      }
      companyUsers = parsedUsers.data
      notify()
      return { ok: true }
    } catch {
      return { ok: false, error: 'invalid_credentials' }
    }
  },

  // ── Remove user (Firestore only — no Admin SDK needed) ────────────────────
  async removeUser(userId: string) {
    await deleteDoc(doc(db, 'users', userId))
    companyUsers = companyUsers.filter(u => u.id !== userId)
    notify()
  },

  // ── Update user profile ───────────────────────────────────────────────────
  async updateUser(
    userId: string,
    data: { name?: string; email?: string; role?: User['role']; password?: string },
  ): Promise<{ ok: true } | { ok: false; error: AuthError }> {
    try {
      // Check email uniqueness
      if (data.email) {
        const conflict = companyUsers.find(u => u.email === data.email!.toLowerCase() && u.id !== userId)
        if (conflict) return { ok: false, error: 'email_taken' }
      }

      const updates: Partial<User> = {}
      if (data.name)  updates.name  = data.name
      if (data.email) updates.email = data.email.toLowerCase()
      if (data.role)  updates.role  = data.role

      if (Object.keys(updates).length) {
        await updateDoc(doc(db, 'users', userId), updates)
      }

      // Смена пароля возможна только для собственного аккаунта — прямая
      // установка чужого пароля из клиента небезопасна и невозможна без
      // Admin SDK. Для сброса пароля другому пользователю используйте
      // authStore.resetPassword(email) (письмо со ссылкой сброса).
      if (data.password) {
        if (auth.currentUser?.uid !== userId) {
          return { ok: false, error: 'invalid_credentials' }
        }
        const idToken = await auth.currentUser.getIdToken()
        await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${import.meta.env.VITE_FIREBASE_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, password: data.password, returnSecureToken: false }),
          },
        )
      }

      // Refresh local cache
      companyUsers = companyUsers.map(u => u.id === userId ? { ...u, ...updates } : u)
      if (currentUser?.id === userId) currentUser = { ...currentUser, ...updates }
      notify()
      return { ok: true }
    } catch {
      return { ok: false, error: 'invalid_credentials' }
    }
  },

  // ── Update company ────────────────────────────────────────────────────────
  async updateCompany(companyId: string, data: Partial<Pick<Company, 'name' | 'legalType' | 'inn' | 'currency'>>) {
    await updateDoc(doc(db, 'companies', companyId), data)
    if (currentCompany) currentCompany = { ...currentCompany, ...data }
    allUserCompanies = allUserCompanies.map(c => c.id === companyId ? { ...c, ...data } : c)
    notify()
  },

  // ── Роль и права для активной компании ────────────────────────────────────
  // Роль может отличаться между компаниями (multi-company), поэтому берём роль
  // именно для активной компании.
  getEffectiveRole(): User['role'] {
    if (!currentUser) return 'viewer'
    const activeId = activeCompanyId ?? currentUser.companyId
    if (activeId === currentUser.companyId) return currentUser.role
    const membership = currentUser.companies?.find(c => c.companyId === activeId)
    return membership?.role ?? currentUser.role
  },
  // Может ли менять данные: все, кроме «Наблюдателя»
  canWrite() { return this.getEffectiveRole() !== 'viewer' },
  // Админ компании: настройки компании и управление пользователями
  isAdmin() { return this.getEffectiveRole() === 'admin' },

  // ── Multi-company: getters ────────────────────────────────────────────────
  getActiveCompanyId() {
    return activeCompanyId ?? currentUser?.companyId ?? null
  },

  getAllCompanies() {
    return allUserCompanies
  },

  // ── Multi-company: switch active company ──────────────────────────────────
  async switchCompany(companyId: string) {
    if (companyId === activeCompanyId) return
    activeCompanyId = companyId
    localStorage.setItem(LS_ACTIVE_COMPANY, companyId)

    // Load new company metadata
    const snap = await getDoc(doc(db, 'companies', companyId))
    if (snap.exists()) {
      const parsedCompany = parseCompanyDocument(companyId, snap.data())
      if (!parsedCompany.ok) { setDataErrorState(parsedCompany.error); return }
      currentCompany = parsedCompany.data
    }

    // Refresh users for new company
    const usersSnap = await getDocs(query(collection(db, 'users'), where('companyId', '==', companyId)))
    const parsedUsers = parseLegacyUsersList(usersSnap.docs)
    if (!parsedUsers.ok) { setDataErrorState(parsedUsers.error); return }
    companyUsers = parsedUsers.data

    authDataStatus = 'ready'
    lastDataError = null
    notify()
  },

  // ── Multi-company: create new company ────────────────────────────────────
  async createCompany(params: { name: string; legalType: 'ooo' | 'ip'; inn?: string }) {
    if (!currentUser) return
    const now = new Date().toISOString()
    // crypto.randomUUID() вместо Date.now() — ID компании раньше был
    // временной меткой в миллисекундах, то есть перечисляемым/угадываемым.
    // В сочетании с открытыми Firestore-правилами это позволяло бы читать
    // чужие финансовые данные простым перебором.
    const companyId = 'co_' + crypto.randomUUID()

    const company: Company = {
      id: companyId, name: params.name, legalType: params.legalType,
      inn: params.inn, currency: 'RUB', createdAt: now, ownerId: currentUser.id,
    }

    // Add membership to user record
    const existingCompanies = currentUser.companies ?? [{ companyId: currentUser.companyId, role: 'admin' as const }]
    const updatedCompanies = [...existingCompanies, { companyId, role: 'admin' as const }]

    await Promise.all([
      setDoc(doc(db, 'companies', companyId), company),
      setDoc(doc(db, 'company_data', companyId), {
        accounts: [], categories: DEFAULT_CATEGORIES, counterparties: [],
        transactions: [], projects: [], rules: [], budgets: [], recurring: [],
      }),
      updateDoc(doc(db, 'users', currentUser.id), { companies: updatedCompanies }),
    ])

    currentUser = { ...currentUser, companies: updatedCompanies }
    allUserCompanies = [...allUserCompanies, company]

    // Switch to newly created company
    await authStore.switchCompany(companyId)
  },
}
