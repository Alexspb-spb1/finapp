// FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING.
//
// Real, confirmed gap: liveAcceptanceExecutorCliCore.mjs's
// validateExecutionApproval() (execution/sec-006-gate-ga-r9-fix5, reviewed
// and published — NOT modified by this module) checks mailboxSha256,
// functionsSha256, authMetadataSha256 and stagingFingerprint for nothing
// beyond hex64 SHAPE. It never cross-checks any of them against real
// evidence. `DEPLOYMENT_METADATA_VERIFIED_13FN` alone (from
// gateGaDeploymentCheck13.mjs) is NOT the same claim as a G-A approval's
// `functionsStatus: PASS`; nothing before this module proved the two
// could ever be genuinely bound together.
//
// IMPORTANT — what a matching SHA-256 does and does not prove: a byte-
// equal hash proves the receipt bytes a caller supplies here are the
// exact bytes referenced by `functionsSha256`/`mailboxSha256`/
// `authMetadataSha256` — i.e. INTEGRITY of that specific byte string. It
// is NOT a cryptographic signature and does NOT by itself prove the bytes
// were genuinely produced by a real, live run of the reviewed checker (or
// mailboxDiscovery.mjs / authVerificationShapeDiscovery.mjs) rather than
// hand-assembled by anyone who knows the schema. This module closes the
// gap it CAN close — schema/status/project/binding/freshness plausibility
// of whatever bytes are supplied, so a hex64-shaped-but-unrelated value
// (or a syntactically valid but incomplete/substituted/stale/misbound
// receipt) can no longer pass — while remaining honest that provenance
// beyond that would need a real signing/attestation mechanism, which is
// out of scope. Who actually ran the real command and handed over real
// bytes is a PROCEDURAL trust boundary (see the report's playbook), not a
// cryptographic one.
import { createHash } from 'node:crypto'
import { PROJECT } from './inventoryCore.mjs'
import { CALLABLES as BASELINE_CALLABLES } from './deploymentCheckCore.mjs'
import {
  TASK as DEPLOYMENT_CHECK_13FN_TASK, MEMBER_MANAGEMENT_CALLABLES,
  EXPECTED_BASELINE_SOURCE_HEAD, EXPECTED_BASELINE_RECEIPT_SHA256,
} from './gateGaDeploymentCheck13Core.mjs'
import { approvalCommandSha256, GATE_GA_TASK, EMULATOR_PROJECT } from './liveAcceptanceExecutorCliCore.mjs'

// Reconstructed, not imported: liveAcceptanceExecutorCliCore.mjs's own
// PROJECT_FOR_PROFILE is not exported. Built from the same two exported
// constants (PROJECT, EMULATOR_PROJECT) the reviewed file itself uses, so
// it cannot silently diverge in VALUE — a source-level self-test also
// asserts the reviewed file's own (unexported) mapping literal is still
// exactly `{ staging: PROJECT, emulator: EMULATOR_PROJECT }`.
const PROJECT_FOR_PROFILE = Object.freeze({ staging: PROJECT, emulator: EMULATOR_PROJECT })
import { FIXTURE_MUTATION_SLOTS, LIVE_LIMITS, TOTAL_CALLABLE_CAP } from './liveAcceptanceCore.mjs'

// MUST match liveAcceptanceExecutorCliCore.mjs's own (unexported)
// EXECUTION_APPROVAL_TTL_MS exactly. That constant cannot be imported
// without modifying the reviewed file, so this module pins the same
// literal and a self-test asserts, at the SOURCE level, that the reviewed
// file's own constant is still exactly this value.
export const APPROVAL_TTL_MS = 60 * 60 * 1000

const blocked = () => { throw new Error('approval_evidence_binding_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256Bytes = value => createHash('sha256').update(value).digest('hex')
const hex40 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const bytesOf = value => typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array
const BOOL_STRING = value => value === 'true' || value === 'false'

function checkFreshness({ timestamp, now, maxReceiptAgeMs }) {
  const instant = now(), at = Date.parse(timestamp)
  if (!Number.isSafeInteger(instant) || !Number.isSafeInteger(maxReceiptAgeMs) || maxReceiptAgeMs <= 0 ||
      at > instant || instant - at > maxReceiptAgeMs) blocked()
}

function parseJsonBytes(bytes) {
  if (!bytesOf(bytes)) blocked()
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { return blocked() }
}

/**
 * Proves a claimed functionsSha256 is genuinely the SHA-256 of a real
 * gateGaDeploymentCheck13.mjs output receipt (integrity — see module
 * header for what this does and does not prove about origin), that the
 * receipt reports the exact required task/status/project, was produced
 * by the exact expected checker commit, is bound to the exact pinned
 * baseline receipt hash AND sourceHead (not just one of the two), lists
 * EXACTLY the 13 required function names split correctly across the two
 * families with no missing/duplicate/substituted entry, and is not
 * stale. Fail-closed: any mismatch, omission, or incomplete/foreign
 * function set blocks.
 */
export function validateFunctionsShaBinding({
  functionsSha256, receiptBytes, expectedProject = PROJECT, expectedCheckerSourceHead,
  now = () => Date.now(), maxReceiptAgeMs = APPROVAL_TTL_MS,
  expectedBaselineReceiptSha256 = EXPECTED_BASELINE_RECEIPT_SHA256, expectedBaselineSourceHead = EXPECTED_BASELINE_SOURCE_HEAD,
}) {
  if (!hex64(functionsSha256) || !bytesOf(receiptBytes) || !hex40(expectedCheckerSourceHead) ||
      !hex64(expectedBaselineReceiptSha256) || !hex40(expectedBaselineSourceHead)) blocked()
  if (sha256Bytes(receiptBytes) !== functionsSha256) blocked()
  const receipt = parseJsonBytes(receiptBytes)
  if (!record(receipt) || receipt.task !== DEPLOYMENT_CHECK_13FN_TASK ||
      receipt.status !== 'DEPLOYMENT_METADATA_VERIFIED_13FN' || receipt.project !== expectedProject ||
      receipt.sourceHead !== expectedCheckerSourceHead || receipt.billingEnabled !== true ||
      !iso(receipt.finishedAt) || !Array.isArray(receipt.functions) ||
      receipt.baselineDriftCheckedAgainstSourceHead !== expectedBaselineSourceHead ||
      receipt.baselineDriftCheckedAgainstReceiptSha256 !== expectedBaselineReceiptSha256) blocked()
  checkFreshness({ timestamp: receipt.finishedAt, now, maxReceiptAgeMs })

  const seenBaseline = new Set(), seenMemberManagement = new Set()
  for (const fn of receipt.functions) {
    if (!record(fn) || typeof fn.name !== 'string') blocked()
    const shortName = fn.name.split('/').pop()
    if (fn.family === 'baseline') {
      if (!shortName || !BASELINE_CALLABLES.includes(shortName) || seenBaseline.has(shortName) ||
          fn.driftCheckedAgainstSourceHead !== expectedBaselineSourceHead) blocked()
      seenBaseline.add(shortName)
    } else if (fn.family === 'member-management') {
      if (!shortName || !MEMBER_MANAGEMENT_CALLABLES.includes(shortName) || seenMemberManagement.has(shortName)) blocked()
      seenMemberManagement.add(shortName)
    } else blocked()
  }
  if (seenBaseline.size !== BASELINE_CALLABLES.length || seenMemberManagement.size !== MEMBER_MANAGEMENT_CALLABLES.length) blocked()

  return Object.freeze({
    receiptTask: receipt.task, receiptProject: receipt.project, receiptFinishedAt: receipt.finishedAt,
    receiptSourceHead: receipt.sourceHead, functionsCount: receipt.functions.length,
  })
}

/** Real schema (mailboxDiscoveryCore.mjs's discoverMailbox output, as
 * written verbatim to disk by mailboxDiscovery.mjs), status, project and
 * freshness — the same class of check as validateFunctionsShaBinding,
 * proportionate to what this evidence type actually carries. Does not
 * assert accountExists either way: a resume=true run may legitimately see
 * an existing account; the executor's own recipient guard (unchanged,
 * reviewed) is what enforces the fresh-run absence requirement at
 * execution time. */
export function validateMailboxReceipt({
  receiptBytes, expectedProject = PROJECT, expectedSourceHead, now = () => Date.now(), maxReceiptAgeMs = APPROVAL_TTL_MS,
}) {
  if (!bytesOf(receiptBytes) || !hex40(expectedSourceHead)) blocked()
  const receipt = parseJsonBytes(receiptBytes)
  if (!record(receipt) || receipt.task !== 'SEC-006 Stage 8 mailbox discovery' ||
      receipt.status !== 'MAILBOX_DISCOVERY_COMPLETE' || receipt.project !== expectedProject ||
      receipt.sourceHead !== expectedSourceHead || !iso(receipt.capturedAt) ||
      typeof receipt.accountExists !== 'boolean' || receipt.cloudMutations !== 0 || receipt.emailsSent !== 0) blocked()
  checkFreshness({ timestamp: receipt.capturedAt, now, maxReceiptAgeMs })
  return Object.freeze({ accountExists: receipt.accountExists, capturedAt: receipt.capturedAt })
}

/** Real schema (authVerificationShapeDiscoveryCore.mjs's sanitizeDiscovery
 * output), status, project and freshness. */
export function validateAuthMetadataReceipt({
  receiptBytes, expectedProject = PROJECT, expectedSourceHead, now = () => Date.now(), maxReceiptAgeMs = APPROVAL_TTL_MS,
}) {
  if (!bytesOf(receiptBytes) || !hex40(expectedSourceHead)) blocked()
  const receipt = parseJsonBytes(receiptBytes)
  if (!record(receipt) || receipt.task !== 'SEC-006 Stage 8 Auth verification-template shape discovery' ||
      receipt.status !== 'AUTH_VERIFICATION_TEMPLATE_SHAPE_DISCOVERED' || receipt.project !== expectedProject ||
      receipt.sourceHead !== expectedSourceHead || !iso(receipt.observedAt) ||
      receipt.emailPasswordEnabled !== true || receipt.userSignupDisabled !== false ||
      receipt.verificationMethodPresent !== true || receipt.verificationTemplateMetadataPresent !== true ||
      receipt.callbackDomainPresent !== true || !hex64(receipt.metadataSha256)) blocked()
  checkFreshness({ timestamp: receipt.observedAt, now, maxReceiptAgeMs })
  return Object.freeze({ observedAt: receipt.observedAt })
}

// The 9 fields buildApprovalDraft actually needs for a FUTURE --execute
// invocation. Deliberately NOT --approval/--approval-sha256: those two
// values only exist AFTER this function returns (the approval file has
// not been written yet, and its hash cannot be known before it is), so
// requiring them up front would be a circular dependency on a
// not-yet-computed result. approvalCommandSha256() itself never reads
// either of those two fields (confirmed: it hashes only mode/profile/
// project/sourceHead/journal-path/output-path/recipientConfirmedSha256/
// resume/legacyCleanupApproved), so nothing is lost by not asking for them
// here.
export const DRAFT_ARGUMENTS = Object.freeze([
  '--profile', '--project', '--expected-head', '--journal', '--out',
  '--recipient', '--recipient-confirmed-sha256', '--resume', '--legacy-cleanup-approved',
])

export function parseDraftArgs(args) {
  if (!Array.isArray(args) || args.length !== DRAFT_ARGUMENTS.length * 2) blocked()
  const parsed = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]
    if (!DRAFT_ARGUMENTS.includes(name) || Object.hasOwn(parsed, name) || typeof value !== 'string' || !value || value.startsWith('--')) blocked()
    parsed[name] = value
  }
  if (Object.keys(parsed).length !== DRAFT_ARGUMENTS.length) blocked()
  if (!Object.hasOwn(PROJECT_FOR_PROFILE, parsed['--profile']) || parsed['--project'] !== PROJECT_FOR_PROFILE[parsed['--profile']]) blocked()
  if (!hex40(parsed['--expected-head']) || !hex64(parsed['--recipient-confirmed-sha256'])) blocked()
  if (!isAbsolutePathString(parsed['--journal']) || !isAbsolutePathString(parsed['--out'])) blocked()
  if (parsed['--recipient'].length === 0 || parsed['--recipient'].startsWith('--')) blocked()
  if (!BOOL_STRING(parsed['--resume']) || !BOOL_STRING(parsed['--legacy-cleanup-approved'])) blocked()
  return Object.freeze(parsed)
}

// path.isAbsolute() without importing node:path's platform-specific
// module twice for one predicate; matches the same posix/win32 shapes
// path.isAbsolute already uses elsewhere in this codebase.
function isAbsolutePathString(value) {
  return typeof value === 'string' && (/^\//.test(value) || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value))
}

/**
 * Assembles a G-A execution-approval draft matching
 * validateExecutionApproval()'s exact required schema. Technical
 * assembly (hashes, schema/freshness checks, commandSha256 via the real
 * imported approvalCommandSha256) is fully separated from the owner's
 * explicit decision: reviewStatus, ciStatus and ownerConfirmsApproval are
 * REQUIRED inputs this function never infers or defaults — this tool has
 * no access to any CI system or code-review record, so it cannot and
 * must not assert PASS on their behalf. Only functionsStatus is derived
 * from evidence (validateFunctionsShaBinding), because that is the one
 * claim this module can actually verify from bytes on disk.
 */
export function buildApprovalDraft({
  draftArgs, mailboxReceiptBytes, functionsReceiptBytes, authMetadataReceiptBytes, stagingFingerprint,
  expectedCheckerSourceHead, reviewStatus, ciStatus, ownerConfirmsApproval,
  approvedAt = new Date().toISOString(), now = () => Date.now(),
}) {
  if (ownerConfirmsApproval !== true) blocked()
  if (reviewStatus !== 'PASS' || ciStatus !== 'PASS') blocked()
  if (!iso(approvedAt) || !hex64(stagingFingerprint)) blocked()
  const parsed = parseDraftArgs(draftArgs)

  validateMailboxReceipt({ receiptBytes: mailboxReceiptBytes, expectedProject: parsed['--project'], expectedSourceHead: expectedCheckerSourceHead, now })
  validateAuthMetadataReceipt({ receiptBytes: authMetadataReceiptBytes, expectedProject: parsed['--project'], expectedSourceHead: expectedCheckerSourceHead, now })
  const functionsSha256 = sha256Bytes(functionsReceiptBytes)
  validateFunctionsShaBinding({ functionsSha256, receiptBytes: functionsReceiptBytes, expectedProject: parsed['--project'], expectedCheckerSourceHead, now })

  const commandSha256 = approvalCommandSha256({
    mode: 'execute', '--profile': parsed['--profile'], '--project': parsed['--project'], '--expected-head': parsed['--expected-head'],
    '--journal': parsed['--journal'], '--out': parsed['--out'], '--recipient-confirmed-sha256': parsed['--recipient-confirmed-sha256'],
    '--resume': parsed['--resume'], '--legacy-cleanup-approved': parsed['--legacy-cleanup-approved'],
  })
  const expiresAt = new Date(Date.parse(approvedAt) + APPROVAL_TTL_MS).toISOString()

  return Object.freeze({
    version: 1, task: GATE_GA_TASK, status: 'APPROVED',
    profile: parsed['--profile'], project: parsed['--project'], sourceHead: parsed['--expected-head'], prHead: parsed['--expected-head'],
    reviewStatus, ciStatus, functionsStatus: 'PASS',
    approvedAt, expiresAt, commandSha256,
    mailboxSha256: sha256Bytes(mailboxReceiptBytes), functionsSha256,
    authMetadataSha256: sha256Bytes(authMetadataReceiptBytes), stagingFingerprint,
    limits: Object.freeze({
      fixtureMutationSlots: FIXTURE_MUTATION_SLOTS.length, totalCallableRequests: TOTAL_CALLABLE_CAP,
      verificationEmails: LIVE_LIMITS.verificationEmails, cleanupAuthorized: true,
      legacyCleanupApproved: parsed['--legacy-cleanup-approved'] === 'true', productionAuthorized: false,
    }),
  })
}
