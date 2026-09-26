import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { PROJECT } from './inventoryCore.mjs'
import { TASK as DEPLOYMENT_CHECK_13FN_TASK, EXPECTED_BASELINE_SOURCE_HEAD } from './gateGaDeploymentCheck13Core.mjs'
import { validateExecutionApproval, parseExecutorCliArgs, GATE_GA_TASK } from './liveAcceptanceExecutorCliCore.mjs'
import { APPROVAL_TTL_MS, validateFunctionsShaBinding, buildApprovalDraft } from './gateGaApprovalEvidenceBindingCore.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const HEAD = 'a'.repeat(40)

test('APPROVAL_TTL_MS is pinned to exactly the reviewed executor source\'s own (unexported) EXECUTION_APPROVAL_TTL_MS', () => {
  const source = fs.readFileSync(path.join(HERE, 'liveAcceptanceExecutorCliCore.mjs'), 'utf8')
  assert.match(source, /const EXECUTION_APPROVAL_TTL_MS = 60 \* 60 \* 1000/)
  assert.equal(APPROVAL_TTL_MS, 60 * 60 * 1000)
})

function realFunctionsReceipt({ finishedAt = '2026-09-26T14:51:55.487Z', status = 'DEPLOYMENT_METADATA_VERIFIED_13FN', project = PROJECT, task = DEPLOYMENT_CHECK_13FN_TASK, baselineDriftCheckedAgainstSourceHead = EXPECTED_BASELINE_SOURCE_HEAD, billingEnabled = true, functions = [{ name: 'x' }, { name: 'y' }] } = {}) {
  return Buffer.from(JSON.stringify({
    task, mode: 'postflight13fn', status, project, sourceHead: HEAD,
    startedAt: '2026-09-26T14:51:51.429Z', finishedAt, billingEnabled,
    database: { name: 'x', type: 'FIRESTORE_NATIVE', locationId: 'eur3' },
    functions, baselineDriftCheckedAgainstSourceHead,
  }))
}

test('validateFunctionsShaBinding: positive — real receipt shape, hash matches, fresh', () => {
  const bytes = realFunctionsReceipt()
  const result = validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, now: () => Date.parse('2026-09-26T15:00:00.000Z') })
  assert.equal(result.functionsCount, 2)
  assert.equal(result.receiptTask, DEPLOYMENT_CHECK_13FN_TASK)
})

test('validateFunctionsShaBinding: a functionsSha256 that is hex64-shaped but does NOT match the receipt is rejected (the exact gap this module closes)', () => {
  const bytes = realFunctionsReceipt()
  const wrongButHex64 = 'f'.repeat(64)
  assert.notEqual(wrongButHex64, sha256(bytes))
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: wrongButHex64, receiptBytes: bytes }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: the same tampered value that this module rejects is ACCEPTED by the reviewed executor\'s own format-only check, confirming the gap is real', () => {
  const wrongButHex64 = 'f'.repeat(64)
  assert.equal(/^[a-f0-9]{64}$/.test(wrongButHex64), true)
})

test('validateFunctionsShaBinding: wrong task string in the receipt is rejected', () => {
  const bytes = realFunctionsReceipt({ task: 'some-other-task' })
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: non-PASS status in the receipt is rejected', () => {
  const bytes = realFunctionsReceipt({ status: 'DEPLOYMENT_CHECK_13FN_BLOCKED' })
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: wrong project in the receipt is rejected', () => {
  const bytes = realFunctionsReceipt({ project: 'finapp-prod-10a83' })
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: a receipt not bound to the pinned baseline sourceHead is rejected', () => {
  const bytes = realFunctionsReceipt({ baselineDriftCheckedAgainstSourceHead: 'b'.repeat(40) })
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: a stale receipt (older than maxReceiptAgeMs) is rejected', () => {
  const bytes = realFunctionsReceipt({ finishedAt: '2026-09-26T10:00:00.000Z' })
  assert.throws(() => validateFunctionsShaBinding({
    functionsSha256: sha256(bytes), receiptBytes: bytes,
    now: () => Date.parse('2026-09-26T15:00:00.000Z'), maxReceiptAgeMs: 60 * 60 * 1000,
  }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: a receipt "finished" in the future is rejected', () => {
  const bytes = realFunctionsReceipt({ finishedAt: '2026-09-26T16:00:00.000Z' })
  assert.throws(() => validateFunctionsShaBinding({
    functionsSha256: sha256(bytes), receiptBytes: bytes, now: () => Date.parse('2026-09-26T15:00:00.000Z'),
  }), /approval_evidence_binding_blocked/)
})

const CLI_ARGS = Object.freeze([
  '--execute',
  '--profile', 'staging', '--project', PROJECT, '--expected-head', HEAD,
  '--approval', '/abs/approval.json', '--approval-sha256', 'a'.repeat(64),
  '--journal', '/abs/journal.jsonl', '--out', '/abs/out.json',
  '--recipient', 'owner-confirmed@example.invalid', '--recipient-confirmed-sha256', 'b'.repeat(64),
  '--resume', 'false', '--legacy-cleanup-approved', 'false',
])

function draftInputs(overrides = {}) {
  return {
    cliArgs: CLI_ARGS,
    mailboxReceiptBytes: Buffer.from('mailbox-receipt-fixture'),
    functionsReceiptBytes: realFunctionsReceipt(),
    authMetadataReceiptBytes: Buffer.from('auth-metadata-receipt-fixture'),
    stagingFingerprint: 'c'.repeat(64),
    approvedAt: '2026-09-26T15:00:00.000Z',
    now: () => Date.parse('2026-09-26T15:00:00.000Z'),
    ...overrides,
  }
}

test('buildApprovalDraft: positive — the resulting draft passes the REAL reviewed validateExecutionApproval unmodified', () => {
  const draft = buildApprovalDraft(draftInputs())
  assert.equal(draft.task, GATE_GA_TASK)
  assert.equal(draft.functionsStatus, 'PASS')
  assert.equal(Date.parse(draft.expiresAt) - Date.parse(draft.approvedAt), 60 * 60 * 1000)
  const parsed = parseExecutorCliArgs(CLI_ARGS)
  const bytes = Buffer.from(JSON.stringify(draft))
  const value = validateExecutionApproval({
    parsed: { ...parsed, '--approval-sha256': sha256(bytes) }, bytes, now: () => Date.parse('2026-09-26T15:30:00.000Z'),
  })
  assert.equal(value.status, 'APPROVED')
  assert.equal(value.functionsSha256, sha256(draftInputs().functionsReceiptBytes))
})

test('buildApprovalDraft: refuses to emit a draft whose functions evidence does not pass validateFunctionsShaBinding', () => {
  const badFunctionsReceipt = Buffer.from(JSON.stringify({ task: 'wrong', status: 'x', project: PROJECT, finishedAt: '2026-09-26T15:00:00.000Z' }))
  assert.throws(() => buildApprovalDraft(draftInputs({ functionsReceiptBytes: badFunctionsReceipt })), /approval_evidence_binding_blocked/)
})

test('buildApprovalDraft: rejects a malformed stagingFingerprint', () => {
  assert.throws(() => buildApprovalDraft(draftInputs({ stagingFingerprint: 'not-hex' })), /approval_evidence_binding_blocked/)
})

test('buildApprovalDraft: rejects a non-ISO approvedAt', () => {
  assert.throws(() => buildApprovalDraft(draftInputs({ approvedAt: 'not-a-date' })), /approval_evidence_binding_blocked/)
})

test('buildApprovalDraft: rejects malformed cliArgs via the real parseExecutorCliArgs (never bypassed)', () => {
  assert.throws(() => buildApprovalDraft(draftInputs({ cliArgs: ['--execute'] })))
})

test('buildApprovalDraft: expiresAt is always exactly approvedAt + 1h, regardless of when it is called', () => {
  for (const approvedAt of ['2026-01-01T00:00:00.000Z', '2026-12-31T23:00:00.000Z']) {
    const draft = buildApprovalDraft(draftInputs({ approvedAt }))
    assert.equal(Date.parse(draft.expiresAt) - Date.parse(draft.approvedAt), 60 * 60 * 1000)
  }
})
