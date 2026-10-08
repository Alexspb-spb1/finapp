// Local stand-in for m1-smoke.mjs / m1-ui-smoke.mjs / m1-ui-smoke-r3.mjs used only by stub-smoke rehearsals,
// to drive every orchestrator branch deterministically (cleanup exit 0/2/3/4, verify-clean
// remainder, R-probe failure). The real gate logic is proven by emulator runs.
// Scenario: smoke.{preflight,seed,ui,api,uiR3,cleanup,verifyClean,inventory} exit codes;
//           smoke.api may be "R3" (the round-1 probe R3) or "R6" (the round-3 ownerId probe) to journal an R-probe STOP (exit 2), "NO_STOP" to exit 2
//           right after MODE_START without any terminal event, or "CORRUPT" to journal a
//           non-Rules STOP and then damage the journal (both are indeterminate outcomes).
//           rev8: smoke.ui may be "UI_FLOW" to journal the ui-flow STOP rev7 met on staging
//           (a browser wait that timed out: an application failure, never a Rules failure).
import fs from 'node:fs'
import path from 'node:path'
import { assertPreloaded, scenario, claim, refuse, H } from './stub-lib.mjs'
import { privateDir } from '../m1-core.mjs'

assertPreloaded()
const [script, ...args] = process.argv.slice(2)
const o = {}
for (let i = 0; i < args.length; i += 2) o[args[i]] = args[i + 1]
if (o['--target'] !== 'emulator' || o['--expected-head'] !== H || !path.isAbsolute(o['--run-dir'] ?? '')) refuse(`smoke arguments: ${JSON.stringify(args)}`)
const s = scenario().smoke ?? {}
const runDir = o['--run-dir']
const log = (event, extra = {}) => fs.appendFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`)

let mode
if (script === 'ui') {
  mode = 'ui'
  if (!o['--dist']) refuse('ui requires --dist')
} else if (script === 'ui-r3') {
  mode = 'ui-r3'
  if (!o['--dist']) refuse('ui-r3 requires --dist')
} else if (script === 'smoke') {
  mode = o['--mode']
  if (!['preflight', 'seed', 'api', 'cleanup', 'verify-clean', 'inventory'].includes(mode)) refuse(`smoke mode ${mode}`)
  if (mode === 'cleanup' && !['untouched', 'verified-new', 'rolled-back', 'unconfirmed'].includes(o['--rules-status'])) refuse('cleanup without valid --rules-status')
} else refuse(`unknown smoke script ${script}`)
claim(`smoke-${mode}`, 1)
// Record the exact rules arguments the orchestrator chose (for assertions).
fs.appendFileSync(path.join(process.env.M1_STUB_STATE, 'smoke-args.jsonl'), `${JSON.stringify({ mode, rulesStatus: o['--rules-status'] ?? null, rulesEvidence: o['--rules-evidence'] ? path.basename(o['--rules-evidence']) : null, rollbackExit: o['--rules-rollback-deploy-exit'] ?? null })}\n`)

if (mode === 'preflight') {
  privateDir(runDir, { mustExist: false })
  log('MODE_START', { mode })
  const code = s.preflight ?? 0
  log(code ? 'MODE_STOP' : 'MODE_PASS', { mode, kind: code ? 'assertion' : undefined })
  process.exit(code)
}
if (!fs.existsSync(runDir)) refuse('run dir missing')
log('MODE_START', { mode })
const keyed = { 'verify-clean': 'verifyClean', 'ui-r3': 'uiR3' }[mode] ?? mode
let value = s[keyed] ?? 0
if ((mode === 'ui' || mode === 'ui-r3') && value === 'UI_FLOW') {
  log('MODE_STOP', { mode, kind: 'ui-flow', reason: `ui-flow after ${mode === 'ui' ? 'F1.admin-nav-users-visible' : 'U1.signed-in-despite-lost-company'}: locator.waitFor: Timeout 45000ms exceeded.` })
  process.exit(2)
}
if (mode === 'api' && (value === 'R3' || value === 'R6')) {
  log('MODE_STOP', { mode, kind: 'assertion', reason: value === 'R3' ? 'R3.disabled-member-rules-denied: assertion failed' : 'R6.owner-without-membership-denied: assertion failed' })
  process.exit(2)
}
// Indeterminate API outcomes: the mode never reaches a terminal event, or the journal is
// damaged after the failure. Both must leave the orchestrator unable to confirm anything.
if (mode === 'api' && value === 'NO_STOP') process.exit(2)
if (mode === 'api' && value === 'CORRUPT') {
  log('MODE_STOP', { mode, kind: 'assertion', reason: 'api.member-list-shape: assertion failed' })
  fs.appendFileSync(path.join(runDir, 'journal.jsonl'), '{"at":"2026-09-16T00:00:00.000Z","event":"MODE_ST\n')
  process.exit(2)
}
if (mode === 'inventory') fs.writeFileSync(path.join(runDir, `inventory-${Date.now()}.json`), `${JSON.stringify({ format: 'finapp-m1-inventory-v1', stub: true, remainingDocumentCount: 1 })}\n`)
// Mirror of the real gate rule G5 (proven against the emulators by emulator-cleanup-gate-tests):
// an unconfirmed Rules state, or a rolled-back state whose rollback deploy exit is not exactly 0,
// refuses without deletes and writes a recovery manifest. The stub outcome therefore follows from
// the arguments the orchestrator chose instead of from a scripted exit code.
if (mode === 'cleanup' && value === 0 && (o['--rules-status'] === 'unconfirmed' || (o['--rules-status'] === 'rolled-back' && o['--rules-rollback-deploy-exit'] !== '0'))) value = 3
if (mode === 'cleanup' && value === 3) fs.writeFileSync(path.join(runDir, `recovery-manifest-${Date.now()}.json`), `${JSON.stringify({ format: 'finapp-m1-recovery-manifest-v1', stub: true, decision: 'CLEANUP_REFUSED_NO_DELETES', rulesStatus: o['--rules-status'] ?? null, rulesRollbackDeployExit: o['--rules-rollback-deploy-exit'] ?? null })}\n`)
log(value ? 'MODE_STOP' : 'MODE_PASS', { mode, kind: value ? 'assertion' : undefined, exitCode: value })
process.exit(value)
