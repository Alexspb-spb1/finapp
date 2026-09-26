import { createHash } from 'node:crypto'
import { BankOperationSchema, parseBankData, type BankOperation } from './contracts'

const digest = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

export function operationKey(raw: BankOperation): string | undefined {
  const op = parseBankData(BankOperationSchema, raw)
  if (!op.providerOperationId) return undefined
  // Do not include channel, date or connection ID: a bank correction can change
  // date/amount, and reconnect must preserve identity. ID case is significant.
  return digest(['bank-operation-v1', op.companyId, op.bankId, op.accountKey, op.providerOperationId])
}

function fingerprint(op: BankOperation): string {
  const cp = op.counterparty
  return digest(['bank-fields-v1', op.companyId, op.bankId, op.accountKey,
    op.bookingDate, op.valueDate ?? null, op.money.currency, op.money.minorUnits,
    op.status, op.purpose, cp.name ?? null, cp.taxId ?? null,
    cp.registrationCode ?? null, cp.accountNumber ?? null, cp.bankCode ?? null])
}

export type IdentityDecision =
  | { kind: 'new' | 'needs_review' }
  | { kind: 'duplicate' | 'correction'; key: string }

/** Conservative pure classifier, NOT a durable ingestion/idempotency store. */
export function classifyOperation(raw: BankOperation, history: readonly BankOperation[]): IdentityDecision {
  const incoming = parseBankData(BankOperationSchema, raw)
  const existing = history.map(value => parseBankData(BankOperationSchema, value))
  const key = operationKey(incoming)
  if (key) {
    const matches = existing.filter(value => operationKey(value) === key)
    if (matches.length > 1) return { kind: 'needs_review' }
    if (matches.length === 1) {
      return { kind: fingerprint(incoming) === fingerprint(matches[0]) ? 'duplicate' : 'correction', key }
    }
  }
  const candidate = existing.some(value =>
    (!key || !operationKey(value)) && fingerprint(value) === fingerprint(incoming))
  return { kind: candidate ? 'needs_review' : 'new' }
}
