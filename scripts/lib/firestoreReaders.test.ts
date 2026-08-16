import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { computeExistingActiveAdmins } from './firestoreReaders.ts'
import { relationKey } from './types.ts'

const ts = Timestamp.now()

describe('computeExistingActiveAdmins', () => {
  it('counts a strictly valid admin membership whose uid has a real user document', () => {
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }]])
    const result = computeExistingActiveAdmins(existing, new Set(['u1']))
    expect(result.get('co_a')).toEqual(new Set(['u1']))
  })

  // ── Independent audit fix #3 (3rd round) ────────────────────────────────
  it('does NOT count a valid-looking admin membership whose uid has NO user document', () => {
    const existing = new Map([[relationKey('co_a', 'u_ghost'), { uid: 'u_ghost', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }]])
    const result = computeExistingActiveAdmins(existing, new Set()) // u_ghost NOT in allUserIds
    expect(result.get('co_a')).toBeUndefined()
  })

  it('a corrupted (extra-field) admin membership still never counts, regardless of user existence', () => {
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts, extra: true }]])
    const result = computeExistingActiveAdmins(existing, new Set(['u1']))
    expect(result.get('co_a')).toBeUndefined()
  })

  it('a non-admin role never counts, regardless of user existence', () => {
    const existing = new Map([[relationKey('co_a', 'u1'), { uid: 'u1', role: 'viewer', status: 'active', createdAt: ts, updatedAt: ts }]])
    const result = computeExistingActiveAdmins(existing, new Set(['u1']))
    expect(result.get('co_a')).toBeUndefined()
  })

  it('one valid admin and one dangling (missing-user) admin for the same company — only the valid one counts', () => {
    const existing = new Map([
      [relationKey('co_a', 'u1'), { uid: 'u1', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }],
      [relationKey('co_a', 'u_ghost'), { uid: 'u_ghost', role: 'admin', status: 'active', createdAt: ts, updatedAt: ts }],
    ])
    const result = computeExistingActiveAdmins(existing, new Set(['u1']))
    expect(result.get('co_a')).toEqual(new Set(['u1']))
  })
})
