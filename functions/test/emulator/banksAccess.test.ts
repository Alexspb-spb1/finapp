import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { authorizeBankRequest } from '../../src/banks/access'

// This tests the private guard against real Firestore transactions, NOT a
// deployed bank callable (none is exported in BANK-001).
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080'
  || process.env.GCLOUD_PROJECT !== 'demo-finapp') {
  throw new Error('BANK tests require the isolated demo-finapp emulator')
}
const app = initializeApp({ projectId: 'demo-finapp' }, 'bank-boundary-test')
const db = getFirestore(app)
const companyId = `bank-test-${randomUUID()}`
const otherCompanyId = `bank-other-${randomUUID()}`
const uid = 'synthetic-bank-admin'
const company = db.doc(`companies/${companyId}`)
const membership = db.doc(`companies/${companyId}/members/${uid}`)
const policy = db.doc('system/bankIntegrations')
const maintenance = db.doc('system/maintenance')
const request = (id = companyId) => ({ data: { companyId: id },
  auth: { uid, token: { email_verified: true } } }) as CallableRequest<unknown>

describe('BANK-001 actual Firestore access boundary', () => {
  beforeEach(async () => {
    await company.set({ name: 'Synthetic BANK test' })
    await membership.set({ uid, role: 'admin', status: 'active',
      createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1) })
    await policy.set({ enabled: true, generation: 1 })
    await maintenance.set({ enabled: false })
  })
  afterAll(async () => {
    await Promise.all([company.delete(), membership.delete(), policy.delete(), maintenance.delete()])
    await deleteApp(app)
  })

  it('authorizes in a transaction without changing financial or company data', async () => {
    const before = await company.get()
    const result = await db.runTransaction(txn => authorizeBankRequest(db, request(), 'manage', txn))
    expect(result).toEqual({ companyId, uid })
    expect((await company.get()).updateTime).toEqual(before.updateTime)
    expect((await db.doc(`company_data/${companyId}`).get()).exists).toBe(false)
  })
  it('does not use another company admin membership', async () => {
    await expect(authorizeBankRequest(db, request(otherCompanyId), 'view')).rejects.toThrow('membership_not_found')
  })
  it('blocks a fresh transaction after revocation', async () => {
    await db.runTransaction(txn => authorizeBankRequest(db, request(), 'sync', txn))
    await membership.update({ status: 'disabled' })
    await expect(db.runTransaction(txn => authorizeBankRequest(db, request(), 'sync', txn))).rejects.toThrow('membership_inactive')
  })
  it('off blocks new work while still permitting authorized disconnect', async () => {
    await policy.update({ enabled: false, generation: 2 })
    await expect(db.runTransaction(txn => authorizeBankRequest(db, request(), 'manage', txn))).rejects.toThrow('bank_module_disabled')
    await expect(db.runTransaction(txn => authorizeBankRequest(db, request(), 'disconnect', txn))).resolves.toEqual({ companyId, uid })
  })
  it('missing policy fails closed', async () => {
    await policy.delete()
    await expect(authorizeBankRequest(db, request(), 'view')).rejects.toThrow('bank_module_disabled')
  })
  it('maintenance blocks management', async () => {
    await maintenance.update({ enabled: true })
    await expect(db.runTransaction(txn => authorizeBankRequest(db, request(), 'manage', txn))).rejects.toThrow('maintenance_mode')
  })
  it('deleted company cannot be accessed through a surviving membership', async () => {
    await company.delete()
    await expect(authorizeBankRequest(db, request(), 'view')).rejects.toThrow('bank_access_denied')
  })
})
