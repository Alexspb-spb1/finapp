// SEC-006 Stage 5: real callable/verified Auth pipeline and real Firestore
// transactions. Only the explicitly labelled fault-injection test invokes
// the orchestration function in-process, using the real emulator database.
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { FunctionsError } from 'firebase/functions'
import { Timestamp, type Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { adminAuth, db } from '../../src/lib/admin'
import { performAcceptInvite } from '../../src/index'
import { AcceptInviteResponseSchema, InvitationDocumentSchema, PreviewInviteResponseSchema } from '../../src/schemas/invitation'
import { MembershipSchema } from '../../src/schemas/auth'
import {
  createTestUser, signInAsExistingUser, signOutClient, seedCompany, seedMembership,
  callInviteMember, callAcceptInvite, callPreviewInvite, callWithEmulatorIdentity,
  getUserDoc, getInvitationDoc, getInvitationLockDoc, getMembershipDoc,
  getMembershipsSnapshot, getAuditEvents, seedInvitationDoc, seedInvitationLockDoc,
  seedRawUserDoc, setMaintenanceMode, clearMaintenanceMode,
} from './helpers'

type InviteLink = { inviteId: string; token: string; expiresAtUtc: string }
const codeOf = (error: unknown) => error instanceof FunctionsError
  ? (error.details as { appCode?: string })?.appCode : undefined
let sequence = 0

async function setup(verified = true) {
  const companyId = `accept_stage5_${Date.now()}_${++sequence}`
  const { uid: adminUid } = await createTestUser(true, 'accept-admin')
  await seedCompany(companyId, adminUid)
  await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
  const { uid } = await createTestUser(verified, 'accept-invitee')
  const email = (await adminAuth.getUser(uid)).email!
  await signInAsExistingUser(adminUid)
  const link = await callInviteMember({ companyId, email, role: 'accountant' }) as InviteLink
  await signInAsExistingUser(uid)
  return { companyId, adminUid, uid, email, ...link }
}
type Fixture = Awaited<ReturnType<typeof setup>>
const payload = (f: Fixture) => ({ inviteId: f.inviteId, token: f.token })
async function snapshot(f: Fixture) {
  return {
    invitation: await getInvitationDoc(f.inviteId), lock: await getInvitationLockDoc(f.companyId, f.email),
    memberships: await getMembershipsSnapshot(f.companyId), profile: await getUserDoc(f.uid),
    audit: await getAuditEvents(f.companyId),
  }
}
async function denial(f: Fixture, code: string, data: unknown = payload(f)) {
  const before = await snapshot(f)
  await expect(callAcceptInvite(data)).rejects.toSatisfy((error: unknown) => codeOf(error) === code)
  expect(await snapshot(f)).toEqual(before)
}
async function patchInvite(f: Fixture, patch: Record<string, unknown>) {
  await seedInvitationDoc(f.inviteId, { ...await getInvitationDoc(f.inviteId), ...patch })
}

describe('acceptInvite and previewInvite through real emulators', () => {
  afterEach(async () => { await signOutClient(); await clearMaintenanceMode() })

  it('accepts an actual inviteMember link and commits the membership, legacy bridge and one acceptance audit', async () => {
    const f = await setup()
    const before = await snapshot(f)
    const result = await callAcceptInvite(payload(f))
    expect(AcceptInviteResponseSchema.parse(result)).toEqual({ companyId: f.companyId })
    const membership = MembershipSchema.parse(await getMembershipDoc(f.companyId, f.uid))
    expect(membership).toMatchObject({ uid: f.uid, role: 'accountant', status: 'active', invitedBy: f.adminUid })
    const invitation = InvitationDocumentSchema.parse(await getInvitationDoc(f.inviteId))
    expect(invitation).toMatchObject({ status: 'accepted', acceptedByUid: f.uid, tokenHash: createHash('sha256').update(f.token).digest('hex') })
    expect(await getUserDoc(f.uid)).toMatchObject({ id: f.uid, email: f.email, role: 'accountant', companyId: f.companyId })
    expect(await getInvitationLockDoc(f.companyId, f.email)).toEqual(before.lock)
    const events = await getAuditEvents(f.companyId)
    expect(events).toHaveLength(before.audit.length + 1)
    const event = events.find(e => e.action === 'invite_accepted')!
    expect(Object.keys(event).sort()).toEqual(['action', 'actorUid', 'createdAt', 'targetUid'])
    expect(event).toMatchObject({ actorUid: f.uid, targetUid: f.uid })
    expect(JSON.stringify(await snapshot(f))).not.toContain(f.token)
  })

  it('replays after a lost response with zero further writes, and does not reactivate a subsequently disabled member', async () => {
    const f = await setup()
    await callAcceptInvite(payload(f)) // successful response treated as lost by caller
    const committed = await snapshot(f)
    await expect(callAcceptInvite(payload(f))).resolves.toEqual({ companyId: f.companyId })
    expect(await snapshot(f)).toEqual(committed)
    await db.collection('companies').doc(f.companyId).collection('members').doc(f.uid).update({ status: 'disabled' })
    const disabled = await snapshot(f)
    await callAcceptInvite(payload(f))
    expect(await snapshot(f)).toEqual(disabled)
  })

  it('allows only one consuming transaction for simultaneous same-UID accepts', async () => {
    const f = await setup()
    const before = await snapshot(f)
    const results = await Promise.all([callAcceptInvite(payload(f)), callAcceptInvite(payload(f))])
    expect(results).toEqual([{ companyId: f.companyId }, { companyId: f.companyId }])
    const after = await snapshot(f)
    expect(after.memberships).toHaveLength(before.memberships.length + 1)
    expect(after.audit).toHaveLength(before.audit.length + 1)
    expect(after.audit.filter(e => e.action === 'invite_accepted')).toHaveLength(1)
  })

  it('refuses an unverified account, then accepts the unchanged invitation after real ID-token refresh', async () => {
    const f = await setup(false)
    await denial(f, 'email_unverified')
    // Emulator Admin Auth change represents the completed Firebase email
    // verification action. Re-sign-in obtains a fresh verified ID token.
    await adminAuth.updateUser(f.uid, { emailVerified: true })
    await signInAsExistingUser(f.uid)
    await expect(callAcceptInvite(payload(f))).resolves.toEqual({ companyId: f.companyId })
  })

  it('refuses a stolen link used by a verified account with a different email', async () => {
    const f = await setup()
    const { uid: attacker } = await createTestUser(true, 'accept-attacker')
    await denial(f, 'invite_invalid')
    expect(await getMembershipDoc(f.companyId, attacker)).toBeUndefined()
    expect(await getUserDoc(attacker)).toBeUndefined()
  })

  it('refuses a different UID replay after acceptance', async () => {
    const f = await setup()
    await callAcceptInvite(payload(f))
    await createTestUser(true, 'accept-other-uid')
    await denial(f, 'invite_already_used')
  })

  it('requires authentication', async () => {
    const f = await setup()
    await signOutClient()
    await denial(f, 'auth_required')
  })

  it.each(['companyId', 'uid', 'email', 'role', 'status', 'email_verified', 'acceptedAt'])('rejects privileged field %s', async field => {
    const f = await setup()
    await denial(f, 'invalid_request', { ...payload(f), [field]: 'forged' })
  })

  it.each(['/', '.', '..', '__reserved__'])('rejects an invalid invite ID: %s', async inviteId => {
    const f = await setup()
    await denial(f, 'invalid_request', { ...payload(f), inviteId })
  })

  it('makes missing and wrong-token invitations indistinguishable', async () => {
    const f = await setup()
    await denial(f, 'invite_invalid', { ...payload(f), inviteId: 'missing_stage5_invite' })
    await denial(f, 'invite_invalid', { ...payload(f), token: Buffer.alloc(32, 8).toString('base64url') })
  })

  it.each(['expired', 'revoked', 'corrupted', 'future', 'lock-missing', 'lock-corrupted', 'lock-replaced', 'company-missing', 'maintenance'])('fails closed without partial writes for %s', async scenario => {
    const f = await setup()
    let expected = 'internal_error'
    if (scenario === 'expired') { await patchInvite(f, { expiresAt: Timestamp.fromMillis(Date.now() - 60_000) }); expected = 'invite_expired' }
    if (scenario === 'revoked') { await patchInvite(f, { status: 'revoked', revokedBy: f.adminUid, revokedAt: Timestamp.now() }); expected = 'invite_revoked' }
    if (scenario === 'corrupted') await patchInvite(f, { role: 'unknown' })
    if (scenario === 'future') await patchInvite(f, { createdAt: Timestamp.fromMillis(Date.now() + 3_600_000) })
    if (scenario === 'lock-missing') {
      const { computeInvitationLockId } = await import('../../src/schemas/invitation')
      await db.collection('invitationLocks').doc(computeInvitationLockId(f.companyId, f.email)).delete()
    }
    if (scenario === 'lock-corrupted') await seedInvitationLockDoc(f.companyId, f.email, { wrong: true })
    if (scenario === 'lock-replaced') { await seedInvitationLockDoc(f.companyId, f.email, { currentInviteId: 'replacement_stage5' }); expected = 'invite_invalid' }
    if (scenario === 'company-missing') { await db.collection('companies').doc(f.companyId).delete(); expected = 'invite_invalid' }
    if (scenario === 'maintenance') { await setMaintenanceMode(true); expected = 'maintenance_mode' }
    await denial(f, expected)
  })

  it.each(['active-conflict', 'active-same', 'disabled', 'invited', 'malformed'])('handles existing membership: %s', async kind => {
    const f = await setup()
    await seedMembership({ companyId: f.companyId, uid: f.uid, role: kind === 'active-same' ? 'accountant' : 'viewer', status: kind === 'disabled' ? 'disabled' : kind === 'invited' ? 'invited' : 'active' })
    const ref = db.collection('companies').doc(f.companyId).collection('members').doc(f.uid)
    if (kind === 'malformed') await ref.update({ role: 'unknown' })
    const original = await getMembershipDoc(f.companyId, f.uid)
    if (kind === 'active-conflict' || kind === 'malformed') {
      await denial(f, kind === 'malformed' ? 'membership_data_error' : 'membership_conflict')
    } else {
      await callAcceptInvite(payload(f))
      const result = await getMembershipDoc(f.companyId, f.uid)
      expect(result).toMatchObject({ role: 'accountant', status: 'active', createdAt: original?.createdAt })
      if (kind === 'active-same') expect(result).toEqual(original)
    }
  })

  it('preserves existing profile identity and primary-company privileges when joining another company', async () => {
    const f = await setup()
    const original = { id: f.uid, name: 'Synthetic existing user', email: f.email, createdAt: new Date().toISOString(), companyId: 'primary_stage5', role: 'admin', avatar: 'synthetic-avatar' }
    await seedRawUserDoc(f.uid, original)
    await callAcceptInvite(payload(f))
    expect(await getUserDoc(f.uid)).toEqual({ ...original, companies: [{ companyId: 'primary_stage5', role: 'admin' }, { companyId: f.companyId, role: 'accountant' }] })
  })

  it('rolls back ALL real Firestore writes if the transaction throws after queuing membership, profile, invitation and audit', async () => {
    const f = await setup()
    const before = await snapshot(f)
    const req = { data: payload(f), auth: { uid: f.uid, token: { email: f.email, email_verified: true } } } as unknown as CallableRequest<unknown>
    const abortingRunner = <T>(fn: (txn: Transaction) => Promise<T>): Promise<T> => db.runTransaction(async txn => {
      await fn(txn)
      throw new Error('synthetic transaction failure before commit')
    })
    await expect(performAcceptInvite(req, abortingRunner)).rejects.toThrow('synthetic transaction failure')
    expect(await snapshot(f)).toEqual(before)
    await expect(callAcceptInvite(payload(f))).resolves.toEqual({ companyId: f.companyId })
  })

  it('serializes accept vs cancel with exactly one terminal action and no partial membership', async () => {
    const f = await setup()
    const before = await snapshot(f)
    const [accept, cancel] = await Promise.allSettled([
      callWithEmulatorIdentity(f.uid, 'acceptInvite', payload(f)),
      callWithEmulatorIdentity(f.adminUid, 'cancelInvite', { companyId: f.companyId, inviteId: f.inviteId }),
    ])
    expect([accept, cancel].filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const after = await snapshot(f)
    expect(after.audit).toHaveLength(before.audit.length + 1)
    if (accept.status === 'fulfilled') {
      expect(after.invitation?.status).toBe('accepted')
      expect(after.memberships).toHaveLength(before.memberships.length + 1)
      expect(cancel.status === 'rejected' && codeOf(cancel.reason)).toBe('invitation_not_pending')
    } else {
      expect(after.invitation?.status).toBe('revoked')
      expect(after.memberships).toEqual(before.memberships)
      expect(after.profile).toBeUndefined()
      expect(codeOf(accept.reason)).toBe('invite_revoked')
    }
  })

  it('serializes accept vs resend; if rotation wins only the newly returned token can be accepted', async () => {
    const f = await setup()
    const old = Timestamp.fromMillis(Date.now() - 120_000)
    await patchInvite(f, { createdAt: old, lastSentAt: old })
    const before = await snapshot(f)
    const [accept, resend] = await Promise.allSettled([
      callWithEmulatorIdentity(f.uid, 'acceptInvite', payload(f)),
      callWithEmulatorIdentity(f.adminUid, 'resendInvite', { companyId: f.companyId, inviteId: f.inviteId }),
    ])
    expect([accept, resend].filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const after = await snapshot(f)
    expect(after.audit).toHaveLength(before.audit.length + 1)
    if (accept.status === 'fulfilled') {
      expect(after.invitation?.status).toBe('accepted')
      expect(resend.status === 'rejected' && codeOf(resend.reason)).toBe('invitation_not_pending')
    } else {
      expect(codeOf(accept.reason)).toBe('invite_invalid')
      expect(after.memberships).toEqual(before.memberships)
      const replacement = (resend as PromiseFulfilledResult<unknown>).value as InviteLink
      await denial(f, 'invite_invalid')
      await expect(callAcceptInvite({ inviteId: f.inviteId, token: replacement.token })).resolves.toEqual({ companyId: f.companyId })
    }
  })

  it('pre-auth preview exposes only masked metadata and has no writes', async () => {
    const f = await setup()
    const before = await snapshot(f)
    await signOutClient()
    const result = PreviewInviteResponseSchema.parse(await callPreviewInvite(payload(f)))
    expect(result).toMatchObject({ companyDisplayName: 'SEC-003 Test Co', roleLabel: 'Бухгалтер', expiresAt: f.expiresAtUtc })
    const serialized = JSON.stringify(result)
    for (const secret of [f.email, f.companyId, f.uid, f.token, 'tokenHash']) expect(serialized).not.toContain(secret)
    expect(await snapshot(f)).toEqual(before)
  })

  it.each(['accepted', 'revoked', 'expired'])('preview exposes %s only with the correct token', async kind => {
    const f = await setup()
    if (kind === 'accepted') await callAcceptInvite(payload(f))
    if (kind === 'revoked') await patchInvite(f, { status: 'revoked', revokedAt: Timestamp.now(), revokedBy: f.adminUid })
    if (kind === 'expired') await patchInvite(f, { expiresAt: Timestamp.fromMillis(Date.now() - 60_000) })
    await signOutClient()
    const before = await snapshot(f)
    await expect(callPreviewInvite({ ...payload(f), token: Buffer.alloc(32, 8).toString('base64url') })).rejects.toSatisfy((err: unknown) => codeOf(err) === 'invite_invalid')
    await expect(callPreviewInvite(payload(f))).rejects.toSatisfy((err: unknown) => codeOf(err) === (kind === 'accepted' ? 'invite_already_used' : `invite_${kind}`))
    expect(await snapshot(f)).toEqual(before)
  })
})
