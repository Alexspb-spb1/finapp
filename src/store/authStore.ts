import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from 'firebase/auth'
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, where,
} from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import type { User, Company } from '../types/auth'

// ── In-memory state ──────────────────────────────────────────────────────────
let currentUser:    User    | null = null
let currentCompany: Company | null = null
let companyUsers:   User[]         = []

export type AuthError = 'email_taken' | 'invalid_credentials' | 'user_not_found'

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
    notify()
    return
  }

  // User is authenticated — mark first-null as consumed
  _firstNullConsumed = true

  try {
    const userSnap = await getDoc(doc(db, 'users', firebaseUser.uid))

    if (!userSnap.exists()) {
      // users/{uid} document is missing — recovery: create it from Auth data
      const now = new Date().toISOString()
      const companyId = 'co_' + firebaseUser.uid   // stable UID-based ID
      const email = firebaseUser.email ?? 'user@unknown.com'

      const recoveredUser: User = {
        id: firebaseUser.uid,
        name: firebaseUser.displayName ?? email.split('@')[0],
        email: email.toLowerCase(),
        role: 'admin',
        companyId,
        createdAt: now,
      }
      const recoveredCompany: Company = {
        id: companyId, name: 'Моя компания', legalType: 'ip',
        currency: 'RUB', createdAt: now, ownerId: firebaseUser.uid,
      }

      // Use recovered data in memory regardless of Firestore write success
      currentUser    = recoveredUser
      currentCompany = recoveredCompany
      companyUsers   = [recoveredUser]

      try {
        await Promise.all([
          setDoc(doc(db, 'users',        firebaseUser.uid), recoveredUser),
          setDoc(doc(db, 'companies',    companyId),        recoveredCompany),
          setDoc(doc(db, 'company_data', companyId),        {
            accounts: [], categories: DEFAULT_CATEGORIES_AUTH, counterparties: [],
            transactions: [], projects: [], rules: [],
          }),
        ])
        console.log('[authStore] Auto-recovered missing Firestore docs for uid:', firebaseUser.uid)
      } catch (recoveryErr) {
        // Firestore write failed (rules or network) — but we still allow the user
        // to use the app with in-memory + localStorage storage via the UID fallback.
        console.warn('[authStore] Recovery write to Firestore failed (will use localStorage fallback):', recoveryErr)
      }
      notify()
      return
    }

    currentUser = userSnap.data() as User

    const [companySnap, usersSnap] = await Promise.all([
      getDoc(doc(db, 'companies', currentUser.companyId)),
      getDocs(query(collection(db, 'users'), where('companyId', '==', currentUser.companyId))),
    ])

    if (!companySnap.exists()) {
      // companies/{companyId} is missing — auto-create it
      const now = new Date().toISOString()
      const recoveredCompany: Company = {
        id: currentUser.companyId, name: 'Моя компания', legalType: 'ip',
        currency: 'RUB', createdAt: now, ownerId: currentUser.id,
      }
      // Use recovered data in memory regardless of Firestore write success
      currentCompany = recoveredCompany

      try {
        await Promise.all([
          setDoc(doc(db, 'companies',    currentUser.companyId), recoveredCompany),
          setDoc(doc(db, 'company_data', currentUser.companyId), {
            accounts: [], categories: DEFAULT_CATEGORIES_AUTH, counterparties: [],
            transactions: [], projects: [], rules: [],
          }),
        ])
        console.log('[authStore] Auto-recovered missing company doc:', currentUser.companyId)
      } catch (recoveryErr) {
        console.warn('[authStore] Company recovery write failed (will use localStorage fallback):', recoveryErr)
      }
    } else {
      currentCompany = companySnap.data() as Company
    }

    companyUsers = usersSnap.docs.map(d => d.data() as User)
  } catch (err) {
    console.error('[authStore] onAuthStateChanged error:', err)
    currentUser = null; currentCompany = null; companyUsers = []
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
  async register(params: {
    name: string; email: string; password: string
    companyName: string; legalType: 'ooo' | 'ip'; inn?: string
  }): Promise<{ ok: true } | { ok: false; error: AuthError }> {
    try {
      const cred = await createUserWithEmailAndPassword(auth, params.email, params.password)
      const uid = cred.user.uid
      const now = new Date().toISOString()
      const companyId = 'co_' + Date.now()

      const company: Company = {
        id: companyId, name: params.companyName, legalType: params.legalType,
        inn: params.inn, currency: 'RUB', createdAt: now, ownerId: uid,
      }
      const user: User = {
        id: uid, name: params.name, email: params.email.toLowerCase(),
        role: 'admin', companyId, createdAt: now,
      }
      const defaultData = {
        accounts: [], categories: DEFAULT_CATEGORIES, counterparties: [],
        transactions: [], projects: [], rules: [],
      }

      await Promise.all([
        setDoc(doc(db, 'users',        uid),        user),
        setDoc(doc(db, 'companies',    companyId),  company),
        setDoc(doc(db, 'company_data', companyId),  defaultData),
      ])

      // Вручную обновляем in-memory state — onAuthStateChanged мог сработать
      // ДО того как setDoc завершился, и обнаружить что doc ещё не существует.
      // Здесь гарантируем что состояние актуально после успешной регистрации.
      currentUser    = user
      currentCompany = company
      companyUsers   = [user]
      notify()

      return { ok: true }
    } catch (e: any) {
      if (e?.code === 'auth/email-already-in-use') return { ok: false, error: 'email_taken' }
      return { ok: false, error: 'invalid_credentials' }
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
      companyUsers = snap.docs.map(d => d.data() as User)
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

      // If changing own password — use Firebase Auth REST API
      if (data.password && auth.currentUser?.uid === userId) {
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
    notify()
  },
}
