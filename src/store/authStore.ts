import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  sendEmailVerification,
  type User as FirebaseUser,
} from 'firebase/auth'
import {
  doc, getDoc, getDocFromServer, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, where,
} from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { callCreateCompany } from '../lib/companyApi'
import type { User, Company } from '../types/auth'
import { parseLegacyUserDocument, type DataError } from '../schemas/auth'
import { parseCompanyDocument } from '../schemas/company'
import { isInvitationEntry } from '../lib/invitationEntry'
import { confirmCompanyAccess } from '../lib/inviteAcceptanceApi'

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
  // Independent audit fix #3 on SEC-004 PR #12: the pending-setup record is
  // now bound to the Firebase Auth uid it was created for. Without this, a
  // shared-device scenario (user A registers/fails, user B signs in on the
  // same browser before A's retry) could let B's completeCompanySetup()
  // silently reuse A's idempotencyKey/company data. See loadUsablePendingSetup().
  uid: string
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
    if (!parsed || typeof parsed.uid !== 'string' || !parsed.uid) return null
    if (typeof parsed.idempotencyKey !== 'string' || !parsed.idempotencyKey) return null
    if (typeof parsed.ownerName !== 'string' || typeof parsed.companyName !== 'string') return null
    if (parsed.legalType !== 'ooo' && parsed.legalType !== 'ip') return null
    return {
      uid: parsed.uid,
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

/** Only returns the pending-setup record if it belongs to THIS uid — see the
 * `uid` field comment on PendingCompanySetup above. A pending record left
 * over from a different (e.g. previously signed-in) user is never usable. */
function loadUsablePendingSetup(uid: string): PendingCompanySetup | null {
  const pending = loadPendingSetup()
  if (!pending || pending.uid !== uid) return null
  return pending
}

function clearPendingSetup() {
  localStorage.removeItem(LS_PENDING_SETUP)
}

type ReadyLoadResult = 'ready' | 'transient_failure' | 'data_error'

/** Loads the canonical profile/company from Firestore (never fabricated
 * client-side) after the server has confirmed company creation.
 * - 'transient_failure' — a read failed or a document doesn't exist yet
 *   (network blip, read-your-write lag): the server-side commit already
 *   happened, so callers must treat this as still-resumable (keep the
 *   pending state, do NOT clear it — independent audit fix #1).
 * - 'data_error' — a document exists but failed schema validation;
 *   setDataErrorState() has ALREADY been called with the real error — a
 *   caller must never overwrite that with 'setup_incomplete' afterwards. */
async function loadReadyStateAfterSetup(uid: string, companyId: string): Promise<ReadyLoadResult> {
  let userSnap, companySnap
  try {
    userSnap = await getDoc(doc(db, 'users', uid))
    companySnap = await getDoc(doc(db, 'companies', companyId))
  } catch {
    return 'transient_failure'
  }
  if (!userSnap.exists() || !companySnap.exists()) return 'transient_failure'

  const parsedProfile = parseLegacyUserDocument(uid, userSnap.data())
  if (!parsedProfile.ok) { setDataErrorState(parsedProfile.error); return 'data_error' }
  const parsedCompany = parseCompanyDocument(companyId, companySnap.data())
  if (!parsedCompany.ok) { setDataErrorState(parsedCompany.error); return 'data_error' }

  currentUser = parsedProfile.data
  currentCompany = parsedCompany.data
  companyUsers = [currentUser]
  allUserCompanies = [currentCompany]
  authDataStatus = 'ready'
  lastDataError = null
  notify()
  return 'ready'
}

// ── Pub/sub ──────────────────────────────────────────────────────────────────
type Listener = () => void
const listeners = new Set<Listener>()
function notify() { listeners.forEach(fn => fn()) }

export function subscribeAuth(fn: Listener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Selection intent is not a completed Auth/data context. Only UI observes
// this signal; notifying subscribeAuth here would prematurely start financial
// companyStore.init against the new company while old data is still visible.
const selectionListeners = new Set<Listener>()
export function subscribeCompanySelection(fn: Listener) {
  selectionListeners.add(fn)
  return () => selectionListeners.delete(fn)
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
  // Invitation Auth never triggers legacy profile recovery or financial loading.
  if (isInvitationEntry) {
    if (!firebaseUser || firebaseUser.uid !== currentUser?.id) {
      currentUser = null; currentCompany = null; companyUsers = []
      allUserCompanies = []; activeCompanyId = null
      authDataStatus = firebaseUser ? 'loading' : 'signed_out'
      lastDataError = null
      notify()
    }
    return
  }
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

  async activateAcceptedCompany(companyId: string, expectedUser: FirebaseUser): Promise<void> {
    const sameSession = () => auth.currentUser === expectedUser && expectedUser.emailVerified
    if (!isInvitationEntry || !sameSession()) throw new Error('Invitation session unavailable')
    const access = await confirmCompanyAccess(companyId, expectedUser.uid)
    if (!sameSession()) throw new Error('Invitation session changed')
    const [profileSnap, companySnap] = await Promise.all([
      getDocFromServer(doc(db, 'users', expectedUser.uid)),
      getDocFromServer(doc(db, 'companies', companyId)),
    ])
    if (!sameSession() || !profileSnap.exists() || !companySnap.exists()) throw new Error('Access readback unavailable')
    const profile = parseLegacyUserDocument(expectedUser.uid, profileSnap.data())
    const company = parseCompanyDocument(companyId, companySnap.data())
    if (!profile.ok || !company.ok) throw new Error('Access readback invalid')
    const entries = profile.data.companies?.filter(entry => entry.companyId === companyId) ?? []
    const role = profile.data.companyId === companyId ? profile.data.role : entries.length === 1 ? entries[0].role : null
    if (role !== access.role || entries.some(entry => entry.role !== role)) throw new Error('Access bridge mismatch')
    // Preserve company navigation for existing members. Only readable, valid
    // metadata is listed; no other company's financial store is initialized.
    const otherIds = [...new Set([profile.data.companyId, ...(profile.data.companies ?? []).map(entry => entry.companyId)])]
      .filter(id => id !== companyId)
    const otherCompanies = await Promise.all(otherIds.map(async id => {
      try {
        const snapshot = await getDocFromServer(doc(db, 'companies', id))
        if (!snapshot.exists()) return null
        const parsed = parseCompanyDocument(id, snapshot.data())
        return parsed.ok ? parsed.data : null
      } catch { return null }
    }))
    if (!sameSession()) throw new Error('Invitation session changed')
    currentUser = profile.data; currentCompany = company.data
    companyUsers = [profile.data]; allUserCompanies = [company.data, ...otherCompanies.filter(value => value !== null)]
    activeCompanyId = companyId; authDataStatus = 'ready'; lastDataError = null
    localStorage.setItem(LS_ACTIVE_COMPANY, companyId)
    notify()
  },

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
    // recognize a retry as the SAME attempt. Bound to `cred.user.uid` — see
    // loadUsablePendingSetup().
    savePendingSetup({
      uid: cred.user.uid,
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
  // UI's retry button after a setup_incomplete result (including after a
  // reload/re-login — see src/components/layout/ProtectedRoute.tsx and
  // src/pages/Register.tsx). NEVER creates a new Firebase Auth user and
  // never touches the password — it only re-sends the SAME pending
  // idempotency key/payload to the server `createCompany` callable.
  //
  // Independent audit fix #1 (SEC-004 PR #12): the pending state is now only
  // cleared, and activeCompanyId only committed, AFTER loadReadyStateAfterSetup()
  // confirms the canonical documents were read back successfully. A
  // transient Firestore read failure right after a successful server commit
  // keeps the pending state intact — a retry reuses the same idempotency
  // key, and the server's bootstrap-idempotency mechanism returns the
  // ALREADY-created companyId rather than creating a second one. A genuine
  // data_error from loadReadyStateAfterSetup() is never downgraded/overwritten.
  async completeCompanySetup(): Promise<{ ok: true } | { ok: false; error: AuthError }> {
    const uid = auth.currentUser?.uid
    if (!uid) {
      _registrationInProgress = false
      authDataStatus = 'setup_incomplete'
      lastDataError = null
      notify()
      return { ok: false, error: 'setup_incomplete' }
    }

    // Independent audit fix #3: never use a pending record that belongs to
    // a DIFFERENT uid (e.g. left over from another user on a shared
    // device) — never call the callable with someone else's name/company
    // data, and never resolve it as if it were this user's attempt.
    const pending = loadUsablePendingSetup(uid)
    if (!pending) {
      _registrationInProgress = false
      authDataStatus = 'setup_incomplete'
      lastDataError = null
      notify()
      return { ok: false, error: 'setup_incomplete' }
    }

    try {
      const response = await callCreateCompany({
        idempotencyKey: pending.idempotencyKey,
        ownerName: pending.ownerName,
        companyName: pending.companyName,
        legalType: pending.legalType,
        inn: pending.inn,
      })

      const result = await loadReadyStateAfterSetup(uid, response.companyId)
      _registrationInProgress = false

      if (result === 'ready') {
        // Only now — after the canonical documents were confirmed readable
        // and valid — is the pending state cleared and this company
        // committed as the active one.
        clearPendingSetup()
        activeCompanyId = response.companyId
        localStorage.setItem(LS_ACTIVE_COMPANY, response.companyId)
        return { ok: true }
      }
      if (result === 'transient_failure') {
        // Server confirmed the company; only the readback failed. Keep the
        // pending state (same idempotencyKey) so a retry is safe.
        authDataStatus = 'setup_incomplete'
        notify()
      }
      // result === 'data_error': loadReadyStateAfterSetup() already set the
      // correct data_error state via setDataErrorState() — do not touch
      // authDataStatus here, and do not clear the pending state either
      // (a corrupted document is not this attempt's fault to discard).
      return { ok: false, error: 'setup_incomplete' }
    } catch (e) {
      console.error('[register] createCompany failed (auth succeeded):', e)
      _registrationInProgress = false
      // Pending state is intentionally NOT cleared — the server may or may
      // not have committed (network error before/after commit); the same
      // idempotencyKey makes a retry safe either way.
      authDataStatus = 'setup_incomplete'
      lastDataError = null
      notify()
      return { ok: false, error: 'setup_incomplete' }
    }
  },

  // ── Start (or restart) company setup for an ALREADY authenticated user ───
  // Independent audit fix #2: used when there is no usable pending-setup
  // record for the current uid (cleared storage, different browser/device,
  // or a pending record that belonged to a different uid) but the user
  // still has a live Firebase Auth session with no completed profile
  // (authDataStatus === 'setup_incomplete'). NEVER calls
  // createUserWithEmailAndPassword and never touches a password — it only
  // (re)creates the pending-setup record for the CURRENT uid with a FRESH
  // idempotency key, then delegates to completeCompanySetup(), so a second
  // Auth account/company can never result from resubmitting this form.
  async startCompanySetup(params: {
    ownerName: string; companyName: string; legalType: 'ooo' | 'ip'; inn?: string
  }): Promise<{ ok: true } | { ok: false; error: AuthError }> {
    const uid = auth.currentUser?.uid
    if (!uid) return { ok: false, error: 'setup_incomplete' }

    savePendingSetup({
      uid,
      idempotencyKey: crypto.randomUUID(),
      ownerName: params.ownerName,
      companyName: params.companyName,
      legalType: params.legalType,
      inn: params.inn,
    })
    return authStore.completeCompanySetup()
  },

  // ── Is there a resumable pending setup for the current uid? ──────────────
  // Lets the UI decide between a plain "retry" button (pending exists) and a
  // re-entry form (no usable pending — see startCompanySetup()), without
  // exposing the raw idempotency key.
  getResumableSetupSummary(): { companyName: string; legalType: 'ooo' | 'ip' } | null {
    const uid = auth.currentUser?.uid
    if (!uid) return null
    const pending = loadUsablePendingSetup(uid)
    return pending ? { companyName: pending.companyName, legalType: pending.legalType } : null
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
    // SEC-006: immediately unmount company-scoped invitation UI before I/O.
    selectionListeners.forEach(listener => listener())

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
