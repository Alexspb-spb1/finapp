// Tests of the v5 export polling (the first staging run stopped because gcloud printed operationState PROCESSING for an operation that
// finished seconds later). Local only: pure functions with a fake describe/clock, the Windows cmd.exe helper arguments, and the packaged
// m1-export.mjs CLI against the stub gcloud (rehearsal profile, no network). No cloud is ever contacted.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  describeArgs, exportArgs, listArgs, parseOperation, operationTimeProblems, freshnessAnchor, DESCRIBE_TIMEOUT_MS, CLOCK_SKEW_MS, operationIdOf, classifyOperation, exportOperationProblems, awaitOperation, pollSettings, gcloudCommand,
  findGcloudCmd, POLL_INTERVAL_MS, POLL_DEADLINE_MS,
} from '../m1-export.mjs'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const H = '714d0f91c60a582ee87dc7da82d6249b3106329f'
const results = []
const record = (name, pass, detail) => { results.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`) }
const throws = fn => { try { fn(); return false } catch { return true } }
const prefix = 'gs://my-backups/finapp/staging/m1-r3-714d0f91-20261004T193154Z'
const NAME = 'projects/finapp-staging/databases/(default)/operations/ASBlZWM4YThhYTRm'
const meta = (state, extra = {}) => ({ '@type': 'type.googleapis.com/google.firestore.admin.v1.ExportDocumentsMetadata', operationState: state, outputUriPrefix: prefix, startTime: '2026-10-04T19:32:37Z', ...extra })
const processing = { name: NAME, metadata: meta('PROCESSING') }   // exactly what the real gcloud printed on staging
const success = { name: NAME, done: true, metadata: meta('SUCCESSFUL', { endTime: '2026-10-04T19:33:02Z' }), response: { outputUriPrefix: prefix } }
const failedOp = { name: NAME, done: true, metadata: meta('FAILED', { endTime: '2026-10-04T19:33:02Z' }), error: { code: 13, message: 'x' } }
const J = o => (typeof o === 'string' ? o : JSON.stringify(o))

// ── pure classification ──────────────────────────────────────────────────────
record('poll: describe vector is fixed - firestore operations describe <id> --project=finapp-staging --format=json (no export verb, no database flag, no parentheses)', JSON.stringify(describeArgs('ASBlZWM4YThhYTRm')) === JSON.stringify(['firestore', 'operations', 'describe', 'ASBlZWM4YThhYTRm', '--project=finapp-staging', '--format=json']) && !describeArgs('x').includes('export'))
record('poll: the operation id is taken from projects/finapp-staging/databases/(default)/operations/<id> only (another project, database, shape or characters -> null)', operationIdOf({ name: NAME }) === 'ASBlZWM4YThhYTRm' && [{ name: 'projects/finapp-prod-10a83/databases/(default)/operations/ASBlZWM4YThhYTRm' }, { name: 'projects/finapp-staging/databases/other/operations/ASBlZWM4YThhYTRm' }, { name: 'projects/finapp-staging/databases/(default)/operations/a;b' }, { name: 'projects/finapp-staging/databases/(default)/operations/ab' }, { name: 'projects/finapp-staging/databases/(default)/operations/ASBl/../x' }, { name: 42 }, {}, null].every(o => operationIdOf(o) === null))
record('poll: parseOperation accepts one object (or an array of one) and refuses text, two operations, null and arrays inside', parseOperation(J(success)).op?.done === true && parseOperation(`[${J(success)}]`).op?.done === true && ['Waiting for [op]...done.', `[${J(success)},${J(success)}]`, 'null', '[null]', '[[]]', ''].every(t => parseOperation(t).problems?.length === 1))
record('poll: the observed staging answer (PROCESSING, no `done`) is RUNNING - not a failure and not a success', classifyOperation(processing, prefix).state === 'RUNNING' && classifyOperation({ ...processing, done: false, metadata: meta('INITIALIZING') }, prefix).state === 'RUNNING' && exportOperationProblems(J(processing), prefix).join() === 'operation not done')
record('poll: SUCCESS needs done=true, SUCCESSFUL, no error and exactly the requested prefix (trailing slash allowed, nothing else)', classifyOperation(success, prefix).state === 'SUCCESS' && classifyOperation({ ...success, response: { outputUriPrefix: `${prefix}/` }, metadata: meta('SUCCESSFUL', { outputUriPrefix: `${prefix}/` }) }, prefix).state === 'SUCCESS' && classifyOperation({ ...success, metadata: meta('SUCCESSFUL', { outputUriPrefix: `${prefix}/sub` }), response: undefined }, prefix).state === 'UNKNOWN' && classifyOperation({ ...success, response: { outputUriPrefix: 'gs://other/x' } }, prefix).state === 'UNKNOWN' && classifyOperation({ name: NAME, done: true, metadata: { operationState: 'SUCCESSFUL' } }, prefix).state === 'UNKNOWN')
record('poll: an error, FAILED, CANCELLED or CANCELLING is FAILED; done without SUCCESSFUL, an unknown state or a foreign prefix is UNKNOWN (never polled on)', classifyOperation(failedOp, prefix).state === 'FAILED' && classifyOperation({ ...processing, error: { code: 1 } }, prefix).state === 'FAILED' && ['CANCELLED', 'CANCELLING', 'FAILED'].every(s => classifyOperation({ name: NAME, metadata: meta(s) }, prefix).state === 'FAILED') && classifyOperation({ name: NAME, done: true, metadata: meta('PROCESSING') }, prefix).state === 'UNKNOWN' && classifyOperation({ name: NAME, metadata: meta('SOMETHING_NEW') }, prefix).state === 'UNKNOWN' && classifyOperation({ name: NAME, metadata: meta('PROCESSING', { outputUriPrefix: 'gs://other/x' }) }, prefix).state === 'UNKNOWN')

// ── the polling loop with a fake describe and clock ──────────────────────────
function harness(answers, { intervalMs = 10000, deadlineMs = 30 * 60 * 1000, describeDelayMs = 0 } = {}) {
  let t = 0, i = 0
  const calls = [], sleeps = [], timeouts = []
  const describe = async (id, timeoutMs) => { calls.push(id); timeouts.push(timeoutMs); t += describeDelayMs; const a = answers[Math.min(i++, answers.length - 1)]; return typeof a === 'function' ? a() : a }
  const sleep = async ms => { sleeps.push(ms); t += ms }
  return { calls, sleeps, timeouts, run: (firstOp = processing, startedAt) => awaitOperation({ firstOp, prefix, describe, sleep, now: () => t, intervalMs, deadlineMs, ...(startedAt === undefined ? {} : { startedAt }) }) }
}
const ok = o => ({ code: 0, stdout: J(o) })
{
  const h = harness([ok(processing), ok(success)]); const r = await h.run()
  record('poll: PROCESSING -> PROCESSING -> SUCCESSFUL gives SUCCESS after exactly 2 describes of the SAME operation id, one interval apart', r.outcome === 'SUCCESS' && r.polls === 2 && h.calls.length === 2 && h.calls.every(c => c === 'ASBlZWM4YThhYTRm') && h.sleeps.join() === '10000,10000')
  const h2 = harness([ok(success)]); const r2 = await h2.run()
  record('poll: SUCCESSFUL on the first describe -> SUCCESS with one poll', r2.outcome === 'SUCCESS' && r2.polls === 1)
  const h3 = harness([]); const r3 = await h3.run(success)
  record('poll: an operation that is already done and SUCCESSFUL in the first answer needs no describe at all', r3.outcome === 'SUCCESS' && r3.polls === 0 && h3.calls.length === 0 && h3.sleeps.length === 0)
}
{
  const h = harness([ok(processing), ok(failedOp)]); const r = await h.run()
  record('poll: PROCESSING -> done with an error/FAILED -> FAILED (provable, exit 2) after 2 describes, no more', r.outcome === 'FAILED' && r.polls === 2 && h.calls.length === 2 && r.problems.length > 0)
  const h2 = harness([ok({ name: NAME, metadata: meta('CANCELLED') })]); const r2 = await h2.run()
  record('poll: CANCELLED is FAILED', r2.outcome === 'FAILED')
}
{
  const cases = {
    'unreadable text': [{ code: 0, stdout: 'Waiting for the operation...' }],
    'two operations': [{ code: 0, stdout: `[${J(success)},${J(success)}]` }],
    'a different operation': [ok({ ...success, name: 'projects/finapp-staging/databases/(default)/operations/OTHERID123' })],
    'SUCCESSFUL but another prefix': [ok({ ...success, metadata: meta('SUCCESSFUL', { outputUriPrefix: 'gs://elsewhere/x' }), response: undefined })],
    'an unknown state': [ok({ name: NAME, metadata: meta('SOMETHING_NEW') })],
    'done without SUCCESSFUL': [ok({ name: NAME, done: true, metadata: meta('PROCESSING') })],
  }
  const out = Object.entries(cases).map(([n, a]) => { const h = harness(a); return h.run().then(r => [n, r.outcome === 'UNCERTAIN' && r.polls === 1 && h.calls.length === 1]) })
  const done = await Promise.all(out)
  record('poll: an unreadable or unknown answer (text, two operations, another operation, foreign prefix, unknown state, done without SUCCESSFUL) is UNCERTAIN at once - no further polling', done.every(d => d[1]), done.filter(d => !d[1]).map(d => d[0]))
}
{
  const h = harness([ok(processing)], { intervalMs: 10000, deadlineMs: 60000 }); const r = await h.run()
  record('poll: an operation that never finishes -> UNCERTAIN (timeout, exit 3) - bounded by the deadline, one describe per interval, never more', r.outcome === 'UNCERTAIN' && /timeout/.test(r.problems.join()) && h.calls.length <= 6 && h.calls.length >= 5 && h.sleeps.reduce((a, b) => a + b, 0) <= 60000)
  const h2 = harness([ok(processing)], { intervalMs: 10000, deadlineMs: 5000 }); const r2 = await h2.run()
  record('poll: a deadline shorter than one interval times out without any describe', r2.outcome === 'UNCERTAIN' && h2.calls.length === 0)
  const h3 = harness([{ code: 1, stdout: '' }]); const r3 = await h3.run()
  record('poll: three describe failures in a row (exit 1) -> UNCERTAIN, no fourth call', r3.outcome === 'UNCERTAIN' && h3.calls.length === 3 && /failed 3 times/.test(r3.problems.join()))
  const h4 = harness([{ code: null, timedOut: true, stdout: '' }, { code: null, spawnError: 'ENOENT', stdout: '' }, { code: 7, stdout: '' }]); const r4 = await h4.run()
  record('poll: a timed-out, an unspawnable and a failing describe all count as failures', r4.outcome === 'UNCERTAIN' && h4.calls.length === 3)
  const h5 = harness([{ code: 1, stdout: '' }, { code: 1, stdout: '' }, ok(processing), { code: 1, stdout: '' }, { code: 1, stdout: '' }, ok(success)]); const r5 = await h5.run()
  record('poll: failures are counted in a row - two failures, a good answer, two more failures, then SUCCESSFUL still succeeds', r5.outcome === 'SUCCESS' && h5.calls.length === 6)
  const r6 = await harness([]).run({ metadata: meta('PROCESSING') })
  record('poll: an export response without an operation name is UNCERTAIN before any describe', r6.outcome === 'UNCERTAIN' && /no operation name/.test(r6.problems.join()))
}
// v6 (audit of v5): the deadline is checked AFTER every external call, before any answer is accepted; it counts from the start of the request
{
  const h = harness([ok(success)], { describeDelayMs: 1810001 }); const r = await h.run()
  record('deadline: a describe that returns SUCCESSFUL only AFTER the 30 minutes (1 810 001 ms, the auditor case) is UNCERTAIN, not SUCCESS - the answer is not even looked at', r.outcome === 'UNCERTAIN' && /not confirmed within 30 minutes/.test(r.problems.join()) && h.calls.length === 1)
  const h2 = harness([ok(failedOp)], { describeDelayMs: 1810001 }); const r2 = await h2.run()
  const h3 = harness([{ code: 1, stdout: '' }], { describeDelayMs: 1810001 }); const r3 = await h3.run()
  record('deadline: a late describe is UNCERTAIN whatever it says (a late FAILED, a late failure) - one describe, never a second', r2.outcome === 'UNCERTAIN' && r3.outcome === 'UNCERTAIN' && h2.calls.length === 1 && h3.calls.length === 1)
  const h4 = harness([ok(processing), ok(processing), ok(success)], { intervalMs: 10000, deadlineMs: 60000, describeDelayMs: 25000 }); const r4 = await h4.run()
  record('deadline: slow describes (25 s each) cannot stretch the poll beyond the deadline: the loop ends UNCERTAIN, not after more calls than the budget allows', r4.outcome === 'UNCERTAIN' && h4.calls.length <= 2)
  const h5 = harness([ok(processing), ok(processing), ok(success)], { intervalMs: 10000, deadlineMs: 5 * 60 * 1000, describeDelayMs: 1000 }); await h5.run()
  record('deadline: every describe gets the remaining time as its limit (at most ' + DESCRIBE_TIMEOUT_MS / 1000 + ' s) - never the 20 minute default of the export call', h5.timeouts.every(t => t > 0 && t <= DESCRIBE_TIMEOUT_MS) && h5.timeouts.length >= 2)
  const h6 = harness([ok(success)], { intervalMs: 10000, deadlineMs: 70000, describeDelayMs: 0 }); const r6 = await h6.run(processing)
  const h7 = harness([ok(processing), ok(success)], { intervalMs: 10000, deadlineMs: 15000 }); await h7.run()
  record('deadline: near the end the limit of a describe is the REMAINING time (15 s budget: first describe gets <= 5 s)', h7.timeouts.length >= 1 && h7.timeouts[0] <= 5000 && r6.outcome === 'SUCCESS')
  const late = harness([]); const lateDone = await late.run(success, -1800001)
  const lateRun = harness([ok(success)]); const lateRunning = await lateRun.run(processing, -1800001)
  record('deadline: the clock starts at the EXPORT REQUEST - a first answer that arrives after the 30 minutes is UNCERTAIN even when it is already SUCCESSFUL, and nothing is described', lateDone.outcome === 'UNCERTAIN' && lateRunning.outcome === 'UNCERTAIN' && late.calls.length === 0 && lateRun.calls.length === 0)
  const edge = harness([ok(success)], { describeDelayMs: 1000, deadlineMs: 60000 }); const redge = await edge.run(processing, 0)
  record('deadline: an answer received just inside the deadline is still accepted (no false timeout)', redge.outcome === 'SUCCESS')
}
// v6: the freshness of the backup is anchored to the operation
{
  const req = Date.parse('2026-10-05T10:00:00Z')
  const ok1 = operationTimeProblems({ startTime: '2026-10-05T10:00:20Z' }, req, req + 60000)
  const okSkew = operationTimeProblems({ startTime: '2026-10-05T09:57:00Z' }, req, req + 60000)
  record('operation time: a startTime shortly after the request (or up to 5 minutes of clock skew before it) is believable', ok1.length === 0 && okSkew.length === 0 && CLOCK_SKEW_MS === 300000)
  const bad = [{ startTime: '2026-10-05T09:14:00Z' }, { startTime: '2026-10-05T09:54:59Z' }, { startTime: '2026-10-05T10:20:00Z' }, { startTime: 'yesterday' }, { startTime: undefined }, {}, null, { startTime: 12345 }].map(m => operationTimeProblems(m, req, req + 60000).length === 1)
  record('operation time: an OLD operation (45 minutes before the request), one just beyond the skew, a future time, an unreadable or missing startTime are refused - the backup age cannot be proven', bad.every(Boolean), bad)
  record('operation time: the freshness anchor is the EARLIER of the request start and the operation start (conservative under clock skew)', freshnessAnchor(req, req + 20000) === '2026-10-05T10:00:00.000Z' && freshnessAnchor(req, req - 120000) === '2026-10-05T09:58:00.000Z')
}
record('poll: poll timing is fixed for staging (10 s / 30 min) and only the rehearsal profile may shorten it through M1_STUB_* variables', POLL_INTERVAL_MS === 10000 && POLL_DEADLINE_MS === 1800000 && pollSettings('staging', { M1_STUB_EXPORT_POLL_MS: '5', M1_STUB_EXPORT_DEADLINE_MS: '9' }).intervalMs === 10000 && pollSettings('staging', {}).deadlineMs === 1800000 && pollSettings('rehearsal', { M1_STUB_EXPORT_POLL_MS: '5', M1_STUB_EXPORT_DEADLINE_MS: '90' }).intervalMs === 5 && pollSettings('rehearsal', { M1_STUB_EXPORT_POLL_MS: '-1', M1_STUB_EXPORT_DEADLINE_MS: 'x' }).deadlineMs === 1800000)

// ── Windows helper arguments ─────────────────────────────────────────────────
{
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-fakegcloud-'))
  fs.writeFileSync(path.join(fake, 'gcloud.cmd'), '@echo off\r\n')
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^M1_STUB_/i.test(k) && !/EMULATOR|^CLOUDSDK_CORE_PROJECT$|^CLOUDSDK_AUTH/i.test(k) && !['GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED'].includes(k.toUpperCase())))
  const env = { ...base, PATH: `${fake}${path.delimiter}${base.PATH ?? base.Path ?? ''}`, Path: undefined, ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  delete env.Path
  const c = gcloudCommand('staging', describeArgs('ASBlZWM4YThhYTRm'), env)
  const expectedLine = `"${path.join(fake, 'gcloud.cmd')}" firestore operations describe ASBlZWM4YThhYTRm --project=finapp-staging --format=json`
  record('windows helper: the describe call is one verbatim cmd.exe /d /s /c line made of the located gcloud.cmd and the fixed vector, shell:false semantics', c.file === 'C:\\Windows\\System32\\cmd.exe' && c.verbatim === true && JSON.stringify(c.args) === JSON.stringify(['/d', '/s', '/c', `"${expectedLine}"`]), c.args)
  const bad = ['a b', 'a;b', 'a&b', 'a|b', 'a"b', "a'b", 'a(b)', '(default)', 'a%b', 'a^b', '$(x)', '`x`', 'a\nb', 'a>b'].map(id => throws(() => gcloudCommand('staging', describeArgs(id), env)))
  record('windows helper: an operation id (or any argument) with a space, quote, ; & | ( ) % ^ $ ` newline or redirection is refused before any process starts', bad.every(Boolean), bad)
  record('windows helper: the staging profile still refuses stub/emulator/credential/project-override environments for the describe call', [{ M1_STUB_SCENARIO: 'x' }, { M1_STUB_EXPORT_POLL_MS: '5' }, { FIRESTORE_EMULATOR_HOST: 'x' }, { GOOGLE_APPLICATION_CREDENTIALS: 'x' }, { CLOUDSDK_CORE_PROJECT: 'finapp-prod-10a83' }].every(o => throws(() => gcloudCommand('staging', describeArgs('ASBlZWM4YThhYTRm'), { ...env, ...o }))))
  const rv = gcloudCommand('rehearsal', describeArgs('stub-export-op'), { M1_STUB_SCENARIO: 's', M1_STUB_STATE: 'd' })
  record('windows helper: the rehearsal profile runs the stub under the no-network preload with the same describe vector', rv.args[0] === '--require' && rv.args[2].endsWith('stub-gcloud.mjs') && rv.args.slice(3).join(' ') === 'firestore operations describe stub-export-op --project=finapp-staging --format=json' && rv.verbatim === false)
  const real = findGcloudCmd()
  if (real) {
    const cmd = gcloudCommand('staging', [...describeArgs('ASBlZWM4YThhYTRm'), '--help'], base)
    const r = spawnSync(cmd.file, cmd.args, { shell: false, windowsHide: true, windowsVerbatimArguments: cmd.verbatim, encoding: 'utf8', env: base, timeout: 120000 })
    record('windows helper: the REAL gcloud.cmd accepts exactly this vector through the verbatim cmd.exe line (help only - no network, no cloud call)', r.status === 0 && /operations describe/i.test(r.stdout + r.stderr), { status: r.status })
  } else record('windows helper: gcloud.cmd is not installed on this machine (real spawn not exercised)', false)
  fs.rmSync(fake, { recursive: true, force: true })
}

// ── the packaged CLI against the stub gcloud (rehearsal profile) ─────────────
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-exportpoll-'))
  const uri = 'gs://my-backups/finapp/staging'
  const cli = (kind, extraEnv = {}) => {
    const dir = path.join(base, kind), state = path.join(dir, 'state'), out = path.join(dir, 'out'), scen = path.join(dir, 'scenario.json')
    fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(scen, JSON.stringify({ export: kind }))
    const r = spawnSync(process.execPath, [path.join(PKG, 'm1-export.mjs'), '--profile', 'rehearsal', '--project', 'finapp-staging', '--uri', uri, '--expected-head', H, '--out-dir', out], { encoding: 'utf8', timeout: 120000, env: { ...process.env, M1_STUB_SCENARIO: scen, M1_STUB_STATE: state, M1_STUB_EXPORT_POLL_MS: '30', M1_STUB_EXPORT_DEADLINE_MS: '15000', ...extraEnv } })
    const inv = fs.existsSync(path.join(state, 'invocations.jsonl')) ? fs.readFileSync(path.join(state, 'invocations.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
    const count = k => inv.filter(e => e.key === k).length
    const result = fs.existsSync(path.join(out, 'export-result.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'export-result.json'), 'utf8')) : null
    return { status: r.status, out: r.stdout, result, exports: count('gcloud-export'), describes: count('gcloud-describe'), lists: count('gcloud-list'), polls: fs.existsSync(out) ? fs.readdirSync(out).filter(f => f.startsWith('operation-poll-')).length : 0 }
  }
  const a = cli('poll-success')
  record('poll CLI: the first answer PROCESSING, then SUCCESSFUL -> EXPORT_VERIFIED (exit 0) from ONE export, 2 describes, the listing, and the operation name in the result', a.status === 0 && a.result?.status === 'EXPORT_VERIFIED' && a.exports === 1 && a.describes === 2 && a.lists === 1 && a.polls === 2 && a.result.operationName.endsWith('/operations/stub-export-op') && a.result.polls === 2 && a.result.operationState === 'SUCCESSFUL', a)
  record('poll CLI: the verified result records requestStartedAt, operationStartTime and freshnessAnchor = the earlier of the two (the age of the backup is counted from the operation, not from finishedAt)', (() => { const r = a.result; const q = Date.parse(r.requestStartedAt), o = Date.parse(r.operationStartTime); return Number.isFinite(q) && Number.isFinite(o) && r.freshnessAnchor === new Date(Math.min(q, o)).toISOString() && Date.parse(r.freshnessAnchor) <= Date.parse(r.finishedAt) })(), a.result)
  const b = cli('poll-success-immediate'), c2 = cli('poll-flaky-then-success'), s0 = cli('success')
  record('poll CLI: success on the first describe, success after one describe failure, and the old already-done answer (no describe) all verify with ONE export', b.status === 0 && b.describes === 1 && c2.status === 0 && c2.describes === 3 && c2.result?.status === 'EXPORT_VERIFIED' && s0.status === 0 && s0.describes === 0 && [b, c2, s0].every(x => x.exports === 1 && x.lists === 1))
  const f = cli('poll-failed')
  record('poll CLI: PROCESSING then an operation error -> STOP (exit 2), no EXPORT_VERIFIED, no listing, ONE export', f.status === 2 && f.result?.status === 'STOP' && f.lists === 0 && f.exports === 1 && f.describes === 2)
  const t = cli('poll-forever', { M1_STUB_EXPORT_DEADLINE_MS: '2500' })
  record('poll CLI: an operation that never finishes -> UNCERTAIN (exit 3) at the deadline, ONE export, no listing, never EXPORT_VERIFIED', t.status === 3 && t.result?.status === 'UNCERTAIN' && /timeout/.test(t.result.problems.join()) && t.exports === 1 && t.lists === 0 && t.describes >= 2 && t.describes <= 21, t)
  const bad = ['poll-describe-exit1', 'poll-bad-json', 'poll-wrong-name', 'poll-wrong-prefix', 'poll-unknown-state'].map(k => [k, cli(k)])
  record('poll CLI: describe exit 1 (x3), unreadable text, another operation, a foreign prefix and an unknown state all end UNCERTAIN (exit 3) - ONE export, no listing, never EXPORT_VERIFIED', bad.every(([, x]) => x.status === 3 && x.result?.status === 'UNCERTAIN' && x.exports === 1 && x.lists === 0), bad.map(([k, x]) => [k, x.status, x.result?.status]))
  const oldOp = cli('poll-old-operation')
  record('poll CLI: an operation whose startTime is 45 minutes older than the request -> UNCERTAIN (exit 3) even though it is SUCCESSFUL: no listing, never EXPORT_VERIFIED (the backup would look fresh by finishedAt)', oldOp.status === 3 && oldOp.result?.status === 'UNCERTAIN' && /started before this export request/.test(oldOp.result.problems.join()) && oldOp.lists === 0 && oldOp.exports === 1, oldOp)
  const slowExport = cli('poll-slow-export', { M1_STUB_EXPORT_DEADLINE_MS: '1200', M1_STUB_EXPORT_DELAY_MS: '2500' })
  record('poll CLI: the export command answers only after the deadline (counted from the request) -> UNCERTAIN (exit 3): no describe, no listing, never EXPORT_VERIFIED', slowExport.status === 3 && slowExport.result?.status === 'UNCERTAIN' && /not confirmed within/.test(slowExport.result.problems.join()) && slowExport.describes === 0 && slowExport.lists === 0 && slowExport.exports === 1, slowExport)
  const slowDescribe = cli('poll-slow-describe', { M1_STUB_EXPORT_DEADLINE_MS: '2500', M1_STUB_EXPORT_DELAY_MS: '5000' })
  record('poll CLI: a describe that hangs past the deadline is cut at the remaining time and the run ends UNCERTAIN (exit 3) - no listing, never EXPORT_VERIFIED, ONE export', slowDescribe.status === 3 && slowDescribe.result?.status === 'UNCERTAIN' && slowDescribe.lists === 0 && slowDescribe.exports === 1, slowDescribe)
  const n = cli('poll-success-no-metadata')
  record('poll CLI: SUCCESSFUL but the independent listing shows no overall_export_metadata -> STOP (exit 2), never EXPORT_VERIFIED', n.status === 2 && n.result?.status === 'STOP' && n.lists === 1 && /overall_export_metadata/.test(n.result.problems.join()))
  const old = ['exit-1', 'bad-json', 'op-failed', 'not-done', 'wrong-prefix', 'no-metadata', 'list-fail'].map(k => [k, cli(k)])
  record('poll CLI: the earlier failure scenarios keep failing closed (gcloud exit 1, unreadable first output, FAILED, a done=false answer that never completes, foreign prefix, no metadata, listing failure) - never EXPORT_VERIFIED', old.every(([, x]) => x.status !== 0 && x.result?.status !== 'EXPORT_VERIFIED' && x.exports === 1), old.map(([k, x]) => [k, x.status, x.result?.status]))
  fs.rmSync(base, { recursive: true, force: true })
}

{
  const orch = fs.readFileSync(path.join(PKG, 'm1-orchestrator.ps1'), 'utf8')
  record('orchestrator source (audit v5): the age of the export is counted from freshnessAnchor (operation/request start), never from finishedAt (the evidence write)', /Parse\(\$State\.export\.freshnessAnchor/.test(orch) && !/Parse\(\$State\.export\.finishedAt/.test(orch) && /export freshnessAnchor missing or unreadable/.test(orch))
}

// ── source hygiene ───────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(PKG, 'm1-export.mjs'), 'utf8')
  record('export source: ONE export vector (never re-sent), the poll uses only describe, no delete/import/restore verbs, no shell:true', (src.match(/'firestore', 'export'/g) ?? []).length === 1 && (src.match(/'firestore', 'operations', 'describe'/g) ?? []).length === 1 && !/shell: true/.test(src) && !/'delete'|'import'|'restore'|'rm'|'cancel'/.test(src) && (src.match(/await run\(exportCmd\)/g) ?? []).length === 1)
}

const failed = results.filter(r => !r.pass).length
fs.mkdirSync(path.join(PKG, 'results'), { recursive: true })
fs.writeFileSync(path.join(PKG, 'results', 'export-poll-tests.json'), `${JSON.stringify({ total: results.length, failed, results, at: new Date().toISOString() }, null, 2)}\n`)
console.log(`EXPORT_POLL_TESTS ${failed ? 'FAIL' : 'PASS'} ${results.length - failed}/${results.length}`)
process.exitCode = failed ? 1 : 0
