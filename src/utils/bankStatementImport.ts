import type { Counterparty, Transaction } from '../types'
import type { ParsedTransaction } from './bankStatementParser'

export type StatementImportStatus = 'new' | 'duplicate' | 'conflict'

export interface StatementImportDecision {
  transaction: ParsedTransaction
  fingerprint: string
  status: StatementImportStatus
}

interface ExistingIdentity {
  fingerprint: string
  operationKey?: string
  used: boolean
}

function normalizeText(value?: string): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
}

function normalizeDigits(value?: string): string {
  return (value ?? '').replace(/\D/g, '')
}

function amountInKopecks(amount: number): number {
  return Math.round(amount * 100)
}

function counterpartyIdentity(
  inn?: string,
  bankAccount?: string,
  name?: string,
): string {
  const normalizedInn = normalizeDigits(inn)
  if (normalizedInn) return `inn:${normalizedInn}`

  const normalizedAccount = normalizeDigits(bankAccount)
  if (normalizedAccount) return `account:${normalizedAccount}`

  return `name:${normalizeText(name)}`
}

export function statementComment(transaction: ParsedTransaction): string {
  if (transaction.purpose != null) return transaction.purpose
  const separator = transaction.description.indexOf(' | ')
  return separator >= 0
    ? transaction.description.slice(separator + 3)
    : transaction.description
}

export function statementFingerprint(
  transaction: ParsedTransaction,
  accountId: string,
): string {
  return JSON.stringify([
    accountId,
    transaction.date,
    transaction.type,
    amountInKopecks(transaction.amount),
    normalizeText(statementComment(transaction)),
    counterpartyIdentity(
      transaction.counterpartInn,
      transaction.counterpartAccount,
      transaction.counterpart,
    ),
  ])
}

function existingFingerprint(
  transaction: Transaction,
  counterpartiesById: Map<string, Counterparty>,
): string {
  if (transaction.importFingerprint) return transaction.importFingerprint

  const counterparty = transaction.counterpartyId
    ? counterpartiesById.get(transaction.counterpartyId)
    : undefined

  return JSON.stringify([
    transaction.accountId,
    transaction.date,
    transaction.type,
    amountInKopecks(transaction.amount),
    normalizeText(transaction.comment),
    counterpartyIdentity(
      counterparty?.inn,
      counterparty?.bankAccount,
      counterparty?.name,
    ),
  ])
}

function operationKey(
  accountId: string,
  date: string,
  type: Transaction['type'],
  bankOperationId?: string,
): string | undefined {
  const normalizedId = normalizeText(bankOperationId)
  if (!normalizedId) return undefined
  return JSON.stringify([accountId, date, type, normalizedId])
}

/**
 * Classifies a statement as a multiset, not a plain set.
 *
 * Fallback fingerprints are matched as a multiset: if one identical operation
 * already exists and a statement contains two rows without bank IDs, only one
 * is a duplicate. Bank operation IDs are unique and use set semantics.
 */
export function classifyStatementTransactions(
  incoming: ParsedTransaction[],
  existing: Transaction[],
  counterparties: Counterparty[],
  accountId: string,
): StatementImportDecision[] {
  const counterpartiesById = new Map(counterparties.map(cp => [cp.id, cp]))
  const seenIncomingOperations = new Map<string, {
    fingerprint: string
    status: StatementImportStatus
  }>()
  const existingIdentities: ExistingIdentity[] = existing
    .filter(transaction =>
      transaction.accountId === accountId
      && (transaction.type === 'income' || transaction.type === 'expense')
    )
    .map(transaction => ({
      fingerprint: existingFingerprint(transaction, counterpartiesById),
      operationKey: operationKey(
        transaction.accountId,
        transaction.date,
        transaction.type,
        transaction.bankOperationId,
      ),
      used: false,
    }))

  return incoming.map(transaction => {
    const fingerprint = statementFingerprint(transaction, accountId)
    const incomingOperationKey = operationKey(
      accountId,
      transaction.date,
      transaction.type,
      transaction.bankOperationId,
    )

    const seenIncoming = incomingOperationKey
      ? seenIncomingOperations.get(incomingOperationKey)
      : undefined
    if (seenIncoming) {
      const repeatedStatus: StatementImportStatus =
        seenIncoming.fingerprint !== fingerprint || seenIncoming.status === 'conflict'
          ? 'conflict'
          : 'duplicate'
      return {
        transaction,
        fingerprint,
        status: repeatedStatus,
      }
    }

    const operationMatch = incomingOperationKey
      ? existingIdentities.find(identity =>
          identity.operationKey === incomingOperationKey
        )
      : undefined

    if (operationMatch) {
      operationMatch.used = true
      const decision: StatementImportDecision = {
        transaction,
        fingerprint,
        status: operationMatch.fingerprint === fingerprint ? 'duplicate' : 'conflict',
      }
      if (incomingOperationKey) {
        seenIncomingOperations.set(incomingOperationKey, {
          fingerprint,
          status: decision.status,
        })
      }
      return decision
    }

    const fingerprintMatch = existingIdentities.find(identity =>
      !identity.used
      && identity.fingerprint === fingerprint
      && (
        !incomingOperationKey
        || !identity.operationKey
        || identity.operationKey === incomingOperationKey
      )
    )

    if (fingerprintMatch) fingerprintMatch.used = true

    const decision: StatementImportDecision = {
      transaction,
      fingerprint,
      status: fingerprintMatch ? 'duplicate' : 'new',
    }
    if (incomingOperationKey) {
      seenIncomingOperations.set(incomingOperationKey, {
        fingerprint,
        status: decision.status,
      })
    }
    return decision
  })
}
