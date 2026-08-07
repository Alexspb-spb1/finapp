import { describe, it, expect } from 'vitest'
import { computeFingerprint, buildIdempotencyReceiptId } from '../../src/lib/idempotency'

describe('computeFingerprint', () => {
  it('is deterministic for the same payload', () => {
    const payload = { companyId: 'co_a', role: 'admin', subjectUid: 'uid_1' }
    expect(computeFingerprint(payload)).toBe(computeFingerprint(payload))
  })

  it('is identical regardless of key insertion order', () => {
    const a = { companyId: 'co_a', role: 'admin' }
    const b = { role: 'admin', companyId: 'co_a' }
    expect(computeFingerprint(a)).toBe(computeFingerprint(b))
  })

  it('differs when the payload content differs', () => {
    const a = { companyId: 'co_a', role: 'admin' }
    const b = { companyId: 'co_a', role: 'viewer' }
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(b))
  })

  it('differs for nested object payloads with different values', () => {
    const a = { outer: { inner: 1 } }
    const b = { outer: { inner: 2 } }
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(b))
  })

  it('is identical for nested objects with different key order', () => {
    const a = { outer: { x: 1, y: 2 } }
    const b = { outer: { y: 2, x: 1 } }
    expect(computeFingerprint(a)).toBe(computeFingerprint(b))
  })

  it('produces a fixed-length hex digest regardless of input size', () => {
    const short = computeFingerprint({ a: 1 })
    const long = computeFingerprint({ a: 'x'.repeat(5000) })
    expect(short).toMatch(/^[0-9a-f]{64}$/)
    expect(long).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('buildIdempotencyReceiptId — scope/key collision safety (independent review finding #4)', () => {
  it('does not collide when the caller-uid/key boundary shifts across a naive separator character', () => {
    // Naive `${operation}:${companyId}:${callerUid}:${rawKey}` string
    // concatenation would make these two produce the IDENTICAL string
    // "op:co:u:v:w" — an unambiguous serialization must tell them apart.
    const a = buildIdempotencyReceiptId({ operation: 'op', companyId: 'co', callerUid: 'u:v' }, 'w')
    const b = buildIdempotencyReceiptId({ operation: 'op', companyId: 'co', callerUid: 'u' }, 'v:w')
    expect(a).not.toBe(b)
  })

  it('does not collide when the operation/companyId boundary shifts', () => {
    const a = buildIdempotencyReceiptId({ operation: 'op:extra', companyId: 'co', callerUid: 'u' }, 'k')
    const b = buildIdempotencyReceiptId({ operation: 'op', companyId: 'extra:co', callerUid: 'u' }, 'k')
    expect(a).not.toBe(b)
  })

  it('is deterministic for identical scope + key', () => {
    const scope = { operation: 'op', companyId: 'co', callerUid: 'u' }
    expect(buildIdempotencyReceiptId(scope, 'k')).toBe(buildIdempotencyReceiptId(scope, 'k'))
  })

  it('differs when only the key differs', () => {
    const scope = { operation: 'op', companyId: 'co', callerUid: 'u' }
    expect(buildIdempotencyReceiptId(scope, 'k1')).not.toBe(buildIdempotencyReceiptId(scope, 'k2'))
  })
})
