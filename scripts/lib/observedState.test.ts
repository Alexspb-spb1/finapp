import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { computeObservedState } from './observedState.ts'
import { relationKey } from './types.ts'

const ts = Timestamp.now()

function validDoc(uid: string, role: string, status = 'active'): Record<string, unknown> {
  return { uid, role, status, createdAt: ts, updatedAt: ts }
}

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
    const complete = new Map([[relationKey('co_a', 'u1'), validDoc('u1', 'admin')]])
    const incomplete = new Map<string, Record<string, unknown>>()
    const completeResult = computeObservedState(target, complete)
    const incompleteResult = computeObservedState(target, incomplete)
    expect(completeResult.observedChecksum).not.toBe(incompleteResult.observedChecksum)
  })

  it('a read-back document with a different role is reported as differing', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const readBack = new Map([[relationKey('co_a', 'u1'), validDoc('u1', 'viewer')]])
    const result = computeObservedState(target, readBack)
    expect(result.differing).toEqual([{ companyId: 'co_a', uid: 'u1' }])
    expect(result.missing).toEqual([])
  })

  it('a fully matching, schema-valid read-back reports neither missing nor differing', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const readBack = new Map([[relationKey('co_a', 'u1'), validDoc('u1', 'admin')]])
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
      [relationKey('co_a', 'u1'), validDoc('u1', 'admin')],
      [relationKey('co_a', 'u2'), validDoc('u2', 'viewer')],
    ])
    const partiallyWritten = new Map([
      [relationKey('co_a', 'u1'), validDoc('u1', 'admin')],
      // u2's write failed — no entry.
    ])
    const full = computeObservedState(target, fullyWritten)
    const partial = computeObservedState(target, partiallyWritten)
    expect(full.missing).toEqual([])
    expect(full.differing).toEqual([])
    expect(partial.observedChecksum).not.toBe(full.observedChecksum)
    expect(partial.missing).toEqual([{ companyId: 'co_a', uid: 'u2' }])
  })
})

// ── Independent audit fix #7 (2nd round) ───────────────────────────────────
describe('computeObservedState — schema-strict differing (not just role/status)', () => {
  it('a document with the CORRECT role/status but a WRONG uid is reported as differing', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const readBack = new Map([[relationKey('co_a', 'u1'), validDoc('someone_else', 'admin')]])
    const result = computeObservedState(target, readBack)
    expect(result.differing).toEqual([{ companyId: 'co_a', uid: 'u1' }])
    expect(result.missing).toEqual([])
  })

  it('a document with the CORRECT role/status but a FAKE (non-Timestamp) createdAt is reported as differing', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const fake = { uid: 'u1', role: 'admin', status: 'active', createdAt: { seconds: 1, nanoseconds: 0 }, updatedAt: ts }
    const readBack = new Map([[relationKey('co_a', 'u1'), fake]])
    const result = computeObservedState(target, readBack)
    expect(result.differing).toEqual([{ companyId: 'co_a', uid: 'u1' }])
  })

  it('a document with the CORRECT role/status but MISSING timestamps entirely is reported as differing', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const readBack = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'active' }]])
    const result = computeObservedState(target, readBack)
    expect(result.differing).toEqual([{ companyId: 'co_a', uid: 'u1' }])
  })

  it('a document with the CORRECT role/status but an EXTRA field is reported as differing', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const readBack = new Map([[relationKey('co_a', 'u1'), { ...validDoc('u1', 'admin'), backdoor: true }]])
    const result = computeObservedState(target, readBack)
    expect(result.differing).toEqual([{ companyId: 'co_a', uid: 'u1' }])
  })

  it('a schema-invalid document (right role/status, wrong uid) produces a DIFFERENT checksum than a fully valid matching one', () => {
    const target = [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }]
    const valid = new Map([[relationKey('co_a', 'u1'), validDoc('u1', 'admin')]])
    const corrupted = new Map([[relationKey('co_a', 'u1'), validDoc('wrong_uid', 'admin')]])
    const validResult = computeObservedState(target, valid)
    const corruptedResult = computeObservedState(target, corrupted)
    expect(validResult.observedChecksum).not.toBe(corruptedResult.observedChecksum)
  })
})
