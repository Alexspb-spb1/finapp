import type { BankOperation } from '../../../../src/banks/contracts'

// Synthetic-only. No real account, company, payer, or bank statement.
export function operation(change: Partial<BankOperation> = {}): BankOperation {
  return {
    companyId: 'company-a', bankId: 'test-bank', accountKey: 'synthetic-rub',
    providerOperationId: 'synthetic-op-1', bookingDate: '2026-09-01',
    money: { currency: 'RUB', minorUnits: '12345' }, status: 'booked',
    purpose: 'Synthetic fixture payment', counterparty: { name: 'Fixture company' },
    source: { channel: 'api', deliveryId: 'synthetic-page-1' }, ...change,
  }
}
