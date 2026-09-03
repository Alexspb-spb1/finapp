// listInvitations — cursor codec + response mapping — SEC-006 Stage 2b.
//
// Two independently-testable pure pieces, deliberately kept separate from
// the Firestore query itself (functions/src/index.ts):
//   - encode/decodeInvitationsCursor: opaque base64url <-> strict versioned
//     JSON payload, never client-trusted without full re-validation.
//   - mapInvitationDocumentToListItem: the ONLY place a stored invitation
//     document's fields are read to build a response item — an explicit
//     field-by-field allowlist, never `{...doc}`, so tokenHash/lockId/
//     acceptedByUid/revokedBy/etc. cannot leak through this response no
//     matter what the schema evolves to include later.
import type { Timestamp } from 'firebase-admin/firestore'
import { AppError } from './errors'
import {
  InvitationsCursorPayloadSchema,
  INVITATIONS_CURSOR_VERSION,
  type InvitationsCursorPayload,
  type InvitationDocument,
  type InvitationListItem,
} from '../schemas/invitation'

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/** Builds the opaque cursor string for a given payload. Internal — callers
 * outside this module should use `buildInvitationsCursor` instead, which
 * derives the payload from a Firestore Timestamp + inviteId directly
 * (avoiding any bare-milliseconds conversion). */
export function encodeInvitationsCursor(payload: InvitationsCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Derives and encodes the "resume from here" cursor for the last item on
 * a page — takes the real Firestore Timestamp (never milliseconds) so
 * `seconds`/`nanoseconds` are preserved exactly. */
export function buildInvitationsCursor(companyId: string, createdAt: Timestamp, inviteId: string): string {
  return encodeInvitationsCursor({
    version: INVITATIONS_CURSOR_VERSION,
    companyId,
    createdAtSeconds: createdAt.seconds,
    createdAtNanoseconds: createdAt.nanoseconds,
    inviteId,
  })
}

/** Decodes and fully validates an incoming cursor string. Fails closed
 * (throws `AppError('invalid_request')`) on: non-base64url characters,
 * invalid base64url padding/content, non-JSON payload, wrong shape/types,
 * out-of-range values, unknown fields, or an unsupported `version`. Never
 * throws anything but AppError — no raw parse error/stack ever escapes. */
export function decodeInvitationsCursor(raw: string): InvitationsCursorPayload {
  if (!BASE64URL_PATTERN.test(raw)) throw new AppError('invalid_request')

  let json: string
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    throw new AppError('invalid_request')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new AppError('invalid_request')
  }

  const result = InvitationsCursorPayloadSchema.safeParse(parsed)
  if (!result.success) throw new AppError('invalid_request')
  return result.data
}

/** The ONLY function permitted to read fields off a validated
 * `InvitationDocument` to build a `listInvitations` response item — a
 * fixed, explicit allowlist. `inviteId` is passed separately because it is
 * the Firestore document ID, not a field stored inside the document data
 * itself. */
export function mapInvitationDocumentToListItem(inviteId: string, doc: InvitationDocument): InvitationListItem {
  return {
    inviteId,
    emailNormalized: doc.emailNormalized,
    role: doc.role,
    status: doc.status,
    createdAtUtc: doc.createdAt.toDate().toISOString(),
    expiresAtUtc: doc.expiresAt.toDate().toISOString(),
    resendCount: doc.resendCount,
    lastSentAtUtc: doc.lastSentAt ? doc.lastSentAt.toDate().toISOString() : null,
    createdBy: doc.createdBy,
  }
}
