// Copies sanitized evidence of the latest local rehearsal run of each case into <pkg>/results/rehearsal/.
// Kept: orchestrator result/journal/state, CI output, readiness attempts + result, the local state/provenance
// check reports, the read-only state reports, run-inspect output, rollback wrapper exit.json + stub logs,
// stub invocation logs, the smoke run journal and result files.
// Never copied: fixture.json (synthetic passwords), Rules sources (rollback rules, backups), screenshots.
// Sanitizing (fail closed): every copied .json/.jsonl is parsed; credential-named keys (password, token, ...) are DROPPED
// structurally (the key and its value) instead of being left for the final secret scan to trip over. A file that cannot be
// parsed aborts the collection (.json) - except single journal LINES of a .jsonl file that are not JSON (the corruption scenarios corrupt
// them on purpose): such a line is kept verbatim only if it contains none of the secret patterns, otherwise it is withheld and counted.
// The source rehearsal files are never modified.
// Usage: node tests/collect-results.mjs --base <rehearsal root> [--out <pkg>/results/rehearsal]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The same patterns as the final result scan (tooling/results-tools.mjs); a test pins the equality.
export const SECRET_LIKE = /M1![A-Za-z0-9_-]{20,}|"password"\s*:|AIza[0-9A-Za-z_-]{30,}|Bearer [A-Za-z0-9._-]{20,}|refresh_token/
export const CREDENTIAL_KEY = /^(password|passwd|pwd|secret|client_?secret|api_?key|id_?token|access_?token|refresh_?token|authorization|bearer|private_?key)$/i

// Returns a copy of `value` without credential-named keys; `stats.dropped[name]` counts what was removed (names only, never values).
export function dropCredentialKeys(value, stats) {
  if (Array.isArray(value)) return value.map(v => dropCredentialKeys(v, stats))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(k)) { stats.dropped[k.toLowerCase()] = (stats.dropped[k.toLowerCase()] || 0) + 1; continue }
      out[k] = dropCredentialKeys(v, stats)
    }
    return out
  }
  return value
}

// Sanitized text of a .json/.jsonl file, or null when nothing had to be dropped (the original bytes are then copied unchanged).
export function sanitizeEvidenceText(name, text, stats) {
  const state = () => JSON.stringify([stats.dropped, stats.withheldLines || 0])
  const before = state()
  const fail = () => { throw new Error(`UNPARSEABLE_EVIDENCE_FILE ${name}`) }
  let out
  if (/\.jsonl$/i.test(name)) {
    const lines = text.split('\n')
    out = lines.map(line => {
      if (!line.trim()) return line
      let v
      try { v = JSON.parse(line) } catch {
        if (!SECRET_LIKE.test(line)) return line
        stats.withheldLines = (stats.withheldLines || 0) + 1
        return JSON.stringify({ withheldUnparseableLine: true, length: line.length })
      }
      return JSON.stringify(dropCredentialKeys(v, stats))
    }).join('\n')
  } else if (/\.json$/i.test(name)) {
    let v; try { v = JSON.parse(text) } catch { fail() }
    out = JSON.stringify(dropCredentialKeys(v, stats), null, 2) + '\n'
  } else return null
  return state() === before ? null : out
}

export function collect({ pkg, base, out }) {
  if (!base || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new Error('COLLECT_BASE_MISSING')
  const resultsRoot = path.resolve(pkg, 'results')
  const OUT = path.resolve(out || path.join(resultsRoot, 'rehearsal'))
  if (OUT === resultsRoot || !OUT.startsWith(resultsRoot + path.sep)) throw new Error('COLLECT_OUT_OUTSIDE_PACKAGE_RESULTS')
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const cases = new Map()
  for (const d of fs.readdirSync(base)) {
    const m = d.match(/^(.+)-(\d{8}-\d{6}-\d{3})$/)
    if (!m || !fs.existsSync(path.join(base, d, 'orchestrator-result.json'))) continue
    if (!cases.has(m[1]) || cases.get(m[1]) < d) cases.set(m[1], d)
  }
  const KEEP = [/^orchestrator-(result|journal|state)\.json(l)?$/, /^ci-check\.json$/, /^run-inspect-.+\.json$/, /^prior-provenance\.json$/, /^state-check-.+\.json$/,
    /^m1-stg-.+\.jsonl$/, /^m1-stg-functions-state-(pre|final)-r3\.json$/]
  const stats = { files: 0, sanitizedFiles: 0, dropped: {} }
  for (const [, dir] of [...cases].sort()) {
    const src = path.join(base, dir), dst = path.join(OUT, dir)
    fs.mkdirSync(dst, { recursive: true })
    const copy = (from, to) => {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      const clean = /\.jsonl?$/i.test(from) ? sanitizeEvidenceText(path.basename(from), fs.readFileSync(from, 'utf8'), stats) : null
      if (clean === null) fs.copyFileSync(from, to); else { fs.writeFileSync(to, clean); stats.sanitizedFiles++ }
      stats.files++
    }
    for (const f of fs.readdirSync(src)) {
      const p = path.join(src, f)
      if (fs.statSync(p).isFile() && KEEP.some(r => r.test(f))) copy(p, path.join(dst, f))
      if (f === 'deploy-rules' || f === 'deploy-rules-rollback' || f === 'readiness' || f === 'm1-stg-firestore-export-r3') for (const g of fs.readdirSync(p)) copy(path.join(p, g), path.join(dst, f, g))
    }
    for (const f of ['invocations.jsonl', 'smoke-args.jsonl', 'network-attempts.jsonl']) if (fs.existsSync(path.join(src, 'stub-state', f))) copy(path.join(src, 'stub-state', f), path.join(dst, 'stub-state', f))
    const run = path.join(src, 'run')
    if (fs.existsSync(run)) for (const f of fs.readdirSync(run)) if (/^(journal\.jsonl|result-.+\.json|recovery-manifest-.+\.json|inventory-.+\.json|ui-requests-.+\.jsonl|ui-r3-requests-.+\.jsonl)$/.test(f)) copy(path.join(run, f), path.join(dst, 'run', f))
    const consoleFile = path.join(base, '_console', `${dir}.stdout.txt`)
    if (fs.existsSync(consoleFile)) copy(consoleFile, path.join(dst, 'console.stdout.txt'))
  }
  return { cases: cases.size, ...stats }
}

function main() {
  const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
  const r = collect({ pkg: PKG, base: arg('--base'), out: arg('--out') })
  const dropped = Object.entries(r.dropped).map(([k, n]) => `${k}:${n}`).join(',') || '-'
  console.log(`collected cases=${r.cases} files=${r.files} sanitizedFiles=${r.sanitizedFiles} droppedCredentialKeys=${dropped} withheldUnparseableLines=${r.withheldLines || 0}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main() } catch (e) { console.error(`COLLECT_FAILED ${e.message}`); process.exitCode = 1 }
}
