import fs from 'node:fs'
import path from 'node:path'

export const AUTH_SHAPE_DISCOVERY_HELP = 'node scripts/invitationRehearsal/authVerificationShapeDiscovery.mjs --project finapp-staging --expected-head <40hex> --out <new-absolute-private-JSON>'

const blocked = () => { throw new Error('auth_shape_discovery_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const normalizedPath = value => process.platform === 'win32' ? value.toLowerCase() : value

export function parseAuthShapeDiscoveryArgs(args) {
  if (!Array.isArray(args) || args.length !== 6) blocked()
  const parsed = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]
    if (!['--project', '--expected-head', '--out'].includes(name) || Object.hasOwn(parsed, name) ||
        typeof value !== 'string' || !value || value.startsWith('--')) blocked()
    parsed[name] = value
  }
  if (!exactKeys(parsed, ['--project', '--expected-head', '--out']) || parsed['--project'] !== 'finapp-staging' ||
      !/^[a-f0-9]{40}$/.test(parsed['--expected-head']) || !path.isAbsolute(parsed['--out'])) blocked()
  return Object.freeze(parsed)
}
function validateCleanHead(value, expectedHead) {
  if (!exactKeys(value, ['head', 'status']) || value.head !== expectedHead || value.status !== '') blocked()
}

function resolveNewExternalPath(filename, repoRoot, io) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || !io || io.existsSync(filename)) blocked()
  const root = io.realpathSync(repoRoot), parentInput = path.dirname(path.resolve(filename)), parent = io.realpathSync(parentInput)
  const parentStat = io.lstatSync(parentInput)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) blocked()
  const target = path.join(parent, path.basename(filename))
  if (normalizedPath(path.resolve(filename)) !== normalizedPath(target)) blocked()
  const relative = path.relative(root, target)
  if ((!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) || normalizedPath(target) === normalizedPath(root)) blocked()
  return target
}

function sanitizeDiscovery(value, observedAt, sourceHead) {
  if (!exactKeys(value, [
    'emailPasswordEnabled', 'userSignupDisabled', 'verificationMethodPresent',
    'verificationTemplateMetadataPresent', 'callbackDomainPresent', 'metadataSha256',
  ]) || value.emailPasswordEnabled !== true || value.userSignupDisabled !== false ||
      value.verificationMethodPresent !== true || value.verificationTemplateMetadataPresent !== true ||
      value.callbackDomainPresent !== true || !hex64(value.metadataSha256) || !iso(observedAt)) blocked()
  const receipt = {
    task: 'SEC-006 Stage 8 Auth verification-template shape discovery',
    status: 'AUTH_VERIFICATION_TEMPLATE_SHAPE_DISCOVERED', project: 'finapp-staging', sourceHead, observedAt,
    emailPasswordEnabled: true, userSignupDisabled: false, verificationMethodPresent: true,
    verificationTemplateMetadataPresent: true, callbackDomainPresent: true, metadataSha256: value.metadataSha256,
  }
  const serialized = JSON.stringify(receipt)
  if (/@|bearer|authorization|idtoken|refreshtoken|oobcode|templatebody|headers/i.test(serialized)) blocked()
  return Object.freeze(receipt)
}

function writeExclusiveReceipt(filename, receipt, io) {
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  let descriptor = null
  try {
    descriptor = io.openSync(filename, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const count = io.writeSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (!Number.isSafeInteger(count) || count < 1) blocked()
      offset += count
    }
    io.fsyncSync(descriptor)
  } catch {
    if (descriptor !== null) { try { io.closeSync(descriptor) } catch { /* retain failure */ } }
    blocked()
  }
  io.closeSync(descriptor)
  const reread = io.readFileSync(filename)
  if (!reread.equals(bytes)) blocked()
  return { bytes: bytes.length }
}

/** All local gates run before loadRuntime. The default CLI's loadRuntime is
 * the only closure that imports firebase-tools and opens its guarded session. */
export async function runAuthVerificationShapeDiscovery({
  args, repoRoot, gitState, loadRuntime, now = () => new Date().toISOString(), io = fs,
}) {
  const parsed = parseAuthShapeDiscoveryArgs(args)
  if (typeof gitState !== 'function' || typeof loadRuntime !== 'function' || typeof now !== 'function') blocked()
  const output = resolveNewExternalPath(parsed['--out'], repoRoot, io)
  validateCleanHead(await gitState(), parsed['--expected-head'])
  const runtime = await loadRuntime()
  if (!exactKeys(runtime, ['openSession', 'discover']) || typeof runtime.openSession !== 'function' || typeof runtime.discover !== 'function') blocked()
  const session = await runtime.openSession(Object.freeze({ approvalValidated: true, localGatesValidated: true }))
  const discovered = await runtime.discover(session)
  validateCleanHead(await gitState(), parsed['--expected-head'])
  const receipt = sanitizeDiscovery(discovered, now(), parsed['--expected-head'])
  writeExclusiveReceipt(output, receipt, io)
  return Object.freeze({ output, receipt })
}
