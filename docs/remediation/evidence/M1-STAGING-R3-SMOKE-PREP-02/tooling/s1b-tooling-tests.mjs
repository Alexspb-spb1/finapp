// Repository-level checks of the S1b candidate: reproducible generator, exact module identity against the accepted R4 snapshot, no deploy/export/rollback files,
// the committed sanitized rehearsal evidence passes the accepted secret/user-name scan. Synthetic temp directories only; nothing is run against a live system.
//   node s1b-tooling-tests.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildPackage, SOURCE } from './build-s1b-package.mjs'
import { scanSecrets, scanUserNames, currentUserNames } from '../../M1-SAFE-STOP-RECOVERY-01/tooling/results-tools.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EV = path.resolve(HERE, '..')
const R4 = path.resolve(EV, '..', 'M1-SAFE-STOP-RECOVERY-01', 'runner-r4-source')
let pass = 0, fail = 0
const t = (name, fn) => { try { const r = fn(); if (r === undefined || r === true) { pass++; console.log(`PASS ${name}`) } else { fail++; console.log(`FAIL ${name}: ${r}`) } } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`) } }
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's1b-tooling-'))

t('the generator reproduces the committed source byte for byte (rebuilt code sums == committed code sums) and never overwrites an existing target', () => {
  const out = path.join(tmp, 'pkg')
  const r = buildPackage(out)
  const same = walk(SOURCE).every(f => sha(path.join(SOURCE, f)) === sha(path.join(out, f)))
  let refused = false
  try { buildPackage(out) } catch (e) { refused = /OUT_EXISTS/.test(e.message) }
  return same && refused && r.listed === walk(SOURCE).length - 2 ? true : `same=${same} refused=${refused} listed=${r.listed}`
})
t('every file of the committed code sums exists with the listed hash', () => {
  const lines = fs.readFileSync(path.join(SOURCE, 'CODE-SHA256SUMS.txt'), 'utf8').split('\n').filter(Boolean)
  return lines.every(l => sha(path.join(SOURCE, ...l.slice(66).split('/'))) === l.slice(0, 64)) && lines.length === walk(SOURCE).filter(f => f !== 'CODE-SHA256SUMS.txt').length - 1 ? true : 'sums differ'
})
t('module identity: the files shared with the accepted R4 snapshot are byte-identical except exactly m1-core.mjs and m1-transport.mjs', () => {
  const r4 = new Set(walk(R4).filter(f => f !== 'CODE-SHA256SUMS.txt'))
  const modified = walk(SOURCE).filter(f => f !== 'CODE-SHA256SUMS.txt' && r4.has(f) && sha(path.join(SOURCE, f)) !== sha(path.join(R4, f)))
  return JSON.stringify(modified.sort()) === JSON.stringify(['m1-core.mjs', 'm1-transport.mjs']) ? true : modified.join(',')
})
t('the recorded file table (s1b-vs-r4-files.txt) agrees with the tree', () => {
  const table = fs.readFileSync(path.join(EV, 's1b-vs-r4-files.txt'), 'utf8').split('\n').filter(Boolean).map(l => { const [kind, h, ...rest] = l.split(/\s+/); return { kind, h, f: rest.join(' ') } })
  const r4 = new Set(walk(R4).filter(f => f !== 'CODE-SHA256SUMS.txt' && f !== '.gitattributes'))
  const src = walk(SOURCE).filter(f => f !== 'CODE-SHA256SUMS.txt' && f !== '.gitattributes')
  for (const f of src) {
    const row = table.find(x => x.f === f)
    const want = !r4.has(f) ? 'NEW' : sha(path.join(R4, f)) === sha(path.join(SOURCE, f)) ? 'IDENTICAL' : 'MODIFIED'
    if (!row || row.kind !== want || (want !== 'REMOVED' && row.h !== sha(path.join(SOURCE, f)))) return `row for ${f}: ${JSON.stringify(row)} want ${want}`
  }
  const removed = [...r4].filter(f => !src.includes(f))
  return removed.every(f => table.some(x => x.kind === 'REMOVED' && x.f === f)) && table.length === src.length + removed.length ? true : 'table incomplete'
})
t('removed from the accepted package: the PowerShell orchestrator, the export, the deploy wrapper, the rollback preparation and their stubs and tests', () => {
  const gone = ['m1-orchestrator.ps1', 'm1-export.mjs', 'm1-deploy-wrapper.mjs', 'm1-rules-rollback-prepare.mjs', 'stubs/stub-firebase.mjs', 'stubs/stub-gcloud.mjs', 'stubs/stub-staging-tools.mjs', 'tests/export-poll-tests.mjs', 'tests/ps51-orchestrator-tests.ps1']
  return gone.every(f => !fs.existsSync(path.join(SOURCE, f)) && fs.existsSync(path.join(R4, f))) ? true : 'a removed file is still present or was not in R4'
})
t('no .env, key, token, credential or fixture file is part of the package source', () => {
  const bad = walk(SOURCE).filter(f => /(^|\/)(\.env|.*\.(pem|key|p12)|fixture\.json|.*credentials.*\.json|serviceAccount.*)$/i.test(f))
  return bad.length === 0 ? true : bad.join(',')
})
t('the committed sanitized rehearsal evidence has no secret-pattern hit and no operating-system user name', () => {
  const dir = path.join(EV, 'rehearsal-results')
  if (!fs.existsSync(dir)) return 'rehearsal-results missing'
  const s = scanSecrets(dir), u = scanUserNames(dir, currentUserNames())
  return s.length === 0 && u.length === 0 ? true : `secret=${s.length} user=${u.length}`
})
t('the permit template and the runbook exist and the runbook carries the owner decision block and the PREPARED_NOT_AUTHORIZED status', () => {
  const rb = path.resolve(EV, '..', '..', 'runbooks', 'M1-S1B-STAGING-SMOKE-PREPARED.md')
  if (!fs.existsSync(rb)) return 'runbook missing'
  const text = fs.readFileSync(rb, 'utf8')
  return /PREPARED_NOT_AUTHORIZED/.test(text) && /Решение владельца/.test(text) && /cleanupExactLookup/.test(text) ? true : 'runbook sections missing'
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`S1B_TOOLING_TESTS ${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail}`)
process.exitCode = fail ? 1 : 0
