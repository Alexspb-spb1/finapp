import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createMailboxRequests, discoverMailbox, discoveryTransport, normalizeMailbox, profileUrl, sanitizeLookup, sanitizeProfile, URLS } from './mailboxDiscoveryCore.mjs'

const mailbox = 'owner@example.test'
const uid = 'safe_uid-1'
const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { Client } = require(path.join(root, 'node_modules/firebase-tools/lib/apiv2.js'))

test('mailbox normalization is strict and does not accept control characters', () => {
  assert.equal(normalizeMailbox(' Owner@Example.Test '), mailbox)
  for (const value of ['', 'not-an-email', 'a@b', 'a@example.test\nother@example.test']) assert.throws(() => normalizeMailbox(value))
})

test('lookup permits absent or one exact account and rejects ambiguity', () => {
  assert.deepEqual(sanitizeLookup({}, mailbox), { accountExists: false, uid: null, account: null })
  const found = sanitizeLookup({ users: [{ localId: uid, email: mailbox, emailVerified: false, createdAt: '123' }] }, mailbox)
  assert.equal(found.accountExists, true)
  assert.equal(found.account.emailVerified, false)
  assert.match(found.account.uidSha256, /^[a-f0-9]{64}$/)
  assert.equal('uid' in found.account, false)
  assert.equal(sanitizeLookup({ users: [{ localId: uid, email: mailbox }] }, mailbox).account.emailVerified, false)
  assert.throws(() => sanitizeLookup({ users: [
    { localId: uid, email: mailbox, emailVerified: false },
    { localId: 'second', email: mailbox, emailVerified: false },
  ] }, mailbox))
  assert.throws(() => sanitizeLookup({ users: [{ localId: uid, email: 'other@example.test', emailVerified: false }] }, mailbox))
})

test('profile output retains only existence and a content hash', () => {
  const result = sanitizeProfile({
    name: `projects/finapp-staging/databases/(default)/documents/users/${uid}`,
    fields: { role: { stringValue: 'viewer' }, private: { stringValue: 'never-output' } },
  }, uid)
  assert.equal(result.profileExists, true)
  assert.match(result.profileFieldsSha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(result).includes('never-output'), false)
  const empty = sanitizeProfile({ name: `projects/finapp-staging/databases/(default)/documents/users/${uid}` }, uid)
  assert.equal(empty.profileExists, true)
  assert.match(empty.profileFieldsSha256, /^[a-f0-9]{64}$/)
  assert.throws(() => sanitizeProfile({ name: `projects/finapp-staging/databases/(default)/documents/users/${uid}`, fields: null }, uid))
})

test('transport allows only exact project GET, lookup POST, allowed profile GET and OAuth refresh', async () => {
  const seen = []
  const transport = discoveryTransport(async (input, init) => { seen.push([String(input), init]); return { ok: true } }, mailbox)
  await transport.fetch(`${URLS.project}?fields=projectId%2CprojectNumber`)
  await transport.fetch(URLS.lookup, { method: 'POST', body: JSON.stringify({ email: [mailbox] }) })
  await transport.fetch('https://www.googleapis.com/oauth2/v3/token', { method: 'POST' })
  transport.allowProfile(uid)
  await transport.fetch(profileUrl(uid))
  assert.equal(seen.length, 4)
  assert.ok(seen.every(([, init]) => init.redirect === 'error'))
  await assert.rejects(() => transport.fetch(URLS.lookup))
  await assert.rejects(() => transport.fetch(URLS.lookup, { method: 'POST', body: JSON.stringify({ email: ['other@example.test'] }) }))
  await assert.rejects(() => transport.fetch(URLS.lookup, { method: 'POST', body: JSON.stringify({ email: [mailbox], extra: true }) }))
  await assert.rejects(() => transport.fetch(`${URLS.project}?fields=projectId`))
  await assert.rejects(() => transport.fetch(`${URLS.lookup}?alt=json`, { method: 'POST', body: JSON.stringify({ email: [mailbox] }) }))
  await assert.rejects(() => transport.fetch('https://identitytoolkit.googleapis.com/v1/projects/finapp-prod-10a83/accounts:lookup', { method: 'POST' }))
  await assert.rejects(() => transport.fetch(profileUrl('other')))
  await assert.rejects(() => transport.fetch(`${profileUrl(uid)}?mask.fieldPaths=role`))
  await assert.rejects(() => transport.fetch(profileUrl(uid), { method: 'DELETE' }))
})

test('installed firebase-tools keeps lookup body off later GETs and each request is dispatched once', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  const baseFetch = async (input, init) => {
    seen.push({ url: String(input), method: init.method, body: init.body })
    const url = new URL(input)
    let body = {}
    if (url.origin === 'https://firebase.googleapis.com') body = { projectId: 'finapp-staging', projectNumber: '123' }
    if (url.origin === 'https://identitytoolkit.googleapis.com') body = { users: [{ localId: uid, email: mailbox, emailVerified: false }] }
    if (url.origin === 'https://firestore.googleapis.com') body = { name: `projects/finapp-staging/databases/(default)/documents/users/${uid}`, fields: { role: { stringValue: 'viewer' } } }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const transport = discoveryTransport(baseFetch, mailbox)
  globalThis.fetch = transport.fetch
  try {
    const requests = createMailboxRequests({ Client, transport, mailbox, auth: false })
    await requests.getProject()
    await requests.lookupAccount()
    requests.allowProfile(uid)
    await requests.getProfile(uid)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(seen.length, 3)
  assert.deepEqual(seen.map(row => row.method), ['GET', 'POST', 'GET'])
  assert.equal(seen[0].body, undefined)
  assert.deepEqual(JSON.parse(seen[1].body), { email: [mailbox] })
  assert.equal(seen[2].body, undefined)
  assert.equal(seen.filter(row => row.url.includes('accounts:lookup')).length, 1)
})

test('installed firebase-tools does not retry a failed lookup transport', async () => {
  let attempts = 0
  const originalFetch = globalThis.fetch
  const transport = discoveryTransport(async () => {
    attempts++
    throw Object.assign(new Error('synthetic closed connection'), { code: 'ECONNRESET' })
  }, mailbox)
  globalThis.fetch = transport.fetch
  try {
    const requests = createMailboxRequests({ Client, transport, mailbox, auth: false })
    await assert.rejects(() => requests.lookupAccount())
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(attempts, 1)
})

test('discovery reports absent account without a profile request', async () => {
  let profileReads = 0
  const result = await discoverMailbox({
    mailbox,
    getProject: async () => ({ projectId: 'finapp-staging', projectNumber: '123' }),
    lookupAccount: async () => ({}),
    allowProfile: () => assert.fail('profile must not be allowed'),
    getProfile: async () => { profileReads++; return {} },
    now: () => '2026-09-08T00:00:00.000Z',
  })
  assert.equal(result.accountExists, false)
  assert.equal(profileReads, 0)
  assert.equal(result.cloudMutations, 0)
  assert.equal(result.emailsSent, 0)
})

test('discovery hashes an existing profile and treats only 404 as absent', async () => {
  const base = {
    mailbox,
    getProject: async () => ({ projectId: 'finapp-staging', projectNumber: '123' }),
    lookupAccount: async () => ({ users: [{ localId: uid, email: mailbox, emailVerified: true }] }),
    allowProfile: value => assert.equal(value, uid),
  }
  const existing = await discoverMailbox({ ...base, getProfile: async () => ({
    name: `projects/finapp-staging/databases/(default)/documents/users/${uid}`, fields: { role: { stringValue: 'viewer' } },
  }) })
  assert.equal(existing.profile.profileExists, true)
  const absent = await discoverMailbox({ ...base, getProfile: async () => { throw { status: 404 } } })
  assert.equal(absent.profile.profileExists, false)
  await assert.rejects(() => discoverMailbox({ ...base, getProfile: async () => { throw { status: 403 } } }))
})
