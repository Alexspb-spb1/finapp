// Client wire contracts mirror functions/src/schemas/invitation.ts. Keep
// server-only crypto/Admin SDK imports out of the browser module graph.
import { z } from 'zod'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'
import { RoleSchema } from '../schemas/auth'

const id = z.string().min(1).max(200)
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const INVITATION_RESEND_LIMIT = 5
export const INVITATION_RESEND_COOLDOWN_MS = 60_000
const linkResponse = z.object({ inviteId: id, token, expiresAtUtc: z.iso.datetime() }).strict()
const itemSchema = z.object({
  inviteId: id, emailNormalized: z.string().trim().toLowerCase().min(1).email(),
  role: RoleSchema, status: z.enum(['pending', 'accepted', 'revoked']),
  createdAtUtc: z.iso.datetime(), expiresAtUtc: z.iso.datetime(),
  resendCount: z.number().int().min(0).max(INVITATION_RESEND_LIMIT),
  lastSentAtUtc: z.iso.datetime().nullable(), createdBy: id,
}).strict()
const listResponse = z.object({
  items: z.array(itemSchema), nextCursor: z.string().regex(/^[A-Za-z0-9_-]+$/).nullable(),
}).strict()
const cancelResponse = z.object({ inviteId: id, revokedAtUtc: z.iso.datetime() }).strict()
export type InvitationLink = z.infer<typeof linkResponse>
export type InvitationListItem = z.infer<typeof itemSchema>
export type InvitationPage = z.infer<typeof listResponse>
export type InvitationRole = z.infer<typeof RoleSchema>

const messages = {
  auth_required: 'Войдите снова, чтобы управлять приглашениями.',
  email_unverified: 'Подтвердите ваш email перед управлением приглашениями.',
  invalid_request: 'Проверьте email и выбранную роль.',
  membership_not_found: 'Доступ к приглашениям этой компании не подтверждён.',
  membership_inactive: 'Доступ к приглашениям этой компании не подтверждён.',
  membership_data_error: 'Доступ к приглашениям этой компании не подтверждён.',
  insufficient_role: 'Управлять приглашениями может только администратор компании.',
  maintenance_mode: 'Сервис временно на обслуживании. Повторите позже.',
  invitation_already_pending: 'Для этого email уже есть приглашение. Обновите список.',
  invitation_not_found: 'Приглашение недоступно. Обновите список.',
  invitation_not_pending: 'Приглашение уже принято или отменено. Обновите список.',
  invitation_resend_cooldown: 'Новую ссылку можно создать через 60 секунд после предыдущей.',
  invitation_resend_limit_reached: 'Достигнут лимит: 5 обновлений ссылки.',
} as const

// Never propagate an SDK message, details object, validation issues or cause:
// even a malformed response/error may contain an invitation token.
export function invitationErrorMessage(error: unknown): string {
  if (error instanceof InvitationApiError) return error.message
  return 'Не удалось выполнить запрос. Проверьте соединение и обновите список. Если ссылка была создана, замените её через «Новая ссылка».'
}
class InvitationApiError extends Error {
  constructor(code: string) {
    super(Object.hasOwn(messages, code) ? messages[code as keyof typeof messages] : invitationErrorMessage(null))
  }
}
async function call<T>(name: string, input: object, schema: z.ZodType<T>): Promise<T> {
  try {
    const result = await httpsCallable(functions, name)(input)
    const parsed = schema.safeParse(result.data)
    if (!parsed.success) throw new InvitationApiError('invalid_response')
    return parsed.data
  } catch (error) {
    if (error instanceof InvitationApiError) throw error
    const parsed = z.object({ details: z.object({ appCode: z.string() }) }).safeParse(error)
    throw new InvitationApiError(parsed.success ? parsed.data.details.appCode : 'unknown')
  }
}
export const invitationApi = {
  create: (input: { companyId: string; email: string; role: InvitationRole }) => call('inviteMember', input, linkResponse),
  list: (input: { companyId: string; cursor?: string; pageSize?: number }) => call('listInvitations', input, listResponse),
  cancel: (input: { companyId: string; inviteId: string }) => call('cancelInvite', input, cancelResponse),
  resend: (input: { companyId: string; inviteId: string }) => call('resendInvite', input, linkResponse),
}

export function buildInvitationLink(invite: InvitationLink, origin: string, base = import.meta.env.BASE_URL): string {
  // The token is a fragment, never a query or a HashRouter route. Stage 7's
  // bootstrap will consume it before bridging this path into HashRouter.
  return new URL(`${base.replace(/\/$/, '')}/accept-invite/${encodeURIComponent(invite.inviteId)}#token=${invite.token}`, origin).href
}
