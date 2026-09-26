import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { setBankModuleEnabled } from '../../src/banks/storage/policy'
import { BankStore } from '../../src/banks/storage/store'
import { BankReadFailure, runOnePage } from '../../src/banks/storage/worker'
import { operationKey } from '../../src/banks/identity'
import { bucketId } from '../../src/banks/storage/schema'
import type { BankOperation } from '../../src/banks/contracts'
import type { ApiBankAdapter } from '../../src/banks/ports'

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' || process.env.GCLOUD_PROJECT !== 'demo-finapp') {
  throw new Error('BANK tests require the isolated demo-finapp emulator')
}
const app = initializeApp({ projectId: 'demo-finapp' }, 'bank-storage-test')
const db = getFirestore(app)
const companyId = `bank-storage-${randomUUID()}`
const uid = 'synthetic-storage-admin'
const root = db.doc(`bankCompanies/${companyId}`)
const company = db.doc(`companies/${companyId}`)
const member = company.collection('members').doc(uid)
const policy = db.doc('system/bankIntegrations')
let now = Date.parse('2026-09-26T00:00:00Z')
let store: BankStore
const req = (data: unknown = { companyId }) => ({ data, auth: { uid, token: { email_verified: true } } }) as CallableRequest<unknown>
const statement = () => ({ companyId, bankId: 'test-bank', accountKey: 'account-1', currency: 'RUB' as const,
  from: '2026-09-01', through: '2026-09-30' })
const op = (id: string | undefined = 'op-1', change: Partial<BankOperation> = {}): BankOperation => ({
  companyId, bankId: 'test-bank', accountKey: 'account-1', ...(id ? { providerOperationId: id } : {}),
  bookingDate: '2026-09-01', money: { currency: 'RUB', minorUnits: '12345' }, status: 'booked',
  purpose: 'Synthetic only', counterparty: {}, source: { channel: 'api', deliveryId: 'synthetic' }, ...change,
})
const grant = (channel: 'api' | 'file' = 'api', id = 'connection-1') => ({
  connection: { companyId, id, bankId: 'test-bank', channel, status: 'active', generation: 0,
    consent: { status: 'active', grantedBy: uid, permissions: ['statements:read'] } },
  accounts: [{ companyId, bankId: 'test-bank', accountKey: 'account-1', currency: 'RUB', maskedNumber: '****0001' }],
})
const enqueue = (requestId = randomUUID(), connectionId = 'connection-1') => store.enqueue(req({ companyId,
  connectionId, requestId, request: statement() }))
const start = async () => {
  const ref = await enqueue()
  const lease = (await store.claim(ref, 'worker-1'))!
  return { ref, lease }
}
const token = { pageIndex: 0, cursor: null }
const page = (operations = [op()], nextCursor: string | null = null) => ({ operations, nextCursor })
const count = async (collection: string) => (await root.collection(collection).get()).size
const adapter = (read: ApiBankAdapter['readStatementPage']): ApiBankAdapter => ({ bankId: 'test-bank',
  capabilities: { channel: 'api', evidence: 'synthetic_tested', readOnly: true, balances: false,
    incremental: false, authorization: 'synthetic', revoke: 'unsupported' },
  listAccounts: async () => [], readStatementPage: read })

describe('BANK-002 transactional storage and worker recovery', () => {
  beforeEach(async () => {
    await db.recursiveDelete(root)
    now = Date.parse('2026-09-26T00:00:00Z')
    store = new BankStore(db, () => now)
    await company.set({ name: 'Synthetic BANK storage' })
    await member.set({ uid, role: 'admin', status: 'active', createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1) })
    await policy.set({ enabled: true, generation: 1 })
    await db.doc('system/maintenance').set({ enabled: false })
    await store.installVerifiedGrant(req(), grant())
  })
  afterAll(async () => {
    await db.recursiveDelete(root)
    await db.recursiveDelete(company)
    await policy.delete()
    await db.doc('system/maintenance').delete()
    await deleteApp(app)
  })
  it('atomically commits rows/cursor/receipt and replays a lost acknowledgment', async () => {
    const { ref, lease } = await start()
    expect(await store.commitPage(lease, token, page())).toBe('committed')
    now += 120_000
    expect(await store.commitPage(lease, token, page())).toBe('replayed')
    expect(await count('operations')).toBe(1)
    expect(await count('outbox')).toBe(1)
    expect((await root.collection('outbox').get()).docs[0].data().reason).toBe('publication_unavailable')
    expect((await root.collection('jobs').doc(ref.jobId).get()).data()?.status).toBe('completed')
    await expect(store.commitPage(lease, token, page([op('other')]))).rejects.toThrow('bank_run_cancelled')
    expect((await db.doc(`company_data/${companyId}`).get()).exists).toBe(false)
  })
  it('request idempotency rejects changed parameters and payload identity', async () => {
    expect(await enqueue('request-1')).toEqual(await enqueue('request-1'))
    await expect(store.enqueue(req({ companyId, connectionId: 'connection-1', requestId: 'request-1',
      request: { ...statement(), through: '2026-09-29' } }))).rejects.toThrow('invalid_bank_data')
    await expect(store.enqueue(req({ companyId, connectionId: 'connection-1', requestId: 'request-2',
      request: statement(), actorUid: uid }))).rejects.toThrow('invalid_bank_data')
  })
  it('only one concurrent claimant wins, expired lease is fenced', async () => {
    const ref = await enqueue()
    const claims = await Promise.all([store.claim(ref, 'one'), store.claim(ref, 'two')])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const old = claims.find(Boolean)!
    now += 60_001
    const fresh = (await store.claim(ref, 'three'))!
    expect(fresh.fence).toBe(old.fence + 1)
    await expect(store.commitPage(old, token, page())).rejects.toThrow('bank_run_cancelled')
    await expect(store.fail(old, 'transient')).rejects.toThrow('bank_run_cancelled')
    await store.commitPage(fresh, token, page())
  })
  it('resumes the next page in a new repository instance without redownloading committed rows', async () => {
    const { ref, lease } = await start()
    await store.commitPage(lease, token, page([op()], 'next-1'))
    store = new BankStore(db, () => now)
    const next = (await store.claim(ref, 'restart'))!
    const work = await store.readWork(next)
    expect(work.cursor).toBe('next-1')
    await store.commitPage(next, { pageIndex: work.pageIndex, cursor: work.cursor }, page([op(), op('op-2')]))
    expect(await count('operations')).toBe(2)
  })
  it('deduplicates overlapping jobs concurrently, preserving distinct bank IDs', async () => {
    const a = await start(), b = await start()
    const attempts = await Promise.allSettled([store.commitPage(a.lease, token, page([op(), op('op-2')])),
      store.commitPage(b.lease, token, page([op(), op('op-2')]))])
    expect(attempts.some(result => result.status === 'fulfilled')).toBe(true)
    // Emulator can close a contending transaction with code 3 rather than the
    // SDK-retryable ABORTED. Assert that exact failure, then recover the lease.
    for (const result of attempts) if (result.status === 'rejected') {
      expect(result.reason).toMatchObject({ code: 3 })
      expect(String(result.reason.message)).toContain('Transaction is invalid or closed')
    }
    now += 60_001
    for (const [i, { ref }] of [a, b].entries()) {
      const lease = await store.claim(ref, `recovery-${i}`)
      if (lease) await store.commitPage(lease, token, page([op(), op('op-2')]))
      expect((await root.collection('jobs').doc(ref.jobId).get()).data()?.status).toBe('completed')
      expect((await root.collection('jobs').doc(ref.jobId).collection('receipts').get()).size).toBe(1)
    }
    expect(await count('operations')).toBe(2)
    expect(await count('outbox')).toBe(2)
  })
  it('deduplicates within a page and across reconnection/channel', async () => {
    const a = await start()
    await store.commitPage(a.lease, token, page([op(), op()]))
    await store.installVerifiedGrant(req(), grant('file', 'connection-2'))
    const ref = await enqueue('file-request', 'connection-2')
    const lease = (await store.claim(ref, 'file-parser'))!
    await store.commitPage(lease, token, page([op('op-1', { source: { channel: 'file', deliveryId: 'file-1' } })]))
    expect(await count('operations')).toBe(1)
  })
  it('quarantines weak occurrences separately, including equal rows', async () => {
    const { lease } = await start()
    const weak = op('unused'); delete weak.providerOperationId
    await store.commitPage(lease, token, page([weak, weak, op()]))
    const rows = await root.collection('operations').get()
    expect(rows.size).toBe(3)
    expect(rows.docs.every(d => d.data().disposition === 'needs_review')).toBe(true)
    expect((await root.collection('matchBuckets').doc(bucketId(weak)).get()).data()?.hasWeak).toBe(true)
  })
  it('preserves original bank fields and records correction proposals', async () => {
    const a = await start(); await store.commitPage(a.lease, token, page())
    const b = await start(); await store.commitPage(b.lease, token, page([op('op-1', { purpose: 'Corrected' })]))
    const c = await start(); await store.commitPage(c.lease, token, page([op('op-1', { purpose: 'Corrected' })]))
    const row = (await root.collection('operations').doc(operationKey(op())!).get()).data()!
    expect(row.original.purpose).toBe('Synthetic only')
    expect(row.disposition).toBe('needs_review')
    expect(row.revision).toBe(1)
    expect(await count('observations')).toBe(1)
    expect(await count('outbox')).toBe(2)
    expect((await root.collection('outbox').get()).docs.every(d => d.data().state === 'blocked')).toBe(true)
  })
  it.each(['companyId', 'accountKey', 'bankId'] as const)('rejects mismatched %s before any write', async field => {
    const { ref, lease } = await start()
    await expect(store.commitPage(lease, token, page([op(), op('op-2', { [field]: 'other-value' })]))).rejects.toThrow('invalid_bank_data')
    expect(await count('operations')).toBe(0)
    expect((await root.collection('jobs').doc(ref.jobId).get()).data()?.pageIndex).toBe(0)
    expect((await root.collection('jobs').doc(ref.jobId).collection('receipts').get()).empty).toBe(true)
  })
  it('allows an empty intermediate page but rejects cursor cycles', async () => {
    const { ref, lease } = await start()
    await store.commitPage(lease, token, page([], 'A'))
    const second = (await store.claim(ref, 'worker-2'))!
    await store.commitPage(second, { pageIndex: 1, cursor: 'A' }, page([], 'B'))
    const third = (await store.claim(ref, 'worker-3'))!
    await expect(store.commitPage(third, { pageIndex: 2, cursor: 'B' }, page([op()], 'A'))).rejects.toThrow('bank_pagination_invalid')
    expect(await count('operations')).toBe(0)
  })
  it('bounds page size without partial writes', async () => {
    const { lease } = await start()
    await expect(store.commitPage(lease, token, page(Array.from({ length: 101 }, (_, i) => op(String(i)))))).rejects.toThrow('invalid_bank_data')
    expect(await count('operations')).toBe(0)
  })
  it('honors Retry-After and exhausts the retry budget', async () => {
    const ref = await enqueue()
    for (let attempt = 1; attempt <= 8; attempt++) {
      const lease = (await store.claim(ref, `worker-${attempt}`))!
      await store.fail(lease, 'rate_limited', 120_000)
      const job = (await root.collection('jobs').doc(ref.jobId).get()).data()!
      expect(job.failures).toBe(attempt)
      if (attempt < 8) {
        expect(job.nextAttemptAt).toBeGreaterThanOrEqual(now + 120_000)
        expect(await store.claim(ref, 'early')).toBeNull()
        now = job.nextAttemptAt
      } else expect(job.status).toBe('failed')
    }
    expect(await store.claim(ref, 'late')).toBeNull()
  })
  it.each(['reauth', 'consent_revoked'] as const)('%s stops all jobs on the connection', async failure => {
    const a = await start(), b = await start()
    await store.fail(a.lease, failure)
    await expect(store.commitPage(b.lease, token, page())).rejects.toThrow('bank_run_cancelled')
    expect(await count('operations')).toBe(0)
  })
  it.each(['disconnect', 'flag', 'member', 'company', 'deleting', 'maintenance', 'generation', 'consent'] as const)(
    'late provider response cannot commit after %s', async change => {
      const ref = await enqueue()
      let release!: (value: unknown) => void
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const response = new Promise<unknown>(resolve => { release = resolve })
      const running = runOnePage(store, ref, adapter(async () => { entered(); return response }))
      // Attach rejection handler before triggering the race; no unhandled promise.
      const result = running.then(() => false, () => true)
      await started
      if (change === 'disconnect') await store.disconnect(req({ companyId, connectionId: 'connection-1' }))
      if (change === 'flag') await policy.update({ enabled: false, generation: 2 })
      if (change === 'generation') await policy.update({ enabled: true, generation: 2 })
      if (change === 'member') await member.update({ status: 'disabled' })
      if (change === 'company') await company.delete()
      if (change === 'deleting') await store.markCompanyDeleting(req())
      if (change === 'maintenance') await db.doc('system/maintenance').set({ enabled: true })
      if (change === 'consent') await root.collection('connections').doc('connection-1').update({ 'consent.status': 'revoked' })
      release(page())
      expect(await result).toBe(true)
      expect(await count('operations')).toBe(0)
    })
  it('disconnect works with module off; tombstone cannot be reactivated', async () => {
    await policy.update({ enabled: false })
    await store.disconnect(req({ companyId, connectionId: 'connection-1' }))
    await store.markCompanyDeleting(req())
    await policy.update({ enabled: true })
    await expect(store.installVerifiedGrant(req(), grant())).rejects.toThrow('invalid_bank_data')
  })
  it('reconnect invalidates old jobs and removes no-longer-authorized account bindings', async () => {
    const { lease } = await start()
    const replacement = grant()
    replacement.accounts[0].accountKey = 'other-account'
    await store.installVerifiedGrant(req(), replacement)
    await expect(store.commitPage(lease, token, page())).rejects.toThrow('bank_run_cancelled')
    await expect(enqueue()).rejects.toThrow('invalid_bank_data')
  })
  it('off/on through the operator protocol never revives a previous job', async () => {
    const { lease } = await start()
    await setBankModuleEnabled(db, false)
    await setBankModuleEnabled(db, true)
    await expect(store.commitPage(lease, token, page())).rejects.toThrow('bank_run_cancelled')
    expect((await policy.get()).data()?.generation).toBe(3)
  })
  it.each(['missing_policy', 'corrupt_tenant', 'corrupt_account', 'expired_consent', 'grantor_demoted'] as const)(
    'fails closed for %s', async change => {
      const { lease } = await start()
      if (change === 'missing_policy') await policy.delete()
      if (change === 'corrupt_tenant') await root.set({ state: 'active', generation: '0' })
      if (change === 'corrupt_account') {
        const docs = await root.collection('bindings').get()
        await docs.docs[0].ref.update({ 'account.companyId': 'other-company' })
      }
      if (change === 'expired_consent') await root.collection('connections').doc('connection-1').update({
        'consent.expiresAt': new Date(now - 1).toISOString() })
      if (change === 'grantor_demoted') await member.update({ role: 'accountant' })
      await expect(store.commitPage(lease, token, page())).rejects.toThrow()
      expect(await count('operations')).toBe(0)
    })
  it('rejects malformed grants and browser-supplied ledger mappings', async () => {
    await expect(store.installVerifiedGrant(req(), { ...grant(), accounts: [{ ...grant().accounts[0],
      ledgerAccountId: 'browser-ledger' }] })).rejects.toThrow('invalid_bank_data')
    await expect(store.enqueue(req({ companyId, connectionId: 'connection-1', requestId: 'cross-tenant',
      request: { ...statement(), companyId: 'other-company' } }))).rejects.toThrow('invalid_bank_data')
  })
  it('abort ignores an adapter that returns late, then lease can be reclaimed', async () => {
    const ref = await enqueue()
    const controller = new AbortController()
    let entered!: () => void
    let release!: (value: unknown) => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const response = new Promise<unknown>(resolve => { release = resolve })
    const result = runOnePage(store, ref, adapter(async () => { entered(); return response }), controller.signal)
      .then(() => false, () => true)
    await started
    controller.abort()
    expect(await result).toBe(true)
    release(page())
    now += 60_001
    const lease = (await store.claim(ref, 'replacement'))!
    await store.commitPage(lease, token, page())
    expect(await count('operations')).toBe(1)
  })
  it('worker records safe provider categories without raw bank errors', async () => {
    const ref = await enqueue()
    expect(await runOnePage(store, ref, adapter(async () => { throw new Error('secret-provider-body') }))).toBe('retry_recorded')
    const job = (await root.collection('jobs').doc(ref.jobId).get()).data()!
    expect(JSON.stringify(job)).not.toContain('secret-provider-body')
    now = job.nextAttemptAt
    expect(await runOnePage(store, ref, adapter(async () => { throw new BankReadFailure('reauth') }))).toBe('retry_recorded')
    expect((await root.collection('connections').doc('connection-1').get()).data()?.status).toBe('requires_reauth')
  })
})
