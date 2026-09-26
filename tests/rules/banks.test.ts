import { afterAll, beforeAll, describe, it } from 'vitest'
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, Timestamp } from 'firebase/firestore'

let env: RulesTestEnvironment
const companyId = 'synthetic-bank-company'
const uid = 'synthetic-bank-admin'
const paths = ['bankOAuthStates/synthetic-state', 'bankCompanies/synthetic-bank-company',
  ...['connections', 'bindings', 'operations', 'jobs', 'matchBuckets', 'observations', 'outbox', 'credentials'].map(name => `bankCompanies/${companyId}/${name}/synthetic`),
  `bankCompanies/${companyId}/jobs/synthetic/receipts/0`,
  `bankCompanies/${companyId}/jobs/synthetic/cursors/synthetic`]

describe('BANK-002 private storage remains denied to every browser client', () => {
  beforeAll(async () => {
    env = await initializeTestEnvironment({ projectId: 'demo-finapp-bank-rules',
      firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.rules', 'utf8') } })
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), `companies/${companyId}`), { ownerId: uid })
      await setDoc(doc(ctx.firestore(), `companies/${companyId}/members/${uid}`), {
        uid, role: 'admin', status: 'active', createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1) })
      for (const path of paths) await setDoc(doc(ctx.firestore(), path), { synthetic: true })
    })
  })
  afterAll(async () => { await env.clearFirestore(); await env.cleanup() })
  it.each(['anonymous', 'admin', 'outsider'])('denies read/list/create/update/delete for %s', async actor => {
    const db = actor === 'anonymous' ? env.unauthenticatedContext().firestore()
      : env.authenticatedContext(actor === 'admin' ? uid : 'synthetic-outsider', { email_verified: true }).firestore()
    for (const path of paths) {
      await assertFails(getDoc(doc(db, path)))
      await assertFails(setDoc(doc(db, path), { synthetic: false }))
      await assertFails(deleteDoc(doc(db, path)))
      await assertFails(setDoc(doc(db, `${path}-new`), { synthetic: true }))
    }
    await assertFails(getDocs(collection(db, `bankCompanies/${companyId}/operations`)))
  })
})
