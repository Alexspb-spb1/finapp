import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  createCallableDispatchPrimitive, createFirebaseReadOnlyPreflightAdapters,
  createGuardedFirebaseToolsSessionLoader, createSafeStopTeardown,
  createIncrementalFirestoreReconciler,
  createSemanticFirestoreReadbackAdapter, createSyntheticVerifiedAuthAdapter,
  discoverFirebaseAuthTemplateMetadata,
  LIVE_EXECUTOR_MISSING_ADAPTERS, runLiveAcceptanceComposition,
} from './liveAcceptanceExecutorAdapters.mjs'
import { appendJournalEvent, buildFixturePlan } from './liveAcceptanceCore.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const now = '2026-09-08T12:00:00.000Z'
const callables = ['acceptInvite', 'cancelInvite', 'createCompany', 'getCompanyAccess', 'inviteMember', 'listInvitations', 'previewInvite', 'resendInvite']

function providerFunction(name) {
  return {
    name: `projects/finapp-staging/locations/us-central1/functions/${name}`,
    state: 'ACTIVE', environment: 'GEN_2',
    buildConfig: {
      runtime: 'nodejs22', entryPoint: name,
      build: 'projects/123456789/locations/us-central1/builds/11111111-2222-3333-4444-555555555555',
      source: { storageSource: { bucket: 'opaque', object: 'opaque' } },
    },
    serviceConfig: {
      availableMemory: '256Mi', availableCpu: '1', maxInstanceRequestConcurrency: 1,
      maxInstanceCount: 1, timeoutSeconds: 60, revision: `${name.toLowerCase()}-00001-abc`,
    },
  }
}

function journalBytes(requestSha256, callable = null) {
  let events = []
  const append = (status, details = {}) => {
    events = appendJournalEvent(events, { seq: events.length, status, at: now, details })
  }
  append('PRECONDITIONS_VERIFIED')
  append('PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED', { envelopeSha256: h('envelope') })
  append('SCENARIOS_RUNNING')
  if (callable === null) {
    append('FIXTURE_MUTATION_MAY_BE_SENT', {
      index: 0, slot: 'createOwnerAAuth', callCount: 1, callable: null,
      callableCount: null, totalCallableCount: 0, requestSha256,
    })
  } else {
    append('CALLABLE_REQUEST_MAY_BE_SENT', {
      callable, callableCount: 1, totalCallableCount: 1, requestSha256,
      bindingSha256: h('binding'),
    })
  }
  return Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')
}

function fakeSessionHarness(overrides = {}) {
  let loads = 0, authorizations = 0
  const requests = []
  class Client {
    constructor({ urlPrefix, auth }) { this.origin = urlPrefix; assert.equal(auth, true) }
    async get(path, requestOptions) {
      requests.push({ method: 'GET', url: `${this.origin}${path}`, options: structuredClone(requestOptions) })
      const key = `GET ${this.origin}${path}`
      if (Object.hasOwn(overrides, key)) {
        const value = overrides[key]
        if (value instanceof Error) throw value
        return { body: structuredClone(value) }
      }
      throw Object.assign(new Error('unexpected fake request'), { status: 599 })
    }
    async post(path, body, requestOptions) {
      requests.push({ method: 'POST', url: `${this.origin}${path}`, body: structuredClone(body), options: structuredClone(requestOptions) })
      const key = `POST ${this.origin}${path}`
      if (Object.hasOwn(overrides, key)) {
        const value = typeof overrides[key] === 'function' ? await overrides[key]({ path, body, requestOptions }) : overrides[key]
        return { body: structuredClone(value) }
      }
      throw Object.assign(new Error('unexpected fake request'), { status: 599 })
    }
  }
  const modules = {
    'logger.js': { logger: { silent: false } },
    'auth.js': { getGlobalDefaultAccount: () => ({ user: { email: 'operator@example.invalid' }, tokens: { refresh_token: 'opaque-refresh' } }) },
    'requireAuth.js': { requireAuth: async options => {
      authorizations++
      assert.equal(options.project, 'finapp-staging')
      return true
    } },
    'apiv2.js': { Client },
  }
  const loader = createGuardedFirebaseToolsSessionLoader({
    repoRoot: 'D:\\projects\\finapp\\finapp-sec006-stage8',
    loadModule: name => { loads++; return modules[name] },
  })
  return { loader, requests, loads: () => loads, authorizations: () => authorizations }
}

test('credential modules and network remain untouched until explicit gated execute', async () => {
  const harness = fakeSessionHarness()
  assert.equal(harness.loads(), 0)
  assert.equal(harness.requests.length, 0)
  await assert.rejects(() => harness.loader.execute({ approvalValidated: true, localGatesValidated: false }))
  assert.equal(harness.loads(), 0)
  assert.equal(harness.authorizations(), 0)
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  assert.deepEqual(session, { project: 'finapp-staging', authenticated: true })
  assert.equal(harness.loads(), 4)
  assert.equal(harness.authorizations(), 1)
  assert.equal(harness.requests.length, 0)
  await assert.rejects(() => harness.loader.execute({ approvalValidated: true, localGatesValidated: true }))
})

test('fresh project/build adapters use exact shapes and block endpoint response drift', async () => {
  const projectUrl = 'https://firebase.googleapis.com/v1beta1/projects/finapp-staging'
  const billingUrl = 'https://cloudbilling.googleapis.com/v1/projects/finapp-staging/billingInfo'
  const databaseUrl = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)'
  const harness = fakeSessionHarness({
    [`GET ${projectUrl}`]: { projectId: 'finapp-staging', projectNumber: '123456789' },
    [`GET ${billingUrl}`]: { projectId: 'finapp-staging', billingEnabled: true },
    [`GET ${databaseUrl}`]: { name: 'projects/finapp-staging/databases/(default)', locationId: 'eur3', type: 'FIRESTORE_NATIVE' },
  })
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const sourceHead = 'a'.repeat(40)
  const adapters = createFirebaseReadOnlyPreflightAdapters({
    session, sourceHead, mailbox: 'owner@example.invalid', expectedAuthMetadataSha256: h('auth'),
    stagingBuildProbe: async () => ({ sourceHead, stagingFingerprint: h('build'), servedFrom: 'http://127.0.0.1:5177', sixFieldsVerified: true }),
    now: () => now,
  })
  assert.equal(harness.requests.length, 0)
  const project = await adapters.project()
  assert.equal(project.projectId, 'finapp-staging')
  assert.equal(harness.requests.length, 3)
  assert.equal(harness.requests[0].options.retries, 0)
  assert.equal(harness.requests[1].options.ignoreQuotaProject, true)
  assert.deepEqual(harness.requests[1].options.headers, {})
  assert.equal((await adapters.build()).sixFieldsVerified, true)

  const drift = fakeSessionHarness({
    [`GET ${projectUrl}`]: { projectId: 'production', projectNumber: '123456789' },
    [`GET ${billingUrl}`]: { projectId: 'finapp-staging', billingEnabled: true },
    [`GET ${databaseUrl}`]: { name: 'projects/finapp-staging/databases/(default)', locationId: 'eur3', type: 'FIRESTORE_NATIVE' },
  })
  const driftSession = await drift.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const driftAdapters = createFirebaseReadOnlyPreflightAdapters({
    session: driftSession, sourceHead, mailbox: 'owner@example.invalid', expectedAuthMetadataSha256: h('auth'),
    stagingBuildProbe: async () => ({ sourceHead: 'b'.repeat(40), stagingFingerprint: h('build'), servedFrom: 'http://127.0.0.1:5177', sixFieldsVerified: true }),
  })
  await assert.rejects(() => driftAdapters.project())
  await assert.rejects(() => driftAdapters.build())
})

test('all eight fresh adapters sanitize the fixed provider schemas', async () => {
  const project = 'https://firebase.googleapis.com/v1beta1/projects/finapp-staging'
  const functionsV1 = 'https://cloudfunctions.googleapis.com/v1/projects/finapp-staging/locations/-/functions'
  const functionsV2 = 'https://cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/-/functions'
  const release = 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/releases/cloud.firestore'
  const ruleset = 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/rulesets/rules-1'
  const indexes = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/collectionGroups/-/indexes'
  const fields = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/collectionGroups/-/fields'
  const auth = 'https://identitytoolkit.googleapis.com/admin/v2/projects/finapp-staging/config'
  const lookup = 'https://identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts:lookup'
  const maintenance = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents/system/maintenance'
  const authMetadata = {
    emailPasswordEnabled: true, userSignupDisabled: false, verificationMethod: 'DEFAULT',
    callbackDomain: 'finapp-staging.firebaseapp.com',
    template: { bodyFormat: 'HTML', customized: false, senderLocalPartPresent: true, subjectPresent: true },
  }
  const missing = Object.assign(new Error('missing'), { status: 404 })
  const invitationIndex = {
    name: 'projects/finapp-staging/databases/(default)/collectionGroups/invitations/indexes/index-1',
    state: 'READY', queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'companyId', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' },
    ],
  }
  const overrides = {
    [`GET ${project}`]: { projectId: 'finapp-staging', projectNumber: '123456789' },
    'GET https://cloudbilling.googleapis.com/v1/projects/finapp-staging/billingInfo': { projectId: 'finapp-staging', billingEnabled: true },
    'GET https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)': {
      name: 'projects/finapp-staging/databases/(default)', locationId: 'eur3', type: 'FIRESTORE_NATIVE',
    },
    [`GET ${functionsV1}`]: {}, [`GET ${functionsV2}`]: { functions: callables.map(providerFunction) },
    [`GET ${release}`]: { name: 'projects/finapp-staging/releases/cloud.firestore', rulesetName: 'projects/finapp-staging/rulesets/rules-1' },
    [`GET ${ruleset}`]: { name: 'projects/finapp-staging/rulesets/rules-1', source: { files: [{ content: 'rules_version = \'2\';\n' }] } },
    [`GET ${indexes}`]: { indexes: [invitationIndex] },
    [`GET ${fields}`]: { fields: [{ name: 'projects/finapp-staging/databases/(default)/collectionGroups/one/fields/two' }] },
    [`GET ${auth}`]: {
      name: 'projects/finapp-staging/config', authorizedDomains: ['finapp-staging.firebaseapp.com'],
      signIn: { email: { enabled: true, passwordRequired: true } }, client: { permissions: { disabledUserSignup: false } },
      notification: { sendEmail: { method: 'DEFAULT', callbackUri: 'https://finapp-staging.firebaseapp.com/__/auth/action',
        verifyEmailTemplate: { bodyFormat: 'HTML', customized: false, senderLocalPart: 'noreply', subject: 'Verify' } } },
    },
    [`GET ${maintenance}`]: missing,
    [`POST ${lookup}`]: {},
    'POST https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents:runQuery': [{ readTime: now }],
  }
  const harness = fakeSessionHarness(overrides)
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const sourceHead = 'a'.repeat(40)
  const adapters = createFirebaseReadOnlyPreflightAdapters({
    session, sourceHead, mailbox: 'owner@example.invalid', expectedAuthMetadataSha256: h(JSON.stringify(authMetadata)),
    stagingBuildProbe: async () => ({ sourceHead, stagingFingerprint: h('build'), servedFrom: 'http://127.0.0.1:5177', sixFieldsVerified: true }),
    now: () => now,
  })
  assert.deepEqual(Object.keys(adapters), ['project', 'functions', 'rules', 'indexes', 'auth', 'maintenance', 'subjectAbsence', 'build'])
  const result = {}
  for (const name of Object.keys(adapters)) result[name] = await adapters[name]()
  assert.equal(result.functions.items.length, 8)
  assert.equal(result.rules.canonicalSha256, h('rules_version = \'2\';\n'))
  assert.equal(result.indexes.invitationIndexState, 'READY')
  assert.equal(result.auth.verificationTemplateMetadataPresent, true)
  assert.equal(result.maintenance.state, 'ABSENT')
  assert.equal(result.subjectAbsence.accountExists, false)
  assert.equal(JSON.stringify(result).includes('Verify'), false)
  assert.equal(JSON.stringify(result).includes('owner@example.invalid'), false)
})

test('narrow Auth template discovery returns hashes and booleans without template text', async () => {
  const project = 'https://firebase.googleapis.com/v1beta1/projects/finapp-staging'
  const auth = 'https://identitytoolkit.googleapis.com/admin/v2/projects/finapp-staging/config'
  const harness = fakeSessionHarness({
    [`GET ${project}`]: { projectId: 'finapp-staging', projectNumber: '123456789' },
    [`GET ${auth}`]: {
      name: 'projects/123456789/config', authorizedDomains: ['finapp-staging.firebaseapp.com'],
      signIn: { email: { enabled: true, passwordRequired: true } }, client: { permissions: {} },
      notification: { sendEmail: { method: 'DEFAULT', callbackUri: 'https://finapp-staging.firebaseapp.com/__/auth/action',
        verifyEmailTemplate: { bodyFormat: 'HTML', senderLocalPart: 'noreply', subject: 'Private subject' } } },
    },
  })
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const result = await discoverFirebaseAuthTemplateMetadata({ session })
  assert.deepEqual(Object.keys(result), [
    'emailPasswordEnabled', 'userSignupDisabled', 'verificationMethodPresent',
    'verificationTemplateMetadataPresent', 'callbackDomainPresent', 'metadataSha256',
  ])
  assert.match(result.metadataSha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(result).includes('Private subject'), false)
  assert.deepEqual(harness.requests.map(row => [row.method, row.url]), [['GET', project], ['GET', auth]])
  assert.equal(harness.requests.every(row => row.options.retries === 0), true)
})

test('synthetic Admin Auth adapter binds exact body to journal and reconciles verified UID', async () => {
  const runId = 'stage8-run001'
  const ownerA = { uid: `${runId}-ownerA`, email: 'owner-a@example.invalid', password: 'long-random-password-A1!' }
  const ownerB = { uid: `${runId}-ownerB`, email: 'owner-b@example.invalid', password: 'different-random-B2!' }
  const createUrl = 'https://identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts'
  const lookupUrl = `${createUrl}:lookup`
  const provider = { localId: ownerA.uid, email: ownerA.email, emailVerified: true, disabled: false }
  const harness = fakeSessionHarness({ [`POST ${createUrl}`]: provider, [`POST ${lookupUrl}`]: { users: [provider] } })
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const adapter = createSyntheticVerifiedAuthAdapter({ session, runId, accounts: { ownerA, ownerB } })
  const subjectSha256 = h(ownerA.email)
  const operation = adapter.slot('ownerA', subjectSha256)
  const permit = { slot: 'createOwnerAAuth', requestSha256: operation.requestSha256,
    journalBytes: journalBytes(operation.requestSha256) }
  const dispatched = await operation.dispatch(permit)
  assert.match(dispatched.outcomeSha256, /^[a-f0-9]{64}$/)
  const readback = await operation.readback()
  assert.deepEqual(readback.produced, { ownerAUid: ownerA.uid })
  assert.equal(harness.requests[0].body.emailVerified, true)
  assert.equal(harness.requests[0].body.disableUser, false)
  assert.equal(harness.requests[0].options.retries, 0)
  await assert.rejects(() => operation.dispatch({ ...permit, requestSha256: h('drift') }))
})

test('callable primitive fixes URL, method and body and blocks body/journal drift', async () => {
  const input = { companyId: 'company_a', pageSize: 20 }
  const body = JSON.stringify({ data: input })
  const requestSha256 = h(body)
  const calls = []
  const transport = {
    authorizeRequest(spec) { calls.push({ phase: 'authorize', spec }) },
    async fetch(url, init) {
      calls.push({ phase: 'fetch', url, init })
      return { status: 200, json: async () => ({ result: { items: [], nextCursor: null } }) }
    },
  }
  let tokens = 0
  const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"owner"}').toString('base64url')}.signature`
  const primitive = createCallableDispatchPrimitive({ transport, getIdToken: async () => { tokens++; return jwt } })
  const permit = { requestSha256, binding: { identity: 'ownerA' }, journalBytes: journalBytes(requestSha256, 'listInvitations') }
  const result = await primitive.dispatch({
    callable: 'listInvitations', identity: 'ownerA', input, permit, journalKind: 'callable',
  })
  assert.equal(tokens, 1)
  assert.equal(result.requestSha256, requestSha256)
  assert.deepEqual(calls[0], { phase: 'authorize', spec: {
    method: 'POST', url: 'https://us-central1-finapp-staging.cloudfunctions.net/listInvitations', bodySha256: requestSha256,
  } })
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].init.body, body)
  assert.equal(calls[1].init.headers.authorization, `Bearer ${jwt}`)
  const prepared = primitive.prepare({ callable: 'getCompanyAccess', identity: 'ownerA', input: { companyId: 'company_a' } })
  assert.deepEqual(Object.keys(prepared), ['requestSha256'])
  await assert.rejects(() => primitive.dispatch({
    callable: 'listInvitations', identity: 'ownerA', input, permit, journalKind: 'callable',
  }))
  assert.equal(tokens, 1)
  assert.equal(calls.length, 2)
  await assert.rejects(() => primitive.dispatch({
    callable: 'listInvitations', identity: 'ownerA', input: { ...input, extra: true }, permit,
    journalKind: 'callable',
  }))
  assert.deepEqual(LIVE_EXECUTOR_MISSING_ADAPTERS, [])
})

const fsTime = '2026-09-08T12:00:00.123456789Z'
const fsValue = value => {
  if (value === null) return { nullValue: null }
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}T/.test(value) && value.endsWith('Z')
    ? { timestampValue: value } : { stringValue: value }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (Number.isInteger(value)) return { integerValue: String(value) }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(fsValue) } }
  return { mapValue: { fields: fsFields(value) } }
}
const fsFields = fields => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fsValue(value)]))
const fsDoc = (path, fields, updateTime = fsTime) => ({
  name: `projects/finapp-staging/databases/(default)/documents/${path}`,
  fields: fsFields(fields), createTime: fsTime, updateTime,
})

function semanticFixture() {
  const ids = {
    ownerAUid: 'uid_owner_a', ownerBUid: 'uid_owner_b', ownerMailboxUid: 'uid_mailbox',
    companyAId: 'company_a', companyBId: 'company_b', mailboxCancelledInviteId: 'invite_cancelled',
    mailboxFinalInviteId: 'invite_final', ownerBInviteId: 'invite_owner_b',
    mailboxCancelledCapabilitySha256: h('cancelled-token'), mailboxFinalCapabilitySha256: h('final-token'),
    ownerBCapabilitySha256: h('owner-b-token'), mailboxLockId: h('mailbox-lock'), ownerBLockId: h('owner-b-lock'),
  }
  const emails = { ownerA: 'owner-a@example.invalid', ownerB: 'owner-b@example.invalid', mailbox: 'mailbox@example.invalid' }
  const plan = buildFixturePlan({ runId: 'stage8-run001', mailboxSha256: h(emails.mailbox),
    companyIds: { a: ids.companyAId, b: ids.companyBId }, syntheticAuthUids: { ownerA: ids.ownerAUid, ownerB: ids.ownerBUid },
    ownerMailboxUid: ids.ownerMailboxUid, lockIds: { mailbox: ids.mailboxLockId, ownerB: ids.ownerBLockId } })
  const docs = new Map()
  const add = (path, fields, updateTime) => docs.set(path, fsDoc(path, fields, updateTime))
  const company = (id, ownerId, name) => ({ id, name, legalType: 'ooo', currency: 'RUB', createdAt: '2026-09-08T12:00:00.000Z', ownerId })
  const companyData = { accounts: [], categories: [], counterparties: [], transactions: [], projects: [], rules: [] }
  const member = (uid, role, invitedBy) => ({ uid, role, status: 'active', createdAt: fsTime, updatedAt: fsTime, ...(invitedBy ? { invitedBy } : {}) })
  const profile = (uid, email, role, companyId) => ({ id: uid, name: 'Owner', email, role, companyId, createdAt: '2026-09-08T12:00:00.000Z' })
  add(`companies/${ids.companyAId}`, company(ids.companyAId, ids.ownerAUid, 'A'))
  add(`companies/${ids.companyBId}`, company(ids.companyBId, ids.ownerBUid, 'B'))
  add(`company_data/${ids.companyAId}`, companyData); add(`company_data/${ids.companyBId}`, companyData)
  add(`users/${ids.ownerAUid}`, profile(ids.ownerAUid, emails.ownerA, 'admin', ids.companyAId))
  add(`users/${ids.ownerBUid}`, { ...profile(ids.ownerBUid, emails.ownerB, 'admin', ids.companyBId),
    companies: [{ companyId: ids.companyBId, role: 'admin' }, { companyId: ids.companyAId, role: 'viewer' }] })
  add(`users/${ids.ownerMailboxUid}`, profile(ids.ownerMailboxUid, emails.mailbox, 'accountant', ids.companyAId))
  add(`user_bootstrap/${ids.ownerAUid}`, { idempotencyKey: 'idem-a', fingerprint: h('fp-a'), result: { companyId: ids.companyAId }, createdAt: fsTime })
  add(`user_bootstrap/${ids.ownerBUid}`, { idempotencyKey: 'idem-b', fingerprint: h('fp-b'), result: { companyId: ids.companyBId }, createdAt: fsTime })
  add(`companies/${ids.companyAId}/members/${ids.ownerAUid}`, member(ids.ownerAUid, 'admin'))
  add(`companies/${ids.companyBId}/members/${ids.ownerBUid}`, member(ids.ownerBUid, 'admin'))
  add(`companies/${ids.companyAId}/members/${ids.ownerBUid}`, member(ids.ownerBUid, 'viewer', ids.ownerAUid))
  add(`companies/${ids.companyAId}/members/${ids.ownerMailboxUid}`, member(ids.ownerMailboxUid, 'accountant', ids.ownerAUid))
  const invitation = (email, role, tokenHash, status, extra = {}) => ({ companyId: ids.companyAId, emailNormalized: email,
    role, tokenHash, status, expiresAt: fsTime, createdBy: ids.ownerAUid, createdAt: fsTime, updatedAt: fsTime,
    resendCount: extra.resendCount ?? 0, lastSentAt: fsTime, ...extra.fields })
  add(`invitations/${ids.mailboxCancelledInviteId}`, invitation(emails.mailbox, 'accountant', ids.mailboxCancelledCapabilitySha256, 'revoked',
    { fields: { revokedAt: fsTime, revokedBy: ids.ownerAUid } }))
  add(`invitations/${ids.mailboxFinalInviteId}`, invitation(emails.mailbox, 'accountant', ids.mailboxFinalCapabilitySha256, 'accepted',
    { resendCount: 1, fields: { acceptedAt: fsTime, acceptedByUid: ids.ownerMailboxUid } }))
  add(`invitations/${ids.ownerBInviteId}`, invitation(emails.ownerB, 'viewer', ids.ownerBCapabilitySha256, 'accepted',
    { fields: { acceptedAt: fsTime, acceptedByUid: ids.ownerBUid } }))
  add(`invitationLocks/${ids.mailboxLockId}`, { currentInviteId: ids.mailboxFinalInviteId })
  add(`invitationLocks/${ids.ownerBLockId}`, { currentInviteId: ids.ownerBInviteId })
  const audit = [
    ['company_created', ids.ownerAUid, null], ['member_invited', ids.ownerAUid, null],
    ['invitation_cancelled', ids.ownerAUid, null], ['member_invited', ids.ownerAUid, null],
    ['invitation_resent', ids.ownerAUid, null], ['invite_accepted', ids.ownerMailboxUid, ids.ownerMailboxUid],
    ['member_invited', ids.ownerAUid, null], ['invite_accepted', ids.ownerBUid, ids.ownerBUid],
  ].map(([action, actorUid, targetUid], index) => fsDoc(`companies/${ids.companyAId}/audit_events/audit_a_${index}`,
    { action, actorUid, targetUid, createdAt: fsTime }))
  const auditB = [fsDoc(`companies/${ids.companyBId}/audit_events/audit_b_0`,
    { action: 'company_created', actorUid: ids.ownerBUid, targetUid: null, createdAt: fsTime })]
  return { ids, emails, plan, docs, audit, auditB }
}

function semanticOverrides(fixture) {
  const root = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents'
  return {
    [`POST ${root}:batchGet`]: [...fixture.docs.values()].map(found => ({ found, readTime: fsTime })),
    [`POST ${root}/companies/${fixture.ids.companyAId}:runQuery`]: fixture.audit.map(document => ({ document, readTime: fsTime })),
    [`POST ${root}/companies/${fixture.ids.companyBId}:runQuery`]: fixture.auditB.map(document => ({ document, readTime: fsTime })),
  }
}

test('semantic Firestore readback fixes paths and blocks alias, audit/updateTime and replay drift', async () => {
  const fixture = semanticFixture(), overrides = semanticOverrides(fixture)
  const harness = fakeSessionHarness(overrides)
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const adapter = createSemanticFirestoreReadbackAdapter({ session, plan: fixture.plan, state: fixture.ids,
    ownerASubjectSha256: h(fixture.emails.ownerA), ownerBEmailSha256: h(fixture.emails.ownerB) })
  const captured = await adapter.captureFinal()
  assert.equal(captured.readbacks.length, 10); assert.equal(captured.auditEvents.length, 9)
  assert.equal(harness.requests[0].body.documents.length, 18)
  assert.equal(harness.requests.every(row => row.method === 'POST' && row.options.retries === 0), true)
  assert.throws(() => createSemanticFirestoreReadbackAdapter({ session, plan: fixture.plan,
    state: { ...fixture.ids, companyBId: fixture.ids.companyAId }, ownerASubjectSha256: h(fixture.emails.ownerA),
    ownerBEmailSha256: h(fixture.emails.ownerB) }))

  const foreign = semanticFixture(), foreignOverrides = semanticOverrides(foreign)
  foreignOverrides[Object.keys(foreignOverrides)[0]][0].found.name =
    'projects/finapp-staging/databases/(default)/documents/companies/foreign'
  const foreignHarness = fakeSessionHarness(foreignOverrides)
  const foreignSession = await foreignHarness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const foreignAdapter = createSemanticFirestoreReadbackAdapter({ session: foreignSession, plan: foreign.plan, state: foreign.ids,
    ownerASubjectSha256: h(foreign.emails.ownerA), ownerBEmailSha256: h(foreign.emails.ownerB) })
  await assert.rejects(() => foreignAdapter.captureFinal())

  await adapter.captureReplayBefore()
  const finalPath = `invitations/${fixture.ids.mailboxFinalInviteId}`
  overrides[Object.keys(overrides)[0]].find(row => row.found.name.endsWith(finalPath)).found.updateTime = '2026-09-08T12:00:01.123456789Z'
  await assert.rejects(() => adapter.captureReplayAfter())

  const auditDrift = semanticFixture(); auditDrift.audit.pop()
  const driftHarness = fakeSessionHarness(semanticOverrides(auditDrift))
  const driftSession = await driftHarness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const driftAdapter = createSemanticFirestoreReadbackAdapter({ session: driftSession, plan: auditDrift.plan, state: auditDrift.ids,
    ownerASubjectSha256: h(auditDrift.emails.ownerA), ownerBEmailSha256: h(auditDrift.emails.ownerB) })
  await assert.rejects(() => driftAdapter.captureFinal())

  const auditOverflow = semanticFixture()
  auditOverflow.audit.push(fsDoc(`companies/${auditOverflow.ids.companyAId}/audit_events/audit_a_extra`,
    { action: 'unexpected', actorUid: auditOverflow.ids.ownerAUid, targetUid: null, createdAt: fsTime }))
  const overflowHarness = fakeSessionHarness(semanticOverrides(auditOverflow))
  const overflowSession = await overflowHarness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const overflowAdapter = createSemanticFirestoreReadbackAdapter({ session: overflowSession, plan: auditOverflow.plan, state: auditOverflow.ids,
    ownerASubjectSha256: h(auditOverflow.emails.ownerA), ownerBEmailSha256: h(auditOverflow.emails.ownerB) })
  await assert.rejects(() => overflowAdapter.captureFinal())

  const timeDrift = semanticFixture(); timeDrift.audit[0].updateTime = '2026-09-08T11:59:59.123456789Z'
  const timeHarness = fakeSessionHarness(semanticOverrides(timeDrift))
  const timeSession = await timeHarness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const timeAdapter = createSemanticFirestoreReadbackAdapter({ session: timeSession, plan: timeDrift.plan, state: timeDrift.ids,
    ownerASubjectSha256: h(timeDrift.emails.ownerA), ownerBEmailSha256: h(timeDrift.emails.ownerB) })
  await assert.rejects(() => timeAdapter.captureFinal())
})

test('incremental reconciler proves final replay changed no document, updateTime or audit event', async () => {
  const fixture = semanticFixture()
  const root = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents'
  const replayPaths = [
    `invitations/${fixture.ids.mailboxFinalInviteId}`,
    `invitationLocks/${fixture.ids.mailboxLockId}`,
    `companies/${fixture.ids.companyAId}/members/${fixture.ids.ownerMailboxUid}`,
    `users/${fixture.ids.ownerMailboxUid}`,
  ]
  const overrides = {
    [`POST ${root}:batchGet`]: replayPaths.map(path => ({ found: fixture.docs.get(path), readTime: fsTime })),
    [`POST ${root}/companies/${fixture.ids.companyAId}:runQuery`]: fixture.audit.map(document => ({ document, readTime: fsTime })),
    [`POST ${root}/companies/${fixture.ids.companyBId}:runQuery`]: fixture.auditB.map(document => ({ document, readTime: fsTime })),
  }
  const harness = fakeSessionHarness(overrides)
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const reconciler = createIncrementalFirestoreReconciler({ session })
  const state = { ...fixture.ids, companyAId: fixture.ids.companyAId, companyBId: fixture.ids.companyBId,
    mailboxSha256: h(fixture.emails.mailbox), ownerBSubjectSha256: h(fixture.emails.ownerB) }
  const binding = { identity: 'ownerMailbox', actorUid: fixture.ids.ownerMailboxUid,
    invitationId: fixture.ids.mailboxFinalInviteId, capabilitySha256: fixture.ids.mailboxFinalCapabilitySha256 }
  await reconciler.captureBefore({ slot: 'replayMailboxFinalInvite', binding, state })
  const result = await reconciler.reconcile({ slot: 'replayMailboxFinalInvite', binding, state,
    requestSha256: h('replay-request'), outcomeSha256: h('replay-outcome'), sanitized: { disposition: 'SUCCESS' }, produced: {} })
  assert.match(result.readbackSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(reconciler.readReplayProof(), {
    invitationUpdateTimeBefore: fsTime, invitationUpdateTimeAfter: fsTime,
    membershipUpdateTimeBefore: fsTime, membershipUpdateTimeAfter: fsTime,
    profileUpdateTimeBefore: fsTime, profileUpdateTimeAfter: fsTime,
    auditCountBefore: 9, auditCountAfter: 9,
  })

  const overflow = semanticFixture()
  overflow.audit.push(fsDoc(`companies/${overflow.ids.companyAId}/audit_events/audit_a_extra`,
    { action: 'unexpected', actorUid: overflow.ids.ownerAUid, targetUid: null, createdAt: fsTime }))
  const overflowHarness = fakeSessionHarness({
    [`POST ${root}:batchGet`]: replayPaths.map(path => ({ found: overflow.docs.get(path), readTime: fsTime })),
    [`POST ${root}/companies/${overflow.ids.companyAId}:runQuery`]: overflow.audit.map(document => ({ document, readTime: fsTime })),
    [`POST ${root}/companies/${overflow.ids.companyBId}:runQuery`]: overflow.auditB.map(document => ({ document, readTime: fsTime })),
  })
  const overflowSession = await overflowHarness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const overflowReconciler = createIncrementalFirestoreReconciler({ session: overflowSession })
  await overflowReconciler.captureBefore({ slot: 'replayMailboxFinalInvite', binding, state })
  await assert.rejects(() => overflowReconciler.reconcile({ slot: 'replayMailboxFinalInvite', binding, state,
    requestSha256: h('overflow-request'), outcomeSha256: h('overflow-outcome'), sanitized: null, produced: {} }))

  for (const mutation of ['missing-membership', 'malformed-invitation', 'malformed-lock', 'extra-profile-write']) {
    const changed = semanticFixture()
    const responses = replayPaths.map(path => ({ found: changed.docs.get(path), readTime: fsTime }))
    const caseOverrides = {
      [`POST ${root}:batchGet`]: responses,
      [`POST ${root}/companies/${changed.ids.companyAId}:runQuery`]: changed.audit.map(document => ({ document, readTime: fsTime })),
      [`POST ${root}/companies/${changed.ids.companyBId}:runQuery`]: changed.auditB.map(document => ({ document, readTime: fsTime })),
    }
    const caseHarness = fakeSessionHarness(caseOverrides)
    const caseSession = await caseHarness.loader.execute({ approvalValidated: true, localGatesValidated: true })
    const caseReconciler = createIncrementalFirestoreReconciler({ session: caseSession })
    await caseReconciler.captureBefore({ slot: 'replayMailboxFinalInvite', binding, state })
    if (mutation === 'missing-membership') {
      const index = responses.findIndex(row => row.found.name.endsWith(`/members/${fixture.ids.ownerMailboxUid}`))
      responses[index] = { missing: responses[index].found.name, readTime: fsTime }
    } else if (mutation === 'malformed-invitation') {
      const row = responses.find(value => value.found.name.endsWith(`/invitations/${fixture.ids.mailboxFinalInviteId}`))
      delete row.found.fields.acceptedByUid
    } else if (mutation === 'malformed-lock') {
      const row = responses.find(value => value.found.name.endsWith(`/invitationLocks/${fixture.ids.mailboxLockId}`))
      row.found.fields.currentInviteId = fsValue('wrong-invite')
    } else {
      const row = responses.find(value => value.found.name.endsWith(`/users/${fixture.ids.ownerMailboxUid}`))
      row.found.updateTime = '2026-09-08T12:00:01.123456789Z'
    }
    await assert.rejects(() => caseReconciler.reconcile({ slot: 'replayMailboxFinalInvite', binding, state,
      requestSha256: h(`request-${mutation}`), outcomeSha256: h(`outcome-${mutation}`), sanitized: null, produced: {} }), mutation)
  }
})

test('incremental createCompany proves absent pre-state, exact chronology and exact audit identity', async () => {
  const fixture = semanticFixture(), root = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents'
  const companyId = 'company_new', actorUid = fixture.ids.ownerAUid, idempotencyKey = 'idem-new'
  const docs = new Map(), early = '2026-09-08T11:59:59.000000000Z'
  const harness = fakeSessionHarness({
    [`POST ${root}:batchGet`]: ({ body }) => body.documents.map(name => {
      const path = name.slice('projects/finapp-staging/databases/(default)/documents/'.length), found = docs.get(path)
      return found ? { found, readTime: fsTime } : { missing: name, readTime: docs.size ? fsTime : early }
    }),
    [`POST ${root}/companies/${companyId}:runQuery`]: () => [
      { document: fsDoc(`companies/${companyId}/audit_events/audit_created`,
        { action: 'company_created', actorUid, targetUid: null, createdAt: fsTime }), readTime: fsTime },
    ],
  })
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const reconciler = createIncrementalFirestoreReconciler({ session })
  const state = { ownerASubjectSha256: h(fixture.emails.ownerA), ownerBSubjectSha256: h(fixture.emails.ownerB) }
  const binding = { identity: 'ownerA', actorUid, idempotencyKeySha256: h(idempotencyKey) }
  await reconciler.captureBefore({ slot: 'createCompanyA', binding, state })
  docs.set(`companies/${companyId}`, fsDoc(`companies/${companyId}`, {
    id: companyId, name: 'Company', legalType: 'ooo', currency: 'RUB', createdAt: now, ownerId: actorUid,
  }))
  docs.set(`company_data/${companyId}`, fsDoc(`company_data/${companyId}`,
    { accounts: [], categories: [], counterparties: [], transactions: [], projects: [], rules: [] }))
  docs.set(`companies/${companyId}/members/${actorUid}`, fsDoc(`companies/${companyId}/members/${actorUid}`,
    { uid: actorUid, role: 'admin', status: 'active', createdAt: fsTime, updatedAt: fsTime }))
  docs.set(`users/${actorUid}`, fsDoc(`users/${actorUid}`, {
    id: actorUid, name: 'Owner', email: fixture.emails.ownerA, role: 'admin', companyId, createdAt: now,
  }))
  docs.set(`user_bootstrap/${actorUid}`, fsDoc(`user_bootstrap/${actorUid}`, {
    idempotencyKey, fingerprint: h('fingerprint'), result: { companyId }, createdAt: fsTime,
  }))
  const result = await reconciler.reconcile({ slot: 'createCompanyA', binding, state,
    requestSha256: h('company-request'), outcomeSha256: h('company-outcome'), sanitized: { companyId }, produced: { companyAId: companyId } })
  assert.match(result.readbackSha256, /^[a-f0-9]{64}$/)
})

test('incremental denial snapshots its invitation lock and audit checkpoint rejects an inter-slot event', async () => {
  const fixture = semanticFixture(), root = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents'
  const finalPath = `invitations/${fixture.ids.mailboxFinalInviteId}`
  fixture.docs.set(finalPath, fsDoc(finalPath, { companyId: fixture.ids.companyAId, emailNormalized: fixture.emails.mailbox,
    role: 'accountant', tokenHash: fixture.ids.mailboxFinalCapabilitySha256, status: 'pending', expiresAt: fsTime,
    createdBy: fixture.ids.ownerAUid, createdAt: fsTime, updatedAt: fsTime, resendCount: 1, lastSentAt: fsTime }))
  fixture.docs.delete(`companies/${fixture.ids.companyAId}/members/${fixture.ids.ownerBUid}`)
  fixture.audit = fixture.audit.slice(0, 5)
  const overrides = {
    [`POST ${root}:batchGet`]: ({ body }) => body.documents.map(name => {
      const path = name.slice('projects/finapp-staging/databases/(default)/documents/'.length), found = fixture.docs.get(path)
      return found ? { found, readTime: fsTime } : { missing: name, readTime: fsTime }
    }),
    [`POST ${root}/companies/${fixture.ids.companyAId}:runQuery`]: () => fixture.audit.map(document => ({ document, readTime: fsTime })),
  }
  const harness = fakeSessionHarness(overrides), session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const reconciler = createIncrementalFirestoreReconciler({ session }), state = {
    ...fixture.ids, mailboxSha256: h(fixture.emails.mailbox), ownerBSubjectSha256: h(fixture.emails.ownerB),
  }
  const denial = { identity: 'ownerB', actorUid: fixture.ids.ownerBUid, invitationId: fixture.ids.mailboxFinalInviteId,
    capabilitySha256: fixture.ids.mailboxFinalCapabilitySha256 }
  await reconciler.captureBefore({ slot: 'denyWrongIdentityAccept', binding: denial, state })
  await reconciler.reconcile({ slot: 'denyWrongIdentityAccept', binding: denial, state,
    requestSha256: h('deny-request'), outcomeSha256: h('deny-outcome'), sanitized: { code: 'invite_invalid' }, produced: {} })
  fixture.audit.push(fsDoc(`companies/${fixture.ids.companyAId}/audit_events/unexpected`,
    { action: 'unexpected', actorUid: fixture.ids.ownerAUid, targetUid: null, createdAt: fsTime }))
  await assert.rejects(() => reconciler.captureBefore({ slot: 'ownerBCompanyARecovery',
    binding: { identity: 'ownerB', actorUid: fixture.ids.ownerBUid, companyId: fixture.ids.companyAId, expectation: 'ALLOWED_VIEWER' }, state }))
})

test('safe stop closes browser and transport without cleanup capability', async () => {
  const calls = []
  const stop = createSafeStopTeardown({ browser: { close: async () => calls.push('browser') }, transport: { close: async () => calls.push('transport') } })
  assert.deepEqual(await stop.close(), { browserClosed: true, transportClosed: true, cleanupPerformed: false })
  assert.deepEqual(calls.sort(), ['browser', 'transport'])
  await stop.close(); assert.equal(calls.length, 2)
  assert.equal('cleanup' in stop, false)
})

test('live composition orders concrete stages and safe-stops with fake-only dependencies', async () => {
  const fixture = semanticFixture(), calls = []
  const journal = { append() {}, bytes: () => Buffer.alloc(0), events: () => [],
    close: () => { calls.push('journal.close'); return { journalSha256: h('journal'), eventCount: 50 } } }
  const scenario = {
    scenarios: ['one', 'two', 'three', 'four', 'five', 'six'].map(name => ({ name, status: 'PASS' })),
    materializeFixturePlan: () => { calls.push('materialize'); return fixture.plan },
    readSemanticState: () => fixture.ids,
    readReplayProof: () => ({ invitationUpdateTimeBefore: fsTime, invitationUpdateTimeAfter: fsTime,
      membershipUpdateTimeBefore: fsTime, membershipUpdateTimeAfter: fsTime, profileUpdateTimeBefore: fsTime,
      profileUpdateTimeAfter: fsTime, auditCountBefore: 9, auditCountAfter: 9 }),
    readCallableCounts: () => ({ createCompany: 2, inviteMember: 3, listInvitations: 3, cancelInvite: 1,
      resendInvite: 2, previewInvite: 4, acceptInvite: 5, getCompanyAccess: 7 }),
    readTransportCounts: () => ({ authorizedRequests: 27, dispatchedRequests: 27, oauthRefreshes: 0, verificationDispatches: 1 }),
    verifyAcceptance: () => ({ observationsSha256: h('observations') }),
    buildCleanupPlanOnly: () => ({ status: 'CLEANUP_PLAN_ONLY', executionEnabled: false, cleanupPerformed: false,
      cleanupPlanSha256: h('cleanup'), targets: {} }),
  }
  const stages = {
    openLoopback: async () => { calls.push('loopback.open'); return { receipt: { sourceHead: 'a'.repeat(40) }, close: async () => calls.push('loopback.close') } },
    openProvider: async () => { calls.push('provider.open'); return { session: { opaque: true },
      transport: { close: async () => calls.push('transport.close') }, close: async () => calls.push('provider.close') } },
    createJournal: async () => { calls.push('journal.open'); return journal },
    openPlaywright: async () => { calls.push('playwright.open'); return { browser: { close: async () => calls.push('browser.close') },
      close: async () => calls.push('playwright.close') } },
    runScenarios: async ({ loopbackReceipt }) => {
      assert.deepEqual(loopbackReceipt, { sourceHead: 'a'.repeat(40) })
      calls.push('scenarios'); return scenario
    },
    createSemanticReadback: async () => ({ captureFinal: async () => { calls.push('semantic'); return {
      readbacks: Array.from({ length: 10 }, (_, index) => ({ check: String(index), stateSha256: h(String(index)), updateTime: fsTime })),
      auditEvents: Array.from({ length: 9 }, (_, index) => ({ slot: String(index), company: 'a', id: `id${index}`,
        stateSha256: h(`audit${index}`), createTime: fsTime, updateTime: fsTime })),
      replay: { invitationUpdateTime: fsTime, membershipUpdateTime: fsTime, profileUpdateTime: fsTime, auditCount: 9 },
      fullStateSha256: h('full') } } }),
    writeOutput: async ({ value }) => { calls.push('output'); assert.equal(value.cleanupPerformed, false) },
  }
  const result = await runLiveAcceptanceComposition({ context: { sourceHead: 'a'.repeat(40),
    journalPath: 'D:\\private\\journal.jsonl', outputPath: 'D:\\private\\out.json' }, stages,
  now: (() => { const values = ['2026-09-08T12:00:00.000Z', '2026-09-08T12:01:00.000Z']; return () => values.shift() })() })
  assert.equal(result.status, 'LIVE_ACCEPTANCE_VERIFIED')
  assert.deepEqual(calls, ['loopback.open', 'provider.open', 'journal.open', 'playwright.open', 'scenarios', 'materialize',
    'semantic', 'playwright.close', 'provider.close', 'loopback.close', 'journal.close', 'output'])
  assert.equal(JSON.stringify(result).includes('@'), false)

  const failedCalls = []
  await assert.rejects(() => runLiveAcceptanceComposition({ context: { sourceHead: 'a'.repeat(40),
    journalPath: 'D:\\private\\journal2.jsonl', outputPath: 'D:\\private\\out2.json' }, stages: {
    ...stages,
    openLoopback: async () => ({ receipt: {}, close: async () => failedCalls.push('loopback.close') }),
    openProvider: async () => ({ session: {}, transport: { close: async () => {} }, close: async () => failedCalls.push('provider.close') }),
    createJournal: async () => journal,
    openPlaywright: async () => ({ browser: { close: async () => {} }, close: async () => failedCalls.push('playwright.close') }),
    runScenarios: async () => { throw new Error('synthetic failure') },
    writeOutput: async () => failedCalls.push('output'),
  } }))
  assert.deepEqual(failedCalls, ['playwright.close', 'provider.close', 'loopback.close'])
})
