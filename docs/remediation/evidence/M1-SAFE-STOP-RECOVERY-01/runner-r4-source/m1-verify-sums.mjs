#!/usr/bin/env node
// FINAPP-1.0-M1 R3 (unchanged from rev7) — verifies a SHA256SUMS-style file (`<sha256>  <relative path>`) and,
// optionally, a dist manifest against a directory. Local only.
//
//   node m1-verify-sums.mjs --sums <abs file> --root <abs dir>
//   node m1-verify-sums.mjs --manifest <abs file> --dist <abs dir>
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2), o = {}
for (let i = 0; i < args.length; i += 2) o[args[i]] = args[i + 1]
const sha = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex')
try {
  const [listFile, root, label] = o['--sums'] ? [o['--sums'], o['--root'], 'SUMS'] : [o['--manifest'], o['--dist'], 'MANIFEST']
  if (args.length !== 4 || !path.isAbsolute(listFile ?? '') || !path.isAbsolute(root ?? '') || !fs.existsSync(listFile) || !fs.existsSync(root)) throw new Error('usage')
  const lines = fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean)
  const problems = []
  const listed = new Set()
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/)
    if (!m || m[2].includes('..') || path.isAbsolute(m[2])) { problems.push(`bad line: ${line.slice(0, 80)}`); continue }
    const file = path.join(root, ...m[2].split('/'))
    listed.add(path.resolve(file).toLowerCase())
    if (!fs.existsSync(file)) problems.push(`missing ${m[2]}`)
    else if (sha(file) !== m[1]) problems.push(`hash mismatch ${m[2]}`)
  }
  if (label === 'MANIFEST') {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
    for (const f of walk(root)) if (!listed.has(path.resolve(f).toLowerCase())) problems.push(`unlisted ${path.relative(root, f)}`)
  }
  if (!lines.length) problems.push('empty list')
  if (problems.length) throw new Error(problems.join('; '))
  console.log(`M1_${label}_VERIFIED files=${lines.length}`)
} catch (e) {
  console.log(`M1_SUMS_STOP ${e.message}`)
  process.exitCode = 2
}
