// The resendInvite transaction body — SEC-006 Stage 4, structured exactly
// like lib/cancelInviteTransaction.ts (see that file's own comment for the
// full rationale): the caller (performResendInvite, functions/src/index.ts)
// computes `tokenHash`, `expiresAtTimestamp`, and `nowTimestamp` exactly
// once, BEFORE `db.runTransaction()` is ever called, and hands them in
// here already-generated. This module itself never generates a token,
// hashes one, or computes "now" — so no matter how many times Firestore
// invokes it on an internal retry, every attempt writes the SAME values;
// there is no code path here that could produce different ones. See
// test/unit/resendInviteTransaction.test.ts for the accompanying proof
// (an injected transaction runner that invokes this twice).
import type { Firestore, Timestamp, Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { requireActiveMember, requireRole, requireNotInMaintenanceMode, type RequestAuth } from './authz'
import { AppError } from './errors'
import { writeAuditEvent } from './audit'
import {
  InvitationDocumentSchema,
  InvitationLockDocumentSchema,
  computeInvitationLockId,
  INVITATION_RESEND_COOLDOWN_MS,
  INVITATION_RESEND_LIMIT,
  type ResendInviteRequest,
} from '../schemas/invitation'

export interface ResendInviteGeneratedValues {
  tokenHash: string
  expiresAtTimestamp: Timestamp
  /** The server's own "now", captured once by the caller before the
   * transaction — used for both the cooldown check and the new
   * `lastSentAt` value, so a single logical call always evaluates the
   * cooldown against the same instant it will record. */
  nowTimestamp: Timestamp
}

export interface RunResendInviteTransactionParams {
  db: Firestore
  txn: Transaction
  request: CallableRequest<unknown>
  auth: RequestAuth
  input: ResendInviteRequest
  generated: ResendInviteGeneratedValues
}

export async function runResendInviteTransaction(params: RunResendInviteTransactionParams): Promise<void> {
  const { db, txn, request, auth, input, generated } = params
  const { tokenHash, expiresAtTimestamp, nowTimestamp } = generated

  // Must stay the first statement — see requireNotInMaintenanceMode's own
  // doc comment (lib/authz.ts).
  await requireNotInMaintenanceMode(db, txn)

  const membership = await requireActiveMember(db, input.companyId, auth.uid, txn)
  requireRole(membership, ['admin'])

  const inviteRef = db.collection('invitations').doc(input.inviteId)
  const inviteSnap = await txn.get(inviteRef)

  // Missing and cross-company are the SAME outcome — see
  // cancelInviteTransaction.ts's identical comment (SEC-006 Stage 3
  // independent review finding #1): no oracle for guessing another
  // company's inviteId.
  if (!inviteSnap.exists) throw new AppError('invitation_not_found')

  // Raw, pre-validation company check BEFORE full schema validation — same
  // reasoning as cancelInviteTransaction.ts: a corrupted document
  // belonging to a foreign company must resolve identically to a missing
  // one, never `internal_error`.
  const rawData = inviteSnap.data()
  if (!rawData || typeof rawData.companyId !== 'string' || rawData.companyId !== input.companyId) {
    throw new AppError('invitation_not_found')
  }

  const parsed = InvitationDocumentSchema.safeParse(rawData)
  if (!parsed.success) throw new AppError('internal_error')

  const invite = parsed.data
  if (invite.status !== 'pending') throw new AppError('invitation_not_pending')

  // The lock check is Stage 4's own required addition on top of the
  // pending-status check: `inviteMember` already knows how to atomically
  // replace an expired-but-still-`pending` invitation with a brand new
  // one, repointing `invitationLocks/{lockId}` at the NEW inviteId — but
  // it never touches the OLD invitation document itself, which is left
  // behind still carrying `status: 'pending'`. Without this check,
  // resendInvite would happily "resurrect" that already-superseded old
  // invitation by minting it a fresh token, even though the lock (the
  // single source of truth for "which invitation is currently active for
  // this email") has already moved on to a different inviteId. All three
  // failure shapes here (lock missing, lock corrupted, lock pointing
  // elsewhere) are folded into the same generic `internal_error` and
  // never auto-repaired — this mirrors how every other "the auxiliary
  // Firestore state doesn't check out" case in this package is handled
  // (never disclosing which specific invariant broke), and is
  // deliberately NOT a new, more specific error code: the task only
  // requires refusing without writing, not distinguishing these cases for
  // the client.
  const lockId = computeInvitationLockId(invite.companyId, invite.emailNormalized)
  const lockRef = db.collection('invitationLocks').doc(lockId)
  const lockSnap = await txn.get(lockRef)
  if (!lockSnap.exists) throw new AppError('internal_error')

  const lockParsed = InvitationLockDocumentSchema.safeParse(lockSnap.data())
  if (!lockParsed.success) throw new AppError('internal_error')
  if (lockParsed.data.currentInviteId !== input.inviteId) throw new AppError('internal_error')

  // Resend limit: exactly 5 successful resends allowed on top of the
  // original creation (resendCount starts at 0). Once resendCount reaches
  // the limit, no further resend is possible — the invitation can still
  // be read/cancelled, just never resent again.
  if (invite.resendCount >= INVITATION_RESEND_LIMIT) throw new AppError('invitation_resend_limit_reached')

  // Cooldown: measured from the later of `lastSentAt` (if this invitation
  // has ever been resent before) or `createdAt` (the very first send, for
  // which the schema allows `lastSentAt === null`). Exactly 60s elapsed
  // is ALLOWED (`elapsed < COOLDOWN_MS` is the only rejection condition,
  // never `<=`); anything less is refused. Both `lastSentAt`/`createdAt`
  // are server-authored Firestore Timestamps that can never be
  // client-supplied (Rules deny all client writes to this collection, and
  // `InvitationDocumentSchema` only accepts real `Timestamp` instances),
  // so there is no forged-input path that could shorten this window.
  const lastActivityMillis = (invite.lastSentAt ?? invite.createdAt).toMillis()
  const elapsedMs = nowTimestamp.toMillis() - lastActivityMillis
  if (elapsedMs < INVITATION_RESEND_COOLDOWN_MS) throw new AppError('invitation_resend_cooldown')

  // Only these fields ever change. inviteId/companyId/emailNormalized/
  // role/status/createdAt/createdBy are all left completely untouched by
  // `.update()` — never re-derived, never re-written.
  txn.update(inviteRef, {
    tokenHash,
    expiresAt: expiresAtTimestamp,
    resendCount: invite.resendCount + 1,
    lastSentAt: nowTimestamp,
    updatedAt: nowTimestamp,
  })

  // invitationLocks/{lockId} itself is NOT modified — it already points
  // at this exact inviteId (verified above), and resending doesn't change
  // which invitation is the active one for this (companyId, email) pair.
  writeAuditEvent(db, txn, request, { companyId: input.companyId, action: 'invitation_resent' })
}
