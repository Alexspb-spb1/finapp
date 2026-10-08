// Repository-level checks of the read-only reconciliation candidate: reproducible generator, files reused byte-for-byte from the accepted S1b candidate, pins consistent with the
// accepted local evidence (read-only, hashes only), sanitized evidence scan, runbook decision block. Local files only; nothing touches a network or an owner credential.
//   node recon-tooling-tests.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildPackage, SOURCE } from './build-recon-package.mjs'
import { scanSecrets, scanUserNames, currentUserNames } from '../../M1-SAFE-STOP-RECOVERY-01/tooling/results-tools.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EV = path.resolve(HERE, '..')
const S1B = path.resolve(EV, '..', 'M1-STAGING-R3-SMOKE-PREP-02', 'package-s1b-source')
let pass = 0, fail = 0, skipped = 0
const t = (name, fn) => { try { const r = fn(); if (r === undefined || r === true) { pass++; console.log(`PASS ${name}`) } else if (r === 'SKIP') { skipped++; console.log(`SKIP ${name}`) } else { fail++; console.log(`FAIL ${name}: ${r}`) } } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`) } }
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-tooling-'))

t('the generator rebuilds the committed source byte for byte (sums equal) and never overwrites an existing target', () => {
  const out = path.join(tmp, 'pkg'); const r = buildPackage(out)
  let refused = false; try { buildPackage(out) } catch (e) { refused = /OUT_EXISTS/.test(e.message) }
  const same = walk(SOURCE).every(f => sha(path.join(SOURCE, f)) === sha(path.join(out, f)))
  return same && refused && r.listed === walk(SOURCE).length - 1 ? true : `same=${same} refused=${refused}`
})
t('every file of the committed code sums exists with the listed hash', () => {
  const lines = fs.readFileSync(path.join(SOURCE, 'CODE-SHA256SUMS.txt'), 'utf8').split('\n').filter(Boolean)
  return lines.every(l => sha(path.join(SOURCE, ...l.slice(66).split('/'))) === l.slice(0, 64)) && lines.length === walk(SOURCE).length - 1 ? true : 'sums differ'
})
t('files reused from the accepted S1b candidate are byte-identical (state lib, expected state, build manifest, the whole fence incl. its pins)', () => {
  const reused = ['m1-state-lib.mjs', 'expected-state-r3.json', 'dist-staging-manifest.txt', ...fs.readdirSync(path.join(S1B, 'offline-fence')).map(f => `offline-fence/${f}`)]
  const bad = reused.filter(f => sha(path.join(S1B, f)) !== sha(path.join(SOURCE, f)))
  return bad.length === 0 ? true : bad.join(',')
})
t('no live-adapter, deploy, export, rollback, callable, smoke or readiness code or file is part of the package (this package READS only)', () => {
  const names = walk(SOURCE)
  const badNames = names.filter(n => /(^|\/)(m1-smoke|m1-transport|m1-core|m1-ui-smoke|m1-readiness|m1-functions-check|m1-export|m1-deploy-wrapper|m1-orchestrator|m1-s1b)/.test(n))
  const code = names.filter(n => /\.(mjs|cjs)$/.test(n) && !n.startsWith('tests/') && !n.startsWith('offline-fence/') && n !== 'm1-state-lib.mjs').map(n => fs.readFileSync(path.join(SOURCE, n), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')).join('\n')
  const hits = [/firebase deploy/i, /gcloud/i, /createAuthUser|deleteAuthUser|signInWithPassword|accounts:delete/, /\bcallable\b.*POST/i].filter(re => re.test(code))
  return badNames.length === 0 && hits.length === 0 ? true : `names=${badNames} hits=${hits}`
})
t('the frontend pins equal the accepted staging build manifest for every file (15 files, .vite excluded) and the local build, when present', () => {
  const fp = JSON.parse(fs.readFileSync(path.join(SOURCE, 'frontend-allowlist.json'), 'utf8'))
  const manifest = new Map(fs.readFileSync(path.join(SOURCE, 'dist-staging-manifest.txt'), 'utf8').split('\n').filter(Boolean).map(l => [l.slice(66), l.slice(0, 64)]))
  if (fp.files.some(f => manifest.get(f.path) !== f.sha256) || fp.files.length !== 15) return 'manifest mismatch'
  const dist = 'D:\\projects\\finapp\\.runtime\\m1-dist-staging-714d0f91'
  if (!fs.existsSync(dist)) return 'SKIP'
  return fp.files.every(f => sha(path.join(dist, ...f.path.split('/'))) === f.sha256 && fs.statSync(path.join(dist, ...f.path.split('/'))).size === f.bytes) ? true : 'local build differs'
})
t('the consumed-subject pin equals the accepted local evidence (journal hash, single create of key admin, run id) - hashes only, no address is read into the output', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(SOURCE, 'consumed-subject-pin.json'), 'utf8'))
  const jp = 'D:\\projects\\finapp\\.runtime\\m1-staging-run-714d0f91-v5\\journal.jsonl'
  if (!fs.existsSync(jp)) return 'SKIP'
  const bytes = fs.readFileSync(jp)
  const events = bytes.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const pre = events.filter(e => e.event === 'PREFLIGHT_OK'), creates = events.filter(e => e.event === 'AUTH_CREATE_MAY_BE_SENT')
  const email = `m1-${pre[0]?.runId}-admin@example.invalid`
  return createHash('sha256').update(bytes).digest('hex') === pin.source.sha256 && bytes.length === pin.source.bytes && pre.length === 1 && creates.length === 1 && creates[0].key === 'admin' && pre[0].runId === pin.runId && sha256s(email) === pin.subjectSha256 ? true : 'pin differs from the evidence'
})
function sha256s(s) { return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex') }
t('the committed sanitized test evidence has no secret-pattern hit and no operating-system user name', () => {
  const dir = path.join(EV, 'test-results')
  if (!fs.existsSync(dir)) return 'test-results missing'
  const s = scanSecrets(dir), u = scanUserNames(dir, currentUserNames())
  return s.length === 0 && u.length === 0 ? true : `secret=${s.length} user=${u.length}`
})
t('the runbook exists and carries the separate owner decision block, the PREPARED_NOT_AUTHORIZED status, the bootstrap limitation and the operation table', () => {
  const rb = path.resolve(EV, '..', '..', 'runbooks', 'M1-STAGING-READONLY-RECON-PREPARED.md')
  if (!fs.existsSync(rb)) return 'runbook missing'
  const text = fs.readFileSync(rb, 'utf8')
  return ['PREPARED_NOT_AUTHORIZED', 'Решение владельца', 'authExactLookup', 'configstore', 'не входит S1b'].every(s => text.includes(s)) ? true : 'runbook sections missing'
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`RECON_TOOLING_TESTS ${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail} skipped=${skipped}`)
process.exitCode = fail ? 1 : 0
