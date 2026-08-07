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
import type { RequestAuth } from './authz'

export interface AuditEventInput {
  companyId: string
  /**
   * The caller's server-verified identity — MUST be the value returned by
   * requireAuth(), never a bare string (independent review finding #2a on
   * SEC-003 PR #10: accepting `actorUid: string` let ANY string be recorded
   * as the actor, with no structural guarantee it ever passed through
   * platform auth verification). Typing this as `RequestAuth` makes it a
   * compile error to pass an arbitrary string — only a value shaped like
   * requireAuth()'s return type is accepted, and `actorUid` is derived
   * from `auth.uid` internally, never taken from anywhere else.
   */
  auth: RequestAuth
  action: string
  targetUid?: string
  metadata?: Record<string, string | number | boolean>
}

// Metadata is meant for small, non-sensitive tags (e.g. "fieldChanged:
// role") — never secrets. Key names matching this pattern are rejected
// outright as a defense-in-depth guard against an obvious misuse like
// `metadata: { password: '...' }` (independent review finding #2b on
// SEC-003 PR #10). This cannot verify VALUES are safe — callers are still
// responsible for that — but it catches the class of mistake demonstrated
// by the finding.
const SENSITIVE_METADATA_KEY_RE = /pass(word)?|token|secret|api[-_]?key|credential/i

function assertNoSensitiveMetadataKeys(metadata: Record<string, string | number | boolean>): void {
  for (const key of Object.keys(metadata)) {
    if (SENSITIVE_METADATA_KEY_RE.test(key)) {
      throw new Error(`writeAuditEvent: refusing metadata key that looks sensitive: "${key}"`)
    }
  }
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
  const metadata = input.metadata ?? {}
  assertNoSensitiveMetadataKeys(metadata)

  const ref = db
    .collection('companies').doc(input.companyId)
    .collection('audit_events').doc()

  const setCapableWriter: SetCapableWriter = writer
  setCapableWriter.set(ref, {
    action: input.action,
    actorUid: input.auth.uid,
    targetUid: input.targetUid ?? null,
    metadata,
    createdAt: FieldValue.serverTimestamp(),
  })
}
