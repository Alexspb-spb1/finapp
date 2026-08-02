import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import {
  CompanySchema,
  CreateCompanyRequestSchema,
  CreateCompanyResponseSchema,
  parseCompanyDocument,
} from './company'

const validCompany = {
  id: 'co_a',
  name: 'ООО Ромашка',
  legalType: 'ooo' as const,
  currency: 'RUB',
  createdAt: '2026-01-01T00:00:00.000Z',
  ownerId: 'uid_owner',
}

const validMembership = {
  uid: 'uid_owner',
  role: 'admin' as const,
  status: 'active' as const,
  createdAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z')),
  updatedAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z')),
}

describe('CompanySchema', () => {
  it('accepts a valid company', () => {
    expect(CompanySchema.safeParse(validCompany).success).toBe(true)
  })

  it.each(['ownerId', 'id', 'name', 'currency', 'createdAt'] as const)(
    'rejects a company missing %s',
    field => {
      const broken = { ...validCompany } as Record<string, unknown>
      delete broken[field]
      expect(CompanySchema.safeParse(broken).success).toBe(false)
    },
  )

  it('rejects an unknown legalType', () => {
    expect(CompanySchema.safeParse({ ...validCompany, legalType: 'llc' }).success).toBe(false)
  })

  it('rejects a malformed createdAt date', () => {
    expect(CompanySchema.safeParse({ ...validCompany, createdAt: 'not-a-date' }).success).toBe(false)
  })

  it('rejects empty required strings', () => {
    expect(CompanySchema.safeParse({ ...validCompany, name: '' }).success).toBe(false)
    expect(CompanySchema.safeParse({ ...validCompany, ownerId: '' }).success).toBe(false)
  })

  it('rejects unknown extra fields', () => {
    expect(CompanySchema.safeParse({ ...validCompany, role: 'admin' }).success).toBe(false)
    expect(CompanySchema.safeParse({ ...validCompany, isAdmin: true }).success).toBe(false)
  })

  it('ownerId is validated as a plain string reference, never turned into a role/admin field', () => {
    const result = CompanySchema.safeParse(validCompany)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(
        ['createdAt', 'currency', 'id', 'legalType', 'name', 'ownerId'].sort(),
      )
      expect('role' in result.data).toBe(false)
      expect('isAdmin' in result.data).toBe(false)
    }
  })

  it('accepts an optional inn', () => {
    expect(CompanySchema.safeParse({ ...validCompany, inn: '1234567890' }).success).toBe(true)
  })
})

describe('CompanySchema.createdAt — strict ISO-8601 datetime (independent review finding #2)', () => {
  it('accepts a full ISO-8601 datetime with milliseconds and Z', () => {
    const result = CompanySchema.safeParse({ ...validCompany, createdAt: '2026-01-02T03:04:05.000Z' })
    expect(result.success).toBe(true)
  })

  it.each([
    ['date-only, no time', '2026-01-02'],
    ['US-style slash date', '01/02/2026'],
    ['long-form English date', 'January 1, 2026'],
    ['calendar-invalid day (Feb 30)', '2026-02-30T03:04:05.000Z'],
    ['not a date at all', 'not-a-date'],
    ['empty string', ''],
  ])('rejects %s (%s)', (_label, value) => {
    const result = CompanySchema.safeParse({ ...validCompany, createdAt: value })
    expect(result.success).toBe(false)
  })

  it('does not mutate the original input object', () => {
    const input = { ...validCompany }
    const snapshot = JSON.stringify(input)
    CompanySchema.safeParse(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('accepts a valid ISO offset (non-Z) timezone', () => {
    const result = CompanySchema.safeParse({ ...validCompany, createdAt: '2026-01-02T03:04:05.000+02:00' })
    expect(result.success).toBe(true)
  })

  it('rejects a value with no timezone designator at all', () => {
    const result = CompanySchema.safeParse({ ...validCompany, createdAt: '2026-01-02T03:04:05.000' })
    expect(result.success).toBe(false)
  })

  it('accepts a valid leap-year Feb 29', () => {
    // 2028 is a leap year.
    const result = CompanySchema.safeParse({ ...validCompany, createdAt: '2028-02-29T00:00:00.000Z' })
    expect(result.success).toBe(true)
  })

  it('rejects Feb 29 in a non-leap year', () => {
    const result = CompanySchema.safeParse({ ...validCompany, createdAt: '2026-02-29T00:00:00.000Z' })
    expect(result.success).toBe(false)
  })
})

describe('parseCompanyDocument', () => {
  it('accepts a company matching the document id', () => {
    const result = parseCompanyDocument('co_a', validCompany)
    expect(result.ok).toBe(true)
  })

  it('returns data_error when id does not match the document id', () => {
    const result = parseCompanyDocument('co_other', validCompany)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('data_error')
      expect(result.error.issues.some(i => i.includes('document_id_mismatch'))).toBe(true)
    }
  })

  it('does not throw a raw ZodError on malformed input', () => {
    expect(() => parseCompanyDocument('co_a', { name: 'x' })).not.toThrow()
  })

  it('error object never contains the source document values', () => {
    const secretName = 'Совершенно секретное название ООО'
    const result = parseCompanyDocument('co_a', { ...validCompany, name: secretName, legalType: 'llc' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain(secretName)
  })
})

describe('Callable boundary schemas', () => {
  it('CreateCompanyRequestSchema accepts a valid request', () => {
    expect(CreateCompanyRequestSchema.safeParse({ name: 'ООО Ромашка', legalType: 'ooo' }).success).toBe(true)
  })

  it('CreateCompanyRequestSchema rejects an unknown legalType', () => {
    expect(CreateCompanyRequestSchema.safeParse({ name: 'x', legalType: 'llc' }).success).toBe(false)
  })

  it('CreateCompanyRequestSchema rejects extra fields', () => {
    expect(CreateCompanyRequestSchema.safeParse({ name: 'x', legalType: 'ooo', ownerId: 'uid_1' }).success).toBe(false)
  })

  it('CreateCompanyResponseSchema accepts a valid response', () => {
    const result = CreateCompanyResponseSchema.safeParse({ company: validCompany, membership: validMembership })
    expect(result.success).toBe(true)
  })

  it('CreateCompanyResponseSchema rejects a corrupted company payload', () => {
    const result = CreateCompanyResponseSchema.safeParse({
      company: { ...validCompany, legalType: 'llc' },
      membership: validMembership,
    })
    expect(result.success).toBe(false)
  })

  it('CreateCompanyResponseSchema rejects a corrupted membership payload', () => {
    const result = CreateCompanyResponseSchema.safeParse({
      company: validCompany,
      membership: { ...validMembership, role: 'superadmin' },
    })
    expect(result.success).toBe(false)
  })
})
