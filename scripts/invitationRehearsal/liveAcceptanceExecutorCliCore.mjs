import path from 'node:path'
import { createHash } from 'node:crypto'
import { LIVE_LIMITS, PROJECT, TOTAL_CALLABLE_CAP } from './liveAcceptanceCore.mjs'

export const EXECUTOR_HELP = 'node scripts/invitationRehearsal/liveAcceptanceExecutor.mjs --execute --project finapp-staging --expected-head <reviewed-40-char-SHA> --approval <existing-absolute-private-JSON> --approval-sha256 <exact-SHA256> --journal <new-absolute-private-JSONL> --out <new-absolute-private-JSON>'
export const EXECUTOR_ARGUMENTS = Object.freeze([
  '--project', '--expected-head', '--approval', '--approval-sha256', '--journal', '--out',
])

const blocked = () => { throw new Error('live_executor_cli_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

export function parseExecutorCliArgs(args) {
  if (!Array.isArray(args) || args[0] !== '--execute' || args.length !== 1 + EXECUTOR_ARGUMENTS.length * 2) blocked()
  const parsed = { mode: 'execute' }
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]
    if (!EXECUTOR_ARGUMENTS.includes(name) || Object.hasOwn(parsed, name) || typeof value !== 'string' || !value || value.startsWith('--')) blocked()
    parsed[name] = value
  }
  if (Object.keys(parsed).length !== EXECUTOR_ARGUMENTS.length + 1 || parsed['--project'] !== PROJECT ||
      !/^[a-f0-9]{40}$/.test(parsed['--expected-head']) || !hex64(parsed['--approval-sha256'])) blocked()
  for (const name of ['--approval', '--journal', '--out']) if (!path.isAbsolute(parsed[name])) blocked()
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
    mode: 'execute', project: parsed['--project'], sourceHead: parsed['--expected-head'],
    journalPathSha256: sha256(path.resolve(parsed['--journal'])),
    outputPathSha256: sha256(path.resolve(parsed['--out'])),
  }))
}

export function validatePrivateExecutorPaths({ parsed, repoRoot, io }) {
  if (!parsed || typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || !io) blocked()
  const root = io.realpathSync(repoRoot)
  const resolved = {}
  for (const [name, existing] of [['--approval', true], ['--journal', false], ['--out', false]]) {
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

export function validateExecutionApproval({ parsed, bytes, now = () => Date.now() }) {
  if (!(typeof bytes === 'string' || Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) ||
      sha256(bytes) !== parsed['--approval-sha256'] || Buffer.byteLength(bytes) < 1 || Buffer.byteLength(bytes) > 64 * 1024) blocked()
  let value
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { blocked() }
  if (!exactKeys(value, [
    'version', 'task', 'status', 'project', 'sourceHead', 'prHead', 'reviewStatus', 'ciStatus', 'functionsStatus',
    'approvedAt', 'expiresAt', 'commandSha256', 'mailboxSha256', 'functionsSha256', 'authMetadataSha256',
    'stagingFingerprint', 'limits',
  ]) || value.version !== 1 || value.task !== 'SEC-006 Stage 8 live acceptance execution' || value.status !== 'APPROVED' ||
      value.project !== PROJECT || value.sourceHead !== parsed['--expected-head'] || value.prHead !== value.sourceHead ||
      value.reviewStatus !== 'PASS' || value.ciStatus !== 'PASS' || value.functionsStatus !== 'PASS' ||
      !iso(value.approvedAt) || !iso(value.expiresAt) || value.commandSha256 !== approvalCommandSha256(parsed) ||
      [value.mailboxSha256, value.functionsSha256, value.authMetadataSha256, value.stagingFingerprint].some(item => !hex64(item)) ||
      !exactKeys(value.limits, ['fixtureMutationSlots', 'totalCallableRequests', 'verificationEmails', 'cleanupAuthorized', 'productionAuthorized']) ||
      value.limits.fixtureMutationSlots !== 16 || value.limits.totalCallableRequests !== TOTAL_CALLABLE_CAP ||
      value.limits.verificationEmails !== LIVE_LIMITS.verificationEmails || value.limits.cleanupAuthorized !== false ||
      value.limits.productionAuthorized !== false) blocked()
  const instant = now(), approvedAt = Date.parse(value.approvedAt), expiresAt = Date.parse(value.expiresAt)
  if (!Number.isSafeInteger(instant) || approvedAt > instant || expiresAt < instant || expiresAt <= approvedAt || expiresAt - approvedAt > 24 * 60 * 60 * 1000) blocked()
  return Object.freeze(structuredClone(value))
}

export function validateCleanExecutorHead({ parsed, gitState }) {
  if (!exactKeys(gitState, ['head', 'status']) || gitState.head !== parsed['--expected-head'] || gitState.status !== '') blocked()
  return true
}

/** Keep the runtime module entirely unloaded until every local gate passes. */
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
  const runtime = await loadRuntime()
  if (!exactKeys(runtime, ['run']) || typeof runtime.run !== 'function') blocked()
  await recheckHead()
  const value = await runtime.run(Object.freeze({ parsed, paths, approval, recheckHead }))
  if (!exactKeys(value, ['status']) || value.status !== 'LIVE_ACCEPTANCE_VERIFIED') blocked()
  return Object.freeze({ status: value.status, exitCode: 0, missing: Object.freeze([]) })
}
