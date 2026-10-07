// Node-level tests for the R3 helpers and stubs. Local only. The only network activity is loopback
// (an in-process http server on 127.0.0.1 for the readiness CLI); child processes are node itself
// running stubs/probes under the no-network preload, and the packaged tools.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateCiRun, ghCommand, GH_ARGS, CI_RUN_ID } from '../m1-ci-check.mjs'
import { deployArgs, commandFor, checkDeploySource, KINDS } from '../m1-deploy-wrapper.mjs'
import { classifyJournal, MODES, R_PROBE } from '../m1-run-inspect.mjs'
import { classifyProbe, runReadiness, sameFunctionSet, CALLABLE_BODY, STAGING_LIMITS, VERDICTS } from '../m1-readiness-lib.mjs'
import { parseArgs as parseReadinessArgs, makeProbe } from '../m1-readiness.mjs'
import { compareFunctions, validateExpected, verifyProvenance, verifyRulesEvidence, localRulesProblems, sha256hex, canonicalOf, RULES_PRE, RULES_TARGET } from '../m1-state-lib.mjs'
import { exportPrefix, exportArgs, listArgs, exportOperationProblems, listingProblems, gcloudCommand, findGcloudCmd, URI_PATTERN } from '../m1-export.mjs'
import { M1_CALLABLES, PRIOR_RUN_IDS, pickRunId, newFixturePlan, DOC_BUDGET, MAX_DOCUMENTS } from '../m1-core.mjs'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const H = '714d0f91c60a582ee87dc7da82d6249b3106329f'
const PRIOR_EV = 'D:\\projects\\finapp\\.runtime\\m1-stg-rev8-8526a79'
const PRIOR_RUN = 'D:\\projects\\finapp\\.runtime\\m1-staging-run-8526a79-rev8'
const REPO = 'D:\\projects\\finapp\\m1-release-714d0f91'
const results = []
const record = (name, pass, detail) => { results.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`) }
const throws = fn => { try { fn(); return false } catch { return true } }
const expected = JSON.parse(fs.readFileSync(path.join(PKG, 'expected-state-r3.json'), 'utf8'))

// ── CI validation ───────────────────────────────────────────────────────────
const job = (name, status = 'completed', conclusion = 'success') => ({ name, status, conclusion })
const run = over => JSON.stringify({ databaseId: 36830077757, headSha: H, status: 'completed', conclusion: 'success', jobs: [job('ci'), job('functions')], ...over })
record('ci: the pinned run is 36830077757 on HEAD 714d0f91', CI_RUN_ID === 36830077757)
record('ci: success -> no problems', validateCiRun(run({})).length === 0)
record('ci: wrong run id (the superseded 8526a79 run) is refused', validateCiRun(run({ databaseId: 34633900626 })).includes('run id mismatch'))
record('ci: wrong head (8526a79, the audited-CHANGES_REQUIRED head) is refused', validateCiRun(run({ headSha: '8526a791ce3f62dee5a64aa239b795c609a39226' })).includes('head mismatch'))
record('ci: workflow not completed', validateCiRun(run({ status: 'in_progress' })).some(p => p.startsWith('workflow status')))
record('ci: workflow failed', validateCiRun(run({ conclusion: 'failure' })).some(p => p.startsWith('workflow conclusion')))
record('ci: missing functions job', validateCiRun(run({ jobs: [job('ci')] })).includes('job functions count 0'))
record('ci: duplicate ci job', validateCiRun(run({ jobs: [job('ci'), job('ci'), job('functions')] })).includes('job ci count 2'))
record('ci: failed job', validateCiRun(run({ jobs: [job('ci'), job('functions', 'completed', 'failure')] })).includes('job functions conclusion failure'))
record('ci: incomplete job', validateCiRun(run({ jobs: [job('ci', 'in_progress', null), job('functions')] })).includes('job ci status in_progress'))
record('ci: extra job', validateCiRun(run({ jobs: [job('ci'), job('functions'), job('deploy')] })).includes('unexpected job deploy'))
record('ci: malformed JSON', validateCiRun('{"jobs": [').includes('malformed JSON'))
record('ci: jobs missing', validateCiRun(JSON.stringify({ databaseId: 36830077757, headSha: H, status: 'completed', conclusion: 'success' })).includes('jobs missing'))
record('ci: gh arguments are an exact array without jq', JSON.stringify(GH_ARGS) === JSON.stringify(['run', 'view', '36830077757', '--repo', 'Alexspb-spb1/finapp', '--json', 'databaseId,headSha,status,conclusion,jobs']))
{
  const saved = process.env.M1_STUB_SCENARIO
  process.env.M1_STUB_SCENARIO = 'x'
  record('ci: staging profile refuses stub environment', throws(() => ghCommand('staging')))
  if (saved === undefined) delete process.env.M1_STUB_SCENARIO; else process.env.M1_STUB_SCENARIO = saved
}

// ── Deploy wrapper: the R3 release can run TWO deploys, both Firestore Rules only ───────────────
const ROLLBACK_CFG = 'C:\\x\\m1-stg-rules-rollback-r3\\firebase.json'
record('wrapper: the only deploy kinds are rules and rules-rollback', JSON.stringify(Object.keys(KINDS)) === JSON.stringify(['rules', 'rules-rollback']))
record('wrapper: forward argv exact (finapp-staging, firestore:rules only, no --config)', JSON.stringify(deployArgs('rules')) === JSON.stringify(['deploy', '--project', 'finapp-staging', '--only', 'firestore:rules', '--non-interactive']))
record('wrapper: rollback argv exact (finapp-staging, --config, firestore:rules only)', JSON.stringify(deployArgs('rules-rollback', ROLLBACK_CFG)) === JSON.stringify(['deploy', '--project', 'finapp-staging', '--config', ROLLBACK_CFG, '--only', 'firestore:rules', '--non-interactive']))
record('wrapper: a Functions, indexes or Hosting deploy vector cannot be built', ['functions', 'indexes', 'hosting', 'all'].every(k => throws(() => deployArgs(k))))
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^M1_STUB_/i.test(k) && !/EMULATOR/i.test(k) && !['FIREBASE_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED'].includes(k.toUpperCase())))
const staging = commandFor('staging', 'rules-rollback', ROLLBACK_CFG, cleanEnv)
record('wrapper: staging runs repo firebase-tools with node, no shell wrapper', staging.file === process.execPath && staging.args[0].toLowerCase().endsWith('node_modules\\firebase-tools\\lib\\bin\\firebase.js') && staging.args[0].toLowerCase().startsWith(REPO.toLowerCase()))
record('wrapper: staging refuses stub environment', throws(() => commandFor('staging', 'rules', undefined, { ...cleanEnv, M1_STUB_SCENARIO: 'x' })))
record('wrapper: staging refuses FIREBASE_TOKEN', throws(() => commandFor('staging', 'rules', undefined, { ...cleanEnv, FIREBASE_TOKEN: 'x' })))
record('wrapper: staging refuses emulator variables', throws(() => commandFor('staging', 'rules', undefined, { ...cleanEnv, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })))
const reh = commandFor('rehearsal', 'rules', undefined, { M1_STUB_SCENARIO: 's', M1_STUB_STATE: 'd' })
record('wrapper: rehearsal runs the stub under the no-network preload', reh.args[0] === '--require' && reh.args[1].endsWith('no-network.cjs') && reh.args[2].endsWith('stub-firebase.mjs'))
record('wrapper: rehearsal refuses without scenario/state', throws(() => commandFor('rehearsal', 'rules', undefined, {})))
const wrapperSource = fs.readFileSync(path.join(PKG, 'm1-deploy-wrapper.mjs'), 'utf8')
record('wrapper: spawn uses shell:false and never exec/execSync', /shell: false/.test(wrapperSource) && !/\bexecSync\(|\bexec\(/.test(wrapperSource))
record('wrapper: no Functions deploy code exists in the wrapper', !/functions:changeMemberRole|M1_FUNCTIONS|markerFile|--only', 'functions/.test(wrapperSource))
{
  // What each kind may publish is checked against the pinned expected state (temporary directories, never the real clone).
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-wrap-repo-'))
  const target = fs.readFileSync(path.join(REPO, 'firestore.rules'))
  fs.writeFileSync(path.join(tmpRepo, 'firestore.rules'), target)
  fs.writeFileSync(path.join(tmpRepo, 'firebase.json'), fs.readFileSync(path.join(REPO, 'firebase.json')))
  record('wrapper source check: the real round-3 file and firebase.json pass (kind rules)', !throws(() => checkDeploySource('rules', expected, { repo: tmpRepo })))
  fs.writeFileSync(path.join(tmpRepo, 'firestore.rules'), Buffer.concat([target, Buffer.from('\n')]))
  record('wrapper source check: one extra byte in firestore.rules -> refused (kind rules)', throws(() => checkDeploySource('rules', expected, { repo: tmpRepo })))
  fs.writeFileSync(path.join(tmpRepo, 'firestore.rules'), Buffer.from(target.toString('utf8').replace(/\n/g, '\r\n')))
  record('wrapper source check: CRLF endings in firestore.rules -> refused (kind rules)', throws(() => checkDeploySource('rules', expected, { repo: tmpRepo })))
  fs.writeFileSync(path.join(tmpRepo, 'firestore.rules'), fs.readFileSync(path.join(PKG, expected.rollback.blobFile)))
  record('wrapper source check: the round-2 file instead of round 3 -> refused (kind rules)', throws(() => checkDeploySource('rules', expected, { repo: tmpRepo })))
  fs.writeFileSync(path.join(tmpRepo, 'firestore.rules'), target)
  fs.writeFileSync(path.join(tmpRepo, 'firebase.json'), JSON.stringify({ firestore: { rules: 'other.rules' } }))
  record('wrapper source check: firebase.json pointing elsewhere -> refused (kind rules)', throws(() => checkDeploySource('rules', expected, { repo: tmpRepo })))
  fs.rmSync(tmpRepo, { recursive: true, force: true })

  const rb = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-wrap-rb-'))
  const cfg = path.join(rb, 'firebase.json')
  const pre = Buffer.from(fs.readFileSync(path.join(PKG, expected.rollback.blobFile), 'utf8').replace(/\r?\n/g, '\r\n'))
  fs.writeFileSync(path.join(rb, 'firestore.rules'), pre)
  fs.writeFileSync(cfg, `${JSON.stringify({ firestore: { rules: 'firestore.rules' } }, null, 2)}\n`)
  record('wrapper source check: the pinned pre-release bytes (CRLF form of round 2) pass (kind rules-rollback)', !throws(() => checkDeploySource('rules-rollback', expected, { rollbackConfig: cfg })))
  fs.writeFileSync(path.join(rb, 'firestore.rules'), target)
  record('wrapper source check: the round-3 file as a "rollback" -> refused', throws(() => checkDeploySource('rules-rollback', expected, { rollbackConfig: cfg })))
  fs.writeFileSync(path.join(rb, 'firestore.rules'), Buffer.concat([pre, Buffer.from(' ')]))
  record('wrapper source check: a changed rollback rules byte -> refused', throws(() => checkDeploySource('rules-rollback', expected, { rollbackConfig: cfg })))
  fs.writeFileSync(path.join(rb, 'firestore.rules'), pre)
  fs.writeFileSync(cfg, JSON.stringify({ firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' } }))
  record('wrapper source check: a rollback firebase.json that lists more than the Rules file -> refused', throws(() => checkDeploySource('rules-rollback', expected, { rollbackConfig: cfg })))
  fs.writeFileSync(cfg, `${JSON.stringify({ firestore: { rules: 'firestore.rules' } }, null, 2)}\n`)
  fs.writeFileSync(path.join(rb, 'extra.txt'), 'x')
  record('wrapper source check: an extra file in the rollback directory -> refused', throws(() => checkDeploySource('rules-rollback', expected, { rollbackConfig: cfg })))
  fs.rmSync(rb, { recursive: true, force: true })
}

// ── Run inspector: fail-closed classification of a failed smoke mode ─────────
const jline = o => JSON.stringify({ at: '2026-10-01T00:00:00.000Z', ...o })
const mStart = mode => jline({ event: 'MODE_START', mode, target: 'emulator' })
const mPass = mode => jline({ event: 'MODE_PASS', mode })
const mStop = (mode, reason, kind = 'assertion') => jline({ event: 'MODE_STOP', mode, kind, reason })
const preludeLines = [mStart('preflight'), mPass('preflight'), mStart('seed'), mPass('seed'), mStart('ui'), mPass('ui')]
const cls = (lines, mode = 'api') => classifyJournal(lines, mode)
const problemsOf = report => report.problems.join('; ')
{
  const r = cls([...preludeLines, mStart('api'), mStop('api', 'R3.disabled-member-rules-denied: assertion failed'), ''])
  record('inspect: one trusted terminal STOP with an R3 reason -> confirmed-rules-failure', r.classification === 'confirmed-rules-failure' && r.rulesFailure === true && r.indeterminate === false, r.trustedTerminal)
}
for (const probe of ['R5.colleague-profile-denied', 'R6.owner-without-membership-denied', 'R7.lost-company-denied']) {
  const r = cls([...preludeLines, mStart('api'), mStop('api', `${probe}: assertion failed`)])
  record(`inspect: the round-3 probe ${probe.split('.')[0]} is a Rules probe -> confirmed-rules-failure (rollback owed)`, r.classification === 'confirmed-rules-failure' && r.rulesFailure === true)
}
record('inspect: the Rules-probe pattern is R1-R9 only (R0., R10., S8. and free text are not Rules probes)', ['R1.', 'R4.', 'R9.'].every(p => R_PROBE.test(`${p}x`)) && ['R0.x', 'R10.x', 'S8.x', 'xR5.x', 'R5x'].every(p => !R_PROBE.test(p)))
{
  const r = cls([...preludeLines, mStart('api'), mStop('api', 'api.member-list-shape: assertion failed')])
  record('inspect: one trusted terminal STOP without an R-probe reason -> confirmed-non-rules-failure', r.classification === 'confirmed-non-rules-failure' && r.rulesFailure === false)
}
{
  const r = cls([...preludeLines, mStart('api'), mPass('api'), mStart('ui-r3'), mStop('ui-r3', 'ui-flow after U1.signed-in-despite-lost-company: locator.waitFor: Timeout 45000ms exceeded.', 'ui-flow')], 'ui-r3')
  record('inspect: a failed ui-r3 flow (ui-flow kind) is a confirmed NON-Rules failure -> no rollback', r.classification === 'confirmed-non-rules-failure' && r.rulesFailure === false && r.trustedTerminal.mode === 'ui-r3' && r.trustedTerminal.kind === 'ui-flow')
}
{
  const r = cls([mStart('preflight'), mPass('preflight'), mStart('seed'), mPass('seed'), mStart('ui'), mStop('ui', 'ui-flow after F1.admin-nav-users-visible: locator.waitFor: Timeout 45000ms exceeded.', 'ui-flow')], 'ui')
  record('inspect: a UI failure (ui-flow, locator timeout) is a confirmed NON-Rules failure -> no rollback', r.classification === 'confirmed-non-rules-failure' && r.rulesFailure === false && r.trustedTerminal.kind === 'ui-flow')
}
{
  const r = cls([...preludeLines, mStart('api'), jline({ event: 'PROBE_RESULT', reason: 'R1.member-write-denied: assertion failed' }), mStop('api', 'api.transport: connection reset', 'transport')])
  record('inspect: an R-probe reason outside the trusted terminal event is ignored', r.classification === 'confirmed-non-rules-failure' && r.rulesFailure === false)
}
{
  const r = cls([...preludeLines, mStart('api')])
  record('inspect: MODE_START without a terminal event -> indeterminate', r.classification === 'indeterminate' && problemsOf(r).includes('api has no terminal event'), problemsOf(r))
}
{
  const r = cls([...preludeLines, mStart('api'), mStop('api', 'api.x: assertion failed'), '{"at":"2026-10-01T00:00:00.000Z","event":"MODE_ST'])
  record('inspect: a damaged journal line -> indeterminate and journal not readable', r.classification === 'indeterminate' && r.journalReadable === false && problemsOf(r).includes('is not valid JSON'), problemsOf(r))
}
record('inspect: an unreadable journal (null lines) -> indeterminate', cls(null).classification === 'indeterminate' && cls(null).journalReadable === false)
{
  const r = cls([...preludeLines, mStart('api'), mStop('api', 'R2.x: assertion failed'), mStart('api'), mStop('api', 'api.y: assertion failed')])
  record('inspect: two terminal events for the failed mode -> indeterminate', r.classification === 'indeterminate' && problemsOf(r).includes('2 terminal events for api'), problemsOf(r))
}
{
  const r = cls([...preludeLines, mStart('api'), mPass('api')])
  record('inspect: a mode that ended with MODE_PASS is never a confirmed failure', r.classification === 'indeterminate' && problemsOf(r).includes('ended with MODE_PASS'), problemsOf(r))
}
record('inspect: only seed, ui, api and ui-r3 may be inspected', cls([mStart('cleanup'), mStop('cleanup', 'x')], 'cleanup').classification === 'indeterminate' && JSON.stringify(MODES) === JSON.stringify(['seed', 'ui', 'api', 'ui-r3']))
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-inspect-'))
  const runDir = path.join(dir, 'run')
  fs.mkdirSync(runDir)
  const inspector = path.join(PKG, 'm1-run-inspect.mjs')
  const cli = (mode, out, extra = []) => spawnSync(process.execPath, [inspector, '--run-dir', runDir, '--mode', mode, '--out', path.join(dir, out), ...extra], { encoding: 'utf8' })
  record('inspect CLI: a missing journal exits 2 and reports indeterminate', cli('api', 'no-journal.json').status === 2 && JSON.parse(fs.readFileSync(path.join(dir, 'no-journal.json'), 'utf8')).classification === 'indeterminate')
  fs.writeFileSync(path.join(runDir, 'journal.jsonl'), `${[...preludeLines, mStart('api'), mStop('api', 'R6.x: assertion failed')].join('\n')}\n`)
  const confirmed = cli('api', 'confirmed.json')
  record('inspect CLI: a confirmed R6 failure exits 0 and writes the report', confirmed.status === 0 && /classification=confirmed-rules-failure/.test(confirmed.stdout) && JSON.parse(fs.readFileSync(path.join(dir, 'confirmed.json'), 'utf8')).rulesFailure === true)
  record('inspect CLI: ui-r3 is an accepted mode name', cli('ui-r3', 'uir3.json').status === 2 && JSON.parse(fs.readFileSync(path.join(dir, 'uir3.json'), 'utf8')).problems.some(p => p.includes('no MODE_START for ui-r3')))
  record('inspect CLI: refuses to overwrite an existing report', cli('api', 'confirmed.json').status === 2)
  record('inspect CLI: the run directory is never modified', fs.readdirSync(runDir).join(',') === 'journal.jsonl')
  fs.rmSync(dir, { recursive: true, force: true })
}


// ── Readiness classifier: only an application-layer UNAUTHENTICATED/auth_required answer is ready ──
const APP_BODY = JSON.stringify({ error: { details: { appCode: 'auth_required' }, message: 'auth_required', status: 'UNAUTHENTICATED' } })
const appProbe = over => ({ httpStatus: 401, contentType: 'application/json; charset=utf-8', bodyText: APP_BODY, ...over })
const verdict = probe => classifyProbe(probe).verdict
record('readiness classify: the exact diagnostic answer of the application (401, JSON, UNAUTHENTICATED, auth_required) -> ready', classifyProbe(appProbe({})).ready === true && verdict(appProbe({})) === 'ready')
record('readiness classify: content type may carry a charset and any case', classifyProbe(appProbe({ contentType: 'Application/JSON;charset=UTF-8' })).ready === true)
record('readiness classify: PLATFORM 401 (Cloud Run HTML, the rev7 failure) is NOT ready', !classifyProbe({ httpStatus: 401, contentType: 'text/html; charset=UTF-8', bodyText: '<html>The request was not authorized to invoke this service. The access token could not be verified.</html>' }).ready && verdict({ httpStatus: 401, contentType: 'text/html', bodyText: 'x' }) === 'platform-denied')
record('readiness classify: platform 403 is NOT ready', verdict({ httpStatus: 403, contentType: 'text/html', bodyText: 'Forbidden' }) === 'platform-denied')
record('readiness classify: plain-text 401 is NOT ready', verdict({ httpStatus: 401, contentType: 'text/plain', bodyText: 'Unauthorized' }) === 'platform-denied')
record('readiness classify: a valid callable body served as text/html is NOT ready', verdict(appProbe({ contentType: 'text/html' })) === 'platform-denied' && verdict(appProbe({ contentType: '' })) === 'platform-denied')
record('readiness classify: OPTIONS-style 204 is NOT ready', verdict({ httpStatus: 204, contentType: 'text/html', bodyText: '' }) === 'http-2xx')
record('readiness classify: HTTP 200 (even with a result) is NOT ready', verdict({ httpStatus: 200, contentType: 'application/json', bodyText: '{"result":{}}' }) === 'http-2xx')
record('readiness classify: HTTP 5xx is NOT ready', ['500', '502', '503', '504'].every(s => verdict({ httpStatus: Number(s), contentType: 'application/json', bodyText: APP_BODY }) === 'http-5xx'))
record('readiness classify: malformed JSON is NOT ready', verdict(appProbe({ bodyText: '{"error":{"status":"UNAUTHENTI' })) === 'malformed-json' && verdict(appProbe({ bodyText: '' })) === 'malformed-json')
record('readiness classify: JSON that is not a callable envelope is NOT ready', ['[]', '"x"', 'null', '{}', '{"error":null}', '{"error":"x"}', '{"error":[],"a":1}', '{"result":1,"error":{}}'].every(b => verdict(appProbe({ bodyText: b })) === 'not-callable-envelope'))
record('readiness classify: right envelope but another HTTP status is NOT ready', ['400', '403', '404', '409', '429'].every(s => verdict(appProbe({ httpStatus: Number(s) })) === 'unexpected-http'))
record('readiness classify: wrong error.status is NOT ready', verdict(appProbe({ bodyText: JSON.stringify({ error: { details: { appCode: 'auth_required' }, status: 'PERMISSION_DENIED' } }) })) === 'wrong-status' && verdict(appProbe({ bodyText: JSON.stringify({ error: { details: { appCode: 'auth_required' }, status: 'unauthenticated' } }) })) === 'wrong-status')
record('readiness classify: wrong or missing appCode is NOT ready', ['membership_not_found', 'email_unverified', ''].every(c => verdict(appProbe({ bodyText: JSON.stringify({ error: { details: { appCode: c }, status: 'UNAUTHENTICATED' } }) })) === 'wrong-app-code') && verdict(appProbe({ bodyText: JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }) })) === 'wrong-app-code' && verdict(appProbe({ bodyText: JSON.stringify({ error: { details: [], status: 'UNAUTHENTICATED' } }) })) === 'wrong-app-code')
record('readiness classify: timeout and network errors are NOT ready', verdict({ error: 'timeout' }) === 'timeout' && verdict({ error: 'network' }) === 'network-error' && verdict({}) === 'network-error' && verdict(undefined) === 'network-error')
record('readiness classify: an oversized body is NOT ready', verdict(appProbe({ bodyText: 'x'.repeat(70000) })) === 'oversized-body')
record('readiness classify: every verdict is one of the enumerated values', ['', 'x'].every(() => true) && [appProbe({}), { error: 'timeout' }, { httpStatus: 500 }, { httpStatus: 401, contentType: 'text/html' }, appProbe({ bodyText: '[' })].every(p => VERDICTS.includes(classifyProbe(p).verdict)))

// ── Readiness poller (fake clock): all five callables in the SAME round, bounded by a deadline ──
function fakeEnv(startMs = Date.parse('2026-09-20T00:00:00.000Z')) {
  let t = startMs
  return { now: () => t, sleep: ms => { t += ms; return Promise.resolve() }, advance: ms => { t += ms }, at: () => t }
}
const readyProbe = () => appProbe({})
const platformProbe = () => ({ httpStatus: 401, contentType: 'text/html', bodyText: '<html>platform</html>' })
{
  const env = fakeEnv(); const attempts = []
  const r = await runReadiness({ probe: async () => { env.advance(100); return readyProbe() }, deadlineMs: 60000, intervalMs: 1000, now: env.now, sleep: env.sleep, onAttempt: a => attempts.push(a) })
  record('readiness poll: five ready answers in one round -> READY after exactly five probes', r.status === 'READY' && r.rounds === 1 && attempts.length === 5 && r.allReadyInSameRound === true && M1_CALLABLES.every(f => r.functions[f].ready && r.functions[f].attempts === 1))
  record('readiness poll: attempt records hold only enumerated fields (no URL, header, body or token)', attempts.every(a => JSON.stringify(Object.keys(a)) === JSON.stringify(['at', 'round', 'fn', 'ready', 'verdict', 'httpStatus'])) && !/https?:|authorization|bearer|<html|apikey/i.test(JSON.stringify(attempts)))
}
for (const fn of M1_CALLABLES) {
  const env = fakeEnv(); const attempts = []
  const r = await runReadiness({ probe: async f => { env.advance(100); return f === fn ? platformProbe() : readyProbe() }, deadlineMs: 20000, intervalMs: 1000, now: env.now, sleep: env.sleep, onAttempt: a => attempts.push(a) })
  record(`readiness poll: only ${fn} is not ready (platform 401) -> NOT_READY at the deadline, the other four never make it ready`, r.status === 'NOT_READY' && r.functions[fn].ready === false && r.functions[fn].lastVerdict === 'platform-denied' && M1_CALLABLES.filter(f => f !== fn).every(f => r.functions[f].ready) && r.allReadyInSameRound === false && r.rounds > 1)
}
{
  const env = fakeEnv(); const seen = []
  const r = await runReadiness({ probe: async fn => { env.advance(100); seen.push(env.at()); return platformProbe() }, deadlineMs: 5000, intervalMs: 1000, now: env.now, sleep: env.sleep })
  const start = Date.parse('2026-09-20T00:00:00.000Z')
  record('readiness poll: no probe starts at or after the deadline; total time is bounded', r.status === 'NOT_READY' && seen.every(t => t - 100 < start + 5000) && r.elapsedMs <= 5000 + 100)
}
{
  const env = fakeEnv(); let round = 0
  const r = await runReadiness({ probe: async fn => { env.advance(50); if (fn === 'changeMemberRole') round++; return round <= 3 ? platformProbe() : readyProbe() }, deadlineMs: 60000, intervalMs: 500, now: env.now, sleep: env.sleep })
  record('readiness poll: IAM propagation (platform 401, then application answers) -> READY in round 4', r.status === 'READY' && r.rounds === 4)
}
{
  const env = fakeEnv(); const calls = new Map(); const perRound = new Map()
  const notReady = { 1: 'restoreMember', 2: 'changeMemberRole' }
  const r = await runReadiness({ probe: async fn => { env.advance(50); const n = (calls.get(fn) ?? 0) + 1; calls.set(fn, n); const ok = notReady[n] !== fn; perRound.set(n, (perRound.get(n) ?? 0) + (ok ? 1 : 0)); return ok ? readyProbe() : platformProbe() }, deadlineMs: 60000, intervalMs: 500, now: env.now, sleep: env.sleep })
  record('readiness poll: readiness is per round - a different function not ready in each of two rounds (four of five each time) never adds up to READY; only a round with all five does', r.status === 'READY' && r.rounds === 3 && perRound.get(1) === 4 && perRound.get(2) === 4 && perRound.get(3) === 5 && r.functions.restoreMember.attempts === 3)
}
{
  const env = fakeEnv()
  const r = await runReadiness({ probe: async () => { env.advance(5000); return { error: 'timeout' } }, deadlineMs: 30000, intervalMs: 500, now: env.now, sleep: env.sleep })
  record('readiness poll: timeouts everywhere -> NOT_READY', r.status === 'NOT_READY' && M1_CALLABLES.some(f => r.functions[f].lastVerdict === 'timeout'))
}
{
  const env = fakeEnv()
  const r = await runReadiness({ probe: async () => { env.advance(100); throw new Error('boom') }, deadlineMs: 3000, intervalMs: 500, now: env.now, sleep: env.sleep })
  record('readiness poll: a thrown probe error is a network error, never ready', r.status === 'NOT_READY' && M1_CALLABLES.every(f => r.functions[f].lastVerdict === 'network-error'))
}
record('readiness poll: only the five M1 callables are accepted (four, six or a foreign name is refused)', await (async () => {
  const ok = async fns => { try { await runReadiness({ functions: fns, probe: async () => readyProbe(), deadlineMs: 1000, intervalMs: 100 }); return true } catch { return false } }
  return !(await ok(M1_CALLABLES.slice(0, 4))) && !(await ok([...M1_CALLABLES, 'listInvitations'])) && !(await ok([...M1_CALLABLES.slice(0, 4), 'inviteMember'])) && (await ok([...M1_CALLABLES].reverse())) && sameFunctionSet([...M1_CALLABLES].reverse())
})())
record('readiness poll: staging limits are fixed constants (300 s deadline, 5 s interval, 15 s per request)', JSON.stringify(STAGING_LIMITS) === JSON.stringify({ deadlineMs: 300000, intervalMs: 5000, requestTimeoutMs: 15000 }) && Object.isFrozen(STAGING_LIMITS) && CALLABLE_BODY === '{"data":{}}')
record('readiness args: staging accepts no override of endpoint or limits', ['--deadline-ms', '--interval-ms', '--request-timeout-ms'].every(f => throws(() => parseReadinessArgs(['--target', 'staging', '--expected-head', H, '--out-dir', 'C:\\x', f, '10']))) && throws(() => parseReadinessArgs(['--target', 'staging', '--expected-head', H, '--out-dir', 'C:\\x', '--base-url', 'http://127.0.0.1:1'])))
record('readiness args: staging uses the fixed limits and the fixed Cloud Functions endpoint', (() => { const a = parseReadinessArgs(['--target', 'staging', '--expected-head', H, '--out-dir', 'C:\\x']); return a.baseUrl === 'https://us-central1-finapp-staging.cloudfunctions.net' && JSON.stringify(a.limits) === JSON.stringify(STAGING_LIMITS) })())
record('readiness args: only plain loopback http base URLs are accepted for the emulator', ['https://example.com/x', 'http://example.com/x', 'http://127.0.0.1:1/x?k=v', 'http://user:pw@127.0.0.1:1/x', 'http://[::2]:1/x'].every(u => throws(() => parseReadinessArgs(['--target', 'emulator', '--expected-head', H, '--out-dir', 'C:\\x', '--base-url', u]))) && !throws(() => parseReadinessArgs(['--target', 'emulator', '--expected-head', H, '--out-dir', 'C:\\x', '--base-url', 'http://127.0.0.1:5001/demo-finapp/us-central1'])))

// ── Readiness CLI against a REAL loopback http server (no staging, no other host) ──
const cliPath = path.join(PKG, 'm1-readiness.mjs')
function runCli(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    child.on('close', code => resolve({ code, stdout }))
  })
}
async function withServer(handler, fn) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, seen.length) })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try { return await fn(`http://127.0.0.1:${server.address().port}/fn`, seen) } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)) }
}
const appAnswer = res => { res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' }); res.end(APP_BODY) }
const platformAnswer = res => { res.writeHead(401, { 'content-type': 'text/html; charset=UTF-8' }); res.end('<html><body>The request was not authorized to invoke this service.</body></html>') }
const tmpOut = tag => path.join(os.tmpdir(), `m1-ready-${tag}-${process.pid}-${Date.now()}`)
const cliArgs = (base, out, ms = ['--deadline-ms', '2500', '--interval-ms', '100', '--request-timeout-ms', '600']) => ['--target', 'emulator', '--expected-head', H, '--out-dir', out, '--base-url', base, ...ms]
const readResult = out => JSON.parse(fs.readFileSync(path.join(out, 'readiness-result.json'), 'utf8'))
const readAttempts = out => fs.readFileSync(path.join(out, 'readiness-attempts.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
{
  const out = tmpOut('ready')
  const r = await withServer((req, res) => appAnswer(res), async (base, seen) => {
    const res = await runCli(cliArgs(base, out))
    return { res, seen }
  })
  record('readiness CLI (real HTTP): all five answer from the application layer -> exit 0, READY', r.res.code === 0 && readResult(out).status === 'READY' && readAttempts(out).length === 5)
  record('readiness CLI (real HTTP): one POST per function with the exact callable body, no token, no query', r.seen.length === 5 && r.seen.every(s => s.method === 'POST' && s.body === '{"data":{}}' && !s.headers.authorization && !s.url.includes('?') && /^application\/json/.test(s.headers['content-type'])) && JSON.stringify(r.seen.map(s => s.url.split('/').pop()).sort()) === JSON.stringify([...M1_CALLABLES].sort()))
  fs.rmSync(out, { recursive: true, force: true })
}
{
  const out = tmpOut('platform')
  const r = await withServer((req, res) => platformAnswer(res), base => runCli(cliArgs(base, out)))
  const a = readAttempts(out)
  record('readiness CLI (real HTTP): platform 401 for everything -> exit 2, NOT_READY, nothing accepted', r.code === 2 && readResult(out).status === 'NOT_READY' && a.length >= 5 && a.every(x => !x.ready && x.verdict === 'platform-denied' && x.httpStatus === 401))
  fs.rmSync(out, { recursive: true, force: true })
}
for (const bad of ['listCompanyMembers', 'changeMemberRole']) {
  const out = tmpOut(`one-${bad}`)
  const r = await withServer((req, res) => (req.url.endsWith(`/${bad}`) ? platformAnswer(res) : appAnswer(res)), base => runCli(cliArgs(base, out)))
  const res = readResult(out)
  record(`readiness CLI (real HTTP): ${bad} still answered by the platform while four are ready -> exit 2 (partial readiness refused)`, r.code === 2 && res.status === 'NOT_READY' && res.functions[bad].ready === false && M1_CALLABLES.filter(f => f !== bad).every(f => res.functions[f].ready))
  fs.rmSync(out, { recursive: true, force: true })
}
{
  const out = tmpOut('late')
  const r = await withServer((req, res) => { globalThis.__late = (globalThis.__late ?? 0) + (req.url.endsWith('/listCompanyMembers') ? 1 : 0); if (req.url.endsWith('/listCompanyMembers') && globalThis.__late <= 3) platformAnswer(res); else appAnswer(res) }, base => runCli(cliArgs(base, out, ['--deadline-ms', '6000', '--interval-ms', '100', '--request-timeout-ms', '600'])))
  record('readiness CLI (real HTTP): platform answers first, application answers later -> READY after the propagation delay', r.code === 0 && readResult(out).status === 'READY' && readResult(out).rounds === 4)
  fs.rmSync(out, { recursive: true, force: true })
}
for (const [name, status, ctype, body, want] of [['http-500', 500, 'application/json', '{"error":{}}', 'http-5xx'], ['http-200', 200, 'application/json', '{"result":{}}', 'http-2xx'], ['malformed', 401, 'application/json', '{"error":', 'malformed-json'], ['wrong-appcode', 401, 'application/json', JSON.stringify({ error: { details: { appCode: 'x' }, status: 'UNAUTHENTICATED' } }), 'wrong-app-code'], ['html', 401, 'text/html', APP_BODY, 'platform-denied']]) {
  const out = tmpOut(name)
  const r = await withServer((req, res) => { res.writeHead(status, { 'content-type': ctype }); res.end(body) }, base => runCli(cliArgs(base, out)))
  record(`readiness CLI (real HTTP): ${name} -> exit 2 and verdict ${want}`, r.code === 2 && readAttempts(out).every(x => !x.ready && x.verdict === want))
  fs.rmSync(out, { recursive: true, force: true })
}
{
  const out = tmpOut('refused')
  const r = await runCli(cliArgs('http://127.0.0.1:1/fn', out, ['--deadline-ms', '1500', '--interval-ms', '100', '--request-timeout-ms', '500']))
  record('readiness CLI: connection refused (read error) -> exit 2, verdict network-error', r.code === 2 && readAttempts(out).every(x => !x.ready && x.verdict === 'network-error'))
  fs.rmSync(out, { recursive: true, force: true })
}
{
  const out = tmpOut('slow')
  const r = await withServer(() => { /* never answers */ }, base => runCli(cliArgs(base, out, ['--deadline-ms', '2500', '--interval-ms', '100', '--request-timeout-ms', '300'])))
  const a = readAttempts(out)
  record('readiness CLI (real HTTP): a server that never answers -> per-request timeout, NOT_READY, exit 2', r.code === 2 && a.length >= 1 && a.every(x => !x.ready && x.verdict === 'timeout') && readResult(out).elapsedMs < 6000)
  fs.rmSync(out, { recursive: true, force: true })
}
{
  const out = tmpOut('redirect')
  const r = await withServer((req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end() }, base => runCli(cliArgs(base, out, ['--deadline-ms', '1200', '--interval-ms', '100', '--request-timeout-ms', '400'])))
  record('readiness CLI (real HTTP): redirects are refused (never followed) -> NOT_READY', r.code === 2 && readAttempts(out).every(x => !x.ready))
  fs.rmSync(out, { recursive: true, force: true })
}
{
  const out = tmpOut('existing')
  fs.mkdirSync(out)
  const r = await runCli(cliArgs('http://127.0.0.1:1/fn', out))
  record('readiness CLI: an existing out-dir is refused (run-once), nothing inside is touched', r.code === 2 && fs.readdirSync(out).length === 0)
  fs.rmSync(out, { recursive: true, force: true })
  const inRepo = await runCli(cliArgs('http://127.0.0.1:1/fn', 'D:\\projects\\finapp\\m1-release-714d0f91\\m1-readiness-out'))
  record('readiness CLI: an out-dir inside the repository is refused', inRepo.code === 2 && !fs.existsSync('D:\\projects\\finapp\\m1-release-714d0f91\\m1-readiness-out'))
  const wrongHead = await runCli(['--target', 'emulator', '--expected-head', '8f7d495f03b70a6f279f3622d61d5380db611a92', '--out-dir', tmpOut('head')])
  record('readiness CLI: wrong expected head is refused', wrongHead.code === 2)
}
record('readiness source: the CLI has no Authorization header, no query string and stores no header or body', (() => { const s = fs.readFileSync(cliPath, 'utf8'); return !/authorization/i.test(s.replace(/^\s*\/\/.*$/gm, '')) && !/\.headers\)|appendFile.*bodyText|JSON\.stringify\(res/.test(s) })())

// ── Exact-state checks (pinned staging state) ───────────────────────────────
const fnReport = () => expected.functions.map(f => ({ id: f.id, state: 'ACTIVE', runtime: 'nodejs22', resources: { ...expected.caps }, revision: f.revision, build: f.build, sourceReferenceSha256: f.sourceReferenceSha256 }))
record('expected-state file is structurally valid: 13 functions (8 baseline + 5 M1), pre-release and target Rules, rollback reference, prior evidence pins', validateExpected(expected).length === 0 && expected.functions.length === 13 && PRIOR_RUN_IDS.every(id => expected.priorRunIds.includes(id)))
record('expected-state pins: HEAD 714d0f91, prior head 8526a79, pre ruleset cbfcc160 (raw f8b4cae2, 23936 B), target = LF round-3 file (24015 B, raw = canonical c4fe4c09)', expected.sourceHead === H && expected.priorHead.startsWith('8526a79') && expected.rulesPre.rulesetName.includes('cbfcc160') && expected.rulesPre.rawSha256.startsWith('f8b4cae2') && expected.rulesPre.sourceBytes === 23936 && expected.rulesTarget.rawSha256 === expected.rulesTarget.canonicalSha256 && expected.rulesTarget.sourceBytes === 24015 && expected.rulesTarget.canonicalSha256.startsWith('c4fe4c09'))
record('state: the pinned 13 functions compare clean', compareFunctions(fnReport(), expected).length === 0)
record('state: eight baseline functions unchanged is required (revision, build or source change -> drift)', ['revision', 'build', 'sourceReferenceSha256'].every(k => { const r = fnReport(); r.find(f => f.id === 'createCompany')[k] = k === 'sourceReferenceSha256' ? '0'.repeat(64) : `${r.find(f => f.id === 'createCompany')[k]}x`; return compareFunctions(r, expected).some(p => p.includes(`createCompany ${k} changed`)) }))
record('state: the five M1 functions must keep the pinned revision, build and source', ['revision', 'build', 'sourceReferenceSha256'].every(k => { const r = fnReport(); r.find(f => f.id === 'listCompanyMembers')[k] = 'changed'; return compareFunctions(r, expected).some(p => p.includes(`listCompanyMembers ${k} changed`)) }))
record('state: a missing function, an extra function and a duplicate are all drift', compareFunctions(fnReport().filter(f => f.id !== 'removeMember'), expected).some(p => p.includes('missing function removeMember')) && compareFunctions([...fnReport(), { ...fnReport()[0], id: 'authzProbe' }], expected).some(p => p.includes('unexpected function authzProbe')) && compareFunctions([...fnReport().slice(1), fnReport()[1]], expected).some(p => p.includes('duplicate')))
record('state: caps, runtime and state drift are detected', (() => { const a = fnReport(); a[0].resources.maxInstances = 2; const b = fnReport(); b[1].runtime = 'nodejs20'; const c = fnReport(); c[2].state = 'DEPLOYING'; const d = fnReport(); d[3].resources.extra = 1; return [a, b, c, d].every(r => compareFunctions(r, expected).length > 0) })())
record('state: not an array -> problem', compareFunctions(null, expected).length === 1)
const rulesLine = over => `${JSON.stringify({ task: 'SEC-006 Stage 8', mode: 'verify-current-rules', project: 'finapp-staging', sourceHead: H, rulesetName: expected.rulesPre.rulesetName, canonicalSha256: RULES_PRE, rawSha256: expected.rulesPre.rawSha256, sourceBytes: expected.rulesPre.sourceBytes, status: 'CURRENT_RULES_HASH_VERIFIED', finishedAt: '2026-10-01T00:00:00.000Z', ...over })}\n`
const targetLine = over => rulesLine({ rulesetName: 'projects/finapp-staging/rulesets/00000000-0000-4000-8000-0000000000r3', canonicalSha256: RULES_TARGET, rawSha256: expected.rulesTarget.rawSha256, sourceBytes: expected.rulesTarget.sourceBytes, ...over })
record('rules evidence (pre): the pinned pre-release Rules (ruleset cbfcc160, canonical f117e489, raw f8b4cae2, 23936 bytes) verify', verifyRulesEvidence(rulesLine({}), expected, RULES_PRE).length === 0)
record('rules evidence (pre): another ruleset id, raw hash or size is drift (ID matching alone is not enough)', [{ rulesetName: 'projects/finapp-staging/rulesets/other' }, { rawSha256: '0'.repeat(64) }, { sourceBytes: 1 }].every(o => verifyRulesEvidence(rulesLine(o), expected, RULES_PRE).length > 0))
record('rules evidence: canonical hash, status, project, head and shape are enforced', [{ canonicalSha256: RULES_TARGET }, { status: 'STAGING_RESOURCES_BLOCKED' }, { project: 'finapp-prod-10a83' }, { sourceHead: '8526a791ce3f62dee5a64aa239b795c609a39226' }, { finishedAt: 'x' }].every(o => verifyRulesEvidence(rulesLine(o), expected, RULES_PRE).length > 0) && verifyRulesEvidence(`${rulesLine({})}${rulesLine({})}`, expected, RULES_PRE).length > 0 && verifyRulesEvidence('not json\n', expected, RULES_PRE).length > 0 && verifyRulesEvidence('', expected, RULES_PRE).length > 0)
record('rules evidence (target): the round-3 Rules verify only as a NEW ruleset with the pinned raw hash and size', verifyRulesEvidence(targetLine({}), expected, RULES_TARGET).length === 0)
record('rules evidence (target): the target hash on the OLD ruleset (a no-op deploy), another raw hash or another size is drift', [{ rulesetName: expected.rulesPre.rulesetName }, { rawSha256: '0'.repeat(64) }, { sourceBytes: expected.rulesTarget.sourceBytes + 1 }, { rulesetName: 'projects/other/rulesets/x' }].every(o => verifyRulesEvidence(targetLine(o), expected, RULES_TARGET).length > 0))
record('rules evidence: pre-release evidence never verifies as the target and vice versa; an unknown hash verifies as nothing', verifyRulesEvidence(rulesLine({}), expected, RULES_TARGET).length > 0 && verifyRulesEvidence(targetLine({}), expected, RULES_PRE).length > 0 && verifyRulesEvidence(rulesLine({ canonicalSha256: '1'.repeat(64) }), expected, '1'.repeat(64)).length > 0)
record('rules evidence: the prior head is accepted only when asked for explicitly (provenance of rev8 evidence)', verifyRulesEvidence(rulesLine({ sourceHead: '8526a791ce3f62dee5a64aa239b795c609a39226' }), expected, RULES_PRE, '8526a791ce3f62dee5a64aa239b795c609a39226').length === 0)

// ── Local Rules pins: the target file and the round-2 reference ────────────────────────────────
{
  const target = fs.readFileSync(path.join(REPO, 'firestore.rules'))
  const blob = fs.readFileSync(path.join(PKG, expected.rollback.blobFile))
  record('local rules: the release clone file is the pinned LF round-3 target and the shipped round-2 reference CRLF-converts to the live pre-release bytes', localRulesProblems(expected, target, blob).length === 0, localRulesProblems(expected, target, blob))
  record('local rules: the round-3 text hashes differently from the round-2 text (the Rules really change)', RULES_PRE !== RULES_TARGET && canonicalOf(blob.toString('utf8')) === RULES_PRE && canonicalOf(target.toString('utf8')) === RULES_TARGET)
  record('local rules: a changed byte, a CRLF target, a swapped file or a tampered reference are all refused', [
    localRulesProblems(expected, Buffer.concat([target, Buffer.from('\n')]), blob),
    localRulesProblems(expected, Buffer.from(target.toString('utf8').replace(/\n/g, '\r\n')), blob),
    localRulesProblems(expected, blob, blob),
    localRulesProblems(expected, target, target),
    localRulesProblems(expected, target, Buffer.concat([blob, Buffer.from(' ')])),
  ].every(p => p.length > 0))
}

// ── Provenance of the prior (rev8) evidence (real files, read-only) and tamper detection on COPIES ──
const readPrior = (evRoot, runRoot) => (root, rel) => { const f = path.join(root === 'evidence' ? evRoot : runRoot, ...rel.split('/')); return fs.existsSync(f) ? fs.readFileSync(f) : null }
record('provenance: the real rev8 evidence verifies (pinned hashes, STAGE_PASS, functions, Rules, zero synthetic data left)', verifyProvenance(expected, readPrior(PRIOR_EV, PRIOR_RUN)).length === 0, verifyProvenance(expected, readPrior(PRIOR_EV, PRIOR_RUN)))
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-prov-'))
  const evc = path.join(root, 'evidence'), runc = path.join(root, 'run')
  for (const pin of expected.priorEvidence) {
    const dstRoot = pin.root === 'evidence' ? evc : runc
    const dst = path.join(dstRoot, ...pin.path.split('/'))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(path.join(pin.root === 'evidence' ? PRIOR_EV : PRIOR_RUN, ...pin.path.split('/')), dst)
  }
  const check = () => verifyProvenance(expected, readPrior(evc, runc))
  record('provenance: a byte-exact COPY of the pinned rev8 files verifies', check().length === 0)
  const tamper = (rel, root2, fn) => { const f = path.join(root2, ...rel.split('/')); const orig = fs.readFileSync(f); fs.writeFileSync(f, fn(orig)); const p = check(); fs.writeFileSync(f, orig); return p }
  record('provenance: a changed rev8 final functions record is detected', tamper('m1-stg-functions-state-final-rev8.json', evc, b => Buffer.from(b.toString('utf8').replace(expected.functions[0].revision, `${expected.functions[0].revision}x`))).some(p => p.includes('changed evidence/m1-stg-functions-state-final-rev8.json')))
  record('provenance: a changed rev8 final Rules journal is detected', tamper('m1-stg-rules-state-final-rev8.jsonl', evc, b => Buffer.from(b.toString('utf8').replace('cbfcc160', 'cbfcc161'))).length > 0)
  record('provenance: a changed rev8 result (STAGE_PASS -> SAFE_STOP) is detected', tamper('orchestrator-result.json', evc, b => Buffer.from(b.toString('utf8').replace('STAGE_PASS', 'SAFE_STOP'))).length > 0)
  record('provenance: a changed rev8 verify-clean result is detected', tamper('result-verify-clean-1790091986509.json', runc, b => Buffer.from(b.toString('utf8').replace(/"remaining":\s*0/, '"remaining": 2'))).length > 0)
  record('provenance: a missing rev8 file is detected', (() => { const f = path.join(evc, 'orchestrator-result.json'); const orig = fs.readFileSync(f); fs.rmSync(f); const p = check(); fs.writeFileSync(f, orig); return p.some(x => x.startsWith('missing evidence/orchestrator-result.json')) })())
  const forged = structuredClone(expected)
  forged.rulesPre.rawSha256 = '1'.repeat(64)
  record('provenance: an expected-state whose pins disagree with the evidence is refused', verifyProvenance(forged, readPrior(PRIOR_EV, PRIOR_RUN)).length > 0)
  const forgedFn = structuredClone(expected)
  forgedFn.functions[0].revision = `${forgedFn.functions[0].revision}x`
  record('provenance: pinned functions that disagree with the evidence are refused', verifyProvenance(forgedFn, readPrior(PRIOR_EV, PRIOR_RUN)).length > 0)
  fs.rmSync(root, { recursive: true, force: true })
}

// ── m1-state-check CLI ──────────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-statecheck-'))
  const tool = path.join(PKG, 'm1-state-check.mjs')
  const expectedFile = path.join(PKG, 'expected-state-r3.json')
  const cli = args => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' })
  const good = path.join(dir, 'good.json')
  fs.writeFileSync(good, JSON.stringify({ project: 'finapp-staging', sourceHead: H, status: 'M1_FUNCTIONS_EXACT_STATE_VERIFIED', functions: fnReport() }))
  record('state-check CLI: a report of the pinned 13 functions -> OK (exit 0)', cli(['--mode', 'functions', '--expected', expectedFile, '--evidence', good, '--out', path.join(dir, 'o1.json')]).status === 0)
  const bad = path.join(dir, 'bad.json')
  const drifted = fnReport(); drifted.find(f => f.id === 'listCompanyMembers').build = 'x'
  fs.writeFileSync(bad, JSON.stringify({ project: 'finapp-staging', sourceHead: H, status: 'M1_FUNCTIONS_EXACT_STATE_VERIFIED', functions: drifted }))
  const badRun = cli(['--mode', 'functions', '--expected', expectedFile, '--evidence', bad, '--out', path.join(dir, 'o2.json')])
  record('state-check CLI: a drifted report -> BLOCKED (exit 2) and the report file lists problems only', badRun.status === 2 && JSON.parse(fs.readFileSync(path.join(dir, 'o2.json'), 'utf8')).status === 'BLOCKED')
  record('state-check CLI: refuses to overwrite an existing report and refuses extra arguments', cli(['--mode', 'functions', '--expected', expectedFile, '--evidence', good, '--out', path.join(dir, 'o1.json')]).status === 2 && cli(['--mode', 'functions', '--expected', expectedFile, '--evidence', good, '--out', path.join(dir, 'o3.json'), '--force', 'x']).status === 2)
  record('state-check CLI: provenance of the real rev8 directories -> OK', cli(['--mode', 'provenance', '--expected', expectedFile, '--evidence-root', PRIOR_EV, '--run-root', PRIOR_RUN, '--out', path.join(dir, 'o4.json')]).status === 0)
  const preFile = path.join(dir, 'pre.jsonl'); fs.writeFileSync(preFile, rulesLine({}))
  const targetFile = path.join(dir, 'target.jsonl'); fs.writeFileSync(targetFile, targetLine({}))
  const noopFile = path.join(dir, 'noop.jsonl'); fs.writeFileSync(noopFile, targetLine({ rulesetName: expected.rulesPre.rulesetName }))
  record('state-check CLI: pre-release evidence verifies as pre (exit 0) and NOT as the target (exit 2)', cli(['--mode', 'rules', '--expected', expectedFile, '--evidence', preFile, '--canonical', RULES_PRE, '--out', path.join(dir, 'r1.json')]).status === 0 && cli(['--mode', 'rules', '--expected', expectedFile, '--evidence', preFile, '--canonical', RULES_TARGET, '--out', path.join(dir, 'r2.json')]).status === 2)
  record('state-check CLI: target evidence verifies as the target (new ruleset) and a no-op deploy (old ruleset) does not', cli(['--mode', 'rules', '--expected', expectedFile, '--evidence', targetFile, '--canonical', RULES_TARGET, '--out', path.join(dir, 'r3.json')]).status === 0 && cli(['--mode', 'rules', '--expected', expectedFile, '--evidence', noopFile, '--canonical', RULES_TARGET, '--out', path.join(dir, 'r4.json')]).status === 2)
  record('state-check CLI: local-rules on the real release clone -> OK', cli(['--mode', 'local-rules', '--expected', expectedFile, '--repo', REPO, '--out', path.join(dir, 'l1.json')]).status === 0)
  const fakeRepo = path.join(dir, 'repo'); fs.mkdirSync(fakeRepo)
  fs.writeFileSync(path.join(fakeRepo, 'firestore.rules'), `${fs.readFileSync(path.join(REPO, 'firestore.rules'), 'utf8')}// x\n`)
  record('state-check CLI: local-rules on a clone with a changed firestore.rules -> BLOCKED', cli(['--mode', 'local-rules', '--expected', expectedFile, '--repo', fakeRepo, '--out', path.join(dir, 'l2.json')]).status === 2)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── Rollback preparation: the FRESH backup of the live pre-release Rules (synthetic here; the real one is a cloud read) ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-rollprep-'))
  const tool = path.join(PKG, 'm1-rules-rollback-prepare.mjs')
  const blobFile = path.join(PKG, expected.rollback.blobFile)
  const live = fs.readFileSync(blobFile, 'utf8').replace(/\r?\n/g, '\r\n')
  const mkBackup = (file, content, over = {}) => fs.writeFileSync(file, JSON.stringify({ format: 'finapp-rules-backup-v1', project: 'finapp-staging', database: 'projects/finapp-staging/databases/(default)', sourceHead: H, capturedAt: '2026-10-01T00:00:00.000Z',
    rulesetName: expected.rulesPre.rulesetName, release: { name: 'projects/finapp-staging/releases/cloud.firestore', rulesetName: expected.rulesPre.rulesetName }, source: { files: [{ name: 'firestore.rules', content }] },
    canonicalSha256: canonicalOf(content), rawSha256: sha256hex(content), sourceBytes: Buffer.byteLength(content), ...over }))
  const backup = path.join(dir, 'backup.json'); mkBackup(backup, live)
  const base = ['--backup', backup, '--expected-rules-hash', RULES_PRE, '--expected-raw-sha256', expected.rulesPre.rawSha256, '--expected-bytes', String(expected.rulesPre.sourceBytes), '--compare-rules', blobFile]
  const cli = (args, out) => spawnSync(process.execPath, [tool, ...args, '--out-dir', path.join(dir, out)], { encoding: 'utf8' })
  const ok = cli(base, 'ok')
  const written = fs.existsSync(path.join(dir, 'ok', 'firestore.rules')) ? fs.readFileSync(path.join(dir, 'ok', 'firestore.rules')) : Buffer.alloc(0)
  record('rollback-prepare: a backup of the live pre-release Rules (raw f8b4cae2..., 23936 bytes, CRLF) is verified and the written rules equal it byte for byte', ok.status === 0 && sha256hex(written) === expected.rulesPre.rawSha256 && written.length === 23936 && written.equals(Buffer.from(live)))
  record('rollback-prepare: the rollback firebase.json lists only the Rules file', JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'ok', 'firebase.json'), 'utf8'))) === JSON.stringify({ firestore: { rules: 'firestore.rules' } }) && fs.readdirSync(path.join(dir, 'ok')).sort().join(',') === 'firebase.json,firestore.rules')
  const withArg = (k, v) => { const a = [...base]; a[a.indexOf(k) + 1] = v; return a }
  record('rollback-prepare: wrong canonical hash, raw hash, size or reference file -> refused, nothing written', [
    cli(withArg('--expected-rules-hash', RULES_TARGET), 'b1'), cli(withArg('--expected-raw-sha256', '0'.repeat(64)), 'b2'), cli(withArg('--expected-bytes', '23937'), 'b3'), cli(withArg('--compare-rules', path.join(REPO, 'firestore.rules')), 'b4'),
  ].every((r, i) => r.status === 2 && !fs.existsSync(path.join(dir, `b${i + 1}`))))
  const tampered = path.join(dir, 'tampered.json'); mkBackup(tampered, live.replace('rules_version', 'rules_versioN'))
  record('rollback-prepare: a one-byte-tampered backup -> refused', cli(withArg('--backup', tampered), 'b5').status === 2 && !fs.existsSync(path.join(dir, 'b5')))
  const lf = path.join(dir, 'lf.json'); mkBackup(lf, fs.readFileSync(blobFile, 'utf8'))
  record('rollback-prepare: a backup with LF endings (not the pinned live raw bytes) -> refused: the rollback must publish the exact live bytes', cli(withArg('--backup', lf), 'b6').status === 2)
  const lying = path.join(dir, 'lying.json'); mkBackup(lying, live, { rawSha256: '2'.repeat(64) })
  record('rollback-prepare: a backup whose recorded hash disagrees with its content -> refused', cli(withArg('--backup', lying), 'b7').status === 2)
  record('rollback-prepare: an existing out-dir is refused', (() => { fs.mkdirSync(path.join(dir, 'exists')); return cli(base, 'exists').status === 2 })())
  record('rollback-prepare: missing or duplicated arguments are refused', spawnSync(process.execPath, [tool, ...base.slice(0, 6), '--out-dir', path.join(dir, 'b8')], { encoding: 'utf8' }).status === 2 && spawnSync(process.execPath, [tool, ...base, ...base.slice(0, 2), '--out-dir', path.join(dir, 'b9')], { encoding: 'utf8' }).status === 2)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── Firestore export helper (pure parts; the cloud call itself is never made here) ──────────────
{
  const uri = 'gs://my-backups/finapp/staging'
  const at = new Date('2026-10-01T12:34:56.789Z')
  const prefix = exportPrefix(uri, H, at)
  record('export: the prefix is unique per run (<uri>/m1-r3-<head8>-<UTC stamp>) and valid', prefix === 'gs://my-backups/finapp/staging/m1-r3-714d0f91-20261001T123456Z' && URI_PATTERN.test(uri))
  record('export: unsafe or malformed URIs are refused (no path, trailing slash, traversal, spaces, quotes, shell metacharacters, uppercase bucket)', ['gs://bucket-only', 'gs://my-backups/', 'gs://my-backups/a/', 'gs://my-backups/../x', 'gs://my-backups/a b', 'gs://my-backups/a"b', 'gs://my-backups/a&calc', 'gs://My-Backups/a', 'https://my-backups/a', 'gs://my-backups/a;b', 'gs://my-backups/a|b', ''].every(u => throws(() => exportPrefix(u, H, at))))
  record('export: gcloud argument vectors are exact (finapp-staging only, default database, JSON output)', JSON.stringify(exportArgs(prefix)) === JSON.stringify(['firestore', 'export', prefix, '--project=finapp-staging', '--format=json']) && JSON.stringify(listArgs(prefix)) === JSON.stringify(['storage', 'ls', `${prefix}/`, '--project=finapp-staging']))
  const op = (over = {}) => JSON.stringify({ name: 'projects/finapp-staging/databases/(default)/operations/x', done: true, metadata: { operationState: 'SUCCESSFUL', outputUriPrefix: prefix, startTime: '2026-10-01T12:34:56Z', endTime: '2026-10-01T12:35:10Z' }, ...over })
  record('export: a done SUCCESSFUL operation with the requested prefix is accepted', exportOperationProblems(op(), prefix).length === 0)
  record('export: operation response may carry the prefix instead of the metadata (both shapes accepted)', exportOperationProblems(JSON.stringify({ done: true, metadata: { operationState: 'SUCCESSFUL' }, response: { outputUriPrefix: `${prefix}/` } }), prefix).length === 0)
  record('export: not done, FAILED/CANCELLED/PROCESSING, an error, a foreign prefix, no JSON, an array of two or an empty object are all refused', [
    op({ done: false }), op({ metadata: { operationState: 'FAILED', outputUriPrefix: prefix } }), op({ metadata: { operationState: 'CANCELLED', outputUriPrefix: prefix } }), op({ metadata: { operationState: 'PROCESSING', outputUriPrefix: prefix } }),
    op({ error: { code: 7 } }), op({ metadata: { operationState: 'SUCCESSFUL', outputUriPrefix: 'gs://other/x' } }), 'Waiting for [operation] to complete...done.', `[${op()},${op()}]`, '{}', 'null',
  ].every(t => exportOperationProblems(t, prefix).length > 0))
  record('export: only an overall_export_metadata object UNDER the prefix proves the export; other listings do not', listingProblems(`${prefix}/m1-r3.overall_export_metadata\n${prefix}/all_namespaces/\n`, prefix).length === 0 && ['', `${prefix}/other.txt\n`, 'gs://elsewhere/x.overall_export_metadata\n', `${prefix}x/a.overall_export_metadata\n`].every(t => listingProblems(t, prefix).length > 0))
  record('export: gcloud arguments outside the safe character set are refused before any process starts', throws(() => gcloudCommand('rehearsal', ['firestore', 'export', 'gs://b/a&b'], { M1_STUB_SCENARIO: 's', M1_STUB_STATE: 'd' })) && throws(() => gcloudCommand('rehearsal', ['x y'], { M1_STUB_SCENARIO: 's', M1_STUB_STATE: 'd' })))
  const cleanE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^M1_STUB_/i.test(k) && !/EMULATOR|^CLOUDSDK_CORE_PROJECT$|^CLOUDSDK_AUTH/i.test(k) && !['GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED'].includes(k.toUpperCase())))
  record('export: staging refuses stub, emulator, alternate-credential and project-override environments', [{ M1_STUB_SCENARIO: 'x' }, { FIRESTORE_EMULATOR_HOST: 'x' }, { GOOGLE_APPLICATION_CREDENTIALS: 'x' }, { CLOUDSDK_CORE_PROJECT: 'finapp-prod-10a83' }, { CLOUDSDK_AUTH_ACCESS_TOKEN: 'x' }].every(o => throws(() => gcloudCommand('staging', ['version'], { ...cleanE, ...o }))))
  record('export: rehearsal needs the stub scenario and state and runs the stub under the no-network preload', throws(() => gcloudCommand('rehearsal', ['version'], {})) && (() => { const c = gcloudCommand('rehearsal', ['version'], { M1_STUB_SCENARIO: 's', M1_STUB_STATE: 'd' }); return c.args[0] === '--require' && c.args[1].endsWith('no-network.cjs') && c.args[2].endsWith('stub-gcloud.mjs') })())
  const gcloud = findGcloudCmd()
  if (gcloud) {
    // Local-only command: proves the cmd.exe/verbatim spawn mechanics against the real gcloud.cmd (quotes, spaces and parentheses in the path).
    const c = gcloudCommand('staging', ['version'], cleanE)
    const r = spawnSync(c.file, c.args, { shell: false, windowsHide: true, windowsVerbatimArguments: c.verbatim, encoding: 'utf8', env: cleanE, timeout: 120000 })
    record('export: the real gcloud.cmd starts through the verbatim cmd.exe command line (gcloud version, local only)', r.status === 0 && /Google Cloud SDK/.test(r.stdout), { status: r.status })
  } else record('export: gcloud.cmd is not installed on this machine (spawn mechanics not exercised)', false)
}
{
  const exportSource = fs.readFileSync(path.join(PKG, 'm1-export.mjs'), 'utf8')
  record('export source: no shell:true, no exec/execSync, a single `firestore export` argument vector and no delete/import/restore verbs', !/shell: true/.test(exportSource) && !/\bexecSync\(|\bexec\(/.test(exportSource) && (exportSource.match(/'firestore', 'export'/g) ?? []).length === 1 && !/'delete'|'import'|'restore'|'rm'/.test(exportSource))
}

// ── Release gates in the orchestrator source (static) ───────────────────────────────────────────
{
  const orch = fs.readFileSync(path.join(PKG, 'm1-orchestrator.ps1'), 'utf8')
  const at = re => orch.search(re)
  record('orchestrator source: order is Functions check -> backup -> readiness -> preflight -> export -> frontend -> Rules deploy -> smoke', [/'functions-state-pre'/, /'rules-backup'/, /'readiness' \(ToolArgs/, /'smoke-preflight'/, /'firestore-export'/, /FRONTEND_READY/, /'deploy-rules'/, /foreach \(\$stage in/].every((re, i, a) => at(re) > 0 && (i === 0 || at(re) > at(a[i - 1]))))
  record('orchestrator source: the deploy runs only after a verified export no older than 30 minutes, and the export has no retry', /\$ExportMaxAgeMinutes\s+= 30/.test(orch) && /EXPORT_VERIFIED/.test(orch) && (orch.match(/'firestore-export'/g) ?? []).length === 1 && /export is not fresh/.test(orch))
  record('orchestrator source: the forward deploy and the rollback each appear exactly once, and no Functions/indexes deploy exists', (orch.match(/'--kind', 'rules'/g) ?? []).length === 1 && (orch.match(/'--kind', 'rules-rollback'/g) ?? []).length === 1 && !/--only', 'functions|firebase deploy|functions:changeMemberRole/.test(orch))
  record('orchestrator source: a deploy that is not confirmed ends in STOP, with a rollback unless the live Rules are verified unchanged', /rules deploy not confirmed; the live Rules are verified unchanged/.test(orch) && /Invoke-RulesRollback 'e:/.test(orch) && /Verify-LiveRules 'rules-state-reverify'/.test(orch))
  record('orchestrator source: Functions and Firebase config are proven unchanged since 8526a79 and the pinned Rules files are checked in step 0', /git diff --quiet \$PriorHead \$H -- functions firebase\.json firestore\.indexes\.json \.firebaserc/.test(orch) && /'--mode', 'local-rules'/.test(orch))
  record('orchestrator source: a 60-second Rules settle wait (staging only) sits between the confirmed deploy and the first smoke mode', /\$RulesSettleSeconds\s+= if \(\$RunProfile -eq 'staging'\) \{ 60 \} else \{ 0 \}/.test(orch) && at(/RULES_SETTLE_WAIT/) > at(/\$State\.rulesTargetVerified = \$true/) && at(/RULES_SETTLE_WAIT/) < at(/foreach \(\$stage in/) && /Start-Sleep -Seconds \$RulesSettleSeconds/.test(orch))
  record('orchestrator source: smoke modes are seed, ui, api, ui-r3 in this order', /@\('seed', 'ui', 'api', 'ui-r3'\)/.test(orch))
  record('orchestrator source: the Rules constants are the pinned pre-release and target canonical hashes', orch.includes(`$PRE       = '${RULES_PRE}'`) && orch.includes(`$TARGET    = '${RULES_TARGET}'`) && orch.includes(`$H         = '${H}'`) && orch.includes("$CiRunId   = '36830077757'"))
  record('orchestrator source: the fixed repository is the release clone and the evidence/run names are new (no rev8 path can be reused)', orch.includes("$Repo      = 'D:\\projects\\finapp\\m1-release-714d0f91'") && orch.includes("'m1-stg-r4-714d0f91'") && orch.includes("'m1-staging-run-714d0f91-v6'") && !/m1-stg-rev8-8526a79'\)|m1-staging-run-8526a79-rev8'\)/.test(orch.replace(/\$Prior\w+\s*=\s*'[^']+'/g, '')))
}

// ── Budgets of the R3 smoke ─────────────────────────────────────────────────────────────────────
record('budget: the R3 smoke may create at most 25 documents and the audit/seed counts match the new probes', DOC_BUDGET.seedCreates === 4 && DOC_BUDGET.apiAuditEvents === 6 && MAX_DOCUMENTS === 25)

// ── Fresh identities: a new run never reuses a previous run id ──────────────
record('identity: rev7 and rev8 run ids (bbb573d8, acf785fd) are on the forbidden list', PRIOR_RUN_IDS.includes('bbb573d8') && PRIOR_RUN_IDS.includes('acf785fd'))
record('identity: pickRunId never returns a forbidden id (skips it) and refuses malformed ids', (() => { const seq = ['bbb573d8', 'acf785fd', 'zzzzzzzz', 'a1b2c3d4']; return pickRunId(() => seq.shift()) === 'a1b2c3d4' })() && throws(() => pickRunId(() => 'acf785fd')))
record('identity: a new fixture plan derives emails, company names and the orphan probe from a fresh run id', (() => { const p = newFixturePlan(); return !PRIOR_RUN_IDS.includes(p.runId) && Object.values(p.users).every(u => u.email.startsWith(`m1-${p.runId}-`)) && p.companies.A.name.endsWith(p.runId) && p.orphanProbeId === `m1-${p.runId}-orphan-probe` && Object.values(p.users).every(u => u.uid === null) && p.companies.A.id === null })())
record('identity: two fixture plans differ (random 32-bit run ids)', newFixturePlan().runId !== newFixturePlan().runId)

// ── Node versions: Node 24 for the CLI, Node 22 for the Functions code ─────
{
  const n22 = 'D:\\projects\\finapp\\.runtime\\node22-portable\\node-v22.23.3-win-x64\\node.exe'
  const v22 = fs.existsSync(n22) ? spawnSync(n22, ['--version'], { encoding: 'utf8' }).stdout.trim() : ''
  record('node: this test and every package tool run on Node 24.16 (CLI/deploy runtime)', process.version.startsWith('v24.16.'), process.version)
  record('node: Node 22 is available for the Functions build and reports v22.x', v22.startsWith('v22.'), v22)
  const orch = fs.readFileSync(path.join(PKG, 'm1-orchestrator.ps1'), 'utf8')
  record('node: the orchestrator builds the Functions with Node 22 (npm-cli.js through node.exe of Node22Dir) and restores Node 24', /functions-build-node22/.test(orch) && /\$n22 \$npmCli --prefix functions run build/.test(orch) && /root node not restored/.test(orch))
}

// ── No-network proof ────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-nonet-'))
const probe = path.join(tmp, 'probe.mjs')
fs.writeFileSync(probe, `
import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns'; import tls from 'node:tls'
const tries = { fetch: () => fetch('https://example.com/'), net: () => net.connect(443, 'example.com'), http: () => http.get('http://example.com/'), https: () => https.get('https://example.com/'), dns: () => dns.lookup('example.com', () => {}), tls: () => tls.connect(443, 'example.com') }
const out = {}
for (const [k, fn] of Object.entries(tries)) { try { const r = fn(); if (r && typeof r.then === 'function') await r; out[k] = 'NOT BLOCKED' } catch (e) { out[k] = e.code === 'M1_STUB_NETWORK_BLOCKED' ? 'blocked' : 'other:' + e.code } }
console.log(JSON.stringify(out))
`)
const netLog = path.join(tmp, 'network-attempts.jsonl')
const p = spawnSync(process.execPath, ['--require', path.join(PKG, 'stubs', 'no-network.cjs'), probe], { encoding: 'utf8', env: { ...process.env, M1_STUB_NETWORK_LOG: netLog } })
let probeOut = {}
try { probeOut = JSON.parse(p.stdout.trim()) } catch { /* reported below */ }
record('no-network: fetch, net, http, https, dns and tls are all blocked in a preloaded process', ['fetch', 'net', 'http', 'https', 'dns', 'tls'].every(k => probeOut[k] === 'blocked'), probeOut)
record('no-network: every blocked attempt is logged', (fs.existsSync(netLog) ? fs.readFileSync(netLog, 'utf8').split('\n').filter(Boolean).length : 0) === 6)
for (const stub of ['stub-gh.mjs', 'stub-firebase.mjs', 'stub-staging-tools.mjs', 'stub-smoke.mjs', 'stub-readiness.mjs', 'stub-gcloud.mjs']) {
  const r = spawnSync(process.execPath, [path.join(PKG, 'stubs', stub)], { encoding: 'utf8', env: { ...process.env, M1_STUB_SCENARIO: path.join(PKG, 'stubs', 'scenarios', 'pass-stub-clean.json'), M1_STUB_STATE: tmp } })
  record(`no-network: ${stub} refuses to run without the preload`, r.status === 98)
}
const netImports = ['stub-lib.mjs', 'stub-gh.mjs', 'stub-firebase.mjs', 'stub-staging-tools.mjs', 'stub-smoke.mjs', 'stub-readiness.mjs', 'stub-gcloud.mjs', '../m1-readiness-lib.mjs', '../m1-state-lib.mjs'].filter(f => /node:(net|http|https|tls|dns|http2|dgram)'|\bfetch\(/.test(fs.readFileSync(path.join(PKG, 'stubs', f), 'utf8')))
record('no-network: stub sources and the pure libraries they run import no network module and never call fetch', netImports.length === 0, netImports)

// ── Stub strictness ─────────────────────────────────────────────────────────
const stubRun = (stub, args, scenario = 'pass-stub-clean', state = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-stubstate-')), cwd = undefined) => ({ state, r: spawnSync(process.execPath, ['--require', path.join(PKG, 'stubs', 'no-network.cjs'), path.join(PKG, 'stubs', stub), ...args], { encoding: 'utf8', cwd, env: { ...process.env, M1_STUB_SCENARIO: path.join(PKG, 'stubs', 'scenarios', `${scenario}.json`), M1_STUB_STATE: state } }) })
record('stub-gh: unknown arguments refused', stubRun('stub-gh.mjs', ['run', 'view', '36830077757', '--repo', 'Alexspb-spb1/finapp', '--json', 'jobs', '--jq', '.jobs']).r.status === 96 && stubRun('stub-gh.mjs', ['run', 'view', '34633900626', '--repo', 'Alexspb-spb1/finapp', '--json', 'databaseId,headSha,status,conclusion,jobs']).r.status === 96 && stubRun('stub-gh.mjs', ['run', 'view', '36830077757', '--repo', 'someone/else', '--json', 'databaseId,headSha,status,conclusion,jobs']).r.status === 96 && stubRun('stub-gh.mjs', ['run', 'view', '36830077757', '--json', 'databaseId,headSha,status,conclusion,jobs']).r.status === 96)
{
  const { state, r } = stubRun('stub-gh.mjs', GH_ARGS)
  const again = stubRun('stub-gh.mjs', GH_ARGS, 'pass-stub-clean', state).r
  record('stub-gh: exact arguments accepted once, second call refused', r.status === 0 && again.status === 97)
}
record('stub-firebase: a Functions deploy vector is refused (the R3 release deploys no Functions)', stubRun('stub-firebase.mjs', ['deploy', '--project', 'finapp-staging', '--only', 'functions:changeMemberRole,functions:disableMember,functions:restoreMember,functions:removeMember,functions:listCompanyMembers', '--non-interactive'], 'pass-stub-clean', undefined, REPO).r.status === 96)
record('stub-firebase: production project, indexes and a bare deploy are refused', [['deploy', '--project', 'finapp-prod-10a83', '--only', 'firestore:rules', '--non-interactive'], ['deploy', '--project', 'finapp-staging', '--only', 'firestore:indexes', '--non-interactive'], ['deploy', '--project', 'finapp-staging', '--non-interactive']].every(a => stubRun('stub-firebase.mjs', a, 'pass-stub-clean', undefined, REPO).r.status === 96))
{
  const args = deployArgs('rules')
  const first = stubRun('stub-firebase.mjs', args, 'pass-stub-clean', undefined, REPO)
  const again = stubRun('stub-firebase.mjs', args, 'pass-stub-clean', first.state, REPO).r
  record('stub-firebase: the forward Rules vector is accepted once (it checks the repository file is the pinned round-3 file), repeat refused', first.r.status === 0 && again.status === 97)
  const wrongCwd = stubRun('stub-firebase.mjs', args, 'pass-stub-clean', undefined, PKG).r
  record('stub-firebase: the forward deploy refuses when the working directory does not hold the pinned round-3 Rules', wrongCwd.status !== 0)
}
{
  const cfgDir = path.join(tmp, 'm1-stg-rules-rollback-r3'); fs.mkdirSync(cfgDir, { recursive: true })
  fs.writeFileSync(path.join(cfgDir, 'firebase.json'), '{}')
  fs.writeFileSync(path.join(cfgDir, 'firestore.rules'), Buffer.from(fs.readFileSync(path.join(PKG, expected.rollback.blobFile), 'utf8').replace(/\r?\n/g, '\r\n')))
  const args = deployArgs('rules-rollback', path.join(cfgDir, 'firebase.json'))
  const { state, r } = stubRun('stub-firebase.mjs', args)
  const again = stubRun('stub-firebase.mjs', args, 'pass-stub-clean', state).r
  record('stub-firebase: the rollback vector is accepted once (it checks the rollback bytes are the pinned pre-release bytes), repeat refused', r.status === 0 && again.status === 97)
  fs.writeFileSync(path.join(cfgDir, 'firestore.rules'), 'rules_version = \'2\';')
  record('stub-firebase: a rollback directory with other rules is refused', stubRun('stub-firebase.mjs', args).r.status === 96)
}
{
  const prefix = 'gs://my-backups/finapp/staging/m1-r3-714d0f91-20261001T123456Z'
  const a = stubRun('stub-gcloud.mjs', exportArgs(prefix))
  const l = stubRun('stub-gcloud.mjs', listArgs(prefix), 'pass-stub-clean', a.state)
  const again = stubRun('stub-gcloud.mjs', exportArgs(prefix), 'pass-stub-clean', a.state).r
  record('stub-gcloud: the export and the listing vectors are accepted once each; a repeated export is refused', a.r.status === 0 && l.r.status === 0 && again.status === 97 && exportOperationProblems(a.r.stdout, prefix).length === 0 && listingProblems(l.r.stdout, prefix).length === 0)
  record('stub-gcloud: another project, another prefix shape, a delete or an import is refused', [['firestore', 'export', prefix, '--project=finapp-prod-10a83', '--format=json'], ['firestore', 'export', 'gs://b/x/other', '--project=finapp-staging', '--format=json'], ['firestore', 'import', prefix, '--project=finapp-staging'], ['storage', 'rm', `${prefix}/`, '--project=finapp-staging'], ['firestore', 'export', prefix, '--project=finapp-staging']].every(x => stubRun('stub-gcloud.mjs', x).r.status === 96))
  record('stub-gcloud: a listing of a prefix that was never exported is refused', stubRun('stub-gcloud.mjs', listArgs(prefix)).r.status === 96)
}
{
  const args = ['--target', 'emulator', '--expected-head', H, '--out-dir', path.join(tmp, 'rd1'), '--deadline-ms', '10000', '--interval-ms', '500', '--request-timeout-ms', '2000']
  const a = stubRun('stub-readiness.mjs', args)
  const again = stubRun('stub-readiness.mjs', args, 'pass-stub-clean', a.state).r
  const stagingTarget = stubRun('stub-readiness.mjs', ['--target', 'staging', ...args.slice(2)]).r
  record('stub-readiness: exact arguments accepted once (the REAL polling code runs under the no-network preload); repeat and staging target refused', a.r.status === 0 && again.status === 97 && stagingTarget.status === 96 && JSON.parse(fs.readFileSync(path.join(tmp, 'rd1', 'readiness-result.json'), 'utf8')).status === 'READY')
}

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter(r => !r.pass).length
const outDir = path.join(PKG, 'results')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'node-helper-tests.json'), `${JSON.stringify({ total: results.length, failed, results, at: new Date().toISOString() }, null, 2)}\n`)
console.log(`NODE_HELPER_TESTS ${failed ? 'FAIL' : 'PASS'} ${results.length - failed}/${results.length}`)
process.exitCode = failed ? 1 : 0
