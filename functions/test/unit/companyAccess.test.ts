import { describe, expect, it, vi } from 'vitest'
import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { readCompanyAccess } from '../../src/lib/companyAccess'
import { GetCompanyAccessResponseSchema } from '../../src/schemas/companyAccess'
import { toSafeHttpsError } from '../../src/lib/errors'

function request(data: unknown = { companyId: 'company-a' }, uid = 'caller', verified = true): CallableRequest<unknown> {
  return { data, auth: { uid, token: { email_verified: verified } } } as CallableRequest<unknown>
}

function database(raw: unknown, failure?: Error) {
  const paths: string[] = []
  const get = vi.fn(async () => {
    if (failure) throw failure
    return { exists: raw !== undefined, id: 'caller', data: () => raw }
  })
  const ref = (path: string): unknown => ({
    collection: (id: string) => { paths.push(`${path}/${id}`); return ref(`${path}/${id}`) },
    doc: (id: string) => { paths.push(`${path}/${id}`); return ref(`${path}/${id}`) },
    get,
    set: () => { throw new Error('unexpected write') },
    update: () => { throw new Error('unexpected write') },
    delete: () => { throw new Error('unexpected write') },
  })
  return { db: ref('') as Firestore, paths, get }
}

const member = { uid: 'caller', role: 'viewer', status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() }

describe('Stage 7 read-only company access confirmation', () => {
  it.each(['viewer', 'accountant', 'admin'])('accepts current %s and only reads the exact caller membership', async role => {
    const fake = database({ ...member, role })
    const result = await readCompanyAccess(fake.db, request())
    expect(result).toEqual({ companyId: 'company-a', uid: 'caller', role })
    expect(GetCompanyAccessResponseSchema.safeParse(result).success).toBe(true)
    expect(fake.paths).toEqual(['/companies', '/companies/company-a', '/companies/company-a/members', '/companies/company-a/members/caller'])
    expect(fake.get).toHaveBeenCalledOnce()
  })

  it.each([
    [undefined, 'membership_not_found'],
    [{ ...member, status: 'disabled' }, 'membership_inactive'],
    [{ ...member, status: 'invited' }, 'membership_inactive'],
    [{ ...member, role: 'owner' }, 'membership_data_error'],
    [{ ...member, uid: 'another-user' }, 'membership_data_error'],
    [{ ...member, updatedAt: 'not-a-timestamp' }, 'membership_data_error'],
    [{ ...member, ownerId: 'caller' }, 'membership_data_error'],
  ])('denies invalid current membership %j', async (raw, appCode) => {
    const fake = database(raw)
    await expect(readCompanyAccess(fake.db, request())).rejects.toMatchObject({ appCode })
    expect(fake.get).toHaveBeenCalledOnce()
  })

  it.each(['', '.', '..', '__reserved__', 'a/b', 'a'.repeat(201)])('rejects malformed company ID %s before lookup', async companyId => {
    const fake = database(member)
    await expect(readCompanyAccess(fake.db, request({ companyId }))).rejects.toMatchObject({ appCode: 'invalid_request' })
    expect(fake.paths).toEqual([])
  })

  it.each(['uid', 'role', 'email_verified'])('rejects spoofed %s payload fields', async field => {
    const fake = database(member)
    await expect(readCompanyAccess(fake.db, request({ companyId: 'company-a', [field]: 'spoof' }))).rejects.toMatchObject({ appCode: 'invalid_request' })
    expect(fake.paths).toEqual([])
  })

  it('requires authenticated verified identity before lookup', async () => {
    const fake = database(member)
    await expect(readCompanyAccess(fake.db, { data: {} } as CallableRequest<unknown>)).rejects.toMatchObject({ appCode: 'auth_required' })
    await expect(readCompanyAccess(fake.db, request(undefined, 'caller', false))).rejects.toMatchObject({ appCode: 'email_unverified' })
    await expect(readCompanyAccess(fake.db, request(undefined, 'caller/other'))).rejects.toMatchObject({ appCode: 'membership_data_error' })
    expect(fake.paths).toEqual([])
  })

  it('fails closed on read outage without leaking its message', async () => {
    const fake = database(member, new Error('private-user private-company sdk-secret'))
    try {
      await readCompanyAccess(fake.db, request())
      expect.unreachable('read should fail')
    } catch (error) {
      const safe = toSafeHttpsError(error)
      expect(safe.details).toEqual({ appCode: 'membership_data_error' })
      expect(safe.message).toBe('membership_data_error')
    }
  })
})
