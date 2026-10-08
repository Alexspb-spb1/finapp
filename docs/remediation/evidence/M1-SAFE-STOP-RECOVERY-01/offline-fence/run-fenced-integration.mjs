// Bounded, offline, credential-isolated integration run of the seed-stop-recovery regression on demo-finapp (Auth + Firestore emulators).
//   1. fence self-tests (recorder + live loopback) - the emulators are NOT started when they fail;
//   2. Auth/Firestore emulators in the isolated environment with the loopback fence on every Node process;
//   3. the regression test tests/seed-stop-recovery-emulator.mjs of the candidate package;
//   4. sanitized network-result.json: fence event counts (no external destination allowed), JVM connection sampling (observed only), own-process cleanup.
// Never touches owner credential files, system settings or the firewall; stops only the process tree it started.
// Usage: node run-fenced-integration.mjs --pkg <candidate package> --release-clone <dir with firestore.rules and node_modules/firebase-tools> --jdk-bin <dir> --emulators-path <dir> --work <empty dir> --out <result dir>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { HERE, buildIsolatedEnv, credentialEnvNames } from './isolated-env.mjs'
import { startEmulatorSession } from './emulator-session.mjs'
import { sampleOnce, createAggregate } from './network-sample.mjs'

const RULES_SHA256 = 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd'
const argv = process.argv.slice(2)
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const need = n => { const v = arg(n); if (!v) { console.error(`USAGE missing ${n}`); process.exit(2) } return path.resolve(v) }
const pkg = need('--pkg'), releaseClone = need('--release-clone'), jdkBin = need('--jdk-bin'), emulatorsPath = need('--emulators-path'), work = need('--work'), outDir = need('--out')
if (fs.existsSync(work) && fs.readdirSync(work).length) { console.error('WORK_DIR_NOT_EMPTY (run-once: refusing to reuse)'); process.exit(2) }
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(outDir, { recursive: true })
const fenceLog = path.join(work, 'fence.jsonl')
const result = { schema: 1, target: 'demo-finapp', startedUtc: new Date().toISOString(), credentialProfile: 'isolated', selftests: {}, status: 'STARTED' }
const save = () => fs.writeFileSync(path.join(outDir, 'network-result.json'), JSON.stringify(result, null, 2) + '\n')

function selftest(mode, extraPreload) {
  const resultPath = path.join(outDir, `fence-selftest-${mode}.json`)
  const env = buildIsolatedEnv({ root: path.join(work, `selftest-${mode}`), jdkBin, emulatorsPath, fenceLog, extraPreload, extra: { M1_FENCE_SELFTEST_RESULT: resultPath } })
  const r = spawnSync(process.execPath, [path.join(HERE, 'fence-selftest.cjs'), mode], { env, encoding: 'utf8', windowsHide: true, cwd: work })
  const j = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : { total: 0, failed: -1 }
  result.selftests[mode] = { exit: r.status, total: j.total, failed: j.failed }
  return r.status === 0 && j.failed === 0 && j.total > 0
}

let session = null, sampler = null
try {
  if (!selftest('recorder', [path.join(HERE, 'recorder-stub.cjs')]) || !selftest('live-loopback', [])) throw Object.assign(new Error('FENCE_SELFTEST_FAILED'), { code: 'FENCE_SELFTEST_FAILED' })
  fs.writeFileSync(fenceLog, '') // the self-tests have their own events; the run log starts clean
  session = await startEmulatorSession({ releaseClone, jdkBin, emulatorsPath, root: path.join(work, 'emulators'), rulesSha256: RULES_SHA256, fenceLog })
  result.emulatorsReady = true
  const env = session.env
  result.credentialEnvNamesPresent = credentialEnvNames(env)
  const agg = createAggregate()
  let busy = false
  sampler = setInterval(() => { if (busy) return; busy = true; try { agg.add(sampleOnce(session.pids())) } finally { busy = false } }, 3000)
  const t0 = Date.now()
  const test = spawn(process.execPath, [path.join(pkg, 'tests', 'seed-stop-recovery-emulator.mjs')], { cwd: pkg, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  test.stdout.on('data', d => { stdout += d }); test.stderr.on('data', d => { stdout += d })
  const exit = await new Promise(res => test.on('exit', c => res(c ?? 1)))
  clearInterval(sampler); sampler = null
  agg.add(sampleOnce(session.pids()))
  fs.writeFileSync(path.join(outDir, 'integration.stdout.txt'), stdout)
  const final = stdout.split('\n').filter(l => /^SEED_STOP_RECOVERY_EMULATOR /.test(l)).pop() || ''
  result.integration = { test: 'tests/seed-stop-recovery-emulator.mjs', exit, summaryLine: final, seconds: Math.round((Date.now() - t0) / 1000) }
  result.jvm = agg.summary()
  const stop = await session.stop(); session = null
  result.ownProcessCleanup = stop
  // fence log aggregate: counts and the distinct blocked destinations only
  const events = fs.readFileSync(fenceLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const blocked = events.filter(e => e.decision === 'blocked')
  result.fence = {
    guardedApis: ['net.Socket.connect (net/tls/http/https/undici)', 'dns.lookup + dns.resolve*/reverse (+promises)', 'fetch', 'dgram send/connect'],
    events: events.length, loopbackOrLocal: events.filter(e => e.decision === 'loopback' || e.decision === 'local').length, blocked: blocked.length,
    allowedNonLoopback: events.filter(e => !['blocked', 'loopback', 'local'].includes(e.decision)).length, // the fence logs only these three decisions; anything else would be an anomaly
    blockedDestinations: [...new Set(blocked.map(b => b.host))].slice(0, 10),
    processesObserved: new Set(events.map(e => e.pid)).size
  }
  result.limits = [
    'Java (Auth/Firestore emulator JVM) is not fenced: only sampled (observed, not enforced)',
    'The Functions emulator was not started in this run',
    'Non-Node child processes and native add-ons are not fenced',
    'Not a retroactive proof for earlier runs, including the earlier full run that logged an ADC warning'
  ]
  const ok = exit === 0 && /PASS (\d+)\/\1$/.test(final) && result.fence.allowedNonLoopback === 0 && result.credentialEnvNamesPresent.length === 0 && stop.portsFreeAfter && result.jvm.establishedNonLoopback === 0
  result.status = ok ? 'INTEGRATION_PASS' : 'INTEGRATION_FAIL'
} catch (e) {
  result.status = 'LOCAL_RUN_BLOCKED'
  result.reason = String(e.code || e.message).slice(0, 120)
} finally {
  if (sampler) clearInterval(sampler)
  if (session) result.ownProcessCleanup = await session.stop()
  result.finishedUtc = new Date().toISOString()
  save()
  console.log(`FENCED_INTEGRATION ${result.status}${result.reason ? ` reason=${result.reason}` : ''} integrationExit=${result.integration?.exit} blocked=${result.fence?.blocked} allowedNonLoopback=${result.fence?.allowedNonLoopback} jvmNonLoopbackEstablished=${result.jvm?.establishedNonLoopback}`)
  process.exitCode = result.status === 'INTEGRATION_PASS' ? 0 : 1
}
