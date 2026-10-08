// Deterministic negative controls and unit tests of the bounded read-only reconciliation (no network, no emulator, synthetic data only).
// Every provider exchange goes through a RECORDER fetch: no socket is ever opened. Staging-profile cases are INIT-refusal cases only (their fetch throws if reached, and the
// owner profile is pointed at an empty temporary directory), so nothing here can read an owner credential or claim the real namespace.
//   node tests/recon-negative-controls.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeWorld, rehearsalCfg, recorderFetch, rawFunction, FN_IDS, RULES_TEXT, RULES_PRE_TEXT, SYNTH_TOKEN, bootstrapOk, newUnit, sha, PKG } from './synthetic.mjs'

const imp = f => import(pathToFileURL(path.join(PKG, f)).href)
const { RECON, STOP_CODES, Blocked, namespaceProblems, targetProblems } = await imp('recon-pins.mjs')
const core = await imp('recon-core.mjs')
const { runRecon, createClient, createLedger, buildEntries, matchEntry, entryUrl, loadPins, pinProblems, deriveSubject, scanEvidence, projectFunction, EXIT } = core
const { permitTemplate, permitProblems, ACK_KEYS } = await imp('recon-permit.mjs')
const { readCachedLogin, configPath } = await imp('recon-bootstrap.mjs')
const { offlineGuardProblems, selftest } = await imp('recon.mjs')

let pass = 0, fail = 0
const failures = []
const record = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push(name) } console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${String(detail).slice(0, 300)}`}`) }
const t = async (name, fn) => { try { const r = await fn(); record(name, r === undefined || r === true, r) } catch (e) { record(name, false, e?.stack?.split('\n').slice(0, 2).join(' | ') ?? e) } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const realDir = path.join(RECON.runtimeRoot, RECON.evidenceName)
const startedClean = !fs.existsSync(realDir)
const emptyProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-empty-profile-'))
const pins0 = loadPins(PKG)
const NOW = Date.parse('2026-11-01T12:00:00Z')
const goodPermit = (over = {}) => {
  const p = permitTemplate()
  p.status = 'APPROVED'
  p.bytes = { codeSums: pins0.hashes.codeSumsSha256, requestAllowlist: pins0.hashes.requestAllowlistSha256, frontendAllowlist: pins0.hashes.frontendAllowlistSha256, consumedSubjectPin: pins0.hashes.consumedSubjectPinSha256, expectedState: pins0.hashes.expectedStateSha256, distManifest: pins0.hashes.distManifestSha256 }
  p.operations = Object.fromEntries(Object.keys(RECON.operationClasses).map(k => [k, true]))
  p.acknowledgements = Object.fromEntries(ACK_KEYS.map(k => [k, true]))
  p.owner = { approvalRef: 'owner-decision-ref-1', approvedAtUtc: '2026-11-01T11:00:00Z', expiresAtUtc: '2026-11-01T12:30:00Z' }
  return Object.assign(p, over)
}
const factsOf = () => ({ ...pins0.hashes, evidenceName: RECON.evidenceName })
const FORBIDDEN_FETCH = () => { throw new Error('LIVE_FETCH_FORBIDDEN: a staging test reached the network') }
const stagingCfg = (over = {}) => ({ profile: 'staging', pkg: PKG, evDir: realDir, env: { XDG_CONFIG_HOME: emptyProfile }, fetchImpl: FORBIDDEN_FETCH, permit: goodPermit(), now: () => NOW, ...over })

// ── allowlist data ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
await t('allowlist data: 5 Google entries + 17 frontend entries == the request budget; GET only except the one exact lookup POST; no token endpoint; bearer only for googleapis hosts', () => {
  const entries = buildEntries(pins0)
  const g = entries.filter(e => e.auth === 'bearer'), f = entries.filter(e => e.auth === 'none')
  return entries.length === 22 && RECON.limits.maxRequests === 22 && g.length === 5 && f.length === 17 && g.every(e => /\.googleapis\.com$/.test(e.host) && e.maxRequests === 1) && f.every(e => e.host === RECON.stageHost && e.method === 'GET') &&
    entries.filter(e => e.method !== 'GET').map(e => e.id).join() === 'auth-exact-lookup' && !entries.some(e => /oauth2|token/.test(e.path ?? e.pathPattern ?? '')) && pinProblems(pins0).length === 0
})
await t('frontend pins equal the accepted staging build manifest; the package selftest passes (sums, pins, fence pins)', () => {
  const r = selftest(PKG)
  return r.ok ? true : r.problems.join('; ')
})
await t('stop codes are a closed set and Blocked normalizes anything else to "unexpected"', () => STOP_CODES.includes('allowlist-denied') && new Blocked('weird-code').code === 'unexpected' && new Blocked('timeout').code === 'timeout')

// ── allowlist matching: every foreign / write / broad request is denied BEFORE dispatch ──────────────────────────────────────────────────
const entries = buildEntries(pins0)
const denied = (m, u, b) => { try { matchEntry(entries, m, u, b); return false } catch (e) { return e instanceof Blocked && e.code === 'allowlist-denied' } }
const V2 = entryUrl(entries.find(e => e.id === 'functions-v2-list'))
await t('allowlist: the accepted requests match their entries', () => {
  const ok = [['GET', entryUrl(entries.find(e => e.id === 'functions-v1-list'))], ['GET', V2], ['GET', 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/releases/cloud.firestore'], ['GET', 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/rulesets/abc-123'],
    ['GET', 'https://stage.aktivmetr.ru/'], ['GET', 'https://stage.aktivmetr.ru/finapp/'], ['GET', 'https://stage.aktivmetr.ru/finapp/index.html']]
  return ok.every(([m, u]) => { try { return !!matchEntry(entries, m, u) } catch { return false } })
})
await t('allowlist: wrong methods (PUT/PATCH/DELETE/POST on GET entries, GET on the lookup) are denied', () => ['PUT', 'PATCH', 'DELETE', 'POST', 'HEAD', 'OPTIONS'].every(m => denied(m, V2)) && denied('GET', 'https://identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts:lookup') && denied('POST', 'https://stage.aktivmetr.ru/finapp/index.html', '{}'))
await t('allowlist: foreign, production and look-alike hosts are denied (and the token endpoint too)', () => [
  'https://cloudfunctions.googleapis.com.evil.example/v2/projects/finapp-staging/locations/-/functions', 'https://app.aktivmetr.ru/finapp/index.html', 'https://aktivmetr.ru/', 'https://www.googleapis.com/oauth2/v3/token',
  'https://cloudfunctions.googleapis.com/v2/projects/finapp-prod-10a83/locations/-/functions', 'https://firebaserules.googleapis.com/v1/projects/finapp-prod-10a83/releases/cloud.firestore',
  'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents', 'https://stage.aktivmetr.ru.evil.example/'].every(u => denied('GET', u)) && denied('POST', 'https://www.googleapis.com/oauth2/v3/token', 'grant_type=refresh_token'))
await t('allowlist: paths, query sets, scheme, credentials in the URL, port and fragment must match exactly', () => {
  const bad = [V2.replace('pageSize=100', 'pageSize=1000'), `${V2}&pageToken=abc`, V2.replace('&filter=', '&x='), 'http://cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/-/functions', 'https://u:p@cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/-/functions',
    'https://cloudfunctions.googleapis.com:8443/v2/projects/finapp-staging/locations/-/functions', `${V2}#frag`, 'https://cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/us-central1/functions',
    'https://firebaserules.googleapis.com/v1/projects/finapp-staging/releases/cloud.firestore?x=1', 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/rulesets/../releases', 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/rulesets',
    'https://stage.aktivmetr.ru/finapp/assets/not-pinned.js', 'https://stage.aktivmetr.ru/finapp/index.html?x=1', 'https://stage.aktivmetr.ru/other/']
  return bad.every(u => denied('GET', u))
})
await t('allowlist: archive download, code export, IAM, Rules create/release, Firestore export/documents, Auth list/search/signUp/batchGet, callables are all denied', () => [
  ['POST', 'https://cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/us-central1/functions/createCompany:generateDownloadUrl'],
  ['POST', 'https://cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/us-central1/functions/createCompany:setIamPolicy'],
  ['GET', 'https://cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/us-central1/functions/createCompany'],
  ['POST', 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/rulesets'], ['PATCH', 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/releases/cloud.firestore'],
  ['POST', 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default):exportDocuments'], ['GET', 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents/users'],
  ['POST', 'https://identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts:query'], ['POST', 'https://identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts:batchGet'],
  ['POST', 'https://identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts'], ['POST', 'https://identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts:delete'],
  ['POST', 'https://us-central1-finapp-staging.cloudfunctions.net/listCompanyMembers'], ['POST', 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword']].every(([m, u]) => denied(m, u, '{}')))
await t('allowlist: the Auth lookup body must be exactly {"email":[<one synthetic subject>]} - owner / real addresses, lists, other keys and non-JSON are denied', () => {
  const U = 'https://identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts:lookup'
  const okBody = JSON.stringify({ email: ['m1-abcdef01-admin@example.invalid'] })
  let ok = false; try { ok = !!matchEntry(entries, 'POST', U, okBody) } catch { ok = false }
  return ok && [JSON.stringify({ email: ['owner@gmail.com'] }), JSON.stringify({ email: ['m1-abcdef01-admin@example.invalid', 'm1-abcdef01-viewer@example.invalid'] }), JSON.stringify({ email: [] }), JSON.stringify({ localId: ['x'] }),
    JSON.stringify({ email: ['m1-abcdef01-admin@example.invalid'], extra: 1 }), JSON.stringify({ email: 'm1-abcdef01-admin@example.invalid' }), JSON.stringify({ email: ['M1-ABCDEF01-admin@example.invalid'] }), JSON.stringify({ email: ['m1-abcdef01-owner@example.invalid'] }), 'not json', undefined, ''].every(b => denied('POST', U, b))
})

// ── client: intent-before-dispatch, budgets, no retry, redirect=error, token scope ───────────────────────────────────────────────────────
const mkClient = (world, opts = {}) => {
  const unit = newUnit(); fs.mkdirSync(unit, { recursive: true })
  const ledgerFile = path.join(unit, 'ledger.jsonl')
  const ledger = createLedger(ledgerFile)
  const rec = recorderFetch(world ?? makeWorld(), opts.override)
  const client = createClient({ fetchImpl: opts.fetchImpl ?? rec.fetchImpl, entries, ledger, token: 'token' in opts ? opts.token : SYNTH_TOKEN, now: opts.now, limits: opts.limits })
  return { client, calls: rec.calls, ledgerFile, ledger }
}
const ledgerOf = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const rejectsWith = async (p, code) => { try { await p; return false } catch (e) { return e instanceof Blocked && e.code === code } }
await t('client: the INTENT is durable in the ledger BEFORE the request is dispatched (checked from inside the fetch), the RESULT follows', async () => {
  const unit = newUnit(); fs.mkdirSync(unit, { recursive: true })
  const lf = path.join(unit, 'l.jsonl'); const ledger = createLedger(lf); let intentSeenAtDispatch = false
  const fetchImpl = async () => { intentSeenAtDispatch = ledgerOf(lf).some(e => e.phase === 'INTENT' && e.id === 'rules-release') && !ledgerOf(lf).some(e => e.phase === 'RESULT'); return new Response(JSON.stringify({}), { status: 200 }) }
  const c = createClient({ fetchImpl, entries, ledger, token: SYNTH_TOKEN })
  await c.request('GET', 'https://firebaserules.googleapis.com/v1/projects/finapp-staging/releases/cloud.firestore')
  const ev = ledgerOf(lf)
  return intentSeenAtDispatch && ev.map(e => e.phase).join() === 'INTENT,RESULT' && ev[1].outcome === 'ok' && ev[0].seq === 1 && ev[1].seq === 2
})
await t('client: a denied request is ledgered as DENIED and nothing is dispatched; the ledger is exclusive (a second ledger on the same file is refused)', async () => {
  const { client, calls, ledgerFile } = mkClient()
  const r = await rejectsWith(client.request('DELETE', V2), 'allowlist-denied')
  const ev = ledgerOf(ledgerFile)
  let second = false; try { createLedger(ledgerFile) } catch { second = true }
  return r && calls.length === 0 && ev.length === 1 && ev[0].phase === 'DENIED' && second
})
await t('client: budgets - one request per entry, a global cap, nothing is dispatched past them', async () => {
  const a = mkClient(); await a.client.request('GET', V2)
  const again = await rejectsWith(a.client.request('GET', V2), 'budget-exhausted')
  const b = mkClient(null, { limits: { ...RECON.limits, maxRequests: 1 } }); await b.client.request('GET', V2)
  const global = await rejectsWith(b.client.request('GET', entryUrl(entries.find(e => e.id === 'functions-v1-list'))), 'budget-exhausted')
  return again && global && a.calls.length === 1 && b.calls.length === 1
})
await t('client: no retry - every failure ends the request once (401/403/404/429/500/418, network, timeout, redirect)', async () => {
  const cases = [[() => new Response('x', { status: 401 }), 'http-401'], [() => new Response('x', { status: 403 }), 'http-403'], [() => new Response('x', { status: 404 }), 'http-404'], [() => new Response('x', { status: 429 }), 'http-429'], [() => new Response('x', { status: 503 }), 'http-5xx'], [() => new Response('x', { status: 418 }), 'http-other'],
    [() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), 'redirect'], [() => { throw new TypeError('fetch failed') }, 'network-unknown'], [() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) }, 'timeout']]
  for (const [make, code] of cases) {
    const { client, calls, ledgerFile } = mkClient(null, { override: () => make() })
    if (!(await rejectsWith(client.request('GET', V2), code)) || calls.length !== 1) return `${code}: calls=${calls.length}`
    const ev = ledgerOf(ledgerFile)
    if (ev.at(-1).phase !== 'RESULT' || ev.at(-1).outcome !== code) return `${code}: ledger ${JSON.stringify(ev.at(-1))}`
  }
  return true
})
await t('client: redirect=error and a per-request timeout signal are always passed; a response body larger than the entry cap is cancelled (oversize); malformed JSON is a STOP', async () => {
  const { client, calls } = mkClient(null, { override: (k) => (k.includes('rulesets') ? undefined : undefined) })
  await client.request('GET', V2)
  const big = mkClient(null, { override: () => new Response('x'.repeat(2_000_000), { status: 200 }) })
  const oversize = await rejectsWith(big.client.request('GET', V2), 'oversize')
  return calls[0].redirect === 'error' && calls[0].hasSignal && oversize && ledgerOf(big.ledgerFile).at(-1).outcome === 'oversize'
})
await t('client: the deadline stops everything before the next request', async () => {
  let clock = 0
  const { client, calls } = mkClient(null, { now: () => clock })
  await client.request('GET', V2)
  clock += RECON.limits.globalDeadlineMs + 1
  return (await rejectsWith(client.request('GET', entryUrl(entries.find(e => e.id === 'functions-v1-list'))), 'deadline')) && calls.length === 1
})
await t('client: the bearer token goes ONLY to the googleapis entries, together with the quota project; the stage host never sees an Authorization header', async () => {
  const w = makeWorld()
  const { cfg, calls } = rehearsalCfg(w)
  const r = await runRecon(cfg)
  const google = calls.filter(c => c.host.endsWith('.googleapis.com')), stage = calls.filter(c => c.host === RECON.stageHost)
  return r.exitCode === 0 && google.length === 5 && google.every(c => c.headers.authorization === `Bearer ${SYNTH_TOKEN}` && c.headers['x-goog-user-project'] === 'finapp-staging') && stage.length === 17 && stage.every(c => !('authorization' in c.headers) && !('x-goog-user-project' in c.headers))
})
await t('client: a bearer entry without a token is denied (no unauthenticated Google call, nothing dispatched)', async () => {
  const { client, calls } = mkClient(null, { token: null })
  return (await rejectsWith(client.request('GET', V2), 'credential-token-missing')) && calls.length === 0
})

// ── the full reading (rehearsal, synthetic world) ─────────────────────────────────────────────────────────────────────────────────────
await t('success: every comparison equals its pin -> READ_COMPLETE_ALL_MATCH_PINS (exit 0); exactly 22 requests, one POST, fixed order, ledger INTENT/RESULT pairs, zero token-endpoint calls', async () => {
  const { cfg, calls } = rehearsalCfg(makeWorld())
  const r = await runRecon(cfg)
  const ledger = ledgerOf(path.join(cfg.evDir, 'recon-ledger.jsonl'))
  const intents = ledger.filter(e => e.phase === 'INTENT'), results = ledger.filter(e => e.phase === 'RESULT' && e.outcome === 'ok')
  const order = calls.map(c => c.host === RECON.stageHost ? 'frontend' : c.host.split('.')[0]).filter((x, i, a) => a.indexOf(x) === i || a[i - 1] !== x).join(',')
  return r.status === 'READ_COMPLETE_ALL_MATCH_PINS' && r.exitCode === 0 && calls.length === 22 && calls.filter(c => c.method === 'POST').length === 1 && order === 'frontend,cloudfunctions,firebaserules,identitytoolkit' &&
    intents.length === 22 && results.length >= 22 && !calls.some(c => /oauth2|token/.test(c.path)) && r.result.credential.tokenEndpointCalls === 0 && r.result.credential.configWrites === 0 && r.result.requests.total === 22 &&
    ['recon-claim.json', 'recon-ledger.jsonl', 'recon-result.json', 'recon-state.json'].every(f => fs.existsSync(path.join(cfg.evDir, f)))
})
await t('success: the Auth lookup is ONE POST whose body is exactly the derived synthetic subject; no uid / e-mail / token / body ever lands in the evidence (scan clean)', async () => {
  const w = makeWorld(); const { cfg, calls } = rehearsalCfg(w)
  const r = await runRecon(cfg)
  const post = calls.find(c => c.method === 'POST')
  const files = fs.readdirSync(cfg.evDir).map(f => fs.readFileSync(path.join(cfg.evDir, f), 'utf8')).join('\n')
  return r.exitCode === 0 && post.body === JSON.stringify({ email: [w.subject.email] }) && !files.includes(w.subject.email) && !files.includes('example.invalid') && !files.includes(SYNTH_TOKEN) && !/ya29|Bearer|access_token|refresh_token/.test(files) &&
    scanEvidence(cfg.evDir, [SYNTH_TOKEN, w.subject.email]).length === 0 && r.result.branches.auth.classification === 'ABSENT_NOW' && r.result.branches.auth.subjectSha256 === w.subject.pin.subjectSha256
})
await t('success: the Rules text and any response body are never stored (only hashes, sizes and names)', async () => {
  const { cfg } = rehearsalCfg(makeWorld()); await runRecon(cfg)
  const files = fs.readdirSync(cfg.evDir).map(f => fs.readFileSync(path.join(cfg.evDir, f), 'utf8')).join('\n')
  return !files.includes('rules_version') && !files.includes('match /databases') && !files.includes('synthetic-bucket') && !files.includes('storageSource')
})
await t('auth PRESENT_NOW is reported as an observation only (no uid), and is not a pin difference', async () => {
  const w = makeWorld()
  const { cfg } = rehearsalCfg(w, { override: k => (k.startsWith('POST identitytoolkit') ? new Response(JSON.stringify({ users: [{ localId: 'SYNTH-UID-DO-NOT-STORE', email: w.subject.email, emailVerified: true }] }), { status: 200 }) : undefined) })
  const r = await runRecon(cfg)
  const files = fs.readdirSync(cfg.evDir).map(f => fs.readFileSync(path.join(cfg.evDir, f), 'utf8')).join('\n')
  return r.result.branches.auth.classification === 'PRESENT_NOW' && r.exitCode === 0 && !files.includes('SYNTH-UID-DO-NOT-STORE')
})
await t('permit operations are independent: functions only / frontend only / no Auth POST when authExactLookup is off', async () => {
  const a = rehearsalCfg(makeWorld(), { ops: { credentialConfigRead: true, functionsMetadataRead: true, rulesReleaseRead: false, frontendPublicRead: false, authExactLookup: false } })
  const ra = await runRecon(a.cfg)
  const b = rehearsalCfg(makeWorld(), { ops: { credentialConfigRead: false, functionsMetadataRead: false, rulesReleaseRead: false, frontendPublicRead: true, authExactLookup: false } })
  const rb = await runRecon(b.cfg)
  const c = rehearsalCfg(makeWorld(), { ops: { credentialConfigRead: true, functionsMetadataRead: true, rulesReleaseRead: true, frontendPublicRead: true, authExactLookup: false } })
  await runRecon(c.cfg)
  return ra.exitCode === 0 && a.calls.length === 2 && a.bootstrapCalls.length === 1 && rb.exitCode === 0 && b.calls.length === 17 && b.bootstrapCalls.length === 0 && c.calls.length === 21 && !c.calls.some(x => x.method === 'POST')
})

// ── observed DIFFERENCES (well-formed answers that differ from the pins): recorded, not hidden, not STOP ──────────────────────────────
const diff = async (name, override, check) => t(`difference: ${name} -> DIFFERENCES_OBSERVED (exit 4), nothing declared accepted`, async () => {
  const { cfg } = rehearsalCfg(makeWorld(), { override })
  const r = await runRecon(cfg)
  return r.exitCode === 4 && r.status === 'READ_COMPLETE_DIFFERENCES_OBSERVED' && check(r.result) ? true : `status=${r.status} stop=${JSON.stringify(r.stop)}`
})
const withFn = (id, change) => k => (k === 'GET cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/-/functions' ? new Response(JSON.stringify({ functions: FN_IDS.map(i => (i === id ? change(rawFunction(i)) : rawFunction(i))) }), { status: 200 }) : undefined)
await diff('wrong Rules (round-2 text live)', k => (k.endsWith('rulesets/live-ruleset-0002') ? new Response(JSON.stringify({ name: 'projects/finapp-staging/rulesets/live-ruleset-0002', source: { files: [{ name: 'f', content: RULES_PRE_TEXT }] } }), { status: 200 }) : undefined), r => r.differences.includes('rules') && r.branches.rules.matchesPin === false)
await diff('Rules with different bytes but the same size', k => (k.endsWith('rulesets/live-ruleset-0002') ? new Response(JSON.stringify({ name: 'projects/finapp-staging/rulesets/live-ruleset-0002', source: { files: [{ name: 'f', content: RULES_TEXT.replace('false', 'true ') }] } }), { status: 200 }) : undefined), r => r.branches.rules.matchesPin === false)
await diff('Rules still the pre-release ruleset name', k => (k === 'GET firebaserules.googleapis.com/v1/projects/finapp-staging/releases/cloud.firestore' ? new Response(JSON.stringify({ name: 'projects/finapp-staging/releases/cloud.firestore', rulesetName: 'projects/finapp-staging/rulesets/pre-release-0001' }), { status: 200 }) : k.endsWith('rulesets/pre-release-0001') ? new Response(JSON.stringify({ name: 'projects/finapp-staging/rulesets/pre-release-0001', source: { files: [{ name: 'f', content: RULES_PRE_TEXT }] } }), { status: 200 }) : undefined), r => r.branches.rules.equalsPreReleaseRulesetName === true && r.branches.rules.matchesPin === false)
await diff('a changed revision', withFn('createCompany', f => { f.serviceConfig.revision = 'createcompany-00002-new'; return f }), r => r.branches.functions.problems.some(p => /createCompany revision/.test(p)))
await diff('changed caps', withFn('removeMember', f => { f.serviceConfig.maxInstanceCount = 3; return f }), r => r.branches.functions.problems.some(p => /removeMember caps/.test(p)))
await diff('a different runtime', withFn('inviteMember', f => { f.buildConfig.runtime = 'nodejs20'; return f }), r => r.branches.functions.problems.some(p => /runtime/.test(p)))
await diff('a changed source fingerprint', withFn('previewInvite', f => { f.buildConfig.source = { storageSource: { bucket: 'other', object: 'x' } }; return f }), r => r.branches.functions.problems.some(p => /sourceReferenceSha256/.test(p)))
await diff('a missing function', k => (k === 'GET cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/-/functions' ? new Response(JSON.stringify({ functions: FN_IDS.slice(1).map(i => rawFunction(i)) }), { status: 200 }) : undefined), r => r.branches.functions.problems.some(p => /missing function/.test(p)))
await diff('an extra function', k => (k === 'GET cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/-/functions' ? new Response(JSON.stringify({ functions: [...FN_IDS, 'authzProbe'].map(i => rawFunction(i)) }), { status: 200 }) : undefined), r => r.branches.functions.problems.some(p => /unexpected function authzProbe/.test(p)))
await diff('an unexpected 1st-gen function', k => (k === 'GET cloudfunctions.googleapis.com/v1/projects/finapp-staging/locations/-/functions' ? new Response(JSON.stringify({ functions: [{ name: 'projects/finapp-staging/locations/us-central1/functions/old' }] }), { status: 200 }) : undefined), r => r.branches.functions.v1Count === 1)
await diff('a frontend file with other bytes of the same size', k => (k === 'GET stage.aktivmetr.ru/finapp/assets/index-BBBB2222.js' ? new Response('y'.repeat(Buffer.byteLength(makeWorld().files['assets/index-BBBB2222.js'])), { status: 200 }) : undefined), r => r.branches.frontend.filesDiffering.includes('assets/index-BBBB2222.js'))
await diff('a stale root index', k => (k === 'GET stage.aktivmetr.ru/' ? new Response('z'.repeat(Buffer.byteLength(makeWorld().files['index.html'])), { status: 200 }) : undefined), r => r.branches.frontend.rootIndexMatches === false)
await diff('the Firebase marker names production', k => (k === 'GET stage.aktivmetr.ru/finapp/assets/firebase-AAAA1111.js' ? new Response('const c={VITE_FIREBASE_PROJECT_ID:"finapp-prod-10a83"};'.padEnd(Buffer.byteLength(makeWorld().files['assets/firebase-AAAA1111.js']), ' '), { status: 200 }) : undefined), r => r.branches.frontend.markerProject === 'finapp-prod-10a83' && r.branches.frontend.forbiddenMarkerHits >= 1)

// ── STOP: unknown, malformed or over-budget answers end the reading (closed code, no fallback, no further request) ───────────────────────
const stopCase = async (name, override, code, branch, maxCalls) => t(`stop: ${name} -> STOP ${code} (exit 2), no retry, nothing further is requested`, async () => {
  const { cfg, calls } = rehearsalCfg(makeWorld(), { override })
  const r = await runRecon(cfg)
  const text = fs.readdirSync(cfg.evDir).map(f => fs.readFileSync(path.join(cfg.evDir, f), 'utf8')).join('\n')
  return r.exitCode === 2 && r.stop?.code === code && r.stop.branch === branch && (maxCalls === undefined || calls.length <= maxCalls) && STOP_CODES.includes(r.stop.code) && !text.includes(SYNTH_TOKEN) ? true : `status=${r.status} stop=${JSON.stringify(r.stop)} calls=${calls.length}`
})
await stopCase('Functions v2 answers 401', k => (k.includes('/v2/') ? new Response('{}', { status: 401 }) : undefined), 'http-401', 'functions', 19)
await stopCase('Functions v1 answers 403', k => (k.includes('/v1/projects/finapp-staging/locations') ? new Response('{}', { status: 403 }) : undefined), 'http-403', 'functions', 18)
await stopCase('the Rules release answers 429', k => (k.includes('releases') ? new Response('{}', { status: 429 }) : undefined), 'http-429', 'rules', 20)
await stopCase('a frontend file answers 404', k => (k === 'GET stage.aktivmetr.ru/finapp/favicon.svg' ? new Response('x', { status: 404 }) : undefined), 'http-404', 'frontend')
await stopCase('a transport failure of unknown outcome (Auth lookup)', k => { if (k.startsWith('POST identitytoolkit')) throw new TypeError('fetch failed') }, 'network-unknown', 'auth', 22)
await stopCase('a timeout on the Rules ruleset', k => { if (k.includes('/rulesets/')) throw Object.assign(new Error('t'), { name: 'TimeoutError' }) }, 'timeout', 'rules', 21)
await stopCase('an oversize Functions answer', k => (k.includes('/v2/') ? new Response('x'.repeat(1_100_000), { status: 200 }) : undefined), 'oversize', 'functions')
await stopCase('malformed JSON from the Rules release', k => (k.includes('releases') ? new Response('{ not json', { status: 200 }) : undefined), 'malformed-json', 'rules')
await stopCase('a non-object JSON answer', k => (k.includes('releases') ? new Response('[1,2]', { status: 200 }) : undefined), 'malformed-json', 'rules')
await stopCase('a next page of Functions (pagination is not allowed)', k => (k.includes('/v2/') ? new Response(JSON.stringify({ functions: [], nextPageToken: 'abc' }), { status: 200 }) : undefined), 'unexpected-shape', 'functions')
await stopCase('unreachable locations in the Functions list', k => (k.includes('/v2/') ? new Response(JSON.stringify({ functions: [], unreachable: ['europe-west1'] }), { status: 200 }) : undefined), 'unexpected-shape', 'functions')
await stopCase('a function with a malformed name', k => (k.includes('/v2/') ? new Response(JSON.stringify({ functions: [rawFunction('x', { name: 'projects/finapp-prod-10a83/locations/us-central1/functions/x' })] }), { status: 200 }) : undefined), 'unexpected-shape', 'functions')
await stopCase('a release for another project / a ruleset id with a slash', k => (k.includes('releases') ? new Response(JSON.stringify({ name: 'projects/finapp-staging/releases/cloud.firestore', rulesetName: 'projects/finapp-staging/rulesets/a/../b' }), { status: 200 }) : undefined), 'unexpected-shape', 'rules')
await stopCase('a ruleset with two files', k => (k.endsWith('live-ruleset-0002') ? new Response(JSON.stringify({ name: 'projects/finapp-staging/rulesets/live-ruleset-0002', source: { files: [{ content: 'a' }, { content: 'b' }] } }), { status: 200 }) : undefined), 'unexpected-shape', 'rules')
await stopCase('a lookup answer with two accounts', k => (k.startsWith('POST identitytoolkit') ? new Response(JSON.stringify({ users: [{ email: 'a@b.c' }, { email: 'd@e.f' }] }), { status: 200 }) : undefined), 'unexpected-shape', 'auth')
await stopCase('a lookup answer about another account', k => (k.startsWith('POST identitytoolkit') ? new Response(JSON.stringify({ users: [{ email: 'someone.else@example.com' }] }), { status: 200 }) : undefined), 'unexpected-shape', 'auth')
await stopCase('a redirect on a frontend file', k => (k === 'GET stage.aktivmetr.ru/finapp/icons.svg' ? new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }) : undefined), 'redirect', 'frontend')
await t('stop: a STOP keeps the branches finished before it in the state and the result (checkpoint), and the result says STOP', async () => {
  const { cfg } = rehearsalCfg(makeWorld(), { override: k => (k.includes('releases') ? new Response('{}', { status: 500 }) : undefined) })
  const r = await runRecon(cfg)
  const st = JSON.parse(fs.readFileSync(path.join(cfg.evDir, 'recon-state.json'), 'utf8')), res = JSON.parse(fs.readFileSync(path.join(cfg.evDir, 'recon-result.json'), 'utf8'))
  return r.exitCode === 2 && st.branches.frontend.matchesPin === true && st.branches.functions.matchesPin === true && !st.branches.rules && res.status === 'STOP' && res.stop.code === 'http-5xx' && eq(res.stop, st.stop)
})

// ── the consumed-subject lookup: pinned source, synthetic subject only ────────────────────────────────────────────────────────────────
const subjectCase = (name, mutate, code) => t(`subject: ${name} -> STOP ${code} before any Auth request`, async () => {
  const w = makeWorld(); const { cfg, calls, journalPath } = rehearsalCfg(w)
  mutate(w, cfg, journalPath)
  const r = await runRecon(cfg)
  return r.exitCode === 2 && r.stop?.branch === 'auth' && r.stop.code === code && !calls.some(c => c.method === 'POST') ? true : `${r.status} ${JSON.stringify(r.stop)}`
})
await subjectCase('the journal bytes changed (input hash differs from the pin)', (w, cfg, jp) => fs.appendFileSync(jp, '\n'), 'subject-source-mismatch')
await subjectCase('the journal is missing', (w, cfg, jp) => { cfg.consumedJournalPath = path.join(path.dirname(jp), 'nope.jsonl') }, 'subject-source-mismatch')
await subjectCase('the pinned subject hash is another subject (an owner address instead of the synthetic one)', (w) => { w.pins.subject = { ...w.pins.subject, subjectSha256: sha('owner@gmail.com') } }, 'subject-source-mismatch')
await t('subject: a journal with two creates or another run id is rejected by deriveSubject', () => {
  const w = makeWorld()
  const mk = events => { const b = Buffer.from(`${events.map(e => JSON.stringify(e)).join('\n')}\n`); return { b, pin: { ...w.subject.pin, source: { ...w.subject.pin.source, sha256: sha(b) } } } }
  const base = [{ event: 'PREFLIGHT_OK', runId: 'abcdef01' }, { event: 'AUTH_CREATE_MAY_BE_SENT', key: 'admin' }]
  const twice = mk([...base, { event: 'AUTH_CREATE_MAY_BE_SENT', key: 'viewer' }]), other = mk([{ event: 'PREFLIGHT_OK', runId: '11111111' }, base[1]]), viewer = mk([base[0], { event: 'AUTH_CREATE_MAY_BE_SENT', key: 'viewer' }])
  const code = (x) => { try { deriveSubject(x.pin, x.b); return 'ok' } catch (e) { return e.code } }
  let okDerive = false; try { okDerive = deriveSubject(w.subject.pin, w.subject.journal) === w.subject.email } catch { okDerive = false }
  return okDerive && code(twice) === 'subject-source-mismatch' && code(other) === 'subject-source-mismatch' && code(viewer) === 'subject-source-mismatch'
})
await t('subject: the real pin file is consistent (format, run id of the consumed run, hashes) and names no address', () => {
  const s = pins0.subject
  return s.run === 'r3-ab9fb2fe' && s.runId === '7cbe0a6e' && s.subjectKey === 'admin' && /^[0-9a-f]{64}$/.test(s.subjectSha256) && /^[0-9a-f]{64}$/.test(s.source.sha256) && !/m1-[0-9a-f]{8}-/.test(JSON.stringify(s))
})

// ── credential bootstrap: read-only, closed codes ─────────────────────────────────────────────────────────────────────────────────────
const fakeFs = (text, err) => { const writes = []; return { readFileSync: p => { if (err) throw Object.assign(new Error(`${p} SECRET-PATH-TEXT`), { code: err }); return text }, writeFileSync: (...a) => writes.push(a), appendFileSync: (...a) => writes.push(a), renameSync: (...a) => writes.push(a), unlinkSync: (...a) => writes.push(a), writes } }
const loginJson = (over = {}) => JSON.stringify({ user: { email: 'owner@example.com' }, tokens: { access_token: SYNTH_TOKEN, refresh_token: '1//REFRESH-SECRET-0123456789abcdef', expires_at: NOW + 3600000, ...over } })
const bootCode = (fsx, env = { XDG_CONFIG_HOME: emptyProfile }) => { try { return { ok: readCachedLogin({ env, now: () => NOW, fsx }) } } catch (e) { return { code: e.code, msg: String(e.message) } } }
await t('bootstrap: reads access token + expiry only, in memory, with zero writes and zero token-endpoint calls; the refresh token is never returned', () => {
  const f = fakeFs(loginJson()); const r = bootCode(f)
  return r.ok.accessToken === SYNTH_TOKEN && r.ok.remainingMs === 3600000 && r.ok.writes === 0 && r.ok.tokenEndpointCalls === 0 && f.writes.length === 0 && !JSON.stringify(r.ok).includes('REFRESH-SECRET')
})
await t('bootstrap: missing / unreadable / no token / too old / wrong types end in closed codes without any path or content', () => {
  const cases = [[fakeFs('', 'ENOENT'), 'credential-config-missing'], [fakeFs('', 'EACCES'), 'credential-config-unreadable'], [fakeFs('{ not json'), 'credential-config-unreadable'], [fakeFs('{}'), 'credential-token-missing'], [fakeFs(loginJson({ access_token: '' })), 'credential-token-missing'],
    [fakeFs(loginJson({ access_token: 'short' })), 'credential-token-missing'], [fakeFs(loginJson({ access_token: `${SYNTH_TOKEN} x` })), 'credential-token-missing'], [fakeFs(loginJson({ expires_at: '9999999999999' })), 'credential-token-missing'],
    [fakeFs(loginJson({ expires_at: NOW + RECON.limits.minTokenRemainingMs - 1 })), 'credential-too-old'], [fakeFs(loginJson({ expires_at: NOW - 1000 })), 'credential-too-old']]
  for (const [f, code] of cases) { const r = bootCode(f); if (r.code !== code || /SECRET|REFRESH|owner@|\.json|configstore/.test(r.msg)) return `${code}: ${JSON.stringify(r)}` }
  return bootCode(fakeFs(loginJson({ expires_at: NOW + RECON.limits.minTokenRemainingMs }))).ok !== undefined
})
await t('bootstrap: the config path follows XDG_CONFIG_HOME (the isolated profile) and a real temp file is read without being modified', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-profile-')); const file = path.join(dir, 'configstore', 'firebase-tools.json')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, loginJson())
  const before = sha(fs.readFileSync(file)), mtime = fs.statSync(file).mtimeMs
  const r = readCachedLogin({ env: { XDG_CONFIG_HOME: dir }, now: () => NOW })
  return configPath({ XDG_CONFIG_HOME: dir }) === file && r.accessToken === SYNTH_TOKEN && sha(fs.readFileSync(file)) === before && fs.statSync(file).mtimeMs === mtime
})
await t('bootstrap failure inside a reading: STOP before any Google request, frontend result kept, the token path is never reached, nothing about the owner profile in the evidence', async () => {
  const w = makeWorld(); const { cfg, calls } = rehearsalCfg(w, { bootstrap: () => { throw new Blocked('credential-too-old') } })
  const r = await runRecon(cfg)
  const st = JSON.parse(fs.readFileSync(path.join(cfg.evDir, 'recon-state.json'), 'utf8'))
  return r.exitCode === 2 && r.stop.code === 'credential-too-old' && calls.length === 17 && calls.every(c => c.host === RECON.stageHost) && st.branches.frontend?.matchesPin === true && !fs.readFileSync(path.join(cfg.evDir, 'recon-result.json'), 'utf8').includes('configstore')
})
await t('bootstrap sources: the module can only READ (no write/rename/unlink/copy/mkdir/exec) and imports no firebase-tools / googleapis / child_process', () => {
  const src = fs.readFileSync(path.join(PKG, 'recon-bootstrap.mjs'), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const imports = src.split('\n').filter(l => l.startsWith('import ')).join('\n')
  return !/writeFile|appendFile|rename|unlink|copyFile|mkdir|rmSync|spawn|exec|fetch\(/.test(src) && !/firebase-tools|googleapis|child_process/.test(imports)
})

// ── INIT refusals (staging profile): nothing runs, nothing is read, nothing is created ───────────────────────────────────────────────────
const refused = async (name, cfg, re) => t(`INIT: ${name}`, async () => {
  const r = await runRecon(cfg)
  return r.status === 'INIT_REFUSED' && r.exitCode === 3 && (!re || re.test(r.reason)) && !fs.existsSync(realDir) ? true : `${r.status} ${r.reason}`
})
await refused('no permit -> refused, no fetch, no claim', stagingCfg({ permit: undefined }), /permit/)
await refused('a permit template (not a permit) is refused', stagingCfg({ permit: permitTemplate() }), /permit/)
for (const [n, f] of [['codeSums', p => { p.bytes.codeSums = '0'.repeat(64) }], ['requestAllowlist', p => { p.bytes.requestAllowlist = '0'.repeat(64) }], ['frontendAllowlist', p => { p.bytes.frontendAllowlist = '0'.repeat(64) }], ['consumedSubjectPin', p => { p.bytes.consumedSubjectPin = '0'.repeat(64) }],
  ['expectedState', p => { p.bytes.expectedState = '0'.repeat(64) }], ['distManifest', p => { p.bytes.distManifest = '0'.repeat(64) }]]) {
  const p = goodPermit(); f(p)
  await refused(`a permit bound to other bytes (${n}) is refused`, stagingCfg({ permit: p }), /bound/)
}
await t('permit validity matrix: wrong project / host / head / namespace / Rules pin / task, bad operations, missing acknowledgements, time window, >2 h, placeholder reference', () => {
  const f = factsOf()
  const mods = [p => { p.target.project = 'finapp-prod-10a83' }, p => { p.target.stageHost = 'app.aktivmetr.ru' }, p => { p.target.head = '8526a791ce3f62dee5a64aa239b795c609a39226' }, p => { p.namespace.evidenceName = 'm1-stg-s1b-714d0f91' }, p => { p.rules.canonicalSha256 = '0'.repeat(64) },
    p => { p.taskId = 'M1-STAGING-R3-SMOKE-PREP-02' }, p => { p.format = 'x' }, p => { p.operations.extra = true }, p => { delete p.operations.authExactLookup }, p => { p.operations.functionsMetadataRead = 'yes' },
    p => { for (const k of Object.keys(p.operations)) p.operations[k] = false }, p => { p.operations.credentialConfigRead = false }, p => { p.operations.functionsMetadataRead = false; p.operations.rulesReleaseRead = false; p.operations.authExactLookup = false; p.operations.credentialConfigRead = true },
    ...ACK_KEYS.map(k => p => { p.acknowledgements[k] = false }), p => { delete p.acknowledgements[ACK_KEYS[0]] },
    p => { p.owner.approvedAtUtc = '2026-11-01T13:00:00Z'; p.owner.expiresAtUtc = '2026-11-01T14:00:00Z' }, p => { p.owner.expiresAtUtc = '2026-11-01T11:59:59Z' }, p => { p.owner.expiresAtUtc = '2026-11-01T13:00:01Z' }, p => { p.owner.approvedAtUtc = 'tomorrow' }, p => { p.owner.approvalRef = '<reference>' }, p => { p.owner.approvalRef = 'x' }]
  const bad = mods.filter(m => { const p = goodPermit(); m(p); return permitProblems(p, f, NOW).length === 0 })
  return permitProblems(goodPermit(), f, NOW).length === 0 && bad.length === 0 ? true : `accepted ${bad.length}`
})
await refused('forbidden environment (NODE_OPTIONS / FIREBASE_TOKEN / GOOGLE_APPLICATION_CREDENTIALS / proxy / emulator / stub)', stagingCfg({ env: { XDG_CONFIG_HOME: emptyProfile, NODE_OPTIONS: '--require=x.cjs' } }), /environment/)
for (const k of ['FIREBASE_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'HTTPS_PROXY', 'FIRESTORE_EMULATOR_HOST', 'M1_STUB_SCENARIO', 'GOOGLE_OAUTH_ACCESS_TOKEN']) await refused(`forbidden environment variable ${k}`, stagingCfg({ env: { XDG_CONFIG_HOME: emptyProfile, [k]: 'x' } }), /environment/)
await refused('a production marker in an environment value', stagingCfg({ env: { XDG_CONFIG_HOME: emptyProfile, SOME_TARGET: 'finapp-prod-10a83' } }), /target/)
await refused('a production host marker in an environment value', stagingCfg({ env: { XDG_CONFIG_HOME: emptyProfile, SOME_TARGET: 'https://app.aktivmetr.ru/' } }), /target/)
await refused('a wrong evidence namespace name', stagingCfg({ evDir: path.join(RECON.runtimeRoot, 'm1-stg-s1b-714d0f91') }), /namespace/)
await refused('a consumed namespace (an S1b one)', stagingCfg({ evDir: path.join(RECON.runtimeRoot, 'm1-staging-run-714d0f91-s1b') }), /namespace/)
await refused('a namespace outside the runtime root', stagingCfg({ evDir: path.join('D:\\elsewhere', RECON.evidenceName) }), /namespace/)
await t('INIT: tampered pins (allowlist POST on a GET entry / more than one lookup / non-google host / wrong limits) are refused by pinProblems', () => {
  const clone = () => JSON.parse(JSON.stringify(pins0.allow))
  const mods = [a => { a.entries[0].method = 'POST' }, a => { a.entries.find(e => e.id === 'auth-exact-lookup').maxRequests = 2 }, a => { a.entries[0].host = 'evil.example' }, a => { a.entries[1].auth = 'none' }, a => { a.limits.maxRequests = 500 }, a => { a.limits.globalDeadlineMs = 9e9 }, a => { a.project = 'finapp-prod-10a83' }]
  return mods.every(m => { const a = clone(); m(a); return pinProblems({ ...pins0, allow: a }).length > 0 })
})
await t('INIT: tampered frontend / subject / expected pins are refused', () => {
  const fp = () => JSON.parse(JSON.stringify(pins0.frontend))
  const bad = [f => { f.host = 'app.aktivmetr.ru' }, f => { f.files.pop() }, f => { f.files[0].path = '../x' }, f => { f.files[0].sha256 = 'z' }, f => { f.files[0].bytes = 1e9 }]
  const okF = bad.every(m => { const f = fp(); m(f); return pinProblems({ ...pins0, frontend: f }).length > 0 })
  const okS = [s => { s.run = 'other' }, s => { s.subjectKey = 'viewer' }, s => { s.subjectSha256 = 'x' }].every(m => { const s = JSON.parse(JSON.stringify(pins0.subject)); m(s); return pinProblems({ ...pins0, subject: s }).length > 0 })
  const okE = pinProblems({ ...pins0, expected: { ...pins0.expected, project: 'finapp-prod-10a83' } }).length > 0 && pinProblems({ ...pins0, expected: { ...pins0.expected, rulesTarget: { ...pins0.expected.rulesTarget, canonicalSha256: '0'.repeat(64) } } }).length > 0
  return okF && okS && okE
})
await t('INIT: rehearsal reading outside the rehearsal base / unknown profile / no fetch implementation are refused', async () => {
  const a = rehearsalCfg(makeWorld()); a.cfg.evDir = 'D:\\elsewhere\\ev'
  const b = rehearsalCfg(makeWorld()); b.cfg.profile = 'production'
  const c = rehearsalCfg(makeWorld()); c.cfg.fetchImpl = undefined
  const rs = [await runRecon(a.cfg), await runRecon(b.cfg), await runRecon(c.cfg)]
  return rs.every(r => r.status === 'INIT_REFUSED') && a.calls.length + b.calls.length === 0 && !fs.existsSync('D:\\elsewhere')
})

// ── one-use claim ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
await t('claim: a competitor taking the namespace between the check and the claim wins - the loser runs nothing (0 fetch, 0 bootstrap) and the competitor evidence is preserved byte for byte', async () => {
  let opts = 'unset'
  const { cfg, calls, bootstrapCalls } = rehearsalCfg(makeWorld(), { extra: { claimMkdir: (p, o) => { opts = o; fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'recon-ledger.jsonl'), '{"phase":"COMPETITOR_ALREADY_CLAIMED"}\n'); return fs.mkdirSync(p, o) } } })
  const r = await runRecon(cfg)
  return r.status === 'INIT_REFUSED' && /already claimed/.test(r.reason) && calls.length === 0 && bootstrapCalls.length === 0 && opts === undefined && fs.readFileSync(path.join(cfg.evDir, 'recon-ledger.jsonl'), 'utf8') === '{"phase":"COMPETITOR_ALREADY_CLAIMED"}\n' && !fs.existsSync(path.join(cfg.evDir, 'recon-claim.json'))
})
await t('claim: a non-recursive mkdir of the namespace itself, then an exclusive marker before the first ledger event; an existing / partial namespace is consumed and kept', async () => {
  const seen = []
  const a = rehearsalCfg(makeWorld(), { extra: { claimMkdir: (p, o) => { seen.push([p, o]); return fs.mkdirSync(p, o) } } })
  const ra = await runRecon(a.cfg)
  const claim = JSON.parse(fs.readFileSync(path.join(a.cfg.evDir, 'recon-claim.json'), 'utf8')), first = JSON.parse(fs.readFileSync(path.join(a.cfg.evDir, 'recon-ledger.jsonl'), 'utf8').split('\n')[0])
  const b = rehearsalCfg(makeWorld()); fs.mkdirSync(b.cfg.evDir, { recursive: true })
  const rb = await runRecon(b.cfg)
  return ra.exitCode === 0 && seen.length === 1 && seen[0][0] === a.cfg.evDir && seen[0][1] === undefined && Date.parse(claim.claimedAt) <= Date.parse(first.at) && first.phase === 'START' && rb.status === 'INIT_REFUSED' && fs.existsSync(b.cfg.evDir) && fs.readdirSync(b.cfg.evDir).length === 0 && b.calls.length === 0
})
await t('claim: another claim error or an already present marker leaves the namespace consumed and runs nothing', async () => {
  const a = rehearsalCfg(makeWorld(), { extra: { claimMkdir: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) } } })
  const b = rehearsalCfg(makeWorld(), { extra: { claimMkdir: p => { fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'recon-claim.json'), 'taken') } } })
  const ra = await runRecon(a.cfg), rb = await runRecon(b.cfg)
  return ra.status === 'INIT_REFUSED' && /could not claim/.test(ra.reason) && rb.status === 'INIT_REFUSED' && /claim marker/.test(rb.reason) && a.calls.length + b.calls.length === 0 && a.bootstrapCalls.length + b.bootstrapCalls.length === 0 && fs.readFileSync(path.join(b.cfg.evDir, 'recon-claim.json'), 'utf8') === 'taken'
})
await t('claim: two real processes race for one namespace - exactly one reading, the loser fetches nothing and never reads the credential config', async () => {
  const unit = newUnit(); fs.mkdirSync(unit, { recursive: true }); const evDir = path.join(unit, 'ev'), log = path.join(unit, 'calls.log'); fs.writeFileSync(log, '')
  const worker = () => new Promise(resolve => { let out = ''; const c = spawn(process.execPath, [path.join(PKG, 'tests', 'recon-race-worker.mjs'), evDir, log], { windowsHide: true }); c.stdout.on('data', d => { out += d }); c.on('exit', () => resolve(out.trim())) })
  const [a, b] = await Promise.all([worker(), worker()])
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
  const results = [a, b].sort()
  return results[0].startsWith('INIT_REFUSED') && results[1].startsWith('READ_COMPLETE_ALL_MATCH_PINS') && calls.filter(x => x === 'fetch').length === 22 && calls.filter(x => x === 'bootstrap').length === 1 ? true : `${a} | ${b} calls=${calls.length}`
})

// ── sanitizer / scanner ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
await t('scanner: a token-looking value that reaches the evidence ends the reading with exit 2 and a scan-hit marker (file names only); the clean case has none', async () => {
  const leak = rehearsalCfg(makeWorld(), { override: withFn('createCompany', f => { f.serviceConfig.revision = 'ya29.LEAKED-TOKEN-LOOKING-VALUE-0123456789'; return f }) })
  const r = await runRecon(leak.cfg)
  const marker = JSON.parse(fs.readFileSync(path.join(leak.cfg.evDir, 'recon-scan-hit.json'), 'utf8'))
  const clean = rehearsalCfg(makeWorld()); const rc = await runRecon(clean.cfg)
  return r.exitCode === 2 && marker.files.length >= 1 && !JSON.stringify(marker).includes('LEAKED') && rc.exitCode === 0 && !fs.existsSync(path.join(clean.cfg.evDir, 'recon-scan-hit.json'))
})
await t('scanner patterns: tokens, refresh tokens, bearer, API keys, fixture passwords, subject e-mails and an exact known token are all detected', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-scan-'))
  const cases = ['ya29.abcdefghijklmnopqrstuvwxyz', '1//0abcdefghijklmnopqrstuv', 'Bearer abcdefghijklmnopqrstuvwxyz', `AIza${'a'.repeat(35)}`, 'M1!abcdefghijklmnopqrstuvwxyz', '"password": "x"', 'refresh_token', 'm1-abcdef01-admin@example.invalid']
  const hits = cases.map((c, i) => { const f = path.join(d, `c${i}.txt`); fs.writeFileSync(f, c); return scanEvidence(d, []).includes(`c${i}.txt`) })
  fs.writeFileSync(path.join(d, 'needle.txt'), 'prefix SPECIFIC-NEEDLE-VALUE suffix')
  return hits.every(Boolean) && scanEvidence(d, ['SPECIFIC-NEEDLE-VALUE']).includes('needle.txt')
})

// ── offline modes, CLI, hygiene ───────────────────────────────────────────────────────────────────────────────────────────────────────
await t('offline guard: refuses without the fence / the fence log / with credential-like variables; accepts a clean fenced environment', () => {
  const ok = { NODE_OPTIONS: '--require=D:\\p\\offline-fence\\loopback-only.cjs', M1_FENCE_LOG: 'D:\\x\\f.jsonl', GCLOUD_PROJECT: 'demo-finapp' }
  return offlineGuardProblems(ok).length === 0 && offlineGuardProblems({ ...ok, NODE_OPTIONS: '' }).length > 0 && offlineGuardProblems({ ...ok, M1_FENCE_LOG: '' }).length > 0 && ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'CLOUDSDK_AUTH_ACCESS_TOKEN'].every(k => offlineGuardProblems({ ...ok, [k]: 'x' }).length > 0)
})
await t('CLI: plan / selftest / permit-draft refuse without the fence; execute without a permit refuses (exit 3) and creates nothing', () => {
  const run = (args, env) => spawnSync(process.execPath, [path.join(PKG, 'recon.mjs'), ...args], { env, encoding: 'utf8', windowsHide: true })
  const clean = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, XDG_CONFIG_HOME: emptyProfile }
  const a = ['plan', 'selftest', 'permit-draft'].map(c => run([c], clean))
  const e = run(['execute', '--permit', path.join(os.tmpdir(), 'no-such-permit.json')], clean)
  return a.every(r => r.status === 3 && /offline guard/.test(r.stdout)) && e.status === 3 && /INIT_REFUSED/.test(e.stdout) && !fs.existsSync(realDir)
})
await t('offline launcher: plan / selftest / permit-draft run in an isolated environment even if the parent holds credential variables, with NO network event; the plan lists exactly the allowlist', () => {
  const parent = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, GOOGLE_APPLICATION_CREDENTIALS: 'x', FIREBASE_TOKEN: 'y', GITHUB_TOKEN: 'z', HTTPS_PROXY: 'http://p.invalid:1' }
  const run = cmd => spawnSync(process.execPath, [path.join(PKG, 'recon-offline.mjs'), cmd], { env: parent, encoding: 'utf8', windowsHide: true })
  const a = run('selftest'), b = run('plan'), c = run('permit-draft')
  const ev = r => Number((r.stderr.match(/fenceEvents=(\d+)/) ?? [])[1])
  let plan = null, draft = null; try { plan = JSON.parse(b.stdout); draft = JSON.parse(c.stdout) } catch { /* below */ }
  const facts = factsOf()
  return a.status === 0 && /SELFTEST_PASS/.test(a.stdout) && ev(a) === 0 && ev(b) === 0 && ev(c) === 0 && plan?.requests?.length === 22 && plan.status === 'PREPARED_NOT_AUTHORIZED' && draft?.status === 'TEMPLATE_NOT_A_PERMIT' &&
    draft.bytes.codeSums === facts.codeSumsSha256 && draft.bytes.requestAllowlist === facts.requestAllowlistSha256 && Object.values(draft.operations).every(v => v === false) && permitProblems(draft, facts, NOW).length > 0 ? true : `a=${a.status} ${a.stdout.slice(0, 100)} b=${b.status} c=${c.status}`
})
await t('hygiene: no write-capable provider call, no firebase-tools / googleapis / child_process / browser / SDK import in the engine; the only POST is the exact lookup', () => {
  const files = ['recon-core.mjs', 'recon-bootstrap.mjs', 'recon-permit.mjs', 'recon-pins.mjs', 'recon.mjs']
  const code = files.map(f => fs.readFileSync(path.join(PKG, f), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')).join('\n')
  const imports = code.split('\n').filter(l => l.startsWith('import ')).join('\n')
  const bad = [/firebase-tools|child_process|playwright|puppeteer|firebase-admin|@firebase/].filter(re => re.test(imports)).concat([/method:\s*['"](PUT|PATCH|DELETE)/, /exportDocuments|setIamPolicy|generateDownloadUrl/].filter(re => re.test(code)))
  const posts = (code.match(/'POST'/g) ?? []).length
  return bad.length === 0 && posts <= 3 ? true : `bad=${bad.map(String)} posts=${posts}`
})
// ── assumptions about the REAL fetch that the engine relies on, checked against a LOOPBACK server (the engine itself can only talk to its pinned hosts) ──────────────────────
await t('real fetch semantics the engine relies on: redirect=error rejects (-> network-unknown), AbortSignal.timeout gives TimeoutError (-> timeout), and a streamed body can be cancelled at a cap', async () => {
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: '/ok' }); res.end() } else if (req.url === '/slow') { /* never answers */ } else if (req.url === '/big') { res.writeHead(200); res.write('x'.repeat(100000)); res.end('y'.repeat(100000)) } else { res.writeHead(200); res.end('ok') }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const redir = await fetch(`${base}/redir`, { redirect: 'error' }).then(() => 'resolved', e => e?.name)
    const slow = await fetch(`${base}/slow`, { signal: AbortSignal.timeout(100) }).then(() => 'resolved', e => e?.name)
    const res = await fetch(`${base}/big`); const reader = res.body.getReader(); let size = 0, cancelled = false
    for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.byteLength; if (size > 50000) { await reader.cancel(); cancelled = true; break } }
    return redir === 'TypeError' && slow === 'TimeoutError' && cancelled && size < 200000
  } finally { server.closeAllConnections?.(); server.close() }
})
await t('the real staging namespace was never created by these tests, and no owner credential file was involved', () => startedClean && !fs.existsSync(realDir))

fs.rmSync(emptyProfile, { recursive: true, force: true })
console.log(`RECON_NEGATIVE_CONTROLS ${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail}${fail ? ` failed=${failures.join(' | ')}` : ''}`)
process.exitCode = fail ? 1 : 0
