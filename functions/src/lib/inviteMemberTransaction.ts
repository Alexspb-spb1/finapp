// The inviteMember transaction body — SEC-006 Stage 2, extracted from
// functions/src/index.ts so it can be unit-tested directly with a fake
// Transaction, independent of the real Functions/Firestore Emulator.
//
// Hard structural guarantee: this module imports NEITHER
// `generateRawInvitationToken` nor `hashInvitationToken` (lib/invitationToken.ts)
// nor `node:crypto` — the raw token, its hash, the new inviteId, and
// expiresAt are computed exactly once by the caller (performInviteMember in
// functions/src/index.ts), BEFORE `db.runTransaction()` is ever called, and
// handed in here as already-generated values. Because this function has no
// import that could regenerate any of them, calling it more than once (as
// Firestore does on an internal transaction retry) cannot possibly produce
// a different token/tokenHash/inviteId — there is no code path here that
// could. See test/unit/inviteMemberTransaction.test.ts for the accompanying
// behavioral proof (an injected transaction runner that invokes this twice).
import { FieldValue, type Firestore, type Timestamp, type Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { requireActiveMember, requireRole, requireNotInMaintenanceMode, type RequestAuth } from './authz'
import { AppError } from './errors'
import { writeAuditEvent } from './audit'
import { buildPendingInvitationDocument } from './invitationToken'
import {
  InvitationLockDocumentSchema,
  InvitationDocumentSchema,
  computeInvitationLockId,
  type InviteMemberRequest,
} from '../schemas/invitation'

export interface InviteMemberGeneratedValues {
  tokenHash: string
  inviteId: string
  expiresAtTimestamp: Timestamp
}

export interface RunInviteMemberTransactionParams {
  db: Firestore
  txn: Transaction
  request: CallableRequest<unknown>
  auth: RequestAuth
  input: InviteMemberRequest
  generated: InviteMemberGeneratedValues
}

export async function runInviteMemberTransaction(params: RunInviteMemberTransactionParams): Promise<void> {
  const { db, txn, request, auth, input, generated } = params
  const { tokenHash, inviteId, expiresAtTimestamp } = generated

  // Must stay the first statement — see requireNotInMaintenanceMode's own
  // doc comment (lib/authz.ts) on why this closes the TOCTOU window via
  // Firestore's transactional read-set retry.
  await requireNotInMaintenanceMode(db, txn)

  const membership = await requireActiveMember(db, input.companyId, auth.uid, txn)
  requireRole(membership, ['admin'])

  const lockId = computeInvitationLockId(input.companyId, input.email)
  const lockRef = db.collection('invitationLocks').doc(lockId)
  const inviteRef = db.collection('invitations').doc(inviteId)

  // All reads before all writes: resolve the lock (and, if present, the
  // invitation it points to) before any txn.set() below.
  const lockSnap = await txn.get(lockRef)
  if (lockSnap.exists) {
    const lockParsed = InvitationLockDocumentSchema.safeParse(lockSnap.data())
    if (!lockParsed.success) throw new AppError('internal_error')

    const existingInviteRef = db.collection('invitations').doc(lockParsed.data.currentInviteId)
    const existingInviteSnap = await txn.get(existingInviteRef)
    if (!existingInviteSnap.exists) throw new AppError('internal_error')

    const existingInviteParsed = InvitationDocumentSchema.safeParse(existingInviteSnap.data())
    if (!existingInviteParsed.success) throw new AppError('internal_error')

    const existingInvite = existingInviteParsed.data
    if (existingInvite.companyId !== input.companyId || existingInvite.emailNormalized !== input.email) {
      throw new AppError('internal_error')
    }

    if (existingInvite.status === 'pending' && existingInvite.expiresAt.toMillis() > Date.now()) {
      // Still pending and not expired — refuse, change nothing.
      throw new AppError('invitation_already_pending')
    }
    // expired-pending / accepted / revoked — safe to atomically replace
    // the lock with the new invitation created below.
  }

  const serverNow = FieldValue.serverTimestamp()
  txn.set(inviteRef, buildPendingInvitationDocument({
    companyId: input.companyId,
    emailNormalized: input.email,
    role: input.role,
    tokenHash,
    expiresAt: expiresAtTimestamp,
    createdBy: auth.uid,
    createdAt: serverNow,
    updatedAt: serverNow,
    lastSentAt: serverNow,
  }))

  txn.set(lockRef, { currentInviteId: inviteId })

  writeAuditEvent(db, txn, request, { companyId: input.companyId, action: 'member_invited' })
}
