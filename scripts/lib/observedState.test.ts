import { describe, it, expect } from 'vitest'
import { computeObservedState } from './observedState.ts'
import { relationKey } from './types.ts'

describe('computeObservedState — independent audit fix #4', () => {
  it('a target relation with no corresponding read-back entry is MISSING, never substituted with the expected value', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const readBack = new Map<string, Record<string, unknown>>() // nothing was actually read back
    const result = computeObservedState(target, readBack)
    expect(result.missing).toEqual([{ companyId: 'co_a', uid: 'u1' }])
    expect(result.differing).toEqual([])
  })

  it('a checksum computed from a missing entry differs from a checksum computed from the expected value', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const complete = new Map([[relationKey('co_a', 'u1'), { role: 'admin', status: 'active' }]])
    const incomplete = new Map<string, Record<string, unknown>>()
    const completeResult = computeObservedState(target, complete)
    const incompleteResult = computeObservedState(target, incomplete)
    expect(completeResult.observedChecksum).not.toBe(incompleteResult.observedChecksum)
  })

  it('a read-back document with a different role is reported as differing', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const readBack = new Map([[relationKey('co_a', 'u1'), { role: 'viewer', status: 'active' }]])
    const result = computeObservedState(target, readBack)
    expect(result.differing).toEqual([{ companyId: 'co_a', uid: 'u1' }])
    expect(result.missing).toEqual([])
  })

  it('a fully matching read-back reports neither missing nor differing', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const readBack = new Map([[relationKey('co_a', 'u1'), { role: 'admin', status: 'active' }]])
    const result = computeObservedState(target, readBack)
    expect(result.missing).toEqual([])
    expect(result.differing).toEqual([])
  })

  it('a partial write failure (2 targets, only 1 actually readable) produces a non-matching checksum and a non-empty missing list', () => {
    const target = [
      { companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' },
      { companyId: 'co_a', uid: 'u2', role: 'viewer', status: 'active' },
    ]
    const fullyWritten = new Map([
      [relationKey('co_a', 'u1'), { role: 'admin', status: 'active' }],
      [relationKey('co_a', 'u2'), { role: 'viewer', status: 'active' }],
    ])
    const partiallyWritten = new Map([
      [relationKey('co_a', 'u1'), { role: 'admin', status: 'active' }],
      // u2's write failed — no entry.
    ])
    const full = computeObservedState(target, fullyWritten)
    const partial = computeObservedState(target, partiallyWritten)
    expect(partial.observedChecksum).not.toBe(full.observedChecksum)
    expect(partial.missing).toEqual([{ companyId: 'co_a', uid: 'u2' }])
  })
})
