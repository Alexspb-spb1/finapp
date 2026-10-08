// Verification driver for a candidate runner package (replaces the unversioned bash driver kept as run-all-r4.legacy.sh for history).
// Runs the steps sequentially, records every exit code, and prints the success marker VERIFY_ALL_PASS ONLY when every step exited 0 AND its expected
// PASS line is present (and, for "PASS x/y" lines, x === y). Any failing step, a missing expected line, a failed emulator start or a failed
// finalization gives VERIFY_ALL_FAILED and a non-zero exit code. No step is hidden behind a pipe or swallowed.
// Usage: node verify-driver.mjs --pkg <candidate package> --release-clone <dir> --jdk-bin <dir> --emulators-path <dir> --rehearsal-base <dir> --web-config <file> --work <empty dir>
//        [--phases local,emulator,finalize] [--only name,name]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PS = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
const FRACTION = /PASS (\d+)\/(\d+)/
const DETECTED = /detected=(\d+)\/(\d+)/

// A step passes only if exit==0, its expected line is present and any x/y in it is complete.
export function evaluateStep(step, status, output) {
  if (status !== 0) return { ok: false, why: `exit=${status}` }
  if (!step.expect) return { ok: true, line: '' }
  const line = output.split('\n').reverse().find(l => step.expect.test(l))
  if (!line) return { ok: false, why: 'expected line missing' }
  for (const re of [FRACTION, DETECTED]) { const m = line.match(re); if (m && m[1] !== m[2]) return { ok: false, why: `incomplete ${m[1]}/${m[2]}`, line } }
  return { ok: true, line: line.trim().slice(0, 150) }
}

// Runs steps with an injectable executor `exec(step) -> {status, stdout}`; never throws; every step is recorded.
export function runSteps(steps, exec, log = () => {}) {
  const results = []
  for (const step of steps) {
    let status = 1, stdout = ''
    try { const r = exec(step); status = r.status ?? 1; stdout = r.stdout ?? '' } catch (e) { stdout = `executor error: ${e.message}` }
    const ev = evaluateStep(step, status, stdout)
    results.push({ name: step.name, status, ok: ev.ok, why: ev.why, line: ev.line })
    log(`${step.name} exit=${status} ${ev.ok ? 'OK' : `FAILED(${ev.why})`}${ev.line ? ` :: ${ev.line}` : ''}`)
  }
  return results
}

export function verdict(results) {
  const failed = results.filter(r => !r.ok).map(r => r.name)
  return { ok: results.length > 0 && failed.length === 0, failed, marker: results.length > 0 && failed.length === 0 ? `VERIFY_ALL_PASS steps=${results.length}` : `VERIFY_ALL_FAILED failed=${failed.join(',') || 'no-steps'}` }
}

export function buildSteps(cfg) {
  const node = (name, args, expect, extra = {}) => ({ name, cmd: process.execPath, args, cwd: cfg.pkg, expect, ...extra })
  const ps = (name, args, expect) => ({ name, cmd: PS[0], args: [...PS.slice(1), '-File', ...args], cwd: cfg.pkg, expect })
  const local = [
    node('normalize-bom', ['tests/normalize-ps1-bom.mjs']),
    node('code-sums', ['tests/make-code-sums.mjs'], /CODE-SHA256SUMS\.txt files=\d+/),
    ps('parse', ['tests/ps51-parse-check.ps1'], /PS51_PARSE_CHECK .*failed=0/),
    node('node-helper', ['tests/node-helper-tests.mjs'], /NODE_HELPER_TESTS PASS/),
    node('export-poll', ['tests/export-poll-tests.mjs'], /EXPORT_POLL_TESTS PASS/),
    node('transport-classification', ['tests/transport-classification-tests.mjs'], /TRANSPORT_CLASSIFICATION_TESTS PASS/),
    node('ui-route', ['ui-route-policy-tests.mjs'], /UI_ROUTE_POLICY_TESTS PASS/),
    node('local-acl', ['local-acl-webconfig-tests.mjs'], /LOCAL_ACL_WEBCONFIG_TESTS PASS/, { env: { M1_WEB_CONFIG: cfg.webConfig } }),
    ps('orch-helpers', ['tests/ps51-orchestrator-tests.ps1', '-Set', 'helpers'], /PS51_ORCHESTRATOR_TESTS set=helpers PASS/),
    ps('orch-stub', ['tests/ps51-orchestrator-tests.ps1', '-Set', 'stub'], /PS51_ORCHESTRATOR_TESTS set=stub PASS/)
  ]
  const loadRules = name => node(name, ['tests/load-emulator-rules.mjs', '--file', path.join(cfg.releaseClone, 'firestore.rules')], /LOAD_RULES status=200/, { emulator: true })
  const emulator = [
    loadRules('load-rules-1'),
    node('gate-tests', ['emulator-cleanup-gate-tests.mjs'], /GATE_TESTS PASS/, { emulator: true }),
    loadRules('load-rules-2'),
    node('direct-smoke', ['tests/direct-emulator-smoke.mjs'], /direct smoke chain exit=0/, { emulator: true }),
    node('seed-stop-recovery', ['tests/seed-stop-recovery-emulator.mjs'], /SEED_STOP_RECOVERY_EMULATOR PASS/, { emulator: true }),
    loadRules('load-rules-3'),
    ps('orch-emulator', ['tests/ps51-orchestrator-tests.ps1', '-Set', 'emulator'], /PS51_ORCHESTRATOR_TESTS set=emulator PASS/),
    node('mutation', ['tests/mutation-checks.mjs'], /MUTATION_CHECKS PASS/),
    node('mutation-extra', ['tests/mutation-checks-extra.mjs'], /MUTATION_CHECKS_EXTRA PASS/),
    node('mutation-export', ['tests/mutation-checks-export.mjs'], /EXPORT_MUTATION_CHECKS PASS/),
    node('mutation-recovery', ['tests/mutation-checks-recovery.mjs'], /RECOVERY_MUTATION_CHECKS PASS/)
  ].map(s => (s.name.startsWith('orch-emulator') || s.name.startsWith('mutation')) ? { ...s, emulator: true } : s)
  const finalize = [{ name: 'finalize-results', cmd: process.execPath, args: [path.join(HERE, 'finalize-results.mjs'), '--pkg', cfg.pkg, '--base', cfg.rehearsalBase], cwd: cfg.pkg, expect: /^RESULTS_FINALIZED$/ }]
  return { local, emulator, finalize }
}

async function main() {
  const argv = process.argv.slice(2)
  const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const cfg = { pkg: arg('--pkg'), releaseClone: arg('--release-clone'), jdkBin: arg('--jdk-bin'), emulatorsPath: arg('--emulators-path'), rehearsalBase: arg('--rehearsal-base'), webConfig: arg('--web-config'), work: arg('--work') }
  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) { console.log(`VERIFY_ALL_FAILED usage-missing=${missing.join(',')}`); process.exitCode = 2; return }
  for (const k of Object.keys(cfg)) cfg[k] = path.resolve(cfg[k])
  const phases = (arg('--phases') || 'local,emulator,finalize').split(',')
  const only = arg('--only') ? new Set(arg('--only').split(',')) : null
  const results = []
  const log = l => console.log(l)
  const resultsDir = path.join(cfg.pkg, 'results')
  fs.mkdirSync(resultsDir, { recursive: true })
  // `step.env` is MERGED over the caller's environment for local steps; emulator steps get the isolated environment alone (see below).
  const exec = step => {
    const r = spawnSync(step.cmd, step.args, { cwd: step.cwd, env: step.isolatedEnv || (step.env ? { ...process.env, ...step.env } : process.env), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    fs.writeFileSync(path.join(resultsDir, `${step.name}.txt`), out)
    return { status: r.status ?? 1, stdout: out }
  }
  const steps = buildSteps(cfg)
  const pick = list => list.filter(s => !only || only.has(s.name))
  if (phases.includes('local')) results.push(...runSteps(pick(steps.local), exec, log))
  if (phases.includes('emulator')) {
    const wanted = pick(steps.emulator)
    if (wanted.length) {
      const { startEmulatorSession } = await import('../offline-fence/emulator-session.mjs')
      const fenceLog = path.join(cfg.work, 'fence.jsonl')
      fs.mkdirSync(cfg.work, { recursive: true })
      fs.writeFileSync(fenceLog, '')
      let session
      try {
        session = await startEmulatorSession({ releaseClone: cfg.releaseClone, jdkBin: cfg.jdkBin, emulatorsPath: cfg.emulatorsPath, root: path.join(cfg.work, 'emulators'), fenceLog })
        log('emulators ready (isolated credentials, loopback fence on Node processes; JVM not fenced)')
        results.push(...runSteps(wanted.map(s => ({ ...s, isolatedEnv: session.env })), exec, log))
      } catch (e) {
        results.push({ name: 'emulator-session', status: 1, ok: false, why: String(e.message).slice(0, 100) })
        log(`emulator-session FAILED(${String(e.message).slice(0, 100)})`)
      } finally {
        if (session) log(`emulators stopped: ${JSON.stringify(await session.stop())}`)
      }
    }
  }
  if (phases.includes('finalize')) results.push(...runSteps(pick(steps.finalize), exec, log))
  const v = verdict(results)
  console.log(v.marker)
  process.exitCode = v.ok ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
