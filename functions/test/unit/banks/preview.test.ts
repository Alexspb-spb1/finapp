import { describe, expect, it, vi } from 'vitest'
import type { ApiBankAdapter } from '../../../src/banks/ports'
import { unavailableLedgerPublisher } from '../../../src/banks/ports'
import { BankAccountSchema, parseBankData, type BankAccount, type StatementPage } from '../../../src/banks/contracts'
import { syntheticBank } from '../../../src/banks/adapters/synthetic'
import { createApiRegistry } from '../../../src/banks/adapters/registry'
import { collectStatementPreview } from '../../../src/banks/preview'
import { operation } from './fixtures/statement'

const account: BankAccount = { companyId: 'company-a', bankId: 'test-bank',
  accountKey: 'synthetic-rub', currency: 'RUB', maskedNumber: '****TEST' }
const request = { companyId: account.companyId, bankId: account.bankId,
  accountKey: account.accountKey, currency: account.currency, from: '2026-09-01', through: '2026-09-30' }
const signal = () => new AbortController().signal
const allow = async () => undefined
const adapter = () => syntheticBank(account, [[operation()], [], [operation({ providerOperationId: 'synthetic-op-2' })]])

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

describe('BANK-001 synthetic adapter and bounded contract harness', () => {
  it('follows all pages including an empty intermediate page', async () => {
    const bank = adapter()
    const calls = vi.spyOn(bank, 'readStatementPage')
    expect(await collectStatementPreview(bank, request, allow, signal())).toHaveLength(2)
    expect(calls.mock.calls.map(call => call[1])).toEqual([null, '1', '2'])
    const rows = await bank.listAccounts('company-a', signal()) as unknown[]
    expect(parseBankData(BankAccountSchema, rows[0])).toEqual(account)
    await expect(bank.listAccounts('company-b', signal())).rejects.toThrow('bank_access_denied')
  })
  it('cannot accidentally publish into the existing financial model', async () => {
    await expect(unavailableLedgerPublisher.publish({ version: 1, companyId: 'company-a',
      operationKey: 'op', sourceRevision: 1, expectedLedgerRevision: null,
      connectionGeneration: 0, policyGeneration: 0, idempotencyKey: 'request', bankData: operation() })).rejects.toThrow('publication_unavailable')
  })
  it('does not expose researched banks as implemented adapters', () => {
    const empty = createApiRegistry()
    expect(empty.bankIds()).toEqual([])
    expect(() => empty.get('sber')).toThrow('bank_not_supported')
    const bank = adapter()
    expect(createApiRegistry([bank]).get('test-bank')).toBe(bank)
    expect(() => createApiRegistry([bank, bank])).toThrow('invalid_bank_data')
  })
  it('does not let an adapter mutate the scope before returning foreign operations', async () => {
    const bank = adapter()
    vi.spyOn(bank, 'readStatementPage').mockImplementation(async scopedRequest => {
      scopedRequest.companyId = 'company-b'
      return { operations: [operation({ companyId: 'company-b' })], nextCursor: null }
    })
    await expect(collectStatementPreview(bank, request, allow, signal())).rejects.toThrow('bank_unavailable')
  })
  it('has no requests when initially disabled', async () => {
    const bank = adapter()
    const spy = vi.spyOn(bank, 'readStatementPage')
    await expect(collectStatementPreview(bank, request, async () => { throw new Error('disabled') }, signal())).rejects.toThrow('bank_run_cancelled')
    expect(spy).not.toHaveBeenCalled()
  })
  it.each(['flag off', 'consent revoked', 'company deleting', 'membership disabled'])('rejects an in-flight result after %s', async () => {
    const bank = adapter()
    const started = deferred<void>()
    const response = deferred<StatementPage>()
    let allowed = true
    const read = vi.spyOn(bank, 'readStatementPage').mockImplementation(async () => {
      started.resolve(); return response.promise
    })
    const pending = collectStatementPreview(bank, request, async () => { if (!allowed) throw new Error('revoked') }, signal())
    // Attach rejection assertion BEFORE resolving deferred work (no timer race).
    const rejected = expect(pending).rejects.toThrow('bank_run_cancelled')
    await started.promise
    allowed = false
    response.resolve({ operations: [operation()], nextCursor: '1' })
    await rejected
    expect(read).toHaveBeenCalledOnce()
  })
  it('honors abort before start and after a provider ignores cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const bank = adapter()
    const spy = vi.spyOn(bank, 'readStatementPage')
    await expect(collectStatementPreview(bank, request, allow, controller.signal)).rejects.toThrow('bank_run_cancelled')
    expect(spy).not.toHaveBeenCalled()
    const later = new AbortController()
    spy.mockImplementation(async () => { later.abort(); return { operations: [operation()], nextCursor: null } })
    await expect(collectStatementPreview(bank, request, allow, later.signal)).rejects.toThrow('bank_run_cancelled')
  })
  it.each([
    { companyId: 'company-b' }, { bankId: 'other-bank' }, { accountKey: 'foreign' },
    { money: { currency: 'USD' as const, minorUnits: '12345' } },
    { bookingDate: '2026-08-31' }, { source: { channel: 'email' as const, deliveryId: 'unverified' } },
  ])('rejects provider tenant/account/currency/date/channel contamination', async change => {
    const bank = syntheticBank(account, [[operation(change)]])
    await expect(collectStatementPreview(bank, request, allow, signal())).rejects.toThrow('invalid_bank_data')
  })
  it('rejects unknown bank, malformed request and cyclic or excessive pagination', async () => {
    await expect(collectStatementPreview(adapter(), { ...request, bankId: 'unknown-bank' }, allow, signal())).rejects.toThrow('bank_not_supported')
    await expect(collectStatementPreview(adapter(), { ...request, through: '2026-08-01' }, allow, signal())).rejects.toThrow('invalid_bank_data')
    const bank = adapter()
    vi.spyOn(bank, 'readStatementPage').mockResolvedValue({ operations: [], nextCursor: 'loop' })
    await expect(collectStatementPreview(bank, request, allow, signal())).rejects.toThrow('bank_pagination_invalid')
    await expect(collectStatementPreview(adapter(), request, allow, signal(), 1)).rejects.toThrow('bank_preview_limit')
    await expect(collectStatementPreview(adapter(), request, allow, signal(), 0)).rejects.toThrow('bank_preview_limit')
  })
  it('rejects raw credentials and hides provider error text', async () => {
    const bank = adapter()
    const read = vi.spyOn(bank, 'readStatementPage').mockResolvedValue({ operations: [], nextCursor: null, token: 'canary-secret' })
    await expect(collectStatementPreview(bank, request, allow, signal())).rejects.toThrow('invalid_bank_data')
    read.mockRejectedValue(new Error('Bearer canary-secret'))
    await expect(collectStatementPreview(bank, request, allow, signal())).rejects.toThrow(/^bank_unavailable$/)
  })
  it('accepts a second adapter with an unrelated cursor protocol without changing core', async () => {
    const bank: ApiBankAdapter = {
      bankId: 'second-bank', capabilities: adapter().capabilities,
      listAccounts: async () => [{ ...account, bankId: 'second-bank' }],
      readStatementPage: async (_request, cursor) => ({
        operations: [operation({ bankId: 'second-bank', providerOperationId: cursor ?? 'first' })],
        nextCursor: cursor === null ? 'opaque:after:first' : null,
      }),
    }
    const result = await collectStatementPreview(bank, { ...request, bankId: 'second-bank' }, allow, signal())
    expect(result.map(op => op.providerOperationId)).toEqual(['first', 'opaque:after:first'])
  })
})
