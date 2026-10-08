// Packaging tool: rewrites every package .ps1 as UTF-8 with exactly one BOM. Refuses non-ASCII content.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'results' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)])
let n = 0
for (const f of walk(root).filter(f => f.endsWith('.ps1'))) {
  let buf = fs.readFileSync(f)
  while (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3)
  if (buf.some(b => b > 0x7f)) { console.error(`non-ASCII content in ${path.relative(root, f)}`); process.exit(2) }
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]))
  n++
}
console.log(`ps1 files normalized with BOM: ${n}`)
