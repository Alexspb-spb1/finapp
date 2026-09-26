import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ request: mock.request }))
import { MtlsTransport, requireSuccess } from '../../../src/banks/sber/transport'

const tls = { pfx: Buffer.from('synthetic-pfx'), passphrase: 'synthetic-password', ca: ['synthetic-ca'] }
let req: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }
let response: EventEmitter & { statusCode: number; headers: Record<string, string> }
let receive: (value: typeof response) => void
beforeEach(() => {
  mock.request.mockReset()
  req = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn(() => req.emit('close')) })
  response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} })
  mock.request.mockImplementation((_url: URL, _options: unknown, cb: typeof receive) => { receive = cb; return req })
})
const finish = (body: string) => { receive(response); response.emit('data', Buffer.from(body)); response.emit('end'); req.emit('close') }

describe('Sber mTLS transport security', () => {
  it('pins bank resource/host, validates TLS and sends client certificate', async () => {
    const transport = new MtlsTransport('sandbox', async () => tls)
    const result = transport.send({ resource: 'profile', token: 'synthetic-access' }, new AbortController().signal)
    await Promise.resolve()
    const [url, options] = mock.request.mock.calls[0]
    expect(url.toString()).toBe('https://fintech-test.sberbank.ru:9443/ic/sso/api/v2/oauth/user-info')
    expect(options).toMatchObject({ method: 'GET', rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false,
      pfx: tls.pfx, ca: tls.ca, headers: { Accept: 'application/jwt', Authorization: 'Bearer synthetic-access' } })
    finish('synthetic-jwt'); expect((await result).body).toBe('synthetic-jwt')
  })
  it('does not follow redirects', async () => {
    const result = new MtlsTransport('sandbox', async () => tls).send({ resource: 'profile' }, new AbortController().signal)
    await Promise.resolve(); response.statusCode = 302; response.headers.location = 'https://evil.test'; finish('')
    expect(() => requireSuccess({ ...response, status: 302, body: '' })).toThrow()
    expect((await result).status).toBe(302); expect(mock.request).toHaveBeenCalledTimes(1)
  })
  it('bounds response memory and sanitizes network failures', async () => {
    const result = new MtlsTransport('sandbox', async () => tls).send({ resource: 'statement' }, new AbortController().signal)
    const rejected = expect(result).rejects.toMatchObject({ category: 'transient', message: 'bank_read_failed' })
    await Promise.resolve(); receive(response); response.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1)); await rejected
    expect(req.destroy).toHaveBeenCalled()
  })
  it('sanitizes synchronous TLS errors', async () => {
    mock.request.mockImplementation(() => { throw new Error('synthetic-secret-canary') })
    await expect(new MtlsTransport('sandbox', async () => tls).send({ resource: 'token' }, new AbortController().signal))
      .rejects.toMatchObject({ category: 'transient', message: 'bank_read_failed' })
  })
  it('does not make a request without TLS material or after abort', async () => {
    const c = new AbortController(); c.abort()
    await expect(new MtlsTransport('sandbox', async () => tls).send({ resource: 'profile' }, c.signal)).rejects.toThrow()
    await expect(new MtlsTransport('sandbox', async () => ({ ...tls, ca: [] })).send({ resource: 'profile' }, new AbortController().signal)).rejects.toThrow()
    expect(mock.request).not.toHaveBeenCalled()
  })
  it('enforces total timeout even without response data', async () => {
    vi.useFakeTimers()
    try {
      const result = new MtlsTransport('sandbox', async () => tls).send({ resource: 'statement' }, new AbortController().signal)
      const assertion = expect(result).rejects.toMatchObject({ category: 'transient' })
      await Promise.resolve(); await vi.advanceTimersByTimeAsync(20000); await assertion
      expect(req.destroy).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
