#!/usr/bin/env node
// FINAPP-1.0-M1 R3 - read-only EXACT-state check of the Functions on finapp-staging.
// Reuses the reviewed repository transport/guards (deploymentCheckCore, inventoryCore) exactly as the
// rev7 baseline/postflight modes did; like rev8 it has no baseline/postflight modes because the R3 release
// deploys no Functions (the Functions source is byte-identical between 8526a79 and 714d0f91).
//
//   exact: exactly the 13 pinned functions (8 SEC-006 baseline + 5 M1), all ACTIVE with exact caps,
//          and every function's revision, build and source fingerprint equal to the value pinned in
//          expected-state-r3.json (taken from the rev7 postflight and re-observed by rev8). Any drift is a STOP.
//
//   node m1-functions-check.mjs --mode exact --expected-head <sha> --expected <abs expected-state-r3.json> --out <new abs json>
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { gitState, REPO } from './m1-core.mjs'
import { compareFunctions, validateExpected } from './m1-state-lib.mjs'

const core = await import(pathToFileURL(path.join(REPO, 'scripts/invitationRehearsal/deploymentCheckCore.mjs')).href)
const inv = await import(pathToFileURL(path.join(REPO, 'scripts/invitationRehearsal/inventoryCore.mjs')).href)
const blocked = reason => { throw new Error(reason) }
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex')

function checkFunction(value, projectNumber, allowed) {
  const name = allowed.find(id => value?.name === `projects/${inv.PROJECT}/locations/${core.REGION}/functions/${id}`)
  if (!name || value.environment !== 'GEN_2' || value.state !== 'ACTIVE' || value.buildConfig?.runtime !== 'nodejs22' ||
      value.buildConfig?.entryPoint !== name || !record(value.serviceConfig)) blocked(`function shape ${name ?? 'unexpected'}`)
  const c = value.serviceConfig
  const minInstances = Object.hasOwn(c, 'minInstanceCount') ? c.minInstanceCount : 0
  if (c.availableMemory !== '256Mi' || c.availableCpu !== '1' || c.maxInstanceRequestConcurrency !== 1 || minInstances !== 0 ||
      c.maxInstanceCount !== 1 || c.timeoutSeconds !== 60) blocked(`caps ${name}`)
  if (typeof c.revision !== 'string' || !c.revision.startsWith(`${name.toLowerCase()}-`)) blocked(`revision ${name}`)
  if (typeof value.buildConfig.build !== 'string' || !new RegExp(`^projects/(?:${inv.PROJECT}|${projectNumber})/locations/[a-z0-9-]+/builds/[a-f0-9-]{36}$`).test(value.buildConfig.build)) blocked(`build ${name}`)
  if (!record(value.buildConfig.source)) blocked(`source ${name}`)
  return { id: name, state: 'ACTIVE', runtime: 'nodejs22', resources: { memory: '256Mi', cpu: 1, concurrency: 1, minInstances: 0, maxInstances: 1, timeoutSeconds: 60 },
    revision: c.revision, build: value.buildConfig.build, sourceReferenceSha256: sha(value.buildConfig.source) }
}

async function list(get, kind) {
  const rows = []
  let token
  for (let page = 0; page < 10; page++) {
    const r = await get(core.requestSpec(kind, token))
    if (!record(r) || (r.unreachable !== undefined && r.unreachable.length)) blocked('list')
    rows.push(...(r.functions ?? []))
    if (!r.nextPageToken) return rows
    token = r.nextPageToken
  }
  blocked('pages')
}

const originalFetch = globalThis.fetch
try {
  const args = process.argv.slice(2), opts = {}
  for (let i = 0; i < args.length; i += 2) opts[args[i]] = args[i + 1]
  if (args.length !== 8 || opts['--mode'] !== 'exact' || !opts['--out'] || !opts['--expected'] || !path.isAbsolute(opts['--expected']) || !fs.existsSync(opts['--expected'])) blocked('arguments')
  const expected = JSON.parse(fs.readFileSync(opts['--expected'], 'utf8'))
  if (validateExpected(expected).length) blocked('expected-state file')
  const git = gitState()
  inv.guard({ project: inv.PROJECT, expectedHead: opts['--expected-head'], head: git.head, status: git.status, env: process.env })
  const out = opts['--out']
  if (!path.isAbsolute(out) || fs.existsSync(out) || !path.relative(REPO, out).startsWith('..')) blocked('output path')

  globalThis.fetch = core.deploymentTransport(originalFetch)
  const require = createRequire(import.meta.url)
  const ft = name => require(path.join(REPO, 'node_modules/firebase-tools/lib', name))
  ft('logger.js').logger.silent = true
  const account = ft('auth.js').getGlobalDefaultAccount()
  inv.guardCliAccount(account)
  if (!await ft('requireAuth.js').requireAuth({ project: inv.PROJECT, user: account.user, tokens: account.tokens }, true)) blocked('auth')
  const { Client } = ft('apiv2.js')
  const get = async ({ url: target, queryParams }) => {
    const url = new URL(target), client = new Client({ urlPrefix: url.origin, auth: true })
    return (await client.get(url.pathname, { queryParams, ...core.metadataRequestOptions(target), skipLog: { body: true, resBody: true, queryParams: true }, redirect: 'error', retries: 0, timeout: 10000 })).body
  }

  const project = await get(core.requestSpec('project'))
  if (project?.projectId !== inv.PROJECT || !/^\d+$/.test(project.projectNumber ?? '')) blocked('project')
  if ((await list(get, 'functionsV1')).length) blocked('unexpected v1 functions')
  const v2 = await list(get, 'functionsV2')
  const ids = expected.functions.map(f => f.id)
  if (v2.length !== ids.length) blocked(`function count ${v2.length} != ${ids.length}`)
  const functions = v2.map(v => checkFunction(v, project.projectNumber, ids)).sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(functions.map(f => f.id)).size !== ids.length) blocked('duplicate function')
  const drift = compareFunctions(functions, expected)
  if (drift.length) blocked(`state drift: ${drift.slice(0, 3).join(', ')}`)
  const result = {
    task: 'FINAPP-1.0-M1', mode: 'exact', project: inv.PROJECT, sourceHead: git.head, at: new Date().toISOString(),
    status: 'M1_FUNCTIONS_EXACT_STATE_VERIFIED', functions, cloudMutations: 0, callableInvocations: 0,
  }
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(`${result.status}: ${functions.length} functions; read-only.`)
} catch (error) {
  console.error(`M1_FUNCTIONS_CHECK_BLOCKED: ${String(error?.message ?? 'error').slice(0, 120)}`)
  process.exitCode = 2
} finally {
  globalThis.fetch = originalFetch
}
