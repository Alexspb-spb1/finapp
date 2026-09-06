import { createHash } from 'node:crypto'

export const PROJECT = 'finapp-staging'
export const DATABASE = `projects/${PROJECT}/databases/(default)`
const sha = value => createHash('sha256').update(value).digest('hex')
export const rulesHash = value => sha(value.replace(/\r\n?/g, '\n'))
const blocked = () => { throw new Error('inventory_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && /^[\w.()/:-]{1,400}$/.test(value) ? value : null

export function guard({ project, expectedHead, head, status, env }) {
  if (project !== PROJECT || !/^[a-f0-9]{40}$/.test(expectedHead ?? '') || head !== expectedHead || status !== '') blocked()
  // Never fall through to ADC, service-account files, emulators, debug logging,
  // a custom token endpoint, or disabled TLS. Values are never reported.
  for (const [rawKey, value] of Object.entries(env)) {
    // Windows environment lookup is case insensitive although enumeration
    // preserves spelling. Apply the same guard to every spelling/duplicate.
    const key = rawKey.toUpperCase()
    if (value && (/EMULATOR/.test(key) || /^(FIREBASE_TOKEN|FIREBASE_CLIENT_ID|FIREBASE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS|DEBUG|NODE_DEBUG|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|IS_FIREBASE_CLI|IS_FIREBASE_MCP|MONOSPACE_ENV)$/.test(key) || /^FIREBASE_.*(?:URL|ORIGIN)$/.test(key))) blocked()
    if (key === 'GOOGLE_CLOUD_QUOTA_PROJECT' && value && value !== PROJECT) blocked()
  }
}

export function guardCliAccount(account) {
  // An access-token-only account can enter firebase-tools' refreshAuth path,
  // which does not retain skipAutoAuth=true. Require the ordinary CLI login
  // refresh token so expiry always follows that session, never ADC fallback.
  if (!record(account?.user) || !record(account?.tokens) ||
      typeof account.tokens.refresh_token !== 'string' || !account.tokens.refresh_token.trim()) blocked()
}

export const ENDPOINTS = Object.freeze({
  project: ['https://firebase.googleapis.com', `/v1beta1/projects/${PROJECT}`],
  functionsV1: ['https://cloudfunctions.googleapis.com', `/v1/projects/${PROJECT}/locations/-/functions`],
  functionsV2: ['https://cloudfunctions.googleapis.com', `/v2/projects/${PROJECT}/locations/-/functions`],
  database: ['https://firestore.googleapis.com', `/v1/${DATABASE}`],
  indexes: ['https://firestore.googleapis.com', `/v1/${DATABASE}/collectionGroups/-/indexes`],
  fields: ['https://firestore.googleapis.com', `/v1/${DATABASE}/collectionGroups/-/fields`],
  release: ['https://firebaserules.googleapis.com', `/v1/projects/${PROJECT}/releases/cloud.firestore`],
  auth: ['https://identitytoolkit.googleapis.com', `/admin/v2/projects/${PROJECT}/config`],
})

// firebase-tools uses global fetch for these requests, including its OAuth
// refresh. Enforce this boundary before loading auth modules; a redirect can
// never forward bearer headers or the refresh-token form to another URL.
export function guardedFetch(baseFetch) {
  return async (input, init = {}) => {
    if (typeof input !== 'string' && !(input instanceof URL)) blocked()
    const url = new URL(input)
    const method = init.method ?? 'GET'
    if (url.username || url.password || url.hash) blocked()
    const resource = method === 'GET' && (
      Object.values(ENDPOINTS).some(([origin, pathname]) => url.origin === origin && url.pathname === pathname) ||
      (url.origin === 'https://firebaserules.googleapis.com' && new RegExp(`^/v1/projects/${PROJECT}/rulesets/[a-zA-Z0-9-]+$`).test(url.pathname))
    )
    const refresh = method === 'POST' && url.href === 'https://www.googleapis.com/oauth2/v3/token'
    if (!resource && !refresh) blocked()
    return baseFetch(input, { ...init, redirect: 'error' })
  }
}

export function requestSpec(kind, pageToken, rulesetName) {
  let endpoint = ENDPOINTS[kind]
  if (kind === 'ruleset') {
    if (!new RegExp(`^projects/${PROJECT}/rulesets/[a-zA-Z0-9-]+$`).test(rulesetName ?? '')) blocked()
    endpoint = ['https://firebaserules.googleapis.com', `/v1/${rulesetName}`]
  }
  if (!endpoint || (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 10000))) blocked()
  const queryParams = {}
  if (pageToken) queryParams.pageToken = pageToken
  if (kind === 'functionsV2') queryParams.filter = 'environment="GEN_2"'
  if (kind === 'fields') queryParams.filter = 'indexConfig.usesAncestorConfig=false OR ttlConfig:*'
  // Request only metadata; runtime/build env values, secret references,
  // SMTP settings and email template contents are not needed or requested.
  const projections = {
    project: 'projectId,projectNumber', database: 'name,locationId,type',
    functionsV1: 'functions(name,status,runtime,versionId,sourceArchiveUrl,sourceRepository),nextPageToken,unreachable',
    functionsV2: 'functions(name,state,buildConfig(runtime,source),serviceConfig(revision)),nextPageToken,unreachable',
    auth: 'name,authorizedDomains,signIn(email(enabled,passwordRequired))',
  }
  if (projections[kind]) queryParams.fields = projections[kind]
  return { method: 'GET', origin: endpoint[0], path: endpoint[1], queryParams }
}

async function list(get, kind, key) {
  const rows = []
  const seen = new Set()
  let token
  for (let page = 0; page < 100; page++) {
    const result = await get(requestSpec(kind, token))
    if (!record(result) || (result[key] !== undefined && !Array.isArray(result[key])) ||
        (result.unreachable !== undefined && (!Array.isArray(result.unreachable) || result.unreachable.length > 0))) blocked()
    rows.push(...(result[key] ?? []))
    if (!result.nextPageToken) return rows
    if (seen.has(result.nextPageToken)) blocked()
    seen.add(result.nextPageToken)
    token = result.nextPageToken
  }
  blocked()
}

export function sanitizeFunction(value, generation) {
  if (!record(value) || !new RegExp(`^projects/${PROJECT}/locations/[a-z0-9-]+/functions/[a-zA-Z0-9_-]+$`).test(value.name ?? '')) blocked()
  const source = generation === 2 ? value.buildConfig?.source : value.sourceArchiveUrl ?? value.sourceRepository
  return {
    name: value.name, generation, state: text(value.state ?? value.status),
    runtime: text(generation === 2 ? value.buildConfig?.runtime : value.runtime),
    revision: text(generation === 2 ? value.serviceConfig?.revision : String(value.versionId ?? '')),
    sourceReferencePresent: Boolean(source), sourceReferenceSha256: source ? sha(JSON.stringify(source)) : null,
    // A reference can point at an expired/deleted source. This inventory does
    // not fetch source archives, runtime configuration, or secret material.
    rollbackArtifactAvailability: 'NOT_VERIFIED',
  }
}

function sanitizeIndex(value) {
  if (!record(value) || typeof value.name !== 'string' || !value.name.startsWith(`${DATABASE}/collectionGroups/`) ||
      !value.name.includes('/indexes/') || !Array.isArray(value.fields)) blocked()
  return {
    name: text(value.name), state: text(value.state), queryScope: text(value.queryScope),
    fields: value.fields.map(field => {
      if (!record(field) || typeof field.fieldPath !== 'string') blocked()
      return { fieldPath: field.fieldPath, order: text(field.order), arrayConfig: text(field.arrayConfig), vector: record(field.vectorConfig) }
    }),
  }
}

export function sanitizeAuth(value, projectNumber) {
  const names = [`projects/${PROJECT}/config`]
  if (/^\d+$/.test(projectNumber ?? '')) names.push(`projects/${projectNumber}/config`)
  if (!record(value) || !names.includes(value.name) || !Array.isArray(value.authorizedDomains) ||
      value.authorizedDomains.some(domain => typeof domain !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(domain))) blocked()
  return {
    emailPasswordEnabled: typeof value.signIn?.email?.enabled === 'boolean' ? value.signIn.email.enabled : null,
    passwordRequired: typeof value.signIn?.email?.passwordRequired === 'boolean' ? value.signIn.email.passwordRequired : null,
    authorizedDomains: value.authorizedDomains,
    verificationTemplateAndDelivery: 'MANUAL_REVIEW_REQUIRED',
  }
}

export async function inventory({ options, gitState, localRules, authorize, get, now = () => new Date().toISOString() }) {
  guard({ ...options, ...await gitState() })
  const localHash = rulesHash(await localRules())
  await authorize()
  const startedAt = now()
  const project = await get(requestSpec('project'))
  if (!record(project) || project.projectId !== PROJECT || !/^\d+$/.test(project.projectNumber ?? '')) blocked()
  const database = await get(requestSpec('database'))
  if (!record(database) || database.name !== DATABASE) blocked()
  const functionsV1 = await list(get, 'functionsV1', 'functions')
  const functionsV2 = await list(get, 'functionsV2', 'functions')
  const functions = [...functionsV1.map(f => sanitizeFunction(f, 1)), ...functionsV2.map(f => sanitizeFunction(f, 2))]
  const release = await get(requestSpec('release'))
  if (!record(release) || release.name !== `projects/${PROJECT}/releases/cloud.firestore`) blocked()
  const activeRules = await get(requestSpec('ruleset', undefined, release.rulesetName))
  if (!record(activeRules) || activeRules.name !== release.rulesetName || !Array.isArray(activeRules.source?.files) || activeRules.source.files.length !== 1 ||
      typeof activeRules.source.files[0].content !== 'string') blocked()
  const activeHash = rulesHash(activeRules.source.files[0].content)
  const indexes = (await list(get, 'indexes', 'indexes')).map(sanitizeIndex)
  const fields = await list(get, 'fields', 'fields')
  if (fields.some(field => !record(field) || typeof field.name !== 'string' || !field.name.startsWith(`${DATABASE}/collectionGroups/`))) blocked()
  const auth = sanitizeAuth(await get(requestSpec('auth')), project.projectNumber)
  // Do not accept evidence if the reviewed checkout changed during requests.
  guard({ ...options, ...await gitState() })
  return {
    task: 'SEC-006 Stage 8', status: 'INVENTORY_COMPLETE_RELEASE_BLOCKED', project: PROJECT,
    database: { name: DATABASE, locationId: text(database.locationId), type: text(database.type) },
    sourceHead: options.expectedHead, startedAt, finishedAt: now(), functions,
    rules: { release: release.name, rulesetName: release.rulesetName, localSha256: localHash, activeSha256: activeHash, matches: localHash === activeHash, backupDownloaded: false },
    indexes, fieldOverrideCount: fields.length,
    // Hash only, so policies/metadata are not accidentally printed. A later
    // deployment package must preserve full current configuration privately.
    fieldOverridesSha256: sha(JSON.stringify(fields)), auth,
    writesReady: false,
    unresolved: [
      'Separate owner approval for deployment, Auth/data writes, email and cleanup',
      'Verified Functions source/config rollback and preserved Rules backup',
      'Billing, API availability, resource limits and estimated costs',
      'Private staging SDK fingerprint validation and build',
      'Preserve existing indexes and field overrides; check required index READY',
      'Owner-approved mailbox, verification action domain, template and real email delivery',
    ],
  }
}
