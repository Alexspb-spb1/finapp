import { describe, expect, it } from 'vitest'
import { Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { authorizeBankRequest, type BankAction } from '../../../src/banks/access'
import { safeBankError } from '../../../src/banks/errors'

const member = { uid: 'caller', status: 'active', role: 'admin',
  createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1) }
const policy = { enabled: true, generation: 0 }
const request = (data: unknown = { companyId: 'company-a' }, uid = 'caller', verified = true) =>
  ({ data, auth: { uid, token: { email_verified: verified } } }) as CallableRequest<unknown>

function database(changes: Record<string, unknown> = {}) {
  const documents: Record<string, unknown> = {
    'companies/company-a': {}, 'companies/company-a/members/caller': member,
    'system/bankIntegrations': policy, ...changes,
  }
  const reads: string[] = []
  const transactionReads: string[] = []
  const read = async (path: string) => {
    reads.push(path)
    const data = documents[path]
    if (data instanceof Error) throw data
    return { exists: data !== undefined, id: path.split('/').at(-1), data: () => data }
  }
  const ref = (path: string): unknown => ({
    path,
    collection: (id: string) => ref(path ? `${path}/${id}` : id),
    doc: (id: string) => ref(`${path}/${id}`),
    get: () => read(path),
  })
  return {
    db: ref('') as Firestore,
    txn: { get: (r: { path: string }) => { transactionReads.push(r.path); return read(r.path) } } as unknown as Transaction,
    reads, transactionReads, documents,
  }
}

describe('BANK-001 uses canonical server authz, fail closed', () => {
  it.each(['viewer', 'accountant', 'admin'])('allows %s viewing within exactly one company', async role => {
    const db = database({ 'companies/company-a/members/caller': { ...member, role } })
    expect(await authorizeBankRequest(db.db, request(), 'view')).toEqual({ companyId: 'company-a', uid: 'caller' })
    expect(db.reads).toEqual(['companies/company-a/members/caller', 'companies/company-a', 'system/bankIntegrations'])
  })
  it.each(['manage', 'sync', 'disconnect'] as const)('requires transaction for %s and uses it for every read', async action => {
    const db = database()
    await expect(authorizeBankRequest(db.db, request(), action)).rejects.toThrow('bank_access_denied')
    expect(db.reads).toEqual([])
    await authorizeBankRequest(db.db, request(), action, db.txn)
    expect(db.transactionReads).toEqual(db.reads)
    expect(db.reads).toContain('system/maintenance')
  })
  it.each([
    ['viewer', 'sync'], ['viewer', 'manage'], ['accountant', 'manage'],
    ['viewer', 'disconnect'], ['accountant', 'disconnect'],
  ] as const)('denies %s performing %s before other tenant data is read', async (role, action) => {
    const db = database({ 'companies/company-a/members/caller': { ...member, role } })
    await expect(authorizeBankRequest(db.db, request(), action, db.txn)).rejects.toThrow('insufficient_role')
    expect(db.reads).toEqual(['companies/company-a/members/caller'])
  })
  it.each([
    undefined, { ...member, status: 'disabled' }, { ...member, status: 'invited' },
    { ...member, role: 'owner' }, { ...member, uid: 'other' },
    { ...member, updatedAt: 'bad' }, new Error('secret-membership'),
  ])('denies missing, revoked, corrupt or unavailable membership', async value => {
    const db = database({ 'companies/company-a/members/caller': value })
    await expect(authorizeBankRequest(db.db, request(), 'view')).rejects.toThrow()
    expect(db.reads).toEqual(['companies/company-a/members/caller'])
  })
  it('does not grant company B permissions from admin of company A', async () => {
    const db = database()
    await expect(authorizeBankRequest(db.db, request({ companyId: 'company-b' }), 'view')).rejects.toThrow('membership_not_found')
    expect(db.reads).toEqual(['companies/company-b/members/caller'])
  })
  it('rechecks permissions on every invocation', async () => {
    const db = database()
    await authorizeBankRequest(db.db, request(), 'manage', db.txn)
    db.documents['companies/company-a/members/caller'] = { ...member, status: 'disabled' }
    await expect(authorizeBankRequest(db.db, request(), 'manage', db.txn)).rejects.toThrow('membership_inactive')
  })
  it.each([undefined, { enabled: false, generation: 0 }, { enabled: 'true', generation: 0 },
    { enabled: true }, { enabled: true, generation: -1 }, new Error('token-secret')])('missing/off/corrupt/unavailable flag is disabled', async flag => {
    const db = database({ 'system/bankIntegrations': flag })
    await expect(authorizeBankRequest(db.db, request(), 'view')).rejects.toThrow('bank_module_disabled')
    await expect(authorizeBankRequest(db.db, request(), 'disconnect', db.txn)).resolves.toMatchObject({ companyId: 'company-a' })
  })
  it.each([{ enabled: true }, new Error('secret')])('maintenance blocks mutation', async maintenance => {
    const db = database({ 'system/maintenance': maintenance })
    await expect(authorizeBankRequest(db.db, request(), 'sync', db.txn)).rejects.toThrow('maintenance_mode')
    expect(db.reads).not.toContain('system/bankIntegrations')
  })
  it('denies deleted company despite surviving membership', async () => {
    const db = database({ 'companies/company-a': undefined })
    await expect(authorizeBankRequest(db.db, request(), 'view')).rejects.toThrow('bank_access_denied')
  })
  it.each([{ companyId: 'company-a', uid: 'admin' }, { companyId: 'company-a', role: 'admin' },
    { companyId: '../b' }, { companyId: 'a/b' }])('rejects payload spoofing and path injection before reads', async data => {
    const db = database()
    await expect(authorizeBankRequest(db.db, request(data), 'view')).rejects.toThrow('invalid_request')
    expect(db.reads).toEqual([])
  })
  it('requires real authenticated verified request before reading', async () => {
    const db = database()
    await expect(authorizeBankRequest(db.db, { data: {} } as CallableRequest<unknown>, 'view')).rejects.toThrow('auth_required')
    await expect(authorizeBankRequest(db.db, request(undefined, 'caller', false), 'view')).rejects.toThrow('email_unverified')
    await expect(authorizeBankRequest(db.db, request(undefined, 'caller/escape'), 'view')).rejects.toThrow('membership_data_error')
    await expect(authorizeBankRequest(db.db, request(), 'unknown' as BankAction)).rejects.toThrow('bank_access_denied')
    expect(db.reads).toEqual([])
  })
  it('suppresses arbitrary SDK errors and all attached fields', () => {
    const raw = Object.assign(new Error('Authorization: secret'), { token: 'secret' })
    expect(safeBankError(raw).message).toBe('bank_unavailable')
    expect(JSON.stringify(safeBankError(raw))).not.toContain('secret')
  })
})
