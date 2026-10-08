// Local Firebase CLI stub. The R3 release deploys exactly two things and the stub accepts exactly those two
// argument vectors, each at most once (exit 97 on a repeat); any other vector is refused (exit 96):
//   forward   deploy --project finapp-staging --only firestore:rules --non-interactive              (cwd = release clone)
//   rollback  deploy --project finapp-staging --config <...\m1-stg-rules-rollback-r3\firebase.json> --only firestore:rules --non-interactive
// The stub also checks WHAT would be published: the forward deploy needs the repository firestore.rules to be
// byte-for-byte the pinned round-3 file, the rollback needs the prepared rules to be the pinned pre-release bytes.
// Emits firebase-tools 15.24.0-shaped stdout/stderr (interleaved chunks) and updates the stub Rules state.
// Scenario keys: firebase.deploy = success|fail|fail-applied|noop    firebase.rollback = success|fail
//   fail         exit 1, the live Rules stay as they were        fail-applied  exit 1 although the Rules WERE published
//   noop         exit 0 although nothing was published
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assertPreloaded, scenario, claim, refuse, sameArgs, sleep, setRulesState, RULES_PRE, RULES_TARGET } from './stub-lib.mjs'

assertPreloaded()
const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXPECTED = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'expected-state-r3.json'), 'utf8'))
const sha = v => createHash('sha256').update(v).digest('hex')
const args = process.argv.slice(2)
const FORWARD = ['deploy', '--project', 'finapp-staging', '--only', 'firestore:rules', '--non-interactive']
const isForward = sameArgs(args, FORWARD)
const isRollback = args.length === 8 && sameArgs([...args.slice(0, 4), ...args.slice(5)], ['deploy', '--project', 'finapp-staging', '--config', '--only', 'firestore:rules', '--non-interactive'])
  && path.isAbsolute(args[4]) && /\\m1-stg-rules-rollback-r3\\firebase\.json$/i.test(args[4]) && fs.existsSync(args[4])
if (!isForward && !isRollback) refuse(`firebase unexpected arguments: ${JSON.stringify(args)}`)
if (isForward) {
  const rules = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'))
  if (sha(rules) !== EXPECTED.rulesTarget.rawSha256 || rules.length !== EXPECTED.rulesTarget.sourceBytes) refuse('forward deploy would publish bytes other than the pinned round-3 Rules')
} else {
  const rules = fs.readFileSync(path.join(path.dirname(args[4]), 'firestore.rules'))
  if (sha(rules) !== EXPECTED.rulesPre.rawSha256 || rules.length !== EXPECTED.rulesPre.sourceBytes) refuse('rollback would publish bytes other than the pinned pre-release Rules')
}
claim(isForward ? 'firebase-deploy-rules' : 'firebase-rollback', 1)
const s = scenario().firebase ?? {}
const out = async text => { process.stdout.write(text); await sleep(15) }
const err = async text => { process.stderr.write(text); await sleep(15) }

await out("\n=== Deploying to 'finapp-staging'...\n\ni  deploying ")
await out('firestore\n')
const mode = (isForward ? s.deploy : s.rollback) ?? 'success'
if (mode === 'success') {
  setRulesState(isForward ? RULES_TARGET : RULES_PRE, isForward ? 'deploy' : 'rollback')
  await out('+  firestore: released rules firestore.rules to cloud.firestore\n\n+  Deploy complete!\n'); process.exitCode = 0
} else if (mode === 'noop') {
  await out('+  firestore: released rules firestore.rules to cloud.firestore\n\n+  Deploy complete!\n'); process.exitCode = 0
} else if (mode === 'fail') { await err('Error: HTTP Error: 503, The service is currently unavailable.\n'); process.exitCode = 1 }
else if (mode === 'fail-applied') {
  setRulesState(isForward ? RULES_TARGET : RULES_PRE, isForward ? 'deploy' : 'rollback')
  await err('Error: Request timed out while waiting for the release to be confirmed.\n'); process.exitCode = 1
} else refuse(`unknown ${isForward ? 'deploy' : 'rollback'} scenario ${mode}`)
