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
// Firestore Timestamps) — validated, not coerced.
//
// `Date.parse()`/`new Date()` alone are NOT sufficient here (independent
// review finding #2 on SEC-002 PR #9): both accept non-ISO formats
// ("01/02/2026", "January 1, 2026", bare "2026-01-02" with no time/zone),
// AND `new Date('2026-02-30T...Z')` silently normalizes to March 2 instead
// of failing — so an out-of-range calendar day would otherwise pass.
// Full ISO-8601 extended datetime: date + mandatory time + mandatory
// timezone designator (Z or +/-HH:MM), optional fractional seconds.
const ISO_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function isValidIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME_RE.exec(value)
  if (!match) return false
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  const second = Number(secondStr)
  if (month < 1 || month > 12) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  // Day-0-of-next-month trick (UTC, so no local-timezone/DST interference)
  // gives the last valid day of `month` — correctly accounts for leap years.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day >= 1 && day <= daysInMonth
}

const isoDateTimeString = nonEmptyString.refine(isValidIsoDateTime, { message: 'invalid_iso_date' })

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
