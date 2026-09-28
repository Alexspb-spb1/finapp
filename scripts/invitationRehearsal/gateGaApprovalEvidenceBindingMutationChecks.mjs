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
  expectFailure('M1 the core functions-hash-equality check removed', dir)
}
{
  const dir = copyDir('m2-no-checker-sourcehead-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    "receipt.sourceHead !== expectedCheckerSourceHead || receipt.billingEnabled !== true ||",
    'receipt.billingEnabled !== true ||')
  expectFailure('M2 checker sourceHead binding check removed (would accept a receipt from any checker commit)', dir)
}
{
  const dir = copyDir('m3-no-baseline-receipt-hash-binding')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'receipt.baselineDriftCheckedAgainstReceiptSha256 !== expectedBaselineReceiptSha256) blocked()',
    'false) blocked()')
  expectFailure('M3 baseline-receipt-hash binding check removed', dir)
}
{
  const dir = copyDir('m4-no-family-name-validity-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'if (!shortName || !BASELINE_CALLABLES.includes(shortName) || seenBaseline.has(shortName) ||\n          fn.driftCheckedAgainstSourceHead !== expectedBaselineSourceHead) blocked()',
    'if (false) blocked()')
  expectFailure('M4 per-entry baseline name/uniqueness/drift-binding check removed', dir)
}
{
  const dir = copyDir('m5-no-exact-set-size-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'if (seenBaseline.size !== BASELINE_CALLABLES.length || seenMemberManagement.size !== MEMBER_MANAGEMENT_CALLABLES.length) blocked()',
    'if (false) blocked()')
  expectFailure('M5 exact-13-unique-names-across-both-families check removed (the exact gap the audit found)', dir)
}
{
  const dir = copyDir('m6-no-freshness-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'at > instant || instant - at > maxReceiptAgeMs) blocked()',
    'false) blocked()')
  expectFailure('M6 shared receipt-freshness check removed (affects all three receipt types)', dir)
}
{
  const dir = copyDir('m7-drafts-skip-functions-binding-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    "  validateFunctionsShaBinding({ functionsSha256, receiptBytes: functionsReceiptBytes, expectedProject: parsed['--project'], expectedCheckerSourceHead: expectedFunctionsCheckerSourceHead, now })",
    '  void functionsSha256')
  expectFailure('M7 buildApprovalDraft no longer calls validateFunctionsShaBinding before emitting a draft', dir)
}
{
  const dir = copyDir('m8-drafts-skip-mailbox-validation')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    "  validateMailboxReceipt({ receiptBytes: mailboxReceiptBytes, expectedProject: parsed['--project'], expectedSourceHead: expectedDiscoverySourceHead, now })\n",
    '')
  expectFailure('M8 buildApprovalDraft no longer validates the mailbox receipt (would accept forged mailbox bytes)', dir)
}
{
  const dir = copyDir('m9-drafts-skip-auth-metadata-validation')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    "  validateAuthMetadataReceipt({ receiptBytes: authMetadataReceiptBytes, expectedProject: parsed['--project'], expectedSourceHead: expectedDiscoverySourceHead, now })\n",
    '')
  expectFailure('M9 buildApprovalDraft no longer validates the auth-metadata receipt (would accept forged auth bytes)', dir)
}
{
  const dir = copyDir('m13-no-full-path-check')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    "    if (fn.name !== expectedFullName) blocked()",
    '    void expectedFullName')
  expectFailure('M13 full exact function resource-path check removed (only the trailing name segment would be checked)', dir)
}
{
  const dir = copyDir('m14-functions-and-discovery-head-collapsed')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    "expectedCheckerSourceHead: expectedFunctionsCheckerSourceHead, now })",
    "expectedCheckerSourceHead: expectedDiscoverySourceHead, now })")
  expectFailure('M14 functions-checker and discovery source-head params collapsed into one (the exact gap the audit found)', dir)
}
{
  const dir = copyDir('m10-drafts-skip-owner-confirmation')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'if (ownerConfirmsApproval !== true) blocked()',
    'if (false) blocked()')
  expectFailure('M10 explicit ownerConfirmsApproval requirement removed', dir)
}
{
  const dir = copyDir('m11-drafts-skip-review-ci-status')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    "if (reviewStatus !== 'PASS' || ciStatus !== 'PASS') blocked()",
    'if (false) blocked()')
  expectFailure('M11 explicit reviewStatus/ciStatus requirement removed', dir)
}
{
  const dir = copyDir('m12-ttl-drifted-from-reviewed-source')
  mutate(dir, 'gateGaApprovalEvidenceBindingCore.mjs',
    'export const APPROVAL_TTL_MS = 60 * 60 * 1000',
    'export const APPROVAL_TTL_MS = 45 * 60 * 1000')
  expectFailure('M12 APPROVAL_TTL_MS silently drifted from the reviewed executor\'s real constant', dir)
}

fs.rmSync(MUTANTS_ROOT, { recursive: true, force: true })
const undetected = results.filter(r => !r.detected)
console.log(`\nSUMMARY total=${results.length} detected=${results.length - undetected.length} undetected=${undetected.length}`)
if (undetected.length) { console.error('UNDETECTED:', undetected.map(r => r.mutation)); process.exitCode = 1 }
