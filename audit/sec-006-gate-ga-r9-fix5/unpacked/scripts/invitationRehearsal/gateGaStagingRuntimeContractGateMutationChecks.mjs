// Mutation check on createGateGaStagingAdapters (gateGaStagingAdapters.mjs)
// — proves gateGaStagingRuntimeContractGateSelfTest.mjs's full-runtime
// negative test actually catches a regression back to EAGER network I/O
// at adapter-construction time, not just that the current lazy-session
// code happens to pass. FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9
// (independent audit, second follow-up pass), requirement 2. Same
// technique as the other *MutationChecks.mjs files: copy the whole
// scripts/invitationRehearsal directory, apply one deliberate literal
// defect, rerun the self-test unmodified against the mutated copy, and
// require it to now fail.
//
// The mutation inserts a real `fetch(...)` call directly inside
// createGateGaStagingAdapters, BEFORE it returns the adapter object —
// i.e. before any adapter method is ever called, before the
// orchestrator's contract gate even runs. The FIXED withFetchSpy (this
// same audit pass's item 1) is what makes this mutation catchable at
// all: the earlier, buggy withFetchSpy restored the real fetch before
// the orchestrator's ~9s real run ever executed, so an eager fetch call
// like this one would have silently hit the real network instead of the
// spy, and the test would have passed even with this defect present.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const MUTANTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-staging-contract-gate-mutants-'))
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
  const r = spawnSync(process.execPath, ['--test', path.join(dir, 'gateGaStagingRuntimeContractGateSelfTest.mjs')], { encoding: 'utf8', cwd: dir, timeout: 60_000 })
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
  const dir = copyDir('m1-eager-fetch-before-contract-gate')
  mutate(dir, 'gateGaStagingAdapters.mjs',
    "export async function createGateGaStagingAdapters({ repoRoot, io = fs, runTag, loadModule } = {}) {\n  void runTag",
    "export async function createGateGaStagingAdapters({ repoRoot, io = fs, runTag, loadModule } = {}) {\n  void runTag\n  // INJECTED MUTATION: eager network I/O at adapter-construction time,\n  // reproducing the exact regression this audit pass's item 1 guards\n  // against — a real staging build performing a network call before the\n  // orchestrator's adapter-contract gate ever runs.\n  await fetch('https://identitytoolkit.googleapis.com/v1/eager-regression-probe').catch(() => {})")
  expectFailure('M1 createGateGaStagingAdapters performs an eager fetch call before the contract gate ever runs', dir)
}

fs.rmSync(MUTANTS_ROOT, { recursive: true, force: true })
const undetected = results.filter(r => !r.detected)
console.log(`\nSUMMARY total=${results.length} detected=${results.length - undetected.length} undetected=${undetected.length}`)
if (undetected.length) { console.error('UNDETECTED:', undetected.map(r => r.mutation)); process.exitCode = 1 }
