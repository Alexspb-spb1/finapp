import { createHash } from 'node:crypto'
import { PROJECT } from './liveAcceptanceCore.mjs'

const blocked = () => { throw new Error('live_token_lifecycle_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const sha256 = value => createHash('sha256').update(value).digest('hex')
const jsonHash = value => sha256(JSON.stringify(value))
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const safeUid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const safeEmail = value => typeof value === 'string' && value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value === value.trim().toLowerCase()
const safeRefreshToken = value => typeof value === 'string' && value.length >= 20 && value.length <= 4096 &&
  /^[A-Za-z0-9._~-]+$/.test(value)
const safeLifetime = value => typeof value === 'string' && /^\d{1,6}$/.test(value) &&
  Number(value) > 0 && Number(value) <= 86_400
const clone = value => structuredClone(value)
const frozen = value => Object.freeze(clone(value))

function decodePayload(token) {
  if (typeof token !== 'string' || token.length > 16_384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) blocked()
  let payload
  try { payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) } catch { blocked() }
  if (!record(payload)) blocked()
  return payload
}

function validateIdToken(token, { uid, email, emailVerified }) {
  const payload = decodePayload(token)
  if (payload.sub !== uid || payload.user_id !== uid || payload.aud !== PROJECT ||
      payload.email !== email || payload.email_verified !== emailVerified) blocked()
  return token
}

async function readSuccessJson(response) {
  const status = typeof response?.status === 'function' ? response.status() : response?.status
  if (status !== 200 || typeof response?.json !== 'function') blocked()
  let value
  try { value = await response.json() } catch { blocked() }
  if (!record(value)) blocked()
  return value
}

function validateAccount(value, identity) {
  if (!exactKeys(value, ['uid', 'email', 'password']) || !safeUid(value.uid) || !safeEmail(value.email) ||
      !value.email.endsWith('@example.invalid') || typeof value.password !== 'string' ||
      value.password.length < 16 || value.password.length > 128 || value.uid !== value.uid.trim()) blocked()
  return { identity, ...clone(value) }
}

function validateCamelSession(value, expected, emailVerified) {
  if (value.localId !== expected.uid || value.email !== expected.email ||
      !safeRefreshToken(value.refreshToken) || !safeLifetime(value.expiresIn)) blocked()
  validateIdToken(value.idToken, { uid: expected.uid, email: expected.email, emailVerified })
  return { uid: expected.uid, email: expected.email, idToken: value.idToken, refreshToken: value.refreshToken }
}

/**
 * Own the three live identities' credentials and tokens for one Stage 8 run.
 * Secret values never leave this closure except for the exact Authorization
 * header produced later by createCallableDispatchPrimitive.
 */
export function createFixedIdentityTokenLifecycle({ transport, apiKey, accounts, mailbox }) {
  if (!transport || typeof transport.authorizeRequest !== 'function' || typeof transport.fetch !== 'function' ||
      typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{10,100}$/.test(apiKey) ||
      !exactKeys(accounts, ['ownerA', 'ownerB']) || !safeEmail(mailbox)) blocked()
  const privateAccounts = {
    ownerA: validateAccount(accounts.ownerA, 'ownerA'),
    ownerB: validateAccount(accounts.ownerB, 'ownerB'),
  }
  if (privateAccounts.ownerA.uid === privateAccounts.ownerB.uid ||
      privateAccounts.ownerA.email === privateAccounts.ownerB.email ||
      privateAccounts.ownerA.password === privateAccounts.ownerB.password ||
      mailbox === privateAccounts.ownerA.email || mailbox === privateAccounts.ownerB.email) blocked()

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`
  const sessions = new Map()
  const inFlight = new Map()
  let mailboxSession = null
  let mailboxRegistered = false
  let mailboxRefreshed = false

  const signIn = identity => {
    if (sessions.has(identity)) return Promise.resolve(sessions.get(identity).idToken)
    if (inFlight.has(identity)) return inFlight.get(identity)
    const account = privateAccounts[identity]
    if (!account) blocked()
    const pending = (async () => {
      const body = JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true })
      transport.authorizeRequest({ method: 'POST', url, bodySha256: sha256(body) })
      const value = await readSuccessJson(await transport.fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      }))
      if (value.registered !== true) blocked()
      const session = validateCamelSession(value, account, true)
      sessions.set(identity, session)
      return session.idToken
    })()
    inFlight.set(identity, pending)
    return pending.finally(() => inFlight.delete(identity))
  }

  return Object.freeze({
    async getIdToken(identity) {
      if (identity === 'ownerA' || identity === 'ownerB') return signIn(identity)
      if (identity !== 'ownerMailbox' || !mailboxSession) blocked()
      return mailboxSession.idToken
    },
    async captureOwnerMailboxRegistration(response, meta) {
      if (mailboxRegistered || mailboxSession || !exactKeys(meta, ['requestSha256']) || !hex64(meta.requestSha256)) blocked()
      const value = await readSuccessJson(response)
      const expected = { uid: value.localId, email: mailbox }
      if (!safeUid(expected.uid)) blocked()
      mailboxSession = validateCamelSession(value, expected, false)
      mailboxRegistered = true
      const produced = { ownerMailboxUid: expected.uid }
      return frozen({
        requestSha256: meta.requestSha256,
        outcomeSha256: jsonHash({ uidSha256: sha256(expected.uid), emailVerified: false }),
        producedSha256: jsonHash(produced),
      })
    },
    async captureOwnerMailboxForcedRefresh(response) {
      if (!mailboxRegistered || !mailboxSession || mailboxRefreshed) blocked()
      const value = await readSuccessJson(response)
      if (value.user_id !== mailboxSession.uid || value.token_type !== 'Bearer' ||
          !safeRefreshToken(value.refresh_token) || !safeLifetime(value.expires_in)) blocked()
      validateIdToken(value.id_token, { uid: mailboxSession.uid, email: mailbox, emailVerified: true })
      if (value.id_token === mailboxSession.idToken) blocked()
      mailboxSession = { uid: mailboxSession.uid, email: mailbox, idToken: value.id_token, refreshToken: value.refresh_token }
      mailboxRefreshed = true
      return frozen({ captured: true })
    },
    ownerMailboxUid() {
      if (!mailboxSession) blocked()
      return mailboxSession.uid
    },
  })
}
