// Exercises the REAL staging-adapter logic (createGateGaStagingAdaptersCore
// in gateGaStagingAdapters.mjs) — not the emulator twin — against
// controlled fake REST/identity/callable clients that model real Identity
// Toolkit / Firestore REST behavior closely enough to prove every R9
// recovery branch: deterministic-by-runId admin identity (never runTag),
// real reconcileAdminAndCompany/reconcileInvitation/findAuthUidByEmail, and
// a real (non-null) invitation lock path. FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9,
// requirement 5.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGateGaStagingAdaptersCore, cryptoPassword } from './gateGaStagingAdapters.mjs'
import { computeInvitationLockId } from './gateGaInvitationLockCore.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

class FakeHttpError extends Error {
  constructor(status) { super(`fake_http_${status}`); this.status = status }
}

/** A single shared backing store two independent `createFakeClients()`
 * "processes" can point at — this is what makes the cross-process
 * reconciliation tests below a genuine proof: process 2 sees exactly what
 * process 1 durably created, through the SAME real adapter code, never a
 * shared in-memory object the adapter itself holds. */
function makeSharedState() {
  return { authByUid: new Map(), authByEmail: new Map(), firestore: new Map(), nextUid: 1 }
}

function makeFakeClients(state, { failCompanyCreation = false } = {}) {
  function newUid() { return `uid-${state.nextUid++}-${Math.random().toString(36).slice(2, 8)}` }

  async function identity(p, body) {
    if (p === 'accounts:signUp') {
      if (state.authByEmail.has(body.email)) throw new FakeHttpError(400)
      const user = { localId: newUid(), email: body.email, password: body.password, emailVerified: false }
      state.authByUid.set(user.localId, user)
      state.authByEmail.set(user.email, user)
      return { localId: user.localId, idToken: `tok-${user.localId}` }
    }
    if (p === 'accounts:signInWithPassword') {
      const user = state.authByEmail.get(body.email)
      if (!user || user.password !== body.password) throw new FakeHttpError(400)
      // A fresh token string per call — real Identity Toolkit never mints
      // the same idToken twice, even for the same account.
      return { localId: user.localId, idToken: `tok-${user.localId}-${state.nextUid++}` }
    }
    if (p === 'accounts:sendOobCode') return {}
    throw new Error(`fake_identity_unhandled:${p}`)
  }

  async function callable(fn, { body } = {}) {
    if (fn === 'createCompany') {
      if (failCompanyCreation) return { httpStatus: 500, json: { error: { message: 'injected_failure' } } }
      const companyId = `co-${state.nextUid++}`
      const adminUid = [...state.authByEmail.values()].find(u => u.emailVerified)?.localId
      state.firestore.set(`companies/${companyId}`, { name: body.companyName, ownerUid: adminUid })
      state.firestore.set(`company_data/${companyId}`, {})
      if (adminUid) {
        state.firestore.set(`companies/${companyId}/members/${adminUid}`, { role: 'admin' })
        state.firestore.set(`user_bootstrap/${adminUid}`, { fields: { result: { mapValue: { fields: { companyId: { stringValue: companyId } } } } }, __rawResult: { companyId } })
      }
      return { httpStatus: 200, json: { result: { companyId } } }
    }
    if (fn === 'inviteMember') {
      const inviteId = `inv-${state.nextUid++}`
      const lockId = computeInvitationLockId(body.companyId, body.email.trim().toLowerCase())
      state.firestore.set(`invitations/${inviteId}`, { companyId: body.companyId })
      state.firestore.set(`invitationLocks/${lockId}`, { currentInviteId: inviteId })
      return { httpStatus: 200, json: { result: { inviteId, token: `tok-invite-${inviteId}` } } }
    }
    throw new Error(`fake_callable_unhandled:${fn}`)
  }

  const documentsRoot = 'https://firestore.googleapis.com/v1/projects/demo/databases/(default)/documents'
  function relativeFromDocUrl(url) {
    if (url.startsWith(`${documentsRoot}/`)) return url.slice(documentsRoot.length + 1)
    return null
  }
  const rest = {
    documentsRoot,
    async get(url) {
      const relative = relativeFromDocUrl(url)
      if (relative !== null && state.firestore.has(relative)) {
        const value = state.firestore.get(relative)
        // Mirror the emulator adapter's own fake pattern: bootstrap
        // receipts carry a nested Firestore-REST-shaped `result.companyId`.
        if (value.__rawResult) return { fields: { result: { mapValue: { fields: { companyId: { stringValue: value.__rawResult.companyId } } } } } }
        const fields = {}
        for (const [k, v] of Object.entries(value)) fields[k] = typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v } : { stringValue: String(v) }
        return { fields }
      }
      throw new FakeHttpError(404)
    },
    async post(url, body) {
      if (url.endsWith('accounts:lookup')) {
        if (body.email) { const user = state.authByEmail.get(body.email[0]); return { users: user ? [user] : [] } }
        if (body.localId) { const user = state.authByUid.get(body.localId[0]); return { users: user ? [user] : [] } }
        return { users: [] }
      }
      if (url.endsWith('accounts:update')) {
        const user = state.authByUid.get(body.localId)
        if (!user) throw new FakeHttpError(404)
        if (body.emailVerified !== undefined) user.emailVerified = body.emailVerified
        if (body.password !== undefined) user.password = body.password
        return {}
      }
      if (url.endsWith('accounts:delete')) {
        const user = state.authByUid.get(body.localId)
        if (user) { state.authByUid.delete(body.localId); state.authByEmail.delete(user.email) }
        return {}
      }
      if (url.endsWith(':listCollectionIds')) return { collectionIds: [] }
      if (url.endsWith(':runQuery')) return []
      throw new Error(`fake_rest_post_unhandled:${url}`)
    },
    async del(url) {
      const relative = relativeFromDocUrl(url)
      if (relative !== null) state.firestore.delete(relative)
    },
  }
  return { rest, identity, callable }
}

function fixedPassword(seed) { let n = 0; return () => `fixed-pw-${seed}-${n++}` }

test('createAdminAndCompany derives a deterministic email from runId (never runTag) and fires the pre-company checkpoint', async () => {
  const state = makeSharedState()
  const { rest, identity, callable } = makeFakeClients(state)
  const adapters = createGateGaStagingAdaptersCore({ rest, identity, callable, project: 'demo', generatePassword: fixedPassword('a') })
  const checkpoints = []
  const created = await adapters.createAdminAndCompany({ runId: 'run-fixed-1', onInternalCheckpoint: c => checkpoints.push(c) })
  assert.deepEqual(checkpoints, ['ADMIN_AUTH_CREATED_PRE_COMPANY'])
  assert.ok(created.companyId)
  assert.ok(created.adminUid)
  const { deriveAdminIdentity } = await import('./gateGaAdminIdentityCore.mjs')
  const expectedEmail = deriveAdminIdentity('run-fixed-1').adminEmail
  assert.equal(state.authByUid.get(created.adminUid).email, expectedEmail)
})

test('createAdminAndCompany refuses without runId (identity cannot be derived)', async () => {
  const state = makeSharedState()
  const { rest, identity, callable } = makeFakeClients(state)
  const adapters = createGateGaStagingAdaptersCore({ rest, identity, callable, project: 'demo' })
  await assert.rejects(() => adapters.createAdminAndCompany({}), /missing_run_id/)
})

test('reconcileAdminAndCompany reports not-found when nothing was ever created for this runId', async () => {
  const state = makeSharedState()
  const { rest, identity, callable } = makeFakeClients(state)
  const adapters = createGateGaStagingAdaptersCore({ rest, identity, callable, project: 'demo' })
  const result = await adapters.reconcileAdminAndCompany({ runId: 'run-never-existed' })
  assert.deepEqual(result, { found: false })
})

test('reconcileAdminAndCompany reports orphaned when admin Auth exists but createCompany never committed', async () => {
  const state = makeSharedState()
  const { rest, identity, callable } = makeFakeClients(state, { failCompanyCreation: true })
  const adapters = createGateGaStagingAdaptersCore({ rest, identity, callable, project: 'demo', generatePassword: fixedPassword('b') })
  await assert.rejects(() => adapters.createAdminAndCompany({ runId: 'run-orphan-1' }), /create_company_failed/)
  const reconciled = await adapters.reconcileAdminAndCompany({ runId: 'run-orphan-1' })
  assert.equal(reconciled.found, true)
  assert.equal(reconciled.orphaned, true)
  assert.ok(reconciled.adminUid)
})

test('reconcileAdminAndCompany from a genuinely SEPARATE adapter instance (simulating process 2) finds what process 1 created, and signs in without ever knowing the original password', async () => {
  const state = makeSharedState()
  // Process 1: its own fresh clients/instance, but the SAME backing state.
  const process1 = makeFakeClients(state)
  const adaptersP1 = createGateGaStagingAdaptersCore({ rest: process1.rest, identity: process1.identity, callable: process1.callable, project: 'demo', generatePassword: fixedPassword('p1') })
  const created = await adaptersP1.createAdminAndCompany({ runId: 'run-shared-1' })

  // Process 2: independently constructed, no shared JS state except the
  // backing store — exactly like a genuinely separate OS process pointed
  // at the same real staging project would only share via the network.
  const process2 = makeFakeClients(state)
  const adaptersP2 = createGateGaStagingAdaptersCore({ rest: process2.rest, identity: process2.identity, callable: process2.callable, project: 'demo', generatePassword: fixedPassword('p2') })
  const reconciled = await adaptersP2.reconcileAdminAndCompany({ runId: 'run-shared-1' })

  assert.equal(reconciled.found, true)
  assert.equal(reconciled.orphaned, false)
  assert.equal(reconciled.adminUid, created.adminUid)
  assert.equal(reconciled.companyId, created.companyId)
  assert.ok(reconciled.adminIdToken)
  assert.notEqual(reconciled.adminIdToken, created.adminIdToken)
})

test('inviteRecipient returns a real, non-null lockPath matching computeInvitationLockId', async () => {
  const state = makeSharedState()
  const { rest, identity, callable } = makeFakeClients(state)
  const adapters = createGateGaStagingAdaptersCore({ rest, identity, callable, project: 'demo' })
  const created = await adapters.inviteRecipient({ companyId: 'co-fixed', adminIdToken: 'tok', recipient: 'Recipient@Example.Invalid' })
  const expectedLockId = computeInvitationLockId('co-fixed', 'recipient@example.invalid')
  assert.equal(created.lockPath, `invitationLocks/${expectedLockId}`)
})

test('reconcileInvitation reports not-found when nothing was ever created', async () => {
  const state = makeSharedState()
  const { rest, identity, callable } = makeFakeClients(state)
  const adapters = createGateGaStagingAdaptersCore({ rest, identity, callable, project: 'demo' })
  const result = await adapters.reconcileInvitation({ companyId: 'co-x', recipient: 'nobody@example.invalid' })
  assert.deepEqual(result, { found: false })
})

test('reconcileInvitation finds a real invitation via the deterministic lock, from a separate adapter instance', async () => {
  const state = makeSharedState()
  const process1 = makeFakeClients(state)
  const adaptersP1 = createGateGaStagingAdaptersCore({ rest: process1.rest, identity: process1.identity, callable: process1.callable, project: 'demo' })
  const created = await adaptersP1.inviteRecipient({ companyId: 'co-shared', adminIdToken: 'tok', recipient: 'recipient@example.invalid' })

  const process2 = makeFakeClients(state)
  const adaptersP2 = createGateGaStagingAdaptersCore({ rest: process2.rest, identity: process2.identity, callable: process2.callable, project: 'demo' })
  const reconciled = await adaptersP2.reconcileInvitation({ companyId: 'co-shared', recipient: 'recipient@example.invalid' })

  assert.equal(reconciled.found, true)
  assert.equal(reconciled.inviteId, created.inviteId)
  assert.equal(reconciled.lockPath, created.lockPath)
  // The raw invitation token is never persisted anywhere (SEC-006 design)
  // — a reconciled invitation must never carry one, real or fabricated.
  assert.equal('token' in reconciled, false)
})

test('findAuthUidByEmail resolves a real, previously-registered recipient uid, and null for an unknown one', async () => {
  const state = makeSharedState()
  const { rest, identity, callable } = makeFakeClients(state)
  const adapters = createGateGaStagingAdaptersCore({ rest, identity, callable, project: 'demo' })
  const registered = await adapters.registerRecipient({ recipient: 'a-real-recipient@example.invalid', password: 'a-real-password-16chars!' })
  const found = await adapters.findAuthUidByEmail('a-real-recipient@example.invalid')
  assert.equal(found.uid, registered.recipientUid)
  const notFound = await adapters.findAuthUidByEmail('nobody@example.invalid')
  assert.equal(notFound.uid, null)
})

test('normal (non-reconciled) cleanup deletes both the invitation and its lock document', async () => {
  const state = makeSharedState()
  const { rest, identity, callable } = makeFakeClients(state)
  const adapters = createGateGaStagingAdaptersCore({ rest, identity, callable, project: 'demo' })
  const created = await adapters.inviteRecipient({ companyId: 'co-cleanup', adminIdToken: 'tok', recipient: 'recipient@example.invalid' })
  assert.equal((await adapters.readDoc(created.invitationPath)).exists, true)
  assert.equal((await adapters.readDoc(created.lockPath)).exists, true)
  await adapters.deleteDoc(created.invitationPath)
  await adapters.deleteDoc(created.lockPath)
  assert.equal((await adapters.readDoc(created.invitationPath)).exists, false)
  assert.equal((await adapters.readDoc(created.lockPath)).exists, false)
})

test('constructor refuses a rest/identity/callable client missing the expected shape (fail-closed, not a silent no-op adapter)', () => {
  assert.throws(() => createGateGaStagingAdaptersCore({ rest: {}, identity: () => {}, callable: () => {} }), /bad_rest_client/)
  assert.throws(() => createGateGaStagingAdaptersCore({ rest: { get() {}, post() {}, del() {}, documentsRoot: 'x' }, identity: null, callable: () => {} }), /bad_identity_client/)
})

// R9 requirement 5: a dedicated test that fails against the R8-published
// gateGaStagingAdapters.mjs — proven by source inspection, since that
// published shape has no runId-based identity or recovery methods at all
// (this would be an ImportError/undefined-function failure, not a subtle
// logic difference, if run against it directly).
test('source-level: the staging adapter exports the R9 recovery surface and no longer derives admin identity from runTag', () => {
  const source = fs.readFileSync(path.join(HERE, 'gateGaStagingAdapters.mjs'), 'utf8')
  assert.ok(source.includes('export function createGateGaStagingAdaptersCore'), 'must export the DI-testable core factory')
  assert.ok(source.includes('reconcileAdminAndCompany'), 'must implement reconcileAdminAndCompany')
  assert.ok(source.includes('reconcileInvitation'), 'must implement reconcileInvitation')
  assert.ok(source.includes('findAuthUidByEmail'), 'must implement findAuthUidByEmail')
  assert.ok(source.includes('deriveAdminIdentity'), 'admin identity must come from the shared, runId-based derivation')
  assert.ok(!source.includes('${runTag}-admin'), 'must NOT derive admin identity from the ephemeral per-process runTag (the R8-published bug)')
  // The R8-published bug was a literal `lockPath: null` return value with a
  // trailing comma, in code (not inside a backtick-quoted comment
  // reference to that same literal, which this file's own header
  // legitimately contains).
  assert.ok(!/lockPath:\s*null,/.test(source.replace(/`[^`]*`/g, '')), 'inviteRecipient must NOT hardcode lockPath: null (the R8-published bug)')
})
