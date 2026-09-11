import type { User } from '../types/auth'
import { can } from '../auth/capabilities'
import type { Role } from '../schemas/auth'

/**
 * Entry gate for the invitation/member management screens.
 *
 * SEC-007 R1: the decision is now the `member.manage` capability of the
 * ACTIVE company's canonical role. The previous implementation read
 * `user.role`/`user.companyId`/`user.companies[]` — legacy profile fields
 * that Rules and Functions no longer honour — so the UI could open the screen
 * for someone the server would refuse, and could refuse someone whose
 * canonical membership had since been changed.
 *
 * The session/company consistency checks are kept: they ensure the role being
 * applied belongs to the company actually on screen, and that the profile in
 * hand belongs to the signed-in session.
 *
 * listInvitations and every member-management callable independently confirm
 * canonical admin access on the server; this only decides what to render.
 */
export function canOpenInvitationManagement(
  user: User | null,
  companyId: string | null,
  activeCompanyId: string | null,
  status: string,
  sessionUid: string | null,
  role: Role | null,
): boolean {
  if (status !== 'ready' || !user || sessionUid !== user.id ||
      !companyId || activeCompanyId !== companyId) return false
  return can(role, 'member.manage')
}
