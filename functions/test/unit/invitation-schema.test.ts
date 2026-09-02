import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Timestamp } from 'firebase-admin/firestore'
import { validateRequest } from '../../src/lib/authz'
import { AppError } from '../../src/lib/errors'
import {
  INVITATION_TTL_MS,
  INVITATION_RESEND_COOLDOWN_MS,
  INVITATION_RESEND_LIMIT,
  InvitationStatusSchema,
  isInvitationExpired,
  NormalizedEmailSchema,
  RawInvitationTokenSchema,
  TokenHashSchema,
  InvitationDocumentSchema,
  InvitationLockDocumentSchema,
  computeInvitationLockId,
  InviteMemberRequestSchema,
  ListInvitationsRequestSchema,
  CancelInviteRequestSchema,
  ResendInviteRequestSchema,
  PreviewInviteRequestSchema,
  AcceptInviteRequestSchema,
} from '../../src/schemas/invitation'

const VALID_RAW_TOKEN = 'a'.repeat(43) // base64url charset, 43 chars
const VALID_TOKEN_HASH = '0'.repeat(64) // hex, 64 chars
const now = () => Timestamp.now()

function invalidRequestExpectation() {
  return expect.objectContaining({ appCode: 'invalid_request' })
}

// ── Canonical constants (approved owner defaults) ────────────────────────
describe('approved SEC-006 constants', () => {
  it('TTL is exactly 7 days', () => {
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
  it('resend cooldown is exactly 60 seconds', () => {
    expect(INVITATION_RESEND_COOLDOWN_MS).toBe(60 * 1000)
  })
  it('resend limit is exactly 5', () => {
    expect(INVITATION_RESEND_LIMIT).toBe(5)
  })
})

// ── InvitationStatus ──────────────────────────────────────────────────────
describe('InvitationStatusSchema', () => {
  it('accepts pending/accepted/revoked', () => {
    for (const s of ['pending', 'accepted', 'revoked']) {
      expect(InvitationStatusSchema.safeParse(s).success).toBe(true)
    }
  })
  it('rejects "expired" — it is a computed condition, never a stored status', () => {
    expect(InvitationStatusSchema.safeParse('expired').success).toBe(false)
  })
  it('rejects any other unknown status value', () => {
    expect(InvitationStatusSchema.safeParse('invited').success).toBe(false)
    expect(InvitationStatusSchema.safeParse('').success).toBe(false)
  })
})

describe('isInvitationExpired', () => {
  it('is true only for pending + past expiresAt', () => {
    const past = new Date('2026-01-01T00:00:00.000Z')
    const future = new Date('2026-12-31T00:00:00.000Z')
    const nowDate = new Date('2026-06-01T00:00:00.000Z')
    expect(isInvitationExpired('pending', past, nowDate)).toBe(true)
    expect(isInvitationExpired('pending', future, nowDate)).toBe(false)
  })
  it('is false for accepted/revoked regardless of expiresAt', () => {
    const past = new Date('2026-01-01T00:00:00.000Z')
    const nowDate = new Date('2026-06-01T00:00:00.000Z')
    expect(isInvitationExpired('accepted', past, nowDate)).toBe(false)
    expect(isInvitationExpired('revoked', past, nowDate)).toBe(false)
  })
  it('is true exactly at the boundary (now === expiresAt)', () => {
    const boundary = new Date('2026-06-01T00:00:00.000Z')
    expect(isInvitationExpired('pending', boundary, boundary)).toBe(true)
  })
})

// ── Email normalization ───────────────────────────────────────────────────
describe('NormalizedEmailSchema', () => {
  it('trims and lowercases a valid email', () => {
    const result = NormalizedEmailSchema.safeParse('  Test@Example.COM  ')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe('test@example.com')
  })
  it('rejects an empty string', () => {
    expect(NormalizedEmailSchema.safeParse('').success).toBe(false)
  })
  it('rejects a whitespace-only string', () => {
    expect(NormalizedEmailSchema.safeParse('   ').success).toBe(false)
  })
  it('rejects a malformed email', () => {
    expect(NormalizedEmailSchema.safeParse('not-an-email').success).toBe(false)
    expect(NormalizedEmailSchema.safeParse('missing-domain@').success).toBe(false)
    expect(NormalizedEmailSchema.safeParse('@missing-local.com').success).toBe(false)
  })
})

// ── Raw token / tokenHash ─────────────────────────────────────────────────
describe('RawInvitationTokenSchema', () => {
  it('accepts a valid 43-character base64url token', () => {
    expect(RawInvitationTokenSchema.safeParse(VALID_RAW_TOKEN).success).toBe(true)
    // A second, mixed-charset example — generated and length-verified
    // programmatically (not hand-typed/eyeballed) to avoid a miscounted
    // literal silently making this assertion vacuous.
    const mixedCharsetToken = randomBytes(32).toString('base64url')
    expect(mixedCharsetToken).toHaveLength(43)
    expect(RawInvitationTokenSchema.safeParse(mixedCharsetToken).success).toBe(true)
  })
  it('rejects a token shorter than 43 characters', () => {
    expect(RawInvitationTokenSchema.safeParse('a'.repeat(42)).success).toBe(false)
  })
  it('rejects a token longer than 43 characters', () => {
    expect(RawInvitationTokenSchema.safeParse('a'.repeat(44)).success).toBe(false)
  })
  it('rejects padding characters ("=")', () => {
    expect(RawInvitationTokenSchema.safeParse('a'.repeat(42) + '=').success).toBe(false)
  })
  it('rejects standard-base64 characters not in base64url ("+"/"/")', () => {
    expect(RawInvitationTokenSchema.safeParse('+'.repeat(43)).success).toBe(false)
    expect(RawInvitationTokenSchema.safeParse('/'.repeat(43)).success).toBe(false)
  })
  it('rejects an empty string', () => {
    expect(RawInvitationTokenSchema.safeParse('').success).toBe(false)
  })
})

describe('TokenHashSchema', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(TokenHashSchema.safeParse(VALID_TOKEN_HASH).success).toBe(true)
    expect(TokenHashSchema.safeParse('0123456789abcdef'.repeat(4)).success).toBe(true)
  })
  it('rejects uppercase hex', () => {
    expect(TokenHashSchema.safeParse('A'.repeat(64)).success).toBe(false)
  })
  it('rejects a hash shorter than 64 characters', () => {
    expect(TokenHashSchema.safeParse('0'.repeat(63)).success).toBe(false)
  })
  it('rejects a hash longer than 64 characters', () => {
    expect(TokenHashSchema.safeParse('0'.repeat(65)).success).toBe(false)
  })
  it('rejects non-hex characters', () => {
    expect(TokenHashSchema.safeParse('g'.repeat(64)).success).toBe(false)
  })
})

// ── Firestore document model: invitations/{inviteId} ────────────────────
describe('InvitationDocumentSchema — status-dependent invariants', () => {
  const base = {
    companyId: 'company_synthetic',
    emailNormalized: 'invitee@example.test',
    role: 'viewer' as const,
    tokenHash: VALID_TOKEN_HASH,
    expiresAt: now(),
    createdBy: 'uid_admin_synthetic',
    createdAt: now(),
    updatedAt: now(),
    resendCount: 0,
    lastSentAt: null,
  }

  it.each(['viewer', 'accountant', 'admin'] as const)('accepts every canonical role (%s) for a pending invitation', role => {
    expect(InvitationDocumentSchema.safeParse({ ...base, role, status: 'pending' }).success).toBe(true)
  })

  it('rejects a non-canonical role', () => {
    expect(InvitationDocumentSchema.safeParse({ ...base, status: 'pending', role: 'superadmin' }).success).toBe(false)
  })

  it('accepts a well-formed pending invitation', () => {
    expect(InvitationDocumentSchema.safeParse({ ...base, status: 'pending' }).success).toBe(true)
  })

  it('accepts a well-formed accepted invitation (with acceptedAt/acceptedByUid, no revoked fields)', () => {
    const result = InvitationDocumentSchema.safeParse({
      ...base, status: 'accepted', acceptedAt: now(), acceptedByUid: 'uid_invitee_synthetic',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a well-formed revoked invitation (with revokedAt/revokedBy, no accepted fields)', () => {
    const result = InvitationDocumentSchema.safeParse({
      ...base, status: 'revoked', revokedAt: now(), revokedBy: 'uid_admin_synthetic',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a pending invitation carrying accepted-audit fields (acceptedAt/acceptedByUid)', () => {
    const result = InvitationDocumentSchema.safeParse({
      ...base, status: 'pending', acceptedAt: now(), acceptedByUid: 'uid_invitee_synthetic',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a pending invitation carrying revoked-audit fields (revokedAt/revokedBy)', () => {
    const result = InvitationDocumentSchema.safeParse({
      ...base, status: 'pending', revokedAt: now(), revokedBy: 'uid_admin_synthetic',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an accepted invitation missing acceptedAt', () => {
    const result = InvitationDocumentSchema.safeParse({ ...base, status: 'accepted', acceptedByUid: 'uid_invitee_synthetic' })
    expect(result.success).toBe(false)
  })

  it('rejects an accepted invitation missing acceptedByUid', () => {
    const result = InvitationDocumentSchema.safeParse({ ...base, status: 'accepted', acceptedAt: now() })
    expect(result.success).toBe(false)
  })

  it('rejects an accepted invitation carrying revoked-audit fields (revokedAt/revokedBy present)', () => {
    const result = InvitationDocumentSchema.safeParse({
      ...base, status: 'accepted', acceptedAt: now(), acceptedByUid: 'uid_invitee_synthetic',
      revokedAt: now(), revokedBy: 'uid_admin_synthetic',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a revoked invitation missing revokedAt', () => {
    const result = InvitationDocumentSchema.safeParse({ ...base, status: 'revoked', revokedBy: 'uid_admin_synthetic' })
    expect(result.success).toBe(false)
  })

  it('rejects a revoked invitation missing revokedBy', () => {
    const result = InvitationDocumentSchema.safeParse({ ...base, status: 'revoked', revokedAt: now() })
    expect(result.success).toBe(false)
  })

  it('rejects a revoked invitation carrying accepted-audit fields (acceptedAt/acceptedByUid present)', () => {
    const result = InvitationDocumentSchema.safeParse({
      ...base, status: 'revoked', revokedAt: now(), revokedBy: 'uid_admin_synthetic',
      acceptedAt: now(), acceptedByUid: 'uid_invitee_synthetic',
    })
    expect(result.success).toBe(false)
  })

  it('never has a "rawToken"/"token" field in the schema — an extra field with that name is rejected outright', () => {
    const result = InvitationDocumentSchema.safeParse({ ...base, status: 'pending', rawToken: 'a'.repeat(43) })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown top-level field on an otherwise-valid pending document (.strict())', () => {
    const result = InvitationDocumentSchema.safeParse({ ...base, status: 'pending', unexpectedField: 'x' })
    expect(result.success).toBe(false)
  })

  it('rejects resendCount above the approved limit', () => {
    const result = InvitationDocumentSchema.safeParse({ ...base, status: 'pending', resendCount: INVITATION_RESEND_LIMIT + 1 })
    expect(result.success).toBe(false)
  })

  it('rejects a negative resendCount', () => {
    const result = InvitationDocumentSchema.safeParse({ ...base, status: 'pending', resendCount: -1 })
    expect(result.success).toBe(false)
  })

  it('accepts resendCount at the approved limit', () => {
    const result = InvitationDocumentSchema.safeParse({ ...base, status: 'pending', resendCount: INVITATION_RESEND_LIMIT })
    expect(result.success).toBe(true)
  })

  it('rejects a malformed tokenHash even on an otherwise-valid document', () => {
    const result = InvitationDocumentSchema.safeParse({ ...base, status: 'pending', tokenHash: 'not-a-hash' })
    expect(result.success).toBe(false)
  })
})

// ── Firestore document model: invitationLocks/{lockId} ──────────────────
describe('InvitationLockDocumentSchema', () => {
  it('accepts a minimal valid lock document', () => {
    expect(InvitationLockDocumentSchema.safeParse({ currentInviteId: 'invite_synthetic' }).success).toBe(true)
  })
  it('rejects an empty currentInviteId', () => {
    expect(InvitationLockDocumentSchema.safeParse({ currentInviteId: '' }).success).toBe(false)
  })
  it('rejects any extra field (.strict())', () => {
    expect(InvitationLockDocumentSchema.safeParse({ currentInviteId: 'invite_synthetic', emailNormalized: 'x@y.test' }).success).toBe(false)
  })
})

describe('computeInvitationLockId', () => {
  it('is deterministic for the same (companyId, emailNormalized) pair', () => {
    const a = computeInvitationLockId('company_synthetic', 'invitee@example.test')
    const b = computeInvitationLockId('company_synthetic', 'invitee@example.test')
    expect(a).toBe(b)
  })
  it('is a 64-character lowercase hex string (matches TokenHashSchema-shaped output)', () => {
    const id = computeInvitationLockId('company_synthetic', 'invitee@example.test')
    expect(TokenHashSchema.safeParse(id).success).toBe(true)
  })
  it('differs for different companyId with the same email (no cross-company collision)', () => {
    const a = computeInvitationLockId('company_a', 'invitee@example.test')
    const b = computeInvitationLockId('company_b', 'invitee@example.test')
    expect(a).not.toBe(b)
  })
  it('differs for different email with the same companyId', () => {
    const a = computeInvitationLockId('company_synthetic', 'one@example.test')
    const b = computeInvitationLockId('company_synthetic', 'two@example.test')
    expect(a).not.toBe(b)
  })
  it('never embeds the raw email in the output (no boundary-shifting collision either)', () => {
    // The concatenation-boundary collision this JSON.stringify-array approach
    // specifically prevents (mirrors idempotency.ts's own documented case).
    const a = computeInvitationLockId('company', 'a:b@example.test')
    const b = computeInvitationLockId('company:a', 'b@example.test')
    expect(a).not.toBe(b)
    expect(a).not.toContain('invitee')
    expect(a).not.toContain('@example.test')
  })
})

// ── Callable request schemas ──────────────────────────────────────────────
describe('InviteMemberRequestSchema', () => {
  const valid = { companyId: 'company_synthetic', email: 'invitee@example.test', role: 'viewer' as const }

  it('accepts a valid payload and normalizes email', () => {
    const result = InviteMemberRequestSchema.safeParse({ ...valid, email: '  Invitee@Example.TEST  ' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.email).toBe('invitee@example.test')
  })

  it.each(['viewer', 'accountant', 'admin'] as const)('accepts canonical role %s', role => {
    expect(() => validateRequest(InviteMemberRequestSchema, { ...valid, role })).not.toThrow()
  })

  it('rejects a non-canonical role', () => {
    expect(() => validateRequest(InviteMemberRequestSchema, { ...valid, role: 'superadmin' })).toThrowError(invalidRequestExpectation())
  })

  it('rejects an invalid email', () => {
    expect(() => validateRequest(InviteMemberRequestSchema, { ...valid, email: 'not-an-email' })).toThrowError(invalidRequestExpectation())
  })

  it('rejects an unknown field', () => {
    expect(() => validateRequest(InviteMemberRequestSchema, { ...valid, actorUid: 'uid_attacker' })).toThrowError(invalidRequestExpectation())
  })

  it('rejects a missing companyId', () => {
    const { companyId: _companyId, ...withoutCompanyId } = valid
    expect(() => validateRequest(InviteMemberRequestSchema, withoutCompanyId)).toThrowError(invalidRequestExpectation())
  })

  it('rejects an empty companyId', () => {
    expect(() => validateRequest(InviteMemberRequestSchema, { ...valid, companyId: '' })).toThrowError(invalidRequestExpectation())
  })

  it('rejects an overlong companyId', () => {
    expect(() => validateRequest(InviteMemberRequestSchema, { ...valid, companyId: 'a'.repeat(201) })).toThrowError(invalidRequestExpectation())
  })
})

describe('ListInvitationsRequestSchema', () => {
  it('accepts companyId alone and defaults pageSize to 20', () => {
    const result = validateRequest(ListInvitationsRequestSchema, { companyId: 'company_synthetic' })
    expect(result.pageSize).toBe(20)
  })

  it('accepts an explicit valid pageSize', () => {
    const result = validateRequest(ListInvitationsRequestSchema, { companyId: 'company_synthetic', pageSize: 50 })
    expect(result.pageSize).toBe(50)
  })

  it('rejects pageSize 0', () => {
    expect(() => validateRequest(ListInvitationsRequestSchema, { companyId: 'company_synthetic', pageSize: 0 })).toThrowError(invalidRequestExpectation())
  })

  it('rejects pageSize above 50', () => {
    expect(() => validateRequest(ListInvitationsRequestSchema, { companyId: 'company_synthetic', pageSize: 51 })).toThrowError(invalidRequestExpectation())
  })

  it('rejects a non-integer pageSize', () => {
    expect(() => validateRequest(ListInvitationsRequestSchema, { companyId: 'company_synthetic', pageSize: 20.5 })).toThrowError(invalidRequestExpectation())
  })

  it('rejects an unknown field', () => {
    expect(() => validateRequest(ListInvitationsRequestSchema, { companyId: 'company_synthetic', status: 'pending' })).toThrowError(invalidRequestExpectation())
  })

  it('accepts a valid cursor', () => {
    expect(() => validateRequest(ListInvitationsRequestSchema, { companyId: 'company_synthetic', cursor: 'opaque_cursor_value' })).not.toThrow()
  })

  it('rejects an overlong cursor', () => {
    expect(() => validateRequest(ListInvitationsRequestSchema, { companyId: 'company_synthetic', cursor: 'a'.repeat(501) })).toThrowError(invalidRequestExpectation())
  })
})

describe('CancelInviteRequestSchema / ResendInviteRequestSchema — no status/email/role/actor uid accepted', () => {
  const valid = { companyId: 'company_synthetic', inviteId: 'invite_synthetic' }

  for (const [name, schema] of [
    ['CancelInviteRequestSchema', CancelInviteRequestSchema],
    ['ResendInviteRequestSchema', ResendInviteRequestSchema],
  ] as const) {
    it(`${name}: accepts companyId+inviteId only`, () => {
      expect(() => validateRequest(schema, valid)).not.toThrow()
    })
    it(`${name}: rejects a status field`, () => {
      expect(() => validateRequest(schema, { ...valid, status: 'revoked' })).toThrowError(invalidRequestExpectation())
    })
    it(`${name}: rejects an email field`, () => {
      expect(() => validateRequest(schema, { ...valid, email: 'attacker@example.test' })).toThrowError(invalidRequestExpectation())
    })
    it(`${name}: rejects a role field`, () => {
      expect(() => validateRequest(schema, { ...valid, role: 'admin' })).toThrowError(invalidRequestExpectation())
    })
    it(`${name}: rejects an actor/subject uid field`, () => {
      expect(() => validateRequest(schema, { ...valid, actorUid: 'uid_attacker' })).toThrowError(invalidRequestExpectation())
      expect(() => validateRequest(schema, { ...valid, uid: 'uid_attacker' })).toThrowError(invalidRequestExpectation())
    })
  }
})

describe('PreviewInviteRequestSchema — pre-auth, minimal surface', () => {
  const valid = { inviteId: 'invite_synthetic', token: VALID_RAW_TOKEN }

  it('accepts inviteId + valid raw token', () => {
    expect(() => validateRequest(PreviewInviteRequestSchema, valid)).not.toThrow()
  })
  it('rejects a malformed token', () => {
    expect(() => validateRequest(PreviewInviteRequestSchema, { ...valid, token: 'short' })).toThrowError(invalidRequestExpectation())
  })
  it('rejects any field beyond inviteId/token', () => {
    expect(() => validateRequest(PreviewInviteRequestSchema, { ...valid, companyId: 'company_synthetic' })).toThrowError(invalidRequestExpectation())
    expect(() => validateRequest(PreviewInviteRequestSchema, { ...valid, email: 'x@y.test' })).toThrowError(invalidRequestExpectation())
  })
})

describe('AcceptInviteRequestSchema — never accepts role/companyId/email/uid', () => {
  const valid = { inviteId: 'invite_synthetic', token: VALID_RAW_TOKEN }

  it('accepts inviteId + valid raw token only', () => {
    expect(() => validateRequest(AcceptInviteRequestSchema, valid)).not.toThrow()
  })
  it('rejects a role field', () => {
    expect(() => validateRequest(AcceptInviteRequestSchema, { ...valid, role: 'admin' })).toThrowError(invalidRequestExpectation())
  })
  it('rejects a companyId field', () => {
    expect(() => validateRequest(AcceptInviteRequestSchema, { ...valid, companyId: 'company_synthetic' })).toThrowError(invalidRequestExpectation())
  })
  it('rejects an email field', () => {
    expect(() => validateRequest(AcceptInviteRequestSchema, { ...valid, email: 'attacker@example.test' })).toThrowError(invalidRequestExpectation())
  })
  it('rejects a uid field', () => {
    expect(() => validateRequest(AcceptInviteRequestSchema, { ...valid, uid: 'uid_attacker' })).toThrowError(invalidRequestExpectation())
  })
  it('rejects a malformed (wrong-length) token', () => {
    expect(() => validateRequest(AcceptInviteRequestSchema, { ...valid, token: 'a'.repeat(50) })).toThrowError(invalidRequestExpectation())
  })
})

// Sanity: AppError itself carries only appCode, matching the existing
// contract every other schema test in this package already relies on.
describe('validateRequest error contract (sanity, matches existing convention)', () => {
  it('throws AppError, not a raw ZodError, on any invalid payload above', () => {
    try {
      validateRequest(InviteMemberRequestSchema, {})
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
    }
  })
})
