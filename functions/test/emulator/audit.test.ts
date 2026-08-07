// writeAuditEvent — SEC-003, against the real Firestore Emulator.
import { describe, it, expect } from 'vitest'
import { db } from '../../src/lib/admin'
import { writeAuditEvent } from '../../src/lib/audit'
import { seedCompany } from './helpers'

describe('writeAuditEvent — atomic with the transaction it runs in', () => {
  it('creates an audit event with server-assigned fields, never a raw request body', async () => {
    const companyId = `co_audit_${Date.now()}`
    await seedCompany(companyId)

    await db.runTransaction(async txn => {
      writeAuditEvent(db, txn, {
        companyId,
        actorUid: 'uid_actor_server_verified',
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
      writeAuditEvent(db, txn, { companyId, actorUid: 'uid_actor', action: 'should_not_persist' })
      throw new Error('simulated failure after the audit write was staged')
    })).rejects.toThrow('simulated failure')

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    expect(snap.size).toBe(0)
  })

  it('defaults targetUid to null and metadata to {} when omitted', async () => {
    const companyId = `co_audit_defaults_${Date.now()}`
    await seedCompany(companyId)

    await db.runTransaction(async txn => {
      writeAuditEvent(db, txn, { companyId, actorUid: 'uid_actor', action: 'no_target_action' })
    })

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    const data = snap.docs[0]!.data()
    expect(data.targetUid).toBeNull()
    expect(data.metadata).toEqual({})
  })
})
