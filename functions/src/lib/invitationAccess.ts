// SEC-006 Stage 5: shared token-authenticated reads for accept and preview.
import { timingSafeEqual } from 'node:crypto'
import type { Firestore, Transaction, Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'
import { AppError } from './errors'
import {
  computeInvitationLockId, FirestoreDocumentIdSchema, InvitationDocumentSchema,
  InvitationLockDocumentSchema, TokenHashSchema, type InvitationDocument,
} from '../schemas/invitation'

/** Authenticate the digest BEFORE inspecting status or parsing the rest
 * of the document. Missing, malformed-hash and mismatched-hash records
 * share the same error. Fixed-size digest comparison also runs for a
 * missing record; this is not a claim of constant network response time. */
export function verifyInvitationToken(raw: unknown, tokenHash: string): InvitationDocument {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined
  const stored = TokenHashSchema.safeParse(record?.tokenHash)
  const supplied = TokenHashSchema.safeParse(tokenHash)
  const actual = Buffer.from(stored.success ? stored.data : '0'.repeat(64), 'hex')
  const expected = Buffer.from(supplied.success ? supplied.data : '0'.repeat(64), 'hex')
  const matches = timingSafeEqual(actual, expected)
  if (!stored.success || !supplied.success || !matches) throw new AppError('invite_invalid')
  const parsed = InvitationDocumentSchema.safeParse(raw)
  if (!parsed.success || !FirestoreDocumentIdSchema.safeParse(parsed.data.companyId).success) {
    throw new AppError('internal_error')
  }
  return parsed.data
}

export function requirePendingInvitation(
  invite: InvitationDocument, now: Timestamp,
): asserts invite is Extract<InvitationDocument, { status: 'pending' }> {
  if (invite.status === 'revoked') throw new AppError('invite_revoked')
  if (invite.status === 'accepted') throw new AppError('invite_already_used')
  if (now.toMillis() >= invite.expiresAt.toMillis()) throw new AppError('invite_expired')
  if (invite.createdAt.toMillis() > now.toMillis()
    || invite.expiresAt.toMillis() <= invite.createdAt.toMillis()
    || (invite.lastSentAt !== null && (invite.lastSentAt.toMillis() < invite.createdAt.toMillis()
      || invite.lastSentAt.toMillis() > now.toMillis()))) {
    throw new AppError('internal_error')
  }
}

export async function requireCurrentInvitationLock(
  db: Firestore, txn: Transaction, inviteId: string, invite: InvitationDocument,
): Promise<void> {
  const lockId = computeInvitationLockId(invite.companyId, invite.emailNormalized)
  const snap = await txn.get(db.collection('invitationLocks').doc(lockId))
  const parsed = InvitationLockDocumentSchema.safeParse(snap.data())
  if (!snap.exists || !parsed.success) throw new AppError('internal_error')
  if (parsed.data.currentInviteId !== inviteId) throw new AppError('invite_invalid')
}

const CompanyDisplaySchema = z.object({
  id: FirestoreDocumentIdSchema,
  name: z.string().trim().min(1).max(300),
}).strict()

export async function readInvitationCompanyName(db: Firestore, txn: Transaction, companyId: string): Promise<string> {
  const snap = await txn.get(db.collection('companies').doc(companyId))
  if (!snap.exists) throw new AppError('invite_invalid')
  const data = snap.data()
  // Only these two fields are consumed; no company metadata grants access.
  const parsed = CompanyDisplaySchema.safeParse({ id: data?.id, name: data?.name })
  if (!parsed.success || parsed.data.id !== companyId) throw new AppError('internal_error')
  return parsed.data.name
}

export function maskInvitationEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) throw new AppError('internal_error')
  const labels = domain.split('.')
  const first = local.length > 1 ? local[0] : ''
  const last = local.length > 2 ? local.at(-1) : ''
  const domainFirst = (labels[0]?.length ?? 0) > 1 ? labels[0]![0] : ''
  return `${first}***${last}@${domainFirst}***.${labels.at(-1)}`
}
