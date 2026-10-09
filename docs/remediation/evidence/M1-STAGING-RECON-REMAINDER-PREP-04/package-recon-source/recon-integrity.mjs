// M1-STAGING-READONLY-RECON-PREP-03 (corrections V1, CR1) - byte integrity of THIS package against its owner-bound manifest CODE-SHA256SUMS.txt.
// The one-use permit binds a reading to the sha256 of CODE-SHA256SUMS.txt; that alone does not prove that the files on disk are the listed ones. This module compares the ACTUAL
// bytes of every file of the package (code, helpers, pins, fence, tests) with the manifest. `execute` runs it before the namespace claim, before any credential read and before any
// request; `selftest` runs the very same function. Pure local reads: no network, no credential, no write.
//
// It refuses (closed, path-only messages - never file content):
//   - a missing / unreadable / malformed / duplicated manifest, or a manifest that does not list a REQUIRED file;
//   - a listed file that is missing, is not a regular file, or whose sha256 differs;
//   - a file in the package directory that the manifest does not list (an unlisted helper cannot ride along);
//   - a relative import of a code file that the manifest does not list, or a non-`node:` (third-party) dependency in the code.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const SUMS_FILE = 'CODE-SHA256SUMS.txt'
/** Files without which a manifest is not a manifest of this package (entry point, engine, helpers, pins, fence). */
export const REQUIRED_FILES = Object.freeze([
  'recon.mjs', 'recon-core.mjs', 'recon-pins.mjs', 'recon-permit.mjs', 'recon-bootstrap.mjs', 'recon-integrity.mjs', 'recon-offline.mjs', 'm1-state-lib.mjs',
  'request-allowlist.json', 'frontend-allowlist.json', 'consumed-subject-pin.json', 'expected-state-r3.json', 'dist-staging-manifest.txt',
  'offline-fence/FENCE-PINS.json', 'offline-fence/loopback-only.cjs', 'offline-fence/isolated-env.mjs'
])
const LINE = /^([0-9a-f]{64}) {2}([A-Za-z0-9_.][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)*)$/
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export function parseSums(text) {
  const rows = []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const l of lines) {
    const m = LINE.exec(l)
    if (!m || m[2].split('/').some(s => s === '.' || s === '..')) return null
    rows.push({ sha256: m[1], rel: m[2] })
  }
  return rows
}

const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const r = rel ? `${rel}/${e.name}` : e.name
  return e.isDirectory() ? walk(path.join(dir, e.name), r) : [r]
})
// static imports / re-exports, side-effect imports, dynamic import() and require(); a method call such as Buffer.from('x') is not an import
const SPECIFIERS = [
  /^\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"\n]+)['"]/gm, /^\s*import\s*['"]([^'"\n]+)['"]/gm,
  /(?:^|[^\w.$])import\s*\(\s*['"]([^'"\n]+)['"]/gm, /(?:^|[^\w.$])require\s*\(\s*['"]([^'"\n]+)['"]/gm
]

/** Problems of the package directory against its manifest. [] = every listed byte is the actual byte and nothing else is in the directory. */
export function integrityProblems(dir) {
  let text
  try { text = fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8') } catch { return ['manifest unreadable'] }
  const rows = parseSums(text)
  if (!rows || rows.length === 0) return ['manifest malformed']
  const problems = []
  const listed = new Map()
  for (const r of rows) { if (listed.has(r.rel)) problems.push(`manifest lists ${r.rel} twice`); listed.set(r.rel, r.sha256) }
  for (const f of REQUIRED_FILES) if (!listed.has(f)) problems.push(`required file not listed: ${f}`)
  for (const [rel, want] of listed) {
    const file = path.join(dir, ...rel.split('/'))
    let bytes = null
    try { if (!fs.lstatSync(file).isFile()) { problems.push(`not a regular file: ${rel}`); continue }; bytes = fs.readFileSync(file) } catch { problems.push(`file missing: ${rel}`); continue }
    if (sha(bytes) !== want) problems.push(`code hash ${rel}`)
  }
  let present = []
  try { present = walk(dir) } catch { problems.push('package directory unreadable') }
  for (const rel of present) if (rel !== SUMS_FILE && !listed.has(rel)) problems.push(`unlisted file: ${rel}`)
  // the code the package can load: every relative import must be a listed file, nothing outside `node:` builtins may be imported
  for (const rel of listed.keys()) {
    if (rel.startsWith('tests/') || !/\.(mjs|cjs)$/.test(rel)) continue
    let src
    try { src = fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8') } catch { continue }
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    for (const spec of SPECIFIERS.flatMap(re => [...code.matchAll(re)].map(m => m[1]))) {
      if (spec.startsWith('node:')) continue
      if (!spec.startsWith('.')) { problems.push(`dependency outside the package in ${rel}`); continue }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
      if (!listed.has(target)) problems.push(`dependency not listed: ${target} (imported by ${rel})`)
    }
  }
  return problems.slice(0, 50)
}
