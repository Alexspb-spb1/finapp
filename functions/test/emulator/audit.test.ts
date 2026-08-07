// writeAuditEvent — SEC-003, against the real Firestore Emulator.
import { describe, it, expect } from 'vitest'
import { db } from '../../src/lib/admin'
import { writeAuditEvent } from '../../src/lib/audit'
import type { RequestAuth } from '../../src/lib/authz'
import { seedCompany } from './helpers'

const serverVerifiedAuth: RequestAuth = { uid: 'uid_actor_server_verified', token: { email_verified: true } }

describe('writeAuditEvent — atomic with the transaction it runs in', () => {
  it('creates an audit event with server-assigned fields, never a raw request body', async () => {
    const companyId = `co_audit_${Date.now()}`
    await seedCompany(companyId)

    await db.runTransaction(async txn => {
      writeAuditEvent(db, txn, {
        companyId,
        auth: serverVerifiedAuth,
        action: 'test_action',
        targetUid: 'uid_target',
        metadata: { fieldChanged: 'role' },
      })
    })

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    expect(snap.size).toBe(1)
    const data = snap.docs[0]!.data()
    expect(data.action).toBe('test_action')
    expect(data.actorUid).toBe('uid_actor_server_verified')
    expect(data.targetUid).toBe('uid_target')
    expect(data.metadata).toEqual({ fieldChanged: 'role' })
    expect(data.createdAt).toBeDefined()
    expect(data).not.toHaveProperty('rawPayload')
    expect(data).not.toHaveProperty('idToken')
    expect(data).not.toHaveProperty('password')
  })

  it('rolls back together with the rest of the transaction — no orphaned audit event on failure', async () => {
    const companyId = `co_audit_rollback_${Date.now()}`
    await seedCompany(companyId)

    await expect(db.runTransaction(async txn => {
      writeAuditEvent(db, txn, { companyId, auth: serverVerifiedAuth, action: 'should_not_persist' })
      throw new Error('simulated failure after the audit write was staged')
    })).rejects.toThrow('simulated failure')

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    expect(snap.size).toBe(0)
  })

  it('defaults targetUid to null and metadata to {} when omitted', async () => {
    const companyId = `co_audit_defaults_${Date.now()}`
    await seedCompany(companyId)

    await db.runTransaction(async txn => {
      writeAuditEvent(db, txn, { companyId, auth: serverVerifiedAuth, action: 'no_target_action' })
    })

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    const data = snap.docs[0]!.data()
    expect(data.targetUid).toBeNull()
    expect(data.metadata).toEqual({})
  })

  it('rejects metadata containing an obviously sensitive key like "password" (independent review finding #2b)', async () => {
    const companyId = `co_audit_secret_metadata_${Date.now()}`
    await seedCompany(companyId)

    expect(() => {
      writeAuditEvent(db, db.batch(), {
        companyId,
        auth: serverVerifiedAuth,
        action: 'attempted_secret_leak',
        metadata: { password: 'SECRET_VALUE_should_never_be_stored' },
      })
    }).toThrow(/sensitive/i)

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    expect(snap.size).toBe(0)
  })

  it('rejects metadata containing a token/secret/credential-like key, case-insensitively', async () => {
    const companyId = `co_audit_secret_metadata2_${Date.now()}`
    await seedCompany(companyId)
    for (const key of ['idToken', 'API_KEY', 'clientSecret', 'Credential']) {
      expect(() => {
        writeAuditEvent(db, db.batch(), {
          companyId, auth: serverVerifiedAuth, action: 'x', metadata: { [key]: 'leak' },
        })
      }).toThrow(/sensitive/i)
    }
  })

  it('still allows ordinary, non-sensitive metadata keys', async () => {
    const companyId = `co_audit_ok_metadata_${Date.now()}`
    await seedCompany(companyId)
    await db.runTransaction(async txn => {
      writeAuditEvent(db, txn, {
        companyId, auth: serverVerifiedAuth, action: 'role_changed',
        metadata: { fieldChanged: 'role', previousRole: 'viewer', newRole: 'admin' },
      })
    })
    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    expect(snap.size).toBe(1)
  })
})
