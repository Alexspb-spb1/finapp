import { describe, it, expect, vi } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import {
  RoleSchema,
  MembershipStatusSchema,
  MembershipSchema,
  UserProfileSchema,
  LegacyUserSchema,
  CompanyScopedRequestSchema,
  MemberSubjectRequestSchema,
  SetMemberRoleRequestSchema,
  SetMemberStatusRequestSchema,
  MembershipResponseSchema,
  parseUserProfileDocument,
  parseLegacyUserDocument,
  parseMembershipDocument,
} from './auth'

const now = Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z'))

const validMembership = {
  uid: 'uid_1',
  role: 'admin' as const,
  status: 'active' as const,
  createdAt: now,
  updatedAt: now,
}

const validUserProfile = {
  id: 'uid_1',
  name: 'Мария Иванова',
  email: 'maria@example.test',
  createdAt: '2026-01-01T00:00:00.000Z',
}

const validLegacyUser = {
  id: 'uid_1',
  name: 'Мария Иванова',
  email: 'maria@example.test',
  role: 'admin' as const,
  companyId: 'co_a',
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('RoleSchema', () => {
  it('accepts all three valid roles', () => {
    for (const role of ['viewer', 'accountant', 'admin']) {
      expect(RoleSchema.safeParse(role).success).toBe(true)
    }
  })

  it('rejects an unknown role', () => {
    expect(RoleSchema.safeParse('superadmin').success).toBe(false)
  })

  it('does not auto-correct case', () => {
    expect(RoleSchema.safeParse('Admin').success).toBe(false)
    expect(RoleSchema.safeParse('ADMIN').success).toBe(false)
  })
})

describe('MembershipStatusSchema', () => {
  it('accepts all three valid statuses', () => {
    for (const status of ['invited', 'active', 'disabled']) {
      expect(MembershipStatusSchema.safeParse(status).success).toBe(true)
    }
  })

  it('rejects an unknown status', () => {
    expect(MembershipStatusSchema.safeParse('pending').success).toBe(false)
  })
})

describe('MembershipSchema', () => {
  it('accepts a valid membership', () => {
    const result = MembershipSchema.safeParse(validMembership)
    expect(result.success).toBe(true)
  })

  it.each(['uid', 'role', 'status', 'createdAt', 'updatedAt'] as const)(
    'rejects a membership missing %s',
    field => {
      const broken = { ...validMembership }
      delete (broken as Record<string, unknown>)[field]
      expect(MembershipSchema.safeParse(broken).success).toBe(false)
    },
  )

  it('rejects a string in place of a Firestore Timestamp', () => {
    const result = MembershipSchema.safeParse({ ...validMembership, createdAt: '2026-01-01T00:00:00.000Z' })
    expect(result.success).toBe(false)
  })

  it('rejects a number in place of a Firestore Timestamp', () => {
    const result = MembershipSchema.safeParse({ ...validMembership, updatedAt: 1735689600000 })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed timestamp-like object', () => {
    const result = MembershipSchema.safeParse({ ...validMembership, createdAt: { seconds: 1, nanoseconds: 0 } })
    expect(result.success).toBe(false)
  })

  it('rejects unknown privileged extra fields', () => {
    const result = MembershipSchema.safeParse({ ...validMembership, isAdmin: true })
    expect(result.success).toBe(false)
  })

  it('rejects extra unrelated fields (strict)', () => {
    const result = MembershipSchema.safeParse({ ...validMembership, note: 'hello' })
    expect(result.success).toBe(false)
  })

  it('never upgrades an unknown role to admin', () => {
    const result = MembershipSchema.safeParse({ ...validMembership, role: 'superadmin' })
    expect(result.success).toBe(false)
    // and definitely not silently accepted as admin under a different shape
    expect(MembershipSchema.safeParse({ ...validMembership, role: 'superadmin' }).success).toBe(false)
  })

  it('accepts an optional invitedBy field', () => {
    const result = MembershipSchema.safeParse({ ...validMembership, invitedBy: 'uid_admin' })
    expect(result.success).toBe(true)
  })
})

describe('parseMembershipDocument', () => {
  it('accepts a valid membership matching the document id', () => {
    const result = parseMembershipDocument('co_a', 'uid_1', validMembership)
    expect(result.ok).toBe(true)
  })

  it('returns data_error when uid does not match the document id', () => {
    const result = parseMembershipDocument('co_a', 'uid_other', validMembership)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('data_error')
      expect(result.error.issues.some(i => i.includes('document_id_mismatch'))).toBe(true)
    }
  })

  it('returns data_error, not a thrown ZodError, for malformed input', () => {
    expect(() => parseMembershipDocument('co_a', 'uid_1', { role: 'admin' })).not.toThrow()
    const result = parseMembershipDocument('co_a', 'uid_1', { role: 'admin' })
    expect(result.ok).toBe(false)
  })

  it('source is a fixed safe path template — never the real companyId/uid/document values, including in logged console output (independent review finding #3)', () => {
    const secretCompanyId = 'co_SECRET_LEAKED_COMPANY_ID_98765'
    const secretUid = 'uid_SECRET_LEAKED_UID_12345'
    const secretMismatchUid = 'uid_SECRET_OTHER_UID_54321'
    const secretInvitedBy = 'uid_SECRET_INVITER_11111'
    const secretEmail = 'secret-leaked-owner@internal.example.test'

    const consoleSpies = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ]
    const allSecrets = [secretCompanyId, secretUid, secretMismatchUid, secretInvitedBy, secretEmail]
    const loggedOutput = () =>
      consoleSpies.flatMap(spy => spy.mock.calls).map(args => JSON.stringify(args)).join('\n')

    // Case A: schema validation failure (bad role + an unexpected `email`
    // field — Membership has no email field, so a strict-schema document
    // that somehow carries one must fail without ever surfacing it).
    const badRole = parseMembershipDocument(secretCompanyId, secretUid, {
      ...validMembership, uid: secretUid, role: 'superadmin', invitedBy: secretInvitedBy, email: secretEmail,
    })
    expect(badRole.ok).toBe(false)
    if (!badRole.ok) {
      expect(badRole.error.code).toBe('data_error')
      expect(badRole.error.source).toBe('companies/{companyId}/members/{uid}')
      const serialized = JSON.stringify(badRole.error)
      for (const secret of allSecrets) expect(serialized).not.toContain(secret)
    }

    // Case B: document id mismatch (uid parameter differs from membership.uid).
    const mismatch = parseMembershipDocument(secretCompanyId, secretMismatchUid, {
      ...validMembership, uid: secretUid, email: secretEmail,
    })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) {
      expect(mismatch.error.source).toBe('companies/{companyId}/members/{uid}')
      const serialized = JSON.stringify(mismatch.error)
      for (const secret of allSecrets) expect(serialized).not.toContain(secret)
    }

    // Neither case logged anything containing the secret values (parseMembershipDocument
    // itself never logs — this also guards against a future regression that adds logging).
    const captured = loggedOutput()
    for (const secret of allSecrets) expect(captured).not.toContain(secret)

    consoleSpies.forEach(spy => spy.mockRestore())
  })

  it('a successful parse still enforces that the document id matches membership.uid', () => {
    const ok = parseMembershipDocument('co_a', 'uid_1', validMembership)
    expect(ok.ok).toBe(true)
    const mismatched = parseMembershipDocument('co_a', 'uid_does_not_match', validMembership)
    expect(mismatched.ok).toBe(false)
  })
})

describe('UserProfileSchema', () => {
  it('accepts a valid canonical profile', () => {
    expect(UserProfileSchema.safeParse(validUserProfile).success).toBe(true)
  })

  it.each(['role', 'companyId', 'companies', 'isAdmin', 'permissions'])(
    'rejects extra privileged field %s',
    field => {
      const withExtra = { ...validUserProfile, [field]: field === 'companies' ? [] : 'admin' }
      expect(UserProfileSchema.safeParse(withExtra).success).toBe(false)
    },
  )

  it('rejects a legacy document shape outright', () => {
    expect(UserProfileSchema.safeParse(validLegacyUser).success).toBe(false)
  })

  it('does not mutate the original input object', () => {
    const input = { ...validUserProfile }
    const snapshot = JSON.stringify(input)
    UserProfileSchema.safeParse(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('parseUserProfileDocument', () => {
  it('accepts a matching profile', () => {
    const result = parseUserProfileDocument('uid_1', validUserProfile)
    expect(result.ok).toBe(true)
  })

  it('returns data_error on document id mismatch', () => {
    const result = parseUserProfileDocument('uid_other', validUserProfile)
    expect(result.ok).toBe(false)
  })
})

describe('LegacyUserSchema', () => {
  it('temporarily accepts the current valid legacy shape', () => {
    expect(LegacyUserSchema.safeParse(validLegacyUser).success).toBe(true)
  })

  it('accepts a valid multi-company legacy shape', () => {
    const withCompanies = { ...validLegacyUser, companies: [{ companyId: 'co_b', role: 'viewer' as const }] }
    expect(LegacyUserSchema.safeParse(withCompanies).success).toBe(true)
  })

  it('rejects a missing companyId', () => {
    const broken = { ...validLegacyUser } as Record<string, unknown>
    delete broken.companyId
    expect(LegacyUserSchema.safeParse(broken).success).toBe(false)
  })

  it('rejects an unknown home role', () => {
    expect(LegacyUserSchema.safeParse({ ...validLegacyUser, role: 'superadmin' }).success).toBe(false)
  })

  it('rejects an unknown role inside companies[]', () => {
    const broken = { ...validLegacyUser, companies: [{ companyId: 'co_b', role: 'superadmin' }] }
    expect(LegacyUserSchema.safeParse(broken).success).toBe(false)
  })

  it('rejects a malformed companies[] entry', () => {
    const broken = { ...validLegacyUser, companies: [{ companyId: 'co_b' }] }
    expect(LegacyUserSchema.safeParse(broken).success).toBe(false)
  })

  it('rejects an unknown extra field', () => {
    expect(LegacyUserSchema.safeParse({ ...validLegacyUser, isOwner: true }).success).toBe(false)
  })

  it('never fills in a default role or companyId', () => {
    const broken = { ...validLegacyUser } as Record<string, unknown>
    delete broken.role
    const result = LegacyUserSchema.safeParse(broken)
    expect(result.success).toBe(false)
  })
})

describe('parseLegacyUserDocument', () => {
  it('accepts a matching legacy document', () => {
    const result = parseLegacyUserDocument('uid_1', validLegacyUser)
    expect(result.ok).toBe(true)
  })

  it('returns data_error on document id mismatch', () => {
    const result = parseLegacyUserDocument('uid_other', validLegacyUser)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('data_error')
  })
})

describe('Callable boundary schemas', () => {
  it('CompanyScopedRequestSchema rejects a missing companyId', () => {
    expect(CompanyScopedRequestSchema.safeParse({}).success).toBe(false)
  })

  it('CompanyScopedRequestSchema rejects an empty companyId', () => {
    expect(CompanyScopedRequestSchema.safeParse({ companyId: '' }).success).toBe(false)
  })

  it('CompanyScopedRequestSchema rejects extra fields', () => {
    expect(CompanyScopedRequestSchema.safeParse({ companyId: 'co_a', extra: 1 }).success).toBe(false)
  })

  it('MemberSubjectRequestSchema rejects a missing subjectUid', () => {
    expect(MemberSubjectRequestSchema.safeParse({ companyId: 'co_a' }).success).toBe(false)
  })

  it('MemberSubjectRequestSchema accepts a valid request', () => {
    expect(MemberSubjectRequestSchema.safeParse({ companyId: 'co_a', subjectUid: 'uid_1' }).success).toBe(true)
  })

  it('SetMemberRoleRequestSchema rejects an unknown role', () => {
    const result = SetMemberRoleRequestSchema.safeParse({ companyId: 'co_a', subjectUid: 'uid_1', role: 'superadmin' })
    expect(result.success).toBe(false)
  })

  it('SetMemberRoleRequestSchema accepts a valid request', () => {
    const result = SetMemberRoleRequestSchema.safeParse({ companyId: 'co_a', subjectUid: 'uid_1', role: 'admin' })
    expect(result.success).toBe(true)
  })

  it('SetMemberStatusRequestSchema rejects an unknown status', () => {
    const result = SetMemberStatusRequestSchema.safeParse({ companyId: 'co_a', subjectUid: 'uid_1', status: 'pending' })
    expect(result.success).toBe(false)
  })

  it('SetMemberStatusRequestSchema accepts a valid request', () => {
    const result = SetMemberStatusRequestSchema.safeParse({ companyId: 'co_a', subjectUid: 'uid_1', status: 'disabled' })
    expect(result.success).toBe(true)
  })

  it('MembershipResponseSchema rejects a corrupted membership payload', () => {
    const result = MembershipResponseSchema.safeParse({ membership: { ...validMembership, role: 'superadmin' } })
    expect(result.success).toBe(false)
  })

  it('MembershipResponseSchema accepts a valid response', () => {
    const result = MembershipResponseSchema.safeParse({ membership: validMembership })
    expect(result.success).toBe(true)
  })

  it('MembershipResponseSchema rejects extra top-level fields', () => {
    const result = MembershipResponseSchema.safeParse({ membership: validMembership, extra: true })
    expect(result.success).toBe(false)
  })
})

describe('Error contract', () => {
  it('error code is exactly data_error', () => {
    const result = parseUserProfileDocument('uid_1', { ...validUserProfile, role: 'admin' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('data_error')
  })

  it('error object never contains the source document values', () => {
    const secretEmail = 'super-secret-owner@internal.example.test'
    const result = parseUserProfileDocument('uid_1', { ...validUserProfile, email: secretEmail, role: 'admin' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const serialized = JSON.stringify(result.error)
      expect(serialized).not.toContain(secretEmail)
      expect(serialized).not.toContain(validUserProfile.name)
    }
  })

  it('a corrupted record is never returned as a partial success', () => {
    const result = parseMembershipDocument('co_a', 'uid_1', { uid: 'uid_1', role: 'admin' })
    expect(result.ok).toBe(false)
    expect((result as { data?: unknown }).data).toBeUndefined()
  })
})
