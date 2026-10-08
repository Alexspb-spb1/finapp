// Writes CODE-SHA256SUMS.txt for every executable/test/stub file of the package
// (everything except the sums file itself and generated results). Local only.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXCLUDE = new Set(['CODE-SHA256SUMS.txt'])
const EXCLUDE_DIRS = new Set(['results'])
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const r = rel ? `${rel}/${e.name}` : e.name
  if (e.isDirectory()) return EXCLUDE_DIRS.has(r) ? [] : walk(path.join(d, e.name), r)
  return EXCLUDE.has(r) ? [] : [r]
})
const files = walk(root).sort()
const lines = files.map(r => `${createHash('sha256').update(fs.readFileSync(path.join(root, ...r.split('/')))).digest('hex')}  ${r}`)
fs.writeFileSync(path.join(root, 'CODE-SHA256SUMS.txt'), `${lines.join('\n')}\n`)
console.log(`CODE-SHA256SUMS.txt files=${files.length}`)
