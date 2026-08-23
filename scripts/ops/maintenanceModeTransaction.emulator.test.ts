// Real Firestore Emulator proof for set-maintenance-mode.ts's
// transactionalEnable()/transactionalDisable() — production execution
// gate round. Tests the state-machine logic DIRECTLY (importing the
// exported functions against the shared demo-finapp emulator) rather
// than only through the CLI binary, so every branch (already-enabled
// refusal, cross-task disable refusal, idempotent disable, concurrent
// modification) is exercised precisely and fast, independent of CLI
// argument parsing. scripts/ops/set-maintenance-mode.emulator.test.ts
// covers the CLI-wiring level on top of this.
//
// `--no-file-parallelism` (via test:migration) matters here for the same
// reason as the other emulator test files in this suite: this file's
// beforeEach wipes the ENTIRE demo-finapp Firestore project, which would
// race other files' seed/assert sequences if run in parallel worker
// threads.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { transactionalEnable, transactionalDisable, MaintenanceModeStateError } from './set-maintenance-mode.ts'

const PROJECT_ID = 'demo-finapp'

let db: Firestore

beforeAll(() => {
  const app = getApps().length > 0 ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID })
  db = getFirestore(app)
})

beforeEach(async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' })
})

async function getMaintenanceDoc(): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection('system').doc('maintenance').get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

describe('transactionalEnable', () => {
  it('succeeds from a missing document', async () => {
    const result = await transactionalEnable(db, { reason: 'SEC-005 backfill', taskId: 'SEC-005', operator: 'alice' })
    expect(result).toEqual({ changed: true })
    const doc = await getMaintenanceDoc()
    expect(doc?.enabled).toBe(true)
    expect(doc?.taskId).toBe('SEC-005')
    expect(doc?.enabledBy).toBe('alice')
    expect(doc?.enabledAt).toBeDefined()
  })

  it('succeeds from a verifiably-disabled document, overwriting reason/taskId/enabledBy (fresh window, not a merge)', async () => {
    await transactionalEnable(db, { reason: 'old window', taskId: 'SEC-999', operator: 'bob' })
    await transactionalDisable(db, { taskId: 'SEC-999', operator: 'bob' })
    const result = await transactionalEnable(db, { reason: 'new window', taskId: 'SEC-005', operator: 'alice' })
    expect(result).toEqual({ changed: true })
    const doc = await getMaintenanceDoc()
    expect(doc?.enabled).toBe(true)
    expect(doc?.reason).toBe('new window')
    expect(doc?.taskId).toBe('SEC-005')
    expect(doc?.enabledBy).toBe('alice')
    // The disabledAt/disabledBy pair from the previous window must not
    // survive a fresh --enable (full overwrite, not merge).
    expect(doc?.disabledAt).toBeUndefined()
    expect(doc?.disabledBy).toBeUndefined()
  })

  it('refuses (throws MaintenanceModeStateError) when already enabled — document left completely untouched', async () => {
    await transactionalEnable(db, { reason: 'original window', taskId: 'SEC-005', operator: 'alice' })
    const before = await getMaintenanceDoc()

    await expect(transactionalEnable(db, { reason: 'accidental second enable', taskId: 'SEC-005', operator: 'mallory' }))
      .rejects.toThrow(MaintenanceModeStateError)

    const after = await getMaintenanceDoc()
    expect(after).toEqual(before) // byte-for-byte unchanged, including enabledAt
  })

  it('refuses when the existing document has an unverifiable (non-boolean-false) enabled field — fail-closed, never treated as "safely disabled"', async () => {
    // Simulate a malformed/legacy document directly (bypassing the script)
    // — enabled is present but not a real boolean.
    await db.collection('system').doc('maintenance').set({ enabled: 'nope', taskId: 'SEC-005' })
    await expect(transactionalEnable(db, { reason: 'x', taskId: 'SEC-005', operator: 'alice' }))
      .rejects.toThrow(MaintenanceModeStateError)
  })
})

describe('transactionalDisable', () => {
  it('is a safe no-op when no maintenance document exists at all', async () => {
    const result = await transactionalDisable(db, { taskId: 'SEC-005', operator: 'alice' })
    expect(result.changed).toBe(false)
    expect(result.noopReason).toBeDefined()
    expect(await getMaintenanceDoc()).toBeUndefined()
  })

  it('refuses (throws MaintenanceModeStateError) when the record belongs to a different task — document left untouched', async () => {
    await transactionalEnable(db, { reason: 'unrelated task window', taskId: 'SEC-999', operator: 'bob' })
    const before = await getMaintenanceDoc()

    await expect(transactionalDisable(db, { taskId: 'SEC-005', operator: 'mallory' }))
      .rejects.toThrow(MaintenanceModeStateError)

    const after = await getMaintenanceDoc()
    expect(after).toEqual(before)
    expect(after?.enabled).toBe(true) // still enabled — the wrong-task disable attempt changed nothing
  })

  it('successfully disables a currently-enabled record for the matching taskId, preserving the historical audit fields', async () => {
    await transactionalEnable(db, { reason: 'SEC-005 backfill', taskId: 'SEC-005', operator: 'alice' })
    const result = await transactionalDisable(db, { taskId: 'SEC-005', operator: 'alice' })
    expect(result).toEqual({ changed: true })
    const doc = await getMaintenanceDoc()
    expect(doc?.enabled).toBe(false)
    expect(doc?.reason).toBe('SEC-005 backfill')
    expect(doc?.taskId).toBe('SEC-005')
    expect(doc?.disabledAt).toBeDefined()
    expect(doc?.disabledBy).toBe('alice')
  })

  it('is an idempotent no-op when the SEC-005 record is already disabled — no error, changed: false', async () => {
    await transactionalEnable(db, { reason: 'SEC-005 backfill', taskId: 'SEC-005', operator: 'alice' })
    await transactionalDisable(db, { taskId: 'SEC-005', operator: 'alice' })
    const beforeSecondDisable = await getMaintenanceDoc()

    const result = await transactionalDisable(db, { taskId: 'SEC-005', operator: 'alice' })

    expect(result.changed).toBe(false)
    expect(result.noopReason).toBeDefined()
    const after = await getMaintenanceDoc()
    expect(after).toEqual(beforeSecondDisable) // no spurious re-write (disabledAt does not change)
  })
})

describe('concurrent modification — transactional correctness', () => {
  it('two concurrent transactionalEnable() calls: exactly one succeeds, the other is refused as "already enabled" (never both "win")', async () => {
    const results = await Promise.allSettled([
      transactionalEnable(db, { reason: 'racer A', taskId: 'SEC-005', operator: 'alice' }),
      transactionalEnable(db, { reason: 'racer B', taskId: 'SEC-005', operator: 'bob' }),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(MaintenanceModeStateError)

    // The document reflects exactly ONE racer's write — never a merged/
    // corrupted mix of both (proving the transaction was truly atomic).
    const doc = await getMaintenanceDoc()
    expect(doc?.enabled).toBe(true)
    expect(['racer A', 'racer B']).toContain(doc?.reason)
    const winnerOperator = doc?.reason === 'racer A' ? 'alice' : 'bob'
    expect(doc?.enabledBy).toBe(winnerOperator)
  })

  it('a concurrent enable and disable targeting the same fresh document resolve deterministically, never leaving a torn/mixed write', async () => {
    await transactionalEnable(db, { reason: 'initial window', taskId: 'SEC-005', operator: 'alice' })

    const results = await Promise.allSettled([
      transactionalDisable(db, { taskId: 'SEC-005', operator: 'bob' }),
      transactionalEnable(db, { reason: 'racing re-enable', taskId: 'SEC-005', operator: 'carol' }),
    ])

    // Both a disable-of-currently-enabled and an enable-of-currently-enabled
    // are legal state transitions individually, but only one may apply to
    // any given underlying document version — Firestore's transaction
    // retry means the second one to actually commit sees the FIRST one's
    // result, not the pre-race state. Whatever the final state is, it must
    // be internally consistent (never a `{enabled: true, disabledAt: ...}`
    // torn write, for example).
    expect(results.every(r => r.status === 'fulfilled' || r.reason instanceof MaintenanceModeStateError)).toBe(true)
    const doc = await getMaintenanceDoc()
    if (doc?.enabled === true) {
      expect(doc?.disabledAt).toBeUndefined()
    } else if (doc?.enabled === false) {
      expect(doc?.disabledAt).toBeDefined()
    }
  })
})
