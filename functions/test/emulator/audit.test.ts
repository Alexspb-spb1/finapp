// writeAuditEvent — SEC-003, against the real Firestore Emulator.
import { describe, it, expect } from 'vitest'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { db } from '../../src/lib/admin'
import { writeAuditEvent } from '../../src/lib/audit'
import { seedCompany } from './helpers'

function mockRequest(
  auth: { uid: string; token: { email_verified?: boolean } } | undefined,
  data: unknown = {},
): CallableRequest<unknown> {
  return { data, auth } as unknown as CallableRequest<unknown>
}

describe('writeAuditEvent — atomic with the transaction it runs in, actor identity from verified auth only', () => {
  it('creates an audit event with server-assigned actorUid taken from request.auth.uid', async () => {
    const companyId = `co_audit_${Date.now()}`
    await seedCompany(companyId)
    const request = mockRequest({ uid: 'uid_actor_server_verified', token: { email_verified: true } })

    await db.runTransaction(async txn => {
      writeAuditEvent(db, txn, request, { companyId, action: 'test_action', targetUid: 'uid_target' })
    })

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    expect(snap.size).toBe(1)
    const data = snap.docs[0]!.data()
    expect(data.action).toBe('test_action')
    expect(data.actorUid).toBe('uid_actor_server_verified')
    expect(data.targetUid).toBe('uid_target')
    expect(data.createdAt).toBeDefined()
    expect(data).not.toHaveProperty('rawPayload')
    expect(data).not.toHaveProperty('idToken')
    expect(data).not.toHaveProperty('password')
    expect(data).not.toHaveProperty('metadata')
  })

  it('a spoofed actorUid/uid field in the payload (request.data) is completely ignored — actorUid always comes from request.auth.uid (independent review finding #1, round 2)', async () => {
    const companyId = `co_audit_spoof_${Date.now()}`
    await seedCompany(companyId)
    const realUid = 'uid_REAL_VERIFIED_ACTOR'
    const request = mockRequest(
      { uid: realUid, token: { email_verified: true } },
      { actorUid: 'uid_ATTACKER_SPOOFED', uid: 'uid_ATTACKER_SPOOFED_2' },
    )

    await db.runTransaction(async txn => {
      writeAuditEvent(db, txn, request, { companyId, action: 'spoof_attempt' })
    })

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    expect(snap.size).toBe(1)
    const data = snap.docs[0]!.data()
    expect(data.actorUid).toBe(realUid)
    expect(data.actorUid).not.toBe('uid_ATTACKER_SPOOFED')
    expect(data.actorUid).not.toBe('uid_ATTACKER_SPOOFED_2')
  })

  it('an unauthenticated request (no request.auth) is rejected with auth_required and writes nothing', async () => {
    const companyId = `co_audit_unauth_${Date.now()}`
    await seedCompany(companyId)
    const request = mockRequest(undefined)

    await expect(db.runTransaction(async txn => {
      writeAuditEvent(db, txn, request, { companyId, action: 'should_not_persist' })
    })).rejects.toEqual(expect.objectContaining({ appCode: 'auth_required' }))

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    expect(snap.size).toBe(0)
  })

  it('rolls back together with the rest of the transaction — no orphaned audit event on failure', async () => {
    const companyId = `co_audit_rollback_${Date.now()}`
    await seedCompany(companyId)
    const request = mockRequest({ uid: 'uid_actor', token: { email_verified: true } })

    await expect(db.runTransaction(async txn => {
      writeAuditEvent(db, txn, request, { companyId, action: 'should_not_persist' })
      throw new Error('simulated failure after the audit write was staged')
    })).rejects.toThrow('simulated failure')

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    expect(snap.size).toBe(0)
  })

  it('defaults targetUid to null when omitted', async () => {
    const companyId = `co_audit_defaults_${Date.now()}`
    await seedCompany(companyId)
    const request = mockRequest({ uid: 'uid_actor', token: { email_verified: true } })

    await db.runTransaction(async txn => {
      writeAuditEvent(db, txn, request, { companyId, action: 'no_target_action' })
    })

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    const data = snap.docs[0]!.data()
    expect(data.targetUid).toBeNull()
  })

  it('has no metadata field at all — arbitrary metadata is no longer part of the contract (independent review finding #2, round 2)', async () => {
    const companyId = `co_audit_nometadata_${Date.now()}`
    await seedCompany(companyId)
    const request = mockRequest({ uid: 'uid_actor', token: { email_verified: true } })
    const secretValue = 'SECRET_ID_TOKEN_should_never_be_stored_anywhere'

    await db.runTransaction(async txn => {
      // Even if a caller bypasses TypeScript and forces extra properties
      // onto the input object, writeAuditEvent only ever reads the named
      // fields it explicitly destructures — nothing is ever spread from
      // `input` wholesale into the Firestore payload.
      const forgedInput = {
        companyId, action: 'x', note: secretValue, metadata: { note: secretValue },
      } as unknown as { companyId: string; action: string }
      writeAuditEvent(db, txn, request, forgedInput)
    })

    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    const data = snap.docs[0]!.data()
    expect(data).not.toHaveProperty('metadata')
    expect(data).not.toHaveProperty('note')
    expect(JSON.stringify(data)).not.toContain(secretValue)
  })
})
