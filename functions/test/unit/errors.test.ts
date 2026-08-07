import { describe, it, expect, vi } from 'vitest'
import { HttpsError } from 'firebase-functions/v2/https'
import { AppError, APP_ERROR_CODES, toSafeHttpsError } from '../../src/lib/errors'

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
})

describe('toSafeHttpsError', () => {
  it('passes an existing HttpsError through unchanged', () => {
    const original = new HttpsError('not-found', 'not_found')
    expect(toSafeHttpsError(original)).toBe(original)
  })

  it('converts an AppError to its mapped HttpsError', () => {
    const result = toSafeHttpsError(new AppError('last_admin'))
    expect(result.code).toBe('failed-precondition')
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
    toSafeHttpsError(new AppError('membership_data_error', { fieldCount: 3 }))

    const allLogged = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
      .map(args => JSON.stringify(args))
      .join('\n')
    expect(allLogged).not.toContain(secretToken)

    errorSpy.mockRestore(); warnSpy.mockRestore(); logSpy.mockRestore()
  })
})
