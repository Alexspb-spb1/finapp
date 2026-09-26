import { EventEmitter } from 'node:events'
import type { DecodedIdToken } from 'firebase-admin/auth'
import type { Request } from 'firebase-functions/v2/https'
import type { Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSberHttpHandlers } from '../../../src/banks/sber/http'
import { authorizationUrl } from '../../../src/banks/sber/protocol'

const now = 1_800_000_000_000
const config = { environment: 'sandbox', clientId: 'synthetic', issuer: 'synthetic', redirectUri: 'https://app.test/api/sber/callback' } as const
const urls = { beginUrl: 'https://app.test/api/sber/begin', returnUrl: 'https://app.test/banks' }
const state = 's'.repeat(43), code = 'synthetic-code-canary', session = 'synthetic.session.signature'
const body = { companyId: 'company-a', connectionId: 'connection-a' }
const claims = () => ({ uid: 'verified-admin', sub: 'verified-admin', email_verified: true, auth_time: now / 1000 - 60, exp: now / 1000 + 600 }) as DecodedIdToken
const auth = { verifyIdToken: vi.fn(), createSessionCookie: vi.fn(), verifySessionCookie: vi.fn() }
const service = { begin: vi.fn(), callback: vi.fn() }
const factory = () => createSberHttpHandlers(config, urls, auth, service, () => now)
function request(method = 'POST', url = '/api/sber/begin', fields: Record<string, string> = {}) {
  const headers = { origin: 'https://app.test', 'content-type': 'application/json', authorization: 'Bearer synthetic.id.signature', ...fields }
  return Object.assign(new EventEmitter(), { method, originalUrl: url, body, rawBody: Buffer.from(JSON.stringify(body)),
    headers, rawHeaders: Object.entries(headers).flat(), aborted: false,
    auth: { uid: 'forged-client-user', token: { email_verified: true } } }) as unknown as Request
}
function response() {
  const values: Record<string, unknown> = {}
  const result = Object.assign(new EventEmitter(), { values, statusCode: 0, payload: undefined as unknown,
    writableEnded: false, destroyed: false,
    set(fields: Record<string, unknown>) { Object.assign(values, fields); return this },
    setHeader(key: string, value: unknown) { values[key] = value; return this },
    status(code: number) { this.statusCode = code; return this },
    json(value: unknown) { this.payload = value; this.writableEnded = true; return this },
    end() { this.writableEnded = true; return this },
  })
  return { result, res: result as unknown as Response }
}
const callback = (cookie = `__Host-finapp-sber=${session}~${'n'.repeat(43)}`, query = `state=${state}&code=${code}`) =>
  request('GET', `/api/sber/callback?${query}`, { cookie })
beforeEach(() => {
  vi.resetAllMocks()
  auth.verifyIdToken.mockResolvedValue(claims()); auth.verifySessionCookie.mockResolvedValue(claims())
  auth.createSessionCookie.mockResolvedValue(session)
  service.begin.mockResolvedValue({ authorizationUrl: authorizationUrl(config, state, 'nonce') })
  service.callback.mockResolvedValue(body)
})

describe('BANK-003 private HTTP boundary', () => {
  it('verifies bearer/revocation and binds a fresh secure session without trusting client auth', async () => {
    const h = factory(), r = response()
    await h.begin(request(), r.res)
    expect(auth.verifyIdToken).toHaveBeenCalledWith('synthetic.id.signature', true)
    expect(auth.createSessionCookie).toHaveBeenCalledWith('synthetic.id.signature', { expiresIn: 600000 })
    expect(service.begin.mock.calls[0][0].auth.uid).toBe('verified-admin')
    expect(service.begin.mock.calls[0][0].data).toEqual(body)
    expect(r.result.statusCode).toBe(200)
    const cookie = String(r.result.values['Set-Cookie'])
    expect(cookie).toMatch(/^__Host-finapp-sber=synthetic.session.signature~[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/)
    const done = response()
    await h.callback(callback(cookie.split(';')[0]), done.res)
    expect(auth.verifySessionCookie).toHaveBeenCalledWith(session, true)
    expect(service.callback.mock.calls[0][1]).toBe(service.begin.mock.calls[0][1])
    expect(service.callback.mock.calls[0][0].auth.uid).toBe('verified-admin')
    expect(done.result.statusCode).toBe(303)
    expect(done.result.values.Location).toBe('https://app.test/banks?bankConnection=connected')
    expect(done.result.values['Set-Cookie']).toContain('Max-Age=0')
    expect(done.result.values['Referrer-Policy']).toBe('no-referrer')
    expect(done.result.values['Cache-Control']).toBe('no-store')
    expect(JSON.stringify(done.result.values)).not.toContain(code)
  })
  it.each(['https://evil.test', 'https://sub.app.test', 'null', ''])('blocks begin Origin %s before auth or bank service', async origin => {
    const r = response(); await factory().begin(request('POST', '/api/sber/begin', { origin }), r.res)
    expect(r.result.statusCode).toBe(403); expect(auth.verifyIdToken).not.toHaveBeenCalled(); expect(service.begin).not.toHaveBeenCalled()
  })
  it.each(['GET', 'OPTIONS', 'PUT'])('blocks %s begin', async method => {
    const r = response(); await factory().begin(request(method), r.res)
    expect(r.result.statusCode).toBe(403); expect(service.begin).not.toHaveBeenCalled()
  })
  it.each(['text/plain', 'application/x-www-form-urlencoded'])('blocks CSRF content type %s', async contentType => {
    const r = response(); await factory().begin(request('POST', '/api/sber/begin', { 'content-type': contentType }), r.res)
    expect(r.result.statusCode).toBe(403); expect(auth.verifyIdToken).not.toHaveBeenCalled()
  })
  it('rejects duplicate security headers, oversized body, unknown identity fields and query URLs', async () => {
    const duplicate = request(); duplicate.rawHeaders.push('Origin', 'https://evil.test')
    const huge = request(); huge.rawBody = Buffer.alloc(2049)
    const forged = request(); forged.body = { ...body, uid: 'someone-else' }
    for (const req of [duplicate, huge, forged, request('POST', '/api/sber/begin?next=https://evil.test'), request('POST', '/api/sber/begin', { 'sec-fetch-site': 'cross-site' })]) {
      const r = response(); await factory().begin(req, r.res); expect(r.result.statusCode).toBe(403)
    }
    expect(auth.verifyIdToken).not.toHaveBeenCalled()
  })
  it.each(['unverified', 'old-login', 'future-login', 'expired', 'revoked'])('denies %s identity before session creation', async condition => {
    const token = claims()
    if (condition === 'unverified') token.email_verified = false
    if (condition === 'old-login') token.auth_time = now / 1000 - 301
    if (condition === 'future-login') token.auth_time = now / 1000 + 1
    if (condition === 'expired') token.exp = now / 1000
    auth.verifyIdToken.mockResolvedValue(token)
    if (condition === 'revoked') auth.verifyIdToken.mockRejectedValue(new Error('synthetic-secret-canary'))
    const r = response(); await factory().begin(request(), r.res)
    expect(r.result.statusCode).toBe(403); expect(auth.createSessionCookie).not.toHaveBeenCalled()
    expect(r.result.payload).toEqual({ error: 'bank_connection_failed' })
  })
  it('does not set a cookie or leak SDK errors when session creation fails', async () => {
    auth.createSessionCookie.mockRejectedValue(new Error('synthetic-secret-canary'))
    const r = response(); await factory().begin(request(), r.res)
    expect(service.begin).not.toHaveBeenCalled(); expect(r.result.values['Set-Cookie']).toBeUndefined()
    expect(r.result.payload).toEqual({ error: 'bank_connection_failed' })
  })
  it('generates different session bindings for two attempts even for identical Firebase cookies', async () => {
    await factory().begin(request(), response().res); await factory().begin(request(), response().res)
    expect(service.begin.mock.calls[0][1]).not.toBe(service.begin.mock.calls[1][1])
  })
  it.each(['', 'other=value', `__Host-finapp-sber=not-jwt~${'n'.repeat(43)}`,
    `__Host-finapp-sber=${session}~${'n'.repeat(43)}; __Host-finapp-sber=${session}~${'n'.repeat(43)}`])('denies absent/malformed/duplicate cookie (%s)', async cookie => {
    const r = response(); await factory().callback(callback(cookie), r.res)
    expect(auth.verifySessionCookie).not.toHaveBeenCalled(); expect(service.callback).not.toHaveBeenCalled()
    expect(r.result.values.Location).toBe('https://app.test/banks?bankConnection=failed')
  })
  it.each([`state=${state}&state=${state}&code=${code}`, `state=${state}&error=access_denied`,
    `state=${state}&code=${code}&next=https://evil.test`, 'state=bad&code=x', `state=${state}&code=`])('rejects malformed/denied callback without echoing query', async query => {
    const r = response(); await factory().callback(callback(undefined, query), r.res)
    expect(service.callback).not.toHaveBeenCalled(); expect(auth.verifySessionCookie).not.toHaveBeenCalled()
    expect(r.result.values.Location).toBe('https://app.test/banks?bankConnection=failed')
  })
  it('blocks revoked callback sessions and sanitizes service failure', async () => {
    auth.verifySessionCookie.mockRejectedValue(new Error('synthetic-secret-canary'))
    const r = response(); await factory().callback(callback(), r.res)
    expect(service.callback).not.toHaveBeenCalled()
    auth.verifySessionCookie.mockResolvedValue(claims()); service.callback.mockRejectedValue(new Error(code))
    const r2 = response(); await factory().callback(callback(), r2.res)
    expect(r2.result.values.Location).toBe('https://app.test/banks?bankConnection=failed')
    expect(JSON.stringify(r2.result.values)).not.toContain(code)
  })
  it('passes abort on disconnect and removes listeners', async () => {
    const req = callback(), r = response()
    service.callback.mockImplementation(async (_req, _session, signal: AbortSignal) => {
      r.result.emit('close'); expect(signal.aborted).toBe(true); throw new Error()
    })
    await factory().callback(req, r.res)
    expect(req.listenerCount('aborted')).toBe(0); expect(r.result.listenerCount('close')).toBe(0)
    expect(r.result.values.Location).toContain('failed')
  })
  it('aborts the bank operation after the total callback deadline', async () => {
    vi.useFakeTimers()
    try {
      service.callback.mockImplementation(async (_req, _session, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error()), { once: true })
      }))
      const r = response(), done = factory().callback(callback(), r.res)
      await vi.advanceTimersByTimeAsync(30000); await done
      expect(r.result.values.Location).toContain('failed'); expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('rejects unsafe deployment URLs and a substituted bank authorization URL', async () => {
    for (const bad of ['https://evil.test/banks', 'https://app.test/banks?next=x', config.redirectUri]) {
      expect(() => createSberHttpHandlers(config, { ...urls, returnUrl: bad }, auth, service)).toThrow()
    }
    service.begin.mockResolvedValue({ authorizationUrl: 'https://evil.test/' })
    const r = response(); await factory().begin(request(), r.res)
    expect(r.result.statusCode).toBe(403); expect(r.result.values['Set-Cookie']).toBeUndefined()
  })
})
