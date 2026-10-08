// Collects the SANITIZED evidence of a rehearsal run (tooling/run-s1b-rehearsal.mjs) into rehearsal-results/ and refuses to finish unless the accepted secret-pattern
// and user-name scans pass. Copied: the harness result, observed request counts, fence self-test results, the suite outputs, and per scenario the flow's own
// result/state/journal (never the smoke run directory: fixture, manifests, ACL-protected files). Nothing is edited by hand.
//   node collect-s1b-rehearsal.mjs --out-dir <harness out dir> --dest <new dir> [--name <os user name>]
import fs from 'node:fs'
import path from 'node:path'
import { scanSecrets, scanUserNames, redactUserNames, currentUserNames } from '../../M1-SAFE-STOP-RECOVERY-01/tooling/results-tools.mjs'

const argv = process.argv.slice(2)
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const outDir = arg('--out-dir'), dest = arg('--dest')
const names = argv.flatMap((a, i) => argv[i - 1] === '--name' ? [a] : [])
const userNames = names.length ? names : currentUserNames()
const REHEARSAL_BASE = 'D:\\projects\\finapp\\.runtime\\m1-s1b-rehearsal'
if (!outDir || !dest || !path.isAbsolute(dest)) { console.error('USAGE'); process.exit(2) }
if (fs.existsSync(dest)) { console.error('DEST_EXISTS'); process.exit(2) }
fs.mkdirSync(dest, { recursive: true })
const result = JSON.parse(fs.readFileSync(path.join(outDir, 'rehearsal-result.json'), 'utf8'))
let files = 0
// Text outputs are normalized to end with exactly one newline (the harness joins stdout and stderr, which leaves blank lines at the end); JSON/JSONL are copied unchanged.
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (/\.txt$/i.test(from)) fs.writeFileSync(to, `${fs.readFileSync(from, 'utf8').replace(/[\s]+$/, '')}\n`); else fs.copyFileSync(from, to)
  files++
}
for (const f of fs.readdirSync(outDir)) if (/^(rehearsal-result|observed-requests|fence-selftest-.+)\.json$|^suite-.+\.stdout\.txt$/.test(f)) copy(path.join(outDir, f), path.join(dest, f))
for (const s of result.scenarios) {
  if (!s.evidenceDir) continue
  const src = path.join(REHEARSAL_BASE, s.evidenceDir)
  for (const f of ['s1b-result.json', 's1b-state.json', 's1b-journal.jsonl']) if (fs.existsSync(path.join(src, f))) copy(path.join(src, f), path.join(dest, 'scenarios', s.name, f))
}
const redacted = redactUserNames(dest, userNames)
const secrets = scanSecrets(dest), users = scanUserNames(dest, userNames)
console.log(`S1B_REHEARSAL_COLLECTED files=${files} redactedFiles=${redacted} secretPatternHits=${secrets.length} userNameHits=${users.length}`)
process.exitCode = secrets.length || users.length ? 2 : 0
