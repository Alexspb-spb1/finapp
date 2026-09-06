import type { User } from '../types/auth'

/** Temporary validated legacy profile bridge until SEC-008–011. Never use
 * getEffectiveRole's home-role fallback for a different active company.
 * listInvitations additionally confirms canonical admin access on the server. */
export function canOpenInvitationManagement(
  user: User | null,
  companyId: string | null,
  activeCompanyId: string | null,
  status: string,
  sessionUid: string | null,
): boolean {
  if (status !== 'ready' || !user || sessionUid !== user.id ||
      !companyId || activeCompanyId !== companyId) return false
  if (companyId === user.companyId) return user.role === 'admin'
  const entries = user.companies?.filter(entry => entry.companyId === companyId) ?? []
  return entries.length === 1 && entries[0].role === 'admin'
}
