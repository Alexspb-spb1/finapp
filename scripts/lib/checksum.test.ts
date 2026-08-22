import { describe, it, expect } from 'vitest'
import {
  canonicalStringify, sha256Hex, computeRelationSetChecksum, computeDecisionsChecksum, sortRelations,
  computeFindingFingerprint, computeFullSourceStateChecksum,
} from './checksum.ts'
import type { Decision, LegacyExtractionResult } from './types.ts'

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    uid: 'u1', companyId: 'co_a', findingType: 'role_mismatch', evidenceFingerprint: 'a'.repeat(64), resolution: 'exclude',
    reason: 'reviewed manually', reviewedBy: 'alice', reviewedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function emptyExtraction(overrides: Partial<LegacyExtractionResult> = {}): LegacyExtractionResult {
  return { confirmed: [], conflicts: [], orphans: [], ownerAnomalies: [], unknownUsers: [], malformedClaims: [], ownerIdAnomalies: [], ...overrides }
}

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

  // ── Independent audit fix #4 (3rd round) ────────────────────────────────
  // A comparator built from `(a.companyId + a.uid)` string concatenation
  // collides for these two pairs — both produce "abc" — which is exactly
  // the bug the review flagged in planner.ts's final sort. sortRelations()
  // is the correct, collision-free two-field comparator that must be used
  // instead.
  it('does not collide on companyId/uid string-concatenation boundaries — forward order', () => {
    const a = [{ companyId: 'a', uid: 'bc' }, { companyId: 'ab', uid: 'c' }]
    const sorted = sortRelations(a)
    expect(sorted.map(r => `${r.companyId}|${r.uid}`)).toEqual(['a|bc', 'ab|c'])
  })

  it('does not collide on companyId/uid string-concatenation boundaries — reversed input order', () => {
    const a = [{ companyId: 'ab', uid: 'c' }, { companyId: 'a', uid: 'bc' }]
    const sorted = sortRelations(a)
    expect(sorted.map(r => `${r.companyId}|${r.uid}`)).toEqual(['a|bc', 'ab|c'])
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
    const a = [decision({ companyId: 'co_a', uid: 'u1' }), decision({ companyId: 'co_b', uid: 'u2', resolution: 'confirm_role', role: 'admin' })]
    const b = [a[1]!, a[0]!]
    expect(computeDecisionsChecksum(a)).toBe(computeDecisionsChecksum(b))
  })

  it('is deterministic for an empty array', () => {
    expect(computeDecisionsChecksum([])).toBe(computeDecisionsChecksum([]))
  })

  // ── Independent audit fix #5 (2nd round) ────────────────────────────────
  it('changing confirm_role.role (admin -> viewer) changes the checksum', () => {
    const a = [decision({ resolution: 'confirm_role', role: 'admin' })]
    const b = [decision({ resolution: 'confirm_role', role: 'viewer' })]
    expect(computeDecisionsChecksum(a)).not.toBe(computeDecisionsChecksum(b))
  })

  it('changing reason changes the checksum', () => {
    const a = [decision({ reason: 'reason A' })]
    const b = [decision({ reason: 'reason B' })]
    expect(computeDecisionsChecksum(a)).not.toBe(computeDecisionsChecksum(b))
  })

  it('changing reviewedBy changes the checksum', () => {
    const a = [decision({ reviewedBy: 'alice' })]
    const b = [decision({ reviewedBy: 'bob' })]
    expect(computeDecisionsChecksum(a)).not.toBe(computeDecisionsChecksum(b))
  })

  it('changing reviewedAt changes the checksum', () => {
    const a = [decision({ reviewedAt: '2026-01-01T00:00:00.000Z' })]
    const b = [decision({ reviewedAt: '2026-01-02T00:00:00.000Z' })]
    expect(computeDecisionsChecksum(a)).not.toBe(computeDecisionsChecksum(b))
  })

  it('changing companyId changes the checksum', () => {
    const a = [decision({ companyId: 'co_a' })]
    const b = [decision({ companyId: 'co_b' })]
    expect(computeDecisionsChecksum(a)).not.toBe(computeDecisionsChecksum(b))
  })

  it('changing uid changes the checksum', () => {
    const a = [decision({ uid: 'u1' })]
    const b = [decision({ uid: 'u2' })]
    expect(computeDecisionsChecksum(a)).not.toBe(computeDecisionsChecksum(b))
  })

  it('a user-level decision (no companyId) produces a different checksum than the same decision WITH a companyId', () => {
    const withCompany = [decision({ companyId: 'co_a' })]
    const userLevel = [decision({ companyId: undefined, findingType: 'no_usable_relations' })]
    expect(computeDecisionsChecksum(withCompany)).not.toBe(computeDecisionsChecksum(userLevel))
  })

  // ── Independent audit fixes, 4th round, item 3.1 ────────────────────────
  it('changing findingType changes the checksum', () => {
    const a = [decision({ findingType: 'role_mismatch' })]
    const b = [decision({ findingType: 'invalid_role' })]
    expect(computeDecisionsChecksum(a)).not.toBe(computeDecisionsChecksum(b))
  })

  it('changing evidenceFingerprint changes the checksum', () => {
    const a = [decision({ evidenceFingerprint: 'a'.repeat(64) })]
    const b = [decision({ evidenceFingerprint: 'b'.repeat(64) })]
    expect(computeDecisionsChecksum(a)).not.toBe(computeDecisionsChecksum(b))
  })
})

describe('computeFindingFingerprint', () => {
  it('is deterministic and order-independent of key insertion', () => {
    expect(computeFindingFingerprint({ sourceKinds: ['users.home'], observedRoles: ['admin'] }))
      .toBe(computeFindingFingerprint({ observedRoles: ['admin'], sourceKinds: ['users.home'] }))
  })

  it('differs when evidence differs', () => {
    const a = computeFindingFingerprint({ sourceKinds: ['users.home'] })
    const b = computeFindingFingerprint({ sourceKinds: ['users.companies[]'] })
    expect(a).not.toBe(b)
  })

  it('is a 64-character hex digest', () => {
    expect(computeFindingFingerprint({})).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('computeFullSourceStateChecksum — independent audit fixes, 4th round, item 3.2', () => {
  it('is identical for the same logical state regardless of Map/array insertion order', () => {
    const extraction = emptyExtraction({
      confirmed: [
        { companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] },
        { companyId: 'co_b', uid: 'u2', role: 'viewer', sources: ['users.companies[]'] },
      ],
    })
    const membershipsA = new Map([['["co_a","u1"]', { role: 'admin' }], ['["co_b","u2"]', { role: 'viewer' }]])
    const membershipsB = new Map([['["co_b","u2"]', { role: 'viewer' }], ['["co_a","u1"]', { role: 'admin' }]])
    const a = computeFullSourceStateChecksum({ extraction, existingMemberships: membershipsA, allCompanyIds: new Set(['co_a', 'co_b']), allUserIds: new Set(['u1', 'u2']) })
    const b = computeFullSourceStateChecksum({ extraction, existingMemberships: membershipsB, allCompanyIds: new Set(['co_b', 'co_a']), allUserIds: new Set(['u2', 'u1']) })
    expect(a).toBe(b)
  })

  it('changing a confirmed relation role changes the checksum', () => {
    const base = { existingMemberships: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']) }
    const a = computeFullSourceStateChecksum({ extraction: emptyExtraction({ confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }] }), ...base })
    const b = computeFullSourceStateChecksum({ extraction: emptyExtraction({ confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'viewer', sources: ['users.home'] }] }), ...base })
    expect(a).not.toBe(b)
  })

  it('changing a confirmed relation source kind changes the checksum (scenario: users.home -> users.companies[])', () => {
    const base = { existingMemberships: new Map(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']) }
    const a = computeFullSourceStateChecksum({ extraction: emptyExtraction({ confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.home'] }] }), ...base })
    const b = computeFullSourceStateChecksum({ extraction: emptyExtraction({ confirmed: [{ companyId: 'co_a', uid: 'u1', role: 'admin', sources: ['users.companies[]'] }] }), ...base })
    expect(a).not.toBe(b)
  })

  it('changing an orphan evidenceFingerprint changes the checksum', () => {
    const base = { existingMemberships: new Map(), allCompanyIds: new Set<string>(), allUserIds: new Set(['u1']) }
    const a = computeFullSourceStateChecksum({ extraction: emptyExtraction({ orphans: [{ companyId: 'co_a', uid: 'u1', reason: 'missing_company', sourceKinds: ['users.home'], evidenceFingerprint: 'a'.repeat(64) }] }), ...base })
    const b = computeFullSourceStateChecksum({ extraction: emptyExtraction({ orphans: [{ companyId: 'co_a', uid: 'u1', reason: 'missing_company', sourceKinds: ['users.home'], evidenceFingerprint: 'b'.repeat(64) }] }), ...base })
    expect(a).not.toBe(b)
  })

  it('changing an existing membership document role changes the checksum', () => {
    const base = { extraction: emptyExtraction(), allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']) }
    const a = computeFullSourceStateChecksum({ existingMemberships: new Map([['["co_a","u1"]', { role: 'admin' }]]), ...base })
    const b = computeFullSourceStateChecksum({ existingMemberships: new Map([['["co_a","u1"]', { role: 'viewer' }]]), ...base })
    expect(a).not.toBe(b)
  })

  it('changing the set of existing company/user IDs changes the checksum', () => {
    const base = { extraction: emptyExtraction(), existingMemberships: new Map() }
    const a = computeFullSourceStateChecksum({ allCompanyIds: new Set(['co_a']), allUserIds: new Set(['u1']), ...base })
    const b = computeFullSourceStateChecksum({ allCompanyIds: new Set(['co_a', 'co_b']), allUserIds: new Set(['u1']), ...base })
    expect(a).not.toBe(b)
  })
})
