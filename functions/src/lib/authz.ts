// Server-side authorization helpers — SEC-003.
//
// This module is the single point of privileged-access decisions for
// Cloud Functions. No callable in this package (or any future one) should
// derive access from anything other than these helpers — never from
// `users/{uid}.role`, `ownerId`, client-supplied payload fields, or a
// `CallableRequest.auth`-adjacent guess.
import type { CallableRequest } from 'firebase-functions/v2/https'
import type { Firestore, Transaction } from 'firebase-admin/firestore'
import { AppError } from './errors'
import { MembershipSchema, type Role, type Membership } from '../schemas/auth'
import type { ZodType } from 'zod'

export interface RequestAuth {
  uid: string
  token: { email_verified?: boolean }
}

/**
 * requireAuth — the ONLY source of caller identity. Uses exclusively the
 * platform-verified `request.auth` populated by the Callable Functions
 * framework from the caller's verified ID token. A `uid` field inside
 * `request.data` (the payload) is never consulted here or anywhere else in
 * this module — payload-supplied identity is not identity.
 */
export function requireAuth(request: CallableRequest<unknown>): RequestAuth {
  if (!request.auth) throw new AppError('auth_required')
  return request.auth as RequestAuth
}

/**
 * requireVerifiedEmail — checks ONLY `auth.token.email_verified === true`,
 * i.e. the platform-verified claim on the ID token used to authenticate
 * this call. An `email`/`emailVerified` field on the request payload or on
 * a Firestore profile document is never treated as proof.
 */
export function requireVerifiedEmail(auth: RequestAuth): void {
  if (auth.token.email_verified !== true) throw new AppError('email_unverified')
}

/**
 * requireActiveMember — reads EXACTLY
 * `companies/{companyId}/members/{uid}` (uid from requireAuth(), never
 * from the payload) and returns the validated membership only if:
 *   - the document exists,
 *   - it passes MembershipSchema (unknown/missing fields, unknown role,
 *     unknown status, or a non-Timestamp createdAt/updatedAt all fail),
 *   - the document ID matches `membership.uid`,
 *   - `status === 'active'`.
 * Any other outcome (missing doc, `invited`/`disabled` status, schema
 * failure, id mismatch, or a Firestore read error) is a deny — there is no
 * fallback to `users/{uid}.role`, `ownerId`, or any cached/client state.
 */
export async function requireActiveMember(
  db: Firestore,
  companyId: string,
  uid: string,
  txn?: Transaction,
): Promise<Membership> {
  const ref = db.collection('companies').doc(companyId).collection('members').doc(uid)

  let snap
  try {
    snap = txn ? await txn.get(ref) : await ref.get()
  } catch {
    // Firestore read failure — fail closed, never fall through to a
    // permissive default.
    throw new AppError('membership_data_error')
  }

  if (!snap.exists) throw new AppError('membership_not_found')

  const parsed = MembershipSchema.safeParse(snap.data())
  if (!parsed.success) throw new AppError('membership_data_error')
  if (parsed.data.uid !== snap.id) throw new AppError('membership_data_error')
  if (parsed.data.status !== 'active') throw new AppError('membership_inactive')

  return parsed.data
}

/**
 * requireRole — checks the ALREADY-VALIDATED membership's role against an
 * explicit allowlist. Because `membership.role` only ever reaches this
 * point after passing MembershipSchema (via requireActiveMember), an
 * unknown role can never be present here — but the allowlist check itself
 * is still exhaustive and rejects anything not explicitly listed. A caller
 * who is `admin` of company A gets no special treatment for company B: this
 * function only ever sees the membership for the ONE company that was
 * looked up by requireActiveMember.
 */
export function requireRole(membership: Membership, allowed: readonly Role[]): void {
  if (!allowed.includes(membership.role)) throw new AppError('insufficient_role')
}

/**
 * validateRequest — the only sanctioned way to turn `request.data: unknown`
 * into a typed value. Schemas are strict (extra fields fail); on failure,
 * throws a generic `invalid_request` AppError with NO details — never the
 * raw ZodError, never the offending value, never the field's actual
 * content (only validateRequest's caller sees the strongly-typed, already
 * safe result on success).
 */
export function validateRequest<T>(schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) throw new AppError('invalid_request')
  return result.data
}

/**
 * assertNotLastAdmin — MUST be called with the same `Transaction` that will
 * also perform the membership mutation, and MUST be awaited before that
 * mutation is applied. It queries the company's active admins INSIDE the
 * transaction (not via a plain `.get()`), so Firestore's optimistic
 * concurrency control makes the whole transaction retry — re-running this
 * check against fresh data — if a concurrent transaction changes any
 * document that was part of this query's result set before this one
 * commits. That is what prevents two concurrent "demote the other admin"
 * requests from both succeeding and leaving zero active admins: whichever
 * transaction commits first invalidates the other's read set, forcing a
 * retry that re-evaluates the (now-smaller) active-admin set.
 *
 * `ownerId` plays no role here — it is a company-metadata reference field,
 * never a membership/authorization signal (see ADR-001, "ownerId
 * semantics"), so it cannot be used to bypass this check.
 */
export async function assertNotLastAdmin(
  db: Firestore,
  txn: Transaction,
  companyId: string,
  subjectUid: string,
): Promise<void> {
  const membersRef = db.collection('companies').doc(companyId).collection('members')
  const query = membersRef.where('status', '==', 'active').where('role', '==', 'admin')

  let activeAdminUids: string[]
  try {
    const snap = await txn.get(query)
    // The query filter only constrains the `role`/`status` FIELD VALUES —
    // it says nothing about whether the rest of the document is a valid
    // membership. A document matching role=admin/status=active by chance
    // (corrupted, or with `uid` not matching its own document ID) must NOT
    // count as a real admin here, the same way requireActiveMember()
    // already refuses to trust such a document for reads (independent
    // review finding #3 on SEC-003 PR #10). Excluding an unverifiable
    // document from the count is the fail-closed direction — it can only
    // make this check MORE protective of the true last admin, never less.
    activeAdminUids = snap.docs
      .filter(doc => {
        const parsed = MembershipSchema.safeParse(doc.data())
        return parsed.success && parsed.data.uid === doc.id
      })
      .map(doc => doc.id)
  } catch {
    throw new AppError('membership_data_error')
  }

  if (!activeAdminUids.includes(subjectUid)) return // subject isn't currently an active admin — nothing to protect
  const remainingAfterRemoval = activeAdminUids.filter(uid => uid !== subjectUid)
  if (remainingAfterRemoval.length === 0) throw new AppError('last_admin')
}
