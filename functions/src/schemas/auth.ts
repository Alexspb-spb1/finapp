// Server-side runtime schemas — SEC-003.
//
// Deliberately NOT a shared import from the client's src/schemas/auth.ts:
// `functions/` is a separate deployable npm package with its own dependency
// tree (Admin SDK, Node 22 runtime) and must build/typecheck/deploy in
// isolation from the client bundle. The two schema sets are intentionally
// kept in sync by contract (see docs/adr/001-company-membership-and-roles.md
// and docs/remediation/reports/SEC-003.md), not by a cross-package import.
//
// Same hard rules as the client schemas: strict objects, no `.default()`/
// `.catch()`/coerce for role/status, no `.passthrough()` on authorization-
// relevant objects.
import { z } from 'zod'
import { Timestamp } from 'firebase-admin/firestore'
import { FirestoreDocumentIdSchema } from './firestoreIds'

const nonEmptyString = z.string().min(1)

export const RoleSchema = z.enum(['viewer', 'accountant', 'admin'])
export type Role = z.infer<typeof RoleSchema>

export const MembershipStatusSchema = z.enum(['invited', 'active', 'disabled'])
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>

// Real Admin SDK Firestore Timestamp only — never a string/number stand-in.
export const FirestoreTimestampSchema = z.instanceof(Timestamp)

// ── Canonical membership: companies/{companyId}/members/{uid} ──────────────
// Matches docs/adr/001-company-membership-and-roles.md and the client
// MembershipSchema (src/schemas/auth.ts) field-for-field.
export const MembershipSchema = z.object({
  uid: nonEmptyString,
  role: RoleSchema,
  status: MembershipStatusSchema,
  createdAt: FirestoreTimestampSchema,
  updatedAt: FirestoreTimestampSchema,
  invitedBy: nonEmptyString.optional(),
}).strict()
export type Membership = z.infer<typeof MembershipSchema>

// ── Callable request/response boundary schemas ──────────────────────────────
// Shape-only — companyId/subjectUid/role here are NEVER proof of
// authorization by themselves. Real authorization is requireAuth() +
// requireVerifiedEmail() + requireActiveMember()/requireRole() (see
// src/lib/authz.ts), independent of anything in the validated payload.

export const CompanyScopedRequestSchema = z.object({
  companyId: nonEmptyString,
}).strict()
export type CompanyScopedRequest = z.infer<typeof CompanyScopedRequestSchema>

// SEC-007: `companyId`/`subjectUid` are interpolated directly into
// `companies/{companyId}/members/{subjectUid}`, so they must be validated as
// real Firestore document IDs, not merely as non-empty strings. A bare
// non-empty string would admit `.`, `..`, `__reserved__` and embedded `/`.
export const MemberSubjectRequestSchema = z.object({
  companyId: FirestoreDocumentIdSchema,
  subjectUid: FirestoreDocumentIdSchema,
}).strict()
export type MemberSubjectRequest = z.infer<typeof MemberSubjectRequestSchema>

export const SetMemberRoleRequestSchema = z.object({
  companyId: FirestoreDocumentIdSchema,
  subjectUid: FirestoreDocumentIdSchema,
  role: RoleSchema,
}).strict()
export type SetMemberRoleRequest = z.infer<typeof SetMemberRoleRequestSchema>

export const SetMemberStatusRequestSchema = z.object({
  companyId: nonEmptyString,
  subjectUid: nonEmptyString,
  status: MembershipStatusSchema,
}).strict()
export type SetMemberStatusRequest = z.infer<typeof SetMemberStatusRequestSchema>

export const MembershipResponseSchema = z.object({
  membership: MembershipSchema,
}).strict()
export type MembershipResponse = z.infer<typeof MembershipResponseSchema>

// ── Authorization probe (this task's minimal read-only callable) ───────────
// See src/index.ts — proves the real callable pipeline through the
// Functions Emulator without adding any mutating/privileged production
// function ahead of SEC-004.
export const AuthzProbeRequestSchema = z.object({
  companyId: nonEmptyString,
}).strict()
export type AuthzProbeRequest = z.infer<typeof AuthzProbeRequestSchema>

export const AuthzProbeResponseSchema = z.object({
  ok: z.literal(true),
}).strict()
export type AuthzProbeResponse = z.infer<typeof AuthzProbeResponseSchema>
