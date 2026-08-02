// Runtime authorization schemas — SEC-002.
//
// These schemas validate data at the Firestore/network boundary. They do
// NOT implement authorization by themselves (server-side enforcement is
// SEC-003+) and they do NOT change what is currently deployed to Firestore.
// See docs/adr/001-company-membership-and-roles.md for the target model.
//
// Hard rules enforced throughout this file (do not weaken):
// - no `.default()`/`.catch()` for role/status — unknown values are REJECTED,
//   never silently coerced to a "safe" default;
// - no `.passthrough()` on authorization-relevant objects — every schema
//   here is `.strict()`, so unexpected/extra fields fail the whole parse;
// - Firestore Timestamp fields require a real `Timestamp` instance — plain
//   strings/numbers are never accepted as a substitute.
import { z } from 'zod'
import { Timestamp } from 'firebase/firestore'

const nonEmptyString = z.string().min(1)

// ── Role / membership status ────────────────────────────────────────────

export const RoleSchema = z.enum(['viewer', 'accountant', 'admin'])
export type Role = z.infer<typeof RoleSchema>

export const MembershipStatusSchema = z.enum(['invited', 'active', 'disabled'])
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>

// Real Firestore Timestamp only — never a string/number stand-in. Coercion
// here would let a client-controlled string masquerade as a trusted
// server-set createdAt/updatedAt value.
export const FirestoreTimestampSchema = z.instanceof(Timestamp)

// ── Canonical membership: companies/{companyId}/members/{uid} ──────────────
// Matches docs/adr/001-company-membership-and-roles.md exactly. Not deployed
// anywhere yet — this schema exists so future SEC-003+ code has a validated
// contract to read/write against from day one.

export const MembershipSchema = z.object({
  uid: nonEmptyString,
  role: RoleSchema,
  status: MembershipStatusSchema,
  createdAt: FirestoreTimestampSchema,
  updatedAt: FirestoreTimestampSchema,
  invitedBy: nonEmptyString.optional(),
}).strict()
export type Membership = z.infer<typeof MembershipSchema>

// ── Canonical user profile: users/{uid} ─────────────────────────────────────
// Profile-only. Deliberately excludes role/companyId/companies/isAdmin/
// permissions/ownerId — none of those are a legitimate part of the
// canonical profile, and `.strict()` rejects them outright rather than
// silently dropping them.

export const UserProfileSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  email: nonEmptyString,
  avatar: z.string().optional(),
  createdAt: nonEmptyString,
}).strict()
export type UserProfile = z.infer<typeof UserProfileSchema>

// ── Legacy transitional schema (pre-SEC-005) ────────────────────────────────
// LegacyUserSchema is NOT the canonical authorization model. It exists only
// to validate the CURRENT production users/{uid} shape (role/companyId/
// companies[] embedded in the profile document) until SEC-005 backfills
// companies/{companyId}/members/{uid} and this schema can be deleted. It is
// intentionally still strict and still rejects unknown roles/malformed
// entries — "transitional" does not mean "permissive".

const LegacyMembershipEntrySchema = z.object({
  companyId: nonEmptyString,
  role: RoleSchema,
}).strict()

export const LegacyUserSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  email: nonEmptyString,
  role: RoleSchema,
  companyId: nonEmptyString,
  companies: z.array(LegacyMembershipEntrySchema).optional(),
  createdAt: nonEmptyString,
  avatar: z.string().optional(),
}).strict()
// `User` — transitional alias kept only so existing imports of the legacy
// shape keep compiling. Not a second, independently-written contract: it is
// literally `z.infer<typeof LegacyUserSchema>`.
export type User = z.infer<typeof LegacyUserSchema>

// ── Callable request/response boundary schemas ──────────────────────────────
// Cloud Functions are NOT implemented in SEC-002 (FUNCTIONS_IMPLEMENTATION_APPROVED:
// false). These schemas only validate the SHAPE of a future request/response —
// companyId/subjectUid/role here are never proof of authorization by
// themselves. Real token verification and membership checks are SEC-003.

export const CompanyScopedRequestSchema = z.object({
  companyId: nonEmptyString,
}).strict()

export const MemberSubjectRequestSchema = z.object({
  companyId: nonEmptyString,
  subjectUid: nonEmptyString,
}).strict()

export const SetMemberRoleRequestSchema = z.object({
  companyId: nonEmptyString,
  subjectUid: nonEmptyString,
  role: RoleSchema,
}).strict()

export const SetMemberStatusRequestSchema = z.object({
  companyId: nonEmptyString,
  subjectUid: nonEmptyString,
  status: MembershipStatusSchema,
}).strict()

export const MembershipResponseSchema = z.object({
  membership: MembershipSchema,
}).strict()

// ── Boundary parsers ─────────────────────────────────────────────────────
//
// Every parser below returns an explicit result — never throws a raw
// ZodError, never includes the source document/email/field values in the
// error, and never invents a default role or partial success.

export interface DataError {
  code: 'data_error'
  source: string
  issues: string[]
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DataError }

/** Zod issues -> DataError. Deliberately keeps only `path`/`code` — never
 * `.message` or the parsed value — so field values (emails, names, ids)
 * can never leak into logs/UI through an error object. */
export function zodIssuesToDataError(source: string, error: z.ZodError): DataError {
  return {
    code: 'data_error',
    source,
    issues: error.issues.map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.code}`),
  }
}

function idMismatchError(source: string, field: string): DataError {
  return { code: 'data_error', source, issues: [`${field}: document_id_mismatch`] }
}

export function parseUserProfileDocument(docId: string, raw: unknown): ParseResult<UserProfile> {
  const result = UserProfileSchema.safeParse(raw)
  if (!result.success) return { ok: false, error: zodIssuesToDataError('users/{uid} (canonical)', result.error) }
  if (result.data.id !== docId) return { ok: false, error: idMismatchError('users/{uid} (canonical)', 'id') }
  return { ok: true, data: result.data }
}

export function parseLegacyUserDocument(docId: string, raw: unknown): ParseResult<User> {
  const result = LegacyUserSchema.safeParse(raw)
  if (!result.success) return { ok: false, error: zodIssuesToDataError('users/{uid} (legacy)', result.error) }
  if (result.data.id !== docId) return { ok: false, error: idMismatchError('users/{uid} (legacy)', 'id') }
  return { ok: true, data: result.data }
}

// `source` is a fixed, safe path TEMPLATE — never interpolates the real
// companyId/uid so callers/logs can't leak them via a DataError (independent
// review finding #3 on SEC-002 PR #9). `companyId` is still taken as a
// parameter (kept for API compatibility / future use by callers), but is
// deliberately not read into the error.
const MEMBERSHIP_SOURCE = 'companies/{companyId}/members/{uid}'

export function parseMembershipDocument(_companyId: string, uid: string, raw: unknown): ParseResult<Membership> {
  const result = MembershipSchema.safeParse(raw)
  if (!result.success) return { ok: false, error: zodIssuesToDataError(MEMBERSHIP_SOURCE, result.error) }
  if (result.data.uid !== uid) return { ok: false, error: idMismatchError(MEMBERSHIP_SOURCE, 'uid') }
  return { ok: true, data: result.data }
}
