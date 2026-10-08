// Mutation checks of the S1b gates: each mutant removes or weakens ONE gate in a COPY of the package; the negative controls of that copy must FAIL.
// The copy gets its runtime and rehearsal roots rewritten to a temporary directory, so no mutant can create or burn the real staging namespace.
//   node tests/s1b-mutation-checks.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's1b-mutants-'))
const js = s => s.replaceAll('\\', '\\\\')

const MUTANTS = [
  ['no state check of the live Rules against the pinned R3 target', 'm1-s1b-flow.mjs', "'--canonical', S1B.rulesTarget, '--out', ev('state-check-rules.json')]) !== 0", "'--canonical', S1B.rulesTarget, '--out', ev('state-check-rules.json')]) !== 99"],
  ['automatic cleanup also after an unknown transport outcome', 'm1-s1b-flow.mjs', "Object.freeze(['assertion', 'ui-flow'])", "Object.freeze(['assertion', 'ui-flow', 'transport', 'unexpected'])"],
  ['cleanup without the linked Rules evidence', 'm1-s1b-flow.mjs', 'if (safeSha(rulesEv) !== state.rulesEvidenceSha256 || state.rulesEvidenceSha256 === null) {', 'if (false) {'],
  ['cleanup after a Rules probe failure', 'm1-s1b-flow.mjs', "if (rulesProbeFailure) return { run: false, why: 'rules-probe-failure-needs-a-decision' }", ''],
  ['cleanup without the permitted operation pair', 'm1-s1b-flow.mjs', "if (!ops.cleanup || !ops.cleanupExactLookup) return { run: false, why: 'cleanup-not-permitted' }", ''],
  ['smoke modes continue after a failed mode (retry/replay of later modes)', 'm1-s1b-flow.mjs', '      save()\n      break\n', '      save()\n'],
  ['an unreadable run journal is treated as an assertion failure', 'm1-s1b-flow.mjs', "j.unreadable ? { kind: 'journal-unreadable'", "j.unreadable ? { kind: 'assertion'"],
  ['readiness accepted although the tool exit is non-zero', 'm1-s1b-flow.mjs', 'const readyOk = rd === 0 && rr?.status', 'const readyOk = rr?.status'],
  ['forbidden staging environment accepted', 'm1-s1b-flow.mjs', "if (Object.entries(env).some(([k, v]) => v && FORBIDDEN_STAGING_ENV.test(k))) return refuse('forbidden environment for a staging execution')", ''],
  ['root Node version not checked', 'm1-s1b-flow.mjs', "if (!/^v24\\.16\\./.test(cfg.nodeVersion ?? process.version)) stopStage('step0', 'root Node is not the pinned v24.16')", ''],
  ['consumed/reserved namespaces accepted', 'm1-s1b-pins.mjs', "if (S1B.consumedEvidence.includes(n) || S1B.consumedRuns.includes(n)) problems.push(`consumed or reserved namespace ${n}`)", ''],
  ['production markers ignored', 'm1-s1b-pins.mjs', "for (const v of values) for (const m of S1B.productionMarkers) if (String(v).toLowerCase().includes(m)) problems.push('production marker in the input values')", ''],
  ['mismatch reason for round-2 Rules lost', 'm1-s1b-pins.mjs', "return c === 'r2' ? 'rules-r2-live' : 'rules-not-r3'", "return 'rules-not-r3'"],
  ['permit not bound to the package bytes', 'm1-s1b-permit.mjs', "if (p.bytes?.codeSums !== facts.codeSumsSha256) problems.push('permit is not bound to these package bytes')", ''],
  ['permit validity window ignored', 'm1-s1b-permit.mjs', "if (!(approved <= nowMs && nowMs < expires)) problems.push('permit is not valid now')", ''],
  ['permit reconciliation age ignored', 'm1-s1b-permit.mjs', "if (recon > approved || approved - recon > MAX_RECONCILIATION_AGE_MS) problems.push('state reconciliation is missing or older than 24 h at approval')", ''],
  ['credential bootstrap failure leaks the error text as the reason code', 'm1-transport.mjs', "return credentialStop('provider-error')", 'return credentialStop(String(error && error.message))'],
  ['credential bootstrap failure is retried silently into a request', 'm1-transport.mjs', "if (!ok) credentialStop('cli-auth-failed')", "if (!ok) return async () => ({})"],
  ['request budget off by one', 'm1-transport.mjs', 'counters.requests >= budget.maxRequests', 'counters.requests > budget.maxRequests'],
  ['Auth create budget ignored', 'm1-transport.mjs', "if (budget && (counters.authCreateAttempts ?? 0) >= budget.maxAuthCreates) stop('auth-create', 'operation budget exceeded', 'budget')", ''],
  ['staging transport without a budget accepted', 'm1-transport.mjs', "if (target.name === 'staging' && budget === null) stop('transport', 'operation budget required for staging', 'integrity')", '']
]

const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'results' || e.name === 'node_modules') continue
    const a = path.join(from, e.name), b = path.join(to, e.name)
    if (e.isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b)
  }
}
let detected = 0, undetected = [], idx = 0
for (const [name, file, from, to] of MUTANTS) {
  const dir = path.join(TMP, `m${++idx}`)
  copyTree(PKG, dir)
  const rewrite = (f, pairs) => { let s = fs.readFileSync(path.join(dir, f), 'utf8'); for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(`stale anchor in ${f}: ${a.slice(0, 40)}`); s = s.replace(a, () => b) } fs.writeFileSync(path.join(dir, f), s) }
  // sandbox the roots of the copy
  rewrite('m1-s1b-pins.mjs', [["runtimeRoot: 'D:\\\\projects\\\\finapp\\\\.runtime'", `runtimeRoot: '${js(path.join(dir, 'rt'))}'`], ["rehearsalBase: 'D:\\\\projects\\\\finapp\\\\.runtime\\\\m1-s1b-rehearsal\\\\'", `rehearsalBase: '${js(path.join(dir, 'rh'))}\\\\'`]])
  rewrite(file, [[from, to]])
  const r = spawnSync(process.execPath, [path.join(dir, 'tests', 's1b-negative-controls.mjs')], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 32 * 1024 * 1024 })
  const killed = r.status !== 0
  if (killed) detected++; else undetected.push(name)
  console.log(`${killed ? 'DETECTED' : 'SURVIVED'} ${name}`)
}
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`S1B_MUTATION_CHECKS ${undetected.length ? 'FAIL' : 'PASS'} detected=${detected}/${MUTANTS.length}${undetected.length ? ` survived=${undetected.join(' | ')}` : ''}`)
process.exitCode = undetected.length ? 1 : 0
