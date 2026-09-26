import { describe, expect, it } from 'vitest'
import { decimalToMoney } from '../../../src/banks/money'
import { BankDateSchema, BankOperationSchema } from '../../../src/banks/contracts'
import { classifyOperation, operationKey } from '../../../src/banks/identity'
import { operation } from './fixtures/statement'

describe('BANK-001 exact money and strict data boundaries', () => {
  it.each([
    ['9007199254740993.01', 'RUB', '900719925474099301'],
    ['-0.01', 'RUB', '-1'], ['1.2', 'EUR', '120'],
    ['123', 'JPY', '123'], ['0.001', 'KWD', '1'], ['-0.00', 'USD', '0'],
  ])('converts %s %s without float arithmetic', (amount, currency, minorUnits) => {
    expect(decimalToMoney(amount, currency)).toEqual({ currency, minorUnits })
  })
  it.each(['NaN', 'Infinity', '1e3', '1,00', ' 1', '01.0', '1.', '.5', '0.001', '9'.repeat(40)])('rejects unsafe RUB value %s', amount => {
    expect(() => decimalToMoney(amount, 'RUB')).toThrow('invalid_bank_data')
  })
  it('rejects unknown currency and precision, with no implicit rounding', () => {
    expect(() => decimalToMoney('1', 'XXX')).toThrow('invalid_bank_data')
    expect(() => decimalToMoney('1.1', 'JPY')).toThrow('invalid_bank_data')
  })
  it.each(['2026-02-29', '2026-04-31', '2026-1-01', '2026-01-01T00:00:00Z', '0000-01-01'])('rejects invalid bank date %s', date => {
    expect(BankDateSchema.safeParse(date).success).toBe(false)
  })
  it('accepts leap day and rejects unexpected secrets and markup', () => {
    expect(BankDateSchema.safeParse('2024-02-29').success).toBe(true)
    expect(BankOperationSchema.safeParse(operation()).success).toBe(true)
    for (const extra of [{ accessToken: 'secret' }, { categoryId: 'manual' }, { comment: 'manual' }]) {
      expect(BankOperationSchema.safeParse({ ...operation(), ...extra }).success).toBe(false)
    }
    expect(BankOperationSchema.safeParse({ ...operation(), companyId: '../escape' }).success).toBe(false)
  })
})

describe('BANK-001 conservative identity decisions (no persistent dedupe claims)', () => {
  it('keeps identity across connections and API/file channels', () => {
    const a = operation()
    const b = operation({ source: { channel: 'file', deliveryId: 'file-2' } })
    expect(operationKey(a)).toBe(operationKey(b))
    expect(classifyOperation(b, [a])).toEqual({ kind: 'duplicate', key: operationKey(a) })
  })
  it('does not merge companies, banks or accounts', () => {
    const a = operation()
    for (const change of [{ companyId: 'company-b' }, { bankId: 'test-other' }, { accountKey: 'other-account' }]) {
      expect(operationKey(operation(change))).not.toBe(operationKey(a))
      expect(classifyOperation(operation(change), [a]).kind).toBe('new')
    }
  })
  it('different IDs on the same date/amount are separate payments', () => {
    expect(classifyOperation(operation({ providerOperationId: 'op-2' }), [operation()]).kind).toBe('new')
  })
  it('changed amount, date or counterparty for a known ID requires correction review', () => {
    for (const change of [
      { money: { currency: 'RUB' as const, minorUnits: '999' } },
      { bookingDate: '2026-09-02' }, { counterparty: { name: 'Another' } },
      { status: 'reversed' as const },
    ]) {
      expect(classifyOperation(operation(change), [operation()]).kind).toBe('correction')
    }
  })
  it('identical fields without stable IDs require review, never silent deletion', () => {
    const a = operation({ providerOperationId: undefined })
    expect(operationKey(a)).toBeUndefined()
    expect(classifyOperation(a, [a]).kind).toBe('needs_review')
    expect(classifyOperation(operation(), [a]).kind).toBe('needs_review')
  })
  it('corrupted history with duplicate strong keys requires review', () => {
    expect(classifyOperation(operation(), [operation(), operation()]).kind).toBe('needs_review')
  })
})
