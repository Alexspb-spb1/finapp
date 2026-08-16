// Independent audit fix #2 (3rd round) — "create succeeded, subsequent
// read failed" testable seam. Uses a minimal fake Firestore-shaped stub
// (not the real Admin SDK, not the emulator) so this exact failure mode is
// directly exercisable in a pure unit test.
import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import type { Firestore } from 'firebase-admin/firestore'
import { createPlannedRelations, readBackObservedState } from './applyWrites.ts'
import type { PlannedCreate } from './types.ts'

function makeFakeWriteDb(shouldFail: (companyId: string, uid: string) => boolean): Firestore {
  const db = {
    collection(_name: string) {
      return {
        doc(companyId: string) {
          return {
            collection(_name2: string) {
              return {
                doc(uid: string) {
                  const path = `companies/${companyId}/members/${uid}`
                  return {
                    path,
                    // Deliberately NO `get()` method on this fake at all —
                    // if createPlannedRelations() ever called it (the old,
                    // buggy behavior this fix removes), the test would
                    // fail with "ref.get is not a function", proving the
                    // seam genuinely no longer depends on a second read.
                    async create() {
                      if (shouldFail(companyId, uid)) throw new Error('simulated create failure')
                      return { writeTime: Timestamp.now() }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  }
  return db as unknown as Firestore
}

function makeFakeReadBackDb(shouldThrow: boolean): Firestore {
  const db = {
    collectionGroup(_name: string) {
      return {
        async get() {
          if (shouldThrow) throw new Error('simulated read-back failure')
          return { docs: [] as unknown[] }
        },
      }
    },
  }
  return db as unknown as Firestore
}

const planned: PlannedCreate[] = [
  { companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' },
]

describe('createPlannedRelations', () => {
  it('records a successful create using ONLY the WriteResult — no second read', async () => {
    const db = makeFakeWriteDb(() => false)
    const result = await createPlannedRelations(db, planned)
    expect(result.writeFailures).toEqual([])
    expect(result.createdPaths).toHaveLength(1)
    expect(result.createdPaths[0]).toMatchObject({ companyId: 'co_a', uid: 'u1', path: 'companies/co_a/members/u1' })
    expect(result.createdPaths[0]!.createTimeIso).toBeTruthy()
    expect(result.createdPaths[0]!.updateTimeIso).toBe(result.createdPaths[0]!.createTimeIso)
  })

  it('a genuine create() failure is recorded as a write failure, not a created path', async () => {
    const db = makeFakeWriteDb(() => true)
    const result = await createPlannedRelations(db, planned)
    expect(result.createdPaths).toEqual([])
    expect(result.writeFailures).toEqual([{ companyId: 'co_a', uid: 'u1', error: 'simulated create failure' }])
  })

  it('one success and one failure among multiple planned creates are each recorded independently', async () => {
    const db = makeFakeWriteDb((_companyId, uid) => uid === 'u2')
    const twoPlanned: PlannedCreate[] = [
      { companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' },
      { companyId: 'co_a', uid: 'u2', role: 'viewer', status: 'active' },
    ]
    const result = await createPlannedRelations(db, twoPlanned)
    expect(result.createdPaths.map(c => c.uid)).toEqual(['u1'])
    expect(result.writeFailures.map(f => f.uid)).toEqual(['u2'])
  })
})

describe('readBackObservedState', () => {
  it('returns ok:true with computed observed state when the read-back succeeds', async () => {
    const db = makeFakeReadBackDb(false)
    const result = await readBackObservedState(db, [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.missing).toEqual([{ companyId: 'co_a', uid: 'u1' }]) // fake db returns no docs
    }
  })

  it('returns ok:false with an error message when the read-back itself throws — never an uncaught rejection', async () => {
    const db = makeFakeReadBackDb(true)
    const result = await readBackObservedState(db, [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('simulated read-back failure')
    }
  })
})

describe('create succeeded, subsequent read-back failed — the exact scenario the review flagged', () => {
  it('createdPaths from a successful create is never erased by a LATER read-back failure', async () => {
    const writeDb = makeFakeWriteDb(() => false)
    const writeResult = await createPlannedRelations(writeDb, planned)
    expect(writeResult.createdPaths).toHaveLength(1) // durably captured

    // Simulate the read-back step (a SEPARATE Firestore call) failing —
    // this must not, and structurally cannot, mutate or erase
    // `writeResult.createdPaths` from above; they are independent values.
    const readBackDb = makeFakeReadBackDb(true)
    const readBack = await readBackObservedState(readBackDb, [{ companyId: 'co_a', uid: 'u1', role: 'admin', status: 'active' }])

    expect(readBack.ok).toBe(false)
    expect(writeResult.createdPaths).toHaveLength(1) // still intact
    expect(writeResult.createdPaths[0]).toMatchObject({ companyId: 'co_a', uid: 'u1' })
  })
})
