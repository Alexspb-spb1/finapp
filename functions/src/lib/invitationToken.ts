// Invitation token generation/hashing + pending-document payload builder —
// SEC-006 Stage 2.
//
// Hard rule: the raw token is generated exactly once per inviteMember call,
// BEFORE the Firestore transaction starts (see functions/src/index.ts), and
// is reused verbatim across any internal transaction retry — never
// regenerated inside the transaction body. Only its SHA-256 hash
// (tokenHash) is ever persisted; the raw token itself is never a Firestore
// field, never a document ID, never logged, and is returned to the caller
// exactly once, in the callable's single successful response.
import { randomBytes as nodeRandomBytes, createHash } from 'node:crypto'
import type { Timestamp, FieldValue } from 'firebase-admin/firestore'
import type { Role } from '../schemas/auth'

/** 256 random bits, base64url-encoded without padding — exactly 43
 * characters. `randomBytesImpl` is injectable so unit tests can assert the
 * generator requests exactly 32 bytes from its entropy source without
 * relying on the real (non-deterministic) RNG for that specific assertion;
 * production code always uses the default (real `crypto.randomBytes`). */
export function generateRawInvitationToken(
  randomBytesImpl: (size: number) => Buffer = nodeRandomBytes,
): string {
  return randomBytesImpl(32).toString('base64url')
}

/** Lowercase hex SHA-256 digest of the raw token — the only form of the
 * token ever persisted (see TokenHashSchema in schemas/invitation.ts). */
export function hashInvitationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

export interface PendingInvitationFields {
  companyId: string
  emailNormalized: string
  role: Role
  tokenHash: string
  expiresAt: Timestamp
  createdBy: string
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
  lastSentAt: Timestamp | FieldValue
}

/** Builds the exact Firestore payload for a new pending invitation. Takes
 * `tokenHash` — never a raw token — so a caller cannot even accidentally
 * pass the raw token in: there is no parameter for it, and no code path
 * inside this function ever touches or derives one. The shape matches the
 * 'pending' variant of `InvitationDocumentSchema` exactly (verified by a
 * unit test that round-trips real output through that schema). */
export function buildPendingInvitationDocument(
  fields: PendingInvitationFields,
): Record<string, unknown> {
  return {
    companyId: fields.companyId,
    emailNormalized: fields.emailNormalized,
    role: fields.role,
    tokenHash: fields.tokenHash,
    status: 'pending' as const,
    expiresAt: fields.expiresAt,
    createdBy: fields.createdBy,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    resendCount: 0,
    lastSentAt: fields.lastSentAt,
  }
}
