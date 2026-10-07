// Local stand-in for m1-readiness.mjs. It runs the REAL polling and classification code
// (m1-readiness-lib.mjs) under the no-network preload; only the wire call is simulated from the
// scenario and the clock is fake, so rehearsals are instant and deterministic.
//   --target emulator --expected-head <sha> --out-dir <new abs dir> --deadline-ms <n> --interval-ms <n> --request-timeout-ms <n>
// Scenario key `readiness`: { kind, functions?, readyAfterRound? }
//   kind: ready (default) | platform-401 | platform-403 | html | http-204 | http-200 | http-500 |
//         malformed-json | wrong-app-code | wrong-status | timeout | network
//   functions: which callables get `kind` (default: all five); the others answer as ready.
//   readyAfterRound: the listed callables become ready after that many rounds (IAM propagation).
import { assertPreloaded, scenario, claim, refuse, H } from './stub-lib.mjs'
import { M1_CALLABLES } from '../m1-core.mjs'
import { openEvidence, runReadiness, writeResult } from '../m1-readiness-lib.mjs'

assertPreloaded()
const args = process.argv.slice(2)
const o = {}
for (let i = 0; i < args.length; i += 2) o[args[i]] = args[i + 1]
const KEYS = ['--target', '--expected-head', '--out-dir', '--deadline-ms', '--interval-ms', '--request-timeout-ms']
if (args.length !== KEYS.length * 2 || !KEYS.every(k => Object.hasOwn(o, k)) || o['--target'] !== 'emulator' || o['--expected-head'] !== H || !/^[1-9]\d*$/.test(o['--deadline-ms'] + o['--interval-ms'] + o['--request-timeout-ms'])) refuse(`readiness arguments: ${JSON.stringify(args)}`)
claim('readiness', 1)

const sc = scenario().readiness ?? {}
const kind = sc.kind ?? 'ready'
const bad = new Set(sc.functions ?? M1_CALLABLES)
const APP = JSON.stringify({ error: { details: { appCode: 'auth_required' }, message: 'auth_required', status: 'UNAUTHENTICATED' } })
const responses = {
  ready: { httpStatus: 401, contentType: 'application/json; charset=utf-8', bodyText: APP },
  'platform-401': { httpStatus: 401, contentType: 'text/html; charset=UTF-8', bodyText: '<html><body>The request was not authorized to invoke this service.</body></html>' },
  'platform-403': { httpStatus: 403, contentType: 'text/html; charset=UTF-8', bodyText: '<html><body>Forbidden</body></html>' },
  html: { httpStatus: 401, contentType: 'text/html', bodyText: APP },
  'http-204': { httpStatus: 204, contentType: 'text/html', bodyText: '' },
  'http-200': { httpStatus: 200, contentType: 'application/json', bodyText: '{"result":{}}' },
  'http-500': { httpStatus: 500, contentType: 'application/json', bodyText: '{"error":{"status":"INTERNAL"}}' },
  'malformed-json': { httpStatus: 401, contentType: 'application/json', bodyText: '{"error":{"status":"UNAUTHENTI' },
  'wrong-app-code': { httpStatus: 401, contentType: 'application/json', bodyText: JSON.stringify({ error: { details: { appCode: 'membership_not_found' }, status: 'UNAUTHENTICATED' } }) },
  'wrong-status': { httpStatus: 401, contentType: 'application/json', bodyText: JSON.stringify({ error: { details: { appCode: 'auth_required' }, status: 'PERMISSION_DENIED' } }) },
  timeout: { error: 'timeout' },
  network: { error: 'network' },
}
if (!Object.hasOwn(responses, kind)) refuse(`unknown readiness scenario ${kind}`)

let clock = Date.parse('2026-09-20T00:00:00.000Z')
const roundOf = new Map()
const probe = fn => {
  const round = (roundOf.get(fn) ?? 0) + 1
  roundOf.set(fn, round)
  const late = sc.readyAfterRound !== undefined && round > sc.readyAfterRound
  const key = bad.has(fn) && !late ? kind : 'ready'
  clock += key === 'timeout' ? Number(o['--request-timeout-ms']) : 200
  return Promise.resolve(responses[key])
}
const evidence = openEvidence(o['--out-dir'])
const result = await runReadiness({
  functions: M1_CALLABLES, probe, deadlineMs: Number(o['--deadline-ms']), intervalMs: Number(o['--interval-ms']),
  now: () => clock, sleep: ms => { clock += ms; return Promise.resolve() }, onAttempt: r => evidence.append(r),
})
evidence.close()
writeResult(evidence.result, { target: 'emulator', result })
console.log(`M1_READINESS_${result.status} functions=5 rounds=${result.rounds} (stub)`)
process.exitCode = result.status === 'READY' ? 0 : 2
