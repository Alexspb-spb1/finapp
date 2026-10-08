// S1b: the SAME tests as the accepted M1-SAFE-STOP-RECOVERY-01/offline-fence/offline-fence-tests.mjs, run against the package copy of the fence (which carries ONE documented
// delta: the wildcard bind address may be looked up) plus the delta tests. Tests of the offline controls: (1) the isolated environment builder, (2) the loopback fence (self-test in recorder + live-loopback mode),
// (3) negative controls - mutated copies of the fence MUST fail the self-test (the recorder stub makes this safe: nothing can leave the machine).
// Optional (M1_RELEASE_CLONE=<dir with node_modules/firebase-tools>): firebase-tools finds no default account in the isolated environment.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { HERE, buildIsolatedEnv, credentialEnvNames, DEMO_PROJECT } from '../package-s1b-source/offline-fence/isolated-env.mjs'
import { isLoopbackAddress } from '../../M1-SAFE-STOP-RECOVERY-01/offline-fence/network-sample.mjs'

let pass = 0, fail = 0, skipped = 0
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`) } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`) } }
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'not equal'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`) }
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed') }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-fence-tests-'))
const fenceSrc = fs.readFileSync(path.join(HERE, 'loopback-only.cjs'), 'utf8')
const STUB = path.join(HERE, 'recorder-stub.cjs')

// ---- isolated environment
const dirty = {
  Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  GOOGLE_APPLICATION_CREDENTIALS: 'x', FIREBASE_TOKEN: 'x', GOOGLE_OAUTH_ACCESS_TOKEN: 'x', GCLOUD_SERVICE_KEY: 'x', GITHUB_TOKEN: 'x', GH_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', HTTPS_PROXY: 'http://proxy.invalid:1',
  NODE_OPTIONS: '--require=evil.js', APPDATA: 'C:\\Users\\real\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\real', CLOUDSDK_CONFIG: 'C:\\real\\gcloud', XDG_CONFIG_HOME: 'C:\\real\\xdg', FIREBASE_EMULATORS_PATH: 'C:\\real\\emu', UNRELATED: 'x'
}
const root = path.join(tmp, 'iso')
const env = buildIsolatedEnv({ root, base: dirty, jdkBin: 'C:\\jdk\\bin', emulatorsPath: 'C:\\cache\\emulators', fenceLog: path.join(tmp, 'fence.jsonl') })
const inside = p => path.resolve(p).startsWith(path.resolve(root) + path.sep)
t('isolated env: no credential, token, proxy or foreign variable survives', () => { eq(credentialEnvNames(env), [], 'credential-like names'); ok(!('UNRELATED' in env) && !('GITHUB_TOKEN' in env) && !('FIREBASE_TOKEN' in env) && !('GOOGLE_APPLICATION_CREDENTIALS' in env) && !('HTTPS_PROXY' in env), 'a foreign variable survived') })
t('isolated env: every profile/config/credential location points to an empty directory under the isolated root', () => {
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CLOUDSDK_CONFIG', 'TEMP', 'TMP']) { ok(inside(env[k]), `${k} not isolated`); ok(fs.existsSync(env[k]) && fs.readdirSync(env[k]).length === 0, `${k} not empty`) }
})
t('isolated env: project is the demo project, the update check is off, the emulator jar cache is the only external path', () => { eq([env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT, DEMO_PROJECT], [DEMO_PROJECT, DEMO_PROJECT, DEMO_PROJECT]); eq(env.FIREBASE_CLI_DISABLE_UPDATE_CHECK, 'true'); eq(env.FIREBASE_EMULATORS_PATH, 'C:\\cache\\emulators') })
t('isolated env: NODE_OPTIONS holds only the fence preload (the caller value is dropped) and the JDK is first on PATH', () => {
  eq(env.NODE_OPTIONS, `--require=${path.join(HERE, 'loopback-only.cjs')}`)
  ok(env.Path.startsWith('C:\\jdk\\bin'), 'JDK not first')
})
t('isolated env: without a fence log no preload is configured, and a missing root is refused', () => { ok(!('NODE_OPTIONS' in buildIsolatedEnv({ root: path.join(tmp, 'iso2'), base: dirty }))); let threw = false; try { buildIsolatedEnv({}) } catch { threw = true } ok(threw) })
t('JVM sampling classifies loopback and non-loopback remotes', () => { ok(isLoopbackAddress('127.0.0.1') && isLoopbackAddress('::1') && isLoopbackAddress('0.0.0.0')); ok(!isLoopbackAddress('142.250.1.1') && !isLoopbackAddress('2a00:1450::1')) })

// ---- the fence
function runSelftest(fencePath, mode, preload) {
  const log = path.join(tmp, `log-${Math.random().toString(36).slice(2)}.jsonl`)
  const result = path.join(tmp, `res-${Math.random().toString(36).slice(2)}.json`)
  const e = buildIsolatedEnv({ root: path.join(tmp, `r-${Math.random().toString(36).slice(2)}`), base: dirty, fenceLog: log, fencePath, extraPreload: preload, extra: { M1_FENCE_SELFTEST_RESULT: result } })
  const r = spawnSync(process.execPath, [path.join(HERE, 'fence-selftest.cjs'), mode], { env: e, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  const j = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : null
  return { status: r.status, total: j?.total ?? 0, failed: j?.failed ?? -1, failedNames: (j?.results || []).filter(x => !x.ok).map(x => x.name), out: r.stdout }
}
t('fence self-test (recorder): all external attempts blocked, loopback allowed, children inherit, fail closed without log', () => {
  const r = runSelftest(path.join(HERE, 'loopback-only.cjs'), 'recorder', [STUB])
  ok(r.status === 0 && r.failed === 0 && r.total >= 30, `status=${r.status} failed=${r.failed} total=${r.total} ${r.failedNames.join(' | ')}`)
})
t('fence self-test (live loopback): real loopback traffic still works and an external connect is blocked', () => {
  const r = runSelftest(path.join(HERE, 'loopback-only.cjs'), 'live-loopback', [])
  ok(r.status === 0 && r.failed === 0 && r.total === 4, `status=${r.status} failed=${r.failed} total=${r.total} ${r.failedNames.join(' | ')}`)
})

// ---- negative controls: each mutation removes one guard; the self-test must report failures (exit != 0)
const mutations = [
  ['isLoopbackHost accepts everything', s => s.replace('return h === \'localhost\' || h === \'::1\' || LOOPBACK_V4.test(h)', 'return true')],
  ['connect guard removed', s => s.replace('if (!isLoopbackHost(options.host)) throw denied(\'connect\', options.host)', '')],
  ['dns.lookup guard removed', s => s.replace('if (!isLoopbackHost(host) && net.isIP(String(host)) === 0) throw denied(\'dns-lookup\', host)', '')],
  ['wildcard exception widened to every lookup', s => s.replace('if (!isLoopbackHost(host) && net.isIP(String(host)) === 0) throw denied(\'dns-lookup\', host)', 'if (false) throw denied(\'dns-lookup\', host)')],
  ['IP-literal exception removed (listen() would break)', s => s.replace(' && net.isIP(String(host)) === 0', '')],
  ['IP-literal exception widened to every non-empty host', s => s.replace('net.isIP(String(host)) === 0', 'String(host).length === 0')],
  ['dns.promises.lookup guard removed', s => s.replace('if (!isLoopbackHost(host)) throw denied(\'dns-promise-lookup\', host)', '')],
  ['dns.resolve*/reverse guard removed', s => s.replace('if (typeof dns[method] === \'function\') dns[method] = function (host) { throw denied(\'dns-resolve\', host) }', '')],
  ['fetch guard removed', s => s.replace('if (![\'http:\', \'https:\'].includes(u.protocol) || !isLoopbackHost(u.hostname)) throw denied(\'fetch\', u.hostname)', '')],
  ['dgram guard removed', s => s.replace('if (!isLoopbackHost(address)) throw denied(`dgram-${method}`, address)', '')],
  ['log requirement removed (children no longer fail closed)', s => s.replace('if (!LOG) throw new Error(\'M1_FENCE_LOG_REQUIRED\')', '')]
]
for (const [name, mutate] of mutations) {
  t(`negative control: "${name}" is detected by the self-test`, () => {
    const mutated = mutate(fenceSrc)
    ok(mutated !== fenceSrc, 'mutation did not change the fence source (stale anchor)')
    const p = path.join(tmp, `mutant-${Math.random().toString(36).slice(2)}.cjs`)
    fs.writeFileSync(p, mutated)
    const r = runSelftest(p, 'recorder', [STUB])
    ok(r.status !== 0 && r.failed !== 0, `mutant survived: status=${r.status} failed=${r.failed}`)
  })
}

// ---- optional: firebase-tools in the isolated environment
const clone = process.env.M1_RELEASE_CLONE
if (clone && fs.existsSync(path.join(clone, 'node_modules', 'firebase-tools', 'lib', 'auth.js'))) {
  t('firebase-tools finds no default account and no credential in the isolated environment', () => {
    const authJs = path.join(clone, 'node_modules', 'firebase-tools', 'lib', 'auth.js')
    const e = buildIsolatedEnv({ root: path.join(tmp, 'ft'), base: dirty, fenceLog: path.join(tmp, 'ft.jsonl') })
    const r = spawnSync(process.execPath, ['-e', `const a=require(${JSON.stringify(authJs)});process.stdout.write(JSON.stringify({d:a.getGlobalDefaultAccount()===undefined,n:a.getAllAccounts().length}))`], { env: e, encoding: 'utf8', windowsHide: true })
    eq(r.stdout, '{"d":true,"n":0}', `stderr=${(r.stderr || '').slice(0, 120)}`)
  })
} else { skipped++; console.log('SKIP firebase-tools default-account check (set M1_RELEASE_CLONE to the clone with node_modules/firebase-tools)') }

fs.rmSync(tmp, { recursive: true, force: true })
// ---- the documented delta against the accepted fence is exactly the intended one
t('delta: the package fence differs from the accepted fence only by the documented wildcard-lookup lines', () => {
  const accepted = fs.readFileSync(path.join(HERE, '..', '..', '..', 'M1-SAFE-STOP-RECOVERY-01', 'offline-fence', 'loopback-only.cjs'), 'utf8').split('\n')
  const pkg = fs.readFileSync(path.join(HERE, 'loopback-only.cjs'), 'utf8').split('\n')
  const removed = accepted.filter(l => !pkg.includes(l)), added = pkg.filter(l => !accepted.includes(l))
  eq(removed, ["  if (!isLoopbackHost(host)) throw denied('dns-lookup', host)"])
  eq(added.length, 3)
  ok(added.some(l => l.includes('net.isIP(String(host)) === 0')) && added.filter(l => l.trimStart().startsWith('//')).length === 2, 'unexpected added lines')
})
t('delta: the recorder self-test includes the two delta cases', () => {
  const r = runSelftest(path.join(HERE, 'loopback-only.cjs'), 'recorder', [STUB])
  ok(r.status === 0 && r.total >= 33, 'total=' + r.total)
})

console.log(`S1B_FENCE_TESTS ${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail} skipped=${skipped}`)
process.exitCode = fail ? 1 : 0
