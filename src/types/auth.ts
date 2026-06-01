export interface User {
  id: string
  name: string
  email: string
  passwordHash: string
  role: 'admin' | 'accountant' | 'viewer'
  companyId: string
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
