import { createHash } from 'node:crypto'
import { guard, PROJECT, DATABASE, rulesHash } from './inventoryCore.mjs'

export const FIELD_HASH = 'af2e9e80c150cc9a6b2f4c5f5bae330dacb214d7a104188fa5ef4fcfad3c6aee'
export const BASELINE_RULES_HASH = 'b0f6c045e908bc632a4b24381c3c1164ccca95834761b2dc68d460bce6524c8f'
export const BASELINE_RULESET = `projects/${PROJECT}/rulesets/01da0ec2-a6b0-4b17-b533-81195a573359`
export const URLS = Object.freeze({
  project: `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}`,
  database: `https://firestore.googleapis.com/v1/${DATABASE}`,
  release: `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`,
  indexes: `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
  fields: `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/fields`,
  create: `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/invitations/indexes`,
})
export const INDEX = Object.freeze({ queryScope: 'COLLECTION', fields: [
  { fieldPath: 'companyId', order: 'ASCENDING' },
  { fieldPath: 'createdAt', order: 'DESCENDING' },
  { fieldPath: '__name__', order: 'DESCENDING' },
] })
const blocked = () => { throw new Error('staging_resources_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const sha256 = value => createHash('sha256').update(value).digest('hex')
const clone = value => structuredClone(value)

export function resourcesGuard(options, git) {
  guard({ ...options, ...git })
  if (!['backup-rules', 'verify-rules-backup', 'verify-current-rules', 'ensure-index', 'verify-index'].includes(options.mode)) blocked()
  if (options.mode.includes('rules') && !hex(options.expectedRulesHash)) blocked()
  if (options.mode.endsWith('index') && !hex(options.expectedFieldHash)) blocked()
}

function rulesetUrl(name) {
  if (typeof name !== 'string' || !new RegExp(`^projects/${PROJECT}/rulesets/[a-zA-Z0-9-]+$`).test(name)) blocked()
  return `https://firebaserules.googleapis.com/v1/${name}`
}
export function indexUrl(name) {
  const prefix = `${DATABASE}/collectionGroups/invitations/indexes/`
  if (typeof name !== 'string' || !name.startsWith(prefix) || !/^[a-zA-Z0-9_-]+$/.test(name.slice(prefix.length))) blocked()
  return `https://firestore.googleapis.com/v1/${name}`
}
export function indexOperationUrl(name) {
  const prefix = `${DATABASE}/operations/`
  if (typeof name !== 'string' || !name.startsWith(prefix) || !/^[a-zA-Z0-9._-]+$/.test(name.slice(prefix.length))) blocked()
  return `https://firestore.googleapis.com/v1/${name}`
}

export function resourcesTransport(baseFetch, mode, beforeCreate = () => {}) {
  let dispatched = false
  const dynamic = new Set()
  return {
    allowRuleset(name) { dynamic.add(rulesetUrl(name)) },
    allowIndex(name) { dynamic.add(indexUrl(name)) },
    allowOperation(name) { dynamic.add(indexOperationUrl(name)) },
    fetch: async (input, init = {}) => {
      if (typeof input !== 'string' && !(input instanceof URL)) blocked()
      const url = new URL(input)
      const method = init.method ?? 'GET'
      const base = `${url.origin}${url.pathname}`
      const fixed = [URLS.project, URLS.database, ...(mode.includes('rules') ? [URLS.release] : [URLS.indexes, URLS.fields])]
      const read = method === 'GET' && (fixed.includes(base) || dynamic.has(base))
      const refresh = method === 'POST' && url.href === 'https://www.googleapis.com/oauth2/v3/token'
      const create = mode === 'ensure-index' && method === 'POST' && url.href === URLS.create
      if (mode === 'verify-rules-backup' || url.username || url.password || url.hash || (!read && !refresh && !create)) blocked()
      if (create) {
        if (dispatched) blocked()
        dispatched = true
        await beforeCreate()
      }
      return baseFetch(input, { ...init, redirect: 'error' })
    },
  }
}

export function verifyBackup(backup, expectedHash, expectedRulesetName = expectedHash === BASELINE_RULES_HASH ? BASELINE_RULESET : undefined) {
  if (!hex(expectedHash) || !record(backup) || backup.format !== 'finapp-rules-backup-v1' ||
      backup.project !== PROJECT || backup.database !== DATABASE ||
      backup.release?.name !== `projects/${PROJECT}/releases/cloud.firestore` ||
      backup.release.rulesetName !== backup.rulesetName || !/^[a-f0-9]{40}$/.test(backup.sourceHead ?? '') ||
      typeof backup.capturedAt !== 'string' || !Number.isFinite(Date.parse(backup.capturedAt)) ||
      !Array.isArray(backup.source?.files) || backup.source.files.length !== 1) blocked()
  rulesetUrl(backup.rulesetName)
  if (expectedRulesetName !== undefined && backup.rulesetName !== expectedRulesetName) blocked()
  const file = backup.source.files[0]
  if (!record(file) || typeof file.name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(file.name) ||
      typeof file.content !== 'string' || Buffer.byteLength(file.content) > 1024 * 1024 ||
      backup.rawSha256 !== sha256(file.content) || backup.sourceBytes !== Buffer.byteLength(file.content) ||
      backup.canonicalSha256 !== expectedHash || rulesHash(file.content) !== expectedHash) blocked()
  return { rulesetName: backup.rulesetName, canonicalSha256: expectedHash, rawSha256: backup.rawSha256, sourceBytes: backup.sourceBytes }
}

async function list(get, url, key, extra = {}) {
  let token
  const seen = new Set()
  const rows = []
  for (let page = 0; page < 100; page++) {
    const result = await get(url, { ...extra, ...(token ? { pageToken: token } : {}) })
    if (!record(result) || (result[key] !== undefined && !Array.isArray(result[key]))) blocked()
    rows.push(...(result[key] ?? []))
    if (!result.nextPageToken) return rows
    if (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 10000 || seen.has(result.nextPageToken)) blocked()
    token = result.nextPageToken
    seen.add(token)
  }
  blocked()
}

export function isInvitationIndex(value) {
  return record(value) && typeof value.name === 'string' && value.name.startsWith(`${DATABASE}/collectionGroups/invitations/indexes/`) &&
    value.queryScope === INDEX.queryScope && Array.isArray(value.fields) && value.fields.length === INDEX.fields.length &&
    value.fields.every((field, i) => field.fieldPath === INDEX.fields[i].fieldPath && field.order === INDEX.fields[i].order && !field.arrayConfig && !field.vectorConfig) &&
    (value.apiScope === undefined || value.apiScope === 'ANY_API') && (value.density === undefined || value.density === 'SPARSE_ALL') && !value.unique && !value.multikey
}
function definitions(indexes) {
  return indexes.map(({ state: _state, ...definition }) => JSON.stringify(definition)).sort()
}

export async function runResources({ options, gitState, authorize, get, postIndex, transport, persist, readBackup, writeBackup,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date().toISOString() }) {
  resourcesGuard(options, await gitState())
  const event = { task: 'SEC-006 Stage 8', mode: options.mode, project: PROJECT, sourceHead: options.expectedHead, startedAt: now(), createAttempted: false, operation: null, indexName: null, observedIndexState: null }
  const finish = async (status, extra = {}) => {
    const result = { ...event, ...extra, status, finishedAt: now() }
    await persist(result)
    return result
  }
  if (options.mode === 'verify-rules-backup') {
    const verified = verifyBackup(await readBackup(), options.expectedRulesHash)
    resourcesGuard(options, await gitState())
    return finish('RULES_BACKUP_VERIFIED_LOCAL', verified)
  }
  await authorize()
  const project = await get(URLS.project, { fields: 'projectId,projectNumber' })
  if (!record(project) || project.projectId !== PROJECT || !/^\d+$/.test(project.projectNumber ?? '')) blocked()
  const database = await get(URLS.database, { fields: 'name,locationId,type' })
  if (!record(database) || database.name !== DATABASE || database.type !== 'FIRESTORE_NATIVE' || database.locationId !== 'eur3') blocked()
  if (options.mode.includes('rules')) {
    const readRules = async () => {
      const release = await get(URLS.release)
      if (!record(release) || release.name !== `projects/${PROJECT}/releases/cloud.firestore`) blocked()
      transport.allowRuleset(release.rulesetName)
      const ruleset = await get(rulesetUrl(release.rulesetName))
      if (!record(ruleset) || ruleset.name !== release.rulesetName || !Array.isArray(ruleset.source?.files) || ruleset.source.files.length !== 1) blocked()
      const file = ruleset.source.files[0]
      if (typeof file.content !== 'string') blocked()
      const backup = { format: 'finapp-rules-backup-v1', project: PROJECT, database: DATABASE, sourceHead: options.expectedHead, capturedAt: now(),
        release: clone(release), rulesetName: release.rulesetName, source: clone(ruleset.source),
        canonicalSha256: rulesHash(file.content), rawSha256: sha256(file.content), sourceBytes: Buffer.byteLength(file.content) }
      verifyBackup(backup, options.expectedRulesHash)
      return backup
    }
    const backup = await readRules()
    if (options.mode === 'backup-rules') {
      await writeBackup(backup)
      const verified = verifyBackup(await readBackup(), options.expectedRulesHash)
      if (verified.rawSha256 !== backup.rawSha256 || verified.rulesetName !== backup.rulesetName) blocked()
      // Read back the current release too; a capture is not fresh if the
      // active release changed while the disk backup was being verified.
      const current = await readRules()
      if (current.rulesetName !== backup.rulesetName || current.rawSha256 !== backup.rawSha256) blocked()
    }
    resourcesGuard(options, await gitState())
    return finish(options.mode === 'backup-rules' ? 'RULES_BACKUP_SAVED_VERIFIED' : 'CURRENT_RULES_HASH_VERIFIED', verifyBackup(backup, options.expectedRulesHash))
  }

  let lastFieldMetadata
  const readIndexes = async () => {
    const indexes = await list(get, URLS.indexes, 'indexes')
    const names = new Set()
    for (const index of indexes) {
      if (!record(index) || typeof index.name !== 'string' || !index.name.startsWith(`${DATABASE}/collectionGroups/`) ||
          !index.name.includes('/indexes/') || !Array.isArray(index.fields) || names.has(index.name)) blocked()
      names.add(index.name)
    }
    const fields = await list(get, URLS.fields, 'fields', { filter: 'indexConfig.usesAncestorConfig=false OR ttlConfig:*' })
    if (fields.some(field => !record(field) || typeof field.name !== 'string' || !field.name.startsWith(`${DATABASE}/collectionGroups/`))) blocked()
    if (sha256(JSON.stringify(fields)) !== options.expectedFieldHash) blocked()
    lastFieldMetadata = fields
    return indexes
  }
  const before = await readIndexes()
  event.beforeIndexesSha256 = sha256(JSON.stringify(before))
  event.fieldOverridesSha256 = options.expectedFieldHash
  const find = indexes => {
    const matches = indexes.filter(isInvitationIndex)
    if (matches.length > 1) blocked()
    if (matches[0]) indexUrl(matches[0].name)
    return matches[0]
  }
  let matching = find(before)
  if (options.mode === 'verify-index') {
    resourcesGuard(options, await gitState())
    return finish(matching?.state === 'READY' ? 'INVITATION_INDEX_READY_VERIFIED' : 'INVITATION_INDEX_NOT_READY', { indexName: matching?.name ?? null, observedIndexState: matching?.state ?? null })
  }
  // This journal is private. Preserve exact restorable metadata before any
  // create; public reports receive only final hashes/outcomes, not this row.
  await persist({ ...event, status: 'INDEX_PREFLIGHT_VERIFIED', beforeIndexes: clone(before), beforeFieldOverrides: clone(lastFieldMetadata) })
  let operation
  if (!matching) {
    const fresh = await readIndexes()
    matching = find(fresh)
    // Preserve all prior definitions; new unexpected indexes also stop this
    // mutation. A matching index created concurrently is safely reused.
    if (JSON.stringify(definitions(fresh.filter(index => index !== matching))) !== JSON.stringify(definitions(before))) blocked()
    if (!matching) {
      resourcesGuard(options, await gitState())
      event.createAttempted = true
      await persist({ ...event, status: 'INDEX_CREATE_REQUEST_MAY_BE_SENT' })
      try {
        operation = await postIndex(clone(INDEX))
        if (!record(operation)) blocked()
        indexOperationUrl(operation.name)
        event.operation = operation.name
        await persist({ ...event, status: 'INDEX_OPERATION_RECEIVED' })
        transport.allowOperation(operation.name)
        resourcesGuard(options, await gitState())
      } catch { return finish('INDEX_CREATE_UNCERTAIN') }
    }
  }
  // Poll only a returned operation or the exact matching index. No automatic
  // create retry follows an unknown result. verify-index reconciles reads.
  for (let attempt = 0; attempt <= 24; attempt++) {
    try {
      if (operation) {
        if (operation.done === true && operation.error !== undefined) return finish('INDEX_OPERATION_FAILED')
        if (operation.done === true) {
          if (!isInvitationIndex(operation.response)) return finish('INDEX_CREATE_UNCERTAIN')
          matching = operation.response
          operation = undefined
        } else if (operation.done !== undefined && operation.done !== false) return finish('INDEX_CREATE_UNCERTAIN')
      }
      if (matching) {
        transport.allowIndex(matching.name)
        event.indexName = matching.name
        matching = await get(indexUrl(matching.name))
        if (!isInvitationIndex(matching) || matching.name !== event.indexName) blocked()
        event.observedIndexState = matching.state
        if (matching.state === 'NEEDS_REPAIR') return finish('INVITATION_INDEX_NEEDS_REPAIR')
        if (matching.state === 'READY') {
          const after = await readIndexes()
          const exact = find(after)
          if (!exact || exact.name !== matching.name || exact.state !== 'READY') blocked()
          const originalOther = before.filter(index => index.name !== matching.name)
          const currentOther = after.filter(index => index.name !== matching.name)
          if (JSON.stringify(definitions(currentOther)) !== JSON.stringify(definitions(originalOther))) blocked()
          resourcesGuard(options, await gitState())
          return finish('INVITATION_INDEX_READY_VERIFIED')
        }
        if (matching.state !== 'CREATING') blocked()
      }
      if (attempt === 24) return finish(event.createAttempted ? 'INDEX_CREATE_UNCERTAIN' : 'INVITATION_INDEX_NOT_READY')
      await sleep(5000)
      if (operation) {
        operation = await get(indexOperationUrl(event.operation))
        if (!record(operation) || operation.name !== event.operation) blocked()
      }
    } catch { return finish(event.createAttempted ? 'INDEX_CREATE_UNCERTAIN' : 'INDEX_VERIFICATION_BLOCKED') }
  }
}
