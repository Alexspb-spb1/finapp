import type { ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BankError } from '../errors'
import { BankReadFailure } from '../storage/worker'
import { API_ORIGINS, STATEMENT_PATH, type SberConfig } from './protocol'
import type { SberRateGate } from './rateGate'

export type Resource = 'token' | 'profile' | 'statement'
export interface WireRequest { resource: Resource; token?: string; form?: URLSearchParams; query?: URLSearchParams }
export interface WireResponse { status: number; body: string; retryAfter?: string }
export interface SberTransport { send(input: WireRequest, signal: AbortSignal): Promise<WireResponse> }
export interface TlsSecrets { pfx: Buffer; passphrase: string; ca: string[] }
const paths: Record<Resource, string> = { token: '/ic/sso/api/v2/oauth/token', profile: '/ic/sso/api/v2/oauth/user-info', statement: STATEMENT_PATH }
/** Fixed hosts/resources, verified mTLS, no redirects, bounded response and total timeout. */
export class MtlsTransport implements SberTransport {
  constructor(private readonly environment: SberConfig['environment'], private readonly secrets: () => Promise<TlsSecrets>,
    private readonly gate: SberRateGate) {}
  async send(input: WireRequest, signal: AbortSignal): Promise<WireResponse> {
    const origin = API_ORIGINS[this.environment]
    if (!origin || !Object.hasOwn(paths, input.resource)) throw new BankError('bank_access_denied')
    let tls: TlsSecrets
    try { tls = await this.secrets() } catch { throw new BankError('bank_access_denied') }
    if (!tls.pfx.length || !tls.ca.length || signal.aborted) throw new BankError('bank_access_denied')
    const url = new URL(paths[input.resource], origin)
    url.search = input.query?.toString() ?? ''
    const body = input.form?.toString()
    return this.gate.run(leaseUntil => new Promise((resolve, reject) => {
      if (signal.aborted || Date.now() + 20_000 >= leaseUntil) { reject(new BankReadFailure('transient')); return }
      const fail = () => reject(new BankReadFailure('transient'))
      let req: ClientRequest
      try { req = httpsRequest(url, { method: input.resource === 'token' ? 'POST' : 'GET',
        pfx: tls.pfx, passphrase: tls.passphrase, ca: tls.ca, rejectUnauthorized: true,
        minVersion: 'TLSv1.2', agent: false, signal,
        headers: { Accept: input.resource === 'profile' ? 'application/jwt' : 'application/json',
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}) },
      }, res => {
        const chunks: Buffer[] = []; let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 2 * 1024 * 1024) { req.destroy(); fail(); return }
          chunks.push(chunk)
        })
        res.on('error', fail)
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
          ...(res.headers['retry-after'] ? { retryAfter: res.headers['retry-after'] } : {}) }))
      })
      } catch { fail(); return }
      const timer = setTimeout(() => { req.destroy(); fail() }, 20_000)
      req.once('close', () => clearTimeout(timer))
      req.on('error', fail)
      if (body) req.write(body)
      req.end()
    }), signal)
  }
}
export function requireSuccess(response: WireResponse, now = Date.now()): string {
  if (response.status === 200) return response.body
  if (response.status === 401) throw new BankReadFailure('reauth')
  if (response.status === 403) throw new BankReadFailure('consent_revoked')
  if (response.status === 429) {
    const raw = response.retryAfter ?? ''
    const delay = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now
    throw new BankReadFailure('rate_limited', Number.isFinite(delay) ? Math.min(86_400_000, Math.max(0, Math.ceil(delay))) : 1000)
  }
  if (response.status === 202 || response.status >= 500) throw new BankReadFailure('transient')
  throw new BankReadFailure('permanent')
}
