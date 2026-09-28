import { describe, expect, it } from 'vitest'
import { TokenCipher } from '../../../src/banks/sber/secrets'
import { authorizationUrl } from '../../../src/banks/sber/protocol'

describe('BANK-003 baseline', () => {
  it('requires a bank authorization URL builder', () => { expect(typeof authorizationUrl).toBe('function') })
  it('binds encrypted token material to its company and connection', () => {
    const key = Buffer.alloc(32, 7)
    const cipher = new TokenCipher({ current: () => ({ id: 'test-key', key }), get: () => key })
    const sealed = cipher.seal({ access: 'synthetic-canary' }, 'company-a:connection-a')
    expect(JSON.stringify(sealed)).not.toContain('synthetic-canary')
    expect(cipher.open(sealed, 'company-a:connection-a')).toEqual({ access: 'synthetic-canary' })
    expect(() => cipher.open(sealed, 'company-b:connection-a')).toThrow('bank_access_denied')
  })
})

import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { API_ORIGINS, SCOPES, accounts, losslessJson, statementPage, tokens, verifiedClaims, unavailableBankSignatureVerifier } from '../../../src/banks/sber/protocol'
import { requireSuccess } from '../../../src/banks/sber/transport'
import { RestSberProvider } from '../../../src/banks/sber/provider'

const config = { environment: 'sandbox', clientId: 'syntheticclient', redirectUri: 'https://example.test/bank/callback', issuer: 'synthetic-issuer' } as const
const accountNumber = '40702810000000000001'
const request = { companyId: 'synthetic-company', bankId: 'sber', accountKey: `044000001:${accountNumber}`,
  currency: 'RUB', from: '2026-09-01', through: '2026-09-02' } as const
const cursor = { date: '2026-09-01', page: 1 }
const transfer = { payerAccount: accountNumber, payeeAccount: '40702810000000000002', payeeName: 'Synthetic counterparty' }
const wire = (change: Record<string, unknown> = {}) => ({ _links: [], transactions: [{ operationId: 'op-1', direction: 'DEBIT',
  operationDate: '2026-09-01T23:59:59+0300', amount: { amount: '1.01', currencyName: 'RUB' }, paymentPurpose: 'Synthetic', rurTransfer: transfer, ...change }] })
const nextLink = (href: string) => ({ ...wire(), _links: [{ rel: 'next', href }] })

describe('Sber read-only wire contract', () => {
  it('uses the bank authorization host, exact redirect, encoded state and only approved read scopes', () => {
    const url = new URL(authorizationUrl(config, 'state&injection=1', 'nonce'))
    expect(url.origin).toBe('https://sbi.sberbank.ru:9443')
    expect(url.searchParams.get('state')).toBe('state&injection=1')
    expect(url.searchParams.has('injection')).toBe(false)
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...SCOPES])
    expect(() => authorizationUrl({ ...config, redirectUri: 'http://evil.test' }, 's', 'n')).toThrow()
  })
  it('preserves large numeric amounts from raw JSON, signs debits and retains bank calendar date', () => {
    const raw = JSON.stringify(wire()).replace('"1.01"', '123456789012345678.90')
    const result = statementPage(losslessJson(raw), request, cursor, API_ORIGINS.sandbox)
    expect(result.operations[0].money.minorUnits).toBe('-12345678901234567890')
    expect(result.operations[0].bookingDate).toBe('2026-09-01')
    expect(JSON.parse(result.nextCursor!)).toEqual({ date: '2026-09-02', page: 1 })
  })
  it('normalizes credit and zero without negative zero; never substitutes uuid/number for operationId', () => {
    const credit = wire({ direction: 'CREDIT', rurTransfer: { ...transfer, payeeAccount: accountNumber } })
    expect(statementPage(credit, request, cursor, API_ORIGINS.sandbox).operations[0].money.minorUnits).toBe('101')
    const missing = wire({ operationId: undefined, uuid: 'arbitrary-uuid', amount: { amount: '0.00', currencyName: 'RUB' } })
    const op = statementPage(missing, request, cursor, API_ORIGINS.sandbox).operations[0]
    expect(op.providerOperationId).toBeUndefined()
    expect(op.money.minorUnits).toBe('0')
  })
  it.each([{ direction: 'UNKNOWN' }, { operationDate: '2026-09-02T00:00:00' }, { amount: { amount: '1e3', currencyName: 'RUB' } },
    { amount: { amount: '0.001', currencyName: 'RUB' } }, { amount: { amount: '1', currencyName: 'USD' } },
    { rurTransfer: { payerAccount: 'other' } }, { swiftTransfer: {} }, { revaln: 'ПК' }])('rejects incompatible banking data %#', change => {
    expect(() => statementPage(wire(change), request, cursor, API_ORIGINS.sandbox)).toThrow()
  })
  it('follows relative next links without using bank-provided URLs for HTTP', () => {
    const result = statementPage(nextLink(`?accountNumber=${accountNumber}&statementDate=2026-09-01&page=2&curFormat=curTransfer`), request, cursor, API_ORIGINS.sandbox)
    expect(JSON.parse(result.nextCursor!)).toEqual({ date: '2026-09-01', page: 2 })
  })
  it.each(['https://evil.test/', '//127.0.0.1/metadata', '?page=1', `?accountNumber=${accountNumber}&statementDate=2026-09-01&page=2&page=3`,
    `?accountNumber=${accountNumber}&statementDate=2026-09-01&page=2&secret=steal`,
    `https://fintech.sberbank.ru:9443/fintech/api/v2/statement/transactions?accountNumber=${accountNumber}&statementDate=2026-09-01&page=2`])('rejects unsafe pagination %s', href => {
    expect(() => statementPage(nextLink(href), request, cursor, API_ORIGINS.sandbox)).toThrow('bank_pagination_invalid')
  })
  it('treats empty intermediate pages as progress and null only after the last requested day', () => {
    expect(statementPage({ _links: [], transactions: [] }, request, cursor, API_ORIGINS.sandbox).nextCursor).not.toBeNull()
    expect(statementPage({ _links: [], transactions: [] }, request, { date: request.through, page: 1 }, API_ORIGINS.sandbox).nextCursor).toBeNull()
  })
  it('bounds oversized pages instead of truncating', () => {
    expect(() => statementPage({ _links: [], transactions: Array(101).fill(wire().transactions[0]) }, request, cursor, API_ORIGINS.sandbox)).toThrow()
  })
  it('maps verified account currencies and rejects unsupported and duplicate accounts', () => {
    const profile = { sub: 'sub', inn: '1234567890', offerExpirationDate: '2027-01-01T00:00:00Z', accounts: [{ accountNumber, bic: '044000001' }] }
    expect(accounts(request.companyId, profile)[0].currency).toBe('RUB')
    expect(() => accounts(request.companyId, { ...profile, accounts: [...profile.accounts, ...profile.accounts] })).toThrow()
    expect(() => accounts(request.companyId, { ...profile, accounts: [{ accountNumber: '40702999000000000001', bic: '044000001' }] })).toThrow()
  })
  it.each([[202, 'transient'], [401, 'reauth'], [403, 'consent_revoked'], [429, 'rate_limited'], [500, 'transient'], [302, 'permanent']])('classifies HTTP %s safely', (status, category) => {
    try { requireSuccess({ status: Number(status), body: 'synthetic-secret-body', retryAfter: '120' }) } catch (e) {
      expect(e).toMatchObject({ category })
      expect(String(e)).not.toContain('synthetic-secret-body')
      if (status === 429) expect(e).toMatchObject({ retryAfterMs: 120000 })
      return
    }
    throw new Error('Expected safe failure')
  })
  it('rejects missing/excessive scopes including payment permission', () => {
    const value = { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: SCOPES.join(' ') }
    expect(tokens(value)).toEqual(value)
    expect(() => tokens({ ...value, scope: `${value.scope} PAY_DOC_RU` })).toThrow()
    expect(() => tokens({ ...value, scope: 'openid' })).toThrow()
  })
})

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
// This synthetic verifier checks RSA fixture bytes; it does not implement the
// GOST/CMS algorithm declared by the Sber header and must never be mounted.
const makeJwt = (claims: Record<string, unknown>, alg = 'gost34.10-2012') => {
  const unsigned = `${Buffer.from(JSON.stringify({ alg })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`
}
const verifier = { async verify(raw: string) {
  const parts = raw.split('.'); return verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), publicKey, Buffer.from(parts[2], 'base64url'))
} }
const now = Date.parse('2026-09-26T00:00:00Z')
const claims = { iss: config.issuer, aud: config.clientId, sub: 'synthetic-sub', exp: now / 1000 + 3600, iat: now / 1000, nonce: 'nonce' }

describe('Sber signed identity boundary (synthetic RSA verifier, NOT bank GOST evidence)', () => {
  it('verifies a signed fixture and denies default/unconfigured verification', async () => {
    expect((await verifiedClaims(makeJwt(claims), config, verifier, now, 'nonce')).sub).toBe('synthetic-sub')
    await expect(verifiedClaims(makeJwt(claims), config, unavailableBankSignatureVerifier, now, 'nonce')).rejects.toThrow()
  })
  it.each([{ iss: 'other' }, { aud: 'other' }, { nonce: 'other' }, { exp: now / 1000 }, { iat: now / 1000 + 3600 },
    { aud: [config.clientId, 'other'], azp: 'other' }])('rejects invalid signed claims %#', async change => {
    await expect(verifiedClaims(makeJwt({ ...claims, ...change }), config, verifier, now, 'nonce')).rejects.toThrow('bank_access_denied')
  })
  it('rejects unsigned/modified tokens', async () => {
    await expect(verifiedClaims(makeJwt(claims, 'none'), config, verifier, now)).rejects.toThrow()
    await expect(verifiedClaims(makeJwt(claims, 'RS256'), config, verifier, now)).rejects.toThrow('bank_access_denied')
    const jwt = makeJwt(claims).split('.'); jwt[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'forged' })).toString('base64url')
    await expect(verifiedClaims(jwt.join('.'), config, verifier, now)).rejects.toThrow()
  })
  it('exchanges code and verifies matching signed user-info with the exact redirect', async () => {
    const calls: string[] = []
    const p = new RestSberProvider(config, { async send(input) {
      calls.push(input.resource)
      if (input.resource === 'token') {
        expect(input.form?.get('redirect_uri')).toBe(config.redirectUri)
        expect(input.form?.get('grant_type')).toBe('authorization_code')
        return { status: 200, body: JSON.stringify({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer',
          expires_in: 3600, scope: SCOPES.join(' '), id_token: makeJwt(claims) }) }
      }
      return { status: 200, body: makeJwt({ ...claims, inn: '1234567890', offerExpirationDate: '2027-01-01T00:00:00Z', accounts: [{ accountNumber, bic: '044000001' }] }) }
    } }, async () => 'synthetic-secret', verifier, () => now)
    expect((await p.exchange('code', 'nonce', new AbortController().signal)).profile.inn).toBe('1234567890')
    expect(calls).toEqual(['token', 'profile'])
  })
})

import { SberAdapter } from '../../../src/banks/sber/adapter'
describe('Sber adapter tenant and pagination wiring', () => {
  it('does not request a token or bank data for another tenant/account', async () => {
    let tokenReads = 0, networkCalls = 0
    const adapter = new SberAdapter({ companyId: request.companyId, connectionId: 'connection' },
      { companyId: request.companyId, bankId: 'sber', accountKey: request.accountKey, currency: 'RUB', maskedNumber: '****0001' },
      'sandbox', { async accessToken() { tokenReads++; return 'synthetic' } }, { async send() { networkCalls++; return { status: 200, body: '{}' } } })
    await expect(adapter.readStatementPage({ ...request, companyId: 'other' }, null, new AbortController().signal)).rejects.toThrow()
    await expect(adapter.readStatementPage({ ...request, accountKey: 'other' }, null, new AbortController().signal)).rejects.toThrow()
    expect(tokenReads).toBe(0); expect(networkCalls).toBe(0)
  })
  it('reconstructs the documented request for persisted day/page cursor', async () => {
    const adapter = new SberAdapter({ companyId: request.companyId, connectionId: 'connection' },
      { companyId: request.companyId, bankId: 'sber', accountKey: request.accountKey, currency: 'RUB', maskedNumber: '****0001' },
      'sandbox', { async accessToken() { return 'synthetic' } }, { async send(input) {
        expect(input.resource).toBe('statement')
        expect(input.query?.get('accountNumber')).toBe(accountNumber)
        expect(input.query?.get('statementDate')).toBe('2026-09-02')
        expect(input.query?.get('page')).toBe('4')
        return { status: 200, body: '{"_links":[],"transactions":[]}' }
      } })
    expect(await adapter.readStatementPage(request, JSON.stringify({ date: '2026-09-02', page: 4 }), new AbortController().signal))
      .toEqual({ operations: [], nextCursor: null })
  })
})
