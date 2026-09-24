import path from 'node:path'
import { createHash } from 'node:crypto'
import { LIVE_LIMITS, PROJECT, TOTAL_CALLABLE_CAP } from './liveAcceptanceCore.mjs'

// gate-G-A (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8): the staging execution
// path runs the full orchestrated sequence — preflight, run-id + durable run
// manifest claim (or, with --resume true, a validated resume of that exact
// manifest), recipient guard, legacy-residual inventory, readiness, the
// invitation/email/acceptance/idempotency flow, REAL cleanup+verify-clean of
// the current run, and a separately-gated (--legacy-cleanup-approved,
// bound to the approval document) legacy cleanup+verify-clean — ending in an
// explicit PASS or SAFE_STOP, never a plan-only stub. No approval shaped for
// any prior task name (R4/R5, or the historical CLEANUP_PLAN_ONLY shape) can
// drive an execute() call through this file — GATE_GA_TASK's exact string
// and the exact `limits` key set below are both required, by construction,
// not merely discouraged.
export const GATE_GA_TASK = 'FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8 live orchestrated execution'
export const EMULATOR_PROJECT = 'demo-finapp'
export const EXECUTOR_HELP = 'node scripts/invitationRehearsal/liveAcceptanceExecutor.mjs --execute --profile staging|emulator --project finapp-staging|demo-finapp --expected-head <reviewed-40-char-SHA> --approval <existing-absolute-private-JSON> --approval-sha256 <exact-SHA256> --journal <absolute-private-JSONL: new unless --resume true, then the SAME path as the prior invocation> --out <new-absolute-private-JSON> --recipient <email> --recipient-confirmed-sha256 <exact-SHA256> --resume true|false --legacy-cleanup-approved true|false'
export const EXECUTOR_ARGUMENTS = Object.freeze([
  '--profile', '--project', '--expected-head', '--approval', '--approval-sha256', '--journal', '--out',
  '--recipient', '--recipient-confirmed-sha256', '--resume', '--legacy-cleanup-approved',
])
const BOOL_STRING = value => value === 'true' || value === 'false'

const blocked = () => { throw new Error('live_executor_cli_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const EXECUTION_APPROVAL_TTL_MS = 60 * 60 * 1000
const PROJECT_FOR_PROFILE = Object.freeze({ staging: PROJECT, emulator: EMULATOR_PROJECT })

export function parseExecutorCliArgs(args) {
  if (!Array.isArray(args) || args[0] !== '--execute' || args.length !== 1 + EXECUTOR_ARGUMENTS.length * 2) blocked()
  const parsed = { mode: 'execute' }
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]
    if (!EXECUTOR_ARGUMENTS.includes(name) || Object.hasOwn(parsed, name) || typeof value !== 'string' || !value || value.startsWith('--')) blocked()
    parsed[name] = value
  }
  if (Object.keys(parsed).length !== EXECUTOR_ARGUMENTS.length + 1) blocked()
  if (!Object.hasOwn(PROJECT_FOR_PROFILE, parsed['--profile']) || parsed['--project'] !== PROJECT_FOR_PROFILE[parsed['--profile']]) blocked()
  if (!/^[a-f0-9]{40}$/.test(parsed['--expected-head']) || !hex64(parsed['--approval-sha256']) || !hex64(parsed['--recipient-confirmed-sha256'])) blocked()
  for (const name of ['--approval', '--journal', '--out']) if (!path.isAbsolute(parsed[name])) blocked()
  if (parsed['--recipient'].length === 0 || parsed['--recipient'].startsWith('--')) blocked()
  if (!BOOL_STRING(parsed['--resume']) || !BOOL_STRING(parsed['--legacy-cleanup-approved'])) blocked()
  return Object.freeze(parsed)
}

export async function routeExecutorCli({ args, writeHelp, runSelfTests, execute }) {
  if (!Array.isArray(args) || typeof writeHelp !== 'function' || typeof runSelfTests !== 'function' || typeof execute !== 'function') blocked()
  if (args.length === 1 && args[0] === '--help') { await writeHelp(); return 0 }
  if (args.length === 1 && args[0] === '--self-test') return runSelfTests()
  return execute(parseExecutorCliArgs(args))
}

export function approvalCommandSha256(parsed) {
  if (!parsed || parsed.mode !== 'execute') blocked()
  return sha256(JSON.stringify({
    mode: 'execute', profile: parsed['--profile'], project: parsed['--project'], sourceHead: parsed['--expected-head'],
    journalPathSha256: sha256(path.resolve(parsed['--journal'])),
    outputPathSha256: sha256(path.resolve(parsed['--out'])),
    // Binding the confirmed recipient hash into the approved command means an
    // approval reviewed for one recipient can never silently authorize a
    // run against a different one. Binding resume/legacyCleanupApproved
    // means an approval reviewed for one of those cannot be replayed with
    // the other silently flipped.
    recipientConfirmedSha256: parsed['--recipient-confirmed-sha256'],
    resume: parsed['--resume'] === 'true',
    legacyCleanupApproved: parsed['--legacy-cleanup-approved'] === 'true',
  }))
}

export function validatePrivateExecutorPaths({ parsed, repoRoot, io }) {
  if (!parsed || typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || !io) blocked()
  const root = io.realpathSync(repoRoot)
  // --resume true requires the journal from the prior invocation to already
  // exist at this exact path (the "consistent existing state/journal pair"
  // this file's resume mode requires) — --resume false (a fresh run)
  // requires it to NOT exist, same as --out and --approval's existing rules.
  const resume = parsed['--resume'] === 'true'
  const resolved = {}
  for (const [name, existing] of [['--approval', true], ['--journal', resume], ['--out', false]]) {
    const input = parsed[name]
    if (io.existsSync(input) !== existing) blocked()
    const parent = io.realpathSync(path.dirname(input))
    if (existing && io.lstatSync(input).isSymbolicLink()) blocked()
    const target = existing ? io.realpathSync(input) : path.join(parent, path.basename(input))
    const relative = path.relative(root, target)
    if ((!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) ||
        (existing && (!io.lstatSync(target).isFile() || io.lstatSync(target).isSymbolicLink()))) blocked()
    resolved[name] = target
  }
  const recoveryInput = `${resolved['--out']}.recovery.jsonl`
  if (io.existsSync(recoveryInput)) blocked()
  const recoveryParent = io.realpathSync(path.dirname(recoveryInput))
  const recoveryTarget = path.join(recoveryParent, path.basename(recoveryInput))
  const recoveryRelative = path.relative(root, recoveryTarget)
  if ((!recoveryRelative.startsWith(`..${path.sep}`) && recoveryRelative !== '..' && !path.isAbsolute(recoveryRelative))) blocked()
  resolved.recovery = recoveryTarget
  const canonical = Object.values(resolved).map(value => process.platform === 'win32' ? value.toLowerCase() : value)
  if (new Set(canonical).size !== 4) blocked()
  return Object.freeze(resolved)
}

// Rejects, by construction, any approval shaped for the historical
// CLEANUP_PLAN_ONLY task (different `task` string, `cleanupAuthorized:
// false`) — there is no value of `bytes` that can satisfy both this
// validator and the old one, so an old-style approval simply cannot drive
// an execute() call through this file.
export function validateExecutionApproval({ parsed, bytes, now = () => Date.now() }) {
  if (!(typeof bytes === 'string' || Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) ||
      sha256(bytes) !== parsed['--approval-sha256'] || Buffer.byteLength(bytes) < 1 || Buffer.byteLength(bytes) > 64 * 1024) blocked()
  let value
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { blocked() }
  if (!exactKeys(value, [
    'version', 'task', 'status', 'profile', 'project', 'sourceHead', 'prHead', 'reviewStatus', 'ciStatus', 'functionsStatus',
    'approvedAt', 'expiresAt', 'commandSha256', 'mailboxSha256', 'functionsSha256', 'authMetadataSha256',
    'stagingFingerprint', 'limits',
  ]) || value.version !== 1 || value.task !== GATE_GA_TASK || value.status !== 'APPROVED' ||
      value.profile !== parsed['--profile'] ||
      value.project !== parsed['--project'] || value.sourceHead !== parsed['--expected-head'] || value.prHead !== value.sourceHead ||
      value.reviewStatus !== 'PASS' || value.ciStatus !== 'PASS' || value.functionsStatus !== 'PASS' ||
      !iso(value.approvedAt) || !iso(value.expiresAt) || value.commandSha256 !== approvalCommandSha256(parsed) ||
      [value.mailboxSha256, value.functionsSha256, value.authMetadataSha256, value.stagingFingerprint].some(item => !hex64(item)) ||
      !exactKeys(value.limits, [
        'fixtureMutationSlots', 'totalCallableRequests', 'verificationEmails',
        'cleanupAuthorized', 'legacyCleanupApproved', 'productionAuthorized',
      ]) ||
      value.limits.fixtureMutationSlots !== 16 || value.limits.totalCallableRequests !== TOTAL_CALLABLE_CAP ||
      value.limits.verificationEmails !== LIVE_LIMITS.verificationEmails ||
      // Inverted from the historical validator on purpose: an approval that
      // does NOT authorize real cleanup is exactly the old shape and is
      // refused here, not accepted with cleanup silently skipped.
      value.limits.cleanupAuthorized !== true ||
      // R6: a real, explicit, per-run decision — not a fixed always-true
      // documentation flag (the R4/R5 shape). The approval's own stated
      // decision must exactly match what the CLI invocation is requesting
      // (bound into commandSha256 above); a reviewer who approved this
      // document with legacyCleanupApproved:false can never have that
      // silently upgraded to true by the invocation alone, and vice versa.
      value.limits.legacyCleanupApproved !== (parsed['--legacy-cleanup-approved'] === 'true') ||
      value.limits.productionAuthorized !== false) blocked()
  const instant = now(), approvedAt = Date.parse(value.approvedAt), expiresAt = Date.parse(value.expiresAt)
  if (!Number.isSafeInteger(instant) || approvedAt > instant || expiresAt <= instant ||
      expiresAt - approvedAt !== EXECUTION_APPROVAL_TTL_MS) blocked()
  return Object.freeze(structuredClone(value))
}

export function validateCleanExecutorHead({ parsed, gitState }) {
  if (!exactKeys(gitState, ['head', 'status']) || gitState.head !== parsed['--expected-head'] || gitState.status !== '') blocked()
  return true
}

/**
 * Keep the runtime module entirely unloaded until every local gate passes.
 * Unlike the historical version of this function, a SAFE_STOP from the
 * orchestrator is a normal, fully-handled terminal outcome (cleanup for the
 * current run has already been attempted by the time this returns) — it is
 * reported, not thrown. Only PASS and SAFE_STOP are legitimate outcomes;
 * anything else (an indeterminate/unrecognized status) still blocks.
 */
export async function executeApprovedLiveRuntime({ parsed, repoRoot, io, gitState, missingAdapters, loadRuntime, now = () => Date.now() }) {
  if (!Array.isArray(missingAdapters) || missingAdapters.some(value => typeof value !== 'string' || !value) ||
      typeof loadRuntime !== 'function' || typeof gitState !== 'function') blocked()
  const paths = validatePrivateExecutorPaths({ parsed, repoRoot, io })
  const stat = io.statSync(paths['--approval'])
  if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) blocked()
  const approval = validateExecutionApproval({ parsed, bytes: io.readFileSync(paths['--approval']), now })
  const recheckHead = async () => validateCleanExecutorHead({ parsed, gitState: await gitState() })
  await recheckHead()
  if (missingAdapters.length) return Object.freeze({ status: 'ADAPTERS_INCOMPLETE', exitCode: 2, missing: Object.freeze([...missingAdapters]) })
  // loadRuntime() must resolve to the gate-G-A orchestrated runtime
  // (createGateGaStagingRuntime / createGateGaEmulatorRuntime) — see
  // gateGaStagingCliSelfTest.mjs's source-level seam test, which fails if
  // this file (or liveAcceptanceExecutor.mjs) ever calls the historical
  // createConcreteLiveAcceptanceRuntime as the TOP-LEVEL runtime again.
  const runtime = await loadRuntime()
  if (!exactKeys(runtime, ['run']) || typeof runtime.run !== 'function') blocked()
  await recheckHead()
  const value = await runtime.run(Object.freeze({
    parsed, paths, approval, recheckHead,
    resume: parsed['--resume'] === 'true', legacyCleanupApproved: parsed['--legacy-cleanup-approved'] === 'true',
  }))
  if (!record(value) || !['PASS', 'SAFE_STOP'].includes(value.status)) blocked()
  return Object.freeze({ status: value.status, exitCode: value.status === 'PASS' ? 0 : 1, missing: Object.freeze([]), orchestratorResult: value })
}
