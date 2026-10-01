// SEC-007 client wire contract for server-side member management.
//
// Mirrors functions/src/schemas/auth.ts. The client never writes a role or a
// membership itself: every one of these calls is a Cloud Function that
// re-derives the caller's admin rights from the canonical membership inside a
// transaction, protects the last active admin and writes an audit event.
//
// Failures are surfaced as user-visible text. Nothing is ever reported as a
// success that did not happen, and no SDK message, details object or cause is
// propagated — only a mapped message for a known application code.
import { z } from 'zod'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'
import { RoleSchema } from '../schemas/auth'

const id = z.string().min(1).max(200)

/** `changed: false` means the membership was already in the requested state:
 * the call succeeded and deliberately wrote nothing. */
const resultSchema = z.object({ changed: z.boolean() }).strict()
export type MemberMutationResult = z.infer<typeof resultSchema>
export type MemberRole = z.infer<typeof RoleSchema>

const messages = {
  auth_required: 'Войдите снова, чтобы управлять участниками.',
  email_unverified: 'Подтвердите ваш email перед управлением участниками.',
  invalid_request: 'Проверьте выбранного участника и роль.',
  membership_not_found: 'Участник не найден в этой компании. Обновите список.',
  membership_inactive: 'Ваш доступ к этой компании неактивен. Обновите страницу.',
  membership_data_error: 'Данные участника повреждены. Обратитесь к администратору.',
  membership_conflict: 'Текущий статус участника не допускает это действие. Обновите список.',
  insufficient_role: 'Управлять участниками может только администратор компании.',
  last_admin: 'Нельзя убрать последнего администратора компании. Сначала назначьте другого.',
  maintenance_mode: 'Сервис временно на обслуживании. Повторите позже.',
} as const

const FALLBACK = 'Не удалось выполнить действие. Проверьте соединение и обновите список.'

export class MemberApiError extends Error {
  readonly code: string
  constructor(code: string) {
    super(Object.hasOwn(messages, code) ? messages[code as keyof typeof messages] : FALLBACK)
    this.code = code
    this.name = 'MemberApiError'
  }
}

/** Message for any thrown value, including network failures. Never silently
 * swallows an error and never claims success. */
export function memberErrorMessage(error: unknown): string {
  return error instanceof MemberApiError ? error.message : FALLBACK
}

async function call(name: string, input: object): Promise<MemberMutationResult> {
  try {
    const result = await httpsCallable(functions, name)(input)
    const parsed = resultSchema.safeParse(result.data)
    if (!parsed.success) throw new MemberApiError('invalid_response')
    return parsed.data
  } catch (error) {
    if (error instanceof MemberApiError) throw error
    const parsed = z.object({ details: z.object({ appCode: z.string() }) }).safeParse(error)
    throw new MemberApiError(parsed.success ? parsed.data.details.appCode : 'unknown')
  }
}

const subjectSchema = z.object({ companyId: id, subjectUid: id }).strict()
const roleSchema = z.object({ companyId: id, subjectUid: id, role: RoleSchema }).strict()
const companySchema = z.object({ companyId: id }).strict()

/** Canonical roster entry. `name`/`email` are display-only and may be null
 * when the member has no profile document — the member must still be listed
 * and manageable. */
const rosterEntrySchema = z.object({
  uid: id,
  role: RoleSchema,
  status: z.enum(['invited', 'active', 'disabled']),
  name: z.string().min(1).nullable(),
  email: z.string().min(1).nullable(),
}).strict()
const rosterSchema = z.object({ members: z.array(rosterEntrySchema) }).strict()
export type CompanyMemberEntry = z.infer<typeof rosterEntrySchema>

/** Local validation failures surface exactly like server refusals — a
 * rejected promise carrying a MemberApiError — so a caller that only awaits
 * never faces a synchronous throw or a raw ZodError. */
async function validated<T>(schema: z.ZodType<T>, input: unknown, name: string): Promise<MemberMutationResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new MemberApiError('invalid_request')
  return call(name, parsed.data as object)
}

/** Reads the canonical roster. Separate from `call` because it returns a
 * roster rather than a mutation result, but it shares the error contract. */
async function callRoster(input: unknown): Promise<CompanyMemberEntry[]> {
  const validatedInput = companySchema.safeParse(input)
  if (!validatedInput.success) throw new MemberApiError('invalid_request')
  try {
    const result = await httpsCallable(functions, 'listCompanyMembers')(validatedInput.data)
    const parsed = rosterSchema.safeParse(result.data)
    if (!parsed.success) throw new MemberApiError('invalid_response')
    return parsed.data.members
  } catch (error) {
    if (error instanceof MemberApiError) throw error
    const parsed = z.object({ details: z.object({ appCode: z.string() }) }).safeParse(error)
    throw new MemberApiError(parsed.success ? parsed.data.details.appCode : 'unknown')
  }
}

export const memberApi = {
  /** Canonical member list of a company — the only supported source of "who
   * belongs here". Built server-side because a secondary-company member's
   * profile is unreadable by the browser under canonical Rules. */
  listMembers: (input: { companyId: string }) => callRoster(input),
  changeRole: (input: { companyId: string; subjectUid: string; role: MemberRole }) =>
    validated(roleSchema, input, 'changeMemberRole'),
  disable: (input: { companyId: string; subjectUid: string }) =>
    validated(subjectSchema, input, 'disableMember'),
  restore: (input: { companyId: string; subjectUid: string }) =>
    validated(subjectSchema, input, 'restoreMember'),
  remove: (input: { companyId: string; subjectUid: string }) =>
    validated(subjectSchema, input, 'removeMember'),
}
