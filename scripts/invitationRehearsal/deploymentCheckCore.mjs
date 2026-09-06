import { createHash } from 'node:crypto'
import { guard, PROJECT, DATABASE } from './inventoryCore.mjs'

export const CALLABLES = Object.freeze(['acceptInvite', 'cancelInvite', 'createCompany', 'getCompanyAccess', 'inviteMember', 'listInvitations', 'previewInvite', 'resendInvite'])
export const REGION = 'us-central1'
export const URLS = Object.freeze({
  project: `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}`,
  billing: `https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`,
  database: `https://firestore.googleapis.com/v1/${DATABASE}`,
  functionsV1: `https://cloudfunctions.googleapis.com/v1/projects/${PROJECT}/locations/-/functions`,
  functionsV2: `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT}/locations/-/functions`,
})
export const FIELDS = Object.freeze({
  project: 'projectId,projectNumber',
  billing: 'projectId,billingEnabled',
  database: 'name,locationId,type',
  functionsV1: 'functions(name),nextPageToken,unreachable',
  // Never request environment variables, secret bindings, service accounts or URIs.
  functionsV2: 'functions(name,state,environment,buildConfig(runtime,entryPoint,build,source,sourceProvenance),serviceConfig(availableMemory,availableCpu,maxInstanceRequestConcurrency,minInstanceCount,maxInstanceCount,timeoutSeconds,revision)),nextPageToken,unreachable',
})
const blocked = () => { throw new Error('deployment_check_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function deploymentGuard(options, git) {
  guard({ ...options, ...git })
  if (!['preflight', 'postflight'].includes(options.mode)) blocked()
}

export function requestSpec(kind, pageToken) {
  if (!Object.hasOwn(URLS, kind)) blocked()
  const queryParams = { fields: FIELDS[kind] }
  if (kind.startsWith('functions')) {
    queryParams.pageSize = '100'
    if (pageToken !== undefined) {
      if (typeof pageToken !== 'string' || !pageToken.length || pageToken.length > 4096) blocked()
      queryParams.pageToken = pageToken
    }
    if (kind === 'functionsV2') queryParams.filter = 'environment="GEN_2"'
  } else if (pageToken !== undefined) blocked()
  return { url: URLS[kind], queryParams }
}

export function deploymentTransport(baseFetch) {
  let requests = 0
  return async (input, init = {}) => {
    if (typeof input !== 'string' && !(input instanceof URL)) blocked()
    const url = new URL(input), method = init.method ?? 'GET'
    if (url.username || url.password || url.hash || ++requests > 40) blocked()
    const refresh = method === 'POST' && url.href === 'https://www.googleapis.com/oauth2/v3/token'
    if (!refresh) {
      const kind = Object.keys(URLS).find(key => URLS[key] === `${url.origin}${url.pathname}`)
      if (method !== 'GET' || !kind) blocked()
      const expected = requestSpec(kind, url.searchParams.has('pageToken') ? url.searchParams.get('pageToken') : undefined).queryParams
      if ([...url.searchParams].length !== Object.keys(expected).length ||
          Object.entries(expected).some(([key, value]) => url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value)) blocked()
    }
    // Applies to both metadata GET and the existing CLI session's OAuth refresh.
    const timeout = AbortSignal.timeout(10000)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    return baseFetch(input, { ...init, redirect: 'error', signal })
  }
}

async function list(get, kind) {
  const rows = [], seen = new Set()
  let token
  for (let page = 0; page < 10; page++) {
    const response = await get(requestSpec(kind, token))
    if (!record(response) || (response.functions !== undefined && !Array.isArray(response.functions)) ||
        (response.unreachable !== undefined && (!Array.isArray(response.unreachable) || response.unreachable.length))) blocked()
    rows.push(...(response.functions ?? []))
    if (rows.length > 1000) blocked()
    if (response.nextPageToken === undefined || response.nextPageToken === '') return rows
    if (typeof response.nextPageToken !== 'string' || response.nextPageToken.length > 4096 || seen.has(response.nextPageToken)) blocked()
    token = response.nextPageToken; seen.add(token)
  }
  blocked()
}

export function checkFunction(value, projectNumber) {
  if (!record(value) || !/^\d+$/.test(projectNumber ?? '')) blocked()
  const name = CALLABLES.find(id => value.name === `projects/${PROJECT}/locations/${REGION}/functions/${id}`)
  if (!name || value.environment !== 'GEN_2' || value.state !== 'ACTIVE' ||
      !record(value.buildConfig) || value.buildConfig.runtime !== 'nodejs22' || value.buildConfig.entryPoint !== name ||
      !record(value.serviceConfig)) blocked()
  const config = value.serviceConfig
  // Cloud Functions v2 ServiceConfig uses strings for CPU/memory, integer counts.
  // The protobuf JSON representation omits zero-valued minInstanceCount; omitted
  // means zero. Explicit null, string "0", negative or positive values are denied.
  const minInstanceCount = Object.hasOwn(config, 'minInstanceCount') ? config.minInstanceCount : 0
  if (config.availableMemory !== '256Mi' || config.availableCpu !== '1' ||
      config.maxInstanceRequestConcurrency !== 1 || minInstanceCount !== 0 ||
      config.maxInstanceCount !== 1 || config.timeoutSeconds !== 60) blocked()
  const revisionPrefix = `${name.toLowerCase()}-`
  if (typeof config.revision !== 'string' || !config.revision.startsWith(revisionPrefix) ||
      !/^\d{5,}-[a-z0-9]{3,10}$/.test(config.revision.slice(revisionPrefix.length))) blocked()
  const build = value.buildConfig.build
  if (typeof build !== 'string' || !new RegExp(`^projects/(?:${PROJECT}|${projectNumber})/locations/[a-z0-9-]+/builds/[a-f0-9-]{36}$`).test(build)) blocked()
  if (!record(value.buildConfig.source) || !Object.keys(value.buildConfig.source).length) blocked()
  const source = value.buildConfig.source
  const sourceKind = record(source.storageSource) ? 'storage' : record(source.repoSource) ? 'repository' : null
  if (!sourceKind) blocked()
  return {
    name: value.name, state: 'ACTIVE', generation: 2, runtime: 'nodejs22', region: REGION,
    resources: { memory: '256Mi', cpu: 1, concurrency: 1, minInstances: 0, maxInstances: 1, timeoutSeconds: 60 },
    revision: config.revision, build,
    // Source refs/provenance may contain repository URLs or arbitrary provider
    // metadata. Keep only fingerprints; never source/config payloads or URLs.
    sourceKind, sourceReferenceSha256: sha(source),
    sourceProvenanceSha256: record(value.buildConfig.sourceProvenance) ? sha(value.buildConfig.sourceProvenance) : null,
    rollbackArtifactAvailability: 'NOT_VERIFIED',
  }
}

export async function runDeploymentCheck({ options, gitState, authorize, get, now = () => new Date().toISOString() }) {
  deploymentGuard(options, await gitState())
  await authorize()
  const startedAt = now()
  const project = await get(requestSpec('project'))
  if (!record(project) || project.projectId !== PROJECT || !/^\d+$/.test(project.projectNumber ?? '')) blocked()
  const billing = await get(requestSpec('billing'))
  if (!record(billing) || billing.projectId !== PROJECT || billing.billingEnabled !== true) blocked()
  const database = await get(requestSpec('database'))
  if (!record(database) || database.name !== DATABASE || database.type !== 'FIRESTORE_NATIVE' || database.locationId !== 'eur3') blocked()
  const v1 = await list(get, 'functionsV1')
  if (v1.length) blocked()
  const v2 = await list(get, 'functionsV2')
  let functions = []
  if (options.mode === 'preflight') {
    if (v2.length) blocked()
  } else {
    if (v2.length !== CALLABLES.length) blocked()
    functions = v2.map(value => checkFunction(value, project.projectNumber))
    if (new Set(functions.map(value => value.name)).size !== CALLABLES.length) blocked()
    functions.sort((a, b) => a.name.localeCompare(b.name))
  }
  deploymentGuard(options, await gitState())
  return {
    task: 'SEC-006 Stage 8', mode: options.mode,
    status: options.mode === 'preflight' ? 'DEPLOYMENT_PREFLIGHT_VERIFIED' : 'DEPLOYMENT_METADATA_VERIFIED',
    project: PROJECT, sourceHead: options.expectedHead, startedAt, finishedAt: now(),
    billingEnabled: true, database: { name: DATABASE, type: 'FIRESTORE_NATIVE', locationId: 'eur3' },
    functions, deploymentAllowlist: CALLABLES, excludedFromDeployment: ['authzProbe'],
    cloudMutations: 0, callableInvocations: 0, realEmailDeliveryVerified: false,
    limitations: ['Metadata is not behavioral or real-email acceptance', 'Source fingerprints do not prove recoverable artifacts', 'This check does not grant deployment approval'],
  }
}
