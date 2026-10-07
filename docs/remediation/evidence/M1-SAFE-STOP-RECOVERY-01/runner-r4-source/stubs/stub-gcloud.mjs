// Local gcloud stub for the Firestore export step. It accepts exactly the argument vectors m1-export.mjs builds and nothing else (exit 96):
//   firestore export gs://<bucket>/<path>/m1-r3-714d0f91-<UTC stamp> --project=finapp-staging --format=json            (at most once)
//   storage ls gs://<bucket>/<path>/m1-r3-714d0f91-<UTC stamp>/ --project=finapp-staging                                 (at most once)
//   firestore operations describe stub-export-op --project=finapp-staging --format=json                                 (the read-only poll)
// Scenario key `export`: success (default) | op-failed | exit-1 | bad-json | not-done | wrong-prefix | no-metadata | list-fail
//   and the polling scenarios (the export command prints the FIRST answer, PROCESSING without `done`, exactly like the real gcloud did on staging):
//   poll-success (PROCESSING, then SUCCESSFUL) | poll-success-immediate | poll-flaky-then-success (one describe failure) | poll-failed (error + FAILED) |
//   poll-forever (never done) | poll-describe-exit1 | poll-bad-json | poll-wrong-name | poll-wrong-prefix | poll-unknown-state | poll-success-no-metadata
//   and the timing scenarios (v6): poll-slow-export (the export command answers only after M1_STUB_EXPORT_DELAY_MS) | poll-slow-describe (every describe
//   answers only after M1_STUB_EXPORT_DELAY_MS) | poll-old-operation (the operation reports a startTime 45 minutes before the request)
import fs from 'node:fs'
import path from 'node:path'
import { assertPreloaded, scenario, claim, refuse, stateDir } from './stub-lib.mjs'

assertPreloaded()
const args = process.argv.slice(2)
const PREFIX = /^gs:\/\/[a-z0-9][a-z0-9._-]{2,220}(?:\/[A-Za-z0-9._-]{1,100}){1,6}\/m1-r3-714d0f91-\d{8}T\d{6}Z$/
const kind = scenario().export ?? 'success'
const stateFile = () => path.join(stateDir(), 'export-state.json')
const pollFile = () => path.join(stateDir(), 'describe-count.json')
const POLL = kind.startsWith('poll-')
const OP_NAME = 'projects/finapp-staging/databases/(default)/operations/stub-export-op'

if (args.length === 5 && args[0] === 'firestore' && args[1] === 'export' && PREFIX.test(args[2]) && args[3] === '--project=finapp-staging' && args[4] === '--format=json') {
  claim('gcloud-export', 1)
  const prefix = args[2]
  const start = kind === 'poll-old-operation' ? new Date(Date.now() - 45 * 60000).toISOString() : new Date().toISOString()
  fs.writeFileSync(stateFile(), JSON.stringify({ prefix, start }))
  if (kind === 'exit-1') { console.error('ERROR: (gcloud.firestore.export) PERMISSION_DENIED (stub)'); process.exit(1) }
  if (kind === 'bad-json') { process.stdout.write('Waiting for [operation] to complete...done.\n'); process.exit(0) }
  if (kind === 'poll-slow-export') await new Promise(r => setTimeout(r, Number(process.env.M1_STUB_EXPORT_DELAY_MS ?? 0)))
  if (POLL) {
    // the first answer of the real gcloud: the operation is still running and carries no `done`
    process.stdout.write(`${JSON.stringify({ name: OP_NAME, metadata: { '@type': 'type.googleapis.com/google.firestore.admin.v1.ExportDocumentsMetadata', operationState: 'PROCESSING', outputUriPrefix: prefix, startTime: start } }, null, 2)}\n`)
    process.exit(0)
  }
  const op = {
    name: OP_NAME,
    done: kind !== 'not-done',
    metadata: { '@type': 'type.googleapis.com/google.firestore.admin.v1.ExportDocumentsMetadata', startTime: start, endTime: new Date().toISOString(),
      operationState: kind === 'op-failed' ? 'FAILED' : 'SUCCESSFUL', outputUriPrefix: kind === 'wrong-prefix' ? 'gs://another-bucket/elsewhere' : prefix },
  }
  process.stdout.write(`${JSON.stringify(op, null, 2)}\n`)
  process.exit(0)
}
if (args.length === 6 && args[0] === 'firestore' && args[1] === 'operations' && args[2] === 'describe' && args[3] === 'stub-export-op' && args[4] === '--project=finapp-staging' && args[5] === '--format=json') {
  claim('gcloud-describe', 200)
  if (!fs.existsSync(stateFile())) refuse('describe of an operation that was never started')
  const { prefix, start } = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  const n = (fs.existsSync(pollFile()) ? JSON.parse(fs.readFileSync(pollFile(), 'utf8')).n : 0) + 1
  fs.writeFileSync(pollFile(), JSON.stringify({ n }))
  const meta = (state, extra = {}) => ({ '@type': 'type.googleapis.com/google.firestore.admin.v1.ExportDocumentsMetadata', operationState: state, outputUriPrefix: prefix, startTime: start, ...extra })
  const running = { name: OP_NAME, metadata: meta('PROCESSING') }
  const ok = { name: OP_NAME, done: true, metadata: meta('SUCCESSFUL', { endTime: new Date().toISOString() }), response: { '@type': 'type.googleapis.com/google.firestore.admin.v1.ExportDocumentsResponse', outputUriPrefix: prefix } }
  const out = o => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`)
  if (kind === 'poll-slow-describe') await new Promise(r => setTimeout(r, Number(process.env.M1_STUB_EXPORT_DELAY_MS ?? 0)))
  if (kind === 'poll-describe-exit1') { console.error('ERROR: (gcloud.firestore.operations.describe) UNAVAILABLE (stub)'); process.exit(1) }
  if (kind === 'poll-flaky-then-success') { if (n === 1) { console.error('ERROR: transient (stub)'); process.exit(1) } out(n === 2 ? running : ok); process.exit(0) }
  if (kind === 'poll-bad-json') { process.stdout.write('Waiting for the operation...\n'); process.exit(0) }
  if (kind === 'poll-forever') { out(running); process.exit(0) }
  if (kind === 'poll-wrong-name') { out({ ...ok, name: 'projects/finapp-staging/databases/(default)/operations/another-op' }); process.exit(0) }
  if (kind === 'poll-wrong-prefix') { out({ ...ok, metadata: meta('SUCCESSFUL', { outputUriPrefix: 'gs://another-bucket/elsewhere' }), response: undefined }); process.exit(0) }
  if (kind === 'poll-unknown-state') { out({ name: OP_NAME, metadata: meta('SOMETHING_NEW') }); process.exit(0) }
  if (kind === 'poll-failed') { out(n === 1 ? running : { name: OP_NAME, done: true, metadata: meta('FAILED', { endTime: new Date().toISOString() }), error: { code: 13, message: 'internal (stub)' } }); process.exit(0) }
  if (kind === 'poll-success-immediate') { out(ok); process.exit(0) }
  out(n === 1 ? running : ok)  // poll-success and poll-success-no-metadata: PROCESSING first, then SUCCESSFUL
  process.exit(0)
}
if (args.length === 4 && args[0] === 'storage' && args[1] === 'ls' && args[3] === '--project=finapp-staging' && args[2].endsWith('/') && PREFIX.test(args[2].slice(0, -1))) {
  claim('gcloud-list', 1)
  if (!fs.existsSync(stateFile()) || JSON.parse(fs.readFileSync(stateFile(), 'utf8')).prefix !== args[2].slice(0, -1)) refuse('listing of a prefix that was not exported')
  if (kind === 'list-fail') { console.error('ERROR: (gcloud.storage.ls) 403 (stub)'); process.exit(1) }
  const p = args[2]
  process.stdout.write(`${p}${kind === 'no-metadata' || kind === 'poll-success-no-metadata' ? 'other.txt' : 'm1-r3.overall_export_metadata'}\n${p}all_namespaces/\n`)
  process.exit(0)
}
refuse(`gcloud unexpected arguments: ${JSON.stringify(args)}`)
