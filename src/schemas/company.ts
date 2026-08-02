// Runtime company schemas — SEC-002.
//
// Same rules as src/schemas/auth.ts: strict objects, no default/catch for
// authorization-relevant fields, no passthrough. `ownerId` here is validated
// only as a well-formed reference field — it is NEVER treated as proof of
// access. See docs/adr/001-company-membership-and-roles.md ("ownerId
// semantics").
import { z } from 'zod'
import { MembershipSchema, zodIssuesToDataError, type DataError, type ParseResult } from './auth'

const nonEmptyString = z.string().min(1)

export const LegalTypeSchema = z.enum(['ooo', 'ip'])

// Company.createdAt is a plain ISO date-time string in the current
// production shape (unlike Membership.createdAt/updatedAt, which are real
// Firestore Timestamps) — validated as a parseable ISO string, not coerced.
const isoDateTimeString = nonEmptyString.refine(
  value => !Number.isNaN(Date.parse(value)),
  { message: 'invalid_iso_date' },
)

// ── companies/{companyId} ────────────────────────────────────────────────

export const CompanySchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  legalType: LegalTypeSchema,
  inn: nonEmptyString.optional(),
  currency: nonEmptyString,
  createdAt: isoDateTimeString,
  ownerId: nonEmptyString,
}).strict()
export type Company = z.infer<typeof CompanySchema>

// ── Callable request/response boundary schemas ──────────────────────────────
// Shape-only, same caveats as src/schemas/auth.ts — no Cloud Function exists
// yet, real authorization checks are SEC-003/SEC-004.

export const CreateCompanyRequestSchema = z.object({
  name: nonEmptyString,
  legalType: LegalTypeSchema,
  inn: nonEmptyString.optional(),
}).strict()

export const CreateCompanyResponseSchema = z.object({
  company: CompanySchema,
  membership: MembershipSchema,
}).strict()

// ── Boundary parser ─────────────────────────────────────────────────────

export function parseCompanyDocument(docId: string, raw: unknown): ParseResult<Company> {
  const source = 'companies/{companyId}'
  const result = CompanySchema.safeParse(raw)
  if (!result.success) return { ok: false, error: zodIssuesToDataError(source, result.error) }
  if (result.data.id !== docId) {
    const error: DataError = { code: 'data_error', source, issues: ['id: document_id_mismatch'] }
    return { ok: false, error }
  }
  return { ok: true, data: result.data }
}
