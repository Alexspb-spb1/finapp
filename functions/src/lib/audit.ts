// writeAuditEvent — SEC-003.
//
// Contract:
// - only ever called with Admin SDK access (this whole package is
//   server-only — see functions/src/lib/admin.ts);
// - `actorUid` MUST be the server-verified `request.auth.uid` from
//   requireAuth() — never a value taken from the request payload;
// - `createdAt` is a Firestore server timestamp, never a client-supplied
//   value;
// - never stores the raw request body, tokens, passwords, or unprocessed
//   error objects — only the structured fields below;
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

export interface AuditEventInput {
  companyId: string
  actorUid: string
  action: string
  targetUid?: string
  metadata?: Record<string, string | number | boolean>
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
  input: AuditEventInput,
): void {
  const ref = db
    .collection('companies').doc(input.companyId)
    .collection('audit_events').doc()

  const setCapableWriter: SetCapableWriter = writer
  setCapableWriter.set(ref, {
    action: input.action,
    actorUid: input.actorUid,
    targetUid: input.targetUid ?? null,
    metadata: input.metadata ?? {},
    createdAt: FieldValue.serverTimestamp(),
  })
}
