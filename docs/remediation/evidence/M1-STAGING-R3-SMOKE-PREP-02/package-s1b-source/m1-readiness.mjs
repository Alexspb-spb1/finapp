#!/usr/bin/env node
// FINAPP-1.0-M1 R3 (unchanged from rev8) - readiness gate CLI for the five M1 callables.
//
//   node m1-readiness.mjs --target <staging|emulator> --expected-head <sha> --out-dir <new abs dir>
//        [emulator only: --base-url <http://127.0.0.1:port/path> --deadline-ms <n> --interval-ms <n> --request-timeout-ms <n>]
//
// Sends ONE unauthenticated callable-shaped POST per function per round (no token, no query, no
// identifiers) and applies m1-readiness-lib.mjs. Only the enumerated verdict and the HTTP status
// number are recorded: never a header, a body or a URL query. For the staging target the endpoint
// and the limits (300 s deadline, 5 s interval, 15 s per request) are fixed and cannot be
// overridden. Exit 0 = READY (all five functions ready in the same round); 2 = NOT_READY or refusal.
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EXPECTED_HEAD, REPO, TARGETS, M1_CALLABLES, guardRun } from './m1-core.mjs'
import { CALLABLE_BODY, MAX_BODY_CHARS, STAGING_LIMITS, openEvidence, runReadiness, writeResult } from './m1-readiness-lib.mjs'

const OPTIONAL = ['--base-url', '--deadline-ms', '--interval-ms', '--request-timeout-ms']
const EMULATOR_DEFAULTS = Object.freeze({ deadlineMs: 60000, intervalMs: 1000, requestTimeoutMs: 10000 })

export function parseArgs(argv) {
  if (argv.length % 2) throw new Error('usage')
  const o = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--target', '--expected-head', '--out-dir', ...OPTIONAL].includes(argv[i]) || Object.hasOwn(o, argv[i]) || argv[i + 1] === undefined) throw new Error('usage')
    o[argv[i]] = argv[i + 1]
  }
  if (!['staging', 'emulator'].includes(o['--target']) || !Object.hasOwn(o, '--expected-head') || !Object.hasOwn(o, '--out-dir')) throw new Error('usage')
  const extras = OPTIONAL.filter(k => Object.hasOwn(o, k))
  if (o['--target'] === 'staging' && extras.length) throw new Error('staging endpoint and limits are fixed')
  const int = k => { if (!Object.hasOwn(o, k)) return undefined; if (!/^[1-9]\d{0,6}$/.test(o[k])) throw new Error(`${k} must be a positive integer`); return Number(o[k]) }
  const limits = o['--target'] === 'staging' ? { ...STAGING_LIMITS } : {
    deadlineMs: int('--deadline-ms') ?? EMULATOR_DEFAULTS.deadlineMs,
    intervalMs: int('--interval-ms') ?? EMULATOR_DEFAULTS.intervalMs,
    requestTimeoutMs: int('--request-timeout-ms') ?? EMULATOR_DEFAULTS.requestTimeoutMs,
  }
  let baseUrl = TARGETS[o['--target']].functions
  if (Object.hasOwn(o, '--base-url')) {
    const u = new URL(o['--base-url'])
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || u.search || u.hash || u.username || u.password) throw new Error('--base-url must be a plain loopback http URL')
    baseUrl = `${u.origin}${u.pathname.replace(/\/$/, '')}`
  }
  return { target: o['--target'], expectedHead: o['--expected-head'], outDir: o['--out-dir'], limits, baseUrl }
}

/** Real transport: one POST, redirects refused, hard per-request timeout. Returns a probe object. */
export function makeProbe(baseUrl, requestTimeoutMs, fetchImpl = globalThis.fetch) {
  return async fn => {
    try {
      const res = await fetchImpl(`${baseUrl}/${fn}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: CALLABLE_BODY,
        redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
      })
      const text = await res.text()
      return { httpStatus: res.status, contentType: res.headers.get('content-type') ?? '', bodyText: text.slice(0, MAX_BODY_CHARS + 1) }
    } catch (e) {
      return { error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network' }
    }
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
if (isMain) {
  let evidence = null
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.expectedHead !== EXPECTED_HEAD) throw new Error('expected head mismatch')
    if (Object.keys(process.env).some(k => k.toUpperCase().startsWith('M1_STUB_')) && opts.target === 'staging') throw new Error('stub environment present in staging profile')
    guardRun({ target: opts.target, expectedHead: opts.expectedHead })
    const rel = path.relative(fs.realpathSync(REPO), path.resolve(opts.outDir))
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('out-dir inside repository')
    evidence = openEvidence(opts.outDir)
    const result = await runReadiness({
      functions: M1_CALLABLES, probe: makeProbe(opts.baseUrl, opts.limits.requestTimeoutMs),
      deadlineMs: opts.limits.deadlineMs, intervalMs: opts.limits.intervalMs, onAttempt: r => evidence.append(r),
    })
    evidence.close(); evidence = null
    writeResult(path.join(opts.outDir, 'readiness-result.json'), { target: opts.target, result })
    console.log(`M1_READINESS_${result.status} functions=${M1_CALLABLES.length} rounds=${result.rounds} elapsedMs=${result.elapsedMs}${result.status === 'READY' ? '' : ` reason=${result.reason}`}`)
    process.exitCode = result.status === 'READY' ? 0 : 2
  } catch (e) {
    if (evidence) evidence.close()
    console.log(`M1_READINESS_STOP ${String(e?.message ?? 'error').slice(0, 160)}`)
    process.exitCode = 2
  }
}
