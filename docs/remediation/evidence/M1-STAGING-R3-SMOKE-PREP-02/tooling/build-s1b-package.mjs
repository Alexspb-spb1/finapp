// Generator of the S1b candidate package: copies the reviewed source tree (package-s1b-source/) into a NEW local namespace directory and rebuilds
// CODE-SHA256SUMS.txt with the package's own tests/make-code-sums.mjs. The result must be byte-identical to the committed source (the committed
// CODE-SHA256SUMS.txt must equal the rebuilt one), otherwise the build fails. The target directory must not exist (immutable candidate, never overwritten).
//   node build-s1b-package.mjs --out <new dir, e.g. D:\projects\finapp\.runtime\m1-s1b-staging> [--update-sums]
// --update-sums rewrites the sums file inside the committed source tree (used while the source is being edited, never on the final build).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SOURCE = path.resolve(HERE, '..', 'package-s1b-source')
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name])

export function buildPackage(out, { updateSums = false } = {}) {
  if (!out || !path.isAbsolute(out)) throw new Error('OUT_MUST_BE_ABSOLUTE')
  if (fs.existsSync(out)) throw new Error('OUT_EXISTS (the candidate is immutable and never overwritten)')
  fs.mkdirSync(out, { recursive: true })
  for (const rel of walk(SOURCE)) {
    if (rel === 'CODE-SHA256SUMS.txt') continue
    fs.mkdirSync(path.dirname(path.join(out, ...rel.split('/'))), { recursive: true })
    fs.copyFileSync(path.join(SOURCE, ...rel.split('/')), path.join(out, ...rel.split('/')))
  }
  const r = spawnSync(process.execPath, [path.join(out, 'tests', 'make-code-sums.mjs')], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error('MAKE_CODE_SUMS_FAILED')
  const built = path.join(out, 'CODE-SHA256SUMS.txt')
  const committed = path.join(SOURCE, 'CODE-SHA256SUMS.txt')
  if (updateSums) fs.copyFileSync(built, committed)
  if (!fs.existsSync(committed) || sha(built) !== sha(committed)) throw new Error('SUMS_DIFFER_FROM_COMMITTED_SOURCE')
  const files = walk(out)
  return { files: files.length, sumsSha256: sha(built), listed: fs.readFileSync(built, 'utf8').split('\n').filter(Boolean).length }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) {
  const argv = process.argv.slice(2)
  const out = argv[argv.indexOf('--out') + 1]
  try {
    const r = buildPackage(path.resolve(out), { updateSums: argv.includes('--update-sums') })
    console.log(`S1B_PACKAGE_BUILT out=${path.basename(out)} files=${r.files} listedInSums=${r.listed} codeSumsSha256=${r.sumsSha256}`)
  } catch (e) { console.error(`S1B_PACKAGE_BUILD_FAILED ${e.message}`); process.exitCode = 1 }
}
