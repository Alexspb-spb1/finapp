import { describe, it, expect } from 'vitest'
import { canonicalStringify, sha256Hex, computeRelationSetChecksum, computeDecisionsChecksum, sortRelations } from './checksum.ts'

describe('canonicalStringify', () => {
  it('is identical regardless of key insertion order', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }))
  })

  it('sorts nested object keys too', () => {
    expect(canonicalStringify({ outer: { z: 1, a: 2 } })).toBe(canonicalStringify({ outer: { a: 2, z: 1 } }))
  })

  it('preserves array order (arrays must be sorted by the caller)', () => {
    expect(canonicalStringify([1, 2, 3])).not.toBe(canonicalStringify([3, 2, 1]))
  })
})

describe('sha256Hex', () => {
  it('produces a fixed-length hex digest', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    expect(sha256Hex('x')).toBe(sha256Hex('x'))
  })
})

describe('sortRelations', () => {
  it('sorts by companyId then uid, independent of input order', () => {
    const a = [{ companyId: 'co_b', uid: 'u2' }, { companyId: 'co_a', uid: 'u9' }, { companyId: 'co_a', uid: 'u1' }]
    const sorted = sortRelations(a)
    expect(sorted.map(r => `${r.companyId}:${r.uid}`)).toEqual(['co_a:u1', 'co_a:u9', 'co_b:u2'])
  })
})

describe('computeRelationSetChecksum — order independence (task requirement)', () => {
  it('is identical for the same logical set in different input order', () => {
    const a = [
      { companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' },
      { companyId: 'co_b', uid: 'u2', role: 'viewer', status: 'active' },
    ]
    const b = [a[1]!, a[0]!]
    expect(computeRelationSetChecksum(a)).toBe(computeRelationSetChecksum(b))
  })

  it('differs when a role differs', () => {
    const a = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const b = [{ companyId: 'co_a', uid: 'u1', role: 'viewer', status: 'active' }]
    expect(computeRelationSetChecksum(a)).not.toBe(computeRelationSetChecksum(b))
  })

  it('treats a missing invitedBy the same as an explicit undefined (canonicalized to null)', () => {
    const a = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const b = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active', invitedBy: undefined }]
    expect(computeRelationSetChecksum(a)).toBe(computeRelationSetChecksum(b))
  })

  it('excludes timestamps entirely (not part of the LogicalRelation shape)', () => {
    // LogicalRelation has no createdAt/updatedAt field — this test documents
    // that omission is intentional (see module header comment).
    const a = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    expect(computeRelationSetChecksum(a)).toBe(computeRelationSetChecksum(a))
  })
})

describe('computeDecisionsChecksum', () => {
  it('is order-independent', () => {
    const a = [{ companyId: 'co_a', uid: 'u1', resolution: 'exclude' }, { companyId: 'co_b', uid: 'u2', resolution: 'confirm_role' }]
    const b = [a[1]!, a[0]!]
    expect(computeDecisionsChecksum(a)).toBe(computeDecisionsChecksum(b))
  })

  it('is deterministic for an empty array', () => {
    expect(computeDecisionsChecksum([])).toBe(computeDecisionsChecksum([]))
  })
})
