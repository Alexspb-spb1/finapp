// Real callable pipeline proof — SEC-003.
//
// Every test in this file calls the ACTUAL deployed `authzProbe` callable
// through the Functions Emulator (not a direct in-process function call),
// using real Auth Emulator-issued ID tokens and real Firestore Emulator
// documents. This is the emulator-verifiable proof that requireAuth ->
// requireVerifiedEmail -> requireActiveMember -> requireRole works
// end-to-end, not just as isolated unit-tested functions.
import { describe, it, expect, beforeAll } from 'vitest'
import { FunctionsError } from 'firebase/functions'
import {
  createTestUser, signOutClient, seedCompany, seedMembership, seedRawMembershipDoc,
  callAuthzProbe, callAuthzProbeRaw,
} from './helpers'

function appCodeOf(err: unknown): string | undefined {
  if (err instanceof FunctionsError) {
    const details = err.details as { appCode?: string } | undefined
    return details?.appCode
  }
  return undefined
}

describe('authzProbe — real callable pipeline through the Functions Emulator', () => {
  const companyA = `co_a_${Date.now()}`
  const companyB = `co_b_${Date.now()}`

  beforeAll(async () => {
    await seedCompany(companyA)
    await seedCompany(companyB)
  })

  it('unauthenticated callable is rejected with auth_required', async () => {
    await signOutClient()
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'auth_required')
  })

  it('an authenticated but unverified email is rejected with email_unverified', async () => {
    const { uid } = await createTestUser(false, 'unverified')
    await seedMembership({ companyId: companyA, uid, role: 'admin', status: 'active' })
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'email_unverified')
  })

  it('a missing membership document is rejected with membership_not_found', async () => {
    const { uid: _uid } = await createTestUser(true, 'nomember')
    // No membership doc seeded for this uid at all.
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'membership_not_found')
  })

  it('an "invited" (not yet active) membership is rejected with membership_inactive', async () => {
    const { uid } = await createTestUser(true, 'invited')
    await seedMembership({ companyId: companyA, uid, role: 'admin', status: 'invited' })
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'membership_inactive')
  })

  it('a "disabled" membership is rejected with membership_inactive', async () => {
    const { uid } = await createTestUser(true, 'disabled')
    await seedMembership({ companyId: companyA, uid, role: 'admin', status: 'disabled' })
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'membership_inactive')
  })

  it('a corrupted (schema-invalid) membership document is rejected with membership_data_error', async () => {
    const { uid } = await createTestUser(true, 'corrupted')
    await seedRawMembershipDoc(companyA, uid, { uid, name: 'not a valid membership shape' })
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'membership_data_error')
  })

  it('an unknown role value in the membership document is rejected with membership_data_error — never upgraded', async () => {
    const { uid } = await createTestUser(true, 'unknownrole')
    const { Timestamp } = await import('firebase-admin/firestore')
    const now = Timestamp.now()
    await seedRawMembershipDoc(companyA, uid, { uid, role: 'superadmin', status: 'active', createdAt: now, updatedAt: now })
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'membership_data_error')
  })

  it('a document ID that does not match membership.uid is rejected with membership_data_error', async () => {
    const { uid } = await createTestUser(true, 'idmismatch')
    // Document is stored at .../members/{uid}, but its own `uid` field claims a different subject.
    await seedMembership({ companyId: companyA, uid: 'uid_someone_else', role: 'admin', status: 'active', docIdOverride: uid })
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'membership_data_error')
  })

  it('an active viewer calling this admin-only command is rejected with insufficient_role', async () => {
    const { uid } = await createTestUser(true, 'viewer')
    await seedMembership({ companyId: companyA, uid, role: 'viewer', status: 'active' })
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'insufficient_role')
  })

  it('an active accountant calling this admin-only command is rejected with insufficient_role', async () => {
    const { uid } = await createTestUser(true, 'accountant')
    await seedMembership({ companyId: companyA, uid, role: 'accountant', status: 'active' })
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'insufficient_role')
  })

  it('an admin of a DIFFERENT company gets no access to this company — membership_not_found, not insufficient_role', async () => {
    const { uid } = await createTestUser(true, 'crosscompany')
    await seedMembership({ companyId: companyB, uid, role: 'admin', status: 'active' })
    // Never seeded a membership for this uid under companyA.
    await expect(callAuthzProbe(companyA)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'membership_not_found')
  })

  it('an active admin of the CORRECT company succeeds and gets only { ok: true }', async () => {
    const { uid } = await createTestUser(true, 'happypath')
    await seedMembership({ companyId: companyA, uid, role: 'admin', status: 'active' })
    const result = await callAuthzProbe(companyA)
    expect(result).toEqual({ ok: true })
  })

  it('a spoofed uid field in the payload is rejected as invalid_request (extra field), never used as identity', async () => {
    const { uid } = await createTestUser(true, 'spoofuid')
    await seedMembership({ companyId: companyA, uid, role: 'admin', status: 'active' })
    await expect(callAuthzProbeRaw({ companyId: companyA, uid: 'uid_attacker_supplied' }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
  })

  it('extra role/isAdmin/permissions fields in the payload are rejected as invalid_request', async () => {
    const { uid } = await createTestUser(true, 'extrafields')
    await seedMembership({ companyId: companyA, uid, role: 'admin', status: 'active' })
    await expect(callAuthzProbeRaw({ companyId: companyA, role: 'admin', isAdmin: true, permissions: ['*'] }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
  })

  it('errors returned to the client never contain secret-like values from the request or documents', async () => {
    const secretCompanyId = `co_SECRET_LEAKED_${Date.now()}`
    await seedCompany(secretCompanyId)
    const { uid } = await createTestUser(true, 'secretcheck')
    await seedRawMembershipDoc(secretCompanyId, uid, { uid, role: 'superadmin-SECRET-VALUE', status: 'active' })
    try {
      await callAuthzProbe(secretCompanyId)
      expect.unreachable('expected the call to fail for a corrupted membership document')
    } catch (err) {
      const serialized = JSON.stringify(err instanceof FunctionsError ? { code: err.code, details: err.details, message: err.message } : err)
      expect(serialized).not.toContain(secretCompanyId)
      expect(serialized).not.toContain('superadmin-SECRET-VALUE')
    }
  })
})
