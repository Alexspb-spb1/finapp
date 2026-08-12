import { describe, it, expect } from 'vitest'
import { validateRequest } from '../../src/lib/authz'
import { AppError } from '../../src/lib/errors'
import { CreateCompanyRequestSchema, CreateCompanyResponseSchema } from '../../src/schemas/company'

const validPayload = {
  idempotencyKey: 'a'.repeat(36),
  ownerName: 'Иван Иванов',
  companyName: 'Моя Компания',
  legalType: 'ooo' as const,
}

describe('CreateCompanyRequestSchema', () => {
  it('accepts a minimal valid payload without inn', () => {
    expect(() => validateRequest(CreateCompanyRequestSchema, validPayload)).not.toThrow()
  })

  it('accepts a valid ooo payload with a 10-digit inn', () => {
    expect(() => validateRequest(CreateCompanyRequestSchema, { ...validPayload, inn: '7701234567' })).not.toThrow()
  })

  it('accepts a valid ip payload with a 12-digit inn', () => {
    expect(() =>
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, legalType: 'ip', inn: '770112345678' }),
    ).not.toThrow()
  })

  it('trims ownerName/companyName and rejects a whitespace-only owner name', () => {
    expect(() => validateRequest(CreateCompanyRequestSchema, { ...validPayload, ownerName: '   ' })).toThrowError(
      expect.objectContaining({ appCode: 'invalid_request' }),
    )
  })

  it('rejects a whitespace-only company name', () => {
    expect(() => validateRequest(CreateCompanyRequestSchema, { ...validPayload, companyName: '  \t ' })).toThrowError(
      expect.objectContaining({ appCode: 'invalid_request' }),
    )
  })

  it('rejects an empty owner name', () => {
    expect(() => validateRequest(CreateCompanyRequestSchema, { ...validPayload, ownerName: '' })).toThrowError(
      expect.objectContaining({ appCode: 'invalid_request' }),
    )
  })

  it('rejects an empty company name', () => {
    expect(() => validateRequest(CreateCompanyRequestSchema, { ...validPayload, companyName: '' })).toThrowError(
      expect.objectContaining({ appCode: 'invalid_request' }),
    )
  })

  it('rejects an invalid legalType', () => {
    expect(() =>
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, legalType: 'llc' }),
    ).toThrowError(expect.objectContaining({ appCode: 'invalid_request' }))
  })

  it('rejects a 12-digit inn for an ooo (must be exactly 10 digits)', () => {
    expect(() =>
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, inn: '770123456789' }),
    ).toThrowError(expect.objectContaining({ appCode: 'invalid_request' }))
  })

  it('rejects a 10-digit inn for an ip (must be exactly 12 digits)', () => {
    expect(() =>
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, legalType: 'ip', inn: '7701234567' }),
    ).toThrowError(expect.objectContaining({ appCode: 'invalid_request' }))
  })

  it('rejects a non-numeric inn', () => {
    expect(() =>
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, inn: 'abcdefghij' }),
    ).toThrowError(expect.objectContaining({ appCode: 'invalid_request' }))
  })

  it('rejects a missing idempotencyKey', () => {
    const { idempotencyKey: _drop, ...rest } = validPayload
    expect(() => validateRequest(CreateCompanyRequestSchema, rest)).toThrowError(
      expect.objectContaining({ appCode: 'invalid_request' }),
    )
  })

  it('rejects an extra "uid" field — payload-supplied identity is never accepted', () => {
    expect(() =>
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, uid: 'uid_attacker' }),
    ).toThrowError(expect.objectContaining({ appCode: 'invalid_request' }))
  })

  it('rejects an extra "ownerUid" field', () => {
    expect(() =>
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, ownerUid: 'uid_attacker' }),
    ).toThrowError(expect.objectContaining({ appCode: 'invalid_request' }))
  })

  it('rejects an extra "role" field', () => {
    expect(() =>
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, role: 'admin' }),
    ).toThrowError(expect.objectContaining({ appCode: 'invalid_request' }))
  })

  it('rejects an extra "companyId" field — the company id is always server-generated', () => {
    expect(() =>
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, companyId: 'co_client_supplied' }),
    ).toThrowError(expect.objectContaining({ appCode: 'invalid_request' }))
  })

  it('rejects extra createdAt/currency fields', () => {
    expect(() =>
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, createdAt: '2026-01-01', currency: 'USD' }),
    ).toThrowError(expect.objectContaining({ appCode: 'invalid_request' }))
  })

  it('never leaks the offending value in the thrown error', () => {
    const secretValue = 'SECRET_INN_leaked-98765'
    try {
      validateRequest(CreateCompanyRequestSchema, { ...validPayload, inn: secretValue })
      expect.unreachable('expected validateRequest to throw for an invalid inn')
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain(secretValue)
      if (err instanceof AppError) {
        expect(JSON.stringify(err.toHttpsError().details)).not.toContain(secretValue)
      }
    }
  })
})

describe('CreateCompanyResponseSchema', () => {
  it('accepts a minimal { companyId } response', () => {
    expect(() => CreateCompanyResponseSchema.parse({ companyId: 'abc123' })).not.toThrow()
  })

  it('rejects a response missing companyId', () => {
    expect(CreateCompanyResponseSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a response leaking extra fields (email/role/inn/raw documents)', () => {
    const result = CreateCompanyResponseSchema.safeParse({
      companyId: 'abc123',
      email: 'owner@example.test',
      role: 'admin',
      inn: '7701234567',
    })
    expect(result.success).toBe(false)
  })
})
