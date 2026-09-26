// Mutation checks on gateGaApprovalEvidenceBindingCore.mjs.
// FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING. Same technique as
// every other *MutationChecks.mjs file in this directory.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const MUTANTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-approval-evidence-binding-mutants-'))
const results = []

function copyDir(name) {
  const dest = path.join(MUTANTS_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.cpSync(SRC, dest, { recursive: true })
  return dest
}
function mutate(dir, file, from, to) {
  const f = path.join(dir, file)
  const text = fs.readFileSync(f, 'utf8')
  if (!text.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from.slice(0, 100)}`)
  fs.writeFileSync(f, text.replace(from, () => to))
}
function runSelfTest(dir) {
  const r = spawnSync(process.execPath, ['--test', path.join(dir, 'gateGaApprovalEvidenceBindingSelfTest.mjs')], { encoding: 'utf8', cwd: dir, timeout: 60_000 })
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
  const dir = copyDir('m1-no-hash-match-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'if (sha256Bytes(receiptBytes) !== functionsSha256) blocked()',
    'if (false) blocked()')
  expectFailure('M1 the core hash-equality check (the whole point of this module) removed', dir)
}
{
  const dir = copyDir('m2-no-status-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    "receipt.status !== 'DEPLOYMENT_METADATA_VERIFIED_13FN' ||",
    'false ||')
  expectFailure('M2 receipt status check removed (would accept a BLOCKED receipt)', dir)
}
{
  const dir = copyDir('m3-no-task-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'receipt.task !== DEPLOYMENT_CHECK_13FN_TASK ||',
    'false ||')
  expectFailure('M3 receipt task-string check removed (would accept any unrelated JSON blob)', dir)
}
{
  const dir = copyDir('m4-no-project-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'receipt.project !== expectedProject ||',
    'false ||')
  expectFailure('M4 receipt project check removed (would accept evidence from a different project)', dir)
}
{
  const dir = copyDir('m5-no-staleness-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'if (!Number.isSafeInteger(instant) || finishedAt > instant || instant - finishedAt > maxReceiptAgeMs) blocked()',
    'if (!Number.isSafeInteger(instant)) blocked()')
  expectFailure('M5 receipt staleness/future-timestamp check removed', dir)
}
{
  const dir = copyDir('m6-no-baseline-sourcehead-binding')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'receipt.baselineDriftCheckedAgainstSourceHead !== EXPECTED_BASELINE_SOURCE_HEAD) blocked()',
    'false) blocked()')
  expectFailure('M6 pinned baseline sourceHead binding check removed', dir)
}
{
  const dir = copyDir('m7-build-draft-skips-binding-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    "  const functionsSha256 = sha256Bytes(functionsReceiptBytes)\n  validateFunctionsShaBinding({ functionsSha256, receiptBytes: functionsReceiptBytes, expectedProject: parsed['--project'], now })",
    '  const functionsSha256 = sha256Bytes(functionsReceiptBytes)')
  expectFailure('M7 buildApprovalDraft no longer calls validateFunctionsShaBinding before emitting a draft', dir)
}
{
  const dir = copyDir('m8-ttl-drifted-from-reviewed-source')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'export const APPROVAL_TTL_MS = 60 * 60 * 1000',
    'export const APPROVAL_TTL_MS = 45 * 60 * 1000')
  expectFailure('M8 APPROVAL_TTL_MS silently drifted from the reviewed executor\'s real constant', dir)
}

fs.rmSync(MUTANTS_ROOT, { recursive: true, force: true })
const undetected = results.filter(r => !r.detected)
console.log(`\nSUMMARY total=${results.length} detected=${results.length - undetected.length} undetected=${undetected.length}`)
if (undetected.length) { console.error('UNDETECTED:', undetected.map(r => r.mutation)); process.exitCode = 1 }
