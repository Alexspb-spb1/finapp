// M1-STAGING-READONLY-RECON-PREP-03 - the bounded read-only reconciliation engine of finapp-staging.
// Fixed set of GET requests (and at most ONE exact-subject lookup POST) matched against an explicit allowlist BEFORE dispatch; no retry, redirect=error, no pagination, hard budgets
// (requests, bytes, per-request timeout, global deadline); durable intent/result ledger with fsync; sanitized closed-code STOPs; atomic one-use claim of the evidence namespace
// before any credential or provider call. Observations are recorded as observations: the engine never declares a state accepted, compatible or absent in advance.
import fs from 'node:fs'
import path from 'node:path'
import { RECON, Blocked, sha256Hex, namespaceProblems, targetProblems } from './recon-pins.mjs'
import { compareFunctions, validateExpected, canonicalOf } from './m1-state-lib.mjs'
import { permitProblems } from './recon-permit.mjs'
import { readCachedLogin } from './recon-bootstrap.mjs'
import { integrityProblems } from './recon-integrity.mjs'

export const EXIT = Object.freeze({ ALL_MATCH: 0, STOP: 2, INIT_REFUSED: 3, DIFFERENCES: 4 })
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const FORBIDDEN_ENV = /^(FIREBASE_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_OPTIONS|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|GOOGLE_OAUTH_ACCESS_TOKEN|CLOUDSDK_AUTH_ACCESS_TOKEN)$|EMULATOR|^M1_STUB_/i
const SYNTHETIC_SUBJECT = /^m1-[0-9a-f]{8}-(admin|second|viewer)@example\.invalid$/
const SECRET_PATTERNS = [/ya29\.[A-Za-z0-9._-]{20,}/, /\b1\/\/[A-Za-z0-9._-]{20,}/, /Bearer [A-Za-z0-9._-]{20,}/, /AIza[0-9A-Za-z_-]{30,}/, /M1![A-Za-z0-9_-]{20,}/, /"password"\s*:/, /refresh_token/, /access_token/, /m1-[0-9a-f]{8}-(admin|second|viewer)@example\.invalid/]

// ── pins and allowlist ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function loadPins(pkg) {
  const rd = f => fs.readFileSync(path.join(pkg, f))
  const j = f => JSON.parse(rd(f).toString('utf8'))
  return {
    allow: j('request-allowlist.json'), frontend: j('frontend-allowlist.json'), subject: j('consumed-subject-pin.json'), expected: j('expected-state-r3.json'),
    hashes: {
      codeSumsSha256: sha256Hex(rd('CODE-SHA256SUMS.txt')), requestAllowlistSha256: sha256Hex(rd('request-allowlist.json')), frontendAllowlistSha256: sha256Hex(rd('frontend-allowlist.json')),
      consumedSubjectPinSha256: sha256Hex(rd('consumed-subject-pin.json')), expectedStateSha256: sha256Hex(rd('expected-state-r3.json')), distManifestSha256: sha256Hex(rd('dist-staging-manifest.txt'))
    }
  }
}

/** Pin problems of the loaded data itself (independent of any permit). */
export function pinProblems(pins) {
  const p = []
  const { allow, frontend, subject, expected } = pins
  if (allow?.format !== 'finapp-m1-recon-request-allowlist-v1' || allow.project !== RECON.project) p.push('request allowlist format/project')
  const L = allow?.limits ?? {}
  for (const k of ['perRequestTimeoutMs', 'globalDeadlineMs', 'maxRequests', 'maxTotalResponseBytes']) if (L[k] !== RECON.limits[k]) p.push(`allowlist limit ${k}`)
  if (!Array.isArray(allow?.entries) || allow.entries.some(e => e.method !== 'GET' && !(e.method === 'POST' && e.id === 'auth-exact-lookup'))) p.push('allowlist methods (GET only, plus the one exact lookup POST)')
  if (allow?.entries?.some(e => !/^[a-z0-9.-]+\.googleapis\.com$/.test(e.host) || e.auth !== 'bearer' || e.maxRequests !== 1)) p.push('allowlist host/auth/requests')
  if (frontend?.format !== 'finapp-m1-recon-frontend-allowlist-v1' || frontend.host !== RECON.stageHost || frontend.base !== '/finapp/' || !Array.isArray(frontend.files) || frontend.files.length !== 15) p.push('frontend allowlist')
  else if (frontend.files.some(f => !/^[A-Za-z0-9_./-]+$/.test(f.path) || f.path.includes('..') || f.path.startsWith('/') || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.bytes) || f.bytes < 1 || f.bytes > 2 * 1024 * 1024)) p.push('frontend allowlist entries')
  if (subject?.format !== 'finapp-m1-recon-consumed-subject-pin-v1' || subject.run !== 'r3-ab9fb2fe' || !/^[0-9a-f]{8}$/.test(subject.runId ?? '') || subject.subjectKey !== 'admin' || !/^[0-9a-f]{64}$/.test(subject.subjectSha256 ?? '') || !/^[0-9a-f]{64}$/.test(subject.source?.sha256 ?? '')) p.push('consumed subject pin')
  if (expected?.project !== RECON.project || expected.sourceHead !== RECON.head || expected.rulesTarget?.canonicalSha256 !== RECON.rulesTarget) p.push('expected-state pins')
  return p
}

export function buildEntries(pins) {
  const entries = pins.allow.entries.map(e => ({ ...e, timeoutMs: e.timeoutMs ?? RECON.limits.perRequestTimeoutMs }))
  const f = pins.frontend
  const add = (id, p, sha, bytes) => entries.push({ id, branch: 'frontend', class: 'frontendPublicRead', method: 'GET', host: f.host, path: p, query: {}, body: null, maxRequests: 1, maxResponseBytes: bytes, auth: 'none', timeoutMs: RECON.limits.perRequestTimeoutMs, pinSha256: sha })
  add('frontend-root', '/', f.index.sha256, f.index.bytes)
  add('frontend-finapp-index', '/finapp/', f.index.sha256, f.index.bytes)
  for (const file of f.files) add(`frontend-file:${file.path}`, `/finapp/${file.path}`, file.sha256, file.bytes)
  return entries
}
export function entryUrl(entry, pathOverride) {
  const u = new URL(`https://${entry.host}${pathOverride ?? entry.path}`)
  for (const [k, v] of Object.entries(entry.query ?? {})) u.searchParams.set(k, v)
  return u.href
}

/** Matches a request against the allowlist BEFORE dispatch. Throws Blocked('allowlist-denied'). Returns the entry. */
export function matchEntry(entries, method, urlString, bodyText) {
  let u
  try { u = new URL(urlString) } catch { throw new Blocked('allowlist-denied') }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.port) throw new Blocked('allowlist-denied')
  const pairs = [...u.searchParams]
  for (const e of entries) {
    if (e.method !== method || e.host !== u.hostname) continue
    const pathOk = e.path !== undefined ? u.pathname === e.path : new RegExp(e.pathPattern).test(u.pathname)
    if (!pathOk) continue
    const want = Object.entries(e.query ?? {})
    if (pairs.length !== want.length || want.some(([k, v]) => pairs.filter(([pk]) => pk === k).length !== 1 || u.searchParams.get(k) !== v)) continue
    if (e.body === 'auth-lookup') {
      let b
      try { b = JSON.parse(bodyText) } catch { continue }
      if (!record(b) || Object.keys(b).join() !== 'email' || !Array.isArray(b.email) || b.email.length !== 1 || typeof b.email[0] !== 'string' || !SYNTHETIC_SUBJECT.test(b.email[0])) continue
    } else if (bodyText !== undefined) continue
    return e
  }
  throw new Blocked('allowlist-denied')
}

// ── durable ledger ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function createLedger(file, now = () => Date.now()) {
  const fd = fs.openSync(file, 'ax') // exclusive: one ledger per namespace
  let seq = 0
  return {
    event(obj) { const line = `${JSON.stringify({ seq: ++seq, at: new Date(now()).toISOString(), ...obj })}\n`; fs.writeSync(fd, line); fs.fsyncSync(fd); return seq },
    close() { try { fs.closeSync(fd) } catch { /* closed */ } }
  }
}

// ── the client: allowlist, budgets, no retry, redirect=error, intent-before-dispatch ─────────────────────────────────────────────────
// The global deadline is HARD: it limits when a request may start, how long its headers and streamed body may take (the request signal is the smaller of the per-request timeout and
// the budget left) and when it may complete. A request that completes after the deadline is a STOP `deadline`, never a success. `startedAt` is the start of the whole run;
// `signalFor` is injectable so that the budget given to a request can be asserted without sleeping.
export function createClient({ fetchImpl, entries, ledger, token: initialToken = null, now = () => Date.now(), limits = RECON.limits, startedAt, signalFor = ms => AbortSignal.timeout(ms) }) {
  let token = initialToken
  const counts = new Map()
  let total = 0, totalBytes = 0, tokenSent = 0
  const deadlineAt = (startedAt ?? now()) + limits.globalDeadlineMs
  const over = () => now() > deadlineAt
  const deny = (code, extra = {}) => { ledger.event({ phase: 'DENIED', code, ...extra }); return new Blocked(code) }
  return {
    async request(method, urlString, body) {
      if (now() >= deadlineAt) throw deny('deadline')
      let entry
      try { entry = matchEntry(entries, method, urlString, body) } catch (e) {
        let host = null; try { host = new URL(urlString).hostname.slice(0, 80) } catch { /* unparseable */ }
        throw deny('allowlist-denied', { method: String(method).slice(0, 8), host, urlSha256: sha256Hex(String(urlString)) })
      }
      if (total + 1 > limits.maxRequests || (counts.get(entry.id) ?? 0) + 1 > entry.maxRequests) throw deny('budget-exhausted', { id: entry.id })
      if (entry.auth === 'bearer' && !token) throw deny('credential-token-missing', { id: entry.id })
      const u = new URL(urlString)
      ledger.event({ phase: 'INTENT', id: entry.id, method, host: entry.host, urlSha256: sha256Hex(u.pathname + u.search), bodySha256: body === undefined ? null : sha256Hex(body) })
      counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1); total++
      const headers = { accept: entry.host === RECON.stageHost ? '*/*' : 'application/json' }
      if (entry.auth === 'bearer') { headers.authorization = `Bearer ${token}`; headers['x-goog-user-project'] = RECON.project; tokenSent++ }
      if (body !== undefined) headers['content-type'] = 'application/json'
      const started = now()
      const finish = (outcome, extra = {}) => ledger.event({ phase: 'RESULT', id: entry.id, outcome, elapsedMs: now() - started, ...extra })
      const left = deadlineAt - started
      if (left <= 0) { finish('deadline'); throw new Blocked('deadline') } // the budget ran out while the INTENT was being written: nothing is dispatched
      const limited = left < entry.timeoutMs
      const abortCode = () => (limited || over() ? 'deadline' : 'timeout')
      let res
      try { res = await fetchImpl(urlString, { method, headers, body, redirect: 'error', signal: signalFor(Math.min(entry.timeoutMs, left)) }) } catch (e) {
        const code = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? abortCode() : 'network-unknown'
        finish(code)
        throw new Blocked(code)
      }
      if (over()) { try { await res.body?.cancel() } catch { /* ignored */ }; finish('deadline', { status: res.status }); throw new Blocked('deadline') }
      const status = res.status
      if (res.redirected || (status >= 300 && status < 400)) { finish('redirect', { status }); throw new Blocked('redirect') }
      if (status !== 200) {
        try { await res.body?.cancel() } catch { /* ignored */ }
        const code = status === 401 || status === 403 || status === 404 || status === 429 ? `http-${status}` : status >= 500 ? 'http-5xx' : 'http-other'
        finish(code, { status }); throw new Blocked(code)
      }
      const chunks = []
      let size = 0
      try {
        const reader = res.body?.getReader()
        for (;;) {
          const r = reader ? await reader.read() : { done: true }
          if (over()) { try { await reader?.cancel() } catch { /* ignored */ }; finish('deadline', { status, bytes: size }); throw new Blocked('deadline') }
          if (r.done) break
          size += r.value.byteLength
          if (size > entry.maxResponseBytes || totalBytes + size > limits.maxTotalResponseBytes) { try { await reader.cancel() } catch { /* ignored */ } finish('oversize', { status, bytes: size }); throw new Blocked('oversize') }
          chunks.push(Buffer.from(r.value))
        }
      } catch (e) {
        if (e instanceof Blocked) throw e
        const code = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? abortCode() : 'network-unknown'
        finish(code, { status }); throw new Blocked(code)
      }
      totalBytes += size
      const bytes = Buffer.concat(chunks)
      const sha = sha256Hex(bytes)
      finish('ok', { status, bytes: size, bodySha256: sha })
      return { entry, status, bytes, sha256: sha }
    },
    setToken(t) { token = t },
    stats() { return { total, totalBytes, tokenSentRequests: tokenSent, byEntry: Object.fromEntries([...counts]) } }
  }
}
const parseJson = buf => { try { const v = JSON.parse(buf.toString('utf8')); if (!record(v)) throw new Error('shape'); return v } catch { throw new Blocked('malformed-json') } }
const entryById = (entries, id) => entries.find(e => e.id === id)

// ── branch: public frontend ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function runFrontend(client, entries, fp) {
  const rows = entries.filter(e => e.branch === 'frontend')
  if (rows.length !== 17) throw new Blocked('pin-mismatch')
  const differing = []
  const texts = []
  let rootMatches = null, finappMatches = null
  for (const e of rows) {
    const r = await client.request('GET', entryUrl(e))
    const matches = r.sha256 === e.pinSha256 && r.bytes.length === e.maxResponseBytes
    if (e.id === 'frontend-root') rootMatches = matches
    else if (e.id === 'frontend-finapp-index') finappMatches = matches
    else if (!matches) differing.push(e.id.slice('frontend-file:'.length))
    if (/\.(js|html|css)$/.test(e.path) || e.path.endsWith('/')) texts.push({ path: e.path, text: r.bytes.toString('utf8') })
  }
  const chunk = fp.files.find(f => f.path.startsWith(fp.marker.chunkPrefix))
  const chunkText = texts.find(t => chunk && t.path === `/finapp/${chunk.path}`)?.text ?? ''
  const hits = [...chunkText.matchAll(/VITE_FIREBASE_PROJECT_ID:["`]([^"`]+)["`]/g)]
  const markerProject = hits.length === 1 ? hits[0][1].slice(0, 80) : null
  const forbiddenMarkerHits = texts.reduce((n, t) => n + fp.marker.forbidden.reduce((m, s) => m + t.text.split(s).length - 1, 0), 0)
  const matchesPin = rootMatches === true && finappMatches === true && differing.length === 0 && markerProject === fp.marker.projectId && forbiddenMarkerHits === 0
  return { requests: rows.length, rootIndexMatches: rootMatches, finappIndexMatches: finappMatches, filesDiffering: differing, markerProject, forbiddenMarkerHits, matchesPin }
}

// ── branch: Cloud Functions metadata ───────────────────────────────────────────────────────────────────────────────────────────────────
const FN_NAME = new RegExp(`^projects/${RECON.project}/locations/us-central1/functions/([A-Za-z][A-Za-z0-9]{0,62})$`)
const num = v => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v)
export function projectFunction(value) {
  if (!record(value) || typeof value.name !== 'string' || !record(value.buildConfig) || !record(value.serviceConfig) || !record(value.buildConfig.source)) throw new Blocked('unexpected-shape')
  const m = FN_NAME.exec(value.name)
  const c = value.serviceConfig, b = value.buildConfig
  if (!m || ![value.state, value.environment, b.runtime, b.entryPoint, b.build, c.revision].every(s => typeof s === 'string' && s.length <= 300)) throw new Blocked('unexpected-shape')
  return {
    id: m[1], state: value.state, environment: value.environment, runtime: b.runtime, entryPoint: b.entryPoint,
    resources: { memory: c.availableMemory, cpu: num(c.availableCpu), concurrency: c.maxInstanceRequestConcurrency, minInstances: Object.hasOwn(c, 'minInstanceCount') ? c.minInstanceCount : 0, maxInstances: c.maxInstanceCount, timeoutSeconds: c.timeoutSeconds },
    revision: c.revision, build: b.build, sourceReferenceSha256: sha256Hex(JSON.stringify(b.source))
  }
}
async function listPage(client, entry) {
  const body = parseJson((await client.request('GET', entryUrl(entry))).bytes)
  if (body.functions !== undefined && !Array.isArray(body.functions)) throw new Blocked('unexpected-shape')
  if ((body.unreachable !== undefined && (!Array.isArray(body.unreachable) || body.unreachable.length)) || (body.nextPageToken !== undefined && body.nextPageToken !== '')) throw new Blocked('unexpected-shape')
  return body.functions ?? []
}
export async function runFunctions(client, entries, expected) {
  const v1 = await listPage(client, entryById(entries, 'functions-v1-list'))
  const v2 = await listPage(client, entryById(entries, 'functions-v2-list'))
  const observed = v2.map(projectFunction)
  const problems = compareFunctions(observed.map(({ environment: _e, entryPoint: _p, ...f }) => f), expected)
  for (const f of observed) { if (f.environment !== 'GEN_2') problems.push(`${f.id} environment ${f.environment}`); if (f.entryPoint !== f.id) problems.push(`${f.id} entryPoint changed`) }
  if (v1.length) problems.push(`unexpected 1st-gen functions: ${v1.length}`)
  return { v1Count: v1.length, v2Count: v2.length, observed: observed.map(({ id, state, runtime, revision, build, sourceReferenceSha256 }) => ({ id, state, runtime, revision, build, sourceReferenceSha256 })).sort((a, b) => a.id.localeCompare(b.id)), problems: problems.slice(0, 30).map(s => String(s).slice(0, 160)), matchesPin: problems.length === 0 }
}

// ── branch: Firestore Rules release ────────────────────────────────────────────────────────────────────────────────────────────────────
export async function runRules(client, entries, expected) {
  const release = parseJson((await client.request('GET', entryUrl(entryById(entries, 'rules-release')))).bytes)
  const rulesetName = release.rulesetName
  if (release.name !== `projects/${RECON.project}/releases/cloud.firestore` || typeof rulesetName !== 'string' || !new RegExp(`^projects/${RECON.project}/rulesets/[A-Za-z0-9-]{1,64}$`).test(rulesetName)) throw new Blocked('unexpected-shape')
  const ruleset = parseJson((await client.request('GET', entryUrl(entryById(entries, 'rules-ruleset'), `/v1/${rulesetName}`))).bytes)
  const files = ruleset.source?.files
  if (ruleset.name !== rulesetName || !Array.isArray(files) || files.length !== 1 || typeof files[0]?.content !== 'string') throw new Blocked('unexpected-shape')
  const content = files[0].content
  const t = expected.rulesTarget
  const raw = sha256Hex(content), canonical = canonicalOf(content), bytes = Buffer.byteLength(content)
  const short = v => (typeof v === 'string' ? v.slice(0, 64) : null)
  return {
    rulesetName, releaseUpdateTime: short(release.updateTime), rulesetCreateTime: short(ruleset.createTime), bytes, rawSha256: raw, canonicalSha256: canonical,
    equalsPreReleaseRulesetName: rulesetName === expected.rulesPre?.rulesetName, matchesPin: canonical === t.canonicalSha256 && raw === t.rawSha256 && bytes === t.sourceBytes
  }
}

// ── branch: ONE exact synthetic-subject lookup ─────────────────────────────────────────────────────────────────────────────────────────
/** Derives the single synthetic subject from the verified private journal of the consumed run (never printed or stored). */
export function deriveSubject(pin, journalBytes) {
  if (sha256Hex(journalBytes) !== pin.source.sha256) throw new Blocked('subject-source-mismatch')
  let events
  try { events = journalBytes.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { throw new Blocked('subject-source-mismatch') }
  const pre = events.filter(e => e.event === 'PREFLIGHT_OK'), creates = events.filter(e => e.event === 'AUTH_CREATE_MAY_BE_SENT')
  if (pre.length !== 1 || creates.length !== 1 || creates[0].key !== pin.subjectKey || pre[0].runId !== pin.runId) throw new Blocked('subject-source-mismatch')
  const email = `m1-${pre[0].runId}-${creates[0].key}@example.invalid`
  if (sha256Hex(Buffer.from(email, 'utf8')) !== pin.subjectSha256) throw new Blocked('subject-source-mismatch')
  if (!SYNTHETIC_SUBJECT.test(email)) throw new Blocked('subject-not-synthetic')
  return email
}
export async function runAuthLookup(client, entries, pin, journalBytes) {
  const email = deriveSubject(pin, journalBytes)
  const body = parseJson((await client.request('POST', entryUrl(entryById(entries, 'auth-exact-lookup')), JSON.stringify({ email: [email] }))).bytes)
  const users = body.users
  if (users !== undefined && !Array.isArray(users)) throw new Blocked('unexpected-shape')
  if (!users || users.length === 0) return { classification: 'ABSENT_NOW', subjectSha256: pin.subjectSha256 }
  if (users.length === 1 && record(users[0]) && typeof users[0].email === 'string' && users[0].email.toLowerCase() === email) return { classification: 'PRESENT_NOW', subjectSha256: pin.subjectSha256 }
  throw new Blocked('unexpected-shape')
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function scanEvidence(dir, extraNeedles = []) {
  const hits = []
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const t = fs.readFileSync(p, 'utf8'); if (SECRET_PATTERNS.some(re => re.test(t)) || extraNeedles.some(n => n && t.includes(n))) hits.push(path.relative(dir, p)) } } }
  walk(dir)
  return hits
}

/** cfg: { profile: 'staging'|'rehearsal', pkg, evDir, env, fetchImpl, permit?, ops?, pins?, bootstrap?, consumedJournalPath?, now?, claimMkdir? }  ->  { status, exitCode, reason?, stop?, result? } */
export async function runRecon(cfg) {
  const { profile, pkg, evDir } = cfg
  const now = cfg.now ?? (() => Date.now())
  const refuse = reason => ({ status: 'INIT_REFUSED', exitCode: EXIT.INIT_REFUSED, reason })
  if (!['staging', 'rehearsal'].includes(profile)) return refuse('unknown profile')
  // BYTE INTEGRITY FIRST: the actual files of the package must equal the owner-bound manifest before anything else is read, claimed, authenticated or requested (CR1).
  const integrity = integrityProblems(pkg)
  if (integrity.length) return refuse(`integrity: ${integrity[0]}`)
  const env = { ...cfg.env }
  if (profile === 'staging' && Object.entries(env).some(([k, v]) => v && FORBIDDEN_ENV.test(k))) return refuse('forbidden environment for a staging reading')
  if (typeof cfg.fetchImpl !== 'function') return refuse('no fetch implementation')
  let pins
  try { pins = profile === 'rehearsal' && cfg.pins ? cfg.pins : loadPins(pkg) } catch { return refuse('pins unreadable') }
  const pp = profile === 'rehearsal' && cfg.pins ? [] : pinProblems(pins)
  if (pp.length) return refuse(`pins: ${pp[0]}`)
  if (profile === 'staging') { const ev = validateExpected(pins.expected); if (ev.length) return refuse('pins: expected-state structure') }
  const tp = targetProblems({ project: RECON.project, values: [evDir, ...Object.values(env)] })
  if (tp.length) return refuse(`target: ${tp[0]}`)
  const ns = namespaceProblems({ profile, evidenceDir: evDir, exists: p => fs.existsSync(p) })
  if (ns.length) return refuse(`namespace: ${ns[0]}`)
  let ops
  if (profile === 'staging') {
    const pr = permitProblems(cfg.permit, { ...pins.hashes, evidenceName: path.basename(evDir) }, now())
    if (pr.length) return refuse(`permit: ${pr[0]}`)
    ops = cfg.permit.operations
  } else ops = cfg.ops ?? { credentialConfigRead: true, functionsMetadataRead: true, rulesReleaseRead: true, frontendPublicRead: true, authExactLookup: true }
  let entries
  try { entries = buildEntries(pins) } catch { return refuse('pins: allowlist') }

  // ONE-USE CLAIM (atomic, non-recursive) before any credential read, provider call, journal or state write.
  const claimMkdir = cfg.claimMkdir ?? fs.mkdirSync
  try { fs.mkdirSync(path.dirname(evDir), { recursive: true }) } catch { return refuse('could not create the parent of the evidence directory') }
  try { claimMkdir(evDir) } catch (e) { return refuse(e?.code === 'EEXIST' ? 'evidence namespace already claimed (lost the race or consumed): nothing was run' : 'could not claim the evidence directory') }
  try { fs.writeFileSync(path.join(evDir, 'recon-claim.json'), `${JSON.stringify({ task: RECON.taskId, profile, pid: process.pid, claimedAt: new Date(now()).toISOString(), codeSumsSha256: pins.hashes.codeSumsSha256 })}\n`, { flag: 'wx' }) } catch { return refuse('could not write the claim marker (the namespace stays consumed)') }

  const state = { task: RECON.taskId, profile, startedAtUtc: new Date(now()).toISOString(), branches: {}, stop: null, credential: { configReads: 0, configWrites: 0, tokenEndpointCalls: 0, remainingMinutesAtStart: null } }
  const save = () => { const tmp = path.join(evDir, 'recon-state.json.tmp'); fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`); fs.renameSync(tmp, path.join(evDir, 'recon-state.json')) }
  let ledger, client, token = null
  try {
    ledger = createLedger(path.join(evDir, 'recon-ledger.jsonl'), now)
    ledger.event({ phase: 'START', task: RECON.taskId, profile, operations: ops, allowlistSha256: pins.hashes.requestAllowlistSha256 })
    save()
    const runStart = now()
    client = createClient({ fetchImpl: cfg.fetchImpl, entries, ledger, token: null, now, startedAt: runStart, signalFor: cfg.signalFor })
    const stage = async (name, fn) => { try { state.branches[name] = await fn(); } catch (e) { state.stop = { branch: name, code: e instanceof Blocked ? e.code : 'unexpected' }; ledger.event({ phase: 'STOP', branch: name, code: state.stop.code }); save(); throw e } ledger.event({ phase: 'BRANCH_DONE', branch: name }); save() }
    // ONE client for the whole run, so that every budget is global; the token is attached only after the (permitted) bootstrap
    if (ops.frontendPublicRead) await stage('frontend', () => runFrontend(client, entries, pins.frontend))
    if (ops.credentialConfigRead) {
      const boot = profile === 'staging' ? readCachedLogin({ env, now }) : (cfg.bootstrap ?? readCachedLogin)({ env, now })
      token = boot.accessToken
      state.credential = { configReads: boot.reads ?? 1, configWrites: 0, tokenEndpointCalls: 0, remainingMinutesAtStart: Math.floor((boot.remainingMs ?? 0) / 60000) }
      ledger.event({ phase: 'CREDENTIAL_CONFIG_READ', configWrites: 0, tokenEndpointCalls: 0, remainingMinutes: state.credential.remainingMinutesAtStart })
      client.setToken(token)
      save()
    }
    if (ops.functionsMetadataRead) await stage('functions', () => runFunctions(client, entries, pins.expected))
    if (ops.rulesReleaseRead) await stage('rules', () => runRules(client, entries, pins.expected))
    if (ops.authExactLookup) {
      const journalPath = profile === 'staging' ? RECON.consumedJournal : (cfg.consumedJournalPath ?? RECON.consumedJournal)
      await stage('auth', async () => { let bytes; try { bytes = fs.readFileSync(journalPath) } catch { throw new Blocked('subject-source-mismatch') } return runAuthLookup(client, entries, pins.subject, bytes) })
    }
    // a run that ends after its global deadline is never a success, whatever the last request did (the requests themselves are bounded inside the client)
    if (now() - runStart > RECON.limits.globalDeadlineMs) { state.stop = { branch: 'run', code: 'deadline' }; ledger.event({ phase: 'STOP', branch: 'run', code: 'deadline' }); save() }
  } catch (e) {
    if (!state.stop) { state.stop = { branch: 'init', code: e instanceof Blocked ? e.code : 'unexpected' }; try { ledger?.event({ phase: 'STOP', branch: 'init', code: state.stop.code }); save() } catch { /* nothing more can be recorded */ } }
  }
  const differences = Object.entries(state.branches).filter(([name, b]) => name !== 'auth' && b.matchesPin === false).map(([name]) => name)
  const status = state.stop ? 'STOP' : differences.length ? 'READ_COMPLETE_DIFFERENCES_OBSERVED' : 'READ_COMPLETE_ALL_MATCH_PINS'
  const result = {
    format: 'finapp-m1-recon-result-v1', task: RECON.taskId, profile, status, startedAtUtc: state.startedAtUtc, finishedAtUtc: new Date(now()).toISOString(), stop: state.stop,
    branches: state.branches, differences, credential: state.credential, requests: client ? client.stats() : null,
    notes: ['observations of the moment of reading only; nothing here declares a state accepted, compatible or absent in advance', 'ABSENT_NOW / PRESENT_NOW of the Auth lookup is not proof that the old create was or was not processed']
  }
  try {
    fs.writeFileSync(path.join(evDir, 'recon-result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    ledger?.event({ phase: 'RESULT', status })
    ledger?.close()
    const hits = scanEvidence(evDir, [token])
    if (hits.length) { fs.writeFileSync(path.join(evDir, 'recon-scan-hit.json'), `${JSON.stringify({ files: hits })}\n`); return { status: 'STOP', exitCode: EXIT.STOP, stop: { branch: 'scan', code: 'unexpected' }, result } }
  } catch { return { status: 'STOP', exitCode: EXIT.STOP, stop: state.stop ?? { branch: 'finalize', code: 'unexpected' }, result } }
  return { status, exitCode: state.stop ? EXIT.STOP : differences.length ? EXIT.DIFFERENCES : EXIT.ALL_MATCH, stop: state.stop, result }
}
