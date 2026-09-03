import { describe, it, expect, vi } from 'vitest'
import { HttpsError } from 'firebase-functions/v2/https'
import { AppError, APP_ERROR_CODES, toSafeHttpsError, type AppErrorCode } from '../../src/lib/errors'

describe('AppError -> HttpsError mapping', () => {
  it.each([
    ['auth_required', 'unauthenticated'],
    ['email_unverified', 'permission-denied'],
    ['invalid_request', 'invalid-argument'],
    ['membership_not_found', 'permission-denied'],
    ['membership_inactive', 'permission-denied'],
    ['membership_data_error', 'permission-denied'],
    ['insufficient_role', 'permission-denied'],
    ['last_admin', 'failed-precondition'],
    ['idempotency_conflict', 'aborted'],
    ['maintenance_mode', 'failed-precondition'],
    ['invitation_already_pending', 'already-exists'],
    ['invitation_not_found', 'permission-denied'],
    ['invitation_not_pending', 'failed-precondition'],
    ['internal_error', 'internal'],
  ] as const)('%s maps to HttpsError code %s', (appCode, httpsCode) => {
    const httpsError = new AppError(appCode).toHttpsError()
    expect(httpsError).toBeInstanceOf(HttpsError)
    expect(httpsError.code).toBe(httpsCode)
  })

  it('every declared app error code has exactly one mapping (no silent gaps)', () => {
    for (const code of APP_ERROR_CODES) {
      expect(() => new AppError(code).toHttpsError()).not.toThrow()
    }
  })

  it('details always include the stable appCode', () => {
    const httpsError = new AppError('insufficient_role').toHttpsError()
    expect((httpsError.details as { appCode: string }).appCode).toBe('insufficient_role')
  })

  it('AppError.details can only ever be { appCode } — no arbitrary caller-supplied data can reach it, even via a cast that bypasses the public constructor signature (independent review finding #3, round 2)', () => {
    const secretValue = 'SECRET_APPERROR_DETAILS_LEAK_98765'
    // Simulates a caller bypassing the public (appCode-only) constructor
    // signature via a type cast on the class itself — the constructor
    // must structurally ignore any extra argument, not merely "not type
    // it" in the public API.
    const ForgedAppError = AppError as unknown as new (
      code: AppErrorCode,
      forged: Record<string, unknown>,
    ) => AppError
    const forged = new ForgedAppError('last_admin', { secret: secretValue, appCode: 'FORGED_OVERRIDE' })
    const httpsError = forged.toHttpsError()
    expect(httpsError.details).toEqual({ appCode: 'last_admin' })
    const serialized = JSON.stringify({ details: httpsError.details, message: httpsError.message })
    expect(serialized).not.toContain(secretValue)
    expect(serialized).not.toContain('FORGED_OVERRIDE')
  })
})

describe('toSafeHttpsError', () => {
  it('does NOT pass an arbitrary HttpsError through unchanged — sanitizes it like any other error (independent review finding #1a)', () => {
    const secretUid = 'uid_SECRET_LEAKED_98765'
    const secretEmail = 'secret-leaked@internal.example.test'
    const original = new HttpsError('permission-denied', `denied for uid ${secretUid} email ${secretEmail}`, {
      rawDocument: { uid: secretUid, email: secretEmail, idToken: 'SECRET_TOKEN_abc123' },
    })
    const result = toSafeHttpsError(original)
    expect(result).not.toBe(original)
    expect(result.code).toBe('internal')
    expect((result.details as { appCode: string }).appCode).toBe('internal_error')
    const serialized = JSON.stringify({ code: result.code, message: result.message, details: result.details })
    expect(serialized).not.toContain(secretUid)
    expect(serialized).not.toContain(secretEmail)
    expect(serialized).not.toContain('SECRET_TOKEN_abc123')
  })

  it('converts an AppError to its mapped HttpsError', () => {
    const result = toSafeHttpsError(new AppError('last_admin'))
    expect(result.code).toBe('failed-precondition')
  })

  it('converts the SEC-006 invitation_already_pending AppError safely (already-exists, appCode preserved)', () => {
    const result = toSafeHttpsError(new AppError('invitation_already_pending'))
    expect(result.code).toBe('already-exists')
    expect((result.details as { appCode: string }).appCode).toBe('invitation_already_pending')
  })

  it('converts the SEC-006 Stage 3 invitation_not_found/invitation_not_pending AppErrors safely', () => {
    const notFound = toSafeHttpsError(new AppError('invitation_not_found'))
    expect(notFound.code).toBe('permission-denied')
    expect((notFound.details as { appCode: string }).appCode).toBe('invitation_not_found')

    const notPending = toSafeHttpsError(new AppError('invitation_not_pending'))
    expect(notPending.code).toBe('failed-precondition')
    expect((notPending.details as { appCode: string }).appCode).toBe('invitation_not_pending')
  })

  it('collapses an unrecognized error into a generic internal_error — never forwards its message', () => {
    const secretMessage = 'SECRET_INTERNAL_DETAIL_leaked-uid-98765@internal.example.test'
    const result = toSafeHttpsError(new Error(secretMessage))
    expect(result.code).toBe('internal')
    expect(result.message).not.toContain(secretMessage)
    expect(JSON.stringify(result.details)).not.toContain(secretMessage)
  })

  it('collapses a non-Error thrown value (e.g. a raw string/object) the same way', () => {
    const secretValue = 'SECRET_RAW_THROW_leaked-token-11111'
    const result = toSafeHttpsError(secretValue)
    expect(result.code).toBe('internal')
    expect(JSON.stringify(result)).not.toContain(secretValue)
  })

  it('never logs secret-like values while converting errors', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const secretToken = 'SECRET_ID_TOKEN_abcdefghijklmnop'
    toSafeHttpsError(new Error(`token=${secretToken}`))
    toSafeHttpsError(new AppError('membership_data_error'))

    const allLogged = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
      .map(args => JSON.stringify(args))
      .join('\n')
    expect(allLogged).not.toContain(secretToken)

    errorSpy.mockRestore(); warnSpy.mockRestore(); logSpy.mockRestore()
  })
})
