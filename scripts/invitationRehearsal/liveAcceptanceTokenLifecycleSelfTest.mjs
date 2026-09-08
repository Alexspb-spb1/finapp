import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { PROJECT, liveAcceptanceTransport } from './liveAcceptanceCore.mjs'
import { createFixedIdentityTokenLifecycle } from './liveAcceptanceTokenLifecycle.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const jwt = ({ uid, email, verified, marker }) => [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: uid, user_id: uid, aud: PROJECT, email, email_verified: verified, marker })).toString('base64url'),
  Buffer.from(`signature-${marker}`).toString('base64url'),
].join('.')

const values = Object.freeze({
  apiKey: 'private_api_key_1234567890',
  mailbox: 'mailbox@example.invalid',
  ownerA: Object.freeze({ uid: 'run-ownerA', email: 'owner-a@example.invalid', password: 'private-owner-a-password' }),
  ownerB: Object.freeze({ uid: 'run-ownerB', email: 'owner-b@example.invalid', password: 'private-owner-b-password' }),
})

function response(value, browser = false) {
  return browser ? { status: () => 200, async json() { return structuredClone(value) } }
    : { status: 200, async json() { return structuredClone(value) } }
}

test('fixed owner sign-ins use exact guarded Identity Toolkit requests once and retain sessions', async () => {
  const calls = [], permits = []
  const tokens = {
    ownerA: jwt({ uid: values.ownerA.uid, email: values.ownerA.email, verified: true, marker: 'owner-a' }),
    ownerB: jwt({ uid: values.ownerB.uid, email: values.ownerB.email, verified: true, marker: 'owner-b' }),
  }
  const guarded = liveAcceptanceTransport(async (_url, options) => {
      const body = JSON.parse(options.body)
      const identity = body.email === values.ownerA.email ? 'ownerA' : 'ownerB'
      const account = values[identity]
      assert.deepEqual(body, { email: account.email, password: account.password, returnSecureToken: true })
      return response({ localId: account.uid, email: account.email, idToken: tokens[identity],
        refreshToken: `private-refresh-${identity}-1234567890`, expiresIn: '3600', registered: true })
  })
  const transport = {
    authorizeRequest(spec) { permits.push(spec); guarded.authorizeRequest(spec) },
    async fetch(url, options) { calls.push({ url, options }); return guarded.fetch(url, options) },
  }
  const lifecycle = createFixedIdentityTokenLifecycle({ transport, apiKey: values.apiKey,
    accounts: { ownerA: values.ownerA, ownerB: values.ownerB }, mailbox: values.mailbox })
  assert.equal(await lifecycle.getIdToken('ownerA'), tokens.ownerA)
  assert.equal(await lifecycle.getIdToken('ownerA'), tokens.ownerA)
  assert.equal(await lifecycle.getIdToken('ownerB'), tokens.ownerB)
  assert.equal(calls.length, 2); assert.equal(permits.length, 2)
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index], permit = permits[index]
    assert.equal(call.url, `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${values.apiKey}`)
    assert.deepEqual(Object.keys(call.options).sort(), ['body', 'headers', 'method', 'redirect', 'signal'].sort())
    assert.equal(call.options.method, 'POST'); assert.equal(call.options.redirect, 'error')
    assert.deepEqual(call.options.headers, { 'content-type': 'application/json' })
    assert.deepEqual(permit, { method: 'POST', url: call.url, bodySha256: h(call.options.body) })
  }
  const serialized = JSON.stringify(lifecycle)
  for (const secret of [values.apiKey, values.ownerA.password, values.ownerB.password, ...Object.values(tokens)]) {
    assert.equal(serialized.includes(secret), false)
  }
})

test('mailbox signup and verified forced-refresh tokens rotate inside one closure', async () => {
  const transport = { authorizeRequest() { assert.fail('owner mailbox must use browser flow') }, async fetch() { assert.fail('network forbidden') } }
  const lifecycle = createFixedIdentityTokenLifecycle({ transport, apiKey: values.apiKey,
    accounts: { ownerA: values.ownerA, ownerB: values.ownerB }, mailbox: values.mailbox })
  await assert.rejects(() => lifecycle.getIdToken('ownerMailbox'))
  assert.throws(() => lifecycle.ownerMailboxUid())

  const uid = 'mailbox-owner-uid'
  const signupToken = jwt({ uid, email: values.mailbox, verified: false, marker: 'signup' })
  const refreshedToken = jwt({ uid, email: values.mailbox, verified: true, marker: 'refreshed' })
  const registration = await lifecycle.captureOwnerMailboxRegistration(response({
    localId: uid, email: values.mailbox, idToken: signupToken,
    refreshToken: 'private-mailbox-refresh-signup-12345', expiresIn: '3600',
  }, true), { requestSha256: h('signup-request') })
  assert.deepEqual(Object.keys(registration).sort(), ['outcomeSha256', 'producedSha256', 'requestSha256'].sort())
  assert.equal(registration.requestSha256, h('signup-request'))
  assert.equal(lifecycle.ownerMailboxUid(), uid)
  assert.equal(await lifecycle.getIdToken('ownerMailbox'), signupToken)
  for (const secret of [values.mailbox, signupToken, 'private-mailbox-refresh-signup-12345']) {
    assert.equal(JSON.stringify(registration).includes(secret), false)
  }

  const captured = await lifecycle.captureOwnerMailboxForcedRefresh(response({
    user_id: uid, id_token: refreshedToken, refresh_token: 'private-mailbox-refresh-verified-12345',
    expires_in: '3600', token_type: 'Bearer', project_id: PROJECT,
  }, true))
  assert.deepEqual(captured, { captured: true })
  assert.equal(await lifecycle.getIdToken('ownerMailbox'), refreshedToken)
  await assert.rejects(() => lifecycle.captureOwnerMailboxForcedRefresh(response({}, true)))
  await assert.rejects(() => lifecycle.captureOwnerMailboxRegistration(response({}, true), { requestSha256: h('again') }))
})

test('token lifecycle rejects unverified synthetic owners and mismatched mailbox refreshes', async () => {
  const wrongOwnerToken = jwt({ uid: values.ownerA.uid, email: values.ownerA.email, verified: false, marker: 'wrong-owner' })
  const ownerTransport = {
    authorizeRequest() {}, async fetch() { return response({ localId: values.ownerA.uid, email: values.ownerA.email,
      idToken: wrongOwnerToken, refreshToken: 'private-owner-refresh-123456789', expiresIn: '3600', registered: true }) },
  }
  const ownerLifecycle = createFixedIdentityTokenLifecycle({ transport: ownerTransport, apiKey: values.apiKey,
    accounts: { ownerA: values.ownerA, ownerB: values.ownerB }, mailbox: values.mailbox })
  await assert.rejects(() => ownerLifecycle.getIdToken('ownerA'))

  const mailboxLifecycle = createFixedIdentityTokenLifecycle({ transport: ownerTransport, apiKey: values.apiKey,
    accounts: { ownerA: values.ownerA, ownerB: values.ownerB }, mailbox: values.mailbox })
  const uid = 'mailbox-owner-uid'
  await mailboxLifecycle.captureOwnerMailboxRegistration(response({ localId: uid, email: values.mailbox,
    idToken: jwt({ uid, email: values.mailbox, verified: false, marker: 'signup-two' }),
    refreshToken: 'private-mailbox-refresh-22222222', expiresIn: '3600' }, true), { requestSha256: h('signup-two') })
  await assert.rejects(() => mailboxLifecycle.captureOwnerMailboxForcedRefresh(response({ user_id: 'different-uid',
    id_token: jwt({ uid: 'different-uid', email: values.mailbox, verified: true, marker: 'wrong-refresh' }),
    refresh_token: 'private-mailbox-refresh-33333333', expires_in: '3600', token_type: 'Bearer' }, true)))
})
