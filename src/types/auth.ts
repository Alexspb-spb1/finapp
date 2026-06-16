export interface User {
  id: string          // Firebase Auth UID
  name: string
  email: string
  role: 'admin' | 'accountant' | 'viewer'
  companyId: string   // primary (home) company
  companies?: { companyId: string; role: 'admin' | 'accountant' | 'viewer' }[]
  createdAt: string
  avatar?: string
}

export interface Company {
  id: string
  name: string
  legalType: 'ooo' | 'ip'
  inn?: string
  currency: string
  createdAt: string
  ownerId: string
}

export interface AuthSession {
  userId: string
  companyId: string
  expiresAt: string
}
