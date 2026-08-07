import { describe, it, expect } from 'vitest'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { requireAuth, requireVerifiedEmail, requireRole, validateRequest, type RequestAuth } from '../../src/lib/authz'
import { AppError } from '../../src/lib/errors'
import { CompanyScopedRequestSchema, type Membership } from '../../src/schemas/auth'

function mockRequest(auth: RequestAuth | undefined, data: unknown = {}): CallableRequest<unknown> {
  return { data, auth } as unknown as CallableRequest<unknown>
}

const validMembership: Membership = {
  uid: 'uid_1',
  role: 'admin',
  status: 'active',
  // Membership timestamps are not exercised by requireRole — a minimal stand-in is fine here.
  createdAt: { seconds: 0, nanoseconds: 0 } as unknown as Membership['createdAt'],
  updatedAt: { seconds: 0, nanoseconds: 0 } as unknown as Membership['updatedAt'],
}

describe('requireAuth', () => {
  it('returns request.auth when present', () => {
    const auth: RequestAuth = { uid: 'uid_1', token: { email_verified: true } }
    expect(requireAuth(mockRequest(auth))).toBe(auth)
  })

  it('throws auth_required when request.auth is absent (unauthenticated call)', () => {
    expect(() => requireAuth(mockRequest(undefined))).toThrowError(
      expect.objectContaining({ appCode: 'auth_required' }),
    )
  })

  it('never consults a uid field inside the payload as identity', () => {
    // Attacker-controlled payload claims a different uid — requireAuth must
    // still throw (no auth) rather than trust request.data.uid.
    const request = mockRequest(undefined, { uid: 'uid_ATTACKER_SUPPLIED' })
    expect(() => requireAuth(request)).toThrow(AppError)
  })
})

describe('requireVerifiedEmail', () => {
  it('passes when token.email_verified === true', () => {
    expect(() => requireVerifiedEmail({ uid: 'uid_1', token: { email_verified: true } })).not.toThrow()
  })

  it('throws email_unverified when token.email_verified is false', () => {
    expect(() => requireVerifiedEmail({ uid: 'uid_1', token: { email_verified: false } })).toThrowError(
      expect.objectContaining({ appCode: 'email_unverified' }),
    )
  })

  it('throws email_unverified when token.email_verified is absent', () => {
    expect(() => requireVerifiedEmail({ uid: 'uid_1', token: {} })).toThrowError(
      expect.objectContaining({ appCode: 'email_unverified' }),
    )
  })
})

describe('requireRole', () => {
  it('passes when the membership role is in the allowlist', () => {
    expect(() => requireRole(validMembership, ['admin'])).not.toThrow()
  })

  it('throws insufficient_role when the role is not in the allowlist', () => {
    const viewer: Membership = { ...validMembership, role: 'viewer' }
    expect(() => requireRole(viewer, ['admin'])).toThrowError(
      expect.objectContaining({ appCode: 'insufficient_role' }),
    )
  })

  it('accountant does not pass an admin-only allowlist', () => {
    const accountant: Membership = { ...validMembership, role: 'accountant' }
    expect(() => requireRole(accountant, ['admin'])).toThrow(AppError)
  })

  it('an empty allowlist always rejects, regardless of role', () => {
    expect(() => requireRole(validMembership, [])).toThrow(AppError)
  })
})

describe('validateRequest', () => {
  it('returns the parsed value for valid input', () => {
    const result = validateRequest(CompanyScopedRequestSchema, { companyId: 'co_a' })
    expect(result).toEqual({ companyId: 'co_a' })
  })

  it('throws invalid_request for missing required fields', () => {
    expect(() => validateRequest(CompanyScopedRequestSchema, {})).toThrowError(
      expect.objectContaining({ appCode: 'invalid_request' }),
    )
  })

  it('throws invalid_request for extra/unexpected fields (strict schema)', () => {
    expect(() => validateRequest(CompanyScopedRequestSchema, { companyId: 'co_a', role: 'admin' })).toThrowError(
      expect.objectContaining({ appCode: 'invalid_request' }),
    )
  })

  it('throws invalid_request for a completely malformed payload (not an object)', () => {
    expect(() => validateRequest(CompanyScopedRequestSchema, 'not-an-object')).toThrow(AppError)
  })

  it('never leaks the offending value in the thrown error', () => {
    const secretValue = 'SECRET_PAYLOAD_VALUE_leaked-98765'
    try {
      validateRequest(CompanyScopedRequestSchema, { companyId: secretValue, extra: secretValue })
      expect.unreachable('validateRequest should have thrown for the extra field')
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain(secretValue)
      if (err instanceof AppError) {
        expect(err.appCode).toBe('invalid_request')
        expect(JSON.stringify(err.toHttpsError().details)).not.toContain(secretValue)
      }
    }
  })
})
