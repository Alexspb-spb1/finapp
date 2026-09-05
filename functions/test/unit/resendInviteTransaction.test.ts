// Structural + behavioral proof for SEC-006 Stage 4, mirroring
// test/unit/inviteMemberTransaction.test.ts (token non-regeneration) and
// test/unit/cancelInviteTransaction.test.ts ("now" non-regeneration)
// combined: a Firestore-forced internal transaction retry must not
// recompute the token/tokenHash/expiresAt/"now". No Functions/Firestore
// Emulator is used here — everything is a fake Transaction/runner.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Timestamp } from 'firebase-admin/firestore'
import type { Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import * as invitationTokenModule from '../../src/lib/invitationToken'
import { computeInvitationLockId } from '../../src/schemas/invitation'
import { performResendInvite } from '../../src/index'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Structural proof: the transaction-body module cannot possibly
// regenerate the token/hash or compute its own "now" — it never imports
// the token generator/hasher, never imports node:crypto, and never calls
// new Date()/Date.now(). ──
describe('resendInviteTransaction.ts — structural non-regeneration proof', () => {
  it('never imports generateRawInvitationToken/hashInvitationToken/node:crypto, and never calls new Date()/Date.now()', () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/lib/resendInviteTransaction.ts'), 'utf8')
    const importLines = source.split('\n').filter(line => /^\s*import\b/.test(line))
    const importBlock = importLines.join('\n')
    expect(importBlock).not.toMatch(/generateRawInvitationToken/)
    expect(importBlock).not.toMatch(/hashInvitationToken/)
    expect(importBlock).not.toMatch(/from ['"]node:crypto['"]/)
    expect(source).not.toMatch(/new Date\(/)
    expect(source).not.toMatch(/Date\.now\(/)
  })
})

interface FakeTxnOptions {
  membershipRole?: 'admin' | 'viewer' | 'accountant'
  inviteExists?: boolean
  inviteData?: Record<string, unknown>
  lockExists?: boolean
  lockData?: Record<string, unknown>
}

const COMPANY_ID = 'co_synthetic_resend'
const EMAIL = 'invitee-resend-retry@example.test'
const INVITE_ID = 'invite_synthetic_resend_retry'

function makePendingInviteData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Timestamp.now()
  return {
    companyId: COMPANY_ID,
    emailNormalized: EMAIL,
    role: 'viewer',
    tokenHash: '0'.repeat(64),
    status: 'pending',
    expiresAt: Timestamp.fromMillis(now.toMillis() + 1000 * 3600 * 24),
    createdBy: 'uid_someone_else_synthetic',
    createdAt: Timestamp.fromMillis(now.toMillis() - 1000 * 3600 * 24), // created a day ago, well past cooldown
    updatedAt: now,
    resendCount: 0,
    lastSentAt: null,
    ...overrides,
  }
}

function makeFakeTxn(opts: FakeTxnOptions = {}): { txn: Transaction; updateCalls: Array<{ path: string; data: Record<string, unknown> }>; setCalls: Array<{ path: string; data: Record<string, unknown> }> } {
  const updateCalls: Array<{ path: string; data: Record<string, unknown> }> = []
  const setCalls: Array<{ path: string; data: Record<string, unknown> }> = []
  const lockId = computeInvitationLockId(COMPANY_ID, EMAIL)
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
      if (ref.path === `invitationLocks/${lockId}`) {
        return {
          exists: opts.lockExists ?? true,
          data: () => opts.lockData ?? { currentInviteId: INVITE_ID },
        }
      }
      throw new Error(`makeFakeTxn: unexpected get() for path ${ref.path}`)
    },
    update: (ref: { path: string }, data: Record<string, unknown>) => {
      // resendInvite must never .update() anything except the invitation
      // document itself (never invitationLocks).
      if (!ref.path.startsWith('invitations/')) {
        throw new Error(`makeFakeTxn: unexpected update() for path ${ref.path}`)
      }
      updateCalls.push({ path: ref.path, data })
    },
    set: (ref: { path: string }, data: Record<string, unknown>) => {
      // The only legitimate .set() call in this flow is writeAuditEvent's
      // brand-new audit_events document — resendInvite itself never
      // creates/overwrites an invitation or lock document.
      if (!ref.path.includes('/audit_events/')) {
        throw new Error(`makeFakeTxn: unexpected set() for path ${ref.path} — resendInvite must never create/overwrite invitations or invitationLocks`)
      }
      setCalls.push({ path: ref.path, data })
    },
  }
  return { txn: fakeTxn as unknown as Transaction, updateCalls, setCalls }
}

function makeFakeRequest(uid: string, data: unknown): CallableRequest<unknown> {
  return { auth: { uid, token: { email_verified: true } }, data } as unknown as CallableRequest<unknown>
}

describe('performResendInvite — an internally-retried transaction generates the token/tokenHash/expiresAt/now exactly once', () => {
  it('an injected transaction runner that invokes the update function twice reuses the SAME token/tokenHash/expiresAt/lastSentAt both times', async () => {
    const generateSpy = vi.spyOn(invitationTokenModule, 'generateRawInvitationToken')
    const hashSpy = vi.spyOn(invitationTokenModule, 'hashInvitationToken')

    const inviteData = makePendingInviteData()
    const { txn: firstAttemptTxn, updateCalls: firstUpdateCalls } = makeFakeTxn({ inviteData })
    const { txn: secondAttemptTxn, updateCalls: secondUpdateCalls } = makeFakeTxn({ inviteData })

    let invocationCount = 0
    const fakeRunTransaction = async <T>(updateFn: (txn: Transaction) => Promise<T>): Promise<T> => {
      invocationCount += 1
      await updateFn(firstAttemptTxn)
      invocationCount += 1
      return updateFn(secondAttemptTxn)
    }

    const request = makeFakeRequest('uid_admin_synthetic', { companyId: COMPANY_ID, inviteId: INVITE_ID })
    const result = await performResendInvite(request, fakeRunTransaction)

    expect(invocationCount).toBe(2) // the update function really did run twice
    expect(generateSpy).toHaveBeenCalledTimes(1) // yet the token was generated only once
    expect(hashSpy).toHaveBeenCalledTimes(1) // and hashed only once
    expect(firstUpdateCalls).toHaveLength(1)
    expect(secondUpdateCalls).toHaveLength(1)

    const first = firstUpdateCalls[0]!.data
    const second = secondUpdateCalls[0]!.data
    expect(first.tokenHash).toBe(second.tokenHash)
    expect((first.expiresAt as Timestamp).isEqual(second.expiresAt as Timestamp)).toBe(true)
    expect((first.lastSentAt as Timestamp).isEqual(second.lastSentAt as Timestamp)).toBe(true)
    expect(first.updatedAt).toEqual(first.lastSentAt)
    expect(first.resendCount).toBe(1)

    // The response is consistent with what was actually written.
    expect(result.token).toBeTruthy()
    expect(result.expiresAtUtc).toBe((first.expiresAt as Timestamp).toDate().toISOString())

    generateSpy.mockRestore()
    hashSpy.mockRestore()
  })

  it('a state change discovered only on the SECOND attempt (simulating a real retry racing a concurrent cancel) still fails without a second write, and the token was still generated only once', async () => {
    const generateSpy = vi.spyOn(invitationTokenModule, 'generateRawInvitationToken')

    const pendingData = makePendingInviteData()
    const revokedData = { ...pendingData, status: 'revoked', revokedAt: Timestamp.now(), revokedBy: 'uid_other_admin_synthetic' }

    const { txn: firstAttemptTxn } = makeFakeTxn({ inviteData: pendingData })
    const { txn: secondAttemptTxn, updateCalls: secondUpdateCalls } = makeFakeTxn({ inviteData: revokedData })

    const fakeRunTransaction = async <T>(updateFn: (txn: Transaction) => Promise<T>): Promise<T> => {
      await updateFn(firstAttemptTxn).catch(() => undefined)
      return updateFn(secondAttemptTxn)
    }

    const request = makeFakeRequest('uid_admin_synthetic', { companyId: COMPANY_ID, inviteId: INVITE_ID })

    await expect(performResendInvite(request, fakeRunTransaction)).rejects.toBeTruthy()
    expect(generateSpy).toHaveBeenCalledTimes(1)
    expect(secondUpdateCalls).toHaveLength(0)

    generateSpy.mockRestore()
  })

  it('a lock pointing at a DIFFERENT inviteId fails closed without a write (Stage 4\'s own required check)', async () => {
    const inviteData = makePendingInviteData()
    const { txn } = makeFakeTxn({ inviteData, lockData: { currentInviteId: 'invite_someone_else_won' } })

    const fakeRunTransaction = async <T>(updateFn: (txn: Transaction) => Promise<T>): Promise<T> => updateFn(txn)
    const request = makeFakeRequest('uid_admin_synthetic', { companyId: COMPANY_ID, inviteId: INVITE_ID })

    await expect(performResendInvite(request, fakeRunTransaction)).rejects.toBeTruthy()
  })

  it('resendCount at the limit fails closed without a write', async () => {
    const inviteData = makePendingInviteData({ resendCount: 5 })
    const { txn, updateCalls } = makeFakeTxn({ inviteData })

    const fakeRunTransaction = async <T>(updateFn: (txn: Transaction) => Promise<T>): Promise<T> => updateFn(txn)
    const request = makeFakeRequest('uid_admin_synthetic', { companyId: COMPANY_ID, inviteId: INVITE_ID })

    await expect(performResendInvite(request, fakeRunTransaction)).rejects.toBeTruthy()
    expect(updateCalls).toHaveLength(0)
  })

  it('a lastSentAt within the cooldown window fails closed without a write', async () => {
    const now = Timestamp.now()
    const inviteData = makePendingInviteData({ lastSentAt: Timestamp.fromMillis(now.toMillis() - 1000) }) // 1s ago
    const { txn, updateCalls } = makeFakeTxn({ inviteData })

    const fakeRunTransaction = async <T>(updateFn: (txn: Transaction) => Promise<T>): Promise<T> => updateFn(txn)
    const request = makeFakeRequest('uid_admin_synthetic', { companyId: COMPANY_ID, inviteId: INVITE_ID })

    await expect(performResendInvite(request, fakeRunTransaction)).rejects.toBeTruthy()
    expect(updateCalls).toHaveLength(0)
  })
})
