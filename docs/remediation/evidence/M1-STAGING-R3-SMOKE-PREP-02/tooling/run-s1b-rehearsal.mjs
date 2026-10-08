// Local rehearsal of the S1b flow against OWN emulators (Auth + Firestore + Functions, demo-finapp) with the loopback fence on every Node process, an isolated
// environment (no credentials, empty profile/config directories) and no-network stubs for the live read tools. Nothing here can reach a live system.
//   node run-s1b-rehearsal.mjs --pkg <built package> --release-clone <dir> --jdk-bin <dir> --emulators-path <dir> --playwright-path <dir> --work <new dir> --out <new dir> [--only a,b]
// Scenarios (each one new evidence namespace under the rehearsal base; emulator data reset between them):
//   success             the full R3 flow: readiness -> preflight -> seed -> ui -> api -> ui-r3 -> cleanup -> verify-clean -> final reads: PASS, nothing left behind
//   rules-r2            the (stub) live Rules are round 2: STOP at step 1, no account created
//   rules-unknown       unknown Rules hash: STOP at step 1
//   functions-drift     Functions differ from the pins: STOP at step 1
//   unknown-outcome     the first Auth create is delivered but the answer is lost (injected): STOP, NO cleanup, the synthetic account REMAINS (no retry, no replay)
//   budget-real-tool    the real smoke tool with a 1-request budget: STOP kind budget before the second request
// Output: sanitized network-result.json, per-scenario summaries, observed request counts (for budget calibration), fence self-test results.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { startS1bSession } from './s1b-emulator-session.mjs'
import { sampleOnce, createAggregate } from '../../M1-SAFE-STOP-RECOVERY-01/offline-fence/network-sample.mjs'

const argv = process.argv.slice(2)
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const need = n => { const v = arg(n); if (!v) { console.error(`USAGE missing ${n}`); process.exit(2) } return path.resolve(v) }
const pkg = need('--pkg'), releaseClone = need('--release-clone'), jdkBin = need('--jdk-bin'), emulatorsPath = need('--emulators-path'), playwrightPath = need('--playwright-path'), work = need('--work'), outDir = need('--out')
const only = arg('--only') ? new Set(arg('--only').split(',')) : null
if (fs.existsSync(work) && fs.readdirSync(work).length) { console.error('WORK_DIR_NOT_EMPTY'); process.exit(2) }
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(outDir, { recursive: true })
const imp = f => import(pathToFileURL(path.join(pkg, f)).href)
const { S1B, loadBudget } = await imp('m1-s1b-pins.mjs')
const { buildIsolatedEnv, credentialEnvNames } = await imp('offline-fence/isolated-env.mjs')
const RULES_SHA256 = 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd'
const fenceLog = path.join(work, 'fence.jsonl')
const result = { schema: 1, task: S1B.taskId, target: 'demo-finapp', startedUtc: new Date().toISOString(), credentialProfile: 'isolated', selftests: {}, scenarios: [], status: 'STARTED' }
const save = () => fs.writeFileSync(path.join(outDir, 'rehearsal-result.json'), JSON.stringify(result, null, 2) + '\n')
const budget = loadBudget(path.join(pkg, 'operation-budget.json')).budget

function selftest(mode, extraPreload) {
  const resultPath = path.join(outDir, `fence-selftest-${mode}.json`)
  const env = buildIsolatedEnv({ root: path.join(work, `selftest-${mode}`), jdkBin, emulatorsPath, fenceLog, fencePath: path.join(pkg, 'offline-fence', 'loopback-only.cjs'), extraPreload, extra: { M1_FENCE_SELFTEST_RESULT: resultPath } })
  const r = spawnSync(process.execPath, [path.join(pkg, 'offline-fence', 'fence-selftest.cjs'), mode], { env, encoding: 'utf8', windowsHide: true, cwd: work })
  const j = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : { total: 0, failed: -1 }
  result.selftests[mode] = { exit: r.status, total: j.total, failed: j.failed }
  return r.status === 0 && j.failed === 0 && j.total > 0
}
const post = (port, method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: 'Bearer owner', 'content-type': 'application/json', connection: 'close' }, body }).then(async r => ({ status: r.status, text: await r.text() }))
const authUsers = async () => { const r = await post(9099, 'POST', '/identitytoolkit.googleapis.com/v1/projects/demo-finapp/accounts:query', JSON.stringify({ returnSecureToken: false })); const j = JSON.parse(r.text); return Array.isArray(j.userInfo) ? j.userInfo.length : 0 }

let session = null, sampler = null, lastEvDir = null
try {
  if (!selftest('recorder', [path.join(pkg, 'offline-fence', 'recorder-stub.cjs')]) || !selftest('live-loopback', [])) throw Object.assign(new Error('FENCE_SELFTEST_FAILED'), { code: 'FENCE_SELFTEST_FAILED' })
  fs.writeFileSync(fenceLog, '')
  session = await startS1bSession({ pkg, releaseClone, jdkBin, emulatorsPath, playwrightPath, root: path.join(work, 'emulators'), rulesSha256: RULES_SHA256, fenceLog })
  result.emulatorsReady = true
  result.credentialEnvNamesPresent = credentialEnvNames(session.env)
  const agg = createAggregate()
  let busy = false
  sampler = setInterval(() => { if (busy) return; busy = true; try { agg.add(sampleOnce(session.pids())) } finally { busy = false } }, 4000)

  const scenarioFile = (name, content) => { const f = path.join(work, `${name}.scenario.json`); fs.writeFileSync(f, JSON.stringify(content)); return f }
  const runRehearse = (name, scenario, nodeOptionsExtra = '') => {
    const evDir = path.join(S1B.rehearsalBase, `${name}-${Date.now()}`)
    lastEvDir = evDir
    const env = { ...session.env, ...(nodeOptionsExtra ? { NODE_OPTIONS: `${session.env.NODE_OPTIONS} ${nodeOptionsExtra}` } : {}) }
    const r = spawnSync(process.execPath, [path.join(pkg, 'm1-s1b.mjs'), 'rehearse', '--scenario', scenarioFile(name, scenario), '--evidence-root', evDir, '--ui-dist', 'D:\\projects\\finapp\\.runtime\\m1-dist-emulator-714d0f91', '--staging-dist', 'D:\\projects\\finapp\\.runtime\\m1-dist-staging-714d0f91'], { env, encoding: 'utf8', windowsHide: true, cwd: pkg, timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 })
    fs.writeFileSync(path.join(outDir, `${name}.stdout.txt`), `${r.stdout}\n${r.stderr}`)
    const read = f => { try { return JSON.parse(fs.readFileSync(path.join(evDir, f), 'utf8')) } catch { return null } }
    return { exit: r.status, evDir, res: read('s1b-result.json'), journal: (() => { try { return fs.readFileSync(path.join(evDir, 's1b-journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } })() }
  }
  const labelsOf = r => r.journal.filter(e => e.event === 'RUN').map(e => e.label)
  const observed = {}
  const scenarios = [
    ['success', async () => {
      await session.resetData()
      const r = runRehearse('success', { gh: { kind: 'success' }, reads: {} })
      const modes = {}
      const runDir = path.join(r.evDir, 'run')
      if (fs.existsSync(runDir)) for (const f of fs.readdirSync(runDir)) { const m = f.match(/^result-(.+)-\d+\.json$/); if (m) { const j = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8')); modes[m[1]] = { status: j.status, requests: j.counters?.requests ?? null, authCreates: j.counters?.authCreates ?? null, authDeletes: j.counters?.authDeletes ?? null, operatorCommits: j.counters?.operatorCommits ?? null } } }
      observed.success = modes
      const left = await authUsers()
      const need = ['preflight', 'seed', 'ui', 'api', 'ui-r3', 'cleanup', 'verify-clean']
      const within = need.every(m => modes[m] && modes[m].requests <= budget.modes[m].maxRequests && (modes[m].authCreates ?? 0) <= budget.modes[m].maxAuthCreates && (modes[m].authDeletes ?? 0) <= budget.modes[m].maxAuthDeletes && (modes[m].operatorCommits ?? 0) <= budget.modes[m].maxOperatorCommits)
      return { pass: r.exit === 0 && r.res?.status === 'PASS' && r.res.cleanup?.branch === 'CLEANUP_COMPLETE_VERIFIED' && r.res.clientAccess?.uiPass && r.res.clientAccess?.apiPass && r.res.clientAccess?.uiR3Pass && left === 0 && within,
        detail: { exit: r.exit, status: r.res?.status, completed: r.res?.completed, cleanup: r.res?.cleanup?.branch, authUsersLeft: left, withinBudget: within, modes, order: labelsOf(r) } }
    }],
    ['rules-r2', async () => {
      await session.resetData()
      const r = runRehearse('rules-r2', { gh: { kind: 'success' }, reads: { rules: 'r2' } })
      const l = labelsOf(r)
      return { pass: r.exit === 2 && r.res?.stop?.step === 'step1' && /rules-r2-live/.test(r.res.stop.reason) && !l.includes('readiness') && !l.some(x => x.startsWith('smoke-')) && (await authUsers()) === 0, detail: { exit: r.exit, stop: r.res?.stop, labels: l } }
    }],
    ['rules-unknown', async () => {
      await session.resetData()
      const r = runRehearse('rules-unknown', { gh: { kind: 'success' }, reads: { rules: 'unknown' } })
      return { pass: r.exit === 2 && r.res?.stop?.step === 'step1' && /rules-not-r3/.test(r.res.stop.reason) && !labelsOf(r).some(x => x.startsWith('smoke-')), detail: { exit: r.exit, stop: r.res?.stop } }
    }],
    ['functions-drift', async () => {
      await session.resetData()
      const r = runRehearse('functions-drift', { gh: { kind: 'success' }, reads: { functions: 'drift-m1' } })
      return { pass: r.exit === 2 && r.res?.stop?.step === 'step1' && !labelsOf(r).some(x => x.startsWith('smoke-')), detail: { exit: r.exit, stop: r.res?.stop } }
    }],
    ['unknown-outcome', async () => {
      await session.resetData()
      const r = runRehearse('unknown-outcome', { gh: { kind: 'success' }, reads: {} }, `--require=${path.join(pkg, 'tests', 'fault-auth-create-reset-after-send.cjs')}`)
      const l = labelsOf(r)
      const remaining = await authUsers()
      const seed = r.res?.cleanup
      return { pass: r.exit === 2 && r.res?.stop?.step === 'step4' && seed?.run === false && seed?.decision === 'manual-classification-required' && !l.includes('cleanup') && !l.includes('inventory') && l.filter(x => x === 'smoke-seed').length === 1 && !l.includes('smoke-ui') && remaining === 1,
        detail: { exit: r.exit, stop: r.res?.stop, decision: seed?.decision, authUsersRemaining: remaining, labels: l } }
    }],
    // CR1 (Task02 review V1) with the REAL tools: the Auth delete of cleanup fails with an UNKNOWN outcome after the document deletes were sent (cleanup exit 4):
    // the flow must stop - no inventory, no verify-clean, no further provider read - and the synthetic accounts remain for the manual decision.
    ['cleanup-unknown-real', async () => {
      await session.resetData()
      const r = runRehearse('cleanup-unknown-real', { gh: { kind: 'success' }, reads: {} }, `--require=${path.join(pkg, 'tests', 'fault-auth-delete.cjs')}`)
      const l = labelsOf(r)
      const remaining = await authUsers()
      const c = r.res?.cleanup
      return { pass: r.exit === 2 && r.res?.stop?.step === 'step5' && c?.branch === 'CLEANUP_UNSAFE_STOP' && c?.exitCode === 4 && c?.manualClassificationRequired === true && c?.unsafeStop?.kind === 'transport' && c?.unsafeStop?.dispatch === 'unknown' &&
        l.at(-1) === 'cleanup' && !l.includes('inventory') && !l.includes('verify-clean') && !l.includes('final-functions') && remaining === 3,
      detail: { exit: r.exit, stop: r.res?.stop, branch: c?.branch, cleanupExit: c?.exitCode, unsafeStop: c?.unsafeStop, authUsersRemaining: remaining, lastLabel: l.at(-1) } }
    }],
    ['budget-real-tool', async () => {
      await session.resetData()
      const runDir = path.join(S1B.rehearsalBase, `budget-${Date.now()}`)
      fs.mkdirSync(runDir, { recursive: true })
      const env = { ...session.env, M1_S1B_BUDGET: JSON.stringify({ maxRequests: 1, maxAuthCreates: 0, maxAuthDeletes: 0, maxOperatorCommits: 0 }) }
      const r = spawnSync(process.execPath, [path.join(pkg, 'm1-smoke.mjs'), '--target', 'emulator', '--expected-head', S1B.head, '--run-dir', path.join(runDir, 'run'), '--mode', 'preflight'], { env, encoding: 'utf8', windowsHide: true, cwd: pkg })
      let stopKind = null
      try { stopKind = fs.readFileSync(path.join(runDir, 'run', 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x)).filter(e => e.event === 'MODE_STOP').at(-1)?.kind } catch { /* below */ }
      return { pass: r.status === 2 && stopKind === 'budget' && (await authUsers()) === 0, detail: { exit: r.status, stopKind } }
    }]
  ]
  for (const [name, fn] of scenarios) {
    if (only && !only.has(name)) continue
    const t0 = Date.now()
    let r
    try { r = await fn() } catch (e) { r = { pass: false, detail: { error: String(e.message).slice(0, 160) } } }
    result.scenarios.push({ name, pass: r.pass, seconds: Math.round((Date.now() - t0) / 1000), evidenceDir: lastEvDir ? path.basename(lastEvDir) : null, detail: r.detail })
    lastEvDir = null
    console.log(`${r.pass ? 'PASS' : 'FAIL'} scenario ${name} (${Math.round((Date.now() - t0) / 1000)} s)`)
    save()
  }
  // The tests of the CHANGED modules (m1-core, m1-transport) that need no new code: the accepted transport/recovery/cleanup-gate suites run against the S1b package,
  // under the same fence and isolated environment. (They write their own synthetic runs under the runtime root and never touch the S1b namespace.)
  result.suites = []
  if (!only) {
    for (const [name, file, re] of [['transport-classification', 'tests/transport-classification-tests.mjs', /TRANSPORT_CLASSIFICATION_TESTS PASS (\d+)\/\1/], ['seed-stop-recovery', 'tests/seed-stop-recovery-emulator.mjs', /SEED_STOP_RECOVERY_EMULATOR PASS (\d+)\/\1/], ['cleanup-gates', 'emulator-cleanup-gate-tests.mjs', /GATE_TESTS PASS (\d+)\/\1/]]) {
      await session.resetData()
      const r = spawnSync(process.execPath, [path.join(pkg, file)], { env: session.env, encoding: 'utf8', windowsHide: true, cwd: pkg, timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 })
      const out = `${r.stdout}\n${r.stderr}`
      fs.writeFileSync(path.join(outDir, `suite-${name}.stdout.txt`), out)
      const line = out.split('\n').reverse().find(l => re.test(l)) ?? ''
      result.suites.push({ name, exit: r.status, pass: r.status === 0 && re.test(line), line: line.trim().slice(0, 120) })
      console.log(`${r.status === 0 && re.test(line) ? 'PASS' : 'FAIL'} suite ${name} :: ${line.trim().slice(0, 100)}`)
    }
  }
  clearInterval(sampler); sampler = null
  agg.add(sampleOnce(session.pids()))
  fs.writeFileSync(path.join(outDir, 'observed-requests.json'), JSON.stringify(observed, null, 2) + '\n')
  result.jvm = agg.summary()
  result.ownProcessCleanup = await session.stop(); session = null
  const events = fs.readFileSync(fenceLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const blocked = events.filter(e => e.decision === 'blocked')
  result.fence = {
    guardedApis: ['net.Socket.connect (net/tls/http/https/undici)', 'dns.lookup + dns.resolve*/reverse (+promises)', 'fetch', 'dgram send/connect'],
    events: events.length, loopbackOrLocal: events.filter(e => e.decision === 'loopback' || e.decision === 'local').length, blocked: blocked.length,
    allowedNonLoopback: events.filter(e => !['blocked', 'loopback', 'local'].includes(e.decision)).length,
    blockedDestinations: [...new Set(blocked.map(b => b.host))].slice(0, 20), processesObserved: new Set(events.map(e => e.pid)).size,
    scriptsObserved: [...new Set(events.map(e => e.script))].filter(Boolean).slice(0, 40)
  }
  result.limits = [
    'Java (Auth/Firestore emulator JVM) is not fenced: only sampled (observed, not enforced); sampling is TCP, interval-based',
    'The Functions emulator workers are Node processes started by the emulator with the inherited environment: they are fenced only if the fence log shows them (see fence.scriptsObserved); this is observed, not guaranteed',
    'The browser used by the UI modes (Chromium) is a non-Node process: it is outside the Node fence; its page requests pass the UI route policy allowlist, browser-internal traffic is not observed',
    'Non-Node child processes and native add-ons are not fenced',
    'Not a retroactive proof for earlier runs; says nothing about live staging behaviour or about the root cause of the old network failure'
  ]
  const ok = result.scenarios.length > 0 && result.scenarios.every(s => s.pass) && result.suites.every(s => s.pass) && result.fence.allowedNonLoopback === 0 && result.credentialEnvNamesPresent.length === 0 && result.ownProcessCleanup.portsFreeAfter && result.jvm.establishedNonLoopback === 0
  result.status = ok ? 'REHEARSAL_PASS' : 'REHEARSAL_FAIL'
} catch (e) {
  result.status = 'LOCAL_RUN_BLOCKED'; result.reason = String(e.code || e.message).slice(0, 160)
} finally {
  if (sampler) clearInterval(sampler)
  if (session) result.ownProcessCleanup = await session.stop()
  result.finishedUtc = new Date().toISOString()
  save()
  console.log(`S1B_REHEARSAL ${result.status}${result.reason ? ` reason=${result.reason}` : ''} scenarios=${result.scenarios.filter(s => s.pass).length}/${result.scenarios.length} fenceEvents=${result.fence?.events} blocked=${result.fence?.blocked} allowedNonLoopback=${result.fence?.allowedNonLoopback} jvmNonLoopbackEstablished=${result.jvm?.establishedNonLoopback}`)
  process.exitCode = result.status === 'REHEARSAL_PASS' ? 0 : 1
}
void spawn
