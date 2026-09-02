import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import {
  generateRawInvitationToken,
  hashInvitationToken,
  buildPendingInvitationDocument,
} from '../../src/lib/invitationToken'
import { RawInvitationTokenSchema, TokenHashSchema, InvitationDocumentSchema } from '../../src/schemas/invitation'

describe('generateRawInvitationToken', () => {
  it('requests exactly 32 bytes from its entropy source (injected, deterministic — no flakiness)', () => {
    const requestedSizes: number[] = []
    const fixedBytes = Buffer.alloc(32, 7)
    const mockRandomBytes = (size: number): Buffer => {
      requestedSizes.push(size)
      return fixedBytes
    }
    const token = generateRawInvitationToken(mockRandomBytes)
    expect(requestedSizes).toEqual([32])
    expect(token).toBe(fixedBytes.toString('base64url'))
  })

  it('produces a token matching RawInvitationTokenSchema (base64url, exactly 43 chars) with the injected source', () => {
    const mockRandomBytes = (size: number): Buffer => Buffer.alloc(size, 1)
    const token = generateRawInvitationToken(mockRandomBytes)
    expect(token).toHaveLength(43)
    expect(RawInvitationTokenSchema.safeParse(token).success).toBe(true)
  })

  it('with the real (default) entropy source, two calls produce different tokens and both are schema-valid', () => {
    const first = generateRawInvitationToken()
    const second = generateRawInvitationToken()
    expect(first).not.toBe(second)
    expect(RawInvitationTokenSchema.safeParse(first).success).toBe(true)
    expect(RawInvitationTokenSchema.safeParse(second).success).toBe(true)
  })
})

describe('hashInvitationToken', () => {
  it('matches a plain SHA-256 hex digest of the raw token', () => {
    const raw = generateRawInvitationToken()
    const expected = createHash('sha256').update(raw, 'utf8').digest('hex')
    expect(hashInvitationToken(raw)).toBe(expected)
  })

  it('produces a value matching TokenHashSchema', () => {
    const raw = generateRawInvitationToken()
    expect(TokenHashSchema.safeParse(hashInvitationToken(raw)).success).toBe(true)
  })

  it('is deterministic — same input, same output', () => {
    const raw = generateRawInvitationToken()
    expect(hashInvitationToken(raw)).toBe(hashInvitationToken(raw))
  })

  it('different tokens hash to different values', () => {
    const a = generateRawInvitationToken()
    const b = generateRawInvitationToken()
    expect(hashInvitationToken(a)).not.toBe(hashInvitationToken(b))
  })
})

describe('buildPendingInvitationDocument', () => {
  const rawToken = generateRawInvitationToken()
  const tokenHash = hashInvitationToken(rawToken)
  const fields = {
    companyId: 'company_synthetic',
    emailNormalized: 'invitee@example.test',
    role: 'accountant' as const,
    tokenHash,
    expiresAt: Timestamp.now(),
    createdBy: 'uid_admin_synthetic',
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    lastSentAt: Timestamp.now(),
  }

  it('has no parameter for a raw token at all — the raw token cannot structurally appear in its output', () => {
    const doc = buildPendingInvitationDocument(fields)
    const serialized = JSON.stringify(doc)
    expect(serialized).not.toContain(rawToken)
    expect(Object.keys(doc)).not.toContain('token')
    expect(Object.keys(doc)).not.toContain('rawToken')
  })

  it('produces exactly the fields InvitationDocumentSchema expects for a pending invitation, and no more', () => {
    const doc = buildPendingInvitationDocument(fields)
    expect(doc).toEqual({
      companyId: fields.companyId,
      emailNormalized: fields.emailNormalized,
      role: fields.role,
      tokenHash,
      status: 'pending',
      expiresAt: fields.expiresAt,
      createdBy: fields.createdBy,
      createdAt: fields.createdAt,
      updatedAt: fields.updatedAt,
      resendCount: 0,
      lastSentAt: fields.lastSentAt,
    })
  })

  it('its output round-trips through the real InvitationDocumentSchema as a valid pending document', () => {
    const doc = buildPendingInvitationDocument(fields)
    const parsed = InvitationDocumentSchema.safeParse(doc)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.status).toBe('pending')
  })

  it('accepts a FieldValue server-timestamp sentinel for createdAt/updatedAt/lastSentAt (the actual production call shape) without throwing', () => {
    const serverNow = FieldValue.serverTimestamp()
    expect(() => buildPendingInvitationDocument({
      ...fields,
      createdAt: serverNow,
      updatedAt: serverNow,
      lastSentAt: serverNow,
    })).not.toThrow()
  })
})
