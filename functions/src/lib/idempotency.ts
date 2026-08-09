// Transaction-safe idempotency foundation — SEC-003.
//
// Design: the idempotency "receipt" (fingerprint + stored result) and the
// business mutation it guards are written by the SAME `run()` callback
// inside ONE `db.runTransaction(...)` call. There is no separate "mark as
// in_progress, do the work, mark as done" two-phase sequence — Firestore
// transactions are all-or-nothing, so either both the receipt and the
// mutation commit together, or neither does. This deliberately avoids the
// unsafe pattern where a crash between phase 1 and phase 2 leaves a
// permanent `in_progress` receipt that never resolves and blocks all
// future retries with the same key.
//
// Scope: this module only covers Firestore-transaction mutations. It does
// NOT provide any safety for external network side effects (e.g. calling a
// third-party API) performed inside `run()` — those are not idempotent
// through this mechanism and must not be added here without a separate,
// explicit design.
import { createHash } from 'node:crypto'
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore'
import { AppError } from './errors'

const MAX_IDEMPOTENCY_KEY_LENGTH = 200

export interface IdempotencyScope {
  /** Stable name of the command, e.g. "setMemberRole". Prevents the same raw key from colliding across unrelated operations. */
  operation: string
  companyId: string
  callerUid: string
}

export interface RunIdempotentParams<TResult> {
  db: Firestore
  scope: IdempotencyScope
  /** Client-supplied idempotency key. Never used directly as a Firestore path segment — always hashed together with `scope` first. */
  idempotencyKey: string
  /** The already-validated request payload (or any deterministic value derived from it) used to compute the request fingerprint. */
  payloadForFingerprint: unknown
  /** Performs the actual mutation. Must use `txn` for all its own reads/writes so it stays part of the same atomic transaction as the receipt. */
  run: (txn: Transaction) => Promise<TResult>
}

interface StoredReceipt<TResult> {
  fingerprint: string
  result: TResult
}

export function validateIdempotencyKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new AppError('invalid_request')
  }
}

/** Deterministic key-sorted JSON, so two structurally-equal payloads with
 * different key insertion order fingerprint identically. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeysDeep(source[key])
    return sorted
  }
  return value
}

export function computeFingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeysDeep(payload))).digest('hex')
}

/** The raw key is NEVER used as a path segment on its own — it is always
 * combined with `operation`/`companyId`/`callerUid` and hashed, so it can
 * never be used to construct or collide with an unrelated/unsafe Firestore
 * path, and the resulting doc ID has a fixed, safe length regardless of
 * what the caller passed as the key.
 *
 * The four components are combined via `JSON.stringify` of an array, NOT
 * naive `:`-joined string concatenation (independent review finding #4 on
 * SEC-003 PR #10): a plain separator lets the boundary between components
 * shift — e.g. `operation:companyId:"u:v":"w"` and
 * `operation:companyId:"u":"v:w"` would hash identically under naive
 * joining, breaking per-caller isolation. `JSON.stringify` quotes and
 * escapes each element, so no component's content can forge a fake
 * boundary between elements. */
export function buildIdempotencyReceiptId(scope: IdempotencyScope, rawKey: string): string {
  const serialized = JSON.stringify([scope.operation, scope.companyId, scope.callerUid, rawKey])
  return createHash('sha256').update(serialized).digest('hex')
}

export async function runIdempotent<TResult>(params: RunIdempotentParams<TResult>): Promise<TResult> {
  const { db, scope, idempotencyKey, payloadForFingerprint, run } = params
  validateIdempotencyKey(idempotencyKey)

  const receiptId = buildIdempotencyReceiptId(scope, idempotencyKey)
  const fingerprint = computeFingerprint(payloadForFingerprint)
  const receiptRef = db
    .collection('companies').doc(scope.companyId)
    .collection('idempotency_receipts').doc(receiptId)

  return db.runTransaction(async txn => {
    // This read must happen before any writes performed by `run()` — see
    // Firestore's "all reads before all writes" transaction rule.
    const existing = await txn.get(receiptRef)
    if (existing.exists) {
      const stored = existing.data() as StoredReceipt<TResult> | undefined
      if (!stored || stored.fingerprint !== fingerprint) {
        throw new AppError('idempotency_conflict')
      }
      // Same key + same fingerprint: return the already-committed result —
      // the business mutation is NOT re-run.
      return stored.result
    }

    const result = await run(txn)
    txn.set(receiptRef, {
      fingerprint,
      result,
      createdAt: FieldValue.serverTimestamp(),
    })
    return result
  })
}
