// FINAPP-1.0-M1 R3 staging release (HEAD 714d0f91) — shared core for the private smoke runner.
// Out-of-tree on purpose: the reviewed repository HEAD must stay exact.
// Never logs passwords, ID/OAuth tokens or document payloads.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const REPO = 'D:\\projects\\finapp\\m1-release-714d0f91'
export const EXPECTED_HEAD = '714d0f91c60a582ee87dc7da82d6249b3106329f'

export const M1_CALLABLES = Object.freeze(['changeMemberRole', 'disableMember', 'restoreMember', 'removeMember', 'listCompanyMembers'])
export const SEED_CALLABLES = Object.freeze(['createCompany'])
export const INVITATION_CALLABLES = Object.freeze(['inviteMember', 'listInvitations', 'cancelInvite', 'resendInvite', 'previewInvite', 'acceptInvite', 'getCompanyAccess'])

export const TARGETS = Object.freeze({
  staging: Object.freeze({
    name: 'staging', project: 'finapp-staging',
    auth: 'https://identitytoolkit.googleapis.com',
    firestore: 'https://firestore.googleapis.com',
    functions: 'https://us-central1-finapp-staging.cloudfunctions.net',
    tokenRefresh: 'https://securetoken.googleapis.com',
  }),
  emulator: Object.freeze({
    name: 'emulator', project: 'demo-finapp',
    auth: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com',
    firestore: 'http://127.0.0.1:8080',
    functions: 'http://127.0.0.1:5001/demo-finapp/us-central1',
    tokenRefresh: 'http://127.0.0.1:9099/securetoken.googleapis.com',
  }),
})

// Upper bound of Firestore documents this run may create (see package §6).
export const DOC_BUDGET = Object.freeze({
  createCompanyPerCall: 6,      // companies, members, company_data, users, audit_events, user_bootstrap
  createCompanyCalls: 2,
  seedCreates: 4,               // A/members/U2, A/members/U3, B/members/U3, users/U3 (users/U2 is an update)
  uiAuditEvents: 2,             // U3 viewer->accountant->viewer through the UI
  apiAuditEvents: 6,            // U3: changeRole, disable, restore, remove; then promote U2 and U2 removes U1 (R3 ownerId probe)
  rulesDefectReserve: 1,        // orphan-company probe, only if Rules were wrong
})
export const MAX_DOCUMENTS = DOC_BUDGET.createCompanyPerCall * DOC_BUDGET.createCompanyCalls +
  DOC_BUDGET.seedCreates + DOC_BUDGET.uiAuditEvents + DOC_BUDGET.apiAuditEvents + DOC_BUDGET.rulesDefectReserve
export const MAX_AUTH_USERS = 3

// STOP kinds. Only `assertion` (a smoke expectation was not met) and `ui-flow`
// (the browser flow itself failed) leave the manifest and transport trustworthy
// enough for cleanup. Every other kind — guard, transport, manifest, unexpected
// exception — makes cleanup refuse and write a recovery manifest instead.
// Closed set of reason codes that PROVE a transport failure happened in the connect phase (no byte of the request sent); see classifyFetchError in m1-transport.mjs.
export const PRE_DISPATCH_REASON_CODES = Object.freeze(['connect-timeout', 'connection-refused', 'dns', 'network-unreachable', 'tls-verify'])
// `transport-not-dispatched` (M1-SAFE-STOP-RECOVERY-01) is a transport failure of the CONNECT phase: no byte of the request can have been sent. It is safe only
// together with its journaled proof (see assessCleanup G2/G3) and the live exact-subject lookup of G4. A plain `transport` stop (unknown outcome) still refuses.
export const CLEANUP_SAFE_STOP_KINDS = Object.freeze(['assertion', 'ui-flow', 'transport-not-dispatched'])
export class Stop extends Error {
  // `evidence` is optional and holds ONLY closed-set / numeric fields (reasonCode, dispatch, elapsedMs) - never text taken from an underlying error.
  constructor(step, reason, kind = 'integrity', evidence = {}) {
    super(`${step}: ${reason}`); this.step = step; this.reason = reason; this.kind = kind
    if (evidence.reasonCode !== undefined) this.reasonCode = evidence.reasonCode
    if (evidence.dispatch !== undefined) this.dispatch = evidence.dispatch
    if (evidence.elapsedMs !== undefined) this.elapsedMs = evidence.elapsedMs
  }
}
export const stop = (step, reason, kind, evidence) => { throw new Stop(step, reason, kind, evidence) }
export const sha256 = value => createHash('sha256').update(value).digest('hex')

export function gitState() {
  const run = args => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return { head: run(['rev-parse', 'HEAD']), status: run(['status', '--porcelain', '--untracked-files=all']) }
}

export function guardRun({ target, expectedHead, env = process.env }) {
  if (!Object.hasOwn(TARGETS, target)) stop('guard', 'unknown target')
  if (expectedHead !== EXPECTED_HEAD) stop('guard', 'expected head mismatch')
  const git = gitState()
  if (git.head !== EXPECTED_HEAD || git.status !== '') stop('guard', 'repository not clean at expected head')
  for (const [rawKey, value] of Object.entries(env)) {
    const key = rawKey.toUpperCase()
    if (!value) continue
    // Staging must never be redirected to emulators or alternate credentials.
    if (target === 'staging' && (/EMULATOR/.test(key) || /^(FIREBASE_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_OPTIONS)$/.test(key))) stop('guard', `forbidden environment ${key}`)
  }
  return TARGETS[target]
}

/** Private run directory outside the repository. */
// ── Windows ACL for the private run directory ───────────────────────────────
// POSIX modes (0600/0700) are not enforced on NTFS. The run directory holds the
// synthetic users' passwords, so it gets an explicit protected DACL granting
// only the current user, SYSTEM and Administrators, and every mode re-verifies
// it before touching the manifest. Anything unverifiable is a STOP.
const SID_SYSTEM = 'S-1-5-18'
const SID_ADMINISTRATORS = 'S-1-5-32-544'

function powershell(script, env = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })
}
export function currentUserSid() {
  const sid = powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value').trim()
  if (!/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(sid)) stop('acl', 'current user SID unavailable')
  return sid
}
export function readAcl(target) {
  const script = [
    '$a = Get-Acl -LiteralPath $env:M1_ACL_TARGET',
    '$rules = @(foreach ($r in $a.Access) { [pscustomobject]@{ sid = $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; type = [string]$r.AccessControlType; inherited = [bool]$r.IsInherited } })',
    '[pscustomobject]@{ protected = [bool]$a.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ')
  const parsed = JSON.parse(powershell(script, { M1_ACL_TARGET: target }))
  return { protected: parsed.protected === true, rules: [].concat(parsed.rules ?? []) }
}
/** Returns the list of ACL problems (empty = verified). */
export function aclProblems(target, { isDirectory }) {
  const allowed = new Set([currentUserSid(), SID_SYSTEM, SID_ADMINISTRATORS])
  const acl = readAcl(target)
  const problems = []
  if (isDirectory && !acl.protected) problems.push('inheritance not disabled')
  if (!acl.rules.length) problems.push('no access rules')
  for (const r of acl.rules) {
    if (!allowed.has(r.sid)) problems.push(`foreign principal ${r.sid}`)
    if (r.type !== 'Allow') problems.push(`non-allow rule for ${r.sid}`)
    if (isDirectory && r.inherited) problems.push(`inherited rule for ${r.sid}`)
  }
  if (!acl.rules.some(r => r.sid === [...allowed][0] && r.type === 'Allow')) problems.push('current user has no allow rule')
  return problems
}
export function verifyRunDirAcl(dir) {
  if (process.platform !== 'win32') stop('acl', 'ACL verification implemented for Windows only', 'integrity')
  const problems = aclProblems(dir, { isDirectory: true })
  for (const name of fs.readdirSync(dir)) problems.push(...aclProblems(path.join(dir, name), { isDirectory: false }).map(p => `${name}: ${p}`))
  if (problems.length) stop('acl', `run dir ACL not verified: ${problems.join('; ')}`, 'integrity')
}
function restrictDirAcl(dir) {
  const user = currentUserSid()
  execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `*${user}:(OI)(CI)F`, `*${SID_SYSTEM}:(OI)(CI)F`, `*${SID_ADMINISTRATORS}:(OI)(CI)F`],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 })
}

export function privateDir(input, { mustExist }) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) stop('guard', 'run dir must be absolute')
  const exists = fs.existsSync(input)
  if (exists !== mustExist) stop('guard', mustExist ? 'run dir missing' : 'run dir already exists')
  const parent = fs.realpathSync(path.dirname(input))
  const rel = path.relative(fs.realpathSync(REPO), path.join(parent, path.basename(input)))
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) stop('guard', 'run dir inside repository')
  if (!mustExist) {
    fs.mkdirSync(input)
    try { restrictDirAcl(input) } catch { stop('acl', 'could not apply restricted ACL', 'integrity') }
  }
  const dir = fs.realpathSync(input)
  // Verified before any manifest read/write, Auth creation or deletion.
  verifyRunDirAcl(dir)
  return dir
}

// ── Staging web configuration (explicit file, fail-closed) ──────────────────
function parseEnvFile(raw) {
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || line.trimStart().startsWith('#')) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}
/** Loads the staging web config from an explicit file. Values are never printed.
 * Requires projectId exactly `finapp-staging` and passes the repository's
 * reviewed staging preflight (VITE_APP_ENV, config shape, SHA-256 fingerprint). */
export async function loadStagingWebConfig(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.existsSync(file)) stop('web-config', 'explicit absolute --web-config file required', 'integrity')
  const source = parseEnvFile(fs.readFileSync(file, 'utf8'))
  if (source.VITE_FIREBASE_PROJECT_ID !== 'finapp-staging') stop('web-config', 'projectId is not exactly finapp-staging', 'integrity')
  if (typeof source.VITE_FIREBASE_API_KEY !== 'string' || !source.VITE_FIREBASE_API_KEY.trim()) stop('web-config', 'api key missing', 'integrity')
  const { runStagingPreflight } = await import(pathToFileURL(path.join(REPO, 'scripts/lib/stagingPreflight.mjs')).href)
  const verdict = runStagingPreflight(source)
  if (!verdict?.ok) stop('web-config', 'staging preflight (env/config/fingerprint) did not pass', 'integrity')
  return Object.freeze({ projectId: source.VITE_FIREBASE_PROJECT_ID, apiKey: source.VITE_FIREBASE_API_KEY })
}

export function journal(runDir) {
  const file = path.join(runDir, 'journal.jsonl')
  return {
    append(event, extra = {}) {
      const fd = fs.openSync(file, 'a', 0o600)
      try {
        fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`)
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
    },
  }
}

export function writeOnce(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
export function writeReplace(file, value) {
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try { fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
}
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Every fixture write is followed by its SHA-256 in the journal, so cleanup can
 * prove the manifest on disk is exactly the last one the runner wrote. */
export function saveFixture(file, value, log, { create = false } = {}) {
  if (create) writeOnce(file, value)
  else writeReplace(file, value)
  log.append('FIXTURE_WRITTEN', { sha256: sha256(fs.readFileSync(file)) })
}

export function readJournal(runDir) {
  const lines = fs.readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean)
  return lines.map((line, i) => { try { return JSON.parse(line) } catch { stop('manifest', `journal line ${i + 1} unreadable`) } })
}

// R3: run ids that earlier staging runs already used (rev7, rev8). A new run must never reuse one, so its
// synthetic emails, company names and orphan-probe id are guaranteed to differ from theirs.
export const PRIOR_RUN_IDS = Object.freeze(['bbb573d8', 'acf785fd', '7cbe0a6e'])
export function pickRunId(random = () => randomBytes(4).toString('hex')) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = random()
    if (/^[0-9a-f]{8}$/.test(id) && !PRIOR_RUN_IDS.includes(id)) return id
  }
  return stop('fixture', 'could not pick a fresh run id')
}

export function newFixturePlan(random) {
  const runId = pickRunId(random)
  const person = key => ({
    key,
    email: `m1-${runId}-${key}@example.invalid`,
    // 24 random bytes; kept only in the private 0600 fixture file.
    password: `M1!${randomBytes(24).toString('base64url')}`,
    name: `M1 smoke ${key} ${runId}`,
    uid: null,
  })
  return {
    format: 'finapp-m1-smoke-fixture-v1', runId, createdAt: new Date().toISOString(),
    users: { admin: person('admin'), second: person('second'), viewer: person('viewer') },
    companies: { A: { id: null, name: `M1 smoke A ${runId}` }, B: { id: null, name: `M1 smoke B ${runId}` } },
    orphanProbeId: `m1-${runId}-orphan-probe`,
    steps: {},
  }
}

// ── Firestore REST value encoding ───────────────────────────────────────────
export function encode(value) {
  if (value === null) return { nullValue: null }
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (Number.isInteger(value)) return { integerValue: String(value) }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } }
  if (typeof value === 'object') return { mapValue: { fields: encodeFields(value) } }
  stop('encode', 'unsupported value')
}
export const encodeFields = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encode(v)]))
export function decode(v) {
  if ('stringValue' in v) return v.stringValue
  if ('booleanValue' in v) return v.booleanValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('timestampValue' in v) return { timestamp: v.timestampValue }
  if ('nullValue' in v) return null
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decode)
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {})
  return { unsupported: Object.keys(v)[0] }
}
export const decodeFields = fields => Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, decode(v)]))

export { randomUUID }
