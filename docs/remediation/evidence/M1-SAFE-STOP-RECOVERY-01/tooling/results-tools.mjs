// Versioned result-evidence helpers for a candidate runner package (replaces the unversioned .runtime/results-sums.mjs and redact-results.mjs).
// Everything is bound to ONE explicit package directory: only <pkg>/results is read or written, a consumed package is refused, and
// a secret finding is reported by file + kind only (never the matched text).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Unchanged from the helper used for the earlier R4 run: it is not loosened to obtain a PASS.
export const SECRET_PATTERNS = [
  ['m1-fixture-password', /M1![A-Za-z0-9_-]{20,}/],
  ['password-key', /"password"\s*:/],
  ['google-api-key', /AIza[0-9A-Za-z_-]{30,}/],
  ['bearer-token', /Bearer [A-Za-z0-9._-]{20,}/],
  ['refresh-token', /refresh_token/]
]
export const TEXT_FILE = /\.(json|jsonl|txt|md|log)$/i
const MAX_SCAN_BYTES = 5_000_000
// Candidate packages only; the consumed R3 package (m1-r3-staging) and anything else are refused.
export const PACKAGE_NAME = /^m1-r[4-9]-[A-Za-z0-9._-]+$/

const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name])

// Throws unless `pkg` is an existing candidate package with a results directory; returns the resolved results root.
export function resolveTarget(pkg) {
  if (!pkg) throw new Error('TARGET_REQUIRED')
  const abs = path.resolve(pkg)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('TARGET_MISSING')
  if (!PACKAGE_NAME.test(path.basename(abs))) throw new Error('TARGET_NOT_A_CANDIDATE_PACKAGE')
  const results = path.join(abs, 'results')
  if (!fs.existsSync(results) || !fs.statSync(results).isDirectory()) throw new Error('TARGET_HAS_NO_RESULTS')
  return results
}

export function resultFiles(resultsRoot) { return walk(resultsRoot).filter(f => f !== 'SHA256SUMS.txt').sort() }

// Secret-pattern scan. Returns [{file, kind}] (no matched text).
export function scanSecrets(resultsRoot) {
  const hits = []
  for (const f of resultFiles(resultsRoot)) {
    const buf = fs.readFileSync(path.join(resultsRoot, f))
    if (buf.length >= MAX_SCAN_BYTES) { hits.push({ file: f, kind: 'file-too-large-to-scan' }); continue }
    const text = buf.toString('utf8')
    for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) hits.push({ file: f, kind })
  }
  return hits
}

// Names of the current operating-system user (to be removed from path fragments such as C:\Users\<name>\...). Values are never printed.
export function currentUserNames() {
  const names = new Set()
  for (const n of [os.userInfo().username, process.env.USERNAME, process.env.USER]) if (n && n.length >= 3) names.add(n)
  return [...names]
}

export function redactUserNames(resultsRoot, names) {
  let changed = 0
  for (const f of resultFiles(resultsRoot)) {
    if (!TEXT_FILE.test(f)) continue
    const p = path.join(resultsRoot, f)
    const s = fs.readFileSync(p, 'utf8')
    let t = s
    for (const n of names) t = t.split(n).join('<user>').split(encodeURIComponent(n)).join('<user>')
    if (t !== s) { fs.writeFileSync(p, t); changed++ }
  }
  return changed
}

export function scanUserNames(resultsRoot, names) {
  const hits = []
  for (const f of resultFiles(resultsRoot)) {
    if (!TEXT_FILE.test(f)) continue
    const s = fs.readFileSync(path.join(resultsRoot, f), 'utf8')
    if (names.some(n => s.includes(n) || s.includes(encodeURIComponent(n)))) hits.push({ file: f, kind: 'operating-system-user-name' })
  }
  return hits
}

export function writeSums(resultsRoot) {
  const files = resultFiles(resultsRoot)
  const lines = files.map(f => `${createHash('sha256').update(fs.readFileSync(path.join(resultsRoot, f))).digest('hex')}  ${f}`)
  fs.writeFileSync(path.join(resultsRoot, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
  return { files: files.length, sumsSha256: createHash('sha256').update(fs.readFileSync(path.join(resultsRoot, 'SHA256SUMS.txt'))).digest('hex') }
}

// Re-hash and compare with SHA256SUMS.txt: returns the list of mismatching/missing/extra files.
export function verifySums(resultsRoot) {
  const sumsPath = path.join(resultsRoot, 'SHA256SUMS.txt')
  if (!fs.existsSync(sumsPath)) return ['SHA256SUMS.txt missing']
  const listed = new Map(fs.readFileSync(sumsPath, 'utf8').split('\n').filter(Boolean).map(l => [l.slice(66), l.slice(0, 64)]))
  const problems = []
  for (const f of resultFiles(resultsRoot)) {
    const want = listed.get(f)
    if (!want) { problems.push(`unlisted ${f}`); continue }
    if (createHash('sha256').update(fs.readFileSync(path.join(resultsRoot, f))).digest('hex') !== want) problems.push(`changed ${f}`)
    listed.delete(f)
  }
  for (const f of listed.keys()) problems.push(`missing ${f}`)
  return problems
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const arg = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined }
  const given = rest.flatMap((a, i) => rest[i - 1] === '--name' ? [a] : [])
  const names = given.length ? given : currentUserNames()
  const results = resolveTarget(arg('--pkg'))
  if (cmd === 'redact') { console.log(`USER_NAME_REDACT files=${redactUserNames(results, names)}`); return }
  if (cmd === 'scan') {
    const s = scanSecrets(results), u = scanUserNames(results, names)
    console.log(`RESULTS_SCAN files=${resultFiles(results).length} secretPatternHits=${s.length} userNameHits=${u.length}${[...s, ...u].slice(0, 5).map(h => ` ${h.file}:${h.kind}`).join('')}`)
    process.exitCode = s.length || u.length ? 2 : 0
    return
  }
  if (cmd === 'sums') { const r = writeSums(results); console.log(`RESULTS_SUMS files=${r.files} sumsSha256=${r.sumsSha256}`); return }
  if (cmd === 'verify') { const p = verifySums(results); console.log(`RESULTS_SUMS_VERIFY problems=${p.length}${p.slice(0, 5).map(x => ` ${x}`).join('')}`); process.exitCode = p.length ? 2 : 0; return }
  throw new Error('USAGE results-tools.mjs <redact|scan|sums|verify> --pkg <candidate package dir> [--name <os user name>]...')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main() } catch (e) { console.error(`RESULTS_TOOLS_FAILED ${e.message}`); process.exitCode = 1 }
}
