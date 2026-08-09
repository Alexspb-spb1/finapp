// Server-side createCompany request/response schemas — SEC-004.
//
// Same hard rules as functions/src/schemas/auth.ts: strict objects, no
// `.default()`/`.catch()`/coerce for privileged fields, no `.passthrough()`.
// `.strict()` is what rejects uid/ownerUid/role/companyId/timestamps/
// currency/and-any-other-privileged-field smuggled into the payload — those
// values are NEVER read from `request.data` anywhere in this package; the
// only trusted sources are requireAuth()/Firebase Admin Auth (see
// functions/src/index.ts).
import { z } from 'zod'

const nonEmptyString = z.string().min(1)
const trimmedNonEmpty = z.string().trim().min(1)

export const LegalTypeSchema = z.enum(['ooo', 'ip'])
export type LegalType = z.infer<typeof LegalTypeSchema>

const OOO_INN_RE = /^\d{10}$/
const IP_INN_RE = /^\d{12}$/

export const CreateCompanyRequestSchema = z
  .object({
    // Client-generated crypto.randomUUID(); bounded length matches the
    // idempotency module's own validateIdempotencyKey() check.
    idempotencyKey: nonEmptyString.max(200),
    ownerName: trimmedNonEmpty,
    companyName: trimmedNonEmpty,
    legalType: LegalTypeSchema,
    inn: z.string().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.inn === undefined) return
    const re = data.legalType === 'ooo' ? OOO_INN_RE : IP_INN_RE
    if (!re.test(data.inn)) {
      ctx.addIssue({ code: 'custom', message: 'invalid_inn', path: ['inn'] })
    }
  })
export type CreateCompanyRequest = z.infer<typeof CreateCompanyRequestSchema>

// Minimal response — never the created documents, email, role, or INN.
export const CreateCompanyResponseSchema = z.object({
  companyId: nonEmptyString,
}).strict()
export type CreateCompanyResponse = z.infer<typeof CreateCompanyResponseSchema>
