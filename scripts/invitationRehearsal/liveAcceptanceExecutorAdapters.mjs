import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createLiveBrowserRequestBinder } from './liveAcceptanceBrowserCore.mjs'
import {
  createLiveStagingExecutor, createVisibleOwnerHandoff, LIVE_FUNCTIONS,
} from './liveAcceptanceExecutorCore.mjs'
import {
  assertNoSecretMaterial, authorizePendingDispatchJournal, FIXTURE_MUTATION_SLOT_SPECS,
  PROJECT, READBACK_CHECKS, validateFixturePlan,
} from './liveAcceptanceCore.mjs'
import { PLAYWRIGHT_LIVE_MISSING_BINDINGS } from './liveAcceptancePlaywrightCore.mjs'
import { DATABASE, guardCliAccount, rulesHash } from './inventoryCore.mjs'
import {
  checkFunction, requestSpec as deploymentRequestSpec,
} from './deploymentCheckCore.mjs'
import {
  FIELD_HASH, INDEX, isInvitationIndex,
} from './stagingResourcesCore.mjs'
import { normalizeMailbox, sanitizeLookup } from './mailboxDiscoveryCore.mjs'

export const LIVE_ADAPTER_ALLOWLIST = Object.freeze({
  fixtureSlots: Object.freeze([
    'createOwnerAAuth', 'createCompanyA', 'createOwnerBAuth', 'createCompanyB',
    'createMailboxCancelledInvite', 'cancelMailboxInvite', 'createMailboxFinalInvite',
    'denyMailboxResendCooldown', 'resendMailboxFinalInvite', 'createOwnerMailboxAuth',
    'denyWrongIdentityAccept', 'denyUnverifiedMailboxAccept', 'acceptMailboxFinalInvite',
    'replayMailboxFinalInvite', 'createOwnerBInvite', 'acceptOwnerBInvite',
  ]),
  readOnlyCallables: Object.freeze(['listInvitations', 'previewInvite', 'getCompanyAccess']),
  ownerActions: Object.freeze(['OWNER_ENTER_CREDENTIAL', 'OWNER_COMPLETE_PROVIDER_VERIFICATION']),
})

// liveAcceptanceExecutor.mjs refuses credentials while this is non-empty.
// The staging Auth metadata shape was confirmed by the separately authorized
// read-only discovery receipt; all concrete adapter groups are now present.
export const LIVE_EXECUTOR_MISSING_ADAPTERS = Object.freeze([
  ...PLAYWRIGHT_LIVE_MISSING_BINDINGS,
])

const blocked = () => { throw new Error('live_executor_adapters_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const jsonHash = value => sha256(JSON.stringify(value))
const clone = value => structuredClone(value)
const frozen = value => Object.freeze(clone(value))
const isoNow = now => {
  const value = now()
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) blocked()
  return value
}

const sessionInternals = new WeakMap()

/** Load the signed-in firebase-tools session only after both local gates. */
export function createGuardedFirebaseToolsSessionLoader({ repoRoot, loadModule } = {}) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) blocked()
  const require = createRequire(import.meta.url)
  const load = loadModule ?? (name => require(path.join(repoRoot, 'node_modules/firebase-tools/lib', name)))
  if (typeof load !== 'function') blocked()
  let attempted = false
  return Object.freeze({
    async execute(gates) {
      if (attempted || !exactKeys(gates, ['approvalValidated', 'localGatesValidated']) ||
          gates.approvalValidated !== true || gates.localGatesValidated !== true) blocked()
      attempted = true
      const logger = load('logger.js')?.logger
      const auth = load('auth.js')
      const requireAuth = load('requireAuth.js')
      const Client = load('apiv2.js')?.Client
      if (!logger || !auth || !requireAuth || typeof Client !== 'function' ||
          typeof auth.getGlobalDefaultAccount !== 'function' || typeof requireAuth.requireAuth !== 'function') blocked()
      logger.silent = true
      const account = auth.getGlobalDefaultAccount()
      guardCliAccount(account)
      const authenticated = await requireAuth.requireAuth({
        project: PROJECT, user: account.user, tokens: account.tokens,
      }, true)
      if (!authenticated) blocked()
      const session = Object.freeze({ project: PROJECT, authenticated: true })
      sessionInternals.set(session, { Client })
      return session
    },
  })
}

function internalSession(session) {
  const value = sessionInternals.get(session)
  if (!value) blocked()
  return value
}

const REQUEST_OPTIONS = Object.freeze({
  headers: Object.freeze({ 'x-goog-user-project': PROJECT }),
  skipLog: Object.freeze({ body: true, resBody: true, queryParams: true }),
  redirect: 'error', retries: 0, timeout: 10_000,
})

function options(extra = {}) {
  return {
    headers: { ...REQUEST_OPTIONS.headers }, skipLog: { ...REQUEST_OPTIONS.skipLog },
    redirect: REQUEST_OPTIONS.redirect, retries: 0, timeout: REQUEST_OPTIONS.timeout, ...extra,
  }
}

function clientFor(Client, rawUrl) {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) blocked()
  return { url, client: new Client({ urlPrefix: url.origin, auth: true }) }
}

async function exactGet(Client, rawUrl, queryParams = undefined, extra = {}) {
  const { url, client } = clientFor(Client, rawUrl)
  const response = await client.get(url.pathname, options({ ...(queryParams ? { queryParams } : {}), ...extra }))
  if (!record(response) || !Object.hasOwn(response, 'body')) blocked()
  return response.body
}

async function exactPost(Client, rawUrl, body) {
  const { url, client } = clientFor(Client, rawUrl)
  const response = await client.post(url.pathname, body, options())
  if (!record(response) || !Object.hasOwn(response, 'body')) blocked()
  return response.body
}

async function listFunctions(Client, kind) {
  const rows = [], seen = new Set()
  let token
  for (let page = 0; page < 10; page++) {
    const spec = deploymentRequestSpec(kind, token)
    const value = await exactGet(Client, spec.url, spec.queryParams)
    if (!record(value) || (value.functions !== undefined && !Array.isArray(value.functions)) ||
        (value.unreachable !== undefined && (!Array.isArray(value.unreachable) || value.unreachable.length))) blocked()
    rows.push(...(value.functions ?? []))
    if (rows.length > 1000) blocked()
    if (value.nextPageToken === undefined || value.nextPageToken === '') return rows
    if (typeof value.nextPageToken !== 'string' || value.nextPageToken.length > 4096 || seen.has(value.nextPageToken)) blocked()
    token = value.nextPageToken; seen.add(token)
  }
  blocked()
}

async function listCollection(Client, rawUrl, key, queryParams = {}) {
  const rows = [], seen = new Set()
  let token
  for (let page = 0; page < 100; page++) {
    const value = await exactGet(Client, rawUrl, { ...queryParams, ...(token ? { pageToken: token } : {}) })
    if (!record(value) || (value[key] !== undefined && !Array.isArray(value[key]))) blocked()
    rows.push(...(value[key] ?? []))
    if (!value.nextPageToken) return rows
    if (typeof value.nextPageToken !== 'string' || value.nextPageToken.length > 4096 || seen.has(value.nextPageToken)) blocked()
    token = value.nextPageToken; seen.add(token)
  }
  blocked()
}

const URLS = Object.freeze({
  project: `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}`,
  billing: `https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`,
  database: `https://firestore.googleapis.com/v1/${DATABASE}`,
  release: `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`,
  indexes: `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
  fields: `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/fields`,
  auth: `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`,
  authLookup: `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`,
  authCreate: `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`,
  maintenance: `https://firestore.googleapis.com/v1/${DATABASE}/documents/system/maintenance`,
})

const AUTH_FIELDS = 'name,authorizedDomains,signIn(email(enabled,passwordRequired)),client(permissions(disabledUserSignup)),notification(sendEmail(method,callbackUri,verifyEmailTemplate(bodyFormat,customized,senderLocalPart,subject)))'

function rulesetUrl(name) {
  if (typeof name !== 'string' || !new RegExp(`^projects/${PROJECT}/rulesets/[a-zA-Z0-9-]+$`).test(name)) blocked()
  return `https://firebaserules.googleapis.com/v1/${name}`
}

function sanitizeAuthPreflight(value, expectedHash, projectNumber) {
  const names = [`projects/${PROJECT}/config`, `projects/${projectNumber}/config`]
  if (!record(value) || !names.includes(value.name) || !Array.isArray(value.authorizedDomains) ||
      value.authorizedDomains.some(domain => typeof domain !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(domain)) ||
      value.signIn?.email?.enabled !== true || value.signIn.email.passwordRequired !== true ||
      (value.client?.permissions?.disabledUserSignup ?? false) !== false) blocked()
  const send = value.notification?.sendEmail
  const template = send?.verifyEmailTemplate
  if (!record(send) || !['DEFAULT', 'CUSTOM_SMTP'].includes(send.method) ||
      typeof send.callbackUri !== 'string' || !send.callbackUri || !record(template) ||
      !['PLAIN_TEXT', 'HTML'].includes(template.bodyFormat) ||
      (template.customized !== undefined && typeof template.customized !== 'boolean') ||
      typeof template.senderLocalPart !== 'string' || !template.senderLocalPart ||
      typeof template.subject !== 'string' || !template.subject) blocked()
  let callback
  try { callback = new URL(send.callbackUri) } catch { blocked() }
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash ||
      !value.authorizedDomains.includes(callback.hostname)) blocked()
  const metadata = {
    emailPasswordEnabled: true, userSignupDisabled: false, verificationMethod: send.method,
    callbackDomain: callback.hostname, template: {
      bodyFormat: template.bodyFormat, customized: template.customized ?? false,
      senderLocalPartPresent: true, subjectPresent: true,
    },
  }
  const metadataSha256 = jsonHash(metadata)
  if (expectedHash !== null && metadataSha256 !== expectedHash) blocked()
  return {
    emailPasswordEnabled: true, userSignupDisabled: false, verificationMethodPresent: true,
    verificationTemplateMetadataPresent: true, callbackDomainPresent: true,
    metadataSha256,
  }
}

/** Narrow discovery for the separately approved Auth-template read-only gate. */
export async function discoverFirebaseAuthTemplateMetadata({ session }) {
  const { Client } = internalSession(session)
  const project = await exactGet(Client, URLS.project, { fields: 'projectId,projectNumber' })
  if (!record(project) || project.projectId !== PROJECT || !/^\d+$/.test(project.projectNumber ?? '')) blocked()
  const value = await exactGet(Client, URLS.auth, { fields: AUTH_FIELDS })
  return frozen(sanitizeAuthPreflight(value, null, project.projectNumber))
}

/** Exact eight adapters consumed by runFreshLivePreflight(). */
export function createFirebaseReadOnlyPreflightAdapters({
  session, sourceHead, mailbox, expectedAuthMetadataSha256, stagingBuildProbe,
  now = () => new Date().toISOString(),
}) {
  const { Client } = internalSession(session)
  if (!/^[a-f0-9]{40}$/.test(sourceHead ?? '') || !hex64(expectedAuthMetadataSha256) ||
      typeof stagingBuildProbe !== 'function') blocked()
  const normalizedMailbox = normalizeMailbox(mailbox)
  let projectNumber = null
  const observed = () => isoNow(now)
  return Object.freeze({
    project: async () => {
      const project = await exactGet(Client, URLS.project, { fields: 'projectId,projectNumber' })
      const billing = await exactGet(Client, URLS.billing, { fields: 'projectId,billingEnabled' }, { ignoreQuotaProject: true, headers: {} })
      const database = await exactGet(Client, URLS.database, { fields: 'name,locationId,type' })
      if (!record(project) || project.projectId !== PROJECT || !/^\d+$/.test(project.projectNumber ?? '') ||
          !record(billing) || billing.projectId !== PROJECT || billing.billingEnabled !== true ||
          !record(database) || database.name !== DATABASE || database.locationId !== 'eur3' || database.type !== 'FIRESTORE_NATIVE') blocked()
      projectNumber = project.projectNumber
      return { projectId: PROJECT, databaseId: '(default)', databaseLocation: 'eur3', databaseType: 'FIRESTORE_NATIVE',
        billingEnabled: true, sourceHead, observedAt: observed() }
    },
    functions: async () => {
      const project = await exactGet(Client, URLS.project, { fields: 'projectId,projectNumber' })
      if (!record(project) || project.projectId !== PROJECT || !/^\d+$/.test(project.projectNumber ?? '')) blocked()
      const v1 = await listFunctions(Client, 'functionsV1')
      const v2 = await listFunctions(Client, 'functionsV2')
      if (v1.length || v2.length !== LIVE_FUNCTIONS.length) blocked()
      const items = v2.map(row => checkFunction(row, project.projectNumber)).map(row => ({
        name: row.name.slice(row.name.lastIndexOf('/') + 1), state: row.state, generation: row.generation,
        runtime: row.runtime, region: row.region, memory: row.resources.memory, cpu: row.resources.cpu,
        concurrency: row.resources.concurrency, minInstances: row.resources.minInstances,
        maxInstances: row.resources.maxInstances, timeoutSeconds: row.resources.timeoutSeconds,
      })).sort((a, b) => a.name.localeCompare(b.name))
      if (new Set(items.map(item => item.name)).size !== LIVE_FUNCTIONS.length) blocked()
      return { items, inventorySha256: jsonHash(items), authzProbeAbsent: true, sourceHead, observedAt: observed() }
    },
    rules: async () => {
      const release = await exactGet(Client, URLS.release)
      if (!record(release) || release.name !== `projects/${PROJECT}/releases/cloud.firestore`) blocked()
      const ruleset = await exactGet(Client, rulesetUrl(release.rulesetName))
      if (!record(ruleset) || ruleset.name !== release.rulesetName || !Array.isArray(ruleset.source?.files) ||
          ruleset.source.files.length !== 1 || typeof ruleset.source.files[0]?.content !== 'string') blocked()
      return { canonicalSha256: rulesHash(ruleset.source.files[0].content), observedAt: observed() }
    },
    indexes: async () => {
      const indexes = await listCollection(Client, URLS.indexes, 'indexes', { pageSize: '100' })
      const matches = indexes.filter(isInvitationIndex)
      if (matches.length !== 1) blocked()
      const fields = await listCollection(Client, URLS.fields, 'fields', {
        pageSize: '100', filter: 'indexConfig.usesAncestorConfig=false OR ttlConfig:*',
      })
      if (fields.some(field => !record(field) || typeof field.name !== 'string' || !field.name.startsWith(`${DATABASE}/collectionGroups/`))) blocked()
      return { invitationIndexState: matches[0].state, fieldOverrideCount: fields.length,
        fieldOverridesSha256: jsonHash(fields), observedAt: observed() }
    },
    auth: async () => {
      if (!projectNumber) {
        const project = await exactGet(Client, URLS.project, { fields: 'projectId,projectNumber' })
        if (!record(project) || project.projectId !== PROJECT || !/^\d+$/.test(project.projectNumber ?? '')) blocked()
        projectNumber = project.projectNumber
      }
      const value = await exactGet(Client, URLS.auth, { fields: AUTH_FIELDS })
      return { ...sanitizeAuthPreflight(value, expectedAuthMetadataSha256, projectNumber), observedAt: observed() }
    },
    maintenance: async () => {
      try {
        const value = await exactGet(Client, URLS.maintenance)
        if (!record(value) || value.name !== `${DATABASE}/documents/system/maintenance` ||
            value.fields?.enabled?.booleanValue !== false) blocked()
        return { state: 'INACTIVE', observedAt: observed() }
      } catch (error) {
        if (error?.status !== 404) blocked()
        return { state: 'ABSENT', observedAt: observed() }
      }
    },
    subjectAbsence: async () => {
      const lookup = sanitizeLookup(await exactPost(Client, URLS.authLookup, { email: [normalizedMailbox] }), normalizedMailbox)
      if (lookup.accountExists) blocked()
      const profileQuery = { structuredQuery: { from: [{ collectionId: 'users' }], where: { fieldFilter: {
        field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: normalizedMailbox },
      } }, limit: 1 } }
      const profiles = await exactPost(Client, `${DOCUMENTS_URL}:runQuery`, profileQuery)
      if (!Array.isArray(profiles) || profiles.some(row => !exactKeys(row, ['readTime']) || !rfc3339(row.readTime))) blocked()
      return { mailboxSha256: sha256(normalizedMailbox), accountExists: false, profileExists: false, observedAt: observed() }
    },
    build: async () => {
      const value = await stagingBuildProbe()
      if (!exactKeys(value, ['sourceHead', 'stagingFingerprint', 'servedFrom', 'sixFieldsVerified']) ||
          value.sourceHead !== sourceHead || !hex64(value.stagingFingerprint) ||
          value.servedFrom !== 'http://127.0.0.1:5177' || value.sixFieldsVerified !== true) blocked()
      return { ...clone(value), observedAt: observed() }
    },
  })
}

const AUTH_IDENTITIES = Object.freeze({ ownerA: 'createOwnerAAuth', ownerB: 'createOwnerBAuth' })

function validateSyntheticAccount(value, identity, runId) {
  if (!exactKeys(value, ['uid', 'email', 'password']) || value.uid !== `${runId}-${identity}` || value.uid.length > 128 ||
      normalizeMailbox(value.email) !== value.email || !value.email.endsWith('@example.invalid') ||
      typeof value.password !== 'string' || value.password.length < 16 || value.password.length > 128) blocked()
}

function sanitizeCreatedAccount(value, expected) {
  if (!record(value) || value.localId !== expected.uid || normalizeMailbox(value.email) !== expected.email ||
      value.emailVerified !== true || value.disabled === true) blocked()
  return value.localId
}

/** Exact Admin Auth create+lookup adapter for the two synthetic verified owners. */
export function createSyntheticVerifiedAuthAdapter({ session, runId, accounts }) {
  const { Client } = internalSession(session)
  if (typeof runId !== 'string' || !/^[a-z][a-z0-9-]{7,39}$/.test(runId) || runId.includes('--') ||
      !exactKeys(accounts, ['ownerA', 'ownerB'])) blocked()
  for (const identity of Object.keys(AUTH_IDENTITIES)) validateSyntheticAccount(accounts[identity], identity, runId)
  if (accounts.ownerA.uid === accounts.ownerB.uid || accounts.ownerA.email === accounts.ownerB.email ||
      accounts.ownerA.password === accounts.ownerB.password) blocked()
  const completed = new Set()
  return Object.freeze({
    slot(identity, subjectSha256) {
      const slot = AUTH_IDENTITIES[identity]
      const account = accounts[identity]
      if (!slot || !hex64(subjectSha256) || sha256(account.email) !== subjectSha256 || completed.has(identity)) blocked()
      const body = { localId: account.uid, email: account.email, password: account.password, emailVerified: true, disableUser: false }
      const requestSha256 = jsonHash(body)
      let outcomeSha256 = null, dispatched = false
      return Object.freeze({
        requestSha256, binding: frozen({ identity, subjectSha256 }),
        dispatch: async permit => {
          if (dispatched) blocked()
          const journal = authorizePendingDispatchJournal(permit?.journalBytes, 'fixture')
          if (journal.slot !== slot || journal.requestSha256 !== requestSha256 || permit.slot !== slot ||
              permit.requestSha256 !== requestSha256) blocked()
          // Consume before native dispatch. A thrown/timeout result is unknown
          // and cannot be repeated with the same operation object.
          dispatched = true
          const createdUid = sanitizeCreatedAccount(await exactPost(Client, URLS.authCreate, body), account)
          const produced = { [identity === 'ownerA' ? 'ownerAUid' : 'ownerBUid']: createdUid }
          outcomeSha256 = jsonHash({ uidSha256: sha256(createdUid), emailVerified: true, disabled: false })
          return { requestSha256, outcomeSha256, producedSha256: jsonHash(produced) }
        },
        readback: async () => {
          if (!outcomeSha256) blocked()
          const lookup = await exactPost(Client, URLS.authLookup, { localId: [account.uid] })
          if (!record(lookup) || !Array.isArray(lookup.users) || lookup.users.length !== 1) blocked()
          const uid = sanitizeCreatedAccount(lookup.users[0], account)
          const produced = { [identity === 'ownerA' ? 'ownerAUid' : 'ownerBUid']: uid }
          completed.add(identity)
          return { requestSha256, outcomeSha256, readbackSha256: jsonHash({ uidSha256: sha256(uid), emailVerified: true, disabled: false }), produced }
        },
      })
    },
  })
}

const CALLABLE_URLS = Object.freeze(Object.fromEntries(LIVE_FUNCTIONS.map(name => [
  name, `https://us-central1-${PROJECT}.cloudfunctions.net/${name}`,
])))

function callableBody(callable, input) {
  const schemas = {
    createCompany: ['idempotencyKey', 'ownerName', 'companyName', 'legalType'],
    inviteMember: ['companyId', 'email', 'role'], listInvitations: ['companyId', 'pageSize'],
    cancelInvite: ['companyId', 'inviteId'], resendInvite: ['companyId', 'inviteId'],
    previewInvite: ['inviteId', 'token'], acceptInvite: ['inviteId', 'token'], getCompanyAccess: ['companyId'],
  }
  if (!schemas[callable] || !exactKeys(input, schemas[callable])) blocked()
  const body = JSON.stringify({ data: input })
  if (Buffer.byteLength(body) > 4096) blocked()
  return body
}

async function callableJson(response) {
  if (!response || typeof response.json !== 'function' || typeof response.status !== 'number') blocked()
  let value
  try { value = await response.json() } catch { blocked() }
  if (!record(value)) blocked()
  return { status: response.status, value }
}

async function heldCallableJson(response) {
  const status = typeof response?.status === 'function' ? response.status() : null
  if (!Number.isSafeInteger(status) || typeof response?.json !== 'function') blocked()
  let value
  try { value = await response.json() } catch { blocked() }
  if (!record(value)) blocked()
  return { status, value }
}

const SAFE_APP_CODES = new Set([
  'auth_required', 'email_unverified', 'invalid_request', 'membership_not_found',
  'membership_inactive', 'membership_data_error', 'insufficient_role', 'last_admin',
  'idempotency_conflict', 'maintenance_mode', 'invitation_already_pending',
  'invitation_not_found', 'invitation_not_pending', 'invitation_resend_cooldown',
  'invitation_resend_limit_reached', 'invite_invalid', 'invite_expired',
  'invite_revoked', 'invite_already_used', 'membership_conflict', 'internal_error',
])
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value)
const utc = value => typeof value === 'string' && new Date(value).toISOString() === value
const rawCapability = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

function sanitizeCallableResult(callable, response, expectedAppCode, capabilityVault) {
  const { status, value } = response
  if (expectedAppCode !== null) {
    if (!SAFE_APP_CODES.has(expectedAppCode) || status < 400 || !exactKeys(value, ['error']) ||
        !record(value.error) || value.error.details?.appCode !== expectedAppCode) blocked()
    return { disposition: 'DENIED', appCode: expectedAppCode }
  }
  if (status !== 200 || !exactKeys(value, ['result']) || !record(value.result)) blocked()
  const result = value.result
  if (callable === 'createCompany') {
    if (!exactKeys(result, ['companyId']) || !safeId(result.companyId)) blocked()
    return { disposition: 'SUCCESS', companyId: result.companyId }
  }
  if (callable === 'inviteMember' || callable === 'resendInvite') {
    if (!exactKeys(result, ['inviteId', 'token', 'expiresAtUtc']) || !safeId(result.inviteId) ||
        !rawCapability(result.token) || !utc(result.expiresAtUtc)) blocked()
    const capabilitySha256 = sha256(result.token)
    if (capabilityVault.has(capabilitySha256)) blocked()
    capabilityVault.set(capabilitySha256, result.token)
    return { disposition: 'SUCCESS', inviteId: result.inviteId, capabilitySha256, expiresAtUtc: result.expiresAtUtc }
  }
  if (callable === 'cancelInvite') {
    if (!exactKeys(result, ['inviteId', 'revokedAtUtc']) || !safeId(result.inviteId) || !utc(result.revokedAtUtc)) blocked()
    return { disposition: 'SUCCESS', inviteId: result.inviteId, revokedAtUtc: result.revokedAtUtc }
  }
  if (callable === 'acceptInvite') {
    if (!exactKeys(result, ['companyId']) || !safeId(result.companyId)) blocked()
    return { disposition: 'SUCCESS', companyId: result.companyId }
  }
  if (callable === 'listInvitations') {
    if (!exactKeys(result, ['items', 'nextCursor']) || !Array.isArray(result.items) ||
        !(result.nextCursor === null || (typeof result.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,500}$/.test(result.nextCursor)))) blocked()
    for (const item of result.items) {
      if (!exactKeys(item, ['inviteId', 'emailNormalized', 'role', 'status', 'createdAtUtc', 'expiresAtUtc', 'resendCount', 'lastSentAtUtc', 'createdBy']) ||
          !safeId(item.inviteId) || !['viewer', 'accountant', 'admin'].includes(item.role) ||
          !['pending', 'accepted', 'revoked'].includes(item.status) || !utc(item.createdAtUtc) || !utc(item.expiresAtUtc) ||
          !Number.isSafeInteger(item.resendCount) || item.resendCount < 0 || item.resendCount > 5 ||
          !(item.lastSentAtUtc === null || utc(item.lastSentAtUtc)) || !safeId(item.createdBy) ||
          normalizeMailbox(item.emailNormalized) !== item.emailNormalized) blocked()
    }
    return { disposition: 'SUCCESS', itemCount: result.items.length, itemsSha256: jsonHash(result.items), nextCursorPresent: result.nextCursor !== null }
  }
  if (callable === 'previewInvite') {
    if (!exactKeys(result, ['maskedEmail', 'companyDisplayName', 'roleLabel', 'expiresAt']) ||
        typeof result.maskedEmail !== 'string' || !result.maskedEmail || typeof result.companyDisplayName !== 'string' ||
        !result.companyDisplayName || result.companyDisplayName.length > 300 ||
        !['Наблюдатель', 'Бухгалтер', 'Администратор'].includes(result.roleLabel) || !utc(result.expiresAt)) blocked()
    return { disposition: 'SUCCESS', previewSha256: jsonHash(result), expiresAt: result.expiresAt }
  }
  if (callable === 'getCompanyAccess') {
    if (!exactKeys(result, ['companyId', 'uid', 'role']) || !safeId(result.companyId) || !safeId(result.uid) ||
        !['viewer', 'accountant', 'admin'].includes(result.role)) blocked()
    return { disposition: 'SUCCESS', companyId: result.companyId, uid: result.uid, role: result.role }
  }
  blocked()
}

/** Fixed callable URL/verb/body envelope with no retry or generic HTTP hook. */
export function createCallableDispatchPrimitive({ transport, getIdToken }) {
  if (!transport || typeof transport.authorizeRequest !== 'function' || typeof transport.fetch !== 'function' ||
      typeof getIdToken !== 'function') blocked()
  const capabilityVault = new Map()
  const dispatchedJournals = new Set()
  const preparedCalls = new WeakMap()
  const resolveInput = (callable, input) => {
    if (!['previewInvite', 'acceptInvite'].includes(callable) || !exactKeys(input, ['inviteId', 'capabilitySha256'])) return input
    if (!safeId(input.inviteId) || !hex64(input.capabilitySha256)) blocked()
    const token = capabilityVault.get(input.capabilitySha256)
    if (!token) blocked()
    return { inviteId: input.inviteId, token }
  }
  const dispatch = async ({ callable, identity, input, permit, journalKind, expectedAppCode = null, bind = null }) => {
    if (!Object.hasOwn(CALLABLE_URLS, callable) ||
        !['fixture', 'callable'].includes(journalKind) || !(expectedAppCode === null || typeof expectedAppCode === 'string') ||
        (identity !== 'anonymous' && !['ownerA', 'ownerB', 'ownerMailbox'].includes(identity))) blocked()
    const body = callableBody(callable, resolveInput(callable, input))
    const requestSha256 = sha256(body)
    const journal = authorizePendingDispatchJournal(permit?.journalBytes, journalKind)
    const fixtureSpec = journalKind === 'fixture'
      ? FIXTURE_MUTATION_SLOT_SPECS.find(row => row.slot === journal.slot) : null
    if (journal.requestSha256 !== requestSha256 || permit.requestSha256 !== requestSha256 ||
        (journalKind === 'fixture' && (permit.slot !== journal.slot || fixtureSpec?.callable !== callable)) ||
        permit?.binding?.identity !== identity ||
        (journalKind === 'callable' && journal.callable !== callable)) blocked()
    if (dispatchedJournals.has(journal.journalSha256)) blocked()
    dispatchedJournals.add(journal.journalSha256)
    const token = identity === 'anonymous' ? null : await getIdToken(identity)
    if (identity !== 'anonymous' && (typeof token !== 'string' ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))) blocked()
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (bind !== null) {
      if (typeof bind !== 'function') blocked()
      const decision = await bind({ method: 'POST', url: CALLABLE_URLS[callable], postData: body })
      if (!record(decision) || decision.action !== 'continue') blocked()
    }
    transport.authorizeRequest({ method: 'POST', url: CALLABLE_URLS[callable], bodySha256: requestSha256 })
    const response = await callableJson(await transport.fetch(CALLABLE_URLS[callable], {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(30_000),
    }))
    const sanitized = sanitizeCallableResult(callable, response, expectedAppCode, capabilityVault)
    assertNoSecretMaterial(sanitized)
    return frozen({ requestSha256, outcomeSha256: jsonHash(sanitized), sanitized })
  }
  return Object.freeze({
    prepare({ callable, identity, input }) {
      const resolved = resolveInput(callable, input)
      const body = callableBody(callable, resolved)
      const handle = Object.freeze({ requestSha256: sha256(body) })
      preparedCalls.set(handle, { callable, identity, input: clone(input) })
      return handle
    },
    async dispatchPrepared(handle, options) {
      const prepared = preparedCalls.get(handle)
      if (!prepared || !exactKeys(options, ['permit', 'journalKind', 'expectedAppCode', 'bind'])) blocked()
      preparedCalls.delete(handle)
      return dispatch({ ...prepared, ...options })
    },
    async summarizeHeld(callable, response, meta) {
      if (!['acceptInvite', 'getCompanyAccess'].includes(callable) ||
          !exactKeys(meta, ['requestSha256']) || !hex64(meta.requestSha256)) blocked()
      const sanitized = sanitizeCallableResult(callable, await heldCallableJson(response), null, capabilityVault)
      assertNoSecretMaterial(sanitized)
      return frozen({ requestSha256: meta.requestSha256, outcomeSha256: jsonHash(sanitized), producedSha256: jsonHash({}) })
    },
    async withCapability(capabilitySha256, action) {
      if (!hex64(capabilitySha256) || typeof action !== 'function') blocked()
      const capability = capabilityVault.get(capabilitySha256)
      if (!capability) blocked()
      const result = await action(capability)
      if (!exactKeys(result, ['completed']) || result.completed !== true) blocked()
      return frozen(result)
    },
    dispatch,
  })
}

const DOCUMENTS_ROOT = `${DATABASE}/documents`
const DOCUMENTS_URL = `https://firestore.googleapis.com/v1/${DOCUMENTS_ROOT}`
const rfc3339 = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value))
const safePath = value => typeof value === 'string' &&
  /^(?:users|user_bootstrap|companies|company_data|invitations|invitationLocks)\/[a-zA-Z0-9_-]{1,200}(?:\/(?:members|audit_events)\/[a-zA-Z0-9_-]{1,200})?$/.test(value)

function decodeFirestoreValue(value) {
  if (!record(value) || Object.keys(value).length !== 1) blocked()
  if (Object.hasOwn(value, 'nullValue') && value.nullValue === null) return null
  if (Object.hasOwn(value, 'stringValue') && typeof value.stringValue === 'string') return value.stringValue
  if (Object.hasOwn(value, 'booleanValue') && typeof value.booleanValue === 'boolean') return value.booleanValue
  if (Object.hasOwn(value, 'timestampValue') && rfc3339(value.timestampValue)) return value.timestampValue
  if (Object.hasOwn(value, 'integerValue') && /^-?\d+$/.test(value.integerValue ?? '')) {
    const number = Number(value.integerValue)
    if (!Number.isSafeInteger(number)) blocked()
    return number
  }
  if (Object.hasOwn(value, 'doubleValue') && Number.isFinite(value.doubleValue)) return value.doubleValue
  if (Object.hasOwn(value, 'arrayValue') && record(value.arrayValue) &&
      Object.keys(value.arrayValue).every(key => key === 'values') &&
      (value.arrayValue.values === undefined || Array.isArray(value.arrayValue.values))) {
    return (value.arrayValue.values ?? []).map(decodeFirestoreValue)
  }
  if (Object.hasOwn(value, 'mapValue') && record(value.mapValue) &&
      Object.keys(value.mapValue).every(key => key === 'fields') &&
      (value.mapValue.fields === undefined || record(value.mapValue.fields))) {
    return decodeFirestoreFields(value.mapValue.fields ?? {})
  }
  blocked()
}

function decodeFirestoreFields(fields) {
  if (!record(fields)) blocked()
  return Object.fromEntries(Object.keys(fields).sort().map(key => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(key)) blocked()
    return [key, decodeFirestoreValue(fields[key])]
  }))
}

function decodeDocument(value, allowedNames) {
  if (!exactKeys(value, ['name', 'fields', 'createTime', 'updateTime']) || !allowedNames.has(value.name) ||
      !rfc3339(value.createTime) || !rfc3339(value.updateTime) || Date.parse(value.updateTime) < Date.parse(value.createTime)) blocked()
  return frozen({ name: value.name, fields: decodeFirestoreFields(value.fields), createTime: value.createTime, updateTime: value.updateTime })
}

function expectExactFields(value, keys) {
  if (!exactKeys(value, keys)) blocked()
  return value
}

function expectCompany(doc, id, ownerUid) {
  const keys = Object.hasOwn(doc.fields, 'inn')
    ? ['id', 'name', 'legalType', 'inn', 'currency', 'createdAt', 'ownerId']
    : ['id', 'name', 'legalType', 'currency', 'createdAt', 'ownerId']
  expectExactFields(doc.fields, keys)
  if (doc.fields.id !== id || doc.fields.ownerId !== ownerUid || doc.fields.currency !== 'RUB' ||
      !['ooo', 'ip'].includes(doc.fields.legalType) || typeof doc.fields.name !== 'string' || !doc.fields.name.trim() ||
      !utc(doc.fields.createdAt) || (Object.hasOwn(doc.fields, 'inn') && typeof doc.fields.inn !== 'string')) blocked()
}

function expectCompanyData(doc) {
  expectExactFields(doc.fields, ['accounts', 'categories', 'counterparties', 'transactions', 'projects', 'rules'])
  for (const key of ['accounts', 'categories', 'counterparties', 'transactions', 'projects', 'rules']) if (!Array.isArray(doc.fields[key])) blocked()
}

function expectMembership(doc, { uid, role, invitedBy }) {
  expectExactFields(doc.fields, invitedBy === null
    ? ['uid', 'role', 'status', 'createdAt', 'updatedAt']
    : ['uid', 'role', 'status', 'createdAt', 'updatedAt', 'invitedBy'])
  if (doc.fields.uid !== uid || doc.fields.role !== role || doc.fields.status !== 'active' ||
      !rfc3339(doc.fields.createdAt) || !rfc3339(doc.fields.updatedAt) ||
      (invitedBy !== null && doc.fields.invitedBy !== invitedBy)) blocked()
}

function expectProfile(doc, { uid, companyId, role, emailSha256, companies = null }) {
  const keys = Object.hasOwn(doc.fields, 'companies')
    ? ['id', 'name', 'email', 'role', 'companyId', 'createdAt', 'companies']
    : ['id', 'name', 'email', 'role', 'companyId', 'createdAt']
  expectExactFields(doc.fields, keys)
  if (doc.fields.id !== uid || doc.fields.companyId !== companyId || doc.fields.role !== role ||
      typeof doc.fields.name !== 'string' || !doc.fields.name || normalizeMailbox(doc.fields.email) !== doc.fields.email ||
      sha256(doc.fields.email) !== emailSha256 || !utc(doc.fields.createdAt)) blocked()
  if (companies === null) {
    if (Object.hasOwn(doc.fields, 'companies')) blocked()
  } else if (JSON.stringify(doc.fields.companies) !== JSON.stringify(companies)) blocked()
}

function expectBootstrap(doc, uid, companyId) {
  expectExactFields(doc.fields, ['idempotencyKey', 'fingerprint', 'result', 'createdAt'])
  if (typeof doc.fields.idempotencyKey !== 'string' || !doc.fields.idempotencyKey || !hex64(doc.fields.fingerprint) ||
      !exactKeys(doc.fields.result, ['companyId']) || doc.fields.result.companyId !== companyId || !rfc3339(doc.fields.createdAt)) blocked()
}

function expectInvitation(doc, expected) {
  const statusKeys = expected.status === 'revoked' ? ['revokedAt', 'revokedBy'] : ['acceptedAt', 'acceptedByUid']
  expectExactFields(doc.fields, [
    'companyId', 'emailNormalized', 'role', 'tokenHash', 'status', 'expiresAt', 'createdBy',
    'createdAt', 'updatedAt', 'resendCount', 'lastSentAt', ...statusKeys,
  ])
  if (doc.fields.companyId !== expected.companyId || sha256(doc.fields.emailNormalized) !== expected.emailSha256 ||
      doc.fields.role !== expected.role || doc.fields.tokenHash !== expected.capabilitySha256 || doc.fields.status !== expected.status ||
      doc.fields.createdBy !== expected.createdBy || doc.fields.resendCount !== expected.resendCount ||
      !rfc3339(doc.fields.expiresAt) || !rfc3339(doc.fields.createdAt) || !rfc3339(doc.fields.updatedAt) ||
      !(doc.fields.lastSentAt === null || rfc3339(doc.fields.lastSentAt))) blocked()
  if (expected.status === 'revoked' && (!rfc3339(doc.fields.revokedAt) || doc.fields.revokedBy !== expected.createdBy)) blocked()
  if (expected.status === 'accepted' && (!rfc3339(doc.fields.acceptedAt) || doc.fields.acceptedByUid !== expected.acceptedByUid)) blocked()
}

function finalDocumentPaths(plan, state) {
  const invitations = [state.mailboxCancelledInviteId, state.mailboxFinalInviteId, state.ownerBInviteId].map(id => `invitations/${id}`)
  const paths = [
    ...plan.companies.flatMap(row => [row.path, row.dataPath]),
    ...plan.authUsers.flatMap(row => [row.profilePath, ...(row.bootstrapPath ? [row.bootstrapPath] : [])]),
    ...plan.members.map(row => row.path), ...invitations, ...plan.locks.map(row => row.path),
  ]
  if (paths.length !== 18 || paths.some(path => !safePath(path)) || new Set(paths).size !== paths.length) blocked()
  return paths
}

async function batchGetDocuments(Client, paths) {
  const names = paths.map(path => `${DOCUMENTS_ROOT}/${path}`)
  const allowed = new Set(names)
  const body = { documents: names }
  const value = await exactPost(Client, `${DOCUMENTS_URL}:batchGet`, body)
  if (!Array.isArray(value) || value.length !== names.length) blocked()
  const docs = new Map()
  for (const row of value) {
    if (!exactKeys(row, ['found', 'readTime']) || !rfc3339(row.readTime)) blocked()
    const doc = decodeDocument(row.found, allowed)
    if (docs.has(doc.name)) blocked()
    docs.set(doc.name, doc)
  }
  if (docs.size !== names.length) blocked()
  return { docs, requestSha256: jsonHash(body) }
}

async function batchGetIncrementalSnapshot(Client, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 8 ||
      paths.some(path => !safePath(path)) || new Set(paths).size !== paths.length) blocked()
  const names = paths.map(path => `${DOCUMENTS_ROOT}/${path}`)
  const allowed = new Set(names), body = { documents: names }
  const value = await exactPost(Client, `${DOCUMENTS_URL}:batchGet`, body)
  if (!Array.isArray(value) || value.length !== names.length) blocked()
  const rows = new Map(), readTimes = []
  for (const row of value) {
    if (!record(row) || !rfc3339(row.readTime) || (Object.hasOwn(row, 'found') === Object.hasOwn(row, 'missing'))) blocked()
    readTimes.push(row.readTime)
    if (Object.hasOwn(row, 'found')) {
      const doc = decodeDocument(row.found, allowed)
      if (rows.has(doc.name)) blocked()
      rows.set(doc.name, { path: doc.name.slice(DOCUMENTS_ROOT.length + 1), exists: true,
        stateSha256: jsonHash(doc.fields), createTime: doc.createTime, updateTime: doc.updateTime, fields: doc.fields })
    } else {
      if (typeof row.missing !== 'string' || !allowed.has(row.missing) || rows.has(row.missing)) blocked()
      rows.set(row.missing, { path: row.missing.slice(DOCUMENTS_ROOT.length + 1), exists: false,
        stateSha256: null, createTime: null, updateTime: null, fields: null })
    }
  }
  if (rows.size !== names.length) blocked()
  return frozen({ documents: names.map(name => rows.get(name)), observedAt: readTimes.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) })
}

async function incrementalAuditSnapshot(Client, companyId) {
  if (!safeId(companyId)) blocked()
  const body = { structuredQuery: { from: [{ collectionId: 'audit_events' }], orderBy: [
    { field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' },
    { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
  ], limit: 20 } }
  const value = await exactPost(Client, `${DOCUMENTS_URL}/companies/${companyId}:runQuery`, body)
  if (!Array.isArray(value) || value.length > 20) blocked()
  const prefix = `${DOCUMENTS_ROOT}/companies/${companyId}/audit_events/`, rows = [], readTimes = []
  for (const row of value) {
    if (!record(row) || !rfc3339(row.readTime)) blocked()
    readTimes.push(row.readTime)
    if (!Object.hasOwn(row, 'document')) {
      if (!exactKeys(row, ['readTime']) || value.length !== 1) blocked()
      continue
    }
    if (!exactKeys(row, ['document', 'readTime']) || typeof row.document?.name !== 'string' || !row.document.name.startsWith(prefix)) blocked()
    const id = row.document.name.slice(prefix.length)
    if (!safeId(id)) blocked()
    const doc = decodeDocument(row.document, new Set([row.document.name]))
    rows.push({ companyId, id, stateSha256: jsonHash(doc.fields), createTime: doc.createTime, updateTime: doc.updateTime,
      fields: doc.fields })
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length) blocked()
  return frozen({ rows, observedAt: readTimes.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) })
}

function incrementalPaths(slot, binding, produced, state) {
  const company = produced.companyAId ?? produced.companyBId
  if (['createCompanyA', 'createCompanyB'].includes(slot)) return company ? [
      `companies/${company}`, `company_data/${company}`, `companies/${company}/members/${binding.actorUid}`,
      `users/${binding.actorUid}`, `user_bootstrap/${binding.actorUid}`,
    ] : [`users/${binding.actorUid}`, `user_bootstrap/${binding.actorUid}`]
  const invitation = produced.mailboxCancelledInviteId ?? produced.mailboxFinalInviteId ??
    produced.ownerBInviteId ?? binding.invitationId
  if (['createMailboxCancelledInvite', 'createMailboxFinalInvite', 'createOwnerBInvite'].includes(slot)) {
    const lock = produced.mailboxLockId ?? produced.ownerBLockId ??
      (slot === 'createOwnerBInvite' ? state.ownerBLockId : state.mailboxLockId)
    return invitation ? [`invitations/${invitation}`, `invitationLocks/${lock}`] : lock ? [`invitationLocks/${lock}`] : []
  }
  if (['cancelMailboxInvite', 'denyMailboxResendCooldown', 'resendMailboxFinalInvite'].includes(slot)) {
    return [`invitations/${invitation}`, `invitationLocks/${state.mailboxLockId}`]
  }
  if (['denyWrongIdentityAccept', 'denyUnverifiedMailboxAccept', 'acceptMailboxFinalInvite',
    'acceptOwnerBInvite', 'replayMailboxFinalInvite'].includes(slot)) {
    const companyId = slot === 'acceptOwnerBInvite' ? state.companyAId : state.companyAId
    const lockId = slot === 'acceptOwnerBInvite' ? state.ownerBLockId : state.mailboxLockId
    return [`invitations/${invitation}`, `invitationLocks/${lockId}`,
      `companies/${companyId}/members/${binding.actorUid}`, `users/${binding.actorUid}`]
  }
  if (binding.expectation && binding.invitationId) {
    const lockId = binding.invitationId === state.mailboxCancelledInviteId || binding.invitationId === state.mailboxFinalInviteId
      ? state.mailboxLockId : state.ownerBLockId
    return [`invitations/${binding.invitationId}`, `invitationLocks/${lockId}`]
  }
  if (binding.expectation && binding.companyId) return [
    `companies/${binding.companyId}`, `companies/${binding.companyId}/members/${binding.actorUid}`,
  ]
  if (binding.companyId) return [`companies/${binding.companyId}`]
  blocked()
}

const AUDIT_DELTA_SLOTS = new Set([
  'createCompanyA', 'createCompanyB', 'createMailboxCancelledInvite', 'cancelMailboxInvite',
  'createMailboxFinalInvite', 'resendMailboxFinalInvite', 'acceptMailboxFinalInvite',
  'createOwnerBInvite', 'acceptOwnerBInvite',
])
const SLOT_AUDIT_ACTION = Object.freeze({
  createCompanyA: 'company_created', createCompanyB: 'company_created',
  createMailboxCancelledInvite: 'member_invited', cancelMailboxInvite: 'invitation_cancelled',
  createMailboxFinalInvite: 'member_invited', resendMailboxFinalInvite: 'invitation_resent',
  acceptMailboxFinalInvite: 'invite_accepted', createOwnerBInvite: 'member_invited',
  acceptOwnerBInvite: 'invite_accepted',
})

function incrementalDocument(snapshot, path) {
  return snapshot.documents.find(row => row.path === path) ?? blocked()
}

function requireFields(row, keys) {
  if (!row.exists || !exactKeys(row.fields, keys)) blocked()
  return row.fields
}

function assertInvitationFields(fields, expected) {
  const suffix = expected.status === 'accepted' ? ['acceptedAt', 'acceptedByUid']
    : expected.status === 'revoked' ? ['revokedAt', 'revokedBy'] : []
  if (!exactKeys(fields, ['companyId', 'emailNormalized', 'role', 'tokenHash', 'status', 'expiresAt',
    'createdBy', 'createdAt', 'updatedAt', 'resendCount', 'lastSentAt', ...suffix]) ||
      fields.companyId !== expected.companyId || fields.role !== expected.role || fields.status !== expected.status ||
      fields.createdBy !== expected.createdBy || fields.resendCount !== expected.resendCount || !hex64(fields.tokenHash) ||
      !rfc3339(fields.expiresAt) || !rfc3339(fields.createdAt) || !rfc3339(fields.updatedAt) ||
      !rfc3339(fields.lastSentAt) || Date.parse(fields.updatedAt) < Date.parse(fields.createdAt)) blocked()
  if (expected.subjectSha256 && sha256(fields.emailNormalized) !== expected.subjectSha256) blocked()
  if (expected.capabilitySha256 && fields.tokenHash !== expected.capabilitySha256) blocked()
  if (expected.status === 'accepted' &&
      (fields.acceptedByUid !== expected.actorUid || !rfc3339(fields.acceptedAt))) blocked()
  if (expected.status === 'revoked' &&
      (fields.revokedBy !== expected.actorUid || !rfc3339(fields.revokedAt))) blocked()
}

function requireUnchangedDocument(prior, after, path) {
  const left = incrementalDocument(prior, path), right = incrementalDocument(after, path)
  if (JSON.stringify(left) !== JSON.stringify(right)) blocked()
}

const sameInstant = (left, right) => rfc3339(left) && rfc3339(right) && Date.parse(left) === Date.parse(right)
const afterOrEqual = (left, right) => rfc3339(left) && rfc3339(right) && Date.parse(left) >= Date.parse(right)

function requireCreatedAfterCapture(row, prior) {
  if (!row.exists || !prior || !rfc3339(prior.observedAt) || !afterOrEqual(row.createTime, prior.observedAt) ||
      !sameInstant(row.createTime, row.updateTime)) blocked()
}

function requireUpdatedFrom(row, priorRow) {
  if (!row.exists || !priorRow?.exists || !afterOrEqual(row.updateTime, priorRow.updateTime) ||
      sameInstant(row.updateTime, priorRow.updateTime) || !sameInstant(row.createTime, priorRow.createTime)) blocked()
}

function assertLock(snapshot, path, invitationId) {
  const row = incrementalDocument(snapshot, path)
  const fields = requireFields(row, ['currentInviteId'])
  if (fields.currentInviteId !== invitationId) blocked()
  return row
}

function assertIncrementalSemantics(input, after, prior) {
  const { slot, binding, produced, state } = input
  if (['createCompanyA', 'createCompanyB'].includes(slot)) {
    const companyId = produced.companyAId ?? produced.companyBId
    const companyRow = incrementalDocument(after, `companies/${companyId}`)
    expectCompany(companyRow, companyId, binding.actorUid)
    const dataRow = incrementalDocument(after, `company_data/${companyId}`)
    expectCompanyData(dataRow)
    const memberRow = incrementalDocument(after, `companies/${companyId}/members/${binding.actorUid}`)
    expectMembership(memberRow, { uid: binding.actorUid, role: 'admin', invitedBy: null })
    const profile = incrementalDocument(after, `users/${binding.actorUid}`)
    const emailSha256 = slot === 'createCompanyA' ? state.ownerASubjectSha256 : state.ownerBSubjectSha256
    if (!hex64(emailSha256)) blocked()
    expectProfile(profile, { uid: binding.actorUid, companyId, role: 'admin', emailSha256 })
    const bootstrap = incrementalDocument(after, `user_bootstrap/${binding.actorUid}`)
    expectBootstrap(bootstrap, binding.actorUid, companyId)
    if (sha256(bootstrap.fields.idempotencyKey) !== binding.idempotencyKeySha256 || !prior || prior.documents.some(row => row.exists)) blocked()
    for (const row of [companyRow, dataRow, memberRow, profile, bootstrap]) requireCreatedAfterCapture(row, prior)
    if (!sameInstant(memberRow.fields.createdAt, memberRow.updateTime) || !sameInstant(memberRow.fields.updatedAt, memberRow.updateTime) ||
        !sameInstant(bootstrap.fields.createdAt, bootstrap.updateTime) ||
        Date.parse(companyRow.fields.createdAt) > Date.parse(companyRow.createTime) ||
        Date.parse(profile.fields.createdAt) > Date.parse(profile.createTime)) blocked()
  } else if (['createMailboxCancelledInvite', 'createMailboxFinalInvite', 'createOwnerBInvite'].includes(slot)) {
    const invitationId = produced.mailboxCancelledInviteId ?? produced.mailboxFinalInviteId ?? produced.ownerBInviteId
    const capability = produced.mailboxCancelledCapabilitySha256 ?? produced.mailboxFinalCapabilitySha256 ?? produced.ownerBCapabilitySha256
    const invitation = incrementalDocument(after, `invitations/${invitationId}`)
    if (!invitation.exists) blocked()
    assertInvitationFields(invitation.fields, { companyId: binding.companyId, role: binding.role, status: 'pending',
      createdBy: binding.actorUid, resendCount: 0, capabilitySha256: capability, subjectSha256: binding.subjectSha256 })
    const lockId = produced.mailboxLockId ?? produced.ownerBLockId
    const lockPath = `invitationLocks/${lockId}`, lock = assertLock(after, lockPath, invitationId)
    requireCreatedAfterCapture(invitation, prior)
    if (!sameInstant(invitation.fields.createdAt, invitation.updateTime) || !sameInstant(invitation.fields.updatedAt, invitation.updateTime) ||
        !sameInstant(invitation.fields.lastSentAt, invitation.updateTime)) blocked()
    if (slot === 'createMailboxFinalInvite') {
      const priorLock = assertLock(prior, lockPath, state.mailboxCancelledInviteId)
      requireUpdatedFrom(lock, priorLock)
    } else requireCreatedAfterCapture(lock, prior)
  } else if (slot === 'cancelMailboxInvite') {
    const invitation = incrementalDocument(after, `invitations/${binding.invitationId}`)
    if (!invitation.exists) blocked()
    const priorInvitation = incrementalDocument(prior, `invitations/${binding.invitationId}`)
    assertInvitationFields(invitation.fields, { companyId: binding.companyId, role: priorInvitation.fields.role, status: 'revoked',
      createdBy: priorInvitation.fields.createdBy, resendCount: priorInvitation.fields.resendCount,
      capabilitySha256: priorInvitation.fields.tokenHash, subjectSha256: state.mailboxSha256, actorUid: binding.actorUid })
    requireUpdatedFrom(invitation, priorInvitation)
    if (!sameInstant(invitation.fields.revokedAt, invitation.updateTime) || !sameInstant(invitation.fields.updatedAt, invitation.updateTime)) blocked()
    requireUnchangedDocument(prior, after, `invitationLocks/${state.mailboxLockId}`)
  } else if (slot === 'resendMailboxFinalInvite') {
    const invitation = incrementalDocument(after, `invitations/${binding.invitationId}`)
    const priorInvitation = incrementalDocument(prior, `invitations/${binding.invitationId}`)
    if (!invitation.exists || priorInvitation.fields.tokenHash === produced.mailboxFinalCapabilitySha256 ||
        invitation.updateTime === priorInvitation.updateTime) blocked()
    assertInvitationFields(invitation.fields, { companyId: binding.companyId, role: priorInvitation.fields.role, status: 'pending',
      createdBy: priorInvitation.fields.createdBy, resendCount: priorInvitation.fields.resendCount + 1,
      capabilitySha256: produced.mailboxFinalCapabilitySha256, subjectSha256: state.mailboxSha256 })
    requireUpdatedFrom(invitation, priorInvitation)
    if (!sameInstant(invitation.fields.lastSentAt, invitation.updateTime) || !sameInstant(invitation.fields.updatedAt, invitation.updateTime)) blocked()
    requireUnchangedDocument(prior, after, `invitationLocks/${state.mailboxLockId}`)
  } else if (['acceptMailboxFinalInvite', 'acceptOwnerBInvite', 'replayMailboxFinalInvite'].includes(slot)) {
    const invitation = incrementalDocument(after, `invitations/${binding.invitationId}`)
    const role = slot === 'acceptOwnerBInvite' ? 'viewer' : 'accountant'
    const member = incrementalDocument(after, `companies/${state.companyAId}/members/${binding.actorUid}`)
    const profile = incrementalDocument(after, `users/${binding.actorUid}`)
    const expectedCapability = slot === 'acceptOwnerBInvite' ? state.ownerBCapabilitySha256 : state.mailboxFinalCapabilitySha256
    assertInvitationFields(invitation.fields, { companyId: state.companyAId, role, status: 'accepted',
      createdBy: state.ownerAUid, resendCount: slot === 'acceptOwnerBInvite' ? 0 : 1,
      capabilitySha256: expectedCapability, subjectSha256: slot === 'acceptOwnerBInvite' ? state.ownerBSubjectSha256 : state.mailboxSha256,
      actorUid: binding.actorUid })
    expectMembership(member, { uid: binding.actorUid, role, invitedBy: state.ownerAUid })
    expectProfile(profile, { uid: binding.actorUid, companyId: slot === 'acceptOwnerBInvite' ? state.companyBId : state.companyAId,
      role: slot === 'acceptOwnerBInvite' ? 'admin' : 'accountant',
      emailSha256: slot === 'acceptOwnerBInvite' ? state.ownerBSubjectSha256 : state.mailboxSha256,
      companies: slot === 'acceptOwnerBInvite'
        ? [{ companyId: state.companyBId, role: 'admin' }, { companyId: state.companyAId, role: 'viewer' }] : null })
    const lockId = slot === 'acceptOwnerBInvite' ? state.ownerBLockId : state.mailboxLockId
    assertLock(prior, `invitationLocks/${lockId}`, binding.invitationId)
    assertLock(after, `invitationLocks/${lockId}`, binding.invitationId)
    requireUnchangedDocument(prior, after, `invitationLocks/${lockId}`)
    if (slot !== 'replayMailboxFinalInvite') {
      requireUpdatedFrom(invitation, incrementalDocument(prior, `invitations/${binding.invitationId}`))
      if (!sameInstant(invitation.fields.acceptedAt, invitation.updateTime) || !sameInstant(invitation.fields.updatedAt, invitation.updateTime)) blocked()
      if (slot === 'acceptMailboxFinalInvite') {
        if (incrementalDocument(prior, `companies/${state.companyAId}/members/${binding.actorUid}`).exists ||
            incrementalDocument(prior, `users/${binding.actorUid}`).exists) blocked()
        requireCreatedAfterCapture(member, prior); requireCreatedAfterCapture(profile, prior)
      } else {
        if (incrementalDocument(prior, `companies/${state.companyAId}/members/${binding.actorUid}`).exists) blocked()
        const priorProfile = incrementalDocument(prior, `users/${binding.actorUid}`)
        expectProfile(priorProfile, { uid: binding.actorUid, companyId: state.companyBId, role: 'admin',
          emailSha256: state.ownerBSubjectSha256 })
        requireCreatedAfterCapture(member, prior); requireUpdatedFrom(profile, priorProfile)
      }
    }
  } else if (['denyWrongIdentityAccept', 'denyUnverifiedMailboxAccept'].includes(slot)) {
    const invitation = incrementalDocument(after, `invitations/${binding.invitationId}`)
    assertInvitationFields(invitation.fields, { companyId: state.companyAId, role: 'accountant', status: 'pending',
      createdBy: state.ownerAUid, resendCount: 1, capabilitySha256: state.mailboxFinalCapabilitySha256,
      subjectSha256: state.mailboxSha256 })
    assertLock(prior, `invitationLocks/${state.mailboxLockId}`, binding.invitationId)
    assertLock(after, `invitationLocks/${state.mailboxLockId}`, binding.invitationId)
  } else if (binding.expectation) {
    if (binding.invitationId) {
      const invitation = incrementalDocument(after, `invitations/${binding.invitationId}`)
      if (!invitation.exists) blocked()
      const lockId = binding.invitationId === state.ownerBInviteId ? state.ownerBLockId : state.mailboxLockId
      assertLock(prior, `invitationLocks/${lockId}`, binding.invitationId)
      assertLock(after, `invitationLocks/${lockId}`, binding.invitationId)
    } else {
      const company = incrementalDocument(after, `companies/${binding.companyId}`)
      const member = incrementalDocument(after, `companies/${binding.companyId}/members/${binding.actorUid}`)
      if (!company.exists || (binding.expectation === 'DENIED' ? member.exists :
        !member.exists || member.fields.role !== (binding.expectation === 'ALLOWED_VIEWER' ? 'viewer'
          : binding.expectation === 'ALLOWED_ACCOUNTANT' ? 'accountant' : 'admin'))) blocked()
    }
  }
  const delta = AUDIT_DELTA_SLOTS.has(slot) ? 1 : 0
  if (['createCompanyA', 'createCompanyB'].includes(slot)) {
    if (after.audits.length !== 1) blocked()
  } else if (!prior || after.audits.length !== prior.audits.length + delta ||
      JSON.stringify(after.audits.slice(0, prior.audits.length)) !== JSON.stringify(prior.audits)) blocked()
  if (delta === 1) {
    const audit = after.audits.at(-1)
    if (!audit || !exactKeys(audit.fields, ['action', 'actorUid', 'targetUid', 'createdAt']) ||
        audit.fields.action !== SLOT_AUDIT_ACTION[slot] || audit.fields.actorUid !== binding.actorUid ||
        audit.fields.targetUid !== (slot.startsWith('accept') ? binding.actorUid : null) ||
        !rfc3339(audit.fields.createdAt) || !sameInstant(audit.createTime, audit.updateTime) ||
        !sameInstant(audit.fields.createdAt, audit.updateTime) || !afterOrEqual(audit.createTime, prior?.observedAt ?? audit.createTime)) blocked()
    const previousAudit = prior?.audits.at(-1)
    if (previousAudit && !afterOrEqual(audit.fields.createdAt, previousAudit.fields.createdAt)) blocked()
  }
}

function safeIncrementalSnapshot(value) {
  return frozen({ documents: value.documents.map(({ fields: _fields, ...row }) => row),
    audits: value.audits.map(({ fields: _fields, ...row }) => row) })
}

/** Slot-scoped readback used before the full fixture plan exists. Denied and
 * replay operations compare exact before/after snapshots; only hashes and
 * timestamps escape the adapter. */
export function createIncrementalFirestoreReconciler({ session }) {
  const { Client } = internalSession(session)
  const before = new Map()
  const auditCheckpoints = new Map()
  let replayProof = null
  const capture = async input => {
    if (!record(input) || typeof input.slot !== 'string' || !record(input.binding) || !record(input.state)) blocked()
    const paths = incrementalPaths(input.slot, input.binding, input.produced ?? {}, input.state)
    const documentCapture = paths.length ? await batchGetIncrementalSnapshot(Client, paths) : { documents: [], observedAt: null }
    const companyId = input.produced?.companyAId ?? input.produced?.companyBId ?? input.binding.companyId ??
      (input.state.companyAId && !['createCompanyB'].includes(input.slot) ? input.state.companyAId : null)
    const auditCompanies = input.slot === 'replayMailboxFinalInvite'
      ? [input.state.companyAId, input.state.companyBId] : companyId ? [companyId] : []
    if (auditCompanies.some(value => !safeId(value)) || new Set(auditCompanies).size !== auditCompanies.length) blocked()
    const audits = [], observed = [documentCapture.observedAt].filter(Boolean)
    for (const id of auditCompanies) {
      const snapshot = await incrementalAuditSnapshot(Client, id)
      audits.push(...snapshot.rows); if (snapshot.observedAt) observed.push(snapshot.observedAt)
    }
    return { documents: documentCapture.documents, audits,
      observedAt: observed.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null }
  }
  return Object.freeze({
    async captureBefore(input) {
      if (before.has(input?.slot)) blocked()
      const value = await capture({ ...input, produced: {} })
      for (const companyId of new Set(value.audits.map(row => row.companyId))) {
        const current = value.audits.filter(row => row.companyId === companyId)
        const checkpoint = auditCheckpoints.get(companyId)
        if (checkpoint && JSON.stringify(safeIncrementalSnapshot({ documents: [], audits: current })) !== checkpoint) blocked()
      }
      before.set(input.slot, value)
      return frozen({ slot: input.slot, stateSha256: jsonHash(safeIncrementalSnapshot(value)) })
    },
    async reconcile(input) {
      if (!record(input) || !hex64(input.requestSha256) || !hex64(input.outcomeSha256) ||
          !record(input.binding) || !record(input.produced)) blocked()
      if (input.slot === 'createOwnerMailboxAuth') {
        if (!exactKeys(input.produced, ['ownerMailboxUid']) || !safeId(input.produced.ownerMailboxUid) ||
            !record(input.state) || !safeId(input.state.companyAId) || !hex64(input.binding.subjectSha256)) blocked()
        const lookup = await exactPost(Client, URLS.authLookup, { localId: [input.produced.ownerMailboxUid] })
        const user = lookup?.users?.[0]
        if (!record(lookup) || !Array.isArray(lookup.users) || lookup.users.length !== 1 ||
            user.localId !== input.produced.ownerMailboxUid || normalizeMailbox(user.email) !== user.email ||
            sha256(user.email) !== input.binding.subjectSha256 || user.emailVerified === true || user.disabled === true) blocked()
        const absent = await batchGetIncrementalSnapshot(Client, [
          `users/${input.produced.ownerMailboxUid}`,
          `companies/${input.state.companyAId}/members/${input.produced.ownerMailboxUid}`,
        ])
        if (absent.documents.some(row => row.exists)) blocked()
        return frozen({ requestSha256: input.requestSha256, outcomeSha256: input.outcomeSha256,
          readbackSha256: jsonHash({ uidSha256: sha256(user.localId), emailVerified: false, firestoreAbsent: true }),
          produced: input.produced })
      }
      const after = await capture(input)
      const prior = before.get(input.slot)
      if (!prior) blocked()
      before.delete(input.slot)
      assertIncrementalSemantics(input, after, prior)
      if (!AUDIT_DELTA_SLOTS.has(input.slot) && JSON.stringify(safeIncrementalSnapshot(prior)) !== JSON.stringify(safeIncrementalSnapshot(after))) blocked()
      if (input.slot === 'replayMailboxFinalInvite') {
        const beforeDoc = path => prior.documents.find(row => row.path === path) ?? blocked()
        const afterDoc = path => after.documents.find(row => row.path === path) ?? blocked()
        const invitationPath = `invitations/${input.binding.invitationId}`
        const membershipPath = `companies/${input.state.companyAId}/members/${input.binding.actorUid}`
        const profilePath = `users/${input.binding.actorUid}`
        const priorInvitation = beforeDoc(invitationPath), invitation = afterDoc(invitationPath)
        const priorMembership = beforeDoc(membershipPath), membership = afterDoc(membershipPath)
        const priorProfile = beforeDoc(profilePath), profile = afterDoc(profilePath)
        if (![priorInvitation, invitation, priorMembership, membership, priorProfile, profile].every(row => row.exists) ||
            prior.audits.length !== 9 || after.audits.length !== 9) blocked()
        replayProof = frozen({ invitationUpdateTimeBefore: priorInvitation.updateTime, invitationUpdateTimeAfter: invitation.updateTime,
          membershipUpdateTimeBefore: priorMembership.updateTime, membershipUpdateTimeAfter: membership.updateTime,
          profileUpdateTimeBefore: priorProfile.updateTime, profileUpdateTimeAfter: profile.updateTime,
          auditCountBefore: prior.audits.length, auditCountAfter: after.audits.length })
      }
      for (const companyId of new Set(after.audits.map(row => row.companyId))) {
        const rows = after.audits.filter(row => row.companyId === companyId)
        auditCheckpoints.set(companyId, JSON.stringify(safeIncrementalSnapshot({ documents: [], audits: rows })))
      }
      return frozen({ requestSha256: input.requestSha256, outcomeSha256: input.outcomeSha256,
        readbackSha256: jsonHash({ slot: input.slot, after: safeIncrementalSnapshot(after), sanitized: input.sanitized }), produced: input.produced })
    },
    readReplayProof() { if (!replayProof) blocked(); return frozen(replayProof) },
  })
}

async function queryAuditDocuments(Client, plan) {
  const rows = []
  for (const company of plan.companies) {
    const url = `${DOCUMENTS_URL}/${company.path}:runQuery`
    const body = { structuredQuery: { from: [{ collectionId: 'audit_events' }], orderBy: [
      { field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
    ], limit: company.key === 'a' ? 9 : 2 } }
    const value = await exactPost(Client, url, body)
    if (!Array.isArray(value)) blocked()
    const prefix = `${DOCUMENTS_ROOT}/${company.path}/audit_events/`
    const allowed = new Set(value.map(row => row?.document?.name).filter(name => typeof name === 'string' && name.startsWith(prefix)))
    if (allowed.size !== value.length) blocked()
    for (const row of value) {
      if (!exactKeys(row, ['document', 'readTime']) || !rfc3339(row.readTime)) blocked()
      const doc = decodeDocument(row.document, allowed)
      if (!doc.name.startsWith(prefix) || !safeId(doc.name.slice(prefix.length))) blocked()
      rows.push({ company: company.key, id: doc.name.slice(prefix.length), doc })
    }
  }
  if (rows.length !== plan.counts.auditEvents || new Set(rows.map(row => `${row.company}/${row.id}`)).size !== rows.length) blocked()
  return rows
}

const AUDIT_EXPECTATIONS = Object.freeze([
  ['companyACreated', 'a', 'company_created', 'ownerA', null],
  ['companyBCreated', 'b', 'company_created', 'ownerB', null],
  ['mailboxCancelledCreated', 'a', 'member_invited', 'ownerA', null],
  ['mailboxCancelled', 'a', 'invitation_cancelled', 'ownerA', null],
  ['mailboxFinalCreated', 'a', 'member_invited', 'ownerA', null],
  ['mailboxFinalResent', 'a', 'invitation_resent', 'ownerA', null],
  ['mailboxFinalAccepted', 'a', 'invite_accepted', 'ownerMailbox', 'ownerMailbox'],
  ['ownerBInviteCreated', 'a', 'member_invited', 'ownerA', null],
  ['ownerBInviteAccepted', 'a', 'invite_accepted', 'ownerB', 'ownerB'],
].map(Object.freeze))

function validateStateAgainstPlan(plan, state, ownerBEmailSha256) {
  const keys = ['ownerAUid', 'ownerBUid', 'ownerMailboxUid', 'companyAId', 'companyBId',
    'mailboxCancelledInviteId', 'mailboxFinalInviteId', 'ownerBInviteId', 'mailboxCancelledCapabilitySha256',
    'mailboxFinalCapabilitySha256', 'ownerBCapabilitySha256', 'mailboxLockId', 'ownerBLockId']
  if (!exactKeys(state, keys) || !hex64(ownerBEmailSha256)) blocked()
  const ids = keys.filter(key => key.endsWith('Uid') || key.endsWith('Id')).map(key => state[key])
  if (ids.some(value => !safeId(value)) || new Set(ids).size !== ids.length) blocked()
  for (const key of keys.filter(key => key.endsWith('Sha256'))) if (!hex64(state[key])) blocked()
  if (plan.companies[0].id !== state.companyAId || plan.companies[1].id !== state.companyBId ||
      plan.authUsers[0].uid !== state.ownerAUid || plan.authUsers[1].uid !== state.ownerBUid ||
      plan.authUsers[2].uid !== state.ownerMailboxUid || plan.locks[0].id !== state.mailboxLockId ||
      plan.locks[1].id !== state.ownerBLockId) blocked()
}

/** Read and validate only the paths materialized by buildFixturePlan(). */
export function createSemanticFirestoreReadbackAdapter({ session, plan, state, ownerASubjectSha256, ownerBEmailSha256 }) {
  const { Client } = internalSession(session)
  validateFixturePlan(plan)
  if (!hex64(ownerASubjectSha256)) blocked()
  validateStateAgainstPlan(plan, state, ownerBEmailSha256)
  const paths = finalDocumentPaths(plan, state)
  let replayBefore = null

  async function capture() {
    const { docs, requestSha256 } = await batchGetDocuments(Client, paths)
    const get = path => docs.get(`${DOCUMENTS_ROOT}/${path}`) ?? blocked()
    const companyA = get(plan.companies[0].path), companyB = get(plan.companies[1].path)
    expectCompany(companyA, state.companyAId, state.ownerAUid); expectCompany(companyB, state.companyBId, state.ownerBUid)
    expectCompanyData(get(plan.companies[0].dataPath)); expectCompanyData(get(plan.companies[1].dataPath))
    const member = (company, uidKind) => get(plan.members.find(row => row.company === company && row.uidKind === uidKind)?.path)
    const ownerAMember = member('a', 'ownerA'), ownerBAdmin = member('b', 'ownerB')
    const ownerBMember = member('a', 'ownerB'), mailboxMember = member('a', 'ownerMailbox')
    expectMembership(ownerAMember, { uid: state.ownerAUid, role: 'admin', invitedBy: null })
    expectMembership(ownerBAdmin, { uid: state.ownerBUid, role: 'admin', invitedBy: null })
    expectMembership(ownerBMember, { uid: state.ownerBUid, role: 'viewer', invitedBy: state.ownerAUid })
    expectMembership(mailboxMember, { uid: state.ownerMailboxUid, role: 'accountant', invitedBy: state.ownerAUid })
    const profile = key => get(plan.authUsers.find(row => row.key === key)?.profilePath)
    const ownerAProfile = profile('ownerA'), ownerBProfile = profile('ownerB'), mailboxProfile = profile('ownerMailbox')
    expectProfile(ownerAProfile, { uid: state.ownerAUid, companyId: state.companyAId, role: 'admin', emailSha256: ownerASubjectSha256 })
    expectProfile(ownerBProfile, { uid: state.ownerBUid, companyId: state.companyBId, role: 'admin', emailSha256: ownerBEmailSha256,
      companies: [{ companyId: state.companyBId, role: 'admin' }, { companyId: state.companyAId, role: 'viewer' }] })
    expectProfile(mailboxProfile, { uid: state.ownerMailboxUid, companyId: state.companyAId, role: 'accountant', emailSha256: plan.mailboxSha256 })
    expectBootstrap(get(plan.authUsers[0].bootstrapPath), state.ownerAUid, state.companyAId)
    expectBootstrap(get(plan.authUsers[1].bootstrapPath), state.ownerBUid, state.companyBId)
    const cancelled = get(`invitations/${state.mailboxCancelledInviteId}`)
    const final = get(`invitations/${state.mailboxFinalInviteId}`)
    const ownerBInvite = get(`invitations/${state.ownerBInviteId}`)
    expectInvitation(cancelled, { companyId: state.companyAId, emailSha256: plan.mailboxSha256, role: 'accountant',
      capabilitySha256: state.mailboxCancelledCapabilitySha256, status: 'revoked', createdBy: state.ownerAUid, resendCount: 0 })
    expectInvitation(final, { companyId: state.companyAId, emailSha256: plan.mailboxSha256, role: 'accountant',
      capabilitySha256: state.mailboxFinalCapabilitySha256, status: 'accepted', acceptedByUid: state.ownerMailboxUid,
      createdBy: state.ownerAUid, resendCount: 1 })
    expectInvitation(ownerBInvite, { companyId: state.companyAId, emailSha256: ownerBEmailSha256, role: 'viewer',
      capabilitySha256: state.ownerBCapabilitySha256, status: 'accepted', acceptedByUid: state.ownerBUid,
      createdBy: state.ownerAUid, resendCount: 0 })
    const mailboxLock = get(plan.locks[0].path), ownerBLock = get(plan.locks[1].path)
    expectExactFields(mailboxLock.fields, ['currentInviteId']); expectExactFields(ownerBLock.fields, ['currentInviteId'])
    if (mailboxLock.fields.currentInviteId !== state.mailboxFinalInviteId || ownerBLock.fields.currentInviteId !== state.ownerBInviteId) blocked()

    const rawAudits = await queryAuditDocuments(Client, plan)
    const ordered = [...rawAudits.filter(row => row.company === 'a'), ...rawAudits.filter(row => row.company === 'b')]
    const expectedOrder = [...AUDIT_EXPECTATIONS.filter(row => row[1] === 'a'), ...AUDIT_EXPECTATIONS.filter(row => row[1] === 'b')]
    const identities = { ownerA: state.ownerAUid, ownerB: state.ownerBUid, ownerMailbox: state.ownerMailboxUid }
    const auditEvents = ordered.map((row, index) => {
      const [slot, company, action, actor, target] = expectedOrder[index] ?? []
      expectExactFields(row.doc.fields, ['action', 'actorUid', 'targetUid', 'createdAt'])
      if (row.company !== company || row.doc.fields.action !== action || row.doc.fields.actorUid !== identities[actor] ||
          row.doc.fields.targetUid !== (target === null ? null : identities[target]) || !rfc3339(row.doc.fields.createdAt)) blocked()
      return { slot, company, id: row.id, stateSha256: jsonHash(row.doc.fields), createTime: row.doc.createTime, updateTime: row.doc.updateTime }
    })
    const auditUpdateTime = auditEvents.map(row => row.updateTime).sort().at(-1)
    const readbacksByName = {
      'company-a': { docs: [companyA, get(plan.companies[0].dataPath), ownerAMember, ownerAProfile, get(plan.authUsers[0].bootstrapPath)], updateTime: companyA.updateTime },
      'company-b': { docs: [companyB, get(plan.companies[1].dataPath), ownerBAdmin, ownerBProfile, get(plan.authUsers[1].bootstrapPath)], updateTime: companyB.updateTime },
      'mailbox-membership': { docs: [mailboxMember], updateTime: mailboxMember.updateTime },
      'owner-b-membership': { docs: [ownerBMember], updateTime: ownerBMember.updateTime },
      'mailbox-final-invitation': { docs: [final], updateTime: final.updateTime },
      'owner-b-invitation': { docs: [ownerBInvite], updateTime: ownerBInvite.updateTime },
      'mailbox-lock': { docs: [mailboxLock], updateTime: mailboxLock.updateTime },
      'owner-b-lock': { docs: [ownerBLock], updateTime: ownerBLock.updateTime },
      'audit-events': { docs: auditEvents, updateTime: auditUpdateTime },
      'owner-mailbox-profile': { docs: [mailboxProfile], updateTime: mailboxProfile.updateTime },
    }
    const readbacks = READBACK_CHECKS.map(check => ({ check, stateSha256: jsonHash(readbacksByName[check].docs), updateTime: readbacksByName[check].updateTime }))
    const replay = { invitationUpdateTime: final.updateTime, membershipUpdateTime: mailboxMember.updateTime,
      profileUpdateTime: mailboxProfile.updateTime, auditCount: auditEvents.length }
    return frozen({ readbacks, auditEvents, replay, fullStateSha256: jsonHash({ requestSha256, paths, readbacks, auditEvents }) })
  }

  return Object.freeze({
    async captureFinal() { return capture() },
    async captureReplayBefore() { if (replayBefore) blocked(); replayBefore = await capture(); return frozen(replayBefore.replay) },
    async captureReplayAfter() {
      if (!replayBefore) blocked()
      const after = await capture()
      if (JSON.stringify(after.replay) !== JSON.stringify(replayBefore.replay) || after.fullStateSha256 !== replayBefore.fullStateSha256) blocked()
      return frozen({
        invitationUpdateTimeBefore: replayBefore.replay.invitationUpdateTime, invitationUpdateTimeAfter: after.replay.invitationUpdateTime,
        membershipUpdateTimeBefore: replayBefore.replay.membershipUpdateTime, membershipUpdateTimeAfter: after.replay.membershipUpdateTime,
        profileUpdateTimeBefore: replayBefore.replay.profileUpdateTime, profileUpdateTimeAfter: after.replay.profileUpdateTime,
        auditCountBefore: replayBefore.replay.auditCount, auditCountAfter: after.replay.auditCount,
      })
    },
    async reconcileUncertain(slot) {
      const spec = FIXTURE_MUTATION_SLOT_SPECS.find(row => row.slot === slot)
      if (!spec) blocked()
      const snapshot = await capture()
      return frozen({ slot, terminal: true,
        idempotentContinuation: spec.callable === 'createCompany' ? 'EXACT_REQUEST_ONLY'
          : spec.disposition === 'IDEMPOTENT_READBACK' ? 'SAME_UID_ACCEPT_ONLY' : null,
        stateSha256: snapshot.fullStateSha256 })
    },
  })
}

/** Close both live handles on every stop. No cleanup callback is accepted. */
export function createSafeStopTeardown({ browser, transport }) {
  if (!exactKeys({ browser, transport }, ['browser', 'transport']) || typeof browser?.close !== 'function' || typeof transport?.close !== 'function') blocked()
  let closed = false
  return Object.freeze({
    async close() {
      if (closed) return frozen({ browserClosed: true, transportClosed: true, cleanupPerformed: false })
      closed = true
      const results = await Promise.allSettled([browser.close(), transport.close()])
      if (results.some(result => result.status === 'rejected')) blocked()
      return frozen({ browserClosed: true, transportClosed: true, cleanupPerformed: false })
    },
  })
}

const COMPOSITION_STAGES = Object.freeze([
  'openLoopback', 'openProvider', 'createJournal', 'openPlaywright', 'runScenarios',
  'createSemanticReadback', 'writeOutput',
])

/**
 * Compose the concrete live pieces without accepting generic transport, URL,
 * browser-evaluation or cleanup hooks. The CLI loads this path only after all
 * local approval/head/missing-adapter gates have passed.
 */
export async function runLiveAcceptanceComposition({ context, stages, now = () => new Date().toISOString() }) {
  if (!exactKeys(context, ['sourceHead', 'journalPath', 'outputPath']) || !/^[a-f0-9]{40}$/.test(context.sourceHead) ||
      !path.isAbsolute(context.journalPath) || !path.isAbsolute(context.outputPath) ||
      !exactKeys(stages, COMPOSITION_STAGES) || COMPOSITION_STAGES.some(name => typeof stages[name] !== 'function') ||
      typeof now !== 'function') blocked()
  const startedAt = isoNow(now)
  let loopback = null, provider = null, playwright = null, journal = null, teardown = null, journalClosed = false
  try {
    loopback = await stages.openLoopback(frozen({ sourceHead: context.sourceHead }))
    if (!exactKeys(loopback, ['receipt', 'close']) || !record(loopback.receipt) || typeof loopback.close !== 'function') blocked()
    provider = await stages.openProvider(frozen({ sourceHead: context.sourceHead, loopbackReceipt: loopback.receipt }))
    if (!exactKeys(provider, ['session', 'transport', 'close']) || !provider.session ||
        typeof provider.transport?.close !== 'function' || typeof provider.close !== 'function') blocked()
    journal = await stages.createJournal(frozen({ filename: context.journalPath, sourceHead: context.sourceHead }))
    if (!journal || ['append', 'bytes', 'events', 'close'].some(name => typeof journal[name] !== 'function')) blocked()
    playwright = await stages.openPlaywright(Object.freeze({ sourceHead: context.sourceHead, loopbackReceipt: loopback.receipt,
      providerSession: provider.session }))
    if (!exactKeys(playwright, ['browser', 'close']) || typeof playwright.browser?.close !== 'function' || typeof playwright.close !== 'function') blocked()
    const browserHandle = Object.freeze({ close: async () => { await playwright.close(); await loopback.close() } })
    const transportHandle = Object.freeze({ close: provider.close })
    teardown = createSafeStopTeardown({ browser: browserHandle, transport: transportHandle })

    const scenario = await stages.runScenarios(Object.freeze({ sourceHead: context.sourceHead, loopbackReceipt: loopback.receipt, journal,
      providerSession: provider.session, providerTransport: provider.transport, browser: playwright.browser }))
    if (!record(scenario) || !Array.isArray(scenario.scenarios) || typeof scenario.materializeFixturePlan !== 'function' ||
        typeof scenario.readSemanticState !== 'function' || typeof scenario.readReplayProof !== 'function' ||
        typeof scenario.readCallableCounts !== 'function' || typeof scenario.readTransportCounts !== 'function' ||
        typeof scenario.verifyAcceptance !== 'function' || typeof scenario.buildCleanupPlanOnly !== 'function') blocked()
    const plan = scenario.materializeFixturePlan()
    validateFixturePlan(plan)
    const semanticState = scenario.readSemanticState()
    const semantic = await stages.createSemanticReadback(Object.freeze({ session: provider.session, plan, state: semanticState }))
    if (!semantic || typeof semantic.captureFinal !== 'function') blocked()
    const captured = await semantic.captureFinal()
    if (!exactKeys(captured, ['readbacks', 'auditEvents', 'replay', 'fullStateSha256']) || !hex64(captured.fullStateSha256)) blocked()
    const bundle = {
      readbacks: captured.readbacks, auditEvents: captured.auditEvents, replay: scenario.readReplayProof(),
      callableCounts: scenario.readCallableCounts(), transportCounts: scenario.readTransportCounts(),
    }
    const verified = scenario.verifyAcceptance(frozen(bundle))
    if (!record(verified) || !hex64(verified.observationsSha256)) blocked()
    const cleanup = scenario.buildCleanupPlanOnly(frozen(bundle))
    if (!exactKeys(cleanup, ['status', 'executionEnabled', 'cleanupPerformed', 'cleanupPlanSha256', 'targets']) ||
        cleanup.status !== 'CLEANUP_PLAN_ONLY' || cleanup.executionEnabled !== false || cleanup.cleanupPerformed !== false ||
        !hex64(cleanup.cleanupPlanSha256)) blocked()
    await teardown.close()
    const journalReceipt = journal.close(); journalClosed = true
    if (!exactKeys(journalReceipt, ['journalSha256', 'eventCount']) || !hex64(journalReceipt.journalSha256) ||
        !Number.isSafeInteger(journalReceipt.eventCount) || journalReceipt.eventCount < 1) blocked()
    const finishedAt = isoNow(now)
    if (scenario.scenarios.length !== 6 || scenario.scenarios.some(row => !exactKeys(row, ['name', 'status']) || row.status !== 'PASS')) blocked()
    const output = frozen({
      task: 'SEC-006 Stage 8 live acceptance', status: 'LIVE_ACCEPTANCE_VERIFIED', project: PROJECT,
      sourceHead: context.sourceHead, planSha256: jsonHash(plan), observationsSha256: verified.observationsSha256,
      journalSha256: journalReceipt.journalSha256, cleanupPlanSha256: cleanup.cleanupPlanSha256,
      startedAt, finishedAt, scenarios: scenario.scenarios, callableCounts: bundle.callableCounts,
      transportCounts: bundle.transportCounts, cleanup: 'DEFERRED_SEPARATE_APPROVAL', cleanupPerformed: false,
    })
    assertNoSecretMaterial(output)
    await stages.writeOutput(frozen({ filename: context.outputPath, value: output }))
    return output
  } catch {
    if (teardown) { try { await teardown.close() } catch { /* retain original failure */ } }
    else {
      if (playwright) { try { await playwright.close() } catch { /* best effort */ } }
      if (loopback) { try { await loopback.close() } catch { /* best effort */ } }
      if (provider) { try { await provider.close() } catch { /* best effort */ } }
    }
    throw new Error('live_executor_adapters_blocked')
  } finally {
    if (journal && !journalClosed) { try { journal.close() } catch { /* preserve prior failure */ } }
  }
}

export function createStaticLiveAdapterBindings({ executorOptions, browserBinderOptions, openOwnerSession, pauseOwner }) {
  if (!executorOptions || !browserBinderOptions || typeof openOwnerSession !== 'function' || typeof pauseOwner !== 'function') blocked()
  return Object.freeze({
    executor: createLiveStagingExecutor(executorOptions),
    browserBinder: createLiveBrowserRequestBinder(browserBinderOptions),
    ownerHandoff: createVisibleOwnerHandoff({ openSession: openOwnerSession, pause: pauseOwner }),
  })
}

export const LIVE_PROVIDER_CONSTANTS = Object.freeze({
  urls: URLS, authFields: AUTH_FIELDS, invitationIndex: INDEX, fieldOverridesSha256: FIELD_HASH,
})
