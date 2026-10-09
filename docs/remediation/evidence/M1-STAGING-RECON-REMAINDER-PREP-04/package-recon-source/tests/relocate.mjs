// Test helper (corrections V1, CR1/CR2): builds a RELOCATED COPY of the package whose runtime / rehearsal / consumed-journal roots point into a temporary directory and whose
// CODE-SHA256SUMS.txt is regenerated to match its bytes, so that the copy is a self-consistent package (it passes its own integrity check). A copy can therefore neither create or
// burn the real namespace nor read the real private journal, and a deliberate change made AFTER the relocation is the only thing that can break its integrity.
// Pure local file work: no network, no credential.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const js = s => s.replaceAll('\\', '\\\\')
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]))

export function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const a = path.join(from, e.name), b = path.join(to, e.name)
    if (e.isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b)
  }
}

/** The manifest text of a directory in the generator's format (sorted, without the manifest itself). */
export function sumsText(dir) {
  const files = walk(dir).filter(f => f !== 'CODE-SHA256SUMS.txt').sort()
  return `${files.map(f => `${sha(fs.readFileSync(path.join(dir, ...f.split('/'))))}  ${f}`).join('\n')}\n`
}
export const writeSums = dir => fs.writeFileSync(path.join(dir, 'CODE-SHA256SUMS.txt'), sumsText(dir))

/** The directory that holds the runtime / rehearsal roots of a relocated copy: a SIBLING of the package, never inside it (the byte-integrity check refuses unlisted files in the package). */
export const rootsOf = dir => `${dir}.roots`

/** Points the three filesystem roots of recon-pins.mjs into the sibling roots directory (regex based, so it also works on an already relocated copy). */
export function relocateRoots(dir) {
  const f = path.join(dir, 'recon-pins.mjs')
  const roots = rootsOf(dir)
  let s = fs.readFileSync(f, 'utf8')
  const set = (key, value) => {
    const re = new RegExp(`${key}: '[^']*'`)
    if (!re.test(s)) throw new Error(`relocate: anchor ${key} missing`)
    s = s.replace(re, () => `${key}: '${js(value)}'`)
  }
  set('runtimeRoot', path.join(roots, 'rt'))
  set('rehearsalBase', `${path.join(roots, 'rh')}\\`)
  set('consumedJournal', path.join(roots, 'rt', 'no-private-journal', 'journal.jsonl'))
  fs.writeFileSync(f, s)
}

/** A self-consistent relocated copy of `from` at `to` (roots relocated, manifest regenerated). `replace` = { 'relative/file': Buffer|string } is applied BEFORE the manifest is built. */
export function relocatedCopy(from, to, { replace = {} } = {}) {
  copyTree(from, to)
  relocateRoots(to)
  for (const [rel, bytes] of Object.entries(replace)) fs.writeFileSync(path.join(to, ...rel.split('/')), bytes)
  writeSums(to)
  return to
}
