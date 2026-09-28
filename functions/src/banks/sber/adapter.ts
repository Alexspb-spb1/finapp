import { z } from 'zod'
import type { ApiBankAdapter } from '../ports'
import { BankError } from '../errors'
import { BankAccountSchema, StatementRequestSchema, parseBankData, type BankAccount, type StatementRequest } from '../contracts'
import { API_ORIGINS, CursorSchema, losslessJson, statementPage, type SberConfig } from './protocol'
import type { SberConnections, ConnectionRef } from './service'
import { type SberTransport, requireSuccess } from './transport'

/** Construct per claimed job with server-loaded BANK-002 binding; no global user token. */
export class SberAdapter implements ApiBankAdapter {
  readonly bankId = 'sber'
  readonly capabilities = { channel: 'api', evidence: 'synthetic_tested', readOnly: true,
    balances: false, incremental: false, authorization: 'oauth', revoke: 'bank_portal' } as const
  private readonly account: BankAccount
  constructor(private readonly ref: ConnectionRef, account: BankAccount, private readonly environment: SberConfig['environment'],
    private readonly connections: Pick<SberConnections, 'accessToken'>, private readonly transport: SberTransport) {
    this.account = parseBankData(BankAccountSchema, account)
    if (this.account.companyId !== ref.companyId || this.account.bankId !== 'sber'
      || !/^\d{9}:\d{20}$/.test(account.accountKey)) throw new BankError('bank_access_denied')
  }
  async listAccounts(companyId: string, signal: AbortSignal) {
    if (companyId !== this.ref.companyId) throw new BankError('bank_access_denied')
    await this.connections.accessToken(this.ref, signal)
    return [{ ...this.account }]
  }
  async readStatementPage(raw: StatementRequest, rawCursor: string | null, signal: AbortSignal) {
    const request = parseBankData(StatementRequestSchema, raw)
    if (request.companyId !== this.ref.companyId || request.bankId !== 'sber'
      || request.accountKey !== this.account.accountKey || request.currency !== this.account.currency) throw new BankError('bank_access_denied')
    let decoded: unknown = { date: request.from, page: 1 }
    if (rawCursor !== null) {
      try { decoded = JSON.parse(parseBankData(z.string().max(2048), rawCursor)) } catch { throw new BankError('bank_pagination_invalid') }
    }
    const cursor = parseBankData(CursorSchema, decoded)
    if (cursor.date < request.from || cursor.date > request.through) throw new BankError('bank_pagination_invalid')
    const token = await this.connections.accessToken(this.ref, signal)
    const response = await this.transport.send({ resource: 'statement', token, query: new URLSearchParams({
      accountNumber: request.accountKey.split(':')[1], statementDate: cursor.date, page: String(cursor.page), curFormat: 'curTransfer',
    }) }, signal)
    // A BANK-002 page commit also checks current actor/connection/account authority.
    return statementPage(losslessJson(requireSuccess(response)), request, cursor, API_ORIGINS[this.environment])
  }
}
