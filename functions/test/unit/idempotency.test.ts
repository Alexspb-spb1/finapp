import { describe, it, expect } from 'vitest'
import { computeFingerprint } from '../../src/lib/idempotency'

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
