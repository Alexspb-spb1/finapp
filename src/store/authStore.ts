import type { User, Company, AuthSession } from '../types/auth'

const USERS_KEY = 'finapp_users'
const COMPANIES_KEY = 'finapp_companies'
const SESSION_KEY = 'finapp_session'

function hashPassword(password: string): string {
  // Simple deterministic hash (not cryptographic — for demo only)
  let hash = 0
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return hash.toString(36)
}

function loadUsers(): User[] {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) ?? '[]') } catch { return [] }
}
function saveUsers(users: User[]) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users))
}
function loadCompanies(): Company[] {
  try { return JSON.parse(localStorage.getItem(COMPANIES_KEY) ?? '[]') } catch { return [] }
}
function saveCompanies(companies: Company[]) {
  localStorage.setItem(COMPANIES_KEY, JSON.stringify(companies))
}
function loadSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const session: AuthSession = JSON.parse(raw)
    if (new Date(session.expiresAt) < new Date()) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    return session
  } catch { return null }
}
function saveSession(session: AuthSession | null) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  else localStorage.removeItem(SESSION_KEY)
}

export type AuthError = 'email_taken' | 'invalid_credentials' | 'user_not_found'

export const authStore = {
  register(params: { name: string; email: string; password: string; companyName: string; legalType: 'ooo' | 'ip'; inn?: string }): { ok: true } | { ok: false; error: AuthError } {
    const users = loadUsers()
    if (users.find(u => u.email.toLowerCase() === params.email.toLowerCase())) {
      return { ok: false, error: 'email_taken' }
    }

    const companyId = 'co_' + Date.now()
    const userId = 'u_' + Date.now()
    const now = new Date().toISOString()

    const company: Company = {
      id: companyId,
      name: params.companyName,
      legalType: params.legalType,
      inn: params.inn,
      currency: 'RUB',
      createdAt: now,
      ownerId: userId,
    }

    const user: User = {
      id: userId,
      name: params.name,
      email: params.email.toLowerCase(),
      passwordHash: hashPassword(params.password),
      role: 'admin',
      companyId,
      createdAt: now,
    }

    const companies = loadCompanies()
    saveCompanies([...companies, company])
    saveUsers([...users, user])

    const session: AuthSession = {
      userId: user.id,
      companyId: company.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }
    saveSession(session)

    notify()
    return { ok: true }
  },

  login(email: string, password: string): { ok: true } | { ok: false; error: AuthError } {
    const users = loadUsers()
    const user = users.find(u => u.email === email.toLowerCase())
    if (!user) return { ok: false, error: 'invalid_credentials' }
    if (user.passwordHash !== hashPassword(password)) return { ok: false, error: 'invalid_credentials' }

    const session: AuthSession = {
      userId: user.id,
      companyId: user.companyId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }
    saveSession(session)
    notify()
    return { ok: true }
  },

  logout() {
    saveSession(null)
    notify()
  },

  getSession(): AuthSession | null {
    return loadSession()
  },

  getCurrentUser(): User | null {
    const session = loadSession()
    if (!session) return null
    return loadUsers().find(u => u.id === session.userId) ?? null
  },

  getCurrentCompany(): Company | null {
    const session = loadSession()
    if (!session) return null
    return loadCompanies().find(c => c.id === session.companyId) ?? null
  },

  getCompanyUsers(companyId: string): User[] {
    return loadUsers().filter(u => u.companyId === companyId)
  },

  inviteUser(params: { name: string; email: string; password: string; role: User['role']; companyId: string }): { ok: true } | { ok: false; error: AuthError } {
    const users = loadUsers()
    if (users.find(u => u.email.toLowerCase() === params.email.toLowerCase())) {
      return { ok: false, error: 'email_taken' }
    }
    const user: User = {
      id: 'u_' + Date.now(),
      name: params.name,
      email: params.email.toLowerCase(),
      passwordHash: hashPassword(params.password),
      role: params.role,
      companyId: params.companyId,
      createdAt: new Date().toISOString(),
    }
    saveUsers([...users, user])
    notify()
    return { ok: true }
  },

  removeUser(userId: string) {
    const users = loadUsers().filter(u => u.id !== userId)
    saveUsers(users)
    notify()
  },

  updateCompany(companyId: string, data: Partial<Pick<Company, 'name' | 'legalType' | 'inn' | 'currency'>>) {
    const companies = loadCompanies().map(c => c.id === companyId ? { ...c, ...data } : c)
    saveCompanies(companies)
    notify()
  },
}

type Listener = () => void
const listeners = new Set<Listener>()
function notify() { listeners.forEach(fn => fn()) }

export function subscribeAuth(fn: Listener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
