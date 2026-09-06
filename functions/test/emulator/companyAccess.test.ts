import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initializeApp, deleteApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } from 'firebase/auth'
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions'
import { Timestamp } from 'firebase-admin/firestore'
import { adminAuth, db } from '../../src/lib/admin'
import { seedCompany, seedMembership, seedRawMembershipDoc, seedRawUserDoc } from './helpers'

const app = initializeApp({ projectId: 'demo-finapp', apiKey: 'emulator-only-synthetic-key' }, 'company-access-tests')
const auth = getAuth(app)
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
const functions = getFunctions(app)
connectFunctionsEmulator(functions, '127.0.0.1', 5001)
const call = async (payload: unknown) => (await httpsCallable(functions, 'getCompanyAccess')(payload)).data
let counter = 0

async function signIn(verified = true): Promise<string> {
  const user = await adminAuth.createUser({ email: `access-${Date.now()}-${++counter}@example.test`, emailVerified: verified })
  await signInWithCustomToken(auth, await adminAuth.createCustomToken(user.uid))
  return user.uid
}

const denied = (appCode: string) => ({ details: { appCode } })

describe('getCompanyAccess — actual callable and canonical Firestore membership', () => {
  const companyId = `access-a-${Date.now()}`
  const otherCompanyId = `access-b-${Date.now()}`
  beforeAll(async () => { await seedCompany(companyId); await seedCompany(otherCompanyId) })
  afterAll(async () => { await deleteApp(app) })

  it('rejects unauthenticated callers', async () => {
    await signOut(auth)
    await expect(call({ companyId })).rejects.toMatchObject(denied('auth_required'))
  })

  it('rejects unverified email even for an active canonical admin', async () => {
    const uid = await signIn(false)
    await seedMembership({ companyId, uid, role: 'admin', status: 'active' })
    await expect(call({ companyId })).rejects.toMatchObject(denied('email_unverified'))
  })

  it.each(['viewer', 'accountant', 'admin'] as const)('confirms %s with only companyId, authenticated uid and canonical role', async role => {
    const uid = await signIn()
    await seedMembership({ companyId, uid, role, status: 'active' })
    // Legacy profile deliberately disagrees. It cannot supply or elevate role.
    await seedRawUserDoc(uid, { companyId: otherCompanyId, role: 'admin', status: 'active' })
    const memberRef = db.doc(`companies/${companyId}/members/${uid}`)
    const refs = [memberRef, db.doc(`companies/${companyId}`), db.doc(`company_data/${companyId}`), db.doc(`users/${uid}`)]
    const before = await db.getAll(...refs)
    const auditBefore = await db.collection(`companies/${companyId}/audit_events`).get()
    expect(await call({ companyId })).toEqual({ companyId, uid, role })
    const after = await db.getAll(...refs)
    expect(after.map(snap => ({ data: snap.data(), updateTime: snap.updateTime })))
      .toEqual(before.map(snap => ({ data: snap.data(), updateTime: snap.updateTime })))
    expect((await db.collection(`companies/${companyId}/audit_events`).get()).docs.map(snap => snap.data()))
      .toEqual(auditBefore.docs.map(snap => snap.data()))
  })

  it('does not accept ownership, a legacy admin profile or another company membership', async () => {
    const uid = await signIn()
    await seedCompany(companyId, uid)
    await seedRawUserDoc(uid, { companyId, role: 'admin', status: 'active' })
    await seedMembership({ companyId: otherCompanyId, uid, role: 'admin', status: 'active' })
    await expect(call({ companyId })).rejects.toMatchObject(denied('membership_not_found'))
  })

  it.each(['disabled', 'invited'] as const)('rejects a %s membership', async status => {
    const uid = await signIn()
    await seedMembership({ companyId, uid, role: 'admin', status })
    await expect(call({ companyId })).rejects.toMatchObject(denied('membership_inactive'))
  })

  it.each(['unknown-role', 'missing-fields', 'uid-mismatch'])('rejects malformed canonical data: %s', async variant => {
    const uid = await signIn()
    const timestamp = Timestamp.now()
    const raw = variant === 'missing-fields' ? { uid } : {
      uid: variant === 'uid-mismatch' ? 'other-subject' : uid,
      role: variant === 'unknown-role' ? 'private-super-admin' : 'admin',
      status: 'active', createdAt: timestamp, updatedAt: timestamp,
    }
    await seedRawMembershipDoc(companyId, uid, raw)
    await expect(call({ companyId })).rejects.toMatchObject({
      code: 'functions/permission-denied', message: 'membership_data_error',
      details: { appCode: 'membership_data_error' },
    })
  })

  it('rejects malformed path and caller-supplied identity/role', async () => {
    await signIn()
    for (const payload of [
      { companyId: 'a/members/forged' }, { companyId: '.' }, { companyId: '..' },
      { companyId: '__reserved__' }, { companyId, uid: 'another-subject' },
      { companyId, role: 'admin' }, { companyId, email_verified: true },
    ]) await expect(call(payload)).rejects.toMatchObject(denied('invalid_request'))
  })

  it('re-reads current state on each call after membership is disabled or removed', async () => {
    const uid = await signIn()
    await seedMembership({ companyId, uid, role: 'viewer', status: 'active' })
    expect(await call({ companyId })).toEqual({ companyId, uid, role: 'viewer' })
    await seedMembership({ companyId, uid, role: 'viewer', status: 'disabled' })
    await expect(call({ companyId })).rejects.toMatchObject(denied('membership_inactive'))
    await db.doc(`companies/${companyId}/members/${uid}`).delete()
    await expect(call({ companyId })).rejects.toMatchObject(denied('membership_not_found'))
  })
})
