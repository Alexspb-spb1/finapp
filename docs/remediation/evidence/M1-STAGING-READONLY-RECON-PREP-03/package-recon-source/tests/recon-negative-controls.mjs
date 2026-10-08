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
import { relocatedCopy, writeSums, rootsOf } from './relocate.mjs'

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
  const ledger = createLedger(ledgerFile, opts.ledgerNow)
  const rec = recorderFetch(world ?? makeWorld(), opts.override)
  const client = createClient({ fetchImpl: opts.fetchImpl ?? rec.fetchImpl, entries, ledger, token: 'token' in opts ? opts.token : SYNTH_TOKEN, now: opts.now, limits: opts.limits, signalFor: opts.signalFor })
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

// ── the HARD global deadline (corrections V1, CR3): deterministic (injected clock and signal factory, no sleep, no socket) ──────────────────────
const DL = RECON.limits.globalDeadlineMs
const V1URL = entryUrl(entries.find(e => e.id === 'functions-v1-list'))
const timed = (opts = {}) => { const st = { clock: 0 }; const seen = []; const c = mkClient(null, { now: () => st.clock, signalFor: ms => { seen.push(ms); return new AbortController().signal }, ...opts }); return { ...c, st, seen } }
const chunk = s => new TextEncoder().encode(s)
/** A response whose body yields one step per READ (highWaterMark 0: nothing is pulled early); a step returns bytes, or null to close; `cancelled()` reports a cancel of the stream. */
const steppedBody = steps => { let i = 0, cancelled = false; const body = new ReadableStream({ pull(c) { const v = steps[i++](); if (v === null) c.close(); else c.enqueue(v) }, cancel() { cancelled = true } }, { highWaterMark: 0 }); return { response: new Response(body, { status: 200 }), cancelled: () => cancelled } }
const lastResult = f => ledgerOf(f).filter(e => e.phase === 'RESULT').at(-1)
await t('deadline (start): a request may START only while budget is left - DL-1 ms starts, exactly DL and DL+1 are denied before any dispatch', async () => {
  const a = timed(); a.st.clock = DL - 1; await a.client.request('GET', V2)
  const b = timed(); b.st.clock = DL; const rb = await rejectsWith(b.client.request('GET', V2), 'deadline')
  const c = timed(); c.st.clock = DL + 1; const rc = await rejectsWith(c.client.request('GET', V2), 'deadline')
  return a.calls.length === 1 && rb && rc && b.calls.length === 0 && c.calls.length === 0 && ledgerOf(b.ledgerFile)[0].phase === 'DENIED' && ledgerOf(b.ledgerFile).length === 1
})
await t('deadline (signal): the request signal is the SMALLER of the per-request timeout and the budget left (10000 ms at the start, 500 ms with 500 ms left, 10000 ms with 20 s left)', async () => {
  const a = timed(); await a.client.request('GET', V2)
  const b = timed(); b.st.clock = DL - 500; await b.client.request('GET', V2)
  const c = timed(); c.st.clock = DL - 20000; await c.client.request('GET', V2)
  return [a, b, c].map(x => x.seen.join()).join('|') === '10000|500|10000'
})
await t('deadline (headers): the auditor counterexample - started 119500 ms, answered 128500 ms (9 s, inside the 10 s request timeout) - is a STOP deadline, not a success; the body is cancelled and no later request is dispatched', async () => {
  let tm, cancelled = false
  tm = timed({ override: () => { tm.st.clock = 128500; const body = new ReadableStream({ pull(c) { c.enqueue(chunk('{}')); c.close() }, cancel() { cancelled = true } }, { highWaterMark: 0 }); return new Response(body, { status: 200 }) } })
  tm.st.clock = 119500
  const stopped = await rejectsWith(tm.client.request('GET', V2), 'deadline')
  const last = lastResult(tm.ledgerFile)
  const later = await rejectsWith(tm.client.request('GET', V1URL), 'deadline')
  return stopped && cancelled && last.outcome === 'deadline' && last.elapsedMs === 9000 && later && tm.calls.length === 1 && !ledgerOf(tm.ledgerFile).some(e => e.outcome === 'ok')
})
await t('deadline (headers boundary): an answer exactly AT the deadline is accepted, one millisecond after it is a STOP', async () => {
  let at, tm
  const mk = () => { const t2 = timed({ override: () => { t2.st.clock = at; return new Response('{}', { status: 200 }) } }); t2.st.clock = DL - 2000; return t2 }
  at = DL; tm = mk(); const okAt = (await tm.client.request('GET', V2)).status === 200
  at = DL + 1; tm = mk(); const late = await rejectsWith(tm.client.request('GET', V2), 'deadline')
  return okAt && late
})
await t('deadline (status): an error status or a redirect that ARRIVES after the deadline is a STOP deadline (never http-5xx / redirect decided after the budget), and the body is cancelled', async () => {
  const out = []
  for (const make of [() => new Response('x', { status: 503 }), () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })]) {
    let tm
    tm = timed({ override: () => { tm.st.clock = DL + 1; return make() } }); tm.st.clock = DL - 1000
    out.push(await rejectsWith(tm.client.request('GET', V2), 'deadline') && lastResult(tm.ledgerFile).outcome === 'deadline')
  }
  return out.every(Boolean)
})
await t('deadline (body): a streamed body that crosses the deadline between chunks is cancelled and ends in a STOP deadline (no success, no later request)', async () => {
  let tm, probe
  tm = timed({ override: () => { probe = steppedBody([() => chunk('{"functions":['), () => { tm.st.clock = DL + 5000; return chunk(']}') }]); return probe.response } })
  tm.st.clock = DL - 1000
  const stopped = await rejectsWith(tm.client.request('GET', V2), 'deadline')
  const last = lastResult(tm.ledgerFile)
  return stopped && probe.cancelled() && last.outcome === 'deadline' && last.bytes === 14 && !ledgerOf(tm.ledgerFile).some(e => e.outcome === 'ok') && (await rejectsWith(tm.client.request('GET', V1URL), 'deadline')) && tm.calls.length === 1
})
await t('deadline (last read): the FINAL read that reports the end of the body after the deadline is a STOP deadline, not the success of the last request', async () => {
  let tm
  tm = timed({ override: () => steppedBody([() => chunk('{}'), () => { tm.st.clock = DL + 1; return null }]).response })
  tm.st.clock = DL - 1000
  const stopped = await rejectsWith(tm.client.request('GET', V2), 'deadline')
  return stopped && lastResult(tm.ledgerFile).outcome === 'deadline' && !ledgerOf(tm.ledgerFile).some(e => e.outcome === 'ok')
})
await t('deadline (body boundary): a body that ends exactly AT the deadline is a success', async () => {
  let tm
  tm = timed({ override: () => steppedBody([() => chunk('{}'), () => { tm.st.clock = DL; return null }]).response })
  tm.st.clock = DL - 1000
  const r = await tm.client.request('GET', V2)
  return r.bytes.toString() === '{}' && lastResult(tm.ledgerFile).outcome === 'ok'
})
await t('deadline (abort): an abort while the budget bounds the request is `deadline`, an abort of the full per-request timeout stays `timeout` - for the headers and for the body', async () => {
  const timeoutErr = () => Object.assign(new Error('t'), { name: 'TimeoutError' })
  const code = async (clock, mode) => {
    const tm = timed({ override: () => { if (mode === 'headers') throw timeoutErr(); return new Response(new ReadableStream({ pull() { throw timeoutErr() } }, { highWaterMark: 0 }), { status: 200 }) } })
    tm.st.clock = clock
    try { await tm.client.request('GET', V2); return 'resolved' } catch (e) { return e.code }
  }
  return [await code(DL - 500, 'headers'), await code(0, 'headers'), await code(DL - 500, 'body'), await code(0, 'body')].join() === 'deadline,timeout,deadline,timeout'
})
await t('deadline (intent): when the budget runs out while the INTENT is being written, the request is NOT dispatched (INTENT then RESULT deadline)', async () => {
  const st = { clock: 0, ledgerCalls: 0 }
  const m = mkClient(null, { now: () => st.clock, ledgerNow: () => { if (++st.ledgerCalls === 1) st.clock = DL + 10; return st.clock } })
  const stopped = await rejectsWith(m.client.request('GET', V2), 'deadline')
  const ev = ledgerOf(m.ledgerFile)
  return stopped && m.calls.length === 0 && ev.map(e => e.phase).join() === 'INTENT,RESULT' && ev[1].outcome === 'deadline'
})
await t('deadline (real signal on a loopback server): headers that never arrive and a body that stalls halfway both end as STOP deadline when the budget is small, long before the 10 s request timeout', async () => {
  const http = await import('node:http')
  const server = http.createServer((req, res) => { if (req.url === '/body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"functions":[') } /* /headers: never answers */ })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const one = async route => {
      const unit = newUnit(); fs.mkdirSync(unit, { recursive: true })
      const c = createClient({ fetchImpl: (url, init) => fetch(`${base}${route}`, init), entries, ledger: createLedger(path.join(unit, 'l.jsonl')), token: SYNTH_TOKEN, limits: { ...RECON.limits, globalDeadlineMs: 400 } })
      const t0 = Date.now(); const code = await c.request('GET', V2).then(() => 'resolved', e => e.code)
      return { code, ms: Date.now() - t0 }
    }
    const h = await one('/headers'), b = await one('/body')
    return h.code === 'deadline' && b.code === 'deadline' && h.ms < 5000 && b.ms < 5000 ? true : `${JSON.stringify(h)} ${JSON.stringify(b)}`
  } finally { server.closeAllConnections?.(); server.close() }
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

// ── the hard deadline at the level of the whole reading (injected clock) ───────────────────────────────────────────────────────────────────
const T0 = Date.parse('2026-11-01T12:00:00Z')
await t('deadline (run): the LAST frontend request that completes after the global deadline ends the reading as STOP deadline (exit 2, no success, no result for that request)', async () => {
  const st = { clock: T0 }; const w = makeWorld(); const lastKey = `GET stage.aktivmetr.ru/finapp/${w.frontend.files.at(-1).path}`
  const { cfg, calls } = rehearsalCfg(w, { override: k => { if (k === lastKey) st.clock += DL + 1000 }, extra: { now: () => st.clock } })
  const r = await runRecon(cfg)
  const ev = ledgerOf(path.join(cfg.evDir, 'recon-ledger.jsonl'))
  const res = JSON.parse(fs.readFileSync(path.join(cfg.evDir, 'recon-result.json'), 'utf8'))
  return r.exitCode === 2 && r.status === 'STOP' && r.stop.code === 'deadline' && r.stop.branch === 'frontend' && calls.length === 17 && res.status === 'STOP' && !res.branches.frontend && ev.filter(e => e.phase === 'RESULT' && e.outcome === 'ok').length === 16 &&
    ev.filter(e => e.phase === 'RESULT' && e.outcome === 'deadline').length === 1 ? true : `${r.status} ${JSON.stringify(r.stop)} calls=${calls.length}`
})
await t('deadline (run): non-request work that crosses the deadline (the cached-login read) is not a success either - STOP deadline at the end of the run; the same crossing before further requests stops them undispatched', async () => {
  const onlyBootstrap = { credentialConfigRead: true, functionsMetadataRead: false, rulesReleaseRead: false, frontendPublicRead: false, authExactLookup: false }
  const a = { clock: T0 }
  const ra = rehearsalCfg(makeWorld(), { ops: onlyBootstrap, bootstrap: () => { a.clock += DL + 1; return bootstrapOk() }, extra: { now: () => a.clock } })
  const resA = await runRecon(ra.cfg)
  const b = { clock: T0 }
  const rb = rehearsalCfg(makeWorld(), { bootstrap: () => { b.clock += DL + 1; return bootstrapOk() }, extra: { now: () => b.clock } })
  const resB = await runRecon(rb.cfg)
  return resA.exitCode === 2 && resA.stop.code === 'deadline' && resA.stop.branch === 'run' && ra.calls.length === 0 && resB.exitCode === 2 && resB.stop.code === 'deadline' && resB.stop.branch === 'functions' && rb.calls.length === 17 ? true : `${JSON.stringify(resA.stop)} ${JSON.stringify(resB.stop)} ${rb.calls.length}`
})
await t('deadline (run): a reading that finishes exactly at its deadline is still complete (no STOP)', async () => {
  const st = { clock: T0 }; const w = makeWorld(); const lastKey = `GET stage.aktivmetr.ru/finapp/${w.frontend.files.at(-1).path}`
  const { cfg } = rehearsalCfg(w, { ops: { credentialConfigRead: false, functionsMetadataRead: false, rulesReleaseRead: false, frontendPublicRead: true, authExactLookup: false }, override: k => { if (k === lastKey) st.clock += DL }, extra: { now: () => st.clock } })
  const r = await runRecon(cfg)
  return r.exitCode === 0 && r.status === 'READ_COMPLETE_ALL_MATCH_PINS'
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

// ── BYTE INTEGRITY of the package (corrections V1, CR1) ────────────────────────────────────────────────────────────────────────────────────
// Every case below works on a self-consistent RELOCATED COPY of the package under test (roots in a sibling temp directory, manifest regenerated, frontend pins replaced by the
// synthetic ones), drives the copy's OWN engine in the STAGING profile with an injected recorder fetch and an empty owner profile, and changes bytes AFTER the permit was bound.
const fixtures = []
const imp2 = (dir, f) => import(pathToFileURL(path.join(dir, f)).href)
const integrityMod = await imp('recon-integrity.mjs')
const ALL_OPS = Object.fromEntries(Object.keys(RECON.operationClasses).map(k => [k, true]))
const FRONTEND_OPS = Object.fromEntries(Object.keys(RECON.operationClasses).map(k => [k, k === 'frontendPublicRead']))
async function stagingFixture({ ops = FRONTEND_OPS, realPins = false, realClock = false } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-stg-')); fixtures.push(parent)
  const dir = path.join(parent, 'pkg')
  const w = makeWorld()
  relocatedCopy(PKG, dir, realPins ? {} : { replace: { 'frontend-allowlist.json': `${JSON.stringify(w.frontend, null, 2)}\n` } })
  const core2 = await imp2(dir, 'recon-core.mjs'), pins2 = await imp2(dir, 'recon-pins.mjs'), permit2 = await imp2(dir, 'recon-permit.mjs')
  const h = core2.loadPins(dir).hashes
  const permit = permit2.permitTemplate()
  Object.assign(permit, {
    status: 'APPROVED', bytes: { codeSums: h.codeSumsSha256, requestAllowlist: h.requestAllowlistSha256, frontendAllowlist: h.frontendAllowlistSha256, consumedSubjectPin: h.consumedSubjectPinSha256, expectedState: h.expectedStateSha256, distManifest: h.distManifestSha256 },
    operations: { ...ops }, acknowledgements: Object.fromEntries(permit2.ACK_KEYS.map(k => [k, true])),
    // a child process (CLI path) judges the permit window by the real clock; in-process cases use the injected NOW
    owner: realClock ? { approvalRef: 'owner-decision-ref-1', approvedAtUtc: new Date(Date.now() - 60000).toISOString(), expiresAtUtc: new Date(Date.now() + 3600000).toISOString() } : { approvalRef: 'owner-decision-ref-1', approvedAtUtc: '2026-11-01T11:00:00Z', expiresAtUtc: '2026-11-01T12:30:00Z' }
  })
  const rec = recorderFetch(w)
  const permitFile = path.join(parent, 'permit.json')
  fs.writeFileSync(permitFile, JSON.stringify(permit))
  const evDir = path.join(pins2.RECON.runtimeRoot, pins2.RECON.evidenceName)
  return { dir, parent, w, core2, permit, permitFile, rec, evDir, cfg: (over = {}) => ({ profile: 'staging', pkg: dir, evDir, env: { XDG_CONFIG_HOME: emptyProfile }, fetchImpl: rec.fetchImpl, permit, now: () => NOW, ...over }) }
}
const touch = (dir, rel) => fs.appendFileSync(path.join(dir, ...rel.split('/')), /\.(json|txt)$/.test(rel) ? '\n' : '\n// changed after the permit was bound\n')
const refusedIntegrity = async (fx, why) => {
  const r = await fx.core2.runRecon(fx.cfg())
  return r.status === 'INIT_REFUSED' && r.exitCode === 3 && /^integrity:/.test(r.reason) && (!why || why.test(r.reason)) && fx.rec.calls.length === 0 && !fs.existsSync(path.dirname(fx.evDir)) ? true : `${r.status} ${r.reason} calls=${fx.rec.calls.length}`
}
await t('integrity (positive control): an unchanged self-consistent copy passes integrity and the permit, claims its namespace and completes a staging-profile frontend reading (17 injected requests, exit 0)', async () => {
  const fx = await stagingFixture(); const r = await fx.core2.runRecon(fx.cfg())
  return r.exitCode === 0 && r.status === 'READ_COMPLETE_ALL_MATCH_PINS' && fx.rec.calls.length === 17 && fs.existsSync(path.join(fx.evDir, 'recon-claim.json')) && integrityMod.integrityProblems(fx.dir).length === 0 ? true : `${r.status} ${r.reason} calls=${fx.rec.calls.length}`
})
await t('integrity (positive control): the package under test itself has no integrity problem and its selftest passes', () => {
  const p = integrityMod.integrityProblems(PKG); const s = selftest(PKG)
  return p.length === 0 && s.ok && s.files === fs.readFileSync(path.join(PKG, 'CODE-SHA256SUMS.txt'), 'utf8').split('\n').filter(Boolean).length ? true : `${p.join('; ')} | ${s.problems.join('; ')}`
})
const CHANGED = ['recon-bootstrap.mjs', 'recon-core.mjs', 'recon.mjs', 'recon-permit.mjs', 'recon-pins.mjs', 'recon-integrity.mjs', 'm1-state-lib.mjs', 'recon-offline.mjs', 'offline-fence/loopback-only.cjs', 'offline-fence/isolated-env.mjs',
  'offline-fence/FENCE-PINS.json', 'request-allowlist.json', 'frontend-allowlist.json', 'consumed-subject-pin.json', 'expected-state-r3.json', 'dist-staging-manifest.txt', 'tests/synthetic.mjs']
for (const rel of CHANGED) {
  await t(`integrity: ${rel} changed after the permit was bound (manifest and permit unchanged) -> INIT_REFUSED, 0 requests, nothing claimed, no credential read`, async () => {
    const fx = await stagingFixture({ ops: ALL_OPS }); touch(fx.dir, rel)
    return refusedIntegrity(fx, new RegExp(`code hash ${rel.replace(/[.]/g, '\\.')}`))
  })
}
const STRUCTURAL = [
  ['a listed helper is missing', d => fs.rmSync(path.join(d, 'recon-bootstrap.mjs')), /file missing: recon-bootstrap\.mjs/],
  ['an unlisted extra helper is added to the package', d => fs.writeFileSync(path.join(d, 'recon-extra.mjs'), 'export const x = 1\n'), /unlisted file: recon-extra\.mjs/],
  ['an unlisted file is added inside the fence directory', d => fs.writeFileSync(path.join(d, 'offline-fence', 'extra.cjs'), 'module.exports = 1\n'), /unlisted file: offline-fence\/extra\.cjs/],
  ['a results directory with a file is added', d => { fs.mkdirSync(path.join(d, 'results')); fs.writeFileSync(path.join(d, 'results', 'x.txt'), 'x') }, /unlisted file: results\/x\.txt/],
  ['the manifest is emptied', d => fs.writeFileSync(path.join(d, 'CODE-SHA256SUMS.txt'), ''), /manifest malformed/],
  ['the manifest is malformed', d => fs.writeFileSync(path.join(d, 'CODE-SHA256SUMS.txt'), 'not a manifest\n'), /manifest malformed/],
  ['the manifest is missing', d => fs.rmSync(path.join(d, 'CODE-SHA256SUMS.txt')), /manifest unreadable/],
  ['the manifest lacks a required helper', d => { const f = path.join(d, 'CODE-SHA256SUMS.txt'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(l => !l.endsWith('  recon-bootstrap.mjs')).join('\n')) }, /required file not listed: recon-bootstrap\.mjs/],
  ['the manifest lists a file twice', d => { const f = path.join(d, 'CODE-SHA256SUMS.txt'); const t0 = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, t0 + t0.split('\n')[0] + '\n') }, /twice/]
]
for (const [name, fn, why] of STRUCTURAL) {
  await t(`integrity: ${name} -> INIT_REFUSED, 0 requests, nothing claimed`, async () => { const fx = await stagingFixture({ ops: ALL_OPS }); fn(fx.dir); return refusedIntegrity(fx, why) })
}
await t('integrity: an OLD permit is invalid for changed code - refreshing the manifest after a change is refused by the permit binding (codeSums), still before any request or claim', async () => {
  const fx = await stagingFixture({ ops: ALL_OPS }); touch(fx.dir, 'recon-bootstrap.mjs'); writeSums(fx.dir)
  const r = await fx.core2.runRecon(fx.cfg())
  return r.status === 'INIT_REFUSED' && /^permit: permit is not bound to these bytes \(codeSums\)/.test(r.reason) && fx.rec.calls.length === 0 && !fs.existsSync(path.dirname(fx.evDir)) ? true : `${r.status} ${r.reason}`
})
await t('integrity: the structural pin checks stay independent of the manifest - tampered pin DATA with a refreshed manifest and a matching permit is still refused by the pins (not by integrity)', async () => {
  const fx = await stagingFixture(); const f = path.join(fx.dir, 'frontend-allowlist.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.host = 'app.aktivmetr.ru'; fs.writeFileSync(f, JSON.stringify(j))
  writeSums(fx.dir)
  const h = fx.core2.loadPins(fx.dir).hashes; fx.permit.bytes = { codeSums: h.codeSumsSha256, requestAllowlist: h.requestAllowlistSha256, frontendAllowlist: h.frontendAllowlistSha256, consumedSubjectPin: h.consumedSubjectPinSha256, expectedState: h.expectedStateSha256, distManifest: h.distManifestSha256 }
  const r = await fx.core2.runRecon(fx.cfg())
  return r.status === 'INIT_REFUSED' && /^pins: frontend allowlist/.test(r.reason) && fx.rec.calls.length === 0 && !fs.existsSync(path.dirname(fx.evDir)) ? true : `${r.status} ${r.reason}`
})
await t('integrity: the selftest runs the same check - a changed helper makes SELFTEST fail with its path, an unchanged copy passes', async () => {
  const fx = await stagingFixture({ realPins: true }); const s0 = (await imp2(fx.dir, 'recon.mjs')).selftest(fx.dir)
  touch(fx.dir, 'recon-bootstrap.mjs'); const s1 = (await imp2(fx.dir, 'recon.mjs')).selftest(fx.dir)
  return s0.ok && !s1.ok && s1.problems.includes('code hash recon-bootstrap.mjs') ? true : `${s0.ok} ${s1.problems}`
})
await t('integrity (unit): relative imports must be listed, only node: builtins may be imported, comments and method calls such as Buffer.from(\'x\') are not imports, a required file may not be absent from both disk and manifest', async () => {
  const unit = async edit => { const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-int-')); fixtures.push(parent); const d = path.join(parent, 'pkg'); relocatedCopy(PKG, d); edit(d); writeSums(d); return integrityMod.integrityProblems(d) }
  const add = (rel, text) => d => fs.appendFileSync(path.join(d, rel), text)
  const clean = await unit(() => {})
  const ghost = await unit(add('recon-permit.mjs', "\nimport './ghost.mjs'\n"))
  const dyn = await unit(add('recon-permit.mjs', "\nconst z = await import('./ghost2.mjs')\n"))
  const req = await unit(add('offline-fence/loopback-only.cjs', "\nrequire('./ghost3.cjs')\n"))
  const third = await unit(add('recon-permit.mjs', "\nimport lodash from 'lodash'\n"))
  const reexp = await unit(add('recon-permit.mjs', "\nexport * from './ghost4.mjs'\n"))
  const comment = await unit(add('recon-permit.mjs', "\n// import './ghost5.mjs'\nconst b = Buffer.from('x')\n"))
  const noReq = await unit(d => fs.rmSync(path.join(d, 'recon-bootstrap.mjs')))
  return clean.length === 0 && ghost.some(p => /dependency not listed: ghost\.mjs/.test(p)) && dyn.some(p => /dependency not listed: ghost2\.mjs/.test(p)) && req.some(p => /dependency not listed: offline-fence\/ghost3\.cjs/.test(p)) &&
    third.some(p => /dependency outside the package in recon-permit\.mjs/.test(p)) && reexp.some(p => /dependency not listed: ghost4\.mjs/.test(p)) && comment.length === 0 && noReq.some(p => /required file not listed: recon-bootstrap\.mjs/.test(p)) ? true :
    JSON.stringify({ clean, ghost, dyn, req, third, reexp, comment, noReq })
})
await t('integrity (CLI path, fenced): `recon.mjs execute` with a valid permit refuses a changed helper with exit 3 and reason integrity - the fence sees 0 events, nothing is claimed; the unchanged copy passes integrity and permit and its first request is stopped by the fence', async () => {
  const run = (fx, log) => spawnSync(process.execPath, ['--require', path.join(fx.dir, 'offline-fence', 'loopback-only.cjs'), path.join(fx.dir, 'recon.mjs'), 'execute', '--permit', fx.permitFile],
    { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, XDG_CONFIG_HOME: emptyProfile, M1_FENCE_LOG: log }, encoding: 'utf8', windowsHide: true, timeout: 60000 })
  const bad = await stagingFixture({ ops: ALL_OPS, realClock: true }); touch(bad.dir, 'recon-bootstrap.mjs')
  const logBad = path.join(bad.parent, 'fence.jsonl'); fs.writeFileSync(logBad, '')
  const rb = run(bad, logBad)
  const ok = await stagingFixture({ realClock: true }); const logOk = path.join(ok.parent, 'fence.jsonl'); fs.writeFileSync(logOk, '')
  const ro = run(ok, logOk)
  const evOk = fs.readFileSync(logOk, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const stopped = rb.status === 3 && /INIT_REFUSED reason=integrity: code hash recon-bootstrap\.mjs/.test(rb.stdout) && fs.readFileSync(logBad, 'utf8') === '' && !fs.existsSync(path.dirname(bad.evDir))
  const passed = ro.status === 2 && /STOP branch=frontend code=network-unknown/.test(ro.stdout) && evOk.length >= 1 && evOk.every(e => e.decision === 'blocked' && e.host === RECON.stageHost) && fs.existsSync(path.join(ok.evDir, 'recon-claim.json'))
  return stopped && passed ? true : `stopped=${stopped} passed=${passed} ok=${ro.status} ${ro.stdout.slice(0, 100)} ${ro.stderr.slice(0, 100)} fence=${JSON.stringify(evOk.slice(0, 2))} bad=${rb.status}`
})
await t('integrity (offline launcher): plan / permit-draft / selftest of a package with a changed helper are refused (exit 3 / selftest fail) with 0 network events - the printed bindings are only meaningful for unchanged bytes', async () => {
  const fx = await stagingFixture(); touch(fx.dir, 'recon-bootstrap.mjs')
  const parent = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }
  const run = cmd => spawnSync(process.execPath, [path.join(fx.dir, 'recon-offline.mjs'), cmd], { env: parent, encoding: 'utf8', windowsHide: true })
  const [p, d, s] = ['plan', 'permit-draft', 'selftest'].map(run)
  const ev = r => Number((r.stderr.match(/fenceEvents=(\d+)/) ?? [])[1])
  return p.status === 3 && d.status === 3 && /integrity/.test(p.stdout) && /integrity/.test(d.stdout) && s.status === 2 && /SELFTEST_FAIL/.test(s.stdout) && ev(p) === 0 && ev(d) === 0 && ev(s) === 0 ? true : `${p.status} ${d.status} ${s.status} ${p.stdout.slice(0, 100)}`
})
await t('namespace gate itself: every consumed / reserved evidence name is refused in EVERY profile (the rehearsal profile reaches the gate without the pinned-name check in front of it), and the pinned name is not among them', async () => {
  const gate = RECON.consumedNames.filter(n => !namespaceProblems({ profile: 'rehearsal', evidenceDir: RECON.rehearsalBase + n, exists: () => false }).some(p => /consumed or reserved/.test(p)))
  const viaRun = []
  for (const n of ['m1-stg-s1b-714d0f91', 'm1-staging-run-714d0f91-v5']) {
    const { cfg, calls } = rehearsalCfg(makeWorld()); cfg.evDir = path.join(RECON.rehearsalBase, n)
    const r = await runRecon(cfg); viaRun.push(r.status === 'INIT_REFUSED' && /consumed or reserved/.test(r.reason) && calls.length === 0 && !fs.existsSync(cfg.evDir))
  }
  return gate.length === 0 && viaRun.every(Boolean) && !RECON.consumedNames.includes(RECON.evidenceName) ? true : `gate=${gate} viaRun=${viaRun}`
})

// ── the deadline BETWEEN actions and at COMPLETION (corrections V2, CR3 follow-up) ───────────────────────────────────────────────────────
// The injected clock is advanced from INSIDE the real ledger / checkpoint writes (fs.writeSync / fs.writeFileSync are wrapped for the duration of one reading), so that the budget runs out
// exactly in the transition between two actions. Reads of the cached login and of the consumed journal are counted by a wrapper of fs.readFileSync. No sleep, no socket.
async function observed({ onWrite = () => {}, readMatch = () => false }, fn) {
  const w = fs.writeSync, wf = fs.writeFileSync, rf = fs.readFileSync
  const reads = []
  fs.writeSync = function (fd, data, ...a) { const r = w.call(this, fd, data, ...a); onWrite({ kind: 'ledger', text: String(data) }); return r }
  fs.writeFileSync = function (file, data, ...a) { const r = wf.call(this, file, data, ...a); onWrite({ kind: 'file', file: String(file), text: String(data) }); return r }
  fs.readFileSync = function (p, ...a) { if (readMatch(String(p))) reads.push(String(p)); return rf.call(this, p, ...a) }
  try { return { value: await fn(), reads } } finally { fs.writeSync = w; fs.writeFileSync = wf; fs.readFileSync = rf }
}
const isLedger = phase => e => e.kind === 'ledger' && new RegExp(`"phase":"${phase}"`).test(e.text)
const isCheckpoint = re => e => e.kind === 'file' && /recon-state\.json\.tmp$/.test(e.file) && re.test(e.text)
const AFTER_FRONTEND = [['the BRANCH_DONE ledger write of the frontend', e => isLedger('BRANCH_DONE')(e) && /"frontend"/.test(e.text)], ['the checkpoint write after the frontend', isCheckpoint(/"frontend"/)]]
const evEvents = cfg => ledgerOf(path.join(cfg.evDir, 'recon-ledger.jsonl'))
await t('deadline (between actions): the budget runs out DURING the ledger / checkpoint write after the frontend - exhausted by 1 ms or exactly 0 left: the cached-login read does not start (0 bootstrap), no further request, STOP credential/deadline', async () => {
  const bad = []
  for (const [where, trigger] of AFTER_FRONTEND) for (const lead of [DL + 1, DL]) {
    const st = { clock: T0 }; let fired = false
    const { cfg, calls, bootstrapCalls } = rehearsalCfg(makeWorld(), { extra: { now: () => st.clock } })
    const { value: r } = await observed({ onWrite: e => { if (!fired && trigger(e)) { fired = true; st.clock = T0 + lead } } }, () => runRecon(cfg))
    const ev = evEvents(cfg)
    if (!(fired && r.exitCode === 2 && r.stop?.branch === 'credential' && r.stop.code === 'deadline' && calls.length === 17 && bootstrapCalls.length === 0 && !ev.some(e => e.phase === 'CREDENTIAL_CONFIG_READ') && ev.some(e => e.phase === 'STOP' && e.branch === 'credential'))) bad.push(`${where}/${lead - DL}: ${r.status} ${JSON.stringify(r.stop)} calls=${calls.length} boot=${bootstrapCalls.length}`)
  }
  return bad.length === 0 ? true : bad.join(' | ')
})
await t('deadline (between actions, positive): with 1 ms of budget left after the same write the reading continues and completes (bootstrap once, all 22 requests, exit 0)', async () => {
  const st = { clock: T0 }; let fired = false
  const { cfg, calls, bootstrapCalls } = rehearsalCfg(makeWorld(), { extra: { now: () => st.clock } })
  const { value: r } = await observed({ onWrite: e => { if (!fired && AFTER_FRONTEND[1][1](e)) { fired = true; st.clock = T0 + DL - 1 } } }, () => runRecon(cfg))
  return fired && r.exitCode === 0 && calls.length === 22 && bootstrapCalls.length === 1 ? true : `${r.status} ${JSON.stringify(r.stop)} calls=${calls.length}`
})
await t('deadline (between actions): the budget runs out DURING the write after the cached-login read - the consumed journal is NOT read, no Auth request, STOP auth/deadline (and 1 ms of budget left reads it once)', async () => {
  const ops = { credentialConfigRead: true, functionsMetadataRead: false, rulesReleaseRead: false, frontendPublicRead: false, authExactLookup: true }
  const triggers = [['the CREDENTIAL_CONFIG_READ ledger write', isLedger('CREDENTIAL_CONFIG_READ')], ['the checkpoint write after the cached-login read', isCheckpoint(/"configReads": 1/)]]
  const bad = []
  for (const [where, trigger] of triggers) for (const [lead, expectRead] of [[DL + 1, false], [DL, false], [DL - 1, true]]) {
    const st = { clock: T0 }; let fired = false
    const { cfg, calls, journalPath } = rehearsalCfg(makeWorld(), { ops, extra: { now: () => st.clock } })
    const { value: r, reads } = await observed({ onWrite: e => { if (!fired && trigger(e)) { fired = true; st.clock = T0 + lead } }, readMatch: p => p === journalPath }, () => runRecon(cfg))
    const okRun = expectRead ? r.exitCode === 0 && calls.length === 1 : r.exitCode === 2 && r.stop?.branch === 'auth' && r.stop.code === 'deadline' && calls.length === 0
    if (!(fired && okRun && reads.length === (expectRead ? 1 : 0))) bad.push(`${where}/${lead - DL}: ${r.status} ${JSON.stringify(r.stop)} calls=${calls.length} journalReads=${reads.length}`)
  }
  return bad.length === 0 ? true : bad.join(' | ')
})
await t('deadline (between actions, staging profile): the auditor counterexample - the checkpoint after the frontend moves the clock to DL+1 - the cached login file is read 0 times (1 time with budget left), only the 17 frontend requests were sent', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-login-')); fixtures.push(profile)
  fs.mkdirSync(path.join(profile, 'configstore'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'configstore', 'firebase-tools.json'), JSON.stringify({ tokens: { access_token: SYNTH_TOKEN, refresh_token: '1//SYNTHETIC-NOT-A-SECRET-0123456789', expires_at: NOW + 3600000 } }))
  const ops = { credentialConfigRead: true, functionsMetadataRead: true, rulesReleaseRead: false, frontendPublicRead: true, authExactLookup: false }
  const outcome = async lead => {
    const fx = await stagingFixture({ ops }); const st = { clock: NOW }; let fired = false
    const { value: r, reads } = await observed({ onWrite: e => { if (!fired && isCheckpoint(/"frontend"/)(e)) { fired = true; st.clock = NOW + lead } }, readMatch: p => p.endsWith('firebase-tools.json') },
      () => fx.core2.runRecon(fx.cfg({ env: { XDG_CONFIG_HOME: profile }, now: () => st.clock })))
    return { r, reads: reads.length, calls: fx.rec.calls.length, fired }
  }
  const late = await outcome(DL + 1), ok = await outcome(DL - 1)
  return late.fired && late.r.exitCode === 2 && late.r.stop?.branch === 'credential' && late.r.stop.code === 'deadline' && late.reads === 0 && late.calls === 17 && ok.reads === 1 && ok.calls > 17 && ok.r.exitCode !== 3 ? true :
    `late: ${late.r.status} ${JSON.stringify(late.r.stop)} reads=${late.reads} calls=${late.calls}; ok: reads=${ok.reads} calls=${ok.calls}`
})
await t('deadline (completion instant): verdict, finishedAtUtc, the final ledger events and the exit code come from ONE instant - for completion at DL-2 ... DL+2 (a clock that keeps ticking after the last checkpoint): <= DL is a success, > DL is STOP deadline, never a late finishedAt with exit 0', async () => {
  const bad = []
  for (const off of [-2, -1, 0, 1, 2]) {
    let boundary = false, ticks = 0; const frontendOnly = { credentialConfigRead: false, functionsMetadataRead: false, rulesReleaseRead: false, frontendPublicRead: true, authExactLookup: false }
    const now = () => (boundary ? T0 + DL + off + ticks++ : T0)
    const { cfg } = rehearsalCfg(makeWorld(), { ops: frontendOnly, extra: { now } })
    const { value: r } = await observed({ onWrite: e => { if (!boundary && isCheckpoint(/"frontend"/)(e)) boundary = true } }, () => runRecon(cfg))
    const res = JSON.parse(fs.readFileSync(path.join(cfg.evDir, 'recon-result.json'), 'utf8')), ev = evEvents(cfg)
    const elapsed = Date.parse(res.finishedAtUtc) - T0, late = off > 0
    const finalEvents = ev.filter(e => (e.phase === 'RESULT' && typeof e.status === 'string') || (e.phase === 'STOP' && e.branch === 'run'))
    const consistent = late ? r.exitCode === 2 && res.status === 'STOP' && res.stop?.branch === 'run' && res.stop.code === 'deadline' && elapsed === DL + off && finalEvents.some(e => e.phase === 'STOP') : r.exitCode === 0 && res.status === 'READ_COMPLETE_ALL_MATCH_PINS' && elapsed === DL + off
    if (!(consistent && r.status === res.status && finalEvents.every(e => e.at === res.finishedAtUtc))) bad.push(`off=${off}: exit=${r.exitCode} status=${res.status} elapsed=${elapsed} events=${finalEvents.map(e => `${e.phase}@${Date.parse(e.at) - T0}`)}`)
  }
  return bad.length === 0 ? true : bad.join(' | ')
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

for (const p of fixtures) fs.rmSync(p, { recursive: true, force: true })
fs.rmSync(emptyProfile, { recursive: true, force: true })
console.log(`RECON_NEGATIVE_CONTROLS ${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail}${fail ? ` failed=${failures.join(' | ')}` : ''}`)
process.exitCode = fail ? 1 : 0
