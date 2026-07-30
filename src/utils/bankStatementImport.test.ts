import { describe, expect, it } from 'vitest'
import type { Counterparty, Transaction } from '../types'
import { parseBankStatement, type ParsedTransaction } from './bankStatementParser'
import {
  classifyStatementTransactions,
  statementFingerprint,
} from './bankStatementImport'

const ACCOUNT_ID = 'acc_main'

function parsed(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    date: '2026-07-30',
    amount: 1250.5,
    type: 'expense',
    description: 'ООО Ромашка | Оплата аренды',
    purpose: 'Оплата аренды',
    counterpart: 'ООО Ромашка',
    counterpartInn: '123',
    counterpartAccount: '456',
    raw: 'raw',
    ...overrides,
  }
}

function existing(
  source: ParsedTransaction,
  overrides: Partial<Transaction> = {},
): Transaction {
  return {
    id: 'tx_existing',
    date: source.date,
    type: source.type,
    amount: source.amount,
    accountId: ACCOUNT_ID,
    counterpartyId: 'cp_1',
    comment: source.purpose ?? source.description,
    tags: [],
    ...overrides,
  }
}

const counterparties: Counterparty[] = [{
  id: 'cp_1',
  name: 'ООО Ромашка',
  type: 'supplier',
  inn: '123',
  bankAccount: '456',
}]

describe('classifyStatementTransactions', () => {
  it('marks an exact operation on the same account as a duplicate', () => {
    const row = parsed()
    const decisions = classifyStatementTransactions(
      [row],
      [existing(row)],
      counterparties,
      ACCOUNT_ID,
    )

    expect(decisions.map(item => item.status)).toEqual(['duplicate'])
  })

  it('does not compare operations from another account', () => {
    const row = parsed()
    const decisions = classifyStatementTransactions(
      [row],
      [existing(row, { accountId: 'acc_other' })],
      counterparties,
      ACCOUNT_ID,
    )

    expect(decisions.map(item => item.status)).toEqual(['new'])
  })

  it('keeps the non-overlapping part of a statement new', () => {
    const oldRow = parsed()
    const newRow = parsed({
      date: '2026-07-31',
      amount: 800,
      purpose: 'Оплата связи',
      description: 'ПАО Связь | Оплата связи',
      counterpart: 'ПАО Связь',
      counterpartInn: '789',
      counterpartAccount: '654',
    })

    const decisions = classifyStatementTransactions(
      [oldRow, newRow],
      [existing(oldRow)],
      counterparties,
      ACCOUNT_ID,
    )

    expect(decisions.map(item => item.status)).toEqual(['duplicate', 'new'])
  })

  it('uses multiset matching for legitimate identical rows', () => {
    const row = parsed()
    const decisions = classifyStatementTransactions(
      [row, row],
      [existing(row)],
      counterparties,
      ACCOUNT_ID,
    )

    expect(decisions.map(item => item.status)).toEqual(['duplicate', 'new'])
  })

  it('does not collapse different bank operation ids', () => {
    const oldRow = parsed({ bankOperationId: '101' })
    const newRow = parsed({ bankOperationId: '102' })
    const decisions = classifyStatementTransactions(
      [newRow],
      [existing(oldRow, {
        bankOperationId: oldRow.bankOperationId,
        importFingerprint: statementFingerprint(oldRow, ACCOUNT_ID),
      })],
      counterparties,
      ACCOUNT_ID,
    )

    expect(decisions.map(item => item.status)).toEqual(['new'])
  })

  it('blocks a repeated bank operation id inside one uploaded file', () => {
    const row = parsed({ bankOperationId: '101' })
    const decisions = classifyStatementTransactions(
      [row, row],
      [],
      counterparties,
      ACCOUNT_ID,
    )

    expect(decisions.map(item => item.status)).toEqual(['new', 'duplicate'])
  })

  it('reports changed data with the same bank operation id as a conflict', () => {
    const oldRow = parsed({ bankOperationId: '101' })
    const changedRow = parsed({ bankOperationId: '101', amount: 1300 })
    const decisions = classifyStatementTransactions(
      [changedRow],
      [existing(oldRow, {
        bankOperationId: oldRow.bankOperationId,
        importFingerprint: statementFingerprint(oldRow, ACCOUNT_ID),
      })],
      counterparties,
      ACCOUNT_ID,
    )

    expect(decisions.map(item => item.status)).toEqual(['conflict'])
  })

  it('normalizes harmless text and number formatting differences', () => {
    const row = parsed()
    const decisions = classifyStatementTransactions(
      [parsed({
        purpose: '  ОПЛАТА   АРЕНДЫ ',
        counterpart: 'ооо ромашка',
        counterpartInn: '1 2 3',
        counterpartAccount: '4 5 6',
      })],
      [existing(row)],
      counterparties,
      ACCOUNT_ID,
    )

    expect(decisions.map(item => item.status)).toEqual(['duplicate'])
  })

  it('reads the document number from a 1C statement', () => {
    const result = parseBankStatement([
      '1CClientBankExchange',
      'ВерсияФормата=1.03',
      'РасчСчет=TEST_ACCOUNT_MAIN',
      'СекцияДокумент=Платежное поручение исходящее',
      'Номер=42',
      'Дата=30.07.2026',
      'Сумма=1250.50',
      'ПлательщикСчет=TEST_ACCOUNT_MAIN',
      'ПолучательСчет=TEST_ACCOUNT_COUNTERPARTY',
      'Получатель=ООО Ромашка',
      'НазначениеПлатежа=Оплата аренды',
      'КонецДокумента',
    ].join('\n'))

    expect(result.ok).toBe(true)
    expect(result.transactions[0]?.bankOperationId).toBe('42')
  })
})
