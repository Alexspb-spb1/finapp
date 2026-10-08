// Generates stubs/scenarios/*.json (deterministic). Local only.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'stubs', 'scenarios')
fs.mkdirSync(dir, { recursive: true })
const ok = { gh: { kind: 'success' }, firebase: { deploy: 'success', rollback: 'success' }, export: 'success', stagingTools: {}, smoke: {}, readiness: { kind: 'ready' } }
const m = patch => ({ ...structuredClone(ok), ...structuredClone(patch) })
const tools = t => ({ stagingTools: t })
const M1 = ['changeMemberRole', 'disableMember', 'restoreMember', 'removeMember', 'listCompanyMembers']
const scenarios = {
  'pass-emulator': m({}),
  'pass-stub-clean': m({}),
  // v5: the export command prints the first answer (PROCESSING, no `done`) like the real gcloud did on staging; the SAME operation is polled to SUCCESSFUL.
  'pass-export-poll': m({ export: 'poll-success' }),
  ...Object.fromEntries(['wrong-head', 'missing-job', 'failed-job', 'incomplete-job', 'extra-job', 'malformed', 'exit-error'].map(k => [`ci-${k}`, m({ gh: { kind: k } })])),
  // Exact-state drift (step 1): the live tool fails, or writes a drifted report that the independent local check must catch.
  'state-functions-check-fails': m(tools({ statePre: 'fail' })),
  'state-functions-missing': m(tools({ statePre: 'missing' })),
  'state-functions-extra': m(tools({ statePre: 'extra' })),
  'state-baseline-fn-changed': m(tools({ statePre: 'drift-baseline' })),
  'state-m1-fn-changed': m(tools({ statePre: 'drift-m1' })),
  'state-caps-changed': m(tools({ statePre: 'caps' })),
  // The live Rules are already the round-3 target (or something else entirely): the release must not start.
  'state-rules-target': { ...m({}), rulesInitial: 'TARGET' },
  'state-rules-other': { ...m({}), rulesInitial: 'OTHER' },
  'state-rules-ruleset-drift': m(tools({ rulesDrift: 'ruleset' })),
  'state-rules-raw-drift': m(tools({ rulesDrift: 'raw' })),
  'state-rules-bytes-drift': m(tools({ rulesDrift: 'bytes' })),
  'backup-rules-fails': m(tools({ backupRules: 'fail' })),
  'backup-verify-fails': m(tools({ backupVerify: 'fail' })),
  // Readiness gate (step 2).
  'readiness-late-ready': m({ readiness: { kind: 'platform-401', readyAfterRound: 3 } }),
  ...Object.fromEntries(['platform-401', 'platform-403', 'html', 'http-204', 'http-200', 'http-500', 'malformed-json', 'wrong-app-code', 'wrong-status', 'timeout', 'network'].map(k => [`readiness-${k}`, m({ readiness: { kind: k } })])),
  ...Object.fromEntries(M1.map(fn => [`readiness-not-ready-${fn}`, m({ readiness: { kind: 'platform-401', functions: [fn] } })])),
  // Smoke preflight (step 3).
  'smoke-preflight-fail': m({ smoke: { preflight: 2 } }),
  // Fresh Firestore export (step 4): every non-proof ends the run before the Rules deploy.
  ...Object.fromEntries(['exit-1', 'op-failed', 'bad-json', 'not-done', 'wrong-prefix', 'no-metadata', 'list-fail', 'poll-failed', 'poll-forever', 'poll-describe-exit1', 'poll-bad-json', 'poll-wrong-name', 'poll-wrong-prefix', 'poll-unknown-state', 'poll-success-no-metadata', 'poll-old-operation', 'poll-slow-export', 'poll-slow-describe'].map(k => [`export-${k}`, m({ export: k })])),
  // Rules deploy (step 5).
  'deploy-fail': m({ firebase: { deploy: 'fail', rollback: 'success' } }),
  'deploy-noop': m({ firebase: { deploy: 'noop', rollback: 'success' } }),
  'deploy-fail-applied': m({ firebase: { deploy: 'fail-applied', rollback: 'success' } }),
  'deploy-fail-applied-rollback-fails': m({ firebase: { deploy: 'fail-applied', rollback: 'fail' } }),
  'deploy-target-raw-drift': m(tools({ targetDrift: 'raw' })),
  'deploy-target-bytes-drift': m(tools({ targetDrift: 'bytes' })),
  'deploy-target-same-ruleset': m(tools({ targetDrift: 'same-ruleset' })),
  'deploy-postverify-fails': m(tools({ postDeploy: 'fail' })),
  // Smoke branches (step 6).
  'smoke-seed-fail': m({ smoke: { seed: 2 } }),
  'smoke-ui-assertion': m({ smoke: { ui: 2 } }),
  'smoke-ui-flow': m({ smoke: { ui: 'UI_FLOW' } }),
  'smoke-api-assertion': m({ smoke: { api: 2 } }),
  'smoke-r3-rollback': m({ smoke: { api: 'R3' } }),
  'smoke-r6-rollback': m({ smoke: { api: 'R6' } }),
  'smoke-r3-rollback-fails': m({ firebase: { deploy: 'success', rollback: 'fail' }, smoke: { api: 'R3' } }),
  'smoke-api-nostop': m({ smoke: { api: 'NO_STOP' } }),
  'smoke-api-corrupt': m({ smoke: { api: 'CORRUPT' } }),
  'smoke-api-corrupt-rollback-fails': m({ firebase: { deploy: 'success', rollback: 'fail' }, smoke: { api: 'CORRUPT' } }),
  'smoke-uir3-assertion': m({ smoke: { uiR3: 2 } }),
  'smoke-uir3-flow': m({ smoke: { uiR3: 'UI_FLOW' } }),
  // Cleanup (step 7) and final checks (step 8).
  'cleanup-exit-2': m({ smoke: { cleanup: 2 } }),
  'cleanup-exit-3': m({ smoke: { cleanup: 3 } }),
  'cleanup-exit-4': m({ smoke: { cleanup: 4 } }),
  'verify-clean-remainder': m({ smoke: { verifyClean: 2 } }),
  'final-functions-fail': m(tools({ stateFinal: 'fail' })),
  'final-functions-drift': m(tools({ stateFinal: 'drift-m1' })),
  'final-rules-fail': m(tools({ rulesFinal: 'fail' })),
  // Local tamper of a COPY of the prior (rev8) evidence (the harness supplies the copy).
  'prior-tampered-functions': m({}),
  'prior-tampered-rules': m({}),
}
for (const file of fs.readdirSync(dir)) fs.rmSync(path.join(dir, file))
for (const [name, body] of Object.entries(scenarios)) fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`)
console.log(`scenarios=${Object.keys(scenarios).length}`)
