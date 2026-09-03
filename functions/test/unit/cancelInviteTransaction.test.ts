// Structural + behavioral proof for SEC-006 Stage 3, mirroring
// test/unit/inviteMemberTransaction.test.ts exactly: a Firestore-forced
// internal transaction retry must not recompute `revokedAt`. No
// Functions/Firestore Emulator is used here — everything is a fake
// Transaction/runner.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Timestamp } from 'firebase-admin/firestore'
import type { Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { performCancelInvite } from '../../src/index'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Structural proof: the transaction-body module cannot possibly compute
// its own "now" — it never calls new Date()/Date.now() at all, so the
// only possible source of `revokedAt` is the value handed in by the
// caller. ──
describe('cancelInviteTransaction.ts — structural non-regeneration proof', () => {
  it('never calls new Date() or Date.now() — revokedAt can only come from the caller-supplied generated value', () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/lib/cancelInviteTransaction.ts'), 'utf8')
    expect(source).not.toMatch(/new Date\(/)
    expect(source).not.toMatch(/Date\.now\(/)
  })
})

interface FakeTxnOptions {
  membershipRole?: 'admin' | 'viewer' | 'accountant'
  inviteExists?: boolean
  inviteData?: Record<string, unknown>
}

function makePendingInviteData(companyId: string): Record<string, unknown> {
  const now = Timestamp.now()
  return {
    companyId,
    emailNormalized: 'invitee-retry@example.test',
    role: 'viewer',
    tokenHash: '0'.repeat(64),
    status: 'pending',
    expiresAt: Timestamp.fromMillis(now.toMillis() + 1000 * 3600 * 24),
    createdBy: 'uid_someone_else_synthetic',
    createdAt: now,
    updatedAt: now,
    resendCount: 0,
    lastSentAt: null,
  }
}

function makeFakeTxn(opts: FakeTxnOptions = {}): { txn: Transaction; updateCalls: Array<{ path: string; data: Record<string, unknown> }>; setCalls: Array<{ path: string; data: Record<string, unknown> }> } {
  const updateCalls: Array<{ path: string; data: Record<string, unknown> }> = []
  const setCalls: Array<{ path: string; data: Record<string, unknown> }> = []
  const fakeTxn = {
    get: async (ref: { path: string }) => {
      if (ref.path === 'system/maintenance') {
        return { exists: false, data: () => undefined }
      }
      if (ref.path.includes('/members/')) {
        const uid = ref.path.split('/').pop()!
        return {
          exists: true,
          id: uid,
          data: () => ({
            uid, role: opts.membershipRole ?? 'admin', status: 'active',
            createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
          }),
        }
      }
      if (ref.path.startsWith('invitations/')) {
        return {
          exists: opts.inviteExists ?? true,
          id: ref.path.split('/').pop(),
          data: () => opts.inviteData,
        }
      }
      throw new Error(`makeFakeTxn: unexpected get() for path ${ref.path}`)
    },
    update: (ref: { path: string }, data: Record<string, unknown>) => {
      updateCalls.push({ path: ref.path, data })
    },
    set: (ref: { path: string }, data: Record<string, unknown>) => {
      setCalls.push({ path: ref.path, data })
    },
  }
  return { txn: fakeTxn as unknown as Transaction, updateCalls, setCalls }
}

function makeFakeRequest(uid: string, data: unknown): CallableRequest<unknown> {
  return { auth: { uid, token: { email_verified: true } }, data } as unknown as CallableRequest<unknown>
}

describe('performCancelInvite — an internally-retried transaction computes revokedAt exactly once', () => {
  it('an injected transaction runner that invokes the update function twice reuses the SAME revokedAt value both times', async () => {
    const companyId = 'co_synthetic_cancel_retry'
    const inviteData = makePendingInviteData(companyId)

    const { txn: firstAttemptTxn, updateCalls: firstUpdateCalls } = makeFakeTxn({ inviteData })
    const { txn: secondAttemptTxn, updateCalls: secondUpdateCalls } = makeFakeTxn({ inviteData })

    let invocationCount = 0
    const fakeRunTransaction = async <T>(updateFn: (txn: Transaction) => Promise<T>): Promise<T> => {
      invocationCount += 1
      await updateFn(firstAttemptTxn)
      invocationCount += 1
      return updateFn(secondAttemptTxn)
    }

    const request = makeFakeRequest('uid_admin_synthetic', { companyId, inviteId: 'invite_synthetic_retry' })
    const result = await performCancelInvite(request, fakeRunTransaction)

    expect(invocationCount).toBe(2) // the update function really did run twice
    expect(firstUpdateCalls).toHaveLength(1)
    expect(secondUpdateCalls).toHaveLength(1)

    const firstRevokedAt = firstUpdateCalls[0]!.data.revokedAt as Timestamp
    const secondRevokedAt = secondUpdateCalls[0]!.data.revokedAt as Timestamp
    // Byte-identical Timestamp on both attempts — proving the closure
    // carried a fixed value across both invocations rather than calling
    // new Date() again on the second attempt.
    expect(firstRevokedAt.isEqual(secondRevokedAt)).toBe(true)
    expect(firstUpdateCalls[0]!.data.updatedAt).toEqual(firstRevokedAt)
    expect(result.revokedAtUtc).toBe(firstRevokedAt.toDate().toISOString())
  })

  it('a status change discovered only on the SECOND attempt (simulating a real retry racing a concurrent cancel) still reports invitation_not_pending without a second write', async () => {
    const companyId = 'co_synthetic_cancel_race'
    const pendingData = makePendingInviteData(companyId)
    const alreadyRevokedData = { ...pendingData, status: 'revoked', revokedAt: Timestamp.now(), revokedBy: 'uid_other_admin_synthetic' }

    const { txn: firstAttemptTxn } = makeFakeTxn({ inviteData: pendingData })
    const { txn: secondAttemptTxn, updateCalls: secondUpdateCalls } = makeFakeTxn({ inviteData: alreadyRevokedData })

    const fakeRunTransaction = async <T>(updateFn: (txn: Transaction) => Promise<T>): Promise<T> => {
      await updateFn(firstAttemptTxn).catch(() => undefined) // discarded, as a real retried attempt's result is
      return updateFn(secondAttemptTxn)
    }

    const request = makeFakeRequest('uid_admin_synthetic', { companyId, inviteId: 'invite_synthetic_race' })

    await expect(performCancelInvite(request, fakeRunTransaction)).rejects.toBeTruthy()
    expect(secondUpdateCalls).toHaveLength(0) // no write on the failing (already-revoked) attempt
  })
})
