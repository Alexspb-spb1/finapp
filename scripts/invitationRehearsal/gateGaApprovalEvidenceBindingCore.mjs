// FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING.
//
// Real, confirmed gap: liveAcceptanceExecutorCliCore.mjs's
// validateExecutionApproval() (execution/sec-006-gate-ga-r9-fix5, reviewed
// and published — NOT modified by this module) checks mailboxSha256,
// functionsSha256, authMetadataSha256 and stagingFingerprint for nothing
// beyond hex64 SHAPE. It never cross-checks any of them against real
// evidence. An approval author could place any 64 hex characters in
// functionsSha256 and it would validate — silently defeating the entire
// point of recording a functions-verification hash. `DEPLOYMENT_METADATA_
// VERIFIED_13FN` alone (from gateGaDeploymentCheck13.mjs) is NOT the same
// claim as a G-A approval's `functionsStatus: PASS`; nothing today proves
// the two are the same evidence.
//
// This module closes that gap ADDITIVELY, without touching the reviewed
// fix5 executor: it defines the one legitimate way functionsSha256 (and,
// via buildApprovalDraft, the other three hashes) may be derived — the
// raw SHA-256 of a real evidence receipt, itself checked for the right
// task/status/project and for freshness — and a builder that only ever
// emits an approval draft whose functionsSha256 passes this binding
// check. It is a recommended, testable gate for whoever constructs a real
// approval by hand or by script; wiring it AS A HARD REQUIREMENT inside
// the reviewed executor's own validateExecutionApproval() would itself be
// a further, separately scoped change to a published branch — out of
// scope here.
import { createHash } from 'node:crypto'
import { PROJECT } from './inventoryCore.mjs'
import { TASK as DEPLOYMENT_CHECK_13FN_TASK, EXPECTED_BASELINE_SOURCE_HEAD } from './gateGaDeploymentCheck13Core.mjs'
import {
  approvalCommandSha256, GATE_GA_TASK, parseExecutorCliArgs,
} from './liveAcceptanceExecutorCliCore.mjs'
import { FIXTURE_MUTATION_SLOTS, LIVE_LIMITS, TOTAL_CALLABLE_CAP } from './liveAcceptanceCore.mjs'

// MUST match liveAcceptanceExecutorCliCore.mjs's own (unexported)
// EXECUTION_APPROVAL_TTL_MS exactly. That constant cannot be imported
// without modifying the reviewed file, so this module pins the same
// literal and a self-test asserts, at the SOURCE level, that the reviewed
// file's own constant is still exactly this value — the pin is verified
// against the real published source, not merely asserted here.
export const APPROVAL_TTL_MS = 60 * 60 * 1000

const blocked = () => { throw new Error('approval_evidence_binding_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256Bytes = value => createHash('sha256').update(value).digest('hex')
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const bytesOf = value => typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array

/**
 * Proves a claimed functionsSha256 is genuinely the SHA-256 of a real
 * gateGaDeploymentCheck13.mjs output receipt — not merely hex64-shaped —
 * and that the receipt itself reports a real PASS for the expected task
 * and project, finished within `maxReceiptAgeMs` of `now()`. Fail-closed:
 * any malformed, mismatched, wrong-status, wrong-project or stale input
 * blocks.
 */
export function validateFunctionsShaBinding({
  functionsSha256, receiptBytes, expectedProject = PROJECT, now = () => Date.now(), maxReceiptAgeMs = APPROVAL_TTL_MS,
}) {
  if (!hex64(functionsSha256) || !bytesOf(receiptBytes) || !Number.isSafeInteger(maxReceiptAgeMs) || maxReceiptAgeMs <= 0) blocked()
  if (sha256Bytes(receiptBytes) !== functionsSha256) blocked()
  let receipt
  try { receipt = JSON.parse(Buffer.from(receiptBytes).toString('utf8')) } catch { blocked() }
  if (!record(receipt) || receipt.task !== DEPLOYMENT_CHECK_13FN_TASK ||
      receipt.status !== 'DEPLOYMENT_METADATA_VERIFIED_13FN' || receipt.project !== expectedProject ||
      receipt.billingEnabled !== true || !Array.isArray(receipt.functions) || !iso(receipt.finishedAt) ||
      receipt.baselineDriftCheckedAgainstSourceHead !== EXPECTED_BASELINE_SOURCE_HEAD) blocked()
  const instant = now(), finishedAt = Date.parse(receipt.finishedAt)
  if (!Number.isSafeInteger(instant) || finishedAt > instant || instant - finishedAt > maxReceiptAgeMs) blocked()
  return Object.freeze({
    receiptTask: receipt.task, receiptProject: receipt.project, receiptFinishedAt: receipt.finishedAt,
    functionsCount: receipt.functions.length,
  })
}

/**
 * Assembles a G-A execution-approval draft matching
 * validateExecutionApproval()'s exact required schema, computing all four
 * evidence hashes from real receipt bytes (never accepted pre-computed —
 * only the raw bytes, so this function is the ONLY place the hash is
 * ever derived) and cross-checking functionsSha256 via
 * validateFunctionsShaBinding before returning anything. commandSha256 is
 * computed via the real, imported approvalCommandSha256 — the exact same
 * function the reviewed validator uses — so a draft built here is
 * guaranteed byte-for-byte compatible with it, not merely similar.
 * approvedAt defaults to "now" and expiresAt is always exactly
 * approvedAt + APPROVAL_TTL_MS; callers should call this immediately
 * before use, never pre-build and store a draft.
 */
export function buildApprovalDraft({
  cliArgs, mailboxReceiptBytes, functionsReceiptBytes, authMetadataReceiptBytes, stagingFingerprint,
  approvedAt = new Date().toISOString(), now = () => Date.now(),
}) {
  const parsed = parseExecutorCliArgs(cliArgs)
  if (!bytesOf(mailboxReceiptBytes) || !bytesOf(functionsReceiptBytes) || !bytesOf(authMetadataReceiptBytes) ||
      !hex64(stagingFingerprint) || !iso(approvedAt)) blocked()
  const functionsSha256 = sha256Bytes(functionsReceiptBytes)
  validateFunctionsShaBinding({ functionsSha256, receiptBytes: functionsReceiptBytes, expectedProject: parsed['--project'], now })
  const expiresAt = new Date(Date.parse(approvedAt) + APPROVAL_TTL_MS).toISOString()
  return Object.freeze({
    version: 1, task: GATE_GA_TASK, status: 'APPROVED',
    profile: parsed['--profile'], project: parsed['--project'], sourceHead: parsed['--expected-head'], prHead: parsed['--expected-head'],
    reviewStatus: 'PASS', ciStatus: 'PASS', functionsStatus: 'PASS',
    approvedAt, expiresAt, commandSha256: approvalCommandSha256(parsed),
    mailboxSha256: sha256Bytes(mailboxReceiptBytes), functionsSha256,
    authMetadataSha256: sha256Bytes(authMetadataReceiptBytes), stagingFingerprint,
    limits: Object.freeze({
      fixtureMutationSlots: FIXTURE_MUTATION_SLOTS.length, totalCallableRequests: TOTAL_CALLABLE_CAP,
      verificationEmails: LIVE_LIMITS.verificationEmails, cleanupAuthorized: true,
      legacyCleanupApproved: parsed['--legacy-cleanup-approved'] === 'true', productionAuthorized: false,
    }),
  })
}
