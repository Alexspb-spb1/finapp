// Copies sanitized evidence of the latest local rehearsal run of each case into results/rehearsal/.
// Kept: orchestrator result/journal/state, CI output, readiness attempts + result, the local state/provenance
// check reports, the read-only state reports, run-inspect output, rollback wrapper exit.json + stub logs,
// stub invocation logs, the smoke run journal and result files.
// Never copied: fixture.json (synthetic passwords), Rules sources (rollback rules, backups), screenshots.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'D:\\projects\\finapp\\.runtime\\m1-r4-rehearsal'
const OUT = path.join(PKG, 'results', 'rehearsal')
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const cases = new Map()
for (const d of fs.readdirSync(BASE)) {
  const m = d.match(/^(.+)-(\d{8}-\d{6}-\d{3})$/)
  if (!m || !fs.existsSync(path.join(BASE, d, 'orchestrator-result.json'))) continue
  if (!cases.has(m[1]) || cases.get(m[1]) < d) cases.set(m[1], d)
}
const KEEP = [/^orchestrator-(result|journal|state)\.json(l)?$/, /^ci-check\.json$/, /^run-inspect-.+\.json$/, /^prior-provenance\.json$/, /^state-check-.+\.json$/,
  /^m1-stg-.+\.jsonl$/, /^m1-stg-functions-state-(pre|final)-r3\.json$/]
let files = 0
for (const [name, dir] of [...cases].sort()) {
  const src = path.join(BASE, dir), dst = path.join(OUT, dir)
  fs.mkdirSync(dst, { recursive: true })
  const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); files++ }
  for (const f of fs.readdirSync(src)) {
    const p = path.join(src, f)
    if (fs.statSync(p).isFile() && KEEP.some(r => r.test(f))) copy(p, path.join(dst, f))
    if (f === 'deploy-rules' || f === 'deploy-rules-rollback' || f === 'readiness' || f === 'm1-stg-firestore-export-r3') for (const g of fs.readdirSync(p)) copy(path.join(p, g), path.join(dst, f, g))
  }
  for (const f of ['invocations.jsonl', 'smoke-args.jsonl', 'network-attempts.jsonl']) if (fs.existsSync(path.join(src, 'stub-state', f))) copy(path.join(src, 'stub-state', f), path.join(dst, 'stub-state', f))
  const run = path.join(src, 'run')
  if (fs.existsSync(run)) for (const f of fs.readdirSync(run)) if (/^(journal\.jsonl|result-.+\.json|recovery-manifest-.+\.json|inventory-.+\.json|ui-requests-.+\.jsonl|ui-r3-requests-.+\.jsonl)$/.test(f)) copy(path.join(run, f), path.join(dst, 'run', f))
  const consoleFile = path.join(BASE, '_console', `${dir}.stdout.txt`)
  if (fs.existsSync(consoleFile)) copy(consoleFile, path.join(dst, 'console.stdout.txt'))
}
console.log(`collected cases=${cases.size} files=${files}`)
