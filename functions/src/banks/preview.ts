import { StatementPageSchema, StatementRequestSchema, parseBankData, type BankOperation } from './contracts'
import { BankError, safeBankError } from './errors'
import type { ApiBankAdapter } from './ports'

/** Bounded, non-persistent contract harness. No jobs, cursor commits or ledger
 * writes. Production sync/recovery belongs to BANK-002, not this preview.
 * assertCurrent must perform fresh policy/consent/tenant checks; no cached
 * permit. It is also called AFTER every pending adapter call.
 */
export async function collectStatementPreview(
  adapter: ApiBankAdapter,
  rawRequest: unknown,
  assertCurrent: () => Promise<void>,
  signal: AbortSignal,
  maxPages = 20,
): Promise<readonly BankOperation[]> {
  // Adapters must not be able to alter the scope used for post-I/O validation.
  const request = Object.freeze(parseBankData(StatementRequestSchema, rawRequest))
  if (adapter.bankId !== request.bankId) throw new BankError('bank_not_supported')
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new BankError('bank_preview_limit')
  }
  const check = async () => {
    if (signal.aborted) throw new BankError('bank_run_cancelled')
    try { await assertCurrent() } catch { throw new BankError('bank_run_cancelled') }
    if (signal.aborted) throw new BankError('bank_run_cancelled')
  }
  let cursor: string | null = null
  const seen = new Set<string>()
  const operations: BankOperation[] = []
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    await check()
    let rawPage: unknown
    try { rawPage = await adapter.readStatementPage(request, cursor, signal) }
    catch (error) { throw safeBankError(error) }
    await check()
    const page = parseBankData(StatementPageSchema, rawPage)
    for (const op of page.operations) {
      if (op.companyId !== request.companyId || op.bankId !== request.bankId
        || op.accountKey !== request.accountKey || op.money.currency !== request.currency
        || op.source.channel !== 'api' || op.bookingDate < request.from || op.bookingDate > request.through) {
        throw new BankError('invalid_bank_data')
      }
      operations.push(op)
      if (operations.length > 10000) throw new BankError('bank_preview_limit')
    }
    if (page.nextCursor === null) return operations
    if (seen.has(page.nextCursor)) throw new BankError('bank_pagination_invalid')
    seen.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw new BankError('bank_preview_limit')
}
