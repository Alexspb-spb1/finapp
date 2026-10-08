// Writes recon-files.txt: one line per file of package-recon-source - REUSED (byte-identical to the same path in the accepted S1b candidate source) or NEW - with its SHA-256.
// The new package is NOT a fork of S1b: its modules are new; only the state library, the pinned expected state, the build manifest and the fence are reused unchanged.
//   node make-file-table.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EV = path.resolve(HERE, '..')
const SRC = path.join(EV, 'package-recon-source')
const S1B = path.resolve(EV, '..', 'M1-STAGING-R3-SMOKE-PREP-02', 'package-s1b-source')
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name])
const lines = walk(SRC).filter(f => f !== 'CODE-SHA256SUMS.txt').sort().map(f => {
  const mine = sha(path.join(SRC, ...f.split('/')))
  const other = path.join(S1B, ...f.split('/'))
  return `${fs.existsSync(other) && sha(other) === mine ? 'REUSED' : 'NEW   '} ${mine}  ${f}`
})
fs.writeFileSync(path.join(EV, 'recon-files.txt'), `${lines.join('\n')}\n`)
console.log(`RECON_FILE_TABLE reused=${lines.filter(l => l.startsWith('REUSED')).length} new=${lines.filter(l => l.startsWith('NEW')).length}`)
