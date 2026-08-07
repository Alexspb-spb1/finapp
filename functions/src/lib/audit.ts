// writeAuditEvent — SEC-003.
//
// Contract:
// - only ever called with Admin SDK access (this whole package is
//   server-only — see functions/src/lib/admin.ts);
// - `actorUid` can ONLY come from requireAuth(request).uid — this function
//   takes the raw CallableRequest and calls requireAuth() on it itself
//   (independent review finding #1, round 2 on SEC-003 PR #10). There is
//   no way to call writeAuditEvent with a caller-constructed identity: a
//   spoofed `uid`/`actorUid` field inside `request.data` (the payload) is
//   never consulted, and an unauthenticated request (`request.auth`
//   missing) makes this function throw `auth_required` before anything is
//   written;
// - `createdAt` is a Firestore server timestamp, never a client-supplied
//   value;
// - there is NO metadata/free-form field on this contract at all
//   (independent review finding #2, round 2 on SEC-003 PR #10) — only the
//   fixed, named fields below are ever written, and `input` is never
//   spread wholesale into the Firestore payload, so no caller-added
//   property (via a TypeScript-bypassing cast or otherwise) can ever reach
//   Firestore;
// - writes through the SAME transaction/batch as the command that
//   triggered the event, so the audit record and the mutation it describes
//   commit atomically (both, or neither).
import {
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type Transaction,
  type WriteBatch,
} from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { requireAuth } from './authz'

export interface AuditEventInput {
  companyId: string
  action: string
  targetUid?: string
}

// Transaction.set and WriteBatch.set are both overloaded, and TypeScript
// cannot call a method through a `Transaction | WriteBatch` union when the
// two sides' overload sets aren't call-compatible. Both types structurally
// satisfy this single-signature interface, which is all writeAuditEvent
// actually needs.
interface SetCapableWriter {
  set(ref: DocumentReference, data: DocumentData): unknown
}

export function writeAuditEvent(
  db: Firestore,
  writer: Transaction | WriteBatch,
  request: CallableRequest<unknown>,
  input: AuditEventInput,
): void {
  // The ONLY source of actorUid. Throws `auth_required` (via AppError) if
  // `request.auth` is missing — propagates out of this function and out
  // of the enclosing transaction, so nothing is ever written for an
  // unauthenticated caller.
  const auth = requireAuth(request)

  const ref = db
    .collection('companies').doc(input.companyId)
    .collection('audit_events').doc()

  const setCapableWriter: SetCapableWriter = writer
  setCapableWriter.set(ref, {
    action: input.action,
    actorUid: auth.uid,
    targetUid: input.targetUid ?? null,
    createdAt: FieldValue.serverTimestamp(),
  })
}
