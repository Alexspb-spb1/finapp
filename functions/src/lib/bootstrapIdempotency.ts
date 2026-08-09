// Bootstrap idempotency — SEC-004.
//
// runIdempotent() (idempotency.ts) is bound to an EXISTING companyId — a
// first-time registrant has none yet, so it cannot be reused here without
// passing it a fake/client-supplied companyId (explicitly forbidden by the
// task). This module is a separate, narrowly-scoped mechanism for exactly
// one operation: a user's FIRST company bootstrap.
//
// Design: the receipt lives at a single, fixed path keyed ONLY by the
// caller's uid — `user_bootstrap/{uid}` — never by the idempotency key
// itself. This is what makes "one uid cannot create two first companies,
// even with different keys" hold: a second call with a different key still
// reads/writes the SAME receipt document, so Firestore's transaction
// optimistic-concurrency retry (the same mechanism assertNotLastAdmin
// relies on) forces a second concurrent caller to see the first caller's
// already-committed receipt before it can proceed.
//
// Same single-phase pattern as runIdempotent(): the receipt and the
// business mutation are written by the SAME `run()` callback inside ONE
// `db.runTransaction(...)` call, so there is no separate "in_progress"
// state that could get stuck.
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore'
import { AppError } from './errors'
import { computeFingerprint, validateIdempotencyKey } from './idempotency'

export interface RunBootstrapIdempotentParams<TResult> {
  db: Firestore
  /** Caller uid (from requireAuth(), never the payload) — the sole key for the receipt. */
  uid: string
  /** Client-supplied idempotency key. Never used directly as a Firestore path segment. */
  idempotencyKey: string
  payloadForFingerprint: unknown
  /** Performs the actual mutation. Must use `txn` for all its own writes. */
  run: (txn: Transaction) => Promise<TResult>
}

interface StoredBootstrapReceipt<TResult> {
  idempotencyKey: string
  fingerprint: string
  result: TResult
}

export async function runBootstrapIdempotent<TResult>(
  params: RunBootstrapIdempotentParams<TResult>,
): Promise<TResult> {
  const { db, uid, idempotencyKey, payloadForFingerprint, run } = params
  validateIdempotencyKey(idempotencyKey)

  const fingerprint = computeFingerprint(payloadForFingerprint)
  // Fixed, safe path — derived only from the trusted uid, never from the
  // raw idempotency key.
  const receiptRef = db.collection('user_bootstrap').doc(uid)

  return db.runTransaction(async txn => {
    // Must happen before any writes performed by `run()` — Firestore's
    // "all reads before all writes" transaction rule.
    const existing = await txn.get(receiptRef)
    if (existing.exists) {
      const stored = existing.data() as StoredBootstrapReceipt<TResult> | undefined
      if (!stored || stored.idempotencyKey !== idempotencyKey || stored.fingerprint !== fingerprint) {
        // Covers both: same key + different payload, AND a different key
        // entirely (a second "first company" attempt for the same uid).
        throw new AppError('idempotency_conflict')
      }
      // Same key + same fingerprint: return the already-committed result —
      // the business mutation is NOT re-run.
      return stored.result
    }

    const result = await run(txn)
    txn.set(receiptRef, {
      idempotencyKey,
      fingerprint,
      result,
      createdAt: FieldValue.serverTimestamp(),
    })
    return result
  })
}
