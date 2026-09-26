import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { PROJECT } from './inventoryCore.mjs'
import { CALLABLES as BASELINE_CALLABLES } from './deploymentCheckCore.mjs'
import {
  TASK as DEPLOYMENT_CHECK_13FN_TASK, MEMBER_MANAGEMENT_CALLABLES,
  EXPECTED_BASELINE_SOURCE_HEAD, EXPECTED_BASELINE_RECEIPT_SHA256,
} from './gateGaDeploymentCheck13Core.mjs'
import { validateExecutionApproval, parseExecutorCliArgs, GATE_GA_TASK } from './liveAcceptanceExecutorCliCore.mjs'
import {
  APPROVAL_TTL_MS, validateFunctionsShaBinding, validateMailboxReceipt, validateAuthMetadataReceipt,
  buildApprovalDraft, parseDraftArgs,
} from './gateGaApprovalEvidenceBindingCore.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const HEAD = 'a'.repeat(40)
const CHECKER_HEAD = 'b'.repeat(40)

test('APPROVAL_TTL_MS is pinned to exactly the reviewed executor source\'s own (unexported) EXECUTION_APPROVAL_TTL_MS', () => {
  const source = fs.readFileSync(path.join(HERE, 'liveAcceptanceExecutorCliCore.mjs'), 'utf8')
  assert.match(source, /const EXECUTION_APPROVAL_TTL_MS = 60 \* 60 \* 1000/)
  assert.equal(APPROVAL_TTL_MS, 60 * 60 * 1000)
})

test('the reconstructed PROJECT_FOR_PROFILE mirrors the reviewed executor source\'s own (unexported) mapping literal exactly', () => {
  const source = fs.readFileSync(path.join(HERE, 'liveAcceptanceExecutorCliCore.mjs'), 'utf8')
  assert.match(source, /const PROJECT_FOR_PROFILE = Object\.freeze\(\{ staging: PROJECT, emulator: EMULATOR_PROJECT \}\)/)
})

// ---- realistic fixtures, matching the REAL schemas each real discovery
// script writes to disk (see gateGaDeploymentCheck13Core.mjs,
// mailboxDiscoveryCore.mjs, authVerificationShapeDiscoveryCore.mjs) ----

function functionEntry(name, family) {
  return {
    name: `projects/${PROJECT}/locations/us-central1/functions/${name}`,
    state: 'ACTIVE', generation: 2, runtime: 'nodejs22', region: 'us-central1',
    resources: { memory: '256Mi', cpu: 1, concurrency: 1, minInstances: 0, maxInstances: 1, timeoutSeconds: 60 },
    revision: `${name.toLowerCase()}-00001-abc`, build: 'projects/12345/locations/us-central1/builds/11111111-2222-3333-4444-555555555555',
    sourceKind: 'storage', sourceReferenceSha256: sha256(`${name}-source`), sourceProvenanceSha256: sha256(`${name}-provenance`),
    rollbackArtifactAvailability: 'NOT_VERIFIED', family,
    ...(family === 'baseline' ? { driftCheckedAgainstSourceHead: EXPECTED_BASELINE_SOURCE_HEAD } : {}),
  }
}
function realFunctionsReceipt(overrides = {}) {
  const functions = [
    ...BASELINE_CALLABLES.map(name => functionEntry(name, 'baseline')),
    ...MEMBER_MANAGEMENT_CALLABLES.map(name => functionEntry(name, 'member-management')),
  ]
  const base = {
    task: DEPLOYMENT_CHECK_13FN_TASK, mode: 'postflight13fn', status: 'DEPLOYMENT_METADATA_VERIFIED_13FN',
    project: PROJECT, sourceHead: CHECKER_HEAD, startedAt: '2026-09-26T14:51:51.429Z', finishedAt: '2026-09-26T14:51:55.487Z',
    billingEnabled: true, database: { name: 'x', type: 'FIRESTORE_NATIVE', locationId: 'eur3' },
    functions, baselineCallables: BASELINE_CALLABLES, memberManagementCallables: MEMBER_MANAGEMENT_CALLABLES,
    baselineDriftCheckedAgainstReceiptSha256: EXPECTED_BASELINE_RECEIPT_SHA256,
    baselineDriftCheckedAgainstSourceHead: EXPECTED_BASELINE_SOURCE_HEAD,
  }
  return Buffer.from(JSON.stringify({ ...base, ...overrides }))
}
function realMailboxReceipt(overrides = {}) {
  return Buffer.from(JSON.stringify({
    task: 'SEC-006 Stage 8 mailbox discovery', status: 'MAILBOX_DISCOVERY_COMPLETE', project: PROJECT,
    capturedAt: '2026-09-26T15:00:00.000Z', accountExists: false, account: null,
    profile: { profileExists: false, profileFieldsSha256: null }, cloudMutations: 0, emailsSent: 0,
    sourceHead: CHECKER_HEAD, ...overrides,
  }))
}
function realAuthMetadataReceipt(overrides = {}) {
  return Buffer.from(JSON.stringify({
    task: 'SEC-006 Stage 8 Auth verification-template shape discovery',
    status: 'AUTH_VERIFICATION_TEMPLATE_SHAPE_DISCOVERED', project: PROJECT, sourceHead: CHECKER_HEAD,
    observedAt: '2026-09-26T15:00:00.000Z', emailPasswordEnabled: true, userSignupDisabled: false,
    verificationMethodPresent: true, verificationTemplateMetadataPresent: true, callbackDomainPresent: true,
    metadataSha256: sha256('metadata'), ...overrides,
  }))
}
const AT = () => Date.parse('2026-09-26T15:30:00.000Z')

// ---- validateFunctionsShaBinding ----

test('validateFunctionsShaBinding: positive — a real, complete 13-function receipt', () => {
  const bytes = realFunctionsReceipt()
  const result = validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT })
  assert.equal(result.functionsCount, 13)
})

test('validateFunctionsShaBinding: a receipt with only 2 arbitrary function entries is now rejected (the exact gap the audit found)', () => {
  const bytes = Buffer.from(JSON.stringify({
    task: DEPLOYMENT_CHECK_13FN_TASK, status: 'DEPLOYMENT_METADATA_VERIFIED_13FN', project: PROJECT, sourceHead: CHECKER_HEAD,
    finishedAt: '2026-09-26T14:51:55.487Z', billingEnabled: true,
    baselineDriftCheckedAgainstSourceHead: EXPECTED_BASELINE_SOURCE_HEAD, baselineDriftCheckedAgainstReceiptSha256: EXPECTED_BASELINE_RECEIPT_SHA256,
    functions: [{ name: 'x' }, { name: 'y' }],
  }))
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: missing one baseline function (12 entries) is rejected', () => {
  const receipt = JSON.parse(realFunctionsReceipt().toString('utf8'))
  receipt.functions = receipt.functions.filter(f => !f.name.endsWith('/acceptInvite'))
  const bytes = Buffer.from(JSON.stringify(receipt))
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: a duplicated function entry (14 total) is rejected', () => {
  const receipt = JSON.parse(realFunctionsReceipt().toString('utf8'))
  receipt.functions.push({ ...receipt.functions[0] })
  const bytes = Buffer.from(JSON.stringify(receipt))
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: a substituted/foreign function name is rejected', () => {
  const receipt = JSON.parse(realFunctionsReceipt().toString('utf8'))
  const idx = receipt.functions.findIndex(f => f.name.endsWith('/acceptInvite'))
  receipt.functions[idx] = JSON.parse(JSON.stringify(functionEntry('notARealFunction', 'baseline')))
  const bytes = Buffer.from(JSON.stringify(receipt))
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: a function tagged the wrong family (baseline name marked member-management) is rejected', () => {
  const receipt = JSON.parse(realFunctionsReceipt().toString('utf8'))
  const idx = receipt.functions.findIndex(f => f.name.endsWith('/acceptInvite'))
  receipt.functions[idx].family = 'member-management'
  const bytes = Buffer.from(JSON.stringify(receipt))
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: a functionsSha256 that is hex64-shaped but does NOT match the receipt is rejected (and is exactly what the reviewed executor\'s own format-only check would accept)', () => {
  const bytes = realFunctionsReceipt()
  const wrongButHex64 = 'f'.repeat(64)
  assert.notEqual(wrongButHex64, sha256(bytes))
  assert.equal(/^[a-f0-9]{64}$/.test(wrongButHex64), true)
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: wrongButHex64, receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: wrong task / status / project on the receipt is rejected', () => {
  for (const overrides of [{ task: 'other' }, { status: 'DEPLOYMENT_CHECK_13FN_BLOCKED' }, { project: 'finapp-prod-10a83' }]) {
    const receipt = JSON.parse(realFunctionsReceipt().toString('utf8'))
    Object.assign(receipt, overrides)
    const bytes = Buffer.from(JSON.stringify(receipt))
    assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
  }
})

test('validateFunctionsShaBinding: a receipt from the wrong checker commit (sourceHead) is rejected', () => {
  const bytes = realFunctionsReceipt()
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: 'c'.repeat(40), now: AT }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: a receipt bound to the wrong baseline receipt SHA-256 is rejected', () => {
  const receipt = JSON.parse(realFunctionsReceipt().toString('utf8'))
  receipt.baselineDriftCheckedAgainstReceiptSha256 = 'd'.repeat(64)
  const bytes = Buffer.from(JSON.stringify(receipt))
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: a receipt bound to the wrong baseline sourceHead is rejected', () => {
  const receipt = JSON.parse(realFunctionsReceipt().toString('utf8'))
  receipt.baselineDriftCheckedAgainstSourceHead = 'e'.repeat(40)
  const bytes = Buffer.from(JSON.stringify(receipt))
  assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

test('validateFunctionsShaBinding: a stale or future-timestamped receipt is rejected', () => {
  for (const finishedAt of ['2026-09-26T10:00:00.000Z', '2026-09-26T16:00:00.000Z']) {
    const bytes = realFunctionsReceipt({ finishedAt })
    assert.throws(() => validateFunctionsShaBinding({ functionsSha256: sha256(bytes), receiptBytes: bytes, expectedCheckerSourceHead: CHECKER_HEAD, now: AT, maxReceiptAgeMs: 60 * 60 * 1000 }), /approval_evidence_binding_blocked/)
  }
})

// ---- validateMailboxReceipt / validateAuthMetadataReceipt ----

test('validateMailboxReceipt: positive, and wrong task/status/project/sourceHead/nonzero-mutations are rejected', () => {
  const bytes = realMailboxReceipt()
  const result = validateMailboxReceipt({ receiptBytes: bytes, expectedSourceHead: CHECKER_HEAD, now: AT })
  assert.equal(result.accountExists, false)
  for (const overrides of [{ task: 'x' }, { status: 'x' }, { project: 'x' }, { sourceHead: 'f'.repeat(40) }, { cloudMutations: 1 }, { emailsSent: 1 }, { accountExists: 'no' }]) {
    const b = realMailboxReceipt(overrides)
    assert.throws(() => validateMailboxReceipt({ receiptBytes: b, expectedSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
  }
})

test('validateMailboxReceipt: a fabricated/synthetic byte string (not this schema at all) is rejected', () => {
  const bytes = Buffer.from('totally-made-up-not-json-shaped-like-a-receipt')
  assert.throws(() => validateMailboxReceipt({ receiptBytes: bytes, expectedSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

test('validateMailboxReceipt: stale receipt is rejected', () => {
  const bytes = realMailboxReceipt({ capturedAt: '2026-09-26T10:00:00.000Z' })
  assert.throws(() => validateMailboxReceipt({ receiptBytes: bytes, expectedSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

test('validateAuthMetadataReceipt: positive, and wrong task/status/project/sourceHead/flags are rejected', () => {
  const bytes = realAuthMetadataReceipt()
  validateAuthMetadataReceipt({ receiptBytes: bytes, expectedSourceHead: CHECKER_HEAD, now: AT })
  for (const overrides of [{ task: 'x' }, { status: 'x' }, { project: 'x' }, { sourceHead: 'f'.repeat(40) }, { emailPasswordEnabled: false }, { userSignupDisabled: true }, { verificationMethodPresent: false }, { metadataSha256: 'not-hex' }]) {
    const b = realAuthMetadataReceipt(overrides)
    assert.throws(() => validateAuthMetadataReceipt({ receiptBytes: b, expectedSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
  }
})

test('validateAuthMetadataReceipt: a fabricated/synthetic byte string is rejected', () => {
  const bytes = Buffer.from('also-not-a-real-receipt')
  assert.throws(() => validateAuthMetadataReceipt({ receiptBytes: bytes, expectedSourceHead: CHECKER_HEAD, now: AT }), /approval_evidence_binding_blocked/)
})

// ---- buildApprovalDraft ----

const DRAFT_ARGS = Object.freeze([
  '--profile', 'staging', '--project', PROJECT, '--expected-head', HEAD,
  '--journal', '/abs/journal.jsonl', '--out', '/abs/executor-out.json',
  '--recipient', 'owner-confirmed@example.invalid', '--recipient-confirmed-sha256', 'b'.repeat(64),
  '--resume', 'false', '--legacy-cleanup-approved', 'false',
])

function draftInputs(overrides = {}) {
  return {
    draftArgs: DRAFT_ARGS,
    mailboxReceiptBytes: realMailboxReceipt(),
    functionsReceiptBytes: realFunctionsReceipt(),
    authMetadataReceiptBytes: realAuthMetadataReceipt(),
    stagingFingerprint: 'c'.repeat(64),
    expectedCheckerSourceHead: CHECKER_HEAD,
    reviewStatus: 'PASS', ciStatus: 'PASS', ownerConfirmsApproval: true,
    approvedAt: '2026-09-26T15:00:00.000Z',
    now: AT,
    ...overrides,
  }
}

test('buildApprovalDraft: parseDraftArgs never requires --approval or --approval-sha256 (the circular dependency this audit found is gone)', () => {
  assert.equal(DRAFT_ARGS.includes('--approval'), false)
  assert.equal(DRAFT_ARGS.includes('--approval-sha256'), false)
  const parsed = parseDraftArgs(DRAFT_ARGS)
  assert.equal(parsed['--project'], PROJECT)
})

test('buildApprovalDraft: positive — the resulting draft, combined with a --approval/--approval-sha256 pair computed AFTER the fact (exactly the real sequence an owner follows), passes the REAL reviewed validateExecutionApproval unmodified', () => {
  const draft = buildApprovalDraft(draftInputs())
  assert.equal(draft.task, GATE_GA_TASK)
  assert.equal(draft.functionsStatus, 'PASS')
  assert.equal(Date.parse(draft.expiresAt) - Date.parse(draft.approvedAt), 60 * 60 * 1000)

  // The real sequence: the draft's bytes are written, hashed, THEN a full
  // --execute argument list (now including --approval/--approval-sha256,
  // which are only known at this point) is what the real CLI parses.
  const draftBytes = Buffer.from(JSON.stringify(draft))
  const approvalSha256 = sha256(draftBytes)
  const fullExecuteArgs = [
    '--execute',
    '--profile', 'staging', '--project', PROJECT, '--expected-head', HEAD,
    '--approval', '/abs/approval.json', '--approval-sha256', approvalSha256,
    '--journal', '/abs/journal.jsonl', '--out', '/abs/executor-out.json',
    '--recipient', 'owner-confirmed@example.invalid', '--recipient-confirmed-sha256', 'b'.repeat(64),
    '--resume', 'false', '--legacy-cleanup-approved', 'false',
  ]
  const parsed = parseExecutorCliArgs(fullExecuteArgs)
  const value = validateExecutionApproval({ parsed, bytes: draftBytes, now: () => Date.parse('2026-09-26T15:30:00.000Z') })
  assert.equal(value.status, 'APPROVED')
  assert.equal(value.functionsSha256, sha256(draftInputs().functionsReceiptBytes))
})

test('buildApprovalDraft: refuses without explicit ownerConfirmsApproval === true (a string "true" or boolean false are both refused)', () => {
  for (const ownerConfirmsApproval of ['true', false, undefined]) {
    assert.throws(() => buildApprovalDraft(draftInputs({ ownerConfirmsApproval })), /approval_evidence_binding_blocked/)
  }
})

test('buildApprovalDraft: refuses reviewStatus or ciStatus other than the literal "PASS" (never inferred, always the caller\'s explicit claim)', () => {
  for (const overrides of [{ reviewStatus: 'FAIL' }, { reviewStatus: undefined }, { ciStatus: 'PENDING' }, { ciStatus: undefined }]) {
    assert.throws(() => buildApprovalDraft(draftInputs(overrides)), /approval_evidence_binding_blocked/)
  }
})

test('buildApprovalDraft: a forged (synthetic, non-schema) mailbox receipt is rejected', () => {
  assert.throws(() => buildApprovalDraft(draftInputs({ mailboxReceiptBytes: Buffer.from('fake-mailbox-data') })), /approval_evidence_binding_blocked/)
})

test('buildApprovalDraft: a forged (synthetic, non-schema) auth-metadata receipt is rejected', () => {
  assert.throws(() => buildApprovalDraft(draftInputs({ authMetadataReceiptBytes: Buffer.from('fake-auth-data') })), /approval_evidence_binding_blocked/)
})

test('buildApprovalDraft: refuses to emit a draft whose functions evidence does not pass validateFunctionsShaBinding', () => {
  const badFunctionsReceipt = Buffer.from(JSON.stringify({ task: 'wrong', status: 'x', project: PROJECT, finishedAt: '2026-09-26T15:00:00.000Z' }))
  assert.throws(() => buildApprovalDraft(draftInputs({ functionsReceiptBytes: badFunctionsReceipt })), /approval_evidence_binding_blocked/)
})

test('buildApprovalDraft: rejects a malformed stagingFingerprint / non-ISO approvedAt / malformed draftArgs', () => {
  assert.throws(() => buildApprovalDraft(draftInputs({ stagingFingerprint: 'not-hex' })), /approval_evidence_binding_blocked/)
  assert.throws(() => buildApprovalDraft(draftInputs({ approvedAt: 'not-a-date' })), /approval_evidence_binding_blocked/)
  assert.throws(() => buildApprovalDraft(draftInputs({ draftArgs: ['--profile', 'staging'] })), /approval_evidence_binding_blocked/)
})

test('buildApprovalDraft: expiresAt is always exactly approvedAt + 1h, regardless of when it is called', () => {
  for (const approvedAt of ['2026-01-01T00:00:00.000Z', '2026-12-31T23:00:00.000Z']) {
    const draft = buildApprovalDraft(draftInputs({
      approvedAt, now: () => Date.parse(approvedAt),
      mailboxReceiptBytes: realMailboxReceipt({ capturedAt: approvedAt }),
      functionsReceiptBytes: realFunctionsReceipt({ finishedAt: approvedAt }),
      authMetadataReceiptBytes: realAuthMetadataReceipt({ observedAt: approvedAt }),
    }))
    assert.equal(Date.parse(draft.expiresAt) - Date.parse(draft.approvedAt), 60 * 60 * 1000)
  }
})

// ---- full CLI-level integration: the exact commands an owner would run,
// from real files on disk, through to the REAL executor validator ----

test('CLI integration: gateGaBuildApprovalDraft.mjs, run as a real process against real files, produces a file the real validateExecutionApproval genuinely accepts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-approval-cli-integration-'))
  try {
    const mailboxPath = path.join(dir, 'mailbox.json')
    const functionsPath = path.join(dir, 'functions.json')
    const authPath = path.join(dir, 'auth.json')
    const approvalPath = path.join(dir, 'approval.json')
    fs.writeFileSync(mailboxPath, realMailboxReceipt())
    fs.writeFileSync(functionsPath, realFunctionsReceipt())
    fs.writeFileSync(authPath, realAuthMetadataReceipt())

    const result = spawnSync(process.execPath, [
      path.join(HERE, 'gateGaBuildApprovalDraft.mjs'),
      '--mailbox-receipt', mailboxPath, '--functions-receipt', functionsPath, '--auth-metadata-receipt', authPath,
      '--staging-fingerprint', 'c'.repeat(64), '--expected-checker-source-head', CHECKER_HEAD,
      '--review-status', 'PASS', '--ci-status', 'PASS', '--owner-confirms-approval', 'true',
      '--out', approvalPath,
      '--', '--profile', 'staging', '--project', PROJECT, '--expected-head', HEAD,
      '--journal', path.join(dir, 'journal.jsonl'), '--out', path.join(dir, 'executor-out.json'),
      '--recipient', 'owner-confirmed@example.invalid', '--recipient-confirmed-sha256', 'b'.repeat(64),
      '--resume', 'false', '--legacy-cleanup-approved', 'false',
    ], { encoding: 'utf8', timeout: 15_000 })

    assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`)
    assert.match(result.stdout, /APPROVAL_DRAFT_WRITTEN/)
    assert.equal(fs.existsSync(approvalPath), true)
    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
    const approvalBytes = fs.readFileSync(approvalPath)
    assert.equal(printed.approvalSha256, sha256(approvalBytes))

    const fullExecuteArgs = [
      '--execute', '--profile', 'staging', '--project', PROJECT, '--expected-head', HEAD,
      '--approval', approvalPath, '--approval-sha256', printed.approvalSha256,
      '--journal', path.join(dir, 'journal.jsonl'), '--out', path.join(dir, 'executor-out.json'),
      '--recipient', 'owner-confirmed@example.invalid', '--recipient-confirmed-sha256', 'b'.repeat(64),
      '--resume', 'false', '--legacy-cleanup-approved', 'false',
    ]
    const parsed = parseExecutorCliArgs(fullExecuteArgs)
    const value = validateExecutionApproval({ parsed, bytes: approvalBytes, now: () => Date.parse(printed.approvedAt) + 60_000 })
    assert.equal(value.status, 'APPROVED')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI integration: a forged --functions-receipt (well-formed JSON, wrong schema) is refused by the real CLI process, no approval file written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-approval-cli-integration-neg-'))
  try {
    const mailboxPath = path.join(dir, 'mailbox.json')
    const functionsPath = path.join(dir, 'functions.json')
    const authPath = path.join(dir, 'auth.json')
    const approvalPath = path.join(dir, 'approval.json')
    fs.writeFileSync(mailboxPath, realMailboxReceipt())
    fs.writeFileSync(functionsPath, JSON.stringify({ not: 'a real receipt' }))
    fs.writeFileSync(authPath, realAuthMetadataReceipt())

    const result = spawnSync(process.execPath, [
      path.join(HERE, 'gateGaBuildApprovalDraft.mjs'),
      '--mailbox-receipt', mailboxPath, '--functions-receipt', functionsPath, '--auth-metadata-receipt', authPath,
      '--staging-fingerprint', 'c'.repeat(64), '--expected-checker-source-head', CHECKER_HEAD,
      '--review-status', 'PASS', '--ci-status', 'PASS', '--owner-confirms-approval', 'true',
      '--out', approvalPath,
      '--', '--profile', 'staging', '--project', PROJECT, '--expected-head', HEAD,
      '--journal', path.join(dir, 'journal.jsonl'), '--out', path.join(dir, 'executor-out.json'),
      '--recipient', 'owner-confirmed@example.invalid', '--recipient-confirmed-sha256', 'b'.repeat(64),
      '--resume', 'false', '--legacy-cleanup-approved', 'false',
    ], { encoding: 'utf8', timeout: 15_000 })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /APPROVAL_DRAFT_BLOCKED/)
    assert.equal(fs.existsSync(approvalPath), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
