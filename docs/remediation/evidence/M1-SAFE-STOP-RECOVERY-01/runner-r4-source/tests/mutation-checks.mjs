// Controlled local mutations: each mutant is a COPY of the package with one deliberate defect
// (originals are never edited). A mutation counts as "detected" when the relevant test outcome
// changes from the expected safe result. Copies live under .runtime\m1-r4-mutants and are
// removed afterwards; only the summary is kept.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MUTANTS = 'D:\\projects\\finapp\\.runtime\\m1-r4-mutants'
const BASE = 'D:\\projects\\finapp\\.runtime\\m1-r4-rehearsal'
const PRIOR_EV = 'D:\\projects\\finapp\\.runtime\\m1-stg-rev8-8526a79'
const PRIOR_RUN = 'D:\\projects\\finapp\\.runtime\\m1-staging-run-8526a79-rev8'
const H = '714d0f91c60a582ee87dc7da82d6249b3106329f'
fs.mkdirSync(MUTANTS, { recursive: true })
fs.mkdirSync(BASE, { recursive: true })
const results = []

function copyPackage(name) {
  const dest = path.join(MUTANTS, `${name}-${Date.now()}`)
  fs.cpSync(PKG, dest, { recursive: true, filter: src => !src.includes(`${path.sep}results`) })
  return dest
}
function mutate(dir, file, from, to) {
  const f = path.join(dir, file)
  const text = fs.readFileSync(f, 'utf8')
  if (!text.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from.slice(0, 60)}`)
  fs.writeFileSync(f, text.replace(from, () => to))
  spawnSync(process.execPath, [path.join(dir, 'tests', 'normalize-ps1-bom.mjs')], { encoding: 'utf8' })
  spawnSync(process.execPath, [path.join(dir, 'tests', 'make-code-sums.mjs')], { encoding: 'utf8' })
}
function orchestrateBoth(dir, name, scenario, prior = null) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'tests', 'run-orchestrator.ps1'), '-Name', name, '-ScenarioName', scenario, '-SmokeMode', 'stub', '-PackageDir', dir]
  if (prior) args.push('-PriorEvidenceRoot', prior.evidence, '-PriorRunRoot', prior.run)
  const r = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true })
  const ev = (r.stdout.match(/EVIDENCE=(.+)/) ?? [])[1]?.trim()
  const read = f => {
    const p = ev ? path.join(ev, f) : null
    return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) : null
  }
  const invocations = ev && fs.existsSync(path.join(ev, 'stub-state', 'invocations.jsonl')) ? fs.readFileSync(path.join(ev, 'stub-state', 'invocations.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  return { evidence: ev, result: read('orchestrator-result.json'), state: read('orchestrator-state.json'), invocations }
}
const orchestrate = (dir, name, scenario, prior) => orchestrateBoth(dir, name, scenario, prior).result
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const count = (inv, key) => inv.filter(e => e.key === key).length
function record(name, detected, detail) {
  results.push({ mutation: name, detected: Boolean(detected), detail })
  console.log(`${detected ? 'DETECTED' : 'NOT DETECTED'} ${name} ${JSON.stringify(detail)}`)
}
function nodeTests(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, 'tests', 'node-helper-tests.mjs')], { encoding: 'utf8', cwd: dir, timeout: 15 * 60 * 1000 })
  const failed = (r.stdout.match(/^FAIL .*$/gm) ?? []).map(l => l.slice(0, 110))
  return { status: r.status, failed }
}
// A tampered COPY of the pinned rev8 evidence (the harness never edits the real directories).
function priorCopy(tag, tamper) {
  const exp = JSON.parse(fs.readFileSync(path.join(PKG, 'expected-state-r3.json'), 'utf8'))
  const root = path.join(BASE, `priorcopy-${tag}-${Date.now()}`)
  const evc = path.join(root, 'evidence'), runc = path.join(root, 'run')
  for (const pin of exp.priorEvidence) {
    const dst = path.join(pin.root === 'evidence' ? evc : runc, ...pin.path.split('/'))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(path.join(pin.root === 'evidence' ? PRIOR_EV : PRIOR_RUN, ...pin.path.split('/')), dst)
  }
  const f = path.join(evc, 'm1-stg-rules-state-final-rev8.jsonl')
  if (tamper) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('cbfcc160', 'cbfcc161'))
  return { evidence: evc, run: runc }
}

// M1 - the orchestrator does not stop when the readiness gate is not satisfied (readiness step effectively skipped).
{
  const dir = copyPackage('m1-skip-readiness')
  mutate(dir, 'm1-orchestrator.ps1', "  if (-not $readyOk) { Stop-Stage 'step2' \"readiness gate not satisfied (tool exit $rx, status $rstatus): no seed, no Auth user\" }\n", '')
  const { result: r, invocations } = orchestrateBoth(dir, 'mut-skip-readiness', 'readiness-platform-401')
  record('M1 orchestrator ignores a failed readiness gate and goes on (export, deploy, seed)', !(r?.status === 'SAFE_STOP' && r?.stop?.step === 'step2' && count(invocations, 'smoke-seed') === 0 && count(invocations, 'firebase-deploy-rules') === 0), { status: r?.status, step: r?.stop?.step, seeds: count(invocations, 'smoke-seed'), deploys: count(invocations, 'firebase-deploy-rules') })
}
// M2 - the classifier accepts a platform-level 401 (the exact rev7 failure) as readiness.
{
  const dir = copyPackage('m2-accept-platform-401')
  mutate(dir, 'm1-readiness-lib.mjs', "if (!JSON_TYPE.test(type)) return no(status === 401 || status === 403 ? 'platform-denied' : 'not-json')", "if (!JSON_TYPE.test(type)) return status === 401 ? { ready: true, verdict: 'ready' } : no('not-json')")
  const { result: r, invocations } = orchestrateBoth(dir, 'mut-platform-401', 'readiness-platform-401')
  const t = nodeTests(dir)
  record('M2 readiness classifier accepts a platform 401', !(r?.status === 'SAFE_STOP' && r?.stop?.step === 'step2' && count(invocations, 'smoke-seed') === 0) && t.status !== 0, { orchestrator: r?.status, step: r?.stop?.step, seeds: count(invocations, 'smoke-seed'), unitTestsFailed: t.failed.length })
}
// M3 - the fifth function is not verified: the poller only looks at four callables (second line of defence removed as well).
{
  const dir = copyPackage('m3-fifth-function')
  mutate(dir, 'm1-readiness-lib.mjs', '    for (const fn of functions) {\n      if (now() >= deadline)', '    for (const fn of functions.slice(0, 4)) {\n      if (now() >= deadline)')
  const libOnly = orchestrate(dir, 'mut-fifth-lib-only', 'readiness-not-ready-listCompanyMembers')
  const t = nodeTests(dir)
  mutate(dir, 'm1-orchestrator.ps1', '$readyOk = ($rx -eq 0) -and (Test-ReadinessResult $rr)', '$readyOk = ($rx -eq 0)')
  const both = orchestrateBoth(dir, 'mut-fifth-both', 'readiness-not-ready-listCompanyMembers')
  record('M3 the fifth callable (listCompanyMembers) is not verified by the readiness gate', t.status !== 0 && !(both.result?.status === 'SAFE_STOP' && both.result?.stop?.step === 'step2' && count(both.invocations, 'smoke-seed') === 0),
    { unitTestsFailed: t.failed.length, libOnlyOrchestrator: libOnly?.stop?.step ?? libOnly?.status, bothOrchestrator: both.result?.status, seeds: count(both.invocations, 'smoke-seed') })
}
// M4 - the classifier accepts UNAUTHENTICATED with any appCode (no application-layer proof).
{
  const dir = copyPackage('m4-any-appcode')
  mutate(dir, 'm1-readiness-lib.mjs', "if (details === null || typeof details !== 'object' || Array.isArray(details) || details.appCode !== READY_APP_CODE) return no('wrong-app-code')", '')
  const r = orchestrate(dir, 'mut-any-appcode', 'readiness-wrong-app-code')
  const t = nodeTests(dir)
  record('M4 readiness classifier ignores the appCode', t.status !== 0 && r?.stop?.step !== 'step2', { orchestrator: r?.status, step: r?.stop?.step, unitTestsFailed: t.failed.length })
}
// M5 - the independent local check of the live functions report is skipped (drift written with exit 0 goes unnoticed).
{
  const dir = copyPackage('m5-skip-functions-check')
  mutate(dir, 'm1-orchestrator.ps1', "'--out', (EvPath 'state-check-functions-pre.json'))) -ne 0)", "'--out', (EvPath 'state-check-functions-pre.json'))) -eq 99)")
  const r = orchestrate(dir, 'mut-skip-functions-check', 'state-baseline-fn-changed')
  record('M5 baseline function drift goes unnoticed before the export and deploy', !(r?.status === 'SAFE_STOP' && r?.stop?.step === 'step1'), { status: r?.status, step: r?.stop?.step })
}
// M6 - the independent check of the pinned Rules (ruleset / raw hash / size) is no longer applied.
{
  const dir = copyPackage('m6-skip-rules-pin')
  mutate(dir, 'm1-orchestrator.ps1', 'return @{ exit = $x; check = $c }', 'return @{ exit = $x; check = 0 }')
  const r = orchestrate(dir, 'mut-skip-rules-pin', 'state-rules-ruleset-drift')
  record('M6 a different pre-release ruleset with the same canonical hash goes unnoticed', !(r?.status === 'SAFE_STOP' && r?.stop?.step === 'step1'), { status: r?.status, step: r?.stop?.step })
}
// M7 - the provenance check of the rev8 evidence is skipped (tampered COPY of the final Rules journal).
{
  const dir = copyPackage('m7-skip-provenance')
  mutate(dir, 'm1-orchestrator.ps1', "'--out', (EvPath 'prior-provenance.json'))) -ne 0)", "'--out', (EvPath 'prior-provenance.json'))) -eq 99)")
  const r = orchestrate(dir, 'mut-skip-provenance', 'prior-tampered-rules', priorCopy('m7', true))
  record('M7 a tampered prior-evidence copy is accepted', !(r?.status === 'SAFE_STOP' && r?.stop?.step === 'step0'), { status: r?.status, step: r?.stop?.step, reason: r?.stop?.reason })
}
// M8 - no rollback after a confirmed Rules failure.
{
  const dir = copyPackage('m8-no-rollback-confirmed')
  mutate(dir, 'm1-orchestrator.ps1', "if ($classification -eq 'confirmed-rules-failure') { Invoke-RulesRollback 'c: confirmed R1-R9 probe failure during smoke' }", "if ($false) { Invoke-RulesRollback 'c: confirmed R1-R9 probe failure during smoke' }")
  const r = orchestrate(dir, 'mut-no-rollback-confirmed', 'smoke-r3-rollback')
  record('M8 orchestrator does not roll back after a confirmed Rules failure', !(r?.rules?.rollbackAttempted && r?.rules?.rollbackConfirmed), { rollbackAttempted: r?.rules?.rollbackAttempted, cleanup: r?.cleanup?.rulesStatus })
}
// M9 - the conservative rollback after an indeterminate smoke outcome is dropped.
{
  const dir = copyPackage('m9-no-conservative-rollback')
  mutate(dir, 'm1-orchestrator.ps1', "      elseif ($classification -eq 'indeterminate') { Invoke-RulesRollback 'd: indeterminate smoke outcome - one conservative rollback from the fresh verified backup' }\n", '')
  const r = orchestrate(dir, 'mut-no-conservative-rollback', 'smoke-api-nostop')
  record('M9 orchestrator does not roll back after an indeterminate smoke outcome', !(r?.rules?.rollbackAttempted === true && r?.rules?.rollbackConfirmed === true), { indeterminate: r?.smoke?.indeterminate, rollbackAttempted: r?.rules?.rollbackAttempted, cleanupRulesStatus: r?.cleanup?.rulesStatus })
}
// M10 - an ordinary application/UI failure triggers a Rules rollback.
{
  const dir = copyPackage('m10-app-failure-rollback')
  mutate(dir, 'm1-orchestrator.ps1', "elseif ($classification -eq 'indeterminate') { Invoke-RulesRollback 'd:", "elseif ($true) { Invoke-RulesRollback 'd:")
  const { result: r, invocations } = orchestrateBoth(dir, 'mut-app-failure-rollback', 'smoke-ui-flow')
  record('M10 an application/UI failure triggers a Rules rollback', !(r?.stop?.step === 'step6' && !r?.rules?.rollbackAttempted && count(invocations, 'firebase-rollback') === 0), { rollbackAttempted: r?.rules?.rollbackAttempted, rollbacks: count(invocations, 'firebase-rollback') })
}
// M11 - the deploy wrapper is allowed to run a Functions deploy.
{
  const dir = copyPackage('m11-wrapper-functions')
  mutate(dir, 'm1-deploy-wrapper.mjs', "export const KINDS = Object.freeze({ rules: {}, 'rules-rollback': {} })", "export const KINDS = Object.freeze({ rules: {}, 'rules-rollback': {}, functions: {} })")
  const t = nodeTests(dir)
  record('M11 wrapper lists a Functions deploy kind', t.status !== 0, { unitTestsFailed: t.failed.length, first: t.failed[0] })
}
// M12 - the rollback preparation stops comparing the backup with the shipped round-2 reference.
{
  const dir = copyPackage('m12-rollback-compare')
  mutate(dir, 'm1-rules-rollback-prepare.mjs', " || sha(fs.readFileSync(o['--compare-rules'], 'utf8').replace(/\\r\\n?/g, '\\n')) !== canonical) throw new Error('round-2 reference rules differ from the backup')", ") throw new Error('round-2 reference rules differ from the backup')")
  const t = nodeTests(dir)
  record('M12 rollback preparation accepts a reference that differs from the backup', t.status !== 0, { unitTestsFailed: t.failed.length, first: t.failed[0] })
}
// M13 - the state comparison ignores the build of a function (an M1 function was redeployed).
{
  const dir = copyPackage('m13-ignore-build')
  mutate(dir, 'm1-state-lib.mjs', "for (const key of ['revision', 'build', 'sourceReferenceSha256'])", "for (const key of ['revision', 'sourceReferenceSha256'])")
  const r = orchestrate(dir, 'mut-ignore-build', 'state-m1-fn-changed')
  const t = nodeTests(dir)
  record('M13 state comparison ignores a changed build', t.status !== 0 && r?.stop?.step !== 'step1', { orchestrator: r?.status, step: r?.stop?.step, unitTestsFailed: t.failed.length })
}
// M14 - a new run may reuse a run id of rev7/rev8.
{
  const dir = copyPackage('m14-run-id')
  mutate(dir, 'm1-core.mjs', "if (/^[0-9a-f]{8}$/.test(id) && !PRIOR_RUN_IDS.includes(id)) return id", "if (/^[0-9a-f]{8}$/.test(id)) return id")
  const t = nodeTests(dir)
  record('M14 a run id used by an earlier run can be reused', t.status !== 0, { unitTestsFailed: t.failed.length, first: t.failed[0] })
}
// M15 - orchestrator treats cleanup exit 3 as a completed cleanup.
{
  const dir = copyPackage('m15-cleanup-branch')
  mutate(dir, 'm1-orchestrator.ps1', "3 { $cleanup.branch = 'CLEANUP_REFUSED' }", "3 { $cleanup.branch = 'CLEANUP_COMPLETE_VERIFIED' }")
  const r = orchestrate(dir, 'mut-cleanup-branch', 'cleanup-exit-3')
  record('M15 orchestrator accepts a refused cleanup', !(r?.status === 'SAFE_STOP' && r?.cleanup?.branch === 'CLEANUP_REFUSED'), { status: r?.status, branch: r?.cleanup?.branch })
}
// M16 - CI check ignores the head SHA.
{
  const dir = copyPackage('m16-ci-head')
  mutate(dir, 'm1-ci-check.mjs', "if (run.headSha !== expectedHead) problems.push('head mismatch')", '')
  const r = orchestrate(dir, 'mut-ci-head', 'ci-wrong-head')
  record('M16 CI check ignores head mismatch', !(r?.status === 'SAFE_STOP' && r?.stop?.step === 'step0'), { status: r?.status, step: r?.stop?.step })
}
// M17 - the step 7 (cleanup) STOP is no longer persisted to the state file.
{
  const dir = copyPackage('m17-step7-save-state')
  mutate(dir, 'm1-orchestrator.ps1',
    "    Write-Journal 'STOP' @{ step = 'step7'; reason = $cleanup.branch }\n    # The saved state must never lag behind a STOP: state and result stay consistent.\n    Save-State\n",
    "    Write-Journal 'STOP' @{ step = 'step7'; reason = $cleanup.branch }\n")
  const { result, state } = orchestrateBoth(dir, 'mut-step7-save-state', 'cleanup-exit-3')
  record('M17 step 7 STOP is not saved: state and result disagree', !same(state?.stop, result?.stop), { stateStop: state?.stop ?? null, resultStop: result?.stop ?? null })
}
// M18 - the step 8 final block and its STOP are no longer persisted to the state file.
{
  const dir = copyPackage('m18-step8-save-state')
  mutate(dir, 'm1-orchestrator.ps1',
    "  $State.final = [ordered]@{ functionsExit = $finalFunctions; functionsCheckExit = $finalFunctionsCheck; rulesExit = $finalRules; rulesCheckExit = $finalRulesCheck }\n  Save-State\n",
    "  $State.final = [ordered]@{ functionsExit = $finalFunctions; functionsCheckExit = $finalFunctionsCheck; rulesExit = $finalRules; rulesCheckExit = $finalRulesCheck }\n")
  mutate(dir, 'm1-orchestrator.ps1',
    "    Write-Journal 'STOP' @{ step = 'step8'; reason = 'final read-only check' }\n    Save-State\n",
    "    Write-Journal 'STOP' @{ step = 'step8'; reason = 'final read-only check' }\n")
  const { result, state } = orchestrateBoth(dir, 'mut-step8-save-state', 'final-functions-fail')
  record('M18 step 8 final and STOP are not saved: state and result disagree', !(same(state?.final, result?.final) && same(state?.stop, result?.stop)), { stateFinal: state?.final ?? null, resultFinal: result?.final ?? null })
}
// M19 - UI route policy lets the Firestore Write channel through.
{
  const dir = copyPackage('m19-route-policy')
  mutate(dir, 'm1-ui-smoke.mjs', "if (url.origin === ep.firestoreOrigin && url.pathname === LISTEN_CHANNEL", "if (url.origin === ep.firestoreOrigin && (url.pathname === LISTEN_CHANNEL || url.pathname.includes('/Write/'))")
  const r = spawnSync(process.execPath, [path.join(dir, 'ui-route-policy-tests.mjs')], { encoding: 'utf8', cwd: dir })
  record('M19 UI route policy allows Write channel', r.status !== 0, { exit: r.status, summary: (r.stdout.match(/UI_ROUTE_POLICY_TESTS .+/) ?? [''])[0] })
}
// M20 - cleanup gate G5 disabled (rolled-back accepted without a confirmed rollback). Real emulator proof (T9).
{
  const dir = copyPackage('m20-gate-g5')
  mutate(dir, 'm1-smoke.mjs', "if (rules.rollbackDeployExit !== '0') failures.push('G5 rollback deploy exit is not 0 — rollback not confirmed')", '')
  const r = spawnSync(process.execPath, [path.join(dir, 'emulator-cleanup-gate-tests.mjs')], { encoding: 'utf8', cwd: dir, timeout: 30 * 60 * 1000 })
  const t9 = (r.stdout.match(/^(PASS|FAIL) T9 .*$/m) ?? [''])[0]
  record('M20 cleanup gate accepts rollback deploy exit 1', r.status !== 0 && t9.startsWith('FAIL'), { exit: r.status, t9: t9.slice(0, 80), summary: (r.stdout.match(/GATE_TESTS .+/) ?? [''])[0] })
}
// ---- R3-specific mutations: export gate, deploy confirmation, rollback after an unconfirmed deploy, Rules-probe set
// M21 - an unconfirmed deploy (the post-deploy independent check fails) is treated as confirmed.
{
  const dir = copyPackage('m21-deploy-confirmed')
  mutate(dir, 'm1-orchestrator.ps1', '$deployConfirmed = ($State.rulesDeploy.deployExit -eq 0) -and ($post.exit -eq 0) -and ($post.check -eq 0)', '$deployConfirmed = ($State.rulesDeploy.deployExit -eq 0)')
  const { result: r, invocations } = orchestrateBoth(dir, 'mut-deploy-confirmed', 'deploy-target-raw-drift')
  record('M21 a deploy whose live Rules differ from the pinned target is accepted and the smoke starts', !(r?.stop?.step === 'step5' && count(invocations, 'smoke-seed') === 0 && count(invocations, 'firebase-rollback') === 1), { status: r?.status, step: r?.stop?.step, seeds: count(invocations, 'smoke-seed'), rollbacks: count(invocations, 'firebase-rollback') })
}
// M22 - the fresh-export gate does not stop the run (a failed export no longer blocks the Rules deploy).
{
  const dir = copyPackage('m22-export-gate')
  mutate(dir, 'm1-orchestrator.ps1', "  if ($ex -ne 0 -or $exportResult -eq $null -or $exportResult.status -ne 'EXPORT_VERIFIED') { Stop-Stage 'step4' \"fresh Firestore export not verified (exit $ex): no Rules deploy\" }\n", '')
  const { result: r, invocations } = orchestrateBoth(dir, 'mut-export-gate', 'export-wrong-prefix')
  record('M22 the Rules are deployed although the Firestore export is not verified', !(r?.stop?.step === 'step4' && count(invocations, 'firebase-deploy-rules') === 0), { status: r?.status, step: r?.stop?.step, deploys: count(invocations, 'firebase-deploy-rules') })
}
// M23 - no rollback after an unconfirmed deploy that DID change the live Rules.
{
  const dir = copyPackage('m23-no-rollback-after-deploy')
  mutate(dir, 'm1-orchestrator.ps1', "    Invoke-RulesRollback 'e: Rules deploy not confirmed and the live Rules are not provably the pre-release ones - one conservative rollback from the fresh verified backup'\n", '')
  const { result: r, invocations } = orchestrateBoth(dir, 'mut-no-rollback-deploy', 'deploy-fail-applied')
  record('M23 an unconfirmed deploy that changed the live Rules is left in place', !(count(invocations, 'firebase-rollback') === 1 && r?.rules?.rollbackConfirmed), { rollbacks: count(invocations, 'firebase-rollback'), outcome: r?.rules?.deploy?.outcome })
}
// M24 - a deploy that provably changed nothing still triggers a rollback (the unchanged-state proof is ignored).
{
  const dir = copyPackage('m24-always-rollback')
  mutate(dir, 'm1-orchestrator.ps1', 'if ($again.exit -eq 0 -and $again.check -eq 0) {', 'if ($false) {')
  const { result: r, invocations } = orchestrateBoth(dir, 'mut-always-rollback', 'deploy-fail')
  record('M24 a failed deploy with unchanged live Rules triggers a needless rollback', !(r?.stop?.step === 'step5' && count(invocations, 'firebase-rollback') === 0), { rollbacks: count(invocations, 'firebase-rollback'), outcome: r?.rules?.deploy?.outcome })
}
// M25 - the Rules-probe pattern covers only R1-R4: a failed round-3 probe is no longer a Rules failure.
{
  const dir = copyPackage('m25-probe-regex')
  mutate(dir, 'm1-run-inspect.mjs', 'export const R_PROBE = /^R[1-9]\\./', 'export const R_PROBE = /^R[1-4]\\./')
  const { result: r, invocations } = orchestrateBoth(dir, 'mut-probe-regex', 'smoke-r6-rollback')
  const t = nodeTests(dir)
  record('M25 an R5-R9 probe failure is not recognised as a Rules failure (no rollback)', t.status !== 0 && !(r?.rules?.rollbackConfirmed && count(invocations, 'firebase-rollback') === 1), { unitTestsFailed: t.failed.length, rollbackAttempted: r?.rules?.rollbackAttempted })
}
// M26 - the forward deploy no longer checks that the repository firestore.rules is the pinned round-3 file.
{
  const dir = copyPackage('m26-wrapper-source')
  mutate(dir, 'm1-deploy-wrapper.mjs', "if (sha(rules) !== expected.rulesTarget.rawSha256 || rules.length !== expected.rulesTarget.sourceBytes || canonicalOf(rules.toString('utf8')) !== expected.rulesTarget.canonicalSha256) throw new Error('repository firestore.rules is not the pinned round-3 Rules')", '')
  const t = nodeTests(dir)
  record('M26 wrapper deploys a firestore.rules that is not the pinned target', t.status !== 0, { unitTestsFailed: t.failed.length, first: t.failed[0] })
}
// M27 - the export freshness window is removed (an old export would satisfy the gate).
{
  const dir = copyPackage('m27-export-fresh')
  mutate(dir, 'm1-orchestrator.ps1', '$ExportMaxAgeMinutes  = 30', '$ExportMaxAgeMinutes  = 100000')
  const t = nodeTests(dir)
  record('M27 the 30-minute export freshness bound is lost', t.status !== 0, { unitTestsFailed: t.failed.length, first: t.failed[0] })
}
// M28 - the pre-release Rules pin accepts the target ruleset as "pre" (a re-run after a completed release would start).
{
  const dir = copyPackage('m28-target-as-pre')
  mutate(dir, 'm1-state-lib.mjs', "if (typeof e.rulesetName !== 'string' || !e.rulesetName.startsWith(`projects/${PROJECT}/rulesets/`) || e.rulesetName === expected.rulesPre.rulesetName) problems.push('target Rules must be a new ruleset, not the pre-release one')", '')
  const t = nodeTests(dir)
  record('M28 a no-op deploy (target hash on the old ruleset) verifies as the target', t.status !== 0, { unitTestsFailed: t.failed.length, first: t.failed[0] })
}

for (const entry of fs.readdirSync(MUTANTS)) fs.rmSync(path.join(MUTANTS, entry), { recursive: true, force: true })
const undetected = results.filter(r => !r.detected).length
fs.mkdirSync(path.join(PKG, 'results'), { recursive: true })
fs.writeFileSync(path.join(PKG, 'results', 'mutation-checks.json'), `${JSON.stringify({ total: results.length, undetected, results, at: new Date().toISOString() }, null, 2)}\n`)
console.log(`MUTATION_CHECKS ${undetected ? 'FAIL' : 'PASS'} detected=${results.length - undetected}/${results.length}`)
process.exitCode = undetected ? 1 : 0
