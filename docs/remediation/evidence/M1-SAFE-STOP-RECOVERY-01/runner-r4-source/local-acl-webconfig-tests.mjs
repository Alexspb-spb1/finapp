// Local-only tests: Windows ACL guard of the private run directory and the
// fail-closed staging web-config loader. No network, no cloud, values never printed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { privateDir, verifyRunDirAcl, loadStagingWebConfig, Stop } from './m1-core.mjs'

const BASE = 'D:\\projects\\finapp\\.runtime'
// Absolute path of the staging web config, supplied by the operator (never hardcoded).
const WEB_CONFIG = process.env.M1_WEB_CONFIG
if (!WEB_CONFIG) { console.log('set M1_WEB_CONFIG to the absolute staging web config path'); process.exit(2) }
const results = []
const record = (name, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`) }
const stopsWith = (fn, needle) => { try { fn(); return false } catch (e) { return e instanceof Stop && e.message.includes(needle) } }
const stopsWithAsync = async (fn, needle) => { try { await fn(); return false } catch (e) { return e instanceof Stop && e.message.includes(needle) } }

// A1 — new run dir gets a protected ACL and verifies.
const a1 = path.join(BASE, `m1-acl-test-${Date.now()}`)
privateDir(a1, { mustExist: false })
fs.writeFileSync(path.join(a1, 'fixture.json'), '{}')
record('A1 new run dir: restricted ACL applied and verified (dir + file)', !stopsWith(() => verifyRunDirAcl(a1), 'acl'))

// A2 — an extra principal (BUILTIN\Users read) is detected.
execFileSync('icacls', [a1, '/grant', '*S-1-5-32-545:(OI)(CI)R'], { stdio: 'ignore' })
record('A2 foreign principal added -> STOP', stopsWith(() => verifyRunDirAcl(a1), 'foreign principal S-1-5-32-545'))

// A3 — a directory with inheritance enabled (plain mkdir) is refused.
const a3 = path.join(BASE, `m1-acl-inherit-${Date.now()}`)
fs.mkdirSync(a3)
record('A3 existing dir with inherited ACL -> STOP', stopsWith(() => privateDir(a3, { mustExist: true }), 'inheritance not disabled'))

// A4 — a file inside a verified dir given an extra principal is refused.
const a4 = path.join(BASE, `m1-acl-file-${Date.now()}`)
privateDir(a4, { mustExist: false })
const f4 = path.join(a4, 'fixture.json')
fs.writeFileSync(f4, '{}')
execFileSync('icacls', [f4, '/grant', '*S-1-1-0:R'], { stdio: 'ignore' })
record('A4 file readable by Everyone -> STOP', stopsWith(() => verifyRunDirAcl(a4), 'fixture.json: foreign principal S-1-1-0'))

// W1 — the real staging web config passes (projectId + reviewed preflight); nothing printed.
try {
  const cfg = await loadStagingWebConfig(WEB_CONFIG)
  record('W1 staging web config accepted', cfg.projectId === 'finapp-staging' && typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0)
} catch (e) { record('W1 staging web config accepted', false, { reason: e.message }) }

// W1b — the prepared staging build is bound to exactly that config (booleans only).
try {
  const cfg = await loadStagingWebConfig(WEB_CONFIG)
  const assets = 'D:\\projects\\finapp\\.runtime\\m1-dist-staging-714d0f91\\assets'
  const bundle = fs.readdirSync(assets).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n')
  record('W1b staging dist contains verified projectId and API key, no production id', bundle.includes(cfg.projectId) && bundle.includes(cfg.apiKey) && !bundle.includes('finapp-prod-10a83'))
} catch (e) { record('W1b staging dist bound to config', false, { reason: e.message }) }

// W2–W4 — negative configs (synthetic files in a temp dir).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-webcfg-'))
const write = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p }
record('W2 wrong projectId -> STOP', await stopsWithAsync(() => loadStagingWebConfig(write('prod.env', 'VITE_APP_ENV=staging\nVITE_FIREBASE_PROJECT_ID=finapp-prod-10a83\nVITE_FIREBASE_API_KEY=x\n')), 'not exactly finapp-staging'))
record('W3 missing api key -> STOP', await stopsWithAsync(() => loadStagingWebConfig(write('nokey.env', 'VITE_APP_ENV=staging\nVITE_FIREBASE_PROJECT_ID=finapp-staging\n')), 'api key missing'))
record('W4 right projectId but no fingerprint/config -> STOP', await stopsWithAsync(() => loadStagingWebConfig(write('nofp.env', 'VITE_APP_ENV=staging\nVITE_FIREBASE_PROJECT_ID=finapp-staging\nVITE_FIREBASE_API_KEY=x\n')), 'staging preflight'))
record('W5 relative path -> STOP', await stopsWithAsync(() => loadStagingWebConfig('relative-web-config.env'), 'explicit absolute'))
fs.rmSync(tmp, { recursive: true, force: true })

const failed = results.filter(r => !r).length
console.log(`LOCAL_ACL_WEBCONFIG_TESTS ${failed ? 'FAIL' : 'PASS'} ${results.length - failed}/${results.length}`)
console.log(`test dirs left for inspection: ${[a1, a3, a4].map(p => path.basename(p)).join(', ')}`)
process.exitCode = failed ? 1 : 0
