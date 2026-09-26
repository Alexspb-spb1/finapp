import { BankError } from '../errors'
import type { ApiBankAdapter } from '../ports'
import type { BankAccount, BankOperation, StatementRequest } from '../contracts'

/** Deterministic test bank. It performs no network I/O and holds no secrets. */
export function syntheticBank(
  account: BankAccount, pages: readonly (readonly BankOperation[])[],
): ApiBankAdapter {
  const fixture = structuredClone(pages)
  const ownedAccount = structuredClone(account)
  return {
    bankId: ownedAccount.bankId,
    capabilities: { channel: 'api', evidence: 'synthetic_tested', readOnly: true,
      balances: false, incremental: false, authorization: 'synthetic', revoke: 'unsupported' },
    async listAccounts(companyId, signal) {
      if (signal.aborted) throw new BankError('bank_run_cancelled')
      if (companyId !== ownedAccount.companyId) throw new BankError('bank_access_denied')
      return [structuredClone(ownedAccount)]
    },
    async readStatementPage(request: StatementRequest, cursor, signal) {
      if (signal.aborted) throw new BankError('bank_run_cancelled')
      if (request.companyId !== ownedAccount.companyId || request.bankId !== ownedAccount.bankId
        || request.accountKey !== ownedAccount.accountKey) throw new BankError('bank_access_denied')
      if (cursor !== null && !/^[1-9]\d{0,5}$/.test(cursor)) throw new BankError('bank_pagination_invalid')
      const index = cursor === null ? 0 : Number(cursor)
      if (index > 0 && index >= fixture.length) throw new BankError('bank_pagination_invalid')
      return { operations: structuredClone(fixture[index] ?? []),
        nextCursor: index + 1 < fixture.length ? String(index + 1) : null }
    },
  }
}
