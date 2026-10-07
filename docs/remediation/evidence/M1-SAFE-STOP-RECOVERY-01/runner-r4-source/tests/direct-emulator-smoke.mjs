// Direct (orchestrator-free) emulator chain of the REAL tools the R3 release uses:
//   readiness -> preflight -> seed -> ui -> api -> ui-r3 -> cleanup -> verify-clean
// against the local emulators only (demo-finapp). The Rules evidence handed to the cleanup gate is a SYNTHETIC copy of
// the stagingResources verify-current-rules journal shape (the gate only validates its shape and hash).
//   node tests/direct-emulator-smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const H = '714d0f91c60a582ee87dc7da82d6249b3106329f'
const NEW = 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd'
const base = path.join('D:\\projects\\finapp\\.runtime', `m1-r4-direct-${Date.now()}`)
fs.mkdirSync(base)
const runDir = path.join(base, 'run')
const evidence = path.join(base, 'rules-evidence.jsonl')
const now = new Date().toISOString()
fs.writeFileSync(evidence, `${JSON.stringify({ task: 'SEC-006 Stage 8', mode: 'verify-current-rules', project: 'finapp-staging', sourceHead: H, startedAt: now, canonicalSha256: NEW, status: 'CURRENT_RULES_HASH_VERIFIED', finishedAt: now })}\n`)
const steps = [
  ['readiness', 'm1-readiness.mjs', ['--target', 'emulator', '--expected-head', H, '--out-dir', path.join(base, 'readiness'), '--deadline-ms', '30000', '--interval-ms', '500', '--request-timeout-ms', '5000']],
  ['preflight', 'm1-smoke.mjs', ['--target', 'emulator', '--expected-head', H, '--run-dir', runDir, '--mode', 'preflight']],
  ['seed', 'm1-smoke.mjs', ['--target', 'emulator', '--expected-head', H, '--run-dir', runDir, '--mode', 'seed']],
  ['ui', 'm1-ui-smoke.mjs', ['--target', 'emulator', '--expected-head', H, '--run-dir', runDir, '--dist', 'D:\\projects\\finapp\\.runtime\\m1-dist-emulator-714d0f91']],
  ['api', 'm1-smoke.mjs', ['--target', 'emulator', '--expected-head', H, '--run-dir', runDir, '--mode', 'api']],
  ['ui-r3', 'm1-ui-smoke-r3.mjs', ['--target', 'emulator', '--expected-head', H, '--run-dir', runDir, '--dist', 'D:\\projects\\finapp\\.runtime\\m1-dist-emulator-714d0f91']],
  ['cleanup', 'm1-smoke.mjs', ['--target', 'emulator', '--expected-head', H, '--run-dir', runDir, '--mode', 'cleanup', '--rules-status', 'verified-new', '--rules-evidence', evidence]],
  ['verify-clean', 'm1-smoke.mjs', ['--target', 'emulator', '--expected-head', H, '--run-dir', runDir, '--mode', 'verify-clean']],
]
for (const [label, script, args] of steps) {
  const r = spawnSync(process.execPath, [path.join(PKG, script), ...args], { encoding: 'utf8', timeout: 15 * 60 * 1000 })
  process.stdout.write(r.stdout)
  if (r.status !== 0) { process.stdout.write(`${r.stderr}\ndirect smoke chain FAILED at ${label} exit=${r.status}\n`); process.exit(1) }
}
console.log('direct smoke chain exit=0')
