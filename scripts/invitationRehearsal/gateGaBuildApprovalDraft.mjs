#!/usr/bin/env node
// Builds a real G-A execution-approval JSON, immediately before use, from
// real evidence receipt files — never from freely-chosen hash literals.
// FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING. Intended to be
// run by the owner right before invoking
// liveAcceptanceExecutor.mjs --execute, never in advance: expiresAt is
// always exactly approvedAt + 1 hour (gateGaApprovalEvidenceBindingCore.mjs's
// APPROVAL_TTL_MS, pinned to and verified against the reviewed executor's
// own constant), so a draft built ahead of time and left sitting around
// would expire before use. This file has NOT been invoked against live
// evidence — only its --help path was exercised, per the reviewed scope
// for this round.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { buildApprovalDraft } from './gateGaApprovalEvidenceBindingCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const HELP = 'node scripts/invitationRehearsal/gateGaBuildApprovalDraft.mjs --mailbox-receipt <absolute-private-JSON> --functions-receipt <absolute-private-JSON> --auth-metadata-receipt <absolute-private-JSON> --staging-fingerprint <exact-64-hex> --out <new-absolute-private-JSON> -- --execute --profile staging --project finapp-staging --expected-head <SHA> --approval <same-path-as---out> --approval-sha256 <computed-after-write,-see-output> --journal <new-absolute-private-JSONL> --out <new-absolute-private-JSON-for-the-executor-run> --recipient <email> --recipient-confirmed-sha256 <SHA> --resume false --legacy-cleanup-approved false'

if (args.length === 1 && args[0] === '--help') { console.log(HELP); process.exit(0) }

function readPrivateFile(label, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label}_not_absolute`)
  const stat = fs.lstatSync(value)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error(`${label}_invalid`)
  return fs.readFileSync(value)
}

try {
  const sepIndex = args.indexOf('--')
  if (sepIndex === -1) throw new Error('missing_--_separator_before_executor_args')
  const own = args.slice(0, sepIndex)
  const cliArgs = args.slice(sepIndex + 1)

  const accepted = ['--mailbox-receipt', '--functions-receipt', '--auth-metadata-receipt', '--staging-fingerprint', '--out']
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

  const output = parsed['--out']
  if (!path.isAbsolute(output) || fs.existsSync(output)) throw new Error('output')
  const parent = fs.realpathSync(path.dirname(output)), relative = path.relative(fs.realpathSync(root), parent)
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('output')
  const outputPath = path.join(parent, path.basename(output))

  // approvedAt is captured here, at build time — the one moment this
  // script is allowed to call "now". Never pass a stored/older timestamp.
  const draft = buildApprovalDraft({ cliArgs, mailboxReceiptBytes, functionsReceiptBytes, authMetadataReceiptBytes, stagingFingerprint })

  const bytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`)
  fs.writeFileSync(outputPath, bytes, { flag: 'wx', mode: 0o600 })
  const approvalSha256 = createHash('sha256').update(bytes).digest('hex')
  console.log('APPROVAL_DRAFT_WRITTEN', JSON.stringify({
    path: outputPath, approvalSha256, approvedAt: draft.approvedAt, expiresAt: draft.expiresAt,
    note: 'Pass this exact file as --approval and this exact hash as --approval-sha256 to liveAcceptanceExecutor.mjs --execute. This approval expires at expiresAt above — build a new one if that passes before --execute runs.',
  }))
} catch (error) {
  console.error('APPROVAL_DRAFT_BLOCKED', error && error.message ? error.message : 'unknown')
  process.exitCode = 2
}
