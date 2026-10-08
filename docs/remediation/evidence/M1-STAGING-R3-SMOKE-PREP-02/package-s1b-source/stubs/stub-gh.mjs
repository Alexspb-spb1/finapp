// Local gh stub: accepts exactly `run view 36830077757 --repo Alexspb-spb1/finapp --json databaseId,headSha,status,conclusion,jobs`.
// Scenario key `gh`: { kind: success|wrong-head|missing-job|failed-job|incomplete-job|extra-job|malformed|exit-error }.
import { assertPreloaded, scenario, claim, refuse, sameArgs, H, CI_RUN_ID } from './stub-lib.mjs'

assertPreloaded()
const EXPECTED = ['run', 'view', CI_RUN_ID, '--repo', 'Alexspb-spb1/finapp', '--json', 'databaseId,headSha,status,conclusion,jobs']
const args = process.argv.slice(2)
if (!sameArgs(args, EXPECTED)) refuse(`gh unexpected arguments: ${JSON.stringify(args)}`)
claim('gh', 1)
const kind = scenario().gh?.kind ?? 'success'
const job = (name, status = 'completed', conclusion = 'success') => ({ name, status, conclusion, databaseId: name === 'ci' ? 101 : 102, steps: [] })
const run = { databaseId: Number(CI_RUN_ID), headSha: H, status: 'completed', conclusion: 'success', jobs: [job('ci'), job('functions')] }
switch (kind) {
  case 'success': break
  case 'wrong-head': run.headSha = '8f7d495f03b70a6f279f3622d61d5380db611a92'; break
  case 'missing-job': run.jobs = [job('ci')]; break
  case 'failed-job': run.jobs = [job('ci'), job('functions', 'completed', 'failure')]; run.conclusion = 'failure'; break
  case 'incomplete-job': run.jobs = [job('ci'), job('functions', 'in_progress', '')]; run.status = 'in_progress'; run.conclusion = ''; break
  case 'extra-job': run.jobs = [job('ci'), job('functions'), job('deploy')]; break
  case 'malformed': process.stdout.write('{"databaseId": 36830077757, "jobs": [ '); process.exit(0)
  case 'exit-error': process.stderr.write('HTTP 502: Bad Gateway\n'); process.exit(1)
  default: refuse(`unknown gh scenario ${kind}`)
}
process.stdout.write(`${JSON.stringify(run)}\n`)
