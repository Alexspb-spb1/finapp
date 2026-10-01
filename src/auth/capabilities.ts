// SEC-010 — the single role → capability mapping for the whole UI.
//
// This module is the ONLY place a role is turned into "may do X". Pages must
// not compare `role === 'admin'` themselves: a scattered check is what let
// Settings.tsx gate a destructive action on the legacy `user.role` field
// instead of the role of the active company.
//
// This is a UX layer, not a security boundary. Every capability below is also
// enforced server-side (Cloud Functions) or by Firestore Rules against the
// canonical membership. Hiding a button must never be the only thing standing
// between a viewer and a write.
import type { Role } from '../schemas/auth'

export const CAPABILITIES = [
  'company.read',
  'transaction.create',
  'transaction.update',
  'transaction.delete',
  'account.manage',
  'budget.manage',
  'company.settings.manage',
  'member.manage',
  'period.close',
] as const

export type Capability = (typeof CAPABILITIES)[number]

const VIEWER: readonly Capability[] = ['company.read']

const ACCOUNTANT: readonly Capability[] = [
  ...VIEWER,
  'transaction.create',
  'transaction.update',
  'transaction.delete',
  'account.manage',
  'budget.manage',
]

const ADMIN: readonly Capability[] = [
  ...ACCOUNTANT,
  'company.settings.manage',
  'member.manage',
  'period.close',
]

const CAPABILITIES_BY_ROLE: Record<Role, readonly Capability[]> = {
  viewer: VIEWER,
  accountant: ACCOUNTANT,
  admin: ADMIN,
}

/**
 * Fail-closed capability check for the ACTIVE company.
 *
 * `role` is `null` whenever the caller has no usable active membership —
 * signed out, membership missing, disabled, still invited, or the profile
 * data failed validation. In every one of those cases the answer is "no",
 * never a default viewer grant.
 */
export function can(role: Role | null | undefined, capability: Capability): boolean {
  if (!role) return false
  return CAPABILITIES_BY_ROLE[role]?.includes(capability) ?? false
}

/** All capabilities of a role; empty for no active membership. */
export function capabilitiesOf(role: Role | null | undefined): readonly Capability[] {
  if (!role) return []
  return CAPABILITIES_BY_ROLE[role] ?? []
}
