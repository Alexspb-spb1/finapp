// Invitation model, constants, and request/document schemas — SEC-006
// Stage 1 (model/schemas/Rules only — no callables exist yet, see
// functions/src/index.ts, and docs/remediation/reports/SEC-006.md for the
// full staged plan this file is Stage 1 of).
//
// Same hard rules as functions/src/schemas/auth.ts and company.ts: strict
// objects, no `.passthrough()`, and — for authorization-relevant fields
// ONLY (role, status, companyId, uid, timestamps) — no `.default()`/
// `.catch()`/coerce of any kind. Unknown fields are always rejected — this
// is what stops a payload-smuggled `role`/`companyId`/`uid`/timestamp field
// from ever being read by a future callable; no field is EVER read from
// `request.data` for anything not listed in the relevant request schema
// below. This restriction does NOT extend to non-privileged fields: e.g.
// `ListInvitationsRequestSchema`'s `pageSize` below deliberately uses
// `.default(20)` — bounded pagination has no bearing on authorization, so
// defaulting it is safe and intentional, not an exception to this rule.
//
// Role reuse: RoleSchema is imported from ./auth.ts (already the canonical
// source within this package — see docs/adr/001-company-membership-and-roles.md)
// rather than re-declared here. auth.ts's own header comment explains why
// this schema set is intentionally NOT shared with the client's
// src/schemas/auth.ts (separate deployable package, kept in sync by
// contract, not by cross-package import) — that boundary is unrelated to
// this file, which lives inside the SAME `functions/` package as auth.ts
// and imports it directly with no boundary crossing at all.
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { RoleSchema, FirestoreTimestampSchema } from './auth'

const nonEmptyString = z.string().min(1)
const idLikeString = nonEmptyString.max(200)

// A value that is actually used as a literal Firestore document ID
// segment (via `.doc(value)` or `FieldPath.documentId()`) — unlike the
// general-purpose `idLikeString` above, which is only ever a lookup key
// passed to a `.where(...)` equality filter, this enforces Firestore's
// actual documented document-ID constraints
// (https://firebase.google.com/docs/firestore/quotas): no `/` (which
// would otherwise let a forged value smuggle a multi-segment path into a
// query/reference that expects a single document ID segment), and not
// exactly `.` or `..`, and not matching `__.*__` (Firestore reserves that
// pattern for its own internal use and rejects it outright). Originally
// introduced as `cursorDocumentIdString` for the listInvitations cursor
// (independent review findings on SEC-006 Stage 2b rounds 1-2) and
// generalized here (independent review finding #2 on SEC-006 Stage 3
// round 1) so a value genuinely used as a document ID segment gets this
// protection instead of the bare-length `idLikeString`: an unvalidated
// value here would otherwise pass request validation and only fail later
// inside Firestore's own path resolution, surfacing as a generic
// `membership_data_error`/`internal_error` instead of the stable
// `invalid_request` a malformed ID must always produce.
//
// NOT yet applied everywhere it arguably should be (independent review,
// SEC-006 Stage 3 round 2 PASS, non-blocking documentation note): as of
// this writing, `InviteMemberRequestSchema.companyId` and
// `ListInvitationsRequestSchema.companyId` — both also used as a literal
// `companies/{companyId}` path segment via `requireActiveMember` — still
// use the plain `idLikeString`. Widening those was out of scope for
// SEC-006 Stage 3 (which only required fixing `CancelInviteRequestSchema`);
// tracked as a candidate for a future, separate cleanup task rather than
// folded into this one.
const RESERVED_FIRESTORE_DOCUMENT_ID_PATTERN = /^__.*__$/
export const FirestoreDocumentIdSchema = nonEmptyString
  .max(200)
  .regex(/^[^/]+$/)
  .refine(
    value => value !== '.' && value !== '..' && !RESERVED_FIRESTORE_DOCUMENT_ID_PATTERN.test(value),
    { message: 'not a valid Firestore document ID' },
  )

// ── Canonical constants ──────────────────────────────────────────────────
// Approved owner defaults (SEC_006_RECOMMENDED_DEFAULTS) — not re-derived
// or duplicated anywhere else; every future callable that needs these
// values imports them from here.
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const INVITATION_RESEND_COOLDOWN_MS = 60 * 1000
export const INVITATION_RESEND_LIMIT = 5

// ── Status ────────────────────────────────────────────────────────────────
// Deliberately only three stored values. "expired" is NEVER a stored
// status — it is a computed condition (`status === 'pending' && now >=
// expiresAt`), checked at read/accept time, so no scheduled cleanup job is
// required to keep it accurate.
export const InvitationStatusSchema = z.enum(['pending', 'accepted', 'revoked'])
export type InvitationStatus = z.infer<typeof InvitationStatusSchema>

export function isInvitationExpired(status: InvitationStatus, expiresAt: Date, now: Date): boolean {
  return status === 'pending' && now.getTime() >= expiresAt.getTime()
}

// ── Email normalization ──────────────────────────────────────────────────
// trim + lowercase, then validated as a real email shape — empty/whitespace
// -only/malformed values are rejected, never silently coerced to something
// usable.
export const NormalizedEmailSchema = z.string().trim().toLowerCase().min(1).email()

// ── Raw invitation token / tokenHash ────────────────────────────────────
// Raw token: 256 random bits, base64url-encoded without padding — exactly
// 43 characters (ceil(256/6) = 43). This schema is used to validate a
// token ARRIVING from the client (previewInvite/acceptInvite request) — it
// never appears in any Firestore document schema below (see
// InvitationDocumentSchema's own comment).
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const RawInvitationTokenSchema = z.string().regex(RAW_TOKEN_PATTERN)

// tokenHash: SHA-256 hex digest of the raw token — the ONLY form of the
// token ever persisted.
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/
export const TokenHashSchema = z.string().regex(TOKEN_HASH_PATTERN)

// ── Firestore document model: invitations/{inviteId} ────────────────────
// A discriminated union on `status` — each variant's shape STRUCTURALLY
// proves the status-dependent field invariants (not merely "these fields
// happen to be null"): the accepted-audit fields (acceptedAt/acceptedByUid)
// are entirely ABSENT from the shape of a 'pending' or 'revoked' document,
// and likewise for revoked-audit fields on 'pending'/'accepted' — combined
// with `.strict()` on every variant, a document carrying fields from the
// "wrong" status fails validation outright, it is not merely discouraged.
// No `rawToken`/`token` field exists anywhere in this schema — only
// `tokenHash` — proving structurally that the raw token is never persisted.
const invitationBaseFields = {
  companyId: idLikeString,
  emailNormalized: NormalizedEmailSchema,
  role: RoleSchema,
  tokenHash: TokenHashSchema,
  expiresAt: FirestoreTimestampSchema,
  createdBy: idLikeString,
  createdAt: FirestoreTimestampSchema,
  updatedAt: FirestoreTimestampSchema,
  resendCount: z.number().int().min(0).max(INVITATION_RESEND_LIMIT),
  lastSentAt: FirestoreTimestampSchema.nullable(),
}

const PendingInvitationDocumentSchema = z.object({
  ...invitationBaseFields,
  status: z.literal('pending'),
}).strict()

const AcceptedInvitationDocumentSchema = z.object({
  ...invitationBaseFields,
  status: z.literal('accepted'),
  acceptedAt: FirestoreTimestampSchema,
  acceptedByUid: idLikeString,
}).strict()

const RevokedInvitationDocumentSchema = z.object({
  ...invitationBaseFields,
  status: z.literal('revoked'),
  revokedAt: FirestoreTimestampSchema,
  revokedBy: idLikeString,
}).strict()

export const InvitationDocumentSchema = z.discriminatedUnion('status', [
  PendingInvitationDocumentSchema,
  AcceptedInvitationDocumentSchema,
  RevokedInvitationDocumentSchema,
])
export type InvitationDocument = z.infer<typeof InvitationDocumentSchema>

// ── Firestore document model: invitationLocks/{lockId} ──────────────────
// Enforces "at most one active pending invitation per (companyId,
// emailNormalized)" transactionally (see docs/remediation/reports/SEC-006.md
// plan v2 §6) — the SAME fixed-deterministic-path technique already proven
// by functions/src/lib/bootstrapIdempotency.ts's `user_bootstrap/{uid}`
// receipt. Holds only the minimal pointer to the current invite; no other
// field.
export const InvitationLockDocumentSchema = z.object({
  currentInviteId: idLikeString,
}).strict()
export type InvitationLockDocument = z.infer<typeof InvitationLockDocumentSchema>

/** Deterministic lock-document ID for (companyId, emailNormalized) — SHA-256
 * hex over a JSON-stringified array, mirroring
 * `idempotency.ts`'s `buildIdempotencyReceiptId()` exactly (same rationale:
 * `JSON.stringify` of an array, not naive `:`-joined concatenation, so
 * neither component's content can forge a fake boundary between the two —
 * see that function's own comment for the concrete collision example).
 * The raw email is never itself the ID or any part of the ID string — only
 * its SHA-256 hash together with companyId. */
export function computeInvitationLockId(companyId: string, emailNormalized: string): string {
  const serialized = JSON.stringify([companyId, emailNormalized])
  return createHash('sha256').update(serialized).digest('hex')
}

// ── Callable request schemas (Stage 2+ — no callable exists yet) ────────
// Every schema below is `.strict()`: unknown fields rejected outright.
// None of these accept an actor/subject uid (the only source of identity
// is requireAuth(request), never the payload — same rule as every existing
// callable in this package). Timestamps are never client-supplied.

export const InviteMemberRequestSchema = z.object({
  companyId: idLikeString,
  email: NormalizedEmailSchema,
  role: RoleSchema,
}).strict()
export type InviteMemberRequest = z.infer<typeof InviteMemberRequestSchema>

// inviteMember's response — SEC-006 Stage 2. Deliberately minimal: the raw
// token is returned here ONLY (this is the one and only moment it ever
// exists outside a local handler variable — see
// functions/src/lib/invitationToken.ts) and nothing else about the
// invitation (tokenHash, emailNormalized, companyId, internal document
// paths) is ever included. `.strict()` makes this structurally provable in
// a unit test: a response object carrying a stray `tokenHash` field fails
// validation outright.
// z.iso.datetime() (not a bare z.string()) enforces the exact shape
// `Date.prototype.toISOString()` produces: millisecond precision, 'Z'
// suffix, no other offset — matching independent review finding #1 on
// SEC-006 Stage 2, which asked for strict UTC ISO validation rather than
// "any non-empty string".
export const InviteMemberResponseSchema = z.object({
  inviteId: idLikeString,
  token: RawInvitationTokenSchema,
  expiresAtUtc: z.iso.datetime(),
}).strict()
export type InviteMemberResponse = z.infer<typeof InviteMemberResponseSchema>

export const ListInvitationsRequestSchema = z.object({
  companyId: idLikeString,
  cursor: nonEmptyString.max(500).optional(),
  pageSize: z.number().int().min(1).max(50).optional().default(20),
}).strict()
export type ListInvitationsRequest = z.infer<typeof ListInvitationsRequestSchema>

// ── listInvitations pagination cursor — SEC-006 Stage 2b ────────────────
// Opaque to the client (base64url-encoded JSON), but with a strict,
// versioned internal schema on the server side — never a bare Firestore
// Timestamp-to-milliseconds conversion (that loses nanosecond precision
// and can cause skips/duplicates across pages), and never containing
// anything privileged (no email, tokenHash, or raw token — only what is
// needed to resume a `.orderBy(createdAt desc).orderBy(__name__ desc)`
// query: the exact (seconds, nanoseconds) pair and the document id).
// `.strict()` rejects any extra field a forged/tampered cursor might add.
export const INVITATIONS_CURSOR_VERSION = 1 as const

// Firestore's own documented `Timestamp` bounds — 0001-01-01T00:00:00Z to
// 9999-12-31T23:59:59.999999999Z inclusive
// (https://cloud.google.com/nodejs/docs/reference/firestore/latest/firestore/timestamp).
// A cursor claiming `createdAtSeconds` outside this range would otherwise
// reach `new Timestamp(...)` in the callable and throw a raw RangeError
// there — independent review finding #1 on SEC-006 Stage 2b round 1:
// that must fail as a stable `invalid_request` here, at validation time,
// never surface as an uncaught construction error mapped to
// `internal_error`.
const FIRESTORE_TIMESTAMP_MIN_SECONDS = -62_135_596_800
const FIRESTORE_TIMESTAMP_MAX_SECONDS = 253_402_300_799

// A cursor's `inviteId` is used directly as a Firestore document ID via
// `FieldPath.documentId()` — see `FirestoreDocumentIdSchema`'s own
// top-of-file comment for the full rationale (this field is where that
// protection originated, on SEC-006 Stage 2b rounds 1-2).
export const InvitationsCursorPayloadSchema = z.object({
  version: z.literal(INVITATIONS_CURSOR_VERSION),
  companyId: idLikeString,
  createdAtSeconds: z.number().int().min(FIRESTORE_TIMESTAMP_MIN_SECONDS).max(FIRESTORE_TIMESTAMP_MAX_SECONDS),
  createdAtNanoseconds: z.number().int().min(0).max(999_999_999),
  inviteId: FirestoreDocumentIdSchema,
}).strict()
export type InvitationsCursorPayload = z.infer<typeof InvitationsCursorPayloadSchema>

// ── listInvitations response — SEC-006 Stage 2b ──────────────────────────
// Every field below is an explicit allowlist entry, never a spread of the
// raw Firestore document — this is what makes it structurally provable
// (via `.strict()`) that tokenHash/lockId/acceptedByUid/revokedBy/any
// other internal field can never leak through this response, no matter
// what the stored document happens to contain.
export const InvitationListItemSchema = z.object({
  inviteId: idLikeString,
  emailNormalized: NormalizedEmailSchema,
  role: RoleSchema,
  status: InvitationStatusSchema,
  createdAtUtc: z.iso.datetime(),
  expiresAtUtc: z.iso.datetime(),
  resendCount: z.number().int().min(0).max(INVITATION_RESEND_LIMIT),
  lastSentAtUtc: z.iso.datetime().nullable(),
  createdBy: idLikeString,
}).strict()
export type InvitationListItem = z.infer<typeof InvitationListItemSchema>

const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/

export const ListInvitationsResponseSchema = z.object({
  items: z.array(InvitationListItemSchema),
  nextCursor: z.string().regex(OPAQUE_CURSOR_PATTERN).nullable(),
}).strict()
export type ListInvitationsResponse = z.infer<typeof ListInvitationsResponseSchema>

// cancelInvite/resendInvite deliberately accept ONLY companyId (the
// requireActiveMember lookup key) + inviteId (the target) — no status,
// email, role, or actor uid; the server re-derives everything else from
// the stored invitation document and requireAuth(request). Both fields
// use `FirestoreDocumentIdSchema` (not the general-purpose `idLikeString`)
// because cancelInvite's handler passes each of them directly into a
// Firestore path segment (`companies/{companyId}/members/{uid}` via
// requireActiveMember, `invitations/{inviteId}` directly) — independent
// review finding #2 on SEC-006 Stage 3 round 1: an unvalidated `/`, `.`,
// `..`, or `__reserved__` value would otherwise pass request validation
// and only fail later inside Firestore's own path resolution
// (`membership_data_error`/`internal_error`), instead of the stable
// `invalid_request` a malformed request must always produce.
export const CancelInviteRequestSchema = z.object({
  companyId: FirestoreDocumentIdSchema,
  inviteId: FirestoreDocumentIdSchema,
}).strict()
export type CancelInviteRequest = z.infer<typeof CancelInviteRequestSchema>

// cancelInvite's response — SEC-006 Stage 3. Deliberately minimal, the
// same allowlist discipline as InviteMemberResponseSchema/
// InvitationListItemSchema: no emailNormalized/role/tokenHash/token, only
// confirmation of which invitation was cancelled and when.
export const CancelInviteResponseSchema = z.object({
  inviteId: idLikeString,
  revokedAtUtc: z.iso.datetime(),
}).strict()
export type CancelInviteResponse = z.infer<typeof CancelInviteResponseSchema>

export const ResendInviteRequestSchema = z.object({
  companyId: idLikeString,
  inviteId: idLikeString,
}).strict()
export type ResendInviteRequest = z.infer<typeof ResendInviteRequestSchema>

// previewInvite is the only PRE-AUTH callable in this set (see
// docs/remediation/reports/SEC-006.md plan v2 §4) — it accepts only what an
// unauthenticated caller can legitimately present: the invite identifier
// and the raw token proving possession of the link. Nothing else.
export const PreviewInviteRequestSchema = z.object({
  inviteId: idLikeString,
  token: RawInvitationTokenSchema,
}).strict()
export type PreviewInviteRequest = z.infer<typeof PreviewInviteRequestSchema>

// acceptInvite deliberately accepts ONLY inviteId + token — no role,
// companyId, email, or uid. Role/companyId/email are read exclusively from
// the stored invitation document (once tokenHash is verified); uid is read
// exclusively from requireAuth(request).
export const AcceptInviteRequestSchema = z.object({
  inviteId: idLikeString,
  token: RawInvitationTokenSchema,
}).strict()
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>
