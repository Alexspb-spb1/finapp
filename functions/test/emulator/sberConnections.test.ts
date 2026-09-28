import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { DecodedIdToken } from 'firebase-admin/auth'
import type { Request } from 'firebase-functions/v2/https'
import type { Response } from 'express'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { SberConnections } from '../../src/banks/sber/service'
import { TokenCipher } from '../../src/banks/sber/secrets'
import { SCOPES, type Tokens, type Profile } from '../../src/banks/sber/protocol'
import { BankStore } from '../../src/banks/storage/store'
import { BankReadFailure } from '../../src/banks/storage/worker'
import { setBankModuleEnabled } from '../../src/banks/storage/policy'
import { createSberHttpHandlers } from '../../src/banks/sber/http'

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' || process.env.GCLOUD_PROJECT !== 'demo-finapp') throw new Error('Sber tests require demo-finapp emulator')
const app = initializeApp({ projectId: 'demo-finapp' }, 'sber-connections-test')
const db = getFirestore(app)
const companyId = `sber-test-${randomUUID()}`, otherCompany = `${companyId}-other`, uid = 'sber-test-admin'
const ref = { companyId, connectionId: 'sber-connection' }
const root = db.doc(`bankCompanies/${companyId}`), otherRoot = db.doc(`bankCompanies/${otherCompany}`)
const policy = db.doc('system/bankIntegrations'), maintenance = db.doc('system/maintenance')
const session = 'synthetic-session-'.repeat(4)
const config = { environment: 'sandbox', clientId: 'syntheticclient', redirectUri: 'https://example.test/callback', issuer: 'synthetic' } as const
const accountNumber = '40702810000000000001'
const value = (suffix = ''): Tokens => ({ access_token: `synthetic-access-canary${suffix}`, refresh_token: `synthetic-refresh-canary${suffix}`,
  expires_in: 3600, token_type: 'Bearer', scope: SCOPES.join(' ') })
const profile = (): Profile => ({ sub: 'synthetic-sub', inn: '1234567890', offerExpirationDate: '2027-01-01T00:00:00Z',
  accounts: [{ bic: '044000001', accountNumber }] })
const request = (data: unknown, user = uid) => ({ data, auth: { uid: user, token: { email_verified: true } } }) as CallableRequest<unknown>
const member = (id = companyId, user = uid) => db.doc(`companies/${id}/members/${user}`)
let now: number, service: SberConnections, exchanges: number, refreshes: number
let exchangeImpl: (code: string, nonce: string) => Promise<{ tokens: Tokens; profile: Profile }>
let refreshImpl: (refresh: string) => Promise<Tokens>
const cipher = new TokenCipher({ current: () => ({ id: 'synthetic-key', key: Buffer.alloc(32, 9) }), get: () => Buffer.alloc(32, 9) })
const makeService = () => new SberConnections(db, config, {
  async exchange(code, nonce) { exchanges++; return exchangeImpl(code, nonce) },
  async refresh(refresh) { refreshes++; return refreshImpl(refresh) },
}, cipher, () => now)
const signal = () => new AbortController().signal
const begin = async (id = companyId) => {
  const result = await service.begin(request({ ...ref, companyId: id }), session)
  return new URL(result.authorizationUrl).searchParams.get('state')!
}
const complete = (state: string, user = uid, cookie = session) => service.callback(request({ state, code: 'synthetic-code' }, user), cookie, signal())
const connect = async () => complete(await begin())
const credential = () => root.collection('credentials').doc(ref.connectionId)
const connection = () => root.collection('connections').doc(ref.connectionId)
const seedMember = async (id: string, user: string) => member(id, user).set({ uid: user, role: 'admin', status: 'active',
  createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1) })

describe('BANK-003 OAuth isolation and durable refresh', () => {
  beforeEach(async () => {
    await db.recursiveDelete(root); await db.recursiveDelete(otherRoot)
    const states = await db.collection('bankOAuthStates').where('uid', '==', uid).get()
    for (const doc of states.docs) await doc.ref.delete()
    now = Date.parse('2026-09-26T00:00:00Z'); exchanges = 0; refreshes = 0
    exchangeImpl = async () => ({ tokens: value(), profile: profile() })
    refreshImpl = async () => value('-rotated')
    service = makeService()
    for (const id of [companyId, otherCompany]) {
      await db.doc(`companies/${id}`).set({ inn: '1234567890', name: 'Synthetic' })
      await seedMember(id, uid)
    }
    await policy.set({ enabled: true, generation: 1 }); await maintenance.set({ enabled: false })
  })
  afterAll(async () => {
    await db.recursiveDelete(root); await db.recursiveDelete(otherRoot)
    for (const id of [companyId, otherCompany]) await db.recursiveDelete(db.doc(`companies/${id}`))
    for (const doc of (await db.collection('bankOAuthStates').where('uid', '==', uid).get()).docs) await doc.ref.delete()
    await policy.delete(); await maintenance.delete(); await deleteApp(app)
  })
  it('activates a company connection, bindings and encrypted credentials atomically', async () => {
    expect(await connect()).toEqual(ref)
    expect((await connection().get()).data()?.status).toBe('active')
    expect((await root.collection('bindings').get()).size).toBe(1)
    expect(JSON.stringify((await credential().get()).data())).not.toContain('canary')
    expect(await service.accessToken(ref, signal())).toBe(value().access_token)
    expect(refreshes).toBe(0)
    expect((await db.doc(`company_data/${companyId}`).get()).exists).toBe(false)
  })
  it('rejects replay and concurrent callback reuse before another exchange', async () => {
    const state = await begin()
    const results = await Promise.allSettled([complete(state), complete(state)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(exchanges).toBe(1)
    await expect(complete(state)).rejects.toThrow()
    expect(exchanges).toBe(1)
  })
  it('does not consume a valid state for another user/session', async () => {
    const state = await begin()
    await seedMember(companyId, 'other-admin')
    await expect(complete(state, 'other-admin')).rejects.toThrow()
    await expect(complete(state, uid, 'wrong-session'.repeat(5))).rejects.toThrow()
    expect(exchanges).toBe(0)
    await complete(state)
    expect(exchanges).toBe(1)
  })
  it('TTL and configuration changes invalidate callback', async () => {
    const state = await begin(); now += 600_001
    await expect(complete(state)).rejects.toThrow()
    expect(exchanges).toBe(0)
  })
  it('binds tokens to company and refuses swapping ciphertext between tenants', async () => {
    await connect(); await complete(await begin(otherCompany))
    const original = (await credential().get()).data()!
    await otherRoot.collection('credentials').doc(ref.connectionId).update({ sealed: original.sealed })
    await expect(service.accessToken({ ...ref, companyId: otherCompany }, signal())).rejects.toThrow('bank_access_denied')
    expect(await service.accessToken(ref, signal())).toBe(value().access_token)
  })
  it('requires matching company INN from verified bank profile', async () => {
    exchangeImpl = async () => ({ tokens: value(), profile: { ...profile(), inn: '9999999999' } })
    await expect(connect()).rejects.toThrow('bank_access_denied')
    expect((await credential().get()).exists).toBe(false)
    expect((await connection().get()).data()?.status).toBe('awaiting_authorization')
  })
  it('rejects absent company INN before contacting bank', async () => {
    await db.doc(`companies/${companyId}`).set({ name: 'Synthetic without INN' })
    await expect(begin()).rejects.toThrow()
    expect(exchanges).toBe(0)
  })
  it.each(['disconnect', 'policy', 'membership', 'delete', 'new_attempt', 'inn'] as const)('late code exchange cannot activate after %s', async change => {
    const state = await begin()
    let entered!: () => void, release!: (v: { tokens: Tokens; profile: Profile }) => void
    const started = new Promise<void>(r => { entered = r })
    const response = new Promise<{ tokens: Tokens; profile: Profile }>(r => { release = r })
    exchangeImpl = async () => { entered(); return response }
    const result = complete(state).then(() => false, () => true)
    await started
    if (change === 'disconnect') await new BankStore(db, () => now).disconnect(request(ref))
    if (change === 'policy') { await setBankModuleEnabled(db, false); await setBankModuleEnabled(db, true) }
    if (change === 'membership') await member().update({ status: 'disabled' })
    if (change === 'delete') await new BankStore(db, () => now).markCompanyDeleting(request({ companyId }))
    if (change === 'new_attempt') await begin()
    if (change === 'inn') await db.doc(`companies/${companyId}`).update({ inn: '9999999999' })
    release({ tokens: value(), profile: profile() })
    expect(await result).toBe(true)
    expect((await credential().get()).exists).toBe(false)
    expect((await root.collection('bindings').get()).empty).toBe(true)
  })
  it('a failed exchange consumes the code; fresh authorization is required', async () => {
    exchangeImpl = async () => { throw new BankReadFailure('transient') }
    const state = await begin()
    await expect(complete(state)).rejects.toThrow()
    await expect(complete(state)).rejects.toThrow()
    expect(exchanges).toBe(1)
  })
  it('only one refresh runs concurrently; other caller retries, then reads persisted rotated token', async () => {
    await connect(); now += 3_550_000
    let entered!: () => void, release!: (v: Tokens) => void
    const started = new Promise<void>(r => { entered = r }), response = new Promise<Tokens>(r => { release = r })
    refreshImpl = async () => { entered(); return response }
    const first = service.accessToken(ref, signal())
    await started
    await expect(service.accessToken(ref, signal())).rejects.toMatchObject({ category: 'transient' })
    expect(refreshes).toBe(1)
    release(value('-new')); expect(await first).toBe(value('-new').access_token)
    service = makeService()
    expect(await service.accessToken(ref, signal())).toBe(value('-new').access_token)
    expect((await credential().get()).data()?.version).toBe(1)
  })
  it('crashed refresh recovers with the same token after lease expiry and fences old response', async () => {
    await connect(); now += 3_550_000
    let entered!: () => void, release!: (v: Tokens) => void
    const started = new Promise<void>(r => { entered = r }), response = new Promise<Tokens>(r => { release = r })
    refreshImpl = async token => { expect(token).toBe(value().refresh_token); entered(); return response }
    const old = service.accessToken(ref, signal()).then(() => false, () => true)
    await started; now += 60_001
    refreshImpl = async token => { expect(token).toBe(value().refresh_token); return value('-winner') }
    expect(await service.accessToken(ref, signal())).toBe(value('-winner').access_token)
    release(value('-stale')); expect(await old).toBe(true)
    expect(await service.accessToken(ref, signal())).toBe(value('-winner').access_token)
  })
  it('unknown refresh outcome outside recovery window requires reauthorization', async () => {
    await connect(); now += 3_550_000
    refreshImpl = async () => { throw new BankReadFailure('transient') }
    await expect(service.accessToken(ref, signal())).rejects.toThrow()
    now += 3_600_001
    await expect(service.accessToken(ref, signal())).rejects.toMatchObject({ category: 'reauth' })
    expect(refreshes).toBe(1)
  })
  it('persists Retry-After across service restarts', async () => {
    await connect(); now += 3_550_000
    refreshImpl = async () => { throw new BankReadFailure('rate_limited', 120000) }
    await expect(service.accessToken(ref, signal())).rejects.toMatchObject({ category: 'rate_limited' })
    now += 60_001; service = makeService()
    await expect(service.accessToken(ref, signal())).rejects.toMatchObject({ category: 'rate_limited' })
    expect(refreshes).toBe(1)
    now += 60_000; refreshImpl = async () => value('-recovered')
    expect(await service.accessToken(ref, signal())).toBe(value('-recovered').access_token)
  })
  it('invalid refresh grant disables the connection for further token reads', async () => {
    await connect(); now += 3_550_000
    refreshImpl = async () => { throw new BankReadFailure('reauth') }
    await expect(service.accessToken(ref, signal())).rejects.toMatchObject({ category: 'reauth' })
    expect((await connection().get()).data()?.status).toBe('requires_reauth')
    await expect(service.accessToken(ref, signal())).rejects.toThrow('bank_access_denied')
  })
  it('disconnect while refresh is pending prevents token persistence/return', async () => {
    await connect(); now += 3_550_000
    let entered!: () => void, release!: (v: Tokens) => void
    const started = new Promise<void>(r => { entered = r }), response = new Promise<Tokens>(r => { release = r })
    refreshImpl = async () => { entered(); return response }
    const result = service.accessToken(ref, signal()).then(() => false, () => true)
    await started
    await new BankStore(db, () => now).disconnect(request(ref))
    release(value('-late')); expect(await result).toBe(true)
    expect((await credential().get()).data()?.version).toBe(0)
  })
  it('HTTP cookie binding reaches real transactional activation; swapped browser and replay cannot exchange', async () => {
    // Admin SDK is substituted; Firestore, domain guards/state and encryption are real.
    const token = { uid, sub: uid, email_verified: true, auth_time: now / 1000 - 60, exp: now / 1000 + 600 } as DecodedIdToken
    const handlers = createSberHttpHandlers(config, { beginUrl: 'https://example.test/begin', returnUrl: 'https://example.test/banks' }, {
      async verifyIdToken() { return token }, async createSessionCookie() { return 'synthetic.session.signature' },
      async verifySessionCookie() { return token },
    }, service, () => now)
    const httpRequest = (method: string, originalUrl: string, cookie = '') => {
      const headers = { origin: 'https://example.test', 'content-type': 'application/json', authorization: 'Bearer synthetic.id.signature', cookie }
      return Object.assign(new EventEmitter(), { method, originalUrl, body: ref, rawBody: Buffer.from(JSON.stringify(ref)),
        headers, rawHeaders: Object.entries(headers).flat(), aborted: false }) as unknown as Request
    }
    const httpResponse = () => {
      const values: Record<string, unknown> = {}
      const result = Object.assign(new EventEmitter(), { values, payload: { authorizationUrl: '' }, writableEnded: false,
        set(h: Record<string, unknown>) { Object.assign(values, h); return this },
        setHeader(k: string, v: unknown) { values[k] = v; return this }, status() { return this },
        json(v: { authorizationUrl: string }) { this.payload = v; this.writableEnded = true; return this },
        end() { this.writableEnded = true; return this },
      })
      return { result, res: result as unknown as Response }
    }
    const started = httpResponse(); await handlers.begin(httpRequest('POST', '/begin'), started.res)
    const state = new URL(started.result.payload.authorizationUrl).searchParams.get('state')!
    const browserCookie = String(started.result.values['Set-Cookie']).split(';')[0]
    const query = `/callback?state=${state}&code=synthetic-code`
    const wrongCookie = browserCookie.replace(/~[A-Za-z0-9_-]+$/, `~${'x'.repeat(43)}`)
    const wrong = httpResponse(); await handlers.callback(httpRequest('GET', query, wrongCookie), wrong.res)
    expect(wrong.result.values.Location).toBe('https://example.test/banks?bankConnection=failed')
    expect(exchanges).toBe(0); expect((await credential().get()).exists).toBe(false)
    const done = httpResponse(); await handlers.callback(httpRequest('GET', query, browserCookie), done.res)
    expect(done.result.values.Location).toBe('https://example.test/banks?bankConnection=connected')
    expect(exchanges).toBe(1); expect((await connection().get()).data()?.status).toBe('active')
    expect(JSON.stringify((await credential().get()).data())).not.toContain(value().access_token)
    const replay = httpResponse(); await handlers.callback(httpRequest('GET', query, browserCookie), replay.res)
    expect(replay.result.values.Location).toBe('https://example.test/banks?bankConnection=failed'); expect(exchanges).toBe(1)
  })
})
