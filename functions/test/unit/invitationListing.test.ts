import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import {
  encodeInvitationsCursor,
  decodeInvitationsCursor,
  buildInvitationsCursor,
  mapInvitationDocumentToListItem,
} from '../../src/lib/invitationListing'
import { AppError } from '../../src/lib/errors'
import { INVITATIONS_CURSOR_VERSION, InvitationDocumentSchema, type InvitationDocument } from '../../src/schemas/invitation'

function expectInvalidRequest(fn: () => unknown): void {
  try {
    fn()
    expect.unreachable('expected AppError(invalid_request)')
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).appCode).toBe('invalid_request')
  }
}

describe('invitations cursor codec — encode/decode round-trip', () => {
  const payload = {
    version: INVITATIONS_CURSOR_VERSION,
    companyId: 'company_synthetic',
    createdAtSeconds: 1_700_000_123,
    createdAtNanoseconds: 987_654_321,
    inviteId: 'invite_synthetic',
  }

  it('round-trips a payload exactly', () => {
    const cursor = encodeInvitationsCursor(payload)
    expect(decodeInvitationsCursor(cursor)).toEqual(payload)
  })

  it('produces an opaque base64url string (no raw JSON visible)', () => {
    const cursor = encodeInvitationsCursor(payload)
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(cursor).not.toContain(payload.companyId)
    expect(cursor).not.toContain(payload.inviteId)
  })

  it('preserves seconds AND nanoseconds exactly — no bare-milliseconds precision loss', () => {
    // A nanosecond value that is NOT a multiple of 1_000_000 would be
    // silently rounded/truncated by any accidental "convert to millis"
    // step — round-tripping it exactly proves that never happens.
    const precise = { ...payload, createdAtNanoseconds: 123_456_789 }
    const decoded = decodeInvitationsCursor(encodeInvitationsCursor(precise))
    expect(decoded.createdAtSeconds).toBe(precise.createdAtSeconds)
    expect(decoded.createdAtNanoseconds).toBe(precise.createdAtNanoseconds)
  })

  it('buildInvitationsCursor derives the exact seconds/nanoseconds from a real Firestore Timestamp', () => {
    const ts = new Timestamp(1_700_000_500, 42)
    const cursor = buildInvitationsCursor('company_synthetic', ts, 'invite_synthetic')
    const decoded = decodeInvitationsCursor(cursor)
    expect(decoded).toEqual({
      version: INVITATIONS_CURSOR_VERSION,
      companyId: 'company_synthetic',
      createdAtSeconds: 1_700_000_500,
      createdAtNanoseconds: 42,
      inviteId: 'invite_synthetic',
    })
  })

  it('rejects malformed base64url (invalid character set)', () => {
    expectInvalidRequest(() => decodeInvitationsCursor('not base64url!!'))
  })

  it('rejects base64url that decodes to non-JSON', () => {
    const garbage = Buffer.from('this is not json', 'utf8').toString('base64url')
    expectInvalidRequest(() => decodeInvitationsCursor(garbage))
  })

  it('rejects a well-formed-JSON payload with the wrong shape/types', () => {
    const wrongShape = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url')
    expectInvalidRequest(() => decodeInvitationsCursor(wrongShape))
    const wrongTypes = Buffer.from(JSON.stringify({ ...payload, createdAtSeconds: 'not-a-number' }), 'utf8').toString('base64url')
    expectInvalidRequest(() => decodeInvitationsCursor(wrongTypes))
  })

  it('rejects an out-of-range value', () => {
    const outOfRange = Buffer.from(JSON.stringify({ ...payload, createdAtNanoseconds: -5 }), 'utf8').toString('base64url')
    expectInvalidRequest(() => decodeInvitationsCursor(outOfRange))
  })

  it('rejects an unsupported version', () => {
    const wrongVersion = Buffer.from(JSON.stringify({ ...payload, version: 999 }), 'utf8').toString('base64url')
    expectInvalidRequest(() => decodeInvitationsCursor(wrongVersion))
  })

  it('rejects an extra/unknown field (e.g. a smuggled email or tokenHash)', () => {
    const withEmail = Buffer.from(JSON.stringify({ ...payload, email: 'attacker@example.test' }), 'utf8').toString('base64url')
    expectInvalidRequest(() => decodeInvitationsCursor(withEmail))
    const withTokenHash = Buffer.from(JSON.stringify({ ...payload, tokenHash: '0'.repeat(64) }), 'utf8').toString('base64url')
    expectInvalidRequest(() => decodeInvitationsCursor(withTokenHash))
  })

  it('throws AppError (never a raw parse error/exception) for every malformed input above', () => {
    // Spot-check: none of the rejection paths above ever let a raw
    // SyntaxError/RangeError/TypeError escape — expectInvalidRequest()
    // already asserts this per-case, this test just documents the intent.
    expect(() => decodeInvitationsCursor('!!!')).toThrow(AppError)
  })
})

describe('mapInvitationDocumentToListItem — explicit whitelist, never a raw document spread', () => {
  const rawPendingDoc = {
    companyId: 'company_synthetic',
    emailNormalized: 'invitee@example.test',
    role: 'viewer' as const,
    tokenHash: '0'.repeat(64),
    status: 'pending' as const,
    expiresAt: Timestamp.now(),
    createdBy: 'uid_admin_synthetic',
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    resendCount: 2,
    lastSentAt: Timestamp.now(),
  }

  function parseDoc(raw: unknown): InvitationDocument {
    const parsed = InvitationDocumentSchema.safeParse(raw)
    if (!parsed.success) throw new Error('fixture does not match InvitationDocumentSchema')
    return parsed.data
  }

  it('never includes tokenHash, companyId, or any field beyond the explicit allowlist', () => {
    const doc = parseDoc(rawPendingDoc)
    const item = mapInvitationDocumentToListItem('invite_synthetic', doc)
    expect(Object.keys(item).sort()).toEqual([
      'createdAtUtc', 'createdBy', 'emailNormalized', 'expiresAtUtc',
      'inviteId', 'lastSentAtUtc', 'resendCount', 'role', 'status',
    ])
    expect(item).not.toHaveProperty('tokenHash')
    expect(item).not.toHaveProperty('companyId')
    expect(JSON.stringify(item)).not.toContain(rawPendingDoc.tokenHash)
  })

  it('maps createdAt/expiresAt/lastSentAt to real ISO strings via toISOString()', () => {
    const doc = parseDoc(rawPendingDoc)
    const item = mapInvitationDocumentToListItem('invite_synthetic', doc)
    expect(item.createdAtUtc).toBe(doc.createdAt.toDate().toISOString())
    expect(item.expiresAtUtc).toBe(doc.expiresAt.toDate().toISOString())
    expect(item.lastSentAtUtc).toBe(doc.lastSentAt!.toDate().toISOString())
  })

  it('maps a null lastSentAt to a null lastSentAtUtc (not a crash, not a string)', () => {
    const doc = parseDoc({ ...rawPendingDoc, lastSentAt: null })
    const item = mapInvitationDocumentToListItem('invite_synthetic', doc)
    expect(item.lastSentAtUtc).toBeNull()
  })

  it('correctly maps accepted/revoked documents too, without leaking acceptedByUid/revokedBy', () => {
    const acceptedDoc = parseDoc({
      ...rawPendingDoc, status: 'accepted' as const,
      acceptedAt: Timestamp.now(), acceptedByUid: 'uid_who_accepted',
    })
    const acceptedItem = mapInvitationDocumentToListItem('invite_accepted', acceptedDoc)
    expect(acceptedItem.status).toBe('accepted')
    expect(acceptedItem).not.toHaveProperty('acceptedByUid')

    const revokedDoc = parseDoc({
      ...rawPendingDoc, status: 'revoked' as const,
      revokedAt: Timestamp.now(), revokedBy: 'uid_who_revoked',
    })
    const revokedItem = mapInvitationDocumentToListItem('invite_revoked', revokedDoc)
    expect(revokedItem.status).toBe('revoked')
    expect(revokedItem).not.toHaveProperty('revokedBy')
  })

  it('the mapped item itself passes InvitationListItemSchema (consistency proof)', async () => {
    const { InvitationListItemSchema } = await import('../../src/schemas/invitation')
    const doc = parseDoc(rawPendingDoc)
    const item = mapInvitationDocumentToListItem('invite_synthetic', doc)
    expect(InvitationListItemSchema.safeParse(item).success).toBe(true)
  })
})
