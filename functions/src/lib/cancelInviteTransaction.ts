// The cancelInvite transaction body — SEC-006 Stage 3, structured exactly
// like lib/inviteMemberTransaction.ts (see that file's own comment for the
// full rationale): the caller (performCancelInvite, functions/src/index.ts)
// computes `revokedAtTimestamp` exactly once, BEFORE `db.runTransaction()`
// is ever called, and hands it in here already-generated. This module
// itself never computes "now" — so no matter how many times Firestore
// invokes it on an internal retry, every attempt writes the SAME
// `revokedAt` value; there is no code path here that could produce a
// different one. See test/unit/cancelInviteTransaction.test.ts for the
// accompanying proof (an injected transaction runner that invokes this
// twice).
import type { Firestore, Timestamp, Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { requireActiveMember, requireRole, requireNotInMaintenanceMode, type RequestAuth } from './authz'
import { AppError } from './errors'
import { writeAuditEvent } from './audit'
import { InvitationDocumentSchema, type CancelInviteRequest } from '../schemas/invitation'

export interface CancelInviteGeneratedValues {
  revokedAtTimestamp: Timestamp
}

export interface RunCancelInviteTransactionParams {
  db: Firestore
  txn: Transaction
  request: CallableRequest<unknown>
  auth: RequestAuth
  input: CancelInviteRequest
  generated: CancelInviteGeneratedValues
}

export async function runCancelInviteTransaction(params: RunCancelInviteTransactionParams): Promise<void> {
  const { db, txn, request, auth, input, generated } = params
  const { revokedAtTimestamp } = generated

  // Must stay the first statement — see requireNotInMaintenanceMode's own
  // doc comment (lib/authz.ts).
  await requireNotInMaintenanceMode(db, txn)

  const membership = await requireActiveMember(db, input.companyId, auth.uid, txn)
  requireRole(membership, ['admin'])

  const inviteRef = db.collection('invitations').doc(input.inviteId)
  const inviteSnap = await txn.get(inviteRef)

  // Missing and cross-company are DELIBERATELY the same outcome as each
  // other (invitation_not_found) — an admin of company B supplying an
  // inviteId that genuinely belongs to company A must see exactly the
  // same result as supplying an ID that doesn't exist at all. Distinct
  // outcomes here would let a caller enumerate which inviteIds exist in
  // OTHER companies purely from the error shape.
  if (!inviteSnap.exists) throw new AppError('invitation_not_found')

  const parsed = InvitationDocumentSchema.safeParse(inviteSnap.data())
  // A corrupted document is a distinct, genuine data-integrity problem —
  // never attacker-reachable through ordinary input (Rules deny all
  // client writes to this collection), so giving it its own generic
  // internal_error rather than folding it into invitation_not_found does
  // not create a guessable-ID oracle; it matches how every other
  // corrupted-document case in this package is already handled
  // (runInviteMemberTransaction, performListInvitations).
  if (!parsed.success) throw new AppError('internal_error')

  const invite = parsed.data
  if (invite.companyId !== input.companyId) throw new AppError('invitation_not_found')
  if (invite.status !== 'pending') throw new AppError('invitation_not_pending')

  // The invitationLocks/{lockId} entry for this invitation's
  // (companyId, emailNormalized) pair is deliberately left untouched: a
  // lock pointing at a now-revoked invitation is already treated as
  // safely replaceable by inviteMember's own lock-check (a 'revoked'
  // target behind the lock is never `invitation_already_pending` — see
  // runInviteMemberTransaction). There is nothing for cancelInvite to
  // clean up.
  txn.update(inviteRef, {
    status: 'revoked',
    revokedAt: revokedAtTimestamp,
    revokedBy: auth.uid,
    updatedAt: revokedAtTimestamp,
  })

  writeAuditEvent(db, txn, request, { companyId: input.companyId, action: 'invitation_cancelled' })
}
