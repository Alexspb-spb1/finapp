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
// user-controlled value, or a stack trace. `details` only ever holds the
// stable `appCode` plus safe, enumerable metadata (e.g. a field NAME, never
// a field VALUE).
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

// Safe metadata only — field NAMES/counts/enum-like tags, never a value
// pulled from a request, a Firestore document, or an exception message.
export type AppErrorDetails = Record<string, string | number | boolean>

export class AppError extends Error {
  readonly appCode: AppErrorCode
  readonly details: AppErrorDetails

  constructor(appCode: AppErrorCode, details: AppErrorDetails = {}) {
    // The Error `message` is intentionally just the stable code — never
    // anything derived from request/document content.
    super(appCode)
    this.name = 'AppError'
    this.appCode = appCode
    this.details = details
  }

  toHttpsError(): HttpsError {
    return new HttpsError(HTTPS_CODE_FOR[this.appCode], this.appCode, {
      appCode: this.appCode,
      ...this.details,
    })
  }
}

/**
 * Converts anything thrown inside a callable handler into a safe HttpsError.
 * An already-safe AppError/HttpsError is passed through (re-wrapped for
 * HttpsError, unchanged for AppError). Anything else (a raw Firestore SDK
 * error, a programming bug, an unexpected exception) is collapsed to a
 * generic `internal_error` — its original message/stack is deliberately
 * DROPPED rather than forwarded to the client, since it could contain
 * document paths, field values, or other internal details.
 */
export function toSafeHttpsError(err: unknown): HttpsError {
  if (err instanceof HttpsError) return err
  if (err instanceof AppError) return err.toHttpsError()
  return new AppError('internal_error').toHttpsError()
}
