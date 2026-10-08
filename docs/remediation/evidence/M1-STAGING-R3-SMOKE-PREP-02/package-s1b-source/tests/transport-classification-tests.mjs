// M1-SAFE-STOP-RECOVERY-01 - regression tests for the transport failure classification of the smoke runner (offline, loopback only).
// The consumed R3 run stopped with `transport: network failure POST accounts` after 10.7 s: the runner threw away the error class, so nothing in
// the durable evidence could tell a connection that never opened (no request bytes can have been sent) from a failure after the request left.
//   node tests/transport-classification-tests.mjs                              (against this package)
//   M1_PKG_UNDER_TEST=<other package dir> node tests/transport-classification-tests.mjs   (the same assertions against the OLD package: they must FAIL there)
// No cloud, no firebase-tools, no credentials: the emulator target is used with a local fake server (real Node fetch error shapes) and injected errors.
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = process.env.M1_PKG_UNDER_TEST ? path.resolve(process.env.M1_PKG_UNDER_TEST) : path.resolve(HERE, '..')
const load = f => import(pathToFileURL(path.join(PKG, f)).href)
const transportMod = await load('m1-transport.mjs')
const core = await load('m1-core.mjs')
const { makeTransport } = transportMod
const results = []
const record = (name, pass, detail) => { results.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); if (!pass && detail !== undefined) console.log('     detail: ' + JSON.stringify(detail).slice(0, 400)) }
const USER = { email: 'm1-00000000-admin@example.invalid', password: 'synthetic-not-a-secret', name: 'M1 smoke admin 00000000' }

function target(port) {
  return { ...core.TARGETS.emulator, auth: `http://127.0.0.1:${port}/identitytoolkit.googleapis.com`, firestore: `http://127.0.0.1:${port}` }
}
async function attempt(fetchImpl, { port = 9, opts = {} } = {}) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (...a) => { calls++; return fetchImpl(...a) }
  const counters = { requests: 0, authCreates: 0, authDeletes: 0, operatorCommits: 0, invitationCallsRefused: 0, callables: {} }
  try {
    const t = await makeTransport(target(port), { counters, webConfig: null, ...opts })
    try { await t.createAuthUser(USER); return { calls, counters, stop: null } } catch (e) { return { calls, counters, stop: e } }
  } finally { globalThis.fetch = original }
}
const err = (code, { syscall, name } = {}) => Object.assign(new Error(`injected ${code} for identitytoolkit.googleapis.com Bearer ya29.SECRET-TOKEN m1-00000000-admin@example.invalid`), { code, ...(syscall ? { syscall } : {}), ...(name ? { name } : {}) })
const fetchFailed = cause => Object.assign(new TypeError('fetch failed'), { cause })

// ── injected provider-contract shapes (Node/undici) ──────────────────────────
const shapes = [
  ['connect timeout (undici, the 10 s connect timer)', fetchFailed(err('UND_ERR_CONNECT_TIMEOUT', { name: 'ConnectTimeoutError' })), 'connect-timeout', 'not-dispatched'],
  ['connection refused', fetchFailed(err('ECONNREFUSED', { syscall: 'connect' })), 'connection-refused', 'not-dispatched'],
  ['DNS name not found', fetchFailed(err('ENOTFOUND', { syscall: 'getaddrinfo' })), 'dns', 'not-dispatched'],
  ['DNS temporary failure', fetchFailed(err('EAI_AGAIN', { syscall: 'getaddrinfo' })), 'dns', 'not-dispatched'],
  ['network unreachable', fetchFailed(err('ENETUNREACH', { syscall: 'connect' })), 'network-unreachable', 'not-dispatched'],
  ['host unreachable', fetchFailed(err('EHOSTUNREACH', { syscall: 'connect' })), 'network-unreachable', 'not-dispatched'],
  ['TLS certificate verification failed', fetchFailed(err('UNABLE_TO_VERIFY_LEAF_SIGNATURE')), 'tls-verify', 'not-dispatched'],
  ['dual-stack AggregateError, every attempt failed in connect()', fetchFailed(Object.assign(new AggregateError([err('ETIMEDOUT', { syscall: 'connect' }), err('ENETUNREACH', { syscall: 'connect' })], 'agg'), { code: 'ETIMEDOUT' })), 'connect-timeout', 'not-dispatched'],
  // everything below may have happened AFTER the request left the process: unknown outcome, fail closed
  ['connection reset while reading the answer', fetchFailed(err('ECONNRESET', { syscall: 'read' })), 'connection-reset', 'unknown'],
  ['socket closed by the peer (undici)', fetchFailed(err('UND_ERR_SOCKET')), 'socket-closed', 'unknown'],
  ['response headers timeout (undici)', fetchFailed(err('UND_ERR_HEADERS_TIMEOUT')), 'response-timeout', 'unknown'],
  ['response body timeout (undici)', fetchFailed(err('UND_ERR_BODY_TIMEOUT')), 'response-timeout', 'unknown'],
  ['the runner own 30 s abort (TimeoutError)', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'abort-timeout', 'unknown'],
  ['ETIMEDOUT outside connect() (a read)', fetchFailed(err('ETIMEDOUT', { syscall: 'read' })), 'other', 'unknown'],
  ['ECONNREFUSED without syscall (cannot prove connect phase)', fetchFailed(err('ECONNREFUSED')), 'other', 'unknown'],
  ['AggregateError where ONE attempt failed after connect', fetchFailed(Object.assign(new AggregateError([err('ETIMEDOUT', { syscall: 'connect' }), err('ECONNRESET', { syscall: 'read' })], 'agg'), { code: 'ETIMEDOUT' })), 'other', 'unknown'],
  ['plain fetch failed without a cause', new TypeError('fetch failed'), 'other', 'unknown'],
  ['an unknown non-Error value', 'boom', 'other', 'unknown'],
]
for (const [label, error, code, dispatch] of shapes) {
  const t0 = Date.now()
  const r = await attempt(async () => { throw error })
  const s = r.stop
  const ok = s?.kind === (dispatch === 'not-dispatched' ? 'transport-not-dispatched' : 'transport') && s?.reasonCode === code && s?.dispatch === dispatch && Number.isFinite(s?.elapsedMs) && s.elapsedMs >= 0 && s.elapsedMs < 5000
  record(`classification: ${label} -> ${code}, dispatch ${dispatch}`, ok, { kind: s?.kind, reasonCode: s?.reasonCode, dispatch: s?.dispatch, elapsedMs: s?.elapsedMs, took: Date.now() - t0 })
}

// ── the reason text stays the one the orchestrator and the old evidence use; nothing private leaks ──
{
  const r = await attempt(async () => { throw fetchFailed(err('UND_ERR_CONNECT_TIMEOUT')) })
  const dump = JSON.stringify({ message: r.stop?.message, reason: r.stop?.reason, kind: r.stop?.kind, reasonCode: r.stop?.reasonCode, dispatch: r.stop?.dispatch, elapsedMs: r.stop?.elapsedMs })
  record('sanitizer: the STOP reason keeps the fixed text `network failure POST accounts` (old evidence and the orchestrator patterns stay valid)', r.stop?.reason === 'network failure POST accounts' && /^transport: network failure POST accounts$/.test(r.stop?.message ?? ''), dump)
  record('sanitizer: no URL, host, e-mail, token or raw error text from the underlying error reaches the STOP (only fixed codes)', !/SECRET|ya29|Bearer|identitytoolkit|googleapis|@example|http|127\.0\.0\.1/.test(dump), dump)
  record('sanitizer: reasonCode and dispatch come from closed sets', ['connect-timeout', 'connection-refused', 'dns', 'network-unreachable', 'tls-verify', 'connection-reset', 'socket-closed', 'response-timeout', 'abort-timeout', 'other'].includes(r.stop?.reasonCode) && ['not-dispatched', 'unknown'].includes(r.stop?.dispatch))
}

// ── no retry: one failed request is exactly one fetch call ──
{
  const r = await attempt(async () => { throw fetchFailed(err('UND_ERR_CONNECT_TIMEOUT')) })
  record('no retry: a pre-dispatch failure is reported once - the fetch was called exactly once and requests=1, authCreates=0', r.calls === 1 && r.counters.requests === 1 && r.counters.authCreates === 0, { calls: r.calls, counters: r.counters })
}

// ── real Node fetch against a local fake server: the shapes that matter, not only invented ones ──
{
  // (1) closed loopback port: a real ECONNREFUSED from connect()
  const closed = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
  const refused = await attempt(globalThis.fetch.bind(globalThis), { port: closed })
  record('real fetch: a closed loopback port (real ECONNREFUSED) is a proven pre-dispatch failure and nothing reached any server', refused.stop?.kind === 'transport-not-dispatched' && refused.stop?.reasonCode === 'connection-refused' && refused.stop?.dispatch === 'not-dispatched', { kind: refused.stop?.kind, code: refused.stop?.reasonCode })

  // (2) the server READS the request and then kills the socket: the request was delivered, the outcome is unknown
  let seen = 0
  const resetServer = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { seen++; req.socket.destroy() }) })
  await new Promise(r => resetServer.listen(0, '127.0.0.1', r))
  const reset = await attempt(globalThis.fetch.bind(globalThis), { port: resetServer.address().port })
  record('real fetch: a server that received the request and then reset the connection is NOT pre-dispatch (the request was delivered) -> kind transport, dispatch unknown', seen === 1 && reset.stop?.kind === 'transport' && reset.stop?.dispatch === 'unknown', { seen, kind: reset.stop?.kind, code: reset.stop?.reasonCode })
  resetServer.close()

  // (3) a server that accepts and never answers, with the runner's own timeout shortened for the test
  let hang = 0
  const hangServer = http.createServer((req) => { hang++; req.on('data', () => {}) })
  await new Promise(r => hangServer.listen(0, '127.0.0.1', r))
  const t0 = Date.now()
  const slow = await attempt(globalThis.fetch.bind(globalThis), { port: hangServer.address().port, opts: { requestTimeoutMs: 400 } })
  record('real fetch: an answer that never comes ends at the request timeout (TimeoutError) -> dispatch unknown, elapsed recorded, one request seen by the server', hang === 1 && slow.stop?.kind === 'transport' && slow.stop?.reasonCode === 'abort-timeout' && slow.stop?.dispatch === 'unknown' && slow.stop.elapsedMs >= 300 && Date.now() - t0 < 5000, { hang, code: slow.stop?.reasonCode, elapsed: slow.stop?.elapsedMs })
  hangServer.closeAllConnections?.(); hangServer.close()
}

// ── API contract used by the runner ──
{
  record('contract: the classifier is exported as a pure function and refuses to promote an unknown error to pre-dispatch', typeof transportMod.classifyFetchError === 'function' && transportMod.classifyFetchError(new Error('anything')).dispatch === 'unknown' && transportMod.classifyFetchError(undefined).dispatch === 'unknown' && transportMod.classifyFetchError(null).dispatch === 'unknown')
  const src = fs.readFileSync(path.join(PKG, 'm1-transport.mjs'), 'utf8').replace(/\/\/.*$/gm, '')
  record('contract: the transport still has no retry loop and no second fetch call (code only, comments ignored)', (src.match(/\bfetch\(/g) ?? []).length === 1 && !/retry|attempts|for \(let attempt/i.test(src))
}

const failed = results.filter(r => !r.pass).length
const out = path.join(HERE, '..', 'results')
if (!process.env.M1_PKG_UNDER_TEST) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'transport-classification-tests.json'), `${JSON.stringify({ total: results.length, failed, results, at: new Date().toISOString() }, null, 2)}\n`) }
console.log(`TRANSPORT_CLASSIFICATION_TESTS ${failed ? 'FAIL' : 'PASS'} ${results.length - failed}/${results.length}${process.env.M1_PKG_UNDER_TEST ? ` (package under test: ${PKG})` : ''}`)
process.exitCode = failed ? 1 : 0
