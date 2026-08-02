// Canonical types are derived from the runtime Zod schemas in src/schemas/ —
// see docs/adr/001-company-membership-and-roles.md for the target
// authorization model (SEC-002). `User` is a transitional alias for the
// LEGACY users/{uid} document shape (`LegacyUserSchema`) — kept only so
// existing imports keep compiling until SEC-005 backfills membership data
// and the legacy fields can be removed from users/{uid}.
export type { Role, MembershipStatus, Membership, UserProfile, User } from '../schemas/auth'
export type { Company } from '../schemas/company'

export interface AuthSession {
  userId: string
  companyId: string
  expiresAt: string
}
