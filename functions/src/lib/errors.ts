// Stable application error codes — SEC-003.
//
// `AppErrorCode` is the STABLE contract clients can branch on
// (`err.details.appCode`). The underlying `HttpsError` gRPC-style code is an
// implementation detail mapped below and may not be 1:1 (several app codes
// legitimately map to the same HttpsError code, e.g. every membership
// failure reads as `permission-denied` to the transport layer).
//
// Hard rule: nothing built here may ever carry an ID token, email, real
// uid/companyId, raw Firestore document content, a Zod issue message with a
// user-controlled value, or a stack trace. `AppError` has NO caller-facing
// `details`/metadata parameter at all (independent review finding #3,
// round 2 on SEC-003 PR #10) — the only thing `HttpsError.details` can
// ever contain is `{ appCode }`. If a specific error code genuinely needs
// extra client-facing data in the future, that requires introducing an
// explicit, per-error-code allowlist with its own runtime sanitization —
// not a general-purpose `Record<string, unknown>` bag.
import { HttpsError } from 'firebase-functions/v2/https'

export const APP_ERROR_CODES = [
  'auth_required',
  'email_unverified',
  'invalid_request',
  'membership_not_found',
  'membership_inactive',
  'membership_data_error',
  'insufficient_role',
  'last_admin',
  'idempotency_conflict',
  'internal_error',
] as const

export type AppErrorCode = (typeof APP_ERROR_CODES)[number]

// The subset of Firebase Functions HttpsError codes used here, spelled out
// locally so this file has no dependency on an internal/unexported type
// from firebase-functions.
type HttpsErrorCode =
  | 'unauthenticated'
  | 'permission-denied'
  | 'invalid-argument'
  | 'failed-precondition'
  | 'aborted'
  | 'internal'

const HTTPS_CODE_FOR: Record<AppErrorCode, HttpsErrorCode> = {
  auth_required: 'unauthenticated',
  email_unverified: 'permission-denied',
  invalid_request: 'invalid-argument',
  membership_not_found: 'permission-denied',
  membership_inactive: 'permission-denied',
  membership_data_error: 'permission-denied',
  insufficient_role: 'permission-denied',
  last_admin: 'failed-precondition',
  idempotency_conflict: 'aborted',
  internal_error: 'internal',
}

export class AppError extends Error {
  readonly appCode: AppErrorCode

  constructor(appCode: AppErrorCode) {
    // The Error `message` is intentionally just the stable code — never
    // anything derived from request/document content. There is
    // deliberately no second (details/metadata) constructor parameter —
    // see the module-level "Hard rule" comment above.
    super(appCode)
    this.name = 'AppError'
    this.appCode = appCode
  }

  toHttpsError(): HttpsError {
    // The ONLY thing this can ever return: `{ appCode }`. Since the
    // constructor accepts no other data, there is nothing else it could
    // contain — even a caller that bypasses the public TypeScript
    // signature via a cast on the class itself cannot smuggle extra
    // fields in, because this method never reads anything from `this`
    // except `appCode`.
    return new HttpsError(HTTPS_CODE_FOR[this.appCode], this.appCode, { appCode: this.appCode })
  }
}

/**
 * Converts anything thrown inside a callable handler into a safe HttpsError.
 * Only an AppError (which we fully control) is ever converted directly —
 * an arbitrary `HttpsError` is deliberately NOT passed through unchanged
 * (independent review finding #1a on SEC-003 PR #10): this code never
 * throws a raw HttpsError itself, so any HttpsError reaching here is
 * unexpected and could carry an attacker- or SDK-controlled
 * message/details (uid, email, token, raw document content). Anything that
 * isn't our own AppError — including a raw HttpsError, a Firestore SDK
 * error, a programming bug, or any other unexpected exception — is
 * collapsed to a generic `internal_error`; its original message/stack is
 * deliberately DROPPED rather than forwarded to the client.
 */
export function toSafeHttpsError(err: unknown): HttpsError {
  if (err instanceof AppError) return err.toHttpsError()
  return new AppError('internal_error').toHttpsError()
}
