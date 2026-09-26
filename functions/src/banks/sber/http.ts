import { createHash, randomBytes } from 'node:crypto'
import type { Auth, DecodedIdToken } from 'firebase-admin/auth'
import type { CallableRequest, Request } from 'firebase-functions/v2/https'
import type { Response } from 'express'
import { z } from 'zod'
import { FirestoreDocumentIdSchema } from '../../schemas/invitation'
import { BankError } from '../errors'
import { AUTHORIZE, ConfigSchema, type SberConfig } from './protocol'
import type { SberConnections } from './service'

const COOKIE = '__Host-finapp-sber'
const TTL = 600_000
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const BeginSchema = z.object({ companyId: FirestoreDocumentIdSchema, connectionId: FirestoreDocumentIdSchema }).strict()
const CallbackSchema = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(4096) }).strict()
type SessionAuth = Pick<Auth, 'verifyIdToken' | 'createSessionCookie' | 'verifySessionCookie'>
type Service = Pick<SberConnections, 'begin' | 'callback'>
type Handler = (request: Request, response: Response) => Promise<void>
const deny = (): never => { throw new BankError('bank_access_denied') }
const binding = (value: string) => createHash('sha256').update(value).digest('base64url')
const cookie = (value: string, age: number) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`

function headers(response: Response) {
  response.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff' })
}
function header(request: Request, name: string): string {
  // Reject duplicates even where Node combines them or keeps the first value.
  let count = 0
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) count++
  const value = request.headers[name]
  if (count > 1 || Array.isArray(value)) return deny()
  return value ?? ''
}
function verified(token: DecodedIdToken, now: number, recent: boolean) {
  if (!FirestoreDocumentIdSchema.safeParse(token.uid).success || token.email_verified !== true
    || !Number.isFinite(token.auth_time) || token.auth_time * 1000 > now
    || !Number.isFinite(token.exp) || token.exp * 1000 <= now
    || (recent && now - token.auth_time * 1000 > 300_000)) deny()
}
function callable(rawRequest: Request, token: DecodedIdToken, data: unknown): CallableRequest<unknown> {
  // Auth comes ONLY from Admin SDK verification, never request.auth/body/query.
  // These domain methods do not use rawToken; do not propagate the credential.
  return { rawRequest, data, auth: { uid: token.uid, token, rawToken: '' }, acceptsStreaming: false }
}

/** Private factories, NOT exported Cloud Functions. Mount only after bank/runtime gates.
 * Requires a same-origin HTTPS reverse proxy that preserves this host-only cookie.
 */
export function createSberHttpHandlers(configInput: SberConfig, urls: { beginUrl: string; returnUrl: string },
  auth: SessionAuth, service: Service, clock: () => number = Date.now): { begin: Handler; callback: Handler } {
  const config = ConfigSchema.parse(configInput)
  const callbackUrl = new URL(config.redirectUri)
  const beginUrl = new URL(urls.beginUrl), returnUrl = new URL(urls.returnUrl)
  for (const url of [beginUrl, returnUrl]) {
    if (url.origin !== callbackUrl.origin || url.username || url.password || url.search || url.hash) deny()
  }
  if (new Set([beginUrl.pathname, callbackUrl.pathname, returnUrl.pathname]).size !== 3) deny()
  const destination = (success: boolean) => {
    const url = new URL(returnUrl); url.searchParams.set('bankConnection', success ? 'connected' : 'failed'); return url.toString()
  }
  return {
    async begin(request, response) {
      headers(response)
      try {
        // No ambient-cookie authentication or CORS. JSON + exact Origin + bearer
        // stops browser CSRF, including attacks from a sibling subdomain.
        if (request.method !== 'POST' || request.originalUrl !== beginUrl.pathname || request.aborted
          || header(request, 'origin') !== beginUrl.origin
          || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(request, 'content-type'))
          || (header(request, 'sec-fetch-site') && header(request, 'sec-fetch-site') !== 'same-origin')
          || request.rawBody.length > 2048) deny()
        const data = BeginSchema.parse(request.body)
        const authorization = header(request, 'authorization')
        if (!authorization.startsWith('Bearer ') || authorization.length > 16000) deny()
        const idToken = authorization.slice(7)
        if (!JWT.test(idToken)) deny()
        const token = await auth.verifyIdToken(idToken, true)
        verified(token, clock(), true)
        const session = await auth.createSessionCookie(idToken, { expiresIn: TTL })
        if (!JWT.test(session) || session.length > 3500) deny()
        const value = `${session}~${randomBytes(32).toString('base64url')}`
        if (request.aborted || response.destroyed) deny()
        const result = await service.begin(callable(request, token, data), binding(value))
        const target = new URL(result.authorizationUrl)
        if (`${target.origin}${target.pathname}` !== AUTHORIZE || target.username || target.password || target.hash
          || target.searchParams.get('redirect_uri') !== config.redirectUri
          || target.searchParams.get('client_id') !== config.clientId) deny()
        response.setHeader('Set-Cookie', cookie(value, TTL / 1000))
        response.status(200).json({ authorizationUrl: result.authorizationUrl })
      } catch {
        // Do not echo SDK/bank errors or overwrite a previous pending cookie.
        response.status(403).json({ error: 'bank_connection_failed' })
      }
    },
    async callback(request, response) {
      headers(response)
      const controller = new AbortController()
      const abort = () => { controller.abort() }
      const closed = () => { if (!response.writableEnded) abort() }
      request.once('aborted', abort); response.once('close', closed)
      const timer = setTimeout(abort, 30_000)
      let success = false
      try {
        if (request.method !== 'GET' || request.aborted || response.destroyed
          || request.originalUrl.length > 8192 || !request.originalUrl.startsWith(`${callbackUrl.pathname}?`)) deny()
        const url = new URL(request.originalUrl, callbackUrl.origin)
        if (url.origin !== callbackUrl.origin || url.pathname !== callbackUrl.pathname || url.hash) deny()
        // URLSearchParams retains duplicates; Express query parsing may not.
        const params = [...url.searchParams]
        if (params.length !== 2 || new Set(params.map(([key]) => key)).size !== 2) deny()
        const data = CallbackSchema.parse(Object.fromEntries(params))
        const raw = header(request, 'cookie')
        if (raw.length > 16000) deny()
        const matches = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`))
        if (matches.length !== 1) deny()
        const value = matches[0].slice(COOKIE.length + 1), parts = value.split('~')
        if (parts.length !== 2 || !JWT.test(parts[0]) || parts[0].length > 3500 || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) deny()
        const token = await auth.verifySessionCookie(parts[0], true)
        verified(token, clock(), false)
        if (controller.signal.aborted) deny()
        await service.callback(callable(request, token, data), binding(value), controller.signal)
        success = true
      } catch {
        // Bank denial/malformed callback has the same fixed failure destination.
      } finally {
        clearTimeout(timer); request.off('aborted', abort); response.off('close', closed)
      }
      response.setHeader('Set-Cookie', cookie('', 0))
      // No code/state/identity in redirect or response body. UI must re-read status.
      response.status(303).setHeader('Location', destination(success))
      response.end()
    },
  }
}
