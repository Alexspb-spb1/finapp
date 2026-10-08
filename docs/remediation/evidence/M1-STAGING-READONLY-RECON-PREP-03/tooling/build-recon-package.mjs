// Generator of the read-only reconciliation candidate: copies the reviewed source tree (package-recon-source/) into a NEW local namespace directory and (re)builds
// CODE-SHA256SUMS.txt (sha256sum -c format, sorted, without the sums file itself and without results/). The rebuilt sums must equal the committed ones. The target directory
// must not exist (immutable candidate, never overwritten).
//   node build-recon-package.mjs --out <new dir, e.g. D:\projects\finapp\.runtime\m1-recon-readonly-staging> [--update-sums]
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SOURCE = path.resolve(HERE, '..', 'package-recon-source')
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const r = rel ? `${rel}/${e.name}` : e.name
  if (e.isDirectory()) return rel === '' && e.name === 'results' ? [] : walk(path.join(d, e.name), r)
  return [r]
})

export function sumsText(dir) {
  const files = walk(dir).filter(f => f !== 'CODE-SHA256SUMS.txt').sort()
  return `${files.map(f => `${sha(path.join(dir, ...f.split('/')))}  ${f}`).join('\n')}\n`
}

export function buildPackage(out, { updateSums = false } = {}) {
  if (!out || !path.isAbsolute(out)) throw new Error('OUT_MUST_BE_ABSOLUTE')
  if (fs.existsSync(out)) throw new Error('OUT_EXISTS (the candidate is immutable and never overwritten)')
  fs.mkdirSync(out, { recursive: true })
  for (const rel of walk(SOURCE)) {
    if (rel === 'CODE-SHA256SUMS.txt') continue
    fs.mkdirSync(path.dirname(path.join(out, ...rel.split('/'))), { recursive: true })
    fs.copyFileSync(path.join(SOURCE, ...rel.split('/')), path.join(out, ...rel.split('/')))
  }
  const text = sumsText(out)
  fs.writeFileSync(path.join(out, 'CODE-SHA256SUMS.txt'), text)
  const committed = path.join(SOURCE, 'CODE-SHA256SUMS.txt')
  if (updateSums) fs.writeFileSync(committed, text)
  if (!fs.existsSync(committed) || fs.readFileSync(committed, 'utf8') !== text) throw new Error('SUMS_DIFFER_FROM_COMMITTED_SOURCE')
  const files = walk(out)
  return { files: files.length, listed: text.split('\n').filter(Boolean).length, sumsSha256: sha(path.join(out, 'CODE-SHA256SUMS.txt')) }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) {
  const argv = process.argv.slice(2)
  const out = argv[argv.indexOf('--out') + 1]
  try {
    const r = buildPackage(path.resolve(out), { updateSums: argv.includes('--update-sums') })
    console.log(`RECON_PACKAGE_BUILT out=${path.basename(out)} files=${r.files} listedInSums=${r.listed} codeSumsSha256=${r.sumsSha256}`)
  } catch (e) { console.error(`RECON_PACKAGE_BUILD_FAILED ${e.message}`); process.exitCode = 1 }
}
