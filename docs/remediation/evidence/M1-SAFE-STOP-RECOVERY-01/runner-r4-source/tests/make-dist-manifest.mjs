// Packaging tool (run once): writes dist-staging-manifest.txt for the staging build of the release clone.
//   node tests/make-dist-manifest.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = 'D:\\projects\\finapp\\.runtime\\m1-dist-staging-714d0f91'
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const r = rel ? `${rel}/${e.name}` : e.name
  return e.isDirectory() ? walk(path.join(d, e.name), r) : [r]
})
const files = walk(DIST).sort()
const lines = files.map(r => `${createHash('sha256').update(fs.readFileSync(path.join(DIST, ...r.split('/')))).digest('hex')}  ${r}`)
fs.writeFileSync(path.join(PKG, 'dist-staging-manifest.txt'), `${lines.join('\n')}\n`)
console.log(`dist-staging-manifest.txt files=${files.length}`)
