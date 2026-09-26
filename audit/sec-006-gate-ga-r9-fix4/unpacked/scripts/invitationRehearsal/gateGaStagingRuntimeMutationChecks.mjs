// Mutation check on gateGaStagingRuntime.mjs's durableWriteJsonFile
// (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9, independent audit follow-up,
// requirement 2) — proves gateGaStagingRuntimeOutputAtomicitySelfTest.mjs
// actually catches a regression back to writing --out directly at its
// final path (the original, non-atomic R9 shape), not just that the
// current code happens to pass. Same technique as the other
// *MutationChecks.mjs files in this codebase: copy the whole
// scripts/invitationRehearsal directory, apply one deliberate literal
// defect, rerun the self-test unmodified against the mutated copy, and
// require it to now fail.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const MUTANTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-staging-runtime-mutants-'))
const results = []

function copyDir(name) {
  const dest = path.join(MUTANTS_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.cpSync(SRC, dest, { recursive: true })
  return dest
}
function mutate(dir, file, from, to) {
  const f = path.join(dir, file)
  const text = fs.readFileSync(f, 'utf8')
  if (!text.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from.slice(0, 90)}`)
  fs.writeFileSync(f, text.replace(from, () => to))
}
function runSelfTest(dir) {
  const r = spawnSync(process.execPath, ['--test', path.join(dir, 'gateGaStagingRuntimeOutputAtomicitySelfTest.mjs')], { encoding: 'utf8', cwd: dir, timeout: 30_000 })
  const fail = r.stdout.match(/ℹ fail (\d+)/)
  return { exitCode: r.status, fail: fail ? Number(fail[1]) : null }
}
function record(name, detected, detail) {
  results.push({ mutation: name, detected: Boolean(detected), detail })
  console.log(`${detected ? 'DETECTED' : 'NOT DETECTED'} ${name} ${JSON.stringify(detail)}`)
}
function expectFailure(name, dir) {
  const r = runSelfTest(dir)
  record(name, r.exitCode !== 0 || (r.fail !== null && r.fail > 0), r)
}

{
  // The exact R9-published defect this whole item exists to prevent
  // regressing to: writing directly to the final path with a bare `wx`,
  // no temp file, no rename — a kill mid-write would leave a partial
  // file sitting at the real --out path.
  const dir = copyDir('m1-out-reverts-to-direct-final-path-write')
  mutate(dir, 'gateGaStagingRuntime.mjs',
    `export function durableWriteJsonFile(filePath, value, io) {
  const bytes = Buffer.from(\`\${JSON.stringify(value, null, 2)}\\n\`, 'utf8')
  const tmp = \`\${filePath}.tmp-\${process.pid}-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 8)}\`
  const fd = io.openSync(tmp, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) offset += io.writeSync(fd, bytes, offset, bytes.length - offset)
    io.fsyncSync(fd)
  } finally { io.closeSync(fd) }
  if (!io.readFileSync(tmp).equals(bytes)) { io.unlinkSync(tmp); blocked('out_reread_mismatch') }
  io.renameSync(tmp, filePath)
}`,
    `export function durableWriteJsonFile(filePath, value, io) {
  const bytes = Buffer.from(\`\${JSON.stringify(value, null, 2)}\\n\`, 'utf8')
  const fd = io.openSync(filePath, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) offset += io.writeSync(fd, bytes, offset, bytes.length - offset)
    io.fsyncSync(fd)
  } finally { io.closeSync(fd) }
  if (!io.readFileSync(filePath).equals(bytes)) blocked('out_reread_mismatch')
}`)
  expectFailure('M1 durableWriteJsonFile reverts to a direct, non-atomic write at the final --out path', dir)
}

fs.rmSync(MUTANTS_ROOT, { recursive: true, force: true })
const undetected = results.filter(r => !r.detected)
console.log(`\nSUMMARY total=${results.length} detected=${results.length - undetected.length} undetected=${undetected.length}`)
if (undetected.length) { console.error('UNDETECTED:', undetected.map(r => r.mutation)); process.exitCode = 1 }
