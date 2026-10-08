// FINAPP-1.0-M1 R3 (unchanged from rev8) - readiness gate for the five M1 callables: pure decision logic plus the
// evidence writer. It never touches the network itself (the transport is injected), so the stubs
// can run exactly this code under the no-network preload.
//
// Why it exists: in rev7 the first UI call to listCompanyMembers, made 51 s after Cloud Run wrote the
// public invoker IAM binding of the brand-new service, was answered by the PLATFORM (HTTP 401,
// "The access token could not be verified") and never reached the function code. A function is
// therefore "ready" only when an unauthenticated probe is answered by the APPLICATION layer:
//   HTTP 401 + JSON content type + callable envelope {"error":{"status":"UNAUTHENTICATED",
//   "details":{"appCode":"auth_required"}}}.
// Everything else - platform 401/403, HTML or text, 2xx/204, 5xx, malformed JSON, another status or
// appCode, timeout, network error - is NOT_READY. The gate is all-or-nothing: readiness requires
// all five functions to be ready in the SAME round.
import fs from 'node:fs'
import path from 'node:path'
import { M1_CALLABLES } from './m1-core.mjs'

export const READY_HTTP_STATUS = 401
export const READY_ERROR_STATUS = 'UNAUTHENTICATED'
export const READY_APP_CODE = 'auth_required'
/** A well-formed callable envelope with an empty payload; no token, no identifiers. */
export const CALLABLE_BODY = '{"data":{}}'
export const MAX_BODY_CHARS = 65536
/** Staging limits are fixed; the CLI refuses to override them for the staging target. */
export const STAGING_LIMITS = Object.freeze({ deadlineMs: 300000, intervalMs: 5000, requestTimeoutMs: 15000 })
export const VERDICTS = Object.freeze([
  'ready', 'http-2xx', 'http-5xx', 'platform-denied', 'not-json', 'oversized-body', 'malformed-json',
  'not-callable-envelope', 'unexpected-http', 'wrong-status', 'wrong-app-code', 'timeout', 'network-error',
])

const JSON_TYPE = /^application\/json\s*(;|$)/

/** Classifies ONE probe response. `probe` = { httpStatus, contentType, bodyText, error }. */
export function classifyProbe(probe) {
  const no = verdict => ({ ready: false, verdict })
  if (probe?.error) return no(probe.error === 'timeout' ? 'timeout' : 'network-error')
  const status = probe?.httpStatus
  if (!Number.isInteger(status)) return no('network-error')
  if (status >= 200 && status < 300) return no('http-2xx')
  if (status >= 500) return no('http-5xx')
  const type = String(probe.contentType ?? '').trim().toLowerCase()
  if (!JSON_TYPE.test(type)) return no(status === 401 || status === 403 ? 'platform-denied' : 'not-json')
  const text = typeof probe.bodyText === 'string' ? probe.bodyText : ''
  if (text.length > MAX_BODY_CHARS) return no('oversized-body')
  let body
  try { body = JSON.parse(text) } catch { return no('malformed-json') }
  const error = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.error : undefined
  if (error === null || typeof error !== 'object' || Array.isArray(error) || Object.hasOwn(body, 'result')) return no('not-callable-envelope')
  if (status !== READY_HTTP_STATUS) return no('unexpected-http')
  if (error.status !== READY_ERROR_STATUS) return no('wrong-status')
  const details = error.details
  if (details === null || typeof details !== 'object' || Array.isArray(details) || details.appCode !== READY_APP_CODE) return no('wrong-app-code')
  return { ready: true, verdict: 'ready' }
}

export function sameFunctionSet(functions) {
  return Array.isArray(functions) && functions.length === M1_CALLABLES.length &&
    JSON.stringify([...functions].sort()) === JSON.stringify([...M1_CALLABLES].sort())
}

/**
 * Bounded polling. Every round probes ALL functions; success needs all of them ready in the same
 * round. `probe(fn)` resolves to a probe object; `onAttempt` receives one sanitised record per
 * probe (enumerated fields only: no URL, header or body). No probe starts at or after the deadline.
 */
export async function runReadiness({ functions = M1_CALLABLES, probe, deadlineMs, intervalMs, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), onAttempt = () => {} }) {
  if (!sameFunctionSet(functions)) throw new Error('readiness must cover exactly the five M1 callables')
  if (![deadlineMs, intervalMs].every(v => Number.isFinite(v) && v > 0)) throw new Error('deadline and interval required')
  const started = now()
  const deadline = started + deadlineMs
  const perFunction = Object.fromEntries(functions.map(fn => [fn, { attempts: 0, ready: false, lastVerdict: null, lastHttpStatus: null }]))
  let round = 0
  const finish = (status, reason) => ({
    status, reason, rounds: round, elapsedMs: Math.max(0, now() - started), deadlineMs, intervalMs,
    functions: perFunction, allReadyInSameRound: status === 'READY',
  })
  for (;;) {
    round++
    let allReady = true
    for (const fn of functions) {
      if (now() >= deadline) return finish('NOT_READY', 'deadline reached before every function was probed')
      let raw
      try { raw = await probe(fn) } catch { raw = { error: 'network' } }
      const c = classifyProbe(raw)
      const entry = perFunction[fn]
      entry.attempts++
      entry.ready = c.ready
      entry.lastVerdict = c.verdict
      entry.lastHttpStatus = Number.isInteger(raw?.httpStatus) ? raw.httpStatus : null
      onAttempt({ at: new Date(now()).toISOString(), round, fn, ready: c.ready, verdict: c.verdict, httpStatus: entry.lastHttpStatus })
      if (!c.ready) allReady = false
    }
    if (allReady) return finish('READY', 'all five functions answered from the application layer in the same round')
    if (now() + intervalMs >= deadline) return finish('NOT_READY', 'deadline exhausted')
    await sleep(intervalMs)
  }
}

/** Creates `outDir` (must be new) with the attempts journal and the result. Returns the paths. */
export function openEvidence(outDir) {
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir) || fs.existsSync(outDir) || !fs.existsSync(path.dirname(outDir))) throw new Error('out-dir must be a new absolute path with an existing parent')
  fs.mkdirSync(outDir)
  const attempts = path.join(outDir, 'readiness-attempts.jsonl')
  const fd = fs.openSync(attempts, 'wx', 0o600)
  return {
    attempts,
    result: path.join(outDir, 'readiness-result.json'),
    append(record) { fs.writeSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd) },
    close() { fs.closeSync(fd) },
  }
}

export function writeResult(file, { target, result }) {
  const body = { format: 'finapp-m1-readiness-v1', target, ...result, at: new Date().toISOString() }
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return body
}
