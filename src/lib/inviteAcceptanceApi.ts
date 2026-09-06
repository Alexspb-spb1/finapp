import { z } from 'zod'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

const documentId = z.string().min(1).max(200).regex(/^[^/]+$/)
  .refine(value => value !== '.' && value !== '..' && !/^__.*__$/.test(value))
const previewSchema = z.object({
  maskedEmail: z.string().min(1), companyDisplayName: z.string().min(1).max(300),
  roleLabel: z.enum(['Наблюдатель', 'Бухгалтер', 'Администратор']), expiresAt: z.iso.datetime(),
}).strict()
const acceptedSchema = z.object({ companyId: documentId }).strict()
const accessSchema = z.object({
  companyId: documentId, uid: z.string().min(1), role: z.enum(['viewer', 'accountant', 'admin']),
}).strict()
export type CompanyAccess = z.infer<typeof accessSchema>
const messages: Record<string, string> = {
  auth_required: 'Войдите в аккаунт приглашённого пользователя.',
  email_unverified: 'Сначала подтвердите email, затем нажмите «Я подтвердил email».',
  invite_invalid: 'Приглашение недоступно для этого аккаунта. Проверьте ссылку и email.',
  invite_expired: 'Срок приглашения истёк. Попросите администратора прислать новую ссылку.',
  invite_revoked: 'Приглашение отменено. Обратитесь к администратору.',
  invite_already_used: 'Приглашение уже использовано. Повторить принятие может только тот же аккаунт.',
  membership_conflict: 'Доступ не подтверждён. Обратитесь к администратору компании.',
  membership_not_found: 'Доступ к компании не подтверждён.',
  membership_inactive: 'Доступ к компании отключён.',
  membership_data_error: 'Доступ к компании не подтверждён.',
  maintenance_mode: 'Сервис на обслуживании. Повторите позже.',
}
const generic = 'Не удалось выполнить действие. Проверьте соединение и повторите попытку.'
class SafeInviteError extends Error {
  constructor(code: string) { super(Object.hasOwn(messages, code) ? messages[code] : generic) }
}
export function inviteAcceptanceError(error: unknown): string {
  return error instanceof SafeInviteError ? error.message : generic
}
async function call<T>(name: string, input: object, schema: z.ZodType<T>): Promise<T> {
  try {
    const response = await httpsCallable(functions, name)(input)
    const parsed = schema.safeParse(response.data)
    if (!parsed.success) throw new SafeInviteError('invalid_response')
    return parsed.data
  } catch (error) {
    if (error instanceof SafeInviteError) throw error
    const parsed = z.object({ details: z.object({ appCode: z.string() }) }).safeParse(error)
    throw new SafeInviteError(parsed.success ? parsed.data.details.appCode : 'unknown')
  }
}
export const preview = (input: { inviteId: string; token: string }) => call('previewInvite', input, previewSchema)
export const accept = (input: { inviteId: string; token: string }) => call('acceptInvite', input, acceptedSchema)
export async function confirmCompanyAccess(companyId: string, uid: string): Promise<CompanyAccess> {
  const access = await call('getCompanyAccess', { companyId }, accessSchema)
  if (access.companyId !== companyId || access.uid !== uid) throw new SafeInviteError('membership_conflict')
  return access
}
