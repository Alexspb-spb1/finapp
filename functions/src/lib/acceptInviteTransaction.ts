// SEC-006 Stage 5. Every read and write participates in the same Firestore
// transaction. Same-UID accepted retries return before any membership,
// profile or lock access, so later revocation cannot be undone by replay.
import { FieldValue, type Firestore, type Transaction, type Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { requireNotInMaintenanceMode, requireVerifiedEmail, type RequestAuth } from './authz'
import { AppError } from './errors'
import { writeAuditEvent } from './audit'
import { MembershipSchema } from '../schemas/auth'
import { NormalizedEmailSchema, type AcceptInviteResponse } from '../schemas/invitation'
import { verifyInvitationToken, requirePendingInvitation, requireCurrentInvitationLock, readInvitationCompanyName } from './invitationAccess'
import { buildAcceptedInvitationProfile } from './invitationProfileBridge'

export async function runAcceptInviteTransaction(input: {
  db: Firestore; txn: Transaction; request: CallableRequest<unknown>; auth: RequestAuth;
  inviteId: string; tokenHash: string; now: Timestamp;
}): Promise<AcceptInviteResponse> {
  const { db, txn, request, auth, inviteId, tokenHash, now } = input
  await requireNotInMaintenanceMode(db, txn)
  requireVerifiedEmail(auth)
  const inviteRef = db.collection('invitations').doc(inviteId)
  const snap = await txn.get(inviteRef)
  const invite = verifyInvitationToken(snap.data(), tokenHash)
  if (invite.status === 'accepted') {
    if (invite.acceptedByUid !== auth.uid) throw new AppError('invite_already_used')
    return { companyId: invite.companyId }
  }
  requirePendingInvitation(invite, now)
  const email = NormalizedEmailSchema.safeParse(auth.token.email)
  if (!email.success || email.data !== invite.emailNormalized) throw new AppError('invite_invalid')
  await requireCurrentInvitationLock(db, txn, inviteId, invite)
  await readInvitationCompanyName(db, txn, invite.companyId)

  const memberRef = db.collection('companies').doc(invite.companyId).collection('members').doc(auth.uid)
  const memberSnap = await txn.get(memberRef)
  const member = memberSnap.exists ? MembershipSchema.safeParse(memberSnap.data()) : undefined
  if (member && (!member.success || member.data.uid !== auth.uid)) throw new AppError('membership_data_error')
  const existing = member?.success ? member.data : undefined
  if (existing?.status === 'active' && existing.role !== invite.role) throw new AppError('membership_conflict')

  const profileRef = db.collection('users').doc(auth.uid)
  const profileSnap = await txn.get(profileRef)
  const claimedName: unknown = auth.token.name
  const name = typeof claimedName === 'string' && claimedName.trim().length > 0
    ? claimedName.trim().slice(0, 200) : 'Приглашённый пользователь'
  const profile = buildAcceptedInvitationProfile(profileSnap.data(), {
    uid: auth.uid, email: email.data, name, companyId: invite.companyId,
    role: invite.role, createdAt: now.toDate().toISOString(),
  })

  // All validation and reads finish above. A later failure aborts this
  // transaction, including the bridge and audit; no independent writes.
  const serverNow = FieldValue.serverTimestamp()
  if (existing?.status !== 'active') {
    txn.set(memberRef, {
      uid: auth.uid, role: invite.role, status: 'active',
      createdAt: existing?.createdAt ?? serverNow, updatedAt: serverNow,
      invitedBy: invite.createdBy,
    })
  }
  txn.set(profileRef, profile)
  txn.update(inviteRef, { status: 'accepted', acceptedAt: serverNow, acceptedByUid: auth.uid, updatedAt: serverNow })
  writeAuditEvent(db, txn, request, { companyId: invite.companyId, action: 'invite_accepted', targetUid: auth.uid })
  return { companyId: invite.companyId }
}
