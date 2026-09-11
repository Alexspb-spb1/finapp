import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  buildPrivateLiveRecoveryManifest, createCallableDispatchPrimitive, createFirebaseReadOnlyPreflightAdapters,
  createGuardedFirebaseToolsSessionLoader, createSafeStopTeardown,
  createIncrementalFirestoreReconciler,
  createSemanticFirestoreReadbackAdapter, createSyntheticVerifiedAuthAdapter,
  discoverFirebaseAuthTemplateMetadata,
  LIVE_EXECUTOR_MISSING_ADAPTERS, runLiveAcceptanceComposition,
} from './liveAcceptanceExecutorAdapters.mjs'
import { appendJournalEvent, buildFixturePlan, CALLABLE_CAPS, FIXTURE_MUTATION_SLOT_SPECS, SCENARIO_NAMES } from './liveAcceptanceCore.mjs'
import {
  ACTIVE_RULES_SHA256, FIELD_OVERRIDES_SHA256, LIVE_FUNCTIONS, READ_ONLY_SLOT_SPECS,
  createLiveStagingExecutor, createVisibleOwnerHandoff,
} from './liveAcceptanceExecutorCore.mjs'
import { LIVE_PLAYWRIGHT_UI_STEPS } from './liveAcceptancePlaywrightCore.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const now = '2026-09-08T12:00:00.000Z'
const callables = ['acceptInvite', 'cancelInvite', 'createCompany', 'getCompanyAccess', 'inviteMember', 'listInvitations', 'previewInvite', 'resendInvite']
const privatePath = name => path.resolve(path.parse(path.resolve('.')).root, 'private', name)

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

function memoryRecoveryCheckpoint(callLog = []) {
  let events = [], closed = false
  return {
    append(kind, payload) {
      if (closed) throw new Error('closed')
      events.push({ kind, payload: structuredClone(payload) }); callLog.push(`recovery.${kind}`)
      return { seq: events.length - 1, kind, eventSha256: h(JSON.stringify(events.at(-1))) }
    },
    bytes() { if (closed) throw new Error('closed'); return Buffer.from(events.map(row => JSON.stringify(row)).join('\n') + '\n') },
    events() { if (closed) throw new Error('closed'); return structuredClone(events) },
    inspect() { return structuredClone(events) },
    close() {
      if (closed) throw new Error('closed')
      const bytes = this.bytes(); closed = true; callLog.push('recovery.close')
      return { checkpointSha256: h(bytes), eventCount: events.length, lastKind: events.at(-1).kind,
        lastEventSha256: h(JSON.stringify(events.at(-1))) }
    },
  }
}

function fakeSessionHarness(overrides = {}, authOptions = {}) {
  let loads = 0, authorizations = 0, accessTokenCalls = 0, accessTokenRefreshes = 0, accessTokenSets = 0
  let cachedAccessToken = ''
  const requests = []
  const refreshToken = authOptions.refreshToken ?? 'opaque-refresh'
  const getAccessToken = async () => {
    accessTokenCalls++
    if (cachedAccessToken) return cachedAccessToken
    accessTokenRefreshes++
    if (authOptions.accessTokenError) throw authOptions.accessTokenError
    return Object.hasOwn(authOptions, 'accessToken') ? authOptions.accessToken : 'opaque-access'
  }
  const setAccessToken = value => {
    accessTokenSets++
    cachedAccessToken = value
  }
  class Client {
    constructor({ urlPrefix, auth }) { this.origin = urlPrefix; assert.equal(auth, true) }
    async get(path, requestOptions) {
      if (authOptions.simulateClientAuth) await getAccessToken()
      requests.push({ method: 'GET', url: `${this.origin}${path}`, options: structuredClone(requestOptions) })
      const key = `GET ${this.origin}${path}`
      if (Object.hasOwn(overrides, key)) {
        const value = typeof overrides[key] === 'function' ? await overrides[key]({ path, requestOptions }) : overrides[key]
        if (value instanceof Error) throw value
        return { body: structuredClone(value) }
      }
      throw Object.assign(new Error('unexpected fake request'), { status: 599 })
    }
    async post(path, body, requestOptions) {
      if (authOptions.simulateClientAuth) await getAccessToken()
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
    'auth.js': { getGlobalDefaultAccount: () => ({ user: { email: 'operator@example.invalid' }, tokens: { refresh_token: refreshToken } }) },
    'requireAuth.js': { requireAuth: async options => {
      authorizations++
      assert.equal(options.project, 'finapp-staging')
      return true
    } },
    'apiv2.js': { Client, getAccessToken, setAccessToken },
  }
  const loader = createGuardedFirebaseToolsSessionLoader({
    repoRoot: path.resolve('.'),
    env: Object.hasOwn(authOptions, 'env') ? authOptions.env : {},
    loadModule: name => { loads++; return modules[name] },
  })
  return {
    loader, requests,
    loads: () => loads, authorizations: () => authorizations,
    accessTokenCalls: () => accessTokenCalls, accessTokenRefreshes: () => accessTokenRefreshes,
    accessTokenSets: () => accessTokenSets,
  }
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
  assert.equal(harness.accessTokenCalls(), 1)
  assert.equal(harness.accessTokenRefreshes(), 1)
  assert.equal(harness.accessTokenSets(), 1)
  assert.equal(harness.requests.length, 0)
  await assert.rejects(() => harness.loader.execute({ approvalValidated: true, localGatesValidated: true }))
})

test('unsafe environment is rejected case-insensitively before credentials or provider access', async t => {
  const dangerousKeys = [
    'FIREBASE_TOKEN', 'FIREBASE_CLIENT_ID', 'FIREBASE_CLIENT_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS',
    'DEBUG', 'NODE_DEBUG', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'IS_FIREBASE_CLI',
    'IS_FIREBASE_MCP', 'MONOSPACE_ENV', 'CUSTOM_EMULATOR_HOST', 'FIREBASE_TOKEN_URL',
    'FIREBASE_GOOGLE_URL', 'FIREBASE_CUSTOM_URL', 'FIREBASE_CUSTOM_ORIGIN', 'GOOGLE_CLOUD_QUOTA_PROJECT',
  ]
  const mixedCase = value => [...value].map((character, index) =>
    /[a-z]/i.test(character) && index % 2 ? character.toLowerCase() : character.toUpperCase()).join('')
  const styles = [['upper', value => value], ['mixed', mixedCase], ['lower', value => value.toLowerCase()]]
  for (const baseKey of dangerousKeys) {
    for (const [style, transform] of styles) {
      await t.test(`${baseKey} ${style}`, async () => {
        const key = transform(baseKey)
        const value = baseKey === 'GOOGLE_CLOUD_QUOTA_PROJECT' ? 'foreign-project' : 'unsafe-value'
        const harness = fakeSessionHarness({}, { env: { [key]: value } })
        await assert.rejects(
          () => harness.loader.execute({ approvalValidated: true, localGatesValidated: true }),
          error => error?.message === 'live_executor_adapters_blocked',
        )
        assert.equal(harness.loads(), 0)
        assert.equal(harness.authorizations(), 0)
        assert.equal(harness.accessTokenCalls(), 0)
        assert.equal(harness.accessTokenSets(), 0)
        assert.equal(harness.requests.length, 0)
        await assert.rejects(() => harness.loader.execute({ approvalValidated: true, localGatesValidated: true }))
        assert.equal(harness.loads(), 0)
        assert.equal(harness.authorizations(), 0)
        assert.equal(harness.accessTokenCalls(), 0)
        assert.equal(harness.accessTokenSets(), 0)
        assert.equal(harness.requests.length, 0)
      })
    }
  }
})

test('exact staging quota project is allowed in every Windows key casing', async t => {
  for (const key of ['GOOGLE_CLOUD_QUOTA_PROJECT', 'GoOgLe_ClOuD_QuOtA_PrOjEcT', 'google_cloud_quota_project']) {
    await t.test(key, async () => {
      const harness = fakeSessionHarness({}, { env: { [key]: 'finapp-staging' } })
      assert.deepEqual(await harness.loader.execute({ approvalValidated: true, localGatesValidated: true }), {
        project: 'finapp-staging', authenticated: true,
      })
      assert.equal(harness.loads(), 4)
      assert.equal(harness.accessTokenCalls(), 1)
      assert.equal(harness.requests.length, 0)
    })
  }
})

test('access-token preflight fails closed without leaking OAuth errors or attempting provider GETs', async () => {
  const secretCanary = 'oauth-secret-canary-do-not-expose'
  const harness = fakeSessionHarness({}, { accessTokenError: new Error(`HTTP 400 ${secretCanary}`) })
  await assert.rejects(
    () => harness.loader.execute({ approvalValidated: true, localGatesValidated: true }),
    error => error?.message === 'live_executor_adapters_blocked' && !String(error).includes(secretCanary),
  )
  assert.equal(harness.authorizations(), 1)
  assert.equal(harness.accessTokenCalls(), 1)
  assert.equal(harness.accessTokenRefreshes(), 1)
  assert.equal(harness.accessTokenSets(), 0)
  assert.equal(harness.requests.length, 0)
  await assert.rejects(() => harness.loader.execute({ approvalValidated: true, localGatesValidated: true }))
  assert.equal(harness.accessTokenCalls(), 1)
})

test('access-token preflight rejects malformed, oversized and refresh-token values', async t => {
  const cases = [
    ['empty', ''],
    ['non-string', { access_token: 'opaque-access' }],
    ['leading whitespace', ' opaque-access'],
    ['trailing whitespace', 'opaque-access '],
    ['embedded whitespace', 'opaque access'],
    ['control character', 'opaque\naccess'],
    ['oversized', 'a'.repeat(16_385)],
    ['refresh-token', 'opaque-refresh'],
  ]
  for (const [name, accessToken] of cases) {
    await t.test(name, async () => {
      const harness = fakeSessionHarness({}, { accessToken })
      await assert.rejects(
        () => harness.loader.execute({ approvalValidated: true, localGatesValidated: true }),
        error => error?.message === 'live_executor_adapters_blocked',
      )
      assert.equal(harness.accessTokenCalls(), 1)
      assert.equal(harness.accessTokenSets(), 0)
      assert.equal(harness.requests.length, 0)
    })
  }
})

test('cached access token prevents another refresh during parallel authenticated requests', async () => {
  const projectUrl = 'https://firebase.googleapis.com/v1beta1/projects/finapp-staging'
  const billingUrl = 'https://cloudbilling.googleapis.com/v1/projects/finapp-staging/billingInfo'
  const databaseUrl = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)'
  const releaseUrl = 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/releases/cloud.firestore'
  const rulesetUrl = 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/rulesets/rules-1'
  const harness = fakeSessionHarness({
    [`GET ${projectUrl}`]: { projectId: 'finapp-staging', projectNumber: '123456789' },
    [`GET ${billingUrl}`]: { projectId: 'finapp-staging', billingEnabled: true },
    [`GET ${databaseUrl}`]: { name: 'projects/finapp-staging/databases/(default)', locationId: 'eur3', type: 'FIRESTORE_NATIVE' },
    [`GET ${releaseUrl}`]: { name: 'projects/finapp-staging/releases/cloud.firestore', rulesetName: 'projects/finapp-staging/rulesets/rules-1' },
    [`GET ${rulesetUrl}`]: { name: 'projects/finapp-staging/rulesets/rules-1', source: { files: [{ content: 'rules' }] } },
  }, { simulateClientAuth: true })
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const adapters = createFirebaseReadOnlyPreflightAdapters({
    session, sourceHead: 'a'.repeat(40), mailbox: 'owner@example.invalid', expectedAuthMetadataSha256: h('auth'),
    stagingBuildProbe: async () => ({ sourceHead: 'a'.repeat(40), stagingFingerprint: h('build'), servedFrom: 'http://127.0.0.1:5177', sixFieldsVerified: true }),
  })
  await Promise.all([adapters.project(), adapters.rules()])
  assert.equal(harness.requests.length, 5)
  assert.equal(harness.accessTokenCalls(), 6)
  assert.equal(harness.accessTokenRefreshes(), 1)
  assert.equal(harness.accessTokenSets(), 1)
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

test('indexes adapter uses canonical initial and paginated query shapes without pageSize', async () => {
  const indexesUrl = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/collectionGroups/-/indexes'
  const fieldsUrl = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/collectionGroups/-/fields'
  const filter = 'indexConfig.usesAncestorConfig=false OR ttlConfig:*'
  const invitationIndex = {
    name: 'projects/finapp-staging/databases/(default)/collectionGroups/invitations/indexes/index-1',
    state: 'READY', queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'companyId', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' },
    ],
  }
  const field = { name: 'projects/finapp-staging/databases/(default)/collectionGroups/one/fields/two' }
  let indexPage = 0, fieldPage = 0
  const rejectPageSize = requestOptions => {
    if (Object.hasOwn(requestOptions.queryParams, 'pageSize')) {
      throw Object.assign(new Error('pageSize rejected by fake Firestore Admin'), { status: 400 })
    }
  }
  const harness = fakeSessionHarness({
    [`GET ${indexesUrl}`]: ({ requestOptions }) => {
      rejectPageSize(requestOptions)
      indexPage++
      return indexPage === 1 ? { indexes: [invitationIndex], nextPageToken: 'indexes-next' } : {}
    },
    [`GET ${fieldsUrl}`]: ({ requestOptions }) => {
      rejectPageSize(requestOptions)
      fieldPage++
      return fieldPage === 1 ? { fields: [field], nextPageToken: 'fields-next' } : {}
    },
  })
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const adapters = createFirebaseReadOnlyPreflightAdapters({
    session, sourceHead: 'a'.repeat(40), mailbox: 'owner@example.invalid', expectedAuthMetadataSha256: h('auth'),
    stagingBuildProbe: async () => ({ sourceHead: 'a'.repeat(40), stagingFingerprint: h('build'), servedFrom: 'http://127.0.0.1:5177', sixFieldsVerified: true }),
    now: () => now,
  })
  const result = await adapters.indexes()
  assert.deepEqual(result, {
    invitationIndexState: 'READY', fieldOverrideCount: 1,
    fieldOverridesSha256: h(JSON.stringify([field])), observedAt: now,
  })
  assert.deepEqual(harness.requests.map(row => [row.url, row.options.queryParams]), [
    [indexesUrl, {}],
    [indexesUrl, { pageToken: 'indexes-next' }],
    [fieldsUrl, { filter }],
    [fieldsUrl, { filter, pageToken: 'fields-next' }],
  ])
  assert.equal(JSON.stringify(result).includes('indexes-next'), false)
  assert.equal(JSON.stringify(result).includes(field.name), false)
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
  const acknowledgement = { kind: 'identitytoolkit#SignupNewUserResponse', localId: ownerA.uid, email: ownerA.email }
  const lookupAccount = { localId: ownerA.uid, email: ownerA.email, emailVerified: true, disabled: false }
  const harness = fakeSessionHarness({ [`POST ${createUrl}`]: acknowledgement, [`POST ${lookupUrl}`]: { users: [lookupAccount] } })
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const adapter = createSyntheticVerifiedAuthAdapter({ session, runId, accounts: { ownerA, ownerB } })
  const subjectSha256 = h(ownerA.email)
  const operation = adapter.slot('ownerA', subjectSha256)
  const permit = { slot: 'createOwnerAAuth', requestSha256: operation.requestSha256,
    journalBytes: journalBytes(operation.requestSha256) }
  const dispatched = await operation.dispatch(permit)
  assert.equal(dispatched.outcomeSha256, h(JSON.stringify({ uidSha256: h(ownerA.uid), createAcknowledged: true })))
  const readback = await operation.readback()
  assert.deepEqual(readback.produced, { ownerAUid: ownerA.uid })
  assert.deepEqual(harness.requests.map(row => [row.method, row.url]), [['POST', createUrl], ['POST', lookupUrl]])
  assert.equal(harness.requests[0].body.emailVerified, true)
  assert.equal(harness.requests[0].body.disableUser, false)
  assert.equal(harness.requests[0].options.retries, 0)
  await assert.rejects(() => operation.dispatch({ ...permit, requestSha256: h('drift') }))
})

async function syntheticAuthCase({ runId, createResponse, lookupResponse }) {
  const ownerA = { uid: `${runId}-ownerA`, email: `${runId}.ownera@example.invalid`, password: 'long-random-password-A1!' }
  const ownerB = { uid: `${runId}-ownerB`, email: `${runId}.ownerb@example.invalid`, password: 'different-random-B2!' }
  const createUrl = 'https://identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts'
  const lookupUrl = `${createUrl}:lookup`
  const resolve = value => typeof value === 'function' ? value(ownerA) : value
  const harness = fakeSessionHarness({ [`POST ${createUrl}`]: resolve(createResponse), [`POST ${lookupUrl}`]: resolve(lookupResponse) })
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const adapter = createSyntheticVerifiedAuthAdapter({ session, runId, accounts: { ownerA, ownerB } })
  const operation = adapter.slot('ownerA', h(ownerA.email))
  const permit = { slot: 'createOwnerAAuth', requestSha256: operation.requestSha256,
    journalBytes: journalBytes(operation.requestSha256) }
  return { ownerA, harness, operation, permit, createUrl, lookupUrl }
}

const signUpAcknowledgement = owner => ({
  kind: 'identitytoolkit#SignupNewUserResponse', localId: owner.uid, email: owner.email,
})

test('synthetic Admin Auth create acknowledgement accepts SignUpResponse but rejects credential-bearing or mismatched responses', async () => {
  const valid = await syntheticAuthCase({ runId: 'stage8-ack-valid',
    createResponse: signUpAcknowledgement,
    lookupResponse: owner => ({ users: [{ localId: owner.uid, email: owner.email, emailVerified: true }] }) })
  await valid.operation.dispatch(valid.permit)
  assert.deepEqual((await valid.operation.readback()).produced, { ownerAUid: valid.ownerA.uid })

  const invalidResponses = [
    owner => ({ localId: owner.uid, email: owner.email }),
    owner => ({ kind: 'identitytoolkit#WrongResponse', localId: owner.uid, email: owner.email }),
    owner => ({ ...signUpAcknowledgement(owner), localId: `${owner.uid}-drift` }),
    owner => ({ ...signUpAcknowledgement(owner), email: `drift.${owner.email}` }),
    owner => ({ ...signUpAcknowledgement(owner), admin: true }),
    owner => ({ ...signUpAcknowledgement(owner), idToken: 'provider-token-canary' }),
    owner => ({ ...signUpAcknowledgement(owner), refreshToken: 'provider-token-canary' }),
    owner => ({ ...signUpAcknowledgement(owner), expiresIn: '3600' }),
    owner => ({ ...signUpAcknowledgement(owner), ExpiresIn: 'case-variant-canary' }),
    owner => ({ ...signUpAcknowledgement(owner), passwordHash: 'provider-password-canary' }),
    owner => ({ ...signUpAcknowledgement(owner), metadata: { idToken: 'nested-provider-token-canary' } }),
  ]
  for (let index = 0; index < invalidResponses.length; index++) {
    const current = await syntheticAuthCase({ runId: `stage8-ack-bad-${index}`,
      createResponse: invalidResponses[index], lookupResponse: { users: [] } })
    await assert.rejects(() => current.operation.dispatch(current.permit))
    assert.deepEqual(current.harness.requests.map(row => row.url), [current.createUrl])
    assert.equal(/provider-token-canary|provider-password-canary|case-variant-canary/.test(JSON.stringify(current.permit)), false)
  }
})

test('synthetic Admin Auth lookup strictly requires verified identity and omitted or false disabled', async () => {
  const validLookup = owner => ({ localId: owner.uid, email: owner.email, emailVerified: true })
  const invalidLookups = [
    owner => ({ localId: `${owner.uid}-drift`, email: owner.email, emailVerified: true }),
    owner => ({ localId: owner.uid, email: `drift.${owner.email}`, emailVerified: true }),
    owner => ({ localId: owner.uid, email: owner.email }),
    owner => ({ localId: owner.uid, email: owner.email, emailVerified: false }),
    ...[null, 'true', 1, {}].map(emailVerified => owner => ({
      localId: owner.uid, email: owner.email, emailVerified,
    })),
    ...[null, 'false', 0, {}, true].map(disabled => owner => ({
      localId: owner.uid, email: owner.email, emailVerified: true, disabled,
    })),
  ]
  for (let index = 0; index < invalidLookups.length; index++) {
    const current = await syntheticAuthCase({ runId: `stage8-lookup-bad-${index}`,
      createResponse: signUpAcknowledgement,
      lookupResponse: owner => ({ users: [invalidLookups[index](owner)] }) })
    await current.operation.dispatch(current.permit)
    await assert.rejects(() => current.operation.readback())
    assert.deepEqual(current.harness.requests.map(row => row.url), [current.createUrl, current.lookupUrl])
  }

  const invalidEnvelopes = [() => ({}), () => ({ users: null }), () => ({ users: [] }),
    owner => ({ users: [validLookup(owner), validLookup(owner)] })]
  for (let index = 0; index < invalidEnvelopes.length; index++) {
    const current = await syntheticAuthCase({ runId: `stage8-lookup-envelope-${index}`,
      createResponse: signUpAcknowledgement, lookupResponse: invalidEnvelopes[index] })
    await current.operation.dispatch(current.permit)
    await assert.rejects(() => current.operation.readback())
    assert.deepEqual(current.harness.requests.map(row => row.url), [current.createUrl, current.lookupUrl])
  }

  for (const disabled of [undefined, false]) {
    const current = await syntheticAuthCase({ runId: disabled === undefined ? 'stage8-lookup-omitted' : 'stage8-lookup-false',
      createResponse: signUpAcknowledgement,
      lookupResponse: owner => ({ users: [{ ...validLookup(owner), ...(disabled === undefined ? {} : { disabled }) }] }) })
    await current.operation.dispatch(current.permit)
    assert.deepEqual((await current.operation.readback()).produced, { ownerAUid: current.ownerA.uid })
  }
})

function inMemoryLiveJournal() {
  let events = []
  return {
    append(status, details = {}) {
      events = appendJournalEvent(events, { seq: events.length, status, at: now, details })
      return events.at(-1)
    },
    bytes: () => Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')),
    events: () => structuredClone(events),
  }
}

function firstSlotExecutor(journal, runId, ownerAEmail) {
  const sourceHead = 'a'.repeat(40)
  const preflight = trackedPreflight({ emails: { mailbox: 'mailbox@example.invalid' } }, sourceHead)
  return createLiveStagingExecutor({ journal, preflightAdapters: preflight.adapters, expectedPreflight: preflight.expected,
    initial: { runId, mailboxSha256: preflight.expected.mailboxSha256,
      ownerASubjectSha256: h(ownerAEmail), ownerBSubjectSha256: h(`${runId}.ownerb@example.invalid`) },
    nowMs: () => Date.parse(now) })
}

test('real SignUpResponse acknowledgement lets the executor reconcile createOwnerAAuth', async () => {
  const current = await syntheticAuthCase({ runId: 'stage8-executor-pass',
    createResponse: signUpAcknowledgement,
    lookupResponse: owner => ({ users: [{ localId: owner.uid, email: owner.email, emailVerified: true }] }) })
  const journal = inMemoryLiveJournal()
  const executor = firstSlotExecutor(journal, 'stage8-executor-pass', current.ownerA.email)
  await executor.start()
  await executor.executeFixtureSlot({ slot: 'createOwnerAAuth', requestSha256: current.operation.requestSha256,
    binding: current.operation.binding, dispatch: current.operation.dispatch, readback: current.operation.readback })
  assert.equal(journal.events().at(-1).status, 'FIXTURE_MUTATION_RECONCILED')
  assert.equal(executor.snapshot().nextSlot, 1)
  assert.equal(executor.snapshot().state.ownerAUid, current.ownerA.uid)
})

test('rejected create acknowledgement produces deterministic uncertain recovery without lookup or canary leakage', async () => {
  const cases = [
    owner => ({ ...signUpAcknowledgement(owner), idToken: 'provider-token-canary' }),
    owner => ({ ...signUpAcknowledgement(owner), metadata: { idToken: 'nested-provider-token-canary' } }),
  ]
  for (let index = 0; index < cases.length; index++) {
    const runId = `stage8-executor-bad-${index}`
    const current = await syntheticAuthCase({ runId, createResponse: cases[index], lookupResponse: { users: [] } })
    const journal = inMemoryLiveJournal()
    const executor = firstSlotExecutor(journal, runId, current.ownerA.email)
    await executor.start()
    await assert.rejects(() => executor.executeFixtureSlot({ slot: 'createOwnerAAuth',
      requestSha256: current.operation.requestSha256, binding: current.operation.binding,
      dispatch: current.operation.dispatch, readback: current.operation.readback }))
    const events = journal.events()
    assert.deepEqual(events.slice(-2).map(event => event.status), ['FIXTURE_MUTATION_UNCERTAIN', 'FAILED'])
    assert.equal(events.at(-2).details.outcomeSha256,
      h(`uncertain:createOwnerAAuth:${current.operation.requestSha256}`))
    assert.equal(events.at(-1).details.failureCode, 'FIXTURE_MUTATION_UNCERTAIN')
    assert.equal(executor.snapshot().nextSlot, 0)
    assert.equal(executor.snapshot().state.ownerAUid, null)
    assert.deepEqual(current.harness.requests.map(row => row.url), [current.createUrl])
    assert.equal(/provider-token-canary/.test(JSON.stringify(events)), false)
  }
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

test('held admin callables return exact sanitized Playwright shapes and retain capability only in the vault', async () => {
  const primitive = createCallableDispatchPrimitive({ transport: {
    authorizeRequest() {}, async fetch() { throw new Error('unused') },
  }, getIdToken: async () => { throw new Error('unused') } })
  const rawToken = 'T'.repeat(43), invitationRequest = h('held-invitation')
  const invited = await primitive.summarizeHeld('inviteMember', {
    status: () => 200,
    json: async () => ({ result: { inviteId: 'invite_cancelled', token: rawToken, expiresAtUtc: now } }),
  }, { requestSha256: invitationRequest })
  assert.deepEqual(Object.keys(invited).sort(), ['outcomeSha256', 'requestSha256', 'sanitized'])
  assert.deepEqual(invited.sanitized, { disposition: 'SUCCESS', inviteId: 'invite_cancelled',
    capabilitySha256: h(rawToken), expiresAtUtc: now })
  assert.equal(JSON.stringify(invited).includes(rawToken), false)
  assert.deepEqual(await primitive.withCapability(h(rawToken), async value => ({ completed: value === rawToken })), { completed: true })

  const listed = await primitive.summarizeHeld('listInvitations', {
    status: () => 200,
    json: async () => ({ result: { items: [{ inviteId: 'invite_cancelled', emailNormalized: 'mailbox@example.invalid',
      role: 'accountant', status: 'pending', createdAtUtc: now, expiresAtUtc: now, resendCount: 0,
      lastSentAtUtc: now, createdBy: 'uid_owner_a' }], nextCursor: null } }),
  }, { requestSha256: h('held-list') })
  assert.deepEqual(Object.keys(listed).sort(), ['outcomeSha256', 'requestSha256', 'sanitized'])
  assert.deepEqual(listed.sanitized, { disposition: 'SUCCESS', itemCount: 1,
    itemsSha256: h(JSON.stringify([{ inviteId: 'invite_cancelled', emailNormalized: 'mailbox@example.invalid',
      role: 'accountant', status: 'pending', createdAtUtc: now, expiresAtUtc: now, resendCount: 0,
      lastSentAtUtc: now, createdBy: 'uid_owner_a' }])), nextCursorPresent: false })
  assert.equal(JSON.stringify(listed).includes('mailbox@example.invalid'), false)

  const access = await primitive.summarizeHeld('getCompanyAccess', {
    status: () => 200, json: async () => ({ result: { companyId: 'company_a', uid: 'uid_owner_a', role: 'admin' } }),
  }, { requestSha256: h('held-access') })
  assert.deepEqual(Object.keys(access).sort(), ['outcomeSha256', 'producedSha256', 'requestSha256'])
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
  assert.equal(captured.recoveryResources.length, 27)
  assert.equal(new Set(captured.recoveryResources.map(row => row.path)).size, 27)
  assert.equal(captured.recoveryResources.every(row => row.exists === true && row.createTime === fsTime && row.updateTime === fsTime), true)
  assert.equal(JSON.stringify(captured.recoveryResources).includes(fixture.emails.mailbox), false)
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
  const companyId = 'company_new', actorUid = fixture.ids.ownerAUid, idempotencyKey = 'idem-new-1234567890'
  // Firestore serverTimestamp() is REQUEST_TIME, which legitimately precedes
  // the document commit/update time. The emulator reproduces this ordering.
  const requestTime = '2026-09-08T12:00:00.020000000Z'
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
  const checkpoint = memoryRecoveryCheckpoint()
  const reconciler = createIncrementalFirestoreReconciler({ session, recoveryCheckpoint: checkpoint })
  const state = { ownerASubjectSha256: h(fixture.emails.ownerA), ownerBSubjectSha256: h(fixture.emails.ownerB) }
  const binding = { identity: 'ownerA', actorUid, idempotencyKeySha256: h(idempotencyKey) }
  const companyInput = { idempotencyKey, ownerName: 'Owner', companyName: 'Company', legalType: 'ooo' }
  reconciler.registerIdempotencyMaterial({ slot: 'createCompanyA', identity: 'ownerA', actorUid,
    requestSha256: h(JSON.stringify({ data: companyInput })), callable: 'createCompany', input: companyInput })
  assert.equal(checkpoint.events().at(-1).payload.idempotency.createCompanyA.input.idempotencyKey, idempotencyKey)
  await reconciler.captureBefore({ slot: 'createCompanyA', binding, state })
  assert.equal(checkpoint.events().at(-1).payload.slotSnapshots.createCompanyA.state, 'PREPARED')
  docs.set(`companies/${companyId}`, fsDoc(`companies/${companyId}`, {
    id: companyId, name: 'Company', legalType: 'ooo', currency: 'RUB', createdAt: now, ownerId: actorUid,
  }))
  docs.set(`company_data/${companyId}`, fsDoc(`company_data/${companyId}`,
    { accounts: [], categories: [], counterparties: [], transactions: [], projects: [], rules: [] }))
  docs.set(`companies/${companyId}/members/${actorUid}`, fsDoc(`companies/${companyId}/members/${actorUid}`,
    { uid: actorUid, role: 'admin', status: 'active', createdAt: requestTime, updatedAt: requestTime }))
  docs.set(`users/${actorUid}`, fsDoc(`users/${actorUid}`, {
    id: actorUid, name: 'Owner', email: fixture.emails.ownerA, role: 'admin', companyId, createdAt: now,
  }))
  docs.set(`user_bootstrap/${actorUid}`, fsDoc(`user_bootstrap/${actorUid}`, {
    idempotencyKey, fingerprint: h('fingerprint'), result: { companyId }, createdAt: requestTime,
  }))
  const result = await reconciler.reconcile({ slot: 'createCompanyA', binding, state,
    requestSha256: h('company-request'), outcomeSha256: h('company-outcome'), sanitized: { companyId }, produced: { companyAId: companyId } })
  assert.match(result.readbackSha256, /^[a-f0-9]{64}$/)
  assert.equal(checkpoint.events().at(-1).payload.slotSnapshots.createCompanyA.state, 'RECONCILED')
  const persisted = JSON.stringify(checkpoint.events())
  for (const forbidden of [...Object.values(fixture.emails), 'synthetic-password', 'raw-invite-capability', 'provider body']) {
    assert.equal(persisted.includes(forbidden), false)
  }
})

test('incremental createCompany rejects sub-millisecond transform drift and timestamps after commit', async () => {
  const fixture = semanticFixture(), root = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents'
  const companyId = 'company_chronology', actorUid = fixture.ids.ownerAUid, idempotencyKey = 'idem-chronology-1234567890'
  const baseFields = {
    company: { id: companyId, name: 'Company', legalType: 'ooo', currency: 'RUB', createdAt: now, ownerId: actorUid },
    member: { uid: actorUid, role: 'admin', status: 'active', createdAt: fsTime, updatedAt: fsTime },
    profile: { id: actorUid, name: 'Owner', email: fixture.emails.ownerA, role: 'admin', companyId, createdAt: now },
    bootstrap: { idempotencyKey, fingerprint: h('fingerprint'), result: { companyId }, createdAt: fsTime },
  }
  for (const mutate of [
    docs => { docs.get(`companies/${companyId}/members/${actorUid}`).fields.updatedAt.timestampValue = '2026-09-08T12:00:00.123456788Z' },
    docs => { docs.get(`user_bootstrap/${actorUid}`).fields.createdAt.timestampValue = '2026-09-08T12:00:00.123456790Z' },
    docs => {
      const stale = '2026-09-08T11:59:58.999999999Z'
      docs.get(`companies/${companyId}/members/${actorUid}`).fields.createdAt.timestampValue = stale
      docs.get(`companies/${companyId}/members/${actorUid}`).fields.updatedAt.timestampValue = stale
      docs.get(`user_bootstrap/${actorUid}`).fields.createdAt.timestampValue = stale
    },
    docs => {
      const stale = '2026-09-08T11:59:58.999999999Z'
      docs.get(`companies/${companyId}`).fields.createdAt.stringValue = stale
      docs.get(`users/${actorUid}`).fields.createdAt.stringValue = stale
    },
  ]) {
    const afterDocs = new Map([
      [`companies/${companyId}`, fsDoc(`companies/${companyId}`, baseFields.company)],
      [`company_data/${companyId}`, fsDoc(`company_data/${companyId}`, { accounts: [], categories: [], counterparties: [], transactions: [], projects: [], rules: [] })],
      [`companies/${companyId}/members/${actorUid}`, fsDoc(`companies/${companyId}/members/${actorUid}`, baseFields.member)],
      [`users/${actorUid}`, fsDoc(`users/${actorUid}`, baseFields.profile)],
      [`user_bootstrap/${actorUid}`, fsDoc(`user_bootstrap/${actorUid}`, baseFields.bootstrap)],
    ])
    mutate(afterDocs)
    const docs = new Map()
    const harness = fakeSessionHarness({
      [`POST ${root}:batchGet`]: ({ body }) => body.documents.map(name => {
        const path = name.slice('projects/finapp-staging/databases/(default)/documents/'.length), found = docs.get(path)
        return found ? { found, readTime: fsTime } : { missing: name, readTime: '2026-09-08T11:59:59.000000000Z' }
      }),
    })
    const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
    const reconciler = createIncrementalFirestoreReconciler({ session, recoveryCheckpoint: memoryRecoveryCheckpoint() })
    const state = { ownerASubjectSha256: h(fixture.emails.ownerA), ownerBSubjectSha256: h(fixture.emails.ownerB) }
    const binding = { identity: 'ownerA', actorUid, idempotencyKeySha256: h(idempotencyKey) }
    const input = { idempotencyKey, ownerName: 'Owner', companyName: 'Company', legalType: 'ooo' }
    reconciler.registerIdempotencyMaterial({ slot: 'createCompanyA', identity: 'ownerA', actorUid,
      requestSha256: h(JSON.stringify({ data: input })), callable: 'createCompany', input })
    await reconciler.captureBefore({ slot: 'createCompanyA', binding, state })
    for (const [path, document] of afterDocs) docs.set(path, document)
    await assert.rejects(() => reconciler.reconcile({ slot: 'createCompanyA', binding, state,
      requestSha256: h('company-request'), outcomeSha256: h('company-outcome'), sanitized: { companyId }, produced: { companyAId: companyId } }))
  }
})

test('incremental company invitation bootstrap proof uses a full exact empty query', async () => {
  const companyId = 'company_empty'
  const root = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents'
  const url = `${root}:runQuery`
  const harness = fakeSessionHarness({ [`POST ${url}`]: [{ readTime: fsTime }] })
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const receipt = await createIncrementalFirestoreReconciler({ session }).assertCompanyInvitationsEmpty(companyId)
  assert.deepEqual(Object.keys(receipt).sort(), ['companyIdSha256', 'empty', 'querySha256', 'readTime', 'resultCount'])
  assert.equal(receipt.empty, true); assert.equal(receipt.resultCount, 0); assert.equal(receipt.companyIdSha256, h(companyId))
  const body = harness.requests.at(-1).body
  assert.equal(Object.hasOwn(body.structuredQuery, 'limit'), false)
  assert.equal(body.structuredQuery.from[0].collectionId, 'invitations')
  assert.equal(body.structuredQuery.where.fieldFilter.value.stringValue, companyId)

  const nonempty = fakeSessionHarness({ [`POST ${url}`]: [{ document: fsDoc(`invitations/invite_existing`, { companyId }), readTime: fsTime }] })
  const nonemptySession = await nonempty.loader.execute({ approvalValidated: true, localGatesValidated: true })
  await assert.rejects(() => createIncrementalFirestoreReconciler({ session: nonemptySession }).assertCompanyInvitationsEmpty(companyId))
  await assert.rejects(() => createIncrementalFirestoreReconciler({ session }).assertCompanyInvitationsEmpty('../foreign'))
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

function trackedPreflight(fixture, sourceHead) {
  const functions = LIVE_FUNCTIONS.map(name => ({ name, state: 'ACTIVE', generation: 2, runtime: 'nodejs22', region: 'us-central1',
    memory: '256Mi', cpu: 1, concurrency: 1, minInstances: 0, maxInstances: 1, timeoutSeconds: 60 }))
  const expected = { sourceHead, functionsSha256: h(JSON.stringify(functions)), authMetadataSha256: h('auth-metadata'),
    stagingFingerprint: h('staging-build'), mailboxSha256: h(fixture.emails.mailbox) }
  const adapters = {
    project: async () => ({ projectId: 'finapp-staging', databaseId: '(default)', databaseLocation: 'eur3',
      databaseType: 'FIRESTORE_NATIVE', billingEnabled: true, sourceHead, observedAt: now }),
    functions: async () => ({ items: functions, inventorySha256: expected.functionsSha256, authzProbeAbsent: true, sourceHead, observedAt: now }),
    rules: async () => ({ canonicalSha256: ACTIVE_RULES_SHA256, observedAt: now }),
    indexes: async () => ({ invitationIndexState: 'READY', fieldOverrideCount: 1, fieldOverridesSha256: FIELD_OVERRIDES_SHA256, observedAt: now }),
    auth: async () => ({ emailPasswordEnabled: true, userSignupDisabled: false, verificationMethodPresent: true,
      verificationTemplateMetadataPresent: true, callbackDomainPresent: true, metadataSha256: expected.authMetadataSha256, observedAt: now }),
    maintenance: async () => ({ state: 'ABSENT', observedAt: now }),
    subjectAbsence: async () => ({ mailboxSha256: expected.mailboxSha256, accountExists: false, profileExists: false, observedAt: now }),
    build: async () => ({ sourceHead, stagingFingerprint: expected.stagingFingerprint,
      servedFrom: 'http://127.0.0.1:5177', sixFieldsVerified: true, observedAt: now }),
  }
  return { expected, adapters }
}

function trackedBinding(spec, state) {
  const actorUid = { ownerA: state.ownerAUid, ownerB: state.ownerBUid, ownerMailbox: state.ownerMailboxUid }[spec.identity]
  const companyId = { companyA: state.companyAId, companyB: state.companyBId }[spec.entity]
  if (spec.callable === 'listInvitations') return { identity: spec.identity, actorUid, companyId, expectation: spec.expectation }
  if (spec.callable === 'previewInvite') return { identity: spec.identity,
    invitationId: { mailboxCancelledInvite: state.mailboxCancelledInviteId, mailboxFinalInvite: state.mailboxFinalInviteId }[spec.entity],
    capabilitySha256: { mailboxCancelledCapability: state.mailboxCancelledCapabilitySha256,
      mailboxPreviousCapability: state.mailboxPreviousCapabilitySha256,
      mailboxFinalCapability: state.mailboxFinalCapabilitySha256 }[spec.capability], expectation: spec.expectation }
  return { identity: spec.identity, actorUid, companyId, expectation: spec.expectation }
}

function trackedFixtureRows(fixture) {
  const { ids, emails } = fixture
  const oldCapability = h('previous-final-capability')
  return [
    ['createOwnerAAuth', { identity: 'ownerA', subjectSha256: h(emails.ownerA) }, { ownerAUid: ids.ownerAUid }],
    ['createCompanyA', { identity: 'ownerA', actorUid: ids.ownerAUid, idempotencyKeySha256: h('idem-a-1234567890') }, { companyAId: ids.companyAId }],
    ['createOwnerBAuth', { identity: 'ownerB', subjectSha256: h(emails.ownerB) }, { ownerBUid: ids.ownerBUid }],
    ['createCompanyB', { identity: 'ownerB', actorUid: ids.ownerBUid, idempotencyKeySha256: h('idem-b-1234567890') }, { companyBId: ids.companyBId }],
    ['createMailboxCancelledInvite', { identity: 'ownerA', actorUid: ids.ownerAUid, companyId: ids.companyAId,
      subjectSha256: h(emails.mailbox), role: 'accountant' }, { mailboxCancelledInviteId: ids.mailboxCancelledInviteId,
      mailboxCancelledCapabilitySha256: ids.mailboxCancelledCapabilitySha256, mailboxLockId: ids.mailboxLockId }],
    ['cancelMailboxInvite', { identity: 'ownerA', actorUid: ids.ownerAUid, companyId: ids.companyAId,
      invitationId: ids.mailboxCancelledInviteId }, {}],
    ['createMailboxFinalInvite', { identity: 'ownerA', actorUid: ids.ownerAUid, companyId: ids.companyAId,
      subjectSha256: h(emails.mailbox), role: 'accountant' }, { mailboxFinalInviteId: ids.mailboxFinalInviteId,
      mailboxFinalCapabilitySha256: oldCapability, mailboxLockId: ids.mailboxLockId }],
    ['denyMailboxResendCooldown', { identity: 'ownerA', actorUid: ids.ownerAUid, companyId: ids.companyAId,
      invitationId: ids.mailboxFinalInviteId }, {}],
    ['resendMailboxFinalInvite', { identity: 'ownerA', actorUid: ids.ownerAUid, companyId: ids.companyAId,
      invitationId: ids.mailboxFinalInviteId }, { mailboxFinalCapabilitySha256: ids.mailboxFinalCapabilitySha256 }],
    ['createOwnerMailboxAuth', { identity: 'ownerMailbox', subjectSha256: h(emails.mailbox) }, { ownerMailboxUid: ids.ownerMailboxUid }],
    ['denyWrongIdentityAccept', { identity: 'ownerB', actorUid: ids.ownerBUid, invitationId: ids.mailboxFinalInviteId,
      capabilitySha256: ids.mailboxFinalCapabilitySha256 }, {}],
    ['denyUnverifiedMailboxAccept', { identity: 'ownerMailbox', actorUid: ids.ownerMailboxUid,
      invitationId: ids.mailboxFinalInviteId, capabilitySha256: ids.mailboxFinalCapabilitySha256 }, {}],
    ['acceptMailboxFinalInvite', { identity: 'ownerMailbox', actorUid: ids.ownerMailboxUid,
      invitationId: ids.mailboxFinalInviteId, capabilitySha256: ids.mailboxFinalCapabilitySha256 }, {}],
    ['createOwnerBInvite', { identity: 'ownerA', actorUid: ids.ownerAUid, companyId: ids.companyAId,
      subjectSha256: h(emails.ownerB), role: 'viewer' }, { ownerBInviteId: ids.ownerBInviteId,
      ownerBCapabilitySha256: ids.ownerBCapabilitySha256, ownerBLockId: ids.ownerBLockId }],
    ['acceptOwnerBInvite', { identity: 'ownerB', actorUid: ids.ownerBUid, invitationId: ids.ownerBInviteId,
      capabilitySha256: ids.ownerBCapabilitySha256 }, {}],
    ['replayMailboxFinalInvite', { identity: 'ownerMailbox', actorUid: ids.ownerMailboxUid,
      invitationId: ids.mailboxFinalInviteId, capabilitySha256: ids.mailboxFinalCapabilitySha256 }, {}],
  ]
}

async function createTrackedScenario(journal, fixture, sourceHead, {
  uncertainAt = null, onUncertainReadback = async () => {}, recoveryCheckpoint = null,
} = {}) {
  const preflight = trackedPreflight(fixture, sourceHead)
  const executor = createLiveStagingExecutor({ journal, recoveryCheckpoint,
    preflightAdapters: preflight.adapters, expectedPreflight: preflight.expected,
    initial: { runId: fixture.plan.runId, mailboxSha256: h(fixture.emails.mailbox),
      ownerASubjectSha256: h(fixture.emails.ownerA), ownerBSubjectSha256: h(fixture.emails.ownerB) },
    nowMs: () => Date.parse(now), cooldownGate: { start() {}, async wait() { return {} }, isReady: () => true } })
  await executor.start()
  let readOnlyIndex = 0
  const executeReadOnly = async spec => {
    const binding = trackedBinding(spec, executor.snapshot().state)
    const requestSha256 = h(`request-${spec.slot}`), outcomeSha256 = h(`outcome-${spec.slot}`)
    await executor.executeReadOnlyCallable({ slot: spec.slot, callable: spec.callable, requestSha256, binding,
      dispatch: async () => ({ requestSha256, outcomeSha256, producedSha256: h('{}') }),
      readback: async () => ({ requestSha256, outcomeSha256, readbackSha256: h(`readback-${spec.slot}`), produced: {} }) })
  }
  const rows = trackedFixtureRows(fixture)
  for (let index = 0; index < rows.length; index++) {
    const [slot, binding, produced] = rows[index]
    const requestSha256 = h(`request-${slot}`), outcomeSha256 = h(`outcome-${slot}`)
    await executor.executeFixtureSlot({ slot, requestSha256, binding,
      dispatch: async () => ({ requestSha256, outcomeSha256, producedSha256: h(JSON.stringify(produced)) }),
      readback: async () => {
        if (slot === uncertainAt) {
          await onUncertainReadback({ slot, binding, state: executor.snapshot().state, requestSha256, outcomeSha256 })
          throw new Error('synthetic uncertain readback')
        }
        return { requestSha256, outcomeSha256, readbackSha256: h(`readback-${slot}`), produced }
      } })
    if (slot === 'denyUnverifiedMailboxAccept') {
      const emailRequest = h('verification-request'), emailOutcome = h('verification-outcome')
      await executor.executeVerificationEmail({ requestSha256: emailRequest,
        dispatch: async () => ({ requestSha256: emailRequest, outcomeSha256: emailOutcome }) })
      const handoff = createVisibleOwnerHandoff({ openSession: async () => ({
        inspectBoundary: async () => ({ visible: true, persistent: false, fragmentRemovedBeforeInit: true,
          financialModulesLoaded: false, cachedCompanyDataLoaded: false, capabilityPersisted: false }),
        confirmCredentialReady: async () => ({ ready: true, minimumLengthSatisfied: true }),
        prepareRegistration: async () => ({}), dispatchRegistration: async () => ({}), prepareVerification: async () => ({}),
        dispatchVerification: async () => ({}), confirmVerifiedSession: async value => ({ ...value, verified: true, reloaded: true, forcedRefresh: true }),
        close: async () => {},
      }), pause: async () => ({ acknowledged: true }) })
      await handoff.open(); const proof = await handoff.awaitVerifiedSession(executor.verificationSessionChallenge())
      executor.markVerifiedSession(proof); await handoff.close()
    }
    while (READ_ONLY_SLOT_SPECS[readOnlyIndex]?.afterFixtureCount === index + 1) await executeReadOnly(READ_ONLY_SLOT_SPECS[readOnlyIndex++])
  }
  const counts = Object.fromEntries(Object.keys(CALLABLE_CAPS).map(name => [name, 0]))
  for (const event of journal.events()) if (['FIXTURE_MUTATION_MAY_BE_SENT', 'CALLABLE_REQUEST_MAY_BE_SENT'].includes(event.status) && event.details.callable) counts[event.details.callable]++
  const semanticState = Object.fromEntries(['ownerAUid', 'ownerBUid', 'ownerMailboxUid', 'companyAId', 'companyBId',
    'mailboxCancelledInviteId', 'mailboxFinalInviteId', 'ownerBInviteId', 'mailboxCancelledCapabilitySha256',
    'mailboxFinalCapabilitySha256', 'ownerBCapabilitySha256', 'mailboxLockId', 'ownerBLockId'].map(key => [key, executor.snapshot().state[key]]))
  const uiEvidence = LIVE_PLAYWRIGHT_UI_STEPS.map(step => ({
    step, status: 'PASS', observationSha256: h(step),
    ...(step === 'admin-copy-link' ? { initialListSource: 'verified-empty-local-bootstrap' } : {}),
  }))
  return { scenarios: SCENARIO_NAMES.map(name => ({ name, status: 'PASS', evidenceSha256: h(`scenario:${name}`) })),
    uiEvidence, uiEvidenceSha256: h(JSON.stringify(uiEvidence)), materializeFixturePlan: executor.materializeFixturePlan,
    readSemanticState: () => semanticState,
    readReplayProof: () => ({ invitationUpdateTimeBefore: fsTime, invitationUpdateTimeAfter: fsTime,
      membershipUpdateTimeBefore: fsTime, membershipUpdateTimeAfter: fsTime, profileUpdateTimeBefore: fsTime,
      profileUpdateTimeAfter: fsTime, auditCountBefore: 9, auditCountAfter: 9 }),
    readCallableCounts: () => counts,
    readTransportCounts: () => ({ authorizedRequests: 27, dispatchedRequests: 27, oauthRefreshes: 0, verificationDispatches: 1 }),
    verifyAcceptance: executor.verifyAcceptance, buildCleanupPlanOnly: executor.buildCleanupPlanOnly }
}

test('live composition persists complete private recovery state while returning only public evidence', async () => {
  const fixture = semanticFixture(), calls = [], sourceHead = 'a'.repeat(40)
  const harness = fakeSessionHarness(semanticOverrides(fixture))
  const session = await harness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const reconciler = createIncrementalFirestoreReconciler({ session })
  for (const [slot, identity, actorUid, key, ownerName, companyName] of [
    ['createCompanyA', 'ownerA', fixture.ids.ownerAUid, 'idem-a-1234567890', 'Owner A', 'Company A'],
    ['createCompanyB', 'ownerB', fixture.ids.ownerBUid, 'idem-b-1234567890', 'Owner B', 'Company B'],
  ]) {
    const input = { idempotencyKey: key, ownerName, companyName, legalType: 'ooo' }
    reconciler.registerIdempotencyMaterial({ slot, identity, actorUid, requestSha256: h(JSON.stringify({ data: input })), callable: 'createCompany', input })
  }
  const memoryJournal = callLog => {
    let events = [], closed = false
    return { append(status, details = {}) { if (closed) throw new Error('closed'); events = appendJournalEvent(events, { seq: events.length, status, at: now, details }) },
      bytes() { if (closed) throw new Error('closed'); return Buffer.from(events.map(row => JSON.stringify(row)).join('\n') + (events.length ? '\n' : '')) },
      events() { if (closed) throw new Error('closed'); return structuredClone(events) },
      close() { if (closed) throw new Error('closed'); const bytes = this.bytes(); closed = true; callLog.push('journal.close');
        return { journalSha256: h(bytes), eventCount: events.length } } }
  }
  const journal = memoryJournal(calls)
  const recoveryCheckpoint = memoryRecoveryCheckpoint(calls)
  let privateOutput, recoveryPath
  const stages = {
    openLoopback: async () => { calls.push('loopback.open'); return { receipt: { sourceHead }, close: async () => calls.push('loopback.close') } },
    openProvider: async () => { calls.push('provider.open'); return { session,
      transport: { close: async () => calls.push('transport.close') }, close: async () => calls.push('provider.close') } },
    createJournal: async () => { calls.push('journal.open'); return journal },
    createRecoveryCheckpoint: async ({ filename }) => { calls.push('recovery.open'); recoveryPath = filename; return recoveryCheckpoint },
    openPlaywright: async () => { calls.push('playwright.open'); return { browser: { close: async () => calls.push('browser.close') },
      close: async () => calls.push('playwright.close') } },
    runScenarios: async ({ recoveryCheckpoint: value }) => { calls.push('scenarios');
      assert.equal(value, recoveryCheckpoint)
      return createTrackedScenario(journal, fixture, sourceHead, { recoveryCheckpoint: value }) },
    createSemanticReadback: async ({ session: value, plan, state }) => { calls.push('semantic');
      return createSemanticFirestoreReadbackAdapter({ session: value, plan, state,
        ownerASubjectSha256: h(fixture.emails.ownerA), ownerBEmailSha256: h(fixture.emails.ownerB) }) },
    writeOutput: async ({ value }) => { calls.push('output'); privateOutput = value },
  }
  const outputPath = privatePath('out.json')
  const result = await runLiveAcceptanceComposition({ context: { sourceHead,
    journalPath: privatePath('journal.jsonl'), outputPath }, stages,
  now: (() => { const values = ['2026-09-08T12:00:00.000Z', '2026-09-08T12:01:00.000Z']; return () => values.shift() })() })
  assert.equal(result.status, 'LIVE_ACCEPTANCE_VERIFIED'); assert.equal('recoveryManifest' in result, false)
  assert.equal(privateOutput.recoveryManifest.status, 'SUCCESS')
  assert.equal(Object.keys(privateOutput.recoveryManifest.fixtureSlots).length, FIXTURE_MUTATION_SLOT_SPECS.length)
  assert.equal(Object.values(privateOutput.recoveryManifest.fixtureSlots).every(row => row.state === 'RECONCILED'), true)
  assert.equal(Object.values(privateOutput.recoveryManifest.readOnlySlots).every(row => row.state === 'RECONCILED'), true)
  assert.equal(privateOutput.recoveryManifest.auth.ownerA.uid, fixture.ids.ownerAUid)
  assert.equal(privateOutput.recoveryManifest.resources.length, 27)
  assert.equal(privateOutput.recoveryManifest.resources.filter(row => row.kind === 'firestore-audit').length, 9)
  assert.equal(privateOutput.recoveryManifest.resources.filter(row => row.cleanupDisposition === 'CAS_REQUIRED').length, 2)
  assert.equal(privateOutput.recoveryManifest.idempotency.createCompanyA.input.idempotencyKey, 'idem-a-1234567890')
  const persisted = JSON.stringify(privateOutput)
  for (const forbidden of [...Object.values(fixture.emails), 'synthetic-password', 'raw-invite-capability', 'provider body']) assert.equal(persisted.includes(forbidden), false)
  assert.equal(JSON.stringify(result).includes('idem-a-1234567890'), false)
  assert.equal(recoveryPath, `${outputPath}.recovery.jsonl`)
  const recoveryEvents = recoveryCheckpoint.inspect()
  assert.equal(recoveryEvents.at(-1).kind, 'OUTPUT_COMMITTED')
  assert.equal(recoveryEvents.some(row => row.kind === 'FINAL_MANIFEST'), true)
  const finalManifestIndex = calls.lastIndexOf('recovery.FINAL_MANIFEST')
  assert.ok(finalManifestIndex < calls.lastIndexOf('playwright.close'))
  assert.ok(calls.lastIndexOf('journal.close') < calls.lastIndexOf('output'))
  assert.ok(calls.lastIndexOf('output') < calls.lastIndexOf('recovery.OUTPUT_COMMITTED'))
  assert.equal(calls.at(-1), 'recovery.close')

  for (const failure of ['HEAD_DRIFT', 'OUTPUT_FSYNC_FAILURE']) {
    const outputCalls = [], caseJournal = memoryJournal(outputCalls), caseRecovery = memoryRecoveryCheckpoint(outputCalls)
    let writes = 0
    await assert.rejects(() => runLiveAcceptanceComposition({ context: { sourceHead,
      journalPath: privatePath(`${failure}.journal.jsonl`), outputPath: privatePath(`${failure}.json`) }, stages: {
      openLoopback: async () => ({ receipt: { sourceHead }, close: async () => {} }),
      openProvider: async () => ({ session, transport: { close: async () => {} }, close: async () => {} }),
      createJournal: async () => caseJournal,
      createRecoveryCheckpoint: async () => caseRecovery,
      openPlaywright: async () => ({ browser: { close: async () => {} }, close: async () => {} }),
      runScenarios: async ({ recoveryCheckpoint: value }) => createTrackedScenario(caseJournal, fixture, sourceHead,
        { recoveryCheckpoint: value }),
      createSemanticReadback: stages.createSemanticReadback,
      writeOutput: async () => { writes++; throw new Error(failure) },
    }, now: (() => { const values = ['2026-09-08T12:03:00.000Z', '2026-09-08T12:04:00.000Z',
      '2026-09-08T12:05:00.000Z']; return () => values.shift() })() }))
    assert.equal(writes, 1)
    const events = caseRecovery.inspect()
    assert.equal(events.at(-2).kind, 'FINAL_MANIFEST')
    assert.equal(events.at(-1).kind, 'RECOVERY_REQUIRED')
    assert.equal(events.at(-1).payload.reasonCode, 'FINAL_OUTPUT_NOT_COMMITTED')
    assert.equal(events.at(-1).payload.recoveryManifest.status, 'SUCCESS')
    assert.equal(outputCalls.filter(value => value === 'recovery.RECOVERY_REQUIRED').length, 1)
  }

  const failedCalls = [], failedJournal = memoryJournal(failedCalls)
  const failedRecoveryCheckpoint = memoryRecoveryCheckpoint(failedCalls)
  const failedRoot = 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents'
  const failedReplayPaths = [`invitations/${fixture.ids.mailboxFinalInviteId}`, `invitationLocks/${fixture.ids.mailboxLockId}`,
    `companies/${fixture.ids.companyAId}/members/${fixture.ids.ownerMailboxUid}`, `users/${fixture.ids.ownerMailboxUid}`]
  const failedHarness = fakeSessionHarness({
    [`POST ${failedRoot}:batchGet`]: failedReplayPaths.map(pathValue => ({ found: fixture.docs.get(pathValue), readTime: fsTime })),
    [`POST ${failedRoot}/companies/${fixture.ids.companyAId}:runQuery`]: fixture.audit.map(document => ({ document, readTime: fsTime })),
    [`POST ${failedRoot}/companies/${fixture.ids.companyBId}:runQuery`]: fixture.auditB.map(document => ({ document, readTime: fsTime })),
  })
  const failedSession = await failedHarness.loader.execute({ approvalValidated: true, localGatesValidated: true })
  const failedReconciler = createIncrementalFirestoreReconciler({ session: failedSession })
  for (const [slot, identity, actorUid, key, ownerName, companyName] of [
    ['createCompanyA', 'ownerA', fixture.ids.ownerAUid, 'failed-idem-a-1234567890', 'Owner A', 'Company A'],
    ['createCompanyB', 'ownerB', fixture.ids.ownerBUid, 'failed-idem-b-1234567890', 'Owner B', 'Company B'],
  ]) {
    const input = { idempotencyKey: key, ownerName, companyName, legalType: 'ooo' }
    failedReconciler.registerIdempotencyMaterial({ slot, identity, actorUid,
      requestSha256: h(JSON.stringify({ data: input })), callable: 'createCompany', input })
  }
  let failureProbe = {}
  await assert.rejects(() => runLiveAcceptanceComposition({ context: { sourceHead,
    journalPath: privatePath('journal2.jsonl'), outputPath: privatePath('out2.json') }, stages: {
    ...stages,
    openLoopback: async () => ({ receipt: {}, close: async () => failedCalls.push('loopback.close') }),
    openProvider: async () => ({ session: failedSession, transport: { close: async () => {} }, close: async () => failedCalls.push('provider.close') }),
    createJournal: async () => failedJournal,
    createRecoveryCheckpoint: async () => failedRecoveryCheckpoint,
    openPlaywright: async () => ({ browser: { close: async () => {} }, close: async () => failedCalls.push('playwright.close') }),
    runScenarios: async ({ recoveryCheckpoint: value }) => createTrackedScenario(failedJournal, fixture, sourceHead, {
      recoveryCheckpoint: value, uncertainAt: 'replayMailboxFinalInvite',
      onUncertainReadback: async input => {
        failureProbe.started = true
        await failedReconciler.captureBefore(input)
        failureProbe.captured = true
        await failedReconciler.reconcile({ ...input, sanitized: null, produced: {} })
        failureProbe.reconciled = true
        failureProbe.resources = buildPrivateLiveRecoveryManifest({ sourceHead, journal: failedJournal, session: failedSession,
          status: 'RECOVERY_REQUIRED', generatedAt: now }).resources.length
      } }),
    writeOutput: async () => { failedCalls.push('output'); throw new Error('must not write recovery through success output') },
  }, now: () => '2026-09-08T12:02:00.000Z' }))
  assert.deepEqual(failureProbe, { started: true, captured: true, reconciled: true, resources: 13 })
  const failedEvents = failedRecoveryCheckpoint.inspect()
  const required = failedEvents.at(-1)
  assert.equal(required.kind, 'RECOVERY_REQUIRED')
  assert.equal(required.payload.reasonCode, 'EXECUTION_INTERRUPTED')
  assert.equal(required.payload.recoveryManifest.fixtureSlots.acceptOwnerBInvite.state, 'RECONCILED')
  assert.equal(required.payload.recoveryManifest.fixtureSlots.replayMailboxFinalInvite.state, 'UNCERTAIN')
  assert.equal(required.payload.recoveryManifest.identifiers.companyAId, fixture.ids.companyAId)
  assert.equal(required.payload.recoveryManifest.idempotency.createCompanyA.input.idempotencyKey, 'failed-idem-a-1234567890')
  assert.equal(required.payload.recoveryManifest.resources.length, 13)
  assert.equal(required.payload.recoveryManifest.resources.filter(row => row.cleanupDisposition === 'CAS_REQUIRED').length, 2)
  const requiredCall = failedCalls.lastIndexOf('recovery.RECOVERY_REQUIRED')
  assert.ok(requiredCall > failedCalls.lastIndexOf('loopback.close'))
  assert.equal(failedCalls.includes('output'), false)
  assert.equal(failedCalls.at(-1), 'recovery.close')
})
