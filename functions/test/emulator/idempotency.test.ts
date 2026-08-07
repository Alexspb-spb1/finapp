// runIdempotent — SEC-003, against the real Firestore Emulator.
import { describe, it, expect } from 'vitest'
import { db } from '../../src/lib/admin'
import { runIdempotent } from '../../src/lib/idempotency'
import { seedCompany } from './helpers'

describe('runIdempotent — real Firestore transaction', () => {
  it('the same key + same fingerprint runs the mutation exactly once across repeated calls', async () => {
    const companyId = `co_idem_${Date.now()}`
    await seedCompany(companyId)
    let executionCount = 0
    const scope = { operation: 'testOp', companyId, callerUid: 'uid_caller' }
    const payload = { amount: 42 }
    const run = async () => { executionCount += 1; return { mutatedAt: executionCount } }

    const first = await runIdempotent({ db, scope, idempotencyKey: 'key-1', payloadForFingerprint: payload, run })
    const second = await runIdempotent({ db, scope, idempotencyKey: 'key-1', payloadForFingerprint: payload, run })

    expect(executionCount).toBe(1)
    expect(second).toEqual(first)
  })

  it('the same key with a DIFFERENT fingerprint is rejected with idempotency_conflict, without re-running the mutation', async () => {
    const companyId = `co_idem_conflict_${Date.now()}`
    await seedCompany(companyId)
    let executionCount = 0
    const scope = { operation: 'testOp', companyId, callerUid: 'uid_caller' }
    const run = async () => { executionCount += 1; return { done: true } }

    await runIdempotent({ db, scope, idempotencyKey: 'key-2', payloadForFingerprint: { amount: 1 }, run })
    expect(executionCount).toBe(1)

    await expect(
      runIdempotent({ db, scope, idempotencyKey: 'key-2', payloadForFingerprint: { amount: 2 }, run }),
    ).rejects.toEqual(expect.objectContaining({ appCode: 'idempotency_conflict' }))

    expect(executionCount).toBe(1) // conflict must not re-run the business mutation
  })

  it('different companies do not collide even with the identical raw key (scoped by operation+company+caller)', async () => {
    const companyA = `co_idem_scope_a_${Date.now()}`
    const companyB = `co_idem_scope_b_${Date.now()}`
    await seedCompany(companyA)
    await seedCompany(companyB)
    let executionCount = 0
    const run = async () => { executionCount += 1; return { n: executionCount } }

    const resultA = await runIdempotent({
      db, scope: { operation: 'op', companyId: companyA, callerUid: 'uid_x' },
      idempotencyKey: 'shared-key', payloadForFingerprint: {}, run,
    })
    const resultB = await runIdempotent({
      db, scope: { operation: 'op', companyId: companyB, callerUid: 'uid_x' },
      idempotencyKey: 'shared-key', payloadForFingerprint: {}, run,
    })

    expect(executionCount).toBe(2)
    expect(resultA).not.toEqual(resultB)
  })

  it('rejects an empty or excessively long idempotency key as invalid_request, without attempting the mutation', async () => {
    const companyId = `co_idem_badkey_${Date.now()}`
    await seedCompany(companyId)
    const scope = { operation: 'op', companyId, callerUid: 'uid_x' }
    let ran = false
    const run = async () => { ran = true; return {} }

    await expect(runIdempotent({ db, scope, idempotencyKey: '', payloadForFingerprint: {}, run }))
      .rejects.toEqual(expect.objectContaining({ appCode: 'invalid_request' }))
    await expect(runIdempotent({ db, scope, idempotencyKey: 'x'.repeat(500), payloadForFingerprint: {}, run }))
      .rejects.toEqual(expect.objectContaining({ appCode: 'invalid_request' }))
    expect(ran).toBe(false)
  })
})
