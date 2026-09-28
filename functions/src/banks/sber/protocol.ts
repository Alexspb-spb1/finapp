import { z } from 'zod'
import { parseBankData, BankDateSchema, CurrencySchema, BankOperationSchema, type StatementRequest } from '../contracts'
import { decimalToMoney } from '../money'
import { BankError } from '../errors'

export const SCOPES = ['openid', 'GET_STATEMENT_ACCOUNT', 'accounts', 'inn', 'offerExpirationDate', 'sub'] as const
export const API_ORIGINS = { sandbox: 'https://fintech-test.sberbank.ru:9443', production: 'https://fintech.sberbank.ru:9443' } as const
export const AUTHORIZE = 'https://sbi.sberbank.ru:9443/ic/sso/api/v2/oauth/authorize'
export const STATEMENT_PATH = '/fintech/api/v2/statement/transactions'
export const ConfigSchema = z.object({ environment: z.enum(['sandbox', 'production']),
  clientId: z.string().regex(/^[a-zA-Z0-9]+$/), redirectUri: z.url().refine(value => {
    const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search
  }), issuer: z.string().min(1).max(512) }).strict()
export type SberConfig = z.infer<typeof ConfigSchema>
export function authorizationUrl(raw: SberConfig, state: string, nonce: string): string {
  const config = parseBankData(ConfigSchema, raw)
  const u = new URL(AUTHORIZE)
  u.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
    response_type: 'code', scope: SCOPES.join(' '), state, nonce, prompt: 'login' }).toString()
  return u.toString()
}
export const TokenSchema = z.object({ access_token: z.string().min(1).max(16000),
  refresh_token: z.string().min(1).max(16000), token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.number().int().positive().max(86400), scope: z.string().max(8192),
  id_token: z.string().max(64000).optional() })
export type Tokens = z.infer<typeof TokenSchema>
export function tokens(raw: unknown): Tokens {
  const value = parseBankData(TokenSchema, raw)
  const scopes = value.scope.split(/\s+/)
  if (SCOPES.some(scope => !scopes.includes(scope)) || scopes.some(scope => !(SCOPES as readonly string[]).includes(scope))) {
    throw new BankError('bank_access_denied')
  }
  return value
}
/** Production implementation must verify the pinned bank key/chain (including GOST).
 * Merely decoding a JWT is never an implementation of this port.
 */
export interface BankSignatureVerifier { verify(compactJws: string): Promise<boolean> }
export const unavailableBankSignatureVerifier: BankSignatureVerifier = { async verify() { return false } }
const ClaimsSchema = z.object({ iss: z.string(), aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1).max(512), exp: z.number().int().positive(), iat: z.number().int().nonnegative(),
  nonce: z.string().optional(), azp: z.string().optional() }).passthrough()
export async function verifiedClaims(raw: string, config: SberConfig, verifier: BankSignatureVerifier,
  now: number, nonce?: string): Promise<z.infer<typeof ClaimsSchema>> {
  try {
    if (raw.length > 64000 || raw.split('.').length !== 3) throw new Error()
    const header = JSON.parse(Buffer.from(raw.split('.')[0], 'base64url').toString()) as { alg?: unknown; crit?: unknown }
    if (header.alg !== 'gost34.10-2012' || header.crit !== undefined || !(await verifier.verify(raw))) throw new Error()
    const claims = parseBankData(ClaimsSchema, JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString()))
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== config.issuer || !audience.includes(config.clientId) || claims.exp * 1000 <= now
      || claims.iat * 1000 > now + 30_000 || claims.iat > claims.exp
      || (audience.length > 1 && claims.azp !== config.clientId)
      || (claims.azp !== undefined && claims.azp !== config.clientId)
      || (nonce !== undefined && claims.nonce !== nonce)) throw new Error()
    return claims
  } catch { throw new BankError('bank_access_denied') }
}
export const ProfileSchema = z.object({ sub: z.string().min(1), inn: z.string().regex(/^(\d{10}|\d{12})$/),
  offerExpirationDate: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:?\d\d)$/),
  accounts: z.array(z.object({ accountNumber: z.string().regex(/^\d{20}$/), bic: z.string().regex(/^\d{9}$/) })).min(1).max(50),
})
export type Profile = z.infer<typeof ProfileSchema>
const currencies: Record<string, z.infer<typeof CurrencySchema>> = { '810': 'RUB', '643': 'RUB', '840': 'USD', '978': 'EUR', '156': 'CNY', '392': 'JPY', '414': 'KWD' }
export function accounts(companyId: string, profile: Profile) {
  const result = profile.accounts.map(a => {
    const currency = currencies[a.accountNumber.slice(5, 8)]
    if (!currency) throw new BankError('invalid_bank_data')
    return { companyId, bankId: 'sber', accountKey: `${a.bic}:${a.accountNumber}`, currency,
      maskedNumber: `****${a.accountNumber.slice(-4)}` }
  })
  if (new Set(result.map(a => a.accountKey)).size !== result.length) throw new BankError('invalid_bank_data')
  return result
}
/** Node 22 JSON source context preserves bank numeric lexemes before IEEE rounding. */
export function losslessJson(text: string): unknown {
  try {
    const parse = JSON.parse as (text: string, fn: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown
    return parse(text, (_key, value, context) => {
      if (typeof value !== 'number') return value
      if (!context?.source) throw new Error()
      return context.source
    })
  } catch { throw new BankError('invalid_bank_data') }
}
const TransferSchema = z.object({ payerAccount: z.string().max(64).optional(), payeeAccount: z.string().max(64).optional(),
  payerName: z.string().max(512).optional(), payeeName: z.string().max(512).optional(),
  payerInn: z.string().max(32).optional(), payeeInn: z.string().max(32).optional(),
  payerKpp: z.string().max(32).optional(), payeeKpp: z.string().max(32).optional(),
  payerBankBic: z.string().max(32).optional(), payeeBankBic: z.string().max(32).optional(), valueDate: BankDateSchema.optional() })
const WirePageSchema = z.object({ _links: z.array(z.object({ href: z.string().max(2048), rel: z.enum(['next', 'prev', 'self']) })).max(3),
  transactions: z.array(z.object({ operationId: z.string().min(1).max(256).optional(), uuid: z.string().optional(),
    direction: z.enum(['DEBIT', 'CREDIT']), operationDate: z.string().regex(/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?$/),
    amount: z.object({ amount: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/), currencyName: CurrencySchema }),
    paymentPurpose: z.string().max(4096), rurTransfer: TransferSchema.optional(), curTransfer: TransferSchema.optional(),
    swiftTransfer: z.unknown().optional(), revaln: z.string().optional() })).max(100) })
export const CursorSchema = z.object({ date: BankDateSchema, page: z.number().int().min(1).max(10000) }).strict()
export function statementPage(raw: unknown, request: StatementRequest, cursor: z.infer<typeof CursorSchema>, origin: string) {
  const data = parseBankData(WirePageSchema, raw)
  const number = request.accountKey.split(':')[1]
  const operations = data.transactions.map(op => {
    // Unsupported FX revaluation/SWIFT payloads fail atomically; never discard details silently.
    if (op.swiftTransfer !== undefined || op.revaln || (!op.rurTransfer && !op.curTransfer)
      || (op.rurTransfer && op.curTransfer) || op.operationDate.slice(0, 10) !== cursor.date
      || op.amount.currencyName !== request.currency) throw new BankError('invalid_bank_data')
    const t = (op.rurTransfer ?? op.curTransfer)!
    const debit = op.direction === 'DEBIT'
    if ((debit ? t.payerAccount : t.payeeAccount) !== number) throw new BankError('invalid_bank_data')
    const cp = debit ? { name: t.payeeName, taxId: t.payeeInn, registrationCode: t.payeeKpp, accountNumber: t.payeeAccount, bankCode: t.payeeBankBic }
      : { name: t.payerName, taxId: t.payerInn, registrationCode: t.payerKpp, accountNumber: t.payerAccount, bankCode: t.payerBankBic }
    return parseBankData(BankOperationSchema, { companyId: request.companyId, bankId: 'sber', accountKey: request.accountKey,
      ...(op.operationId ? { providerOperationId: op.operationId } : {}), bookingDate: cursor.date,
      ...(t.valueDate ? { valueDate: t.valueDate } : {}), money: decimalToMoney(`${debit && !/^0(?:\.0+)?$/.test(op.amount.amount) ? '-' : ''}${op.amount.amount}`, request.currency),
      status: 'booked', purpose: op.paymentPurpose, counterparty: Object.fromEntries(Object.entries(cp).filter(([, v]) => v !== undefined)),
      source: { channel: 'api', deliveryId: `${cursor.date}:${cursor.page}` } })
  })
  const nextLinks = data._links.filter(link => link.rel === 'next')
  if (nextLinks.length > 1) throw new BankError('bank_pagination_invalid')
  let next = null
  if (nextLinks.length) {
    let url: URL
    try { url = new URL(nextLinks[0].href, origin + STATEMENT_PATH) } catch { throw new BankError('bank_pagination_invalid') }
    if (url.origin !== origin || url.pathname !== STATEMENT_PATH || url.username || url.password || url.hash
      || [...url.searchParams.keys()].some(key => !['accountNumber', 'statementDate', 'page', 'curFormat'].includes(key))
      || ['accountNumber', 'statementDate', 'page'].some(key => url.searchParams.getAll(key).length !== 1)
      || url.searchParams.getAll('curFormat').length > 1
      || (url.searchParams.has('curFormat') && url.searchParams.get('curFormat') !== 'curTransfer')
      || url.searchParams.get('accountNumber') !== number || url.searchParams.get('statementDate') !== cursor.date
      || url.searchParams.get('page') !== String(cursor.page + 1)) throw new BankError('bank_pagination_invalid')
    next = { date: cursor.date, page: cursor.page + 1 }
  } else if (cursor.date < request.through) {
    const tomorrow = new Date(`${cursor.date}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    next = { date: tomorrow.toISOString().slice(0, 10), page: 1 }
  }
  return { operations, nextCursor: next ? JSON.stringify(next) : null }
}
