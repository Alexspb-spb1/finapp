#!/usr/bin/env node
// FINAPP-1.0-M1 R3 - the fresh managed Firestore export that must exist immediately before the Rules deploy
// (owner decision). Staging only: the project is fixed. Exactly ONE `gcloud firestore export` is ever sent
// per run; the export is never retried, never deleted and never read back as data.
//
//   node m1-export.mjs --profile <staging|rehearsal> --project finapp-staging --uri gs://<bucket>/<path>
//        --expected-head <sha> --out-dir <new abs dir>
//
// The run writes the export under a unique prefix <uri>/m1-r3-<head8>-<UTC stamp>, so it can never
// overwrite an earlier export. PASS (exit 0) needs BOTH:
//   1. the export operation finished with operationState SUCCESSFUL (done, no error), and
//   2. an independent listing of the prefix shows an *.overall_export_metadata object.
// The operation state is NOT taken from the stdout of the export command (gcloud may print the first, still PROCESSING answer): the SAME operation
// is polled read-only with `gcloud firestore operations describe <id>` until it is done (10 s interval, 30 min limit). EXPORT_VERIFIED needs the
// final SUCCESSFUL state, exactly the requested prefix and the listing. A proven failure is exit 2; an unreadable or unknown answer, a different
// operation, repeated describe failures or the timeout are exit 3 (the export request was sent but its outcome is unknown: reconcile read-only,
// never resend). Anything else is exit 2 (stopped; nothing exported).
// Evidence in out-dir: plan.json (written BEFORE the request), export-result.json, gcloud logs.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXPECTED_HEAD, gitState } from './m1-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT = 'finapp-staging'
export const URI_PATTERN = /^gs:\/\/[a-z0-9][a-z0-9._-]{2,220}(?:\/[A-Za-z0-9._-]{1,100}){1,6}$/
const TIMEOUT_MS = 20 * 60 * 1000

export const stampUtc = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
export function exportPrefix(uri, head, now = new Date()) {
  if (!URI_PATTERN.test(uri) || uri.endsWith('/') || uri.includes('..')) throw new Error('export uri must be gs://<bucket>/<path> with a safe path')
  return `${uri}/m1-r3-${head.slice(0, 8)}-${stampUtc(now)}`
}

/** The two gcloud argument vectors (after `gcloud`). Fixed shape; no database flag (the default database). */
export const exportArgs = (prefix, project = PROJECT) => ['firestore', 'export', prefix, `--project=${project}`, '--format=json']
export const listArgs = (prefix, project = PROJECT) => ['storage', 'ls', `${prefix}/`, `--project=${project}`]

/** Fixed describe vector: the read-only status of the ONE operation the export request returned (the id is checked against the operation name). */
export const describeArgs = (id, project = PROJECT) => ['firestore', 'operations', 'describe', id, `--project=${project}`, '--format=json']
export const POLL_INTERVAL_MS = 10 * 1000
export const POLL_DEADLINE_MS = 30 * 60 * 1000
export const DESCRIBE_TIMEOUT_MS = 60 * 1000
export const CLOCK_SKEW_MS = 5 * 60 * 1000
export const operationNamePattern = (project = PROJECT) => new RegExp(`^projects/${project}/databases/\\(default\\)/operations/([A-Za-z0-9_-]{4,200})$`)
const IS_STRING = v => typeof v === 'string'

/** Pure: exactly one operation object (an array of one is accepted too). Returns { op } or { problems }. */
export function parseOperation(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return { problems: ['export output is not JSON'] } }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  if (items.length !== 1 || items[0] === null || typeof items[0] !== 'object' || Array.isArray(items[0])) return { problems: ['export output is not exactly one operation object'] }
  return { op: items[0] }
}
/** The operation id (last segment) when the name is exactly projects/<project>/databases/(default)/operations/<id>; otherwise null. */
export function operationIdOf(op, project = PROJECT) {
  const m = typeof op?.name === 'string' ? op.name.match(operationNamePattern(project)) : null
  return m ? m[1] : null
}
const prefixOk = (value, prefix) => IS_STRING(value) && (value === prefix || value === `${prefix}/`)
/**
 * Pure: what does ONE observation of the operation prove? state SUCCESS (done, SUCCESSFUL, no error, exactly the requested prefix),
 * RUNNING (INITIALIZING/PROCESSING and not done - the only state that is polled), FAILED (an error, or FAILED/CANCELLED/CANCELLING),
 * UNKNOWN (anything else, e.g. done without SUCCESSFUL, a foreign prefix, an unknown state): the outcome is not provable.
 */
export function classifyOperation(op, prefix) {
  if (op.error) return { state: 'FAILED', problems: ['operation reports an error'] }
  const state = op.metadata?.operationState
  if (['FAILED', 'CANCELLED', 'CANCELLING'].includes(state)) return { state: 'FAILED', problems: [`operationState ${state}`] }
  const outs = [op.metadata?.outputUriPrefix, op.response?.outputUriPrefix].filter(v => v !== undefined)
  if (outs.some(o => !prefixOk(o, prefix))) return { state: 'UNKNOWN', problems: ['outputUriPrefix is not the requested prefix'] }
  if (op.done === true) {
    if (state !== 'SUCCESSFUL') return { state: 'UNKNOWN', problems: [`operation done but operationState ${String(state)}`] }
    if (!outs.length) return { state: 'UNKNOWN', problems: ['outputUriPrefix is not the requested prefix'] }
    return { state: 'SUCCESS', problems: [] }
  }
  if (state === 'INITIALIZING' || state === 'PROCESSING') return { state: 'RUNNING', problems: [] }
  return { state: 'UNKNOWN', problems: [`operationState ${String(state)} and not done`] }
}
/** Pure: does the text of an operation prove a finished, successful export of exactly this prefix? Returns problems. */
export function exportOperationProblems(text, prefix) {
  const parsed = parseOperation(text)
  if (parsed.problems) return parsed.problems
  const v = classifyOperation(parsed.op, prefix)
  return v.state === 'SUCCESS' ? [] : v.state === 'RUNNING' ? ['operation not done'] : v.problems
}
/**
 * After the ONE export request: poll the SAME operation read-only until it is done, a failure is proven, or the deadline passes.
 * The deadline counts from the START of the export request (startedAt), so a slow first answer is part of the budget; every describe is limited to
 * the remaining time (and to DESCRIBE_TIMEOUT_MS) and the deadline is checked AFTER every external call, BEFORE any answer - even a SUCCESSFUL one - is
 * accepted: a slow describe must never turn an expired poll into a success. Never sends another export.
 * describe(id, timeoutMs) -> { code, stdout, timedOut?, spawnError? }; sleep(ms); now() -> ms.
 * Outcomes: SUCCESS | FAILED (provable failure, exit 2) | UNCERTAIN (not provable: unreadable/unknown answer, a different operation, three describe
 * failures in a row, the deadline - exit 3, reconcile read-only, never resend). onPoll(n, raw) lets the caller keep the evidence.
 */
export async function awaitOperation({ firstOp, prefix, project = PROJECT, describe, sleep, now, startedAt = now(), intervalMs = POLL_INTERVAL_MS, deadlineMs = POLL_DEADLINE_MS, onPoll = () => {} }) {
  const id = operationIdOf(firstOp, project)
  if (!id) return { outcome: 'UNCERTAIN', problems: ['export response carries no operation name of this project and the default database'], polls: 0 }
  const deadline = startedAt + deadlineMs
  const expired = polls => ({ outcome: 'UNCERTAIN', problems: [`export operation ${id} is not confirmed within ${Math.round(deadlineMs / 60000)} minutes of the export request (timeout after ${polls} polls): its outcome is unknown, reconcile read-only, never resend`], polls, name: firstOp.name })
  let op = firstOp, polls = 0, failures = 0
  for (;;) {
    if (now() > deadline) return expired(polls)
    const v = classifyOperation(op, prefix)
    if (v.state === 'SUCCESS') return { outcome: 'SUCCESS', problems: [], polls, operation: op, name: firstOp.name }
    if (v.state === 'FAILED') return { outcome: 'FAILED', problems: v.problems, polls, operation: op, name: firstOp.name }
    if (v.state === 'UNKNOWN') return { outcome: 'UNCERTAIN', problems: v.problems, polls, operation: op, name: firstOp.name }
    if (now() + intervalMs > deadline) return expired(polls)
    await sleep(intervalMs)
    const remaining = deadline - now()
    if (remaining <= 0) return expired(polls)
    const d = await describe(id, Math.min(remaining, DESCRIBE_TIMEOUT_MS))
    polls++
    onPoll(polls, d)
    if (now() > deadline) return expired(polls)
    if (d.timedOut || d.spawnError || d.code !== 0) {
      failures++
      if (failures >= 3) return { outcome: 'UNCERTAIN', problems: [`describe of operation ${id} failed ${failures} times in a row`], polls, name: firstOp.name }
      continue
    }
    failures = 0
    const parsed = parseOperation(d.stdout)
    if (parsed.problems) return { outcome: 'UNCERTAIN', problems: parsed.problems.map(p => `describe: ${p}`), polls, name: firstOp.name }
    if (parsed.op.name !== firstOp.name) return { outcome: 'UNCERTAIN', problems: ['describe returned a different operation than the export request'], polls, name: firstOp.name }
    op = parsed.op
  }
}
/**
 * Pure: is the operation's own start time believable for THIS request? It must parse, must not precede the request by more than the clock-skew
 * allowance (an operation that started long before is not this export - the backup would be older than it looks) and must not lie in the future.
 */
export function operationTimeProblems(meta, requestStartedAt, nowMs, skewMs = CLOCK_SKEW_MS) {
  const t = typeof meta?.startTime === 'string' ? Date.parse(meta.startTime) : NaN
  if (!Number.isFinite(t)) return ['the operation carries no readable startTime: the age of the backup cannot be proven']
  if (t < requestStartedAt - skewMs) return ['the operation started before this export request (an old operation, not this export): the backup is not fresh']
  if (t > nowMs + skewMs) return ['the operation startTime lies in the future: the clocks disagree, the age of the backup cannot be proven']
  return []
}
/** The moment from which the backup's age is counted: the EARLIER of the local request start and the operation's own start (conservative under clock skew). */
export const freshnessAnchor = (requestStartedAt, operationStartMs) => new Date(Math.min(requestStartedAt, operationStartMs)).toISOString()
/** Poll timing. Only the rehearsal profile (stub gcloud) may shorten it, through M1_STUB_* variables that the staging profile refuses. */
export function pollSettings(profile, env = process.env) {
  const pos = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
  if (profile !== 'rehearsal') return { intervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_DEADLINE_MS }
  return { intervalMs: pos(env.M1_STUB_EXPORT_POLL_MS) ?? POLL_INTERVAL_MS, deadlineMs: pos(env.M1_STUB_EXPORT_DEADLINE_MS) ?? POLL_DEADLINE_MS }
}
/** Pure: does a plain `gcloud storage ls <prefix>/` listing show the export metadata object? */
export function listingProblems(text, prefix) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!lines.some(l => l.startsWith(`${prefix}/`) && l.endsWith('.overall_export_metadata'))) return ['no overall_export_metadata object under the export prefix']
  return []
}

export function findGcloudCmd(env = process.env) {
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'gcloud.cmd')
    if (dir && fs.existsSync(candidate)) return candidate
  }
  return null
}

/** Resolves the executable and argv for one gcloud call. Never an interactive shell: cmd.exe /d /s /c with a
 *  verbatim command line made only of the located gcloud.cmd and arguments that passed the fixed patterns. */
export function gcloudCommand(profile, args, env = process.env) {
  const stubVars = Object.keys(env).filter(k => k.toUpperCase().startsWith('M1_STUB_'))
  if (args.some(a => !/^[A-Za-z0-9:/._=-]+$/.test(a))) throw new Error('gcloud argument outside the safe character set')
  if (profile === 'staging') {
    if (stubVars.length) throw new Error('stub environment present in staging profile')
    for (const [k, v] of Object.entries(env)) {
      const key = k.toUpperCase()
      if (v && (/EMULATOR/.test(key) || ['CLOUDSDK_CORE_PROJECT', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED'].includes(key))) throw new Error(`forbidden environment ${key}`)
    }
    const gcloud = findGcloudCmd(env)
    if (!gcloud) throw new Error('gcloud.cmd not found on PATH')
    const comspec = env.ComSpec ?? env.COMSPEC
    if (!comspec) throw new Error('ComSpec missing')
    const commandLine = `"${gcloud}" ${args.join(' ')}`
    return { file: comspec, args: ['/d', '/s', '/c', `"${commandLine}"`], verbatim: true }
  }
  if (profile === 'rehearsal') {
    if (!env.M1_STUB_SCENARIO || !env.M1_STUB_STATE) throw new Error('rehearsal profile requires M1_STUB_SCENARIO and M1_STUB_STATE')
    return { file: process.execPath, args: ['--require', path.join(HERE, 'stubs', 'no-network.cjs'), path.join(HERE, 'stubs', 'stub-gcloud.mjs'), ...args], verbatim: false }
  }
  throw new Error('unknown profile')
}

function run({ file, args, verbatim }, timeoutMs = TIMEOUT_MS) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false
    const child = spawn(file, args, { shell: false, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } finish({ code: null, timedOut: true }) }, timeoutMs)
    const finish = r => { if (settled) return; settled = true; clearTimeout(timer); resolve({ stdout, stderr, ...r }) }
    child.stdout.on('data', d => { stdout += d.toString('utf8') })
    child.stderr.on('data', d => { stderr += d.toString('utf8') })
    child.on('error', e => finish({ code: null, spawnError: e.code ?? 'error' }))
    child.on('close', code => finish({ code }))
  })
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
if (isMain) {
  const argv = process.argv.slice(2)
  const o = {}
  let sent = false
  let outDir = null
  const finish = (status, extra, code) => {
    if (outDir && fs.existsSync(outDir)) {
      try { fs.writeFileSync(path.join(outDir, 'export-result.json'), `${JSON.stringify({ status, ...extra, finishedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' }) } catch { /* the exit code still reports the result */ }
    }
    console.log(`M1_EXPORT_${status}${extra.problems?.length ? ` ${extra.problems.join('; ')}` : ''}`)
    process.exitCode = code
  }
  try {
    const allowed = ['--profile', '--project', '--uri', '--expected-head', '--out-dir']
    if (argv.length !== allowed.length * 2) throw new Error('usage')
    for (let i = 0; i < argv.length; i += 2) {
      if (!allowed.includes(argv[i]) || Object.hasOwn(o, argv[i]) || !argv[i + 1]) throw new Error('usage')
      o[argv[i]] = argv[i + 1]
    }
    if (o['--project'] !== PROJECT) throw new Error('project must be finapp-staging')
    if (o['--expected-head'] !== EXPECTED_HEAD) throw new Error('expected head mismatch')
    const git = gitState()
    if (git.head !== EXPECTED_HEAD || git.status !== '') throw new Error('repository not clean at expected head')
    const dir = o['--out-dir']
    if (!path.isAbsolute(dir) || fs.existsSync(dir) || !fs.existsSync(path.dirname(dir))) throw new Error('out-dir must be a new absolute path with existing parent')
    const prefix = exportPrefix(o['--uri'], EXPECTED_HEAD)
    const exportCmd = gcloudCommand(o['--profile'], exportArgs(prefix))
    const listCmd = gcloudCommand(o['--profile'], listArgs(prefix))
    const poll = pollSettings(o['--profile'])
    fs.mkdirSync(dir)
    outDir = dir
    // The plan is on disk BEFORE the request, so a crash leaves proof of what may have been sent.
    fs.writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify({ intent: 'gcloud firestore export', project: PROJECT, prefix, profile: o['--profile'], head: EXPECTED_HEAD, at: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' })
    sent = true
    const requestStartedAt = Date.now()
    const first = await run(exportCmd)
    fs.writeFileSync(path.join(dir, 'export.stdout.log'), first.stdout, { flag: 'wx' })
    fs.writeFileSync(path.join(dir, 'export.stderr.log'), first.stderr, { flag: 'wx' })
    if (first.timedOut || first.spawnError) finish('UNCERTAIN', { prefix, problems: [first.timedOut ? 'export timed out; the request may have been accepted' : `gcloud could not run: ${first.spawnError}`] }, 3)
    else if (first.code !== 0) finish('STOP', { prefix, exitCode: first.code, problems: [`gcloud exit ${first.code}; reconcile read-only before any retry`] }, 3)
    else {
      const parsed = parseOperation(first.stdout)
      const waited = parsed.problems ? { outcome: 'UNCERTAIN', problems: parsed.problems, polls: 0 } : await awaitOperation({
        firstOp: parsed.op, prefix, startedAt: requestStartedAt, intervalMs: poll.intervalMs, deadlineMs: poll.deadlineMs, now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)),
        describe: (id, ms) => run(gcloudCommand(o['--profile'], describeArgs(id)), ms),
        onPoll: (n, d) => { try { fs.writeFileSync(path.join(dir, `operation-poll-${String(n).padStart(3, '0')}.json`), JSON.stringify({ n, code: d.code, timedOut: Boolean(d.timedOut), spawnError: d.spawnError ?? null, stdout: d.stdout, at: new Date().toISOString() }, null, 2), { flag: 'wx' }) } catch { /* evidence only */ } },
      })
      if (waited.outcome === 'FAILED') finish('STOP', { prefix, operationName: waited.name, polls: waited.polls, problems: waited.problems }, 2)
      else if (waited.outcome !== 'SUCCESS') finish('UNCERTAIN', { prefix, operationName: waited.name ?? null, polls: waited.polls, problems: waited.problems }, 3)
      else {
        const meta = waited.operation.metadata
        const timeProblems = operationTimeProblems(meta, requestStartedAt, Date.now())
        if (timeProblems.length) finish('UNCERTAIN', { prefix, operationName: waited.name, polls: waited.polls, problems: timeProblems }, 3)
        else {
          const deadline = requestStartedAt + poll.deadlineMs
          const second = await run(listCmd, Math.max(1000, Math.min(TIMEOUT_MS, deadline - Date.now())))
          fs.writeFileSync(path.join(dir, 'list.stdout.log'), second.stdout, { flag: 'wx' })
          const listProblems = second.code === 0 && !second.timedOut ? listingProblems(second.stdout, prefix) : [`listing failed (exit ${second.code})`]
          if (listProblems.length) finish('STOP', { prefix, problems: listProblems }, 2)
          else if (Date.now() > deadline) finish('UNCERTAIN', { prefix, operationName: waited.name, polls: waited.polls, problems: ['the verification finished after the deadline of the export request: not confirmed in time'] }, 3)
          else finish('EXPORT_VERIFIED', { prefix, operationName: waited.name, polls: waited.polls, operationState: meta.operationState, startTime: meta.startTime ?? null, endTime: meta.endTime ?? null, requestStartedAt: new Date(requestStartedAt).toISOString(), operationStartTime: new Date(Date.parse(meta.startTime)).toISOString(), freshnessAnchor: freshnessAnchor(requestStartedAt, Date.parse(meta.startTime)) }, 0)
        }
      }
    }
  } catch (e) {
    // Before the request nothing was sent (exit 2); after it the outcome is unknown (exit 3).
    finish(sent ? 'UNCERTAIN' : 'STOP', { problems: [e.message] }, sent ? 3 : 2)
  }
}
