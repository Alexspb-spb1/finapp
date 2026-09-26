#!/usr/bin/env node
// Builds a real G-A execution-approval JSON, immediately before use, from
// real evidence receipt files — never from freely-chosen hash literals,
// and never inferring reviewStatus/ciStatus/the approval decision itself.
// FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING. Run by the owner
// right before invoking liveAcceptanceExecutor.mjs --execute, never in
// advance: expiresAt is always exactly approvedAt + 1 hour, so a draft
// built ahead of time and left sitting around would expire before use.
//
// --approval and --approval-sha256 are deliberately NOT arguments here:
// their real values only exist after this command writes the file, so
// asking for them up front would be a dependency on a not-yet-computed
// result. Pass the printed approvalSha256 and this command's --out path
// as --approval/--approval-sha256 to the SEPARATE --execute invocation
// afterwards (see the report's playbook for the full two-checkout
// sequence: this tool and liveAcceptanceExecutor.mjs do not necessarily
// live in the same checkout).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { buildApprovalDraft } from './gateGaApprovalEvidenceBindingCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const HELP = [
  'node scripts/invitationRehearsal/gateGaBuildApprovalDraft.mjs',
  '  --mailbox-receipt <absolute-private-JSON, from mailboxDiscovery.mjs>',
  '  --functions-receipt <absolute-private-JSON, from gateGaDeploymentCheck13.mjs>',
  '  --auth-metadata-receipt <absolute-private-JSON, from authVerificationShapeDiscovery.mjs>',
  '  --staging-fingerprint <exact-64-hex>',
  '  --expected-checker-source-head <exact-40-hex, the commit the three receipts above were produced from>',
  '  --review-status PASS --ci-status PASS   (your own explicit attestation; never inferred)',
  '  --owner-confirms-approval true          (your own explicit decision to approve; never inferred)',
  '  --out <new-absolute-private-JSON>',
  '  -- --profile staging|emulator --project <matching-project> --expected-head <reviewed-40-char-SHA-of-the-EXECUTOR-commit>',
  '     --journal <new-absolute-private-JSONL> --out <new-absolute-private-JSON-for-the-executor-run>',
  '     --recipient <email> --recipient-confirmed-sha256 <exact-SHA256>',
  '     --resume true|false --legacy-cleanup-approved true|false',
].join('\n')

if (args.length === 1 && args[0] === '--help') { console.log(HELP); process.exit(0) }

function readPrivateFile(label, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label}_not_absolute`)
  const stat = fs.lstatSync(value)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error(`${label}_invalid`)
  return fs.readFileSync(value)
}

try {
  const sepIndex = args.indexOf('--')
  if (sepIndex === -1) throw new Error('missing_--_separator_before_draft_args')
  const own = args.slice(0, sepIndex)
  const draftArgs = args.slice(sepIndex + 1)

  const accepted = [
    '--mailbox-receipt', '--functions-receipt', '--auth-metadata-receipt', '--staging-fingerprint',
    '--expected-checker-source-head', '--review-status', '--ci-status', '--owner-confirms-approval', '--out',
  ]
  if (own.length !== accepted.length * 2) throw new Error('arguments')
  const parsed = {}
  for (let i = 0; i < own.length; i += 2) {
    if (!accepted.includes(own[i]) || Object.hasOwn(parsed, own[i]) || !own[i + 1] || own[i + 1].startsWith('--')) throw new Error('arguments')
    parsed[own[i]] = own[i + 1]
  }

  const mailboxReceiptBytes = readPrivateFile('mailbox_receipt', parsed['--mailbox-receipt'])
  const functionsReceiptBytes = readPrivateFile('functions_receipt', parsed['--functions-receipt'])
  const authMetadataReceiptBytes = readPrivateFile('auth_metadata_receipt', parsed['--auth-metadata-receipt'])
  const stagingFingerprint = parsed['--staging-fingerprint']
  const expectedCheckerSourceHead = parsed['--expected-checker-source-head']
  const reviewStatus = parsed['--review-status']
  const ciStatus = parsed['--ci-status']
  const ownerConfirmsApproval = parsed['--owner-confirms-approval'] === 'true'

  const output = parsed['--out']
  if (!path.isAbsolute(output) || fs.existsSync(output)) throw new Error('output')
  const parent = fs.realpathSync(path.dirname(output)), relative = path.relative(fs.realpathSync(root), parent)
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('output')
  const outputPath = path.join(parent, path.basename(output))

  // approvedAt is captured here, at build time — the one moment this
  // script is allowed to call "now". Never pass a stored/older timestamp.
  const draft = buildApprovalDraft({
    draftArgs, mailboxReceiptBytes, functionsReceiptBytes, authMetadataReceiptBytes, stagingFingerprint,
    expectedCheckerSourceHead, reviewStatus, ciStatus, ownerConfirmsApproval,
  })

  const bytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`)
  fs.writeFileSync(outputPath, bytes, { flag: 'wx', mode: 0o600 })
  const approvalSha256 = createHash('sha256').update(bytes).digest('hex')
  console.log('APPROVAL_DRAFT_WRITTEN', JSON.stringify({
    path: outputPath, approvalSha256, approvedAt: draft.approvedAt, expiresAt: draft.expiresAt,
    note: 'Pass this exact file as --approval and this exact hash as --approval-sha256 to liveAcceptanceExecutor.mjs --execute (run from the checkout at your executor --expected-head, which may differ from this tool\'s own checkout). Expires at expiresAt above — build a new one if that passes before --execute runs.',
  }))
} catch (error) {
  console.error('APPROVAL_DRAFT_BLOCKED', error && error.message ? error.message : 'unknown')
  process.exitCode = 2
}
