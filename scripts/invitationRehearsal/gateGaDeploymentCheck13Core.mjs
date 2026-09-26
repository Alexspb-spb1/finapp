// FINAPP-1.0-SEC-006-GATE-G-A-DEPLOYMENT-CHECK-13FN.
//
// Staging (finapp-staging) now has 13 real ACTIVE Gen2 callables, not the 8
// deploymentCheckCore.mjs's postflight mode was built to attest: the
// original 8 SEC-006 invitation functions plus 5 SEC-007/M1 member-
// management functions (changeMemberRole, disableMember, restoreMember,
// removeMember, listCompanyMembers), already deployed under a previously
// agreed plan. deploymentCheckCore.mjs's exact-eight check correctly
// refuses to attest this 13-function state — it is NOT modified here, and
// its own self-test/mutation coverage is untouched. This module is a
// SEPARATE, additively-identifiable check for the 13-function state: it
// reuses deploymentCheckCore.mjs's transport/shape-validation building
// blocks (CALLABLES, REGION, URLS, FIELDS, deploymentTransport,
// metadataRequestOptions, requestSpec, checkFunction) without changing any
// of them, and adds its own orchestration, member-management shape check,
// and baseline-receipt provenance/drift validation. Its status string
// (DEPLOYMENT_METADATA_VERIFIED_13FN) can never be confused with or
// silently substituted for the original check's DEPLOYMENT_METADATA_VERIFIED.
import { createHash } from 'node:crypto'
import { guard, PROJECT, DATABASE } from './inventoryCore.mjs'
import {
  CALLABLES as BASELINE_CALLABLES, REGION, URLS, FIELDS,
  deploymentTransport, metadataRequestOptions, requestSpec, checkFunction,
} from './deploymentCheckCore.mjs'

export const TASK = 'FINAPP-1.0-SEC-006-GATE-G-A-DEPLOYMENT-CHECK-13FN'

// Verified against functions/src/index.ts's single module-scope
// setGlobalOptions({...}) call on origin/remediation/SEC-007-member-
// management-functions @ 8526a79 — every onCall() in that file, including
// all 5 of these, shares the SAME declared resource shape as the 8 SEC-006
// functions (region us-central1, 256MiB, cpu 1, concurrency 1, minInstances
// 0, maxInstances 1, timeoutSeconds 60, nodejs22/functions/package.json
// engines.node). No M1-specific resource limits exist to diverge from.
export const MEMBER_MANAGEMENT_CALLABLES = Object.freeze([
  'changeMemberRole', 'disableMember', 'restoreMember', 'removeMember', 'listCompanyMembers',
])
export const ALL_CALLABLES = Object.freeze([...BASELINE_CALLABLES, ...MEMBER_MANAGEMENT_CALLABLES])

// Pinned provenance for the ONLY baseline receipt this check trusts for the
// 8 SEC-006 functions' drift comparison. Both values were independently
// verified (not merely asserted) before being pinned here:
//   - EXPECTED_BASELINE_SOURCE_HEAD is a real commit, reachable from this
//     repository's history (`git merge-base --is-ancestor
//     ab1bd670ad04debd081af542e367c5dfc95e55ab HEAD` — exit 0 — on
//     remediation/SEC-006-stage-8-rehearsal, an ancestor of main).
//   - EXPECTED_BASELINE_RECEIPT_SHA256 matches the SHA-256 recorded in
//     docs/remediation/reports/SEC-006.md's "Approved staging backend
//     deployment completed — 2026-09-08" entry for
//     stage8-deployment-postflight-ab1bd67.json, BEFORE this check ever
//     reads or trusts the file's contents — the file's mere existence or a
//     freshly-computed hash of it alone is never sufficient.
export const EXPECTED_BASELINE_SOURCE_HEAD = 'ab1bd670ad04debd081af542e367c5dfc95e55ab'
export const EXPECTED_BASELINE_RECEIPT_SHA256 = 'db0c2508ff2595a6be62ebd91ea784bcdda7fbd09f62353ddf406c9e3c3592a5'

const blocked = () => { throw new Error('deployment_check_13fn_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sha256Bytes = value => createHash('sha256').update(value).digest('hex')
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export { deploymentTransport, metadataRequestOptions, requestSpec, URLS, FIELDS }

/**
 * Validates the baseline receipt's provenance and internal consistency
 * BEFORE a single one of its fields is trusted for drift comparison:
 * exact pinned SHA-256 of its raw bytes, exact pinned sourceHead, and —
 * via the caller-supplied `commitIsReachable` (a real `git merge-base
 * --is-ancestor` result computed by the caller, never fabricated here) —
 * that the pinned sourceHead is a real, reachable commit in this
 * repository's history, not merely a well-formed-looking string. The
 * receipt's existence alone (or an unpinned, freshly-computed hash of it)
 * is never treated as proof.
 */
export function validateBaselineReceiptProvenance({
  bytes, commitIsReachable,
  expectedReceiptSha256 = EXPECTED_BASELINE_RECEIPT_SHA256, expectedSourceHead = EXPECTED_BASELINE_SOURCE_HEAD,
}) {
  if (!(typeof bytes === 'string' || Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) ||
      typeof commitIsReachable !== 'boolean' || !hex64(expectedReceiptSha256) || !/^[a-f0-9]{40}$/.test(expectedSourceHead)) blocked()
  if (sha256Bytes(bytes) !== expectedReceiptSha256 || !commitIsReachable) blocked()
  let receipt
  try { receipt = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { blocked() }
  if (!record(receipt) || receipt.task !== 'SEC-006 Stage 8' || receipt.mode !== 'postflight' ||
      receipt.status !== 'DEPLOYMENT_METADATA_VERIFIED' || receipt.project !== PROJECT ||
      receipt.sourceHead !== expectedSourceHead || receipt.billingEnabled !== true ||
      !record(receipt.database) || receipt.database.type !== 'FIRESTORE_NATIVE' || receipt.database.locationId !== 'eur3' ||
      !Array.isArray(receipt.functions) || receipt.functions.length !== BASELINE_CALLABLES.length ||
      !Array.isArray(receipt.deploymentAllowlist) ||
      JSON.stringify([...receipt.deploymentAllowlist].sort()) !== JSON.stringify([...BASELINE_CALLABLES].sort())) blocked()
  const byName = new Map()
  for (const fn of receipt.functions) {
    if (!record(fn) || typeof fn.name !== 'string') blocked()
    const shortName = fn.name.split('/').pop()
    if (!shortName || !BASELINE_CALLABLES.includes(shortName)) blocked()
    if (fn.state !== 'ACTIVE' || fn.generation !== 2 || fn.runtime !== 'nodejs22' || fn.region !== REGION ||
        typeof fn.revision !== 'string' || !fn.revision.length ||
        typeof fn.build !== 'string' || !fn.build.length ||
        !hex64(fn.sourceReferenceSha256) || !hex64(fn.sourceProvenanceSha256)) blocked()
    byName.set(shortName, fn)
  }
  if (byName.size !== BASELINE_CALLABLES.length) blocked()
  return Object.freeze(byName)
}

// Mirrors checkFunction() from deploymentCheckCore.mjs exactly (same
// GEN_2/ACTIVE/nodejs22/256Mi/cpu1/concurrency1/minInstances0/maxInstances1/
// timeoutSeconds60 shape — see the module header comment for why these are
// identical for the M1 functions too), parameterized by
// MEMBER_MANAGEMENT_CALLABLES instead of the baseline CALLABLES so the
// two name sets can never be silently merged or confused by a future edit
// to either module.
export function checkMemberManagementFunction(value, projectNumber) {
  if (!record(value) || !/^\d+$/.test(projectNumber ?? '')) blocked()
  const name = MEMBER_MANAGEMENT_CALLABLES.find(id => value.name === `projects/${PROJECT}/locations/${REGION}/functions/${id}`)
  if (!name || value.environment !== 'GEN_2' || value.state !== 'ACTIVE' ||
      !record(value.buildConfig) || value.buildConfig.runtime !== 'nodejs22' || value.buildConfig.entryPoint !== name ||
      !record(value.serviceConfig)) blocked()
  const config = value.serviceConfig
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
    sourceKind, sourceReferenceSha256: sha(source),
    sourceProvenanceSha256: record(value.buildConfig.sourceProvenance) ? sha(value.buildConfig.sourceProvenance) : null,
    rollbackArtifactAvailability: 'NOT_VERIFIED',
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

export function deploymentGuard13(options, git) {
  guard({ ...options, ...git })
}

/**
 * The 13-function counterpart of runDeploymentCheck({mode:'postflight'}).
 * Exactly ALL_CALLABLES (13, no more, no fewer, no duplicates) must be
 * present. The 8 baseline functions are validated with the SAME
 * checkFunction() the exact-eight check uses, AND diffed field-by-field
 * (revision/build/sourceReferenceSha256/sourceProvenanceSha256) against the
 * provenance-validated baseline receipt — any drift blocks. The 5 M1
 * functions are validated for shape only (no receipt exists yet to diff
 * them against).
 */
export async function run13FunctionDeploymentCheck({
  options, gitState, authorize, get, baselineReceiptBytes, commitIsReachable,
  expectedReceiptSha256 = EXPECTED_BASELINE_RECEIPT_SHA256, expectedSourceHead = EXPECTED_BASELINE_SOURCE_HEAD,
  now = () => new Date().toISOString(),
}) {
  deploymentGuard13(options, await gitState())
  const baselineByName = validateBaselineReceiptProvenance({
    bytes: baselineReceiptBytes, commitIsReachable, expectedReceiptSha256, expectedSourceHead,
  })
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
  if (v2.length !== ALL_CALLABLES.length) blocked()
  const seen = new Set()
  const functions = []
  for (const value of v2) {
    const shortName = typeof value?.name === 'string' ? value.name.split('/').pop() : null
    if (!shortName || !ALL_CALLABLES.includes(shortName)) blocked()
    seen.add(shortName)
    if (BASELINE_CALLABLES.includes(shortName)) {
      const checked = checkFunction(value, project.projectNumber)
      const recorded = baselineByName.get(shortName)
      if (!recorded || checked.revision !== recorded.revision || checked.build !== recorded.build ||
          checked.sourceReferenceSha256 !== recorded.sourceReferenceSha256 ||
          checked.sourceProvenanceSha256 !== recorded.sourceProvenanceSha256) blocked()
      functions.push({ ...checked, family: 'baseline', driftCheckedAgainstSourceHead: expectedSourceHead })
    } else {
      const checked = checkMemberManagementFunction(value, project.projectNumber)
      functions.push({ ...checked, family: 'member-management' })
    }
  }
  if (seen.size !== ALL_CALLABLES.length) blocked()
  functions.sort((a, b) => a.name.localeCompare(b.name))
  deploymentGuard13(options, await gitState())
  return Object.freeze({
    task: TASK, mode: 'postflight13fn', status: 'DEPLOYMENT_METADATA_VERIFIED_13FN',
    project: PROJECT, sourceHead: options.expectedHead, startedAt, finishedAt: now(),
    billingEnabled: true, database: { name: DATABASE, type: 'FIRESTORE_NATIVE', locationId: 'eur3' },
    functions,
    baselineCallables: BASELINE_CALLABLES, memberManagementCallables: MEMBER_MANAGEMENT_CALLABLES,
    baselineDriftCheckedAgainstReceiptSha256: expectedReceiptSha256,
    baselineDriftCheckedAgainstSourceHead: expectedSourceHead,
    excludedFromDeployment: ['authzProbe'],
    cloudMutations: 0, callableInvocations: 0, realEmailDeliveryVerified: false,
    limitations: [
      'Metadata is not behavioral or real-email acceptance',
      'Source fingerprints do not prove recoverable artifacts',
      'This check does not grant deployment approval',
      'Member-management functions are validated for shape only; no prior-baseline drift check exists for them yet',
    ],
  })
}
