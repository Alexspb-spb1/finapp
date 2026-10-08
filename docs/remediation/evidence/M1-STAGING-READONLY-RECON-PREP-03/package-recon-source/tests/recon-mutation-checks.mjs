// Mutation checks of the read-only reconciliation gates (corrections V1 of TASK 03, CR2).
// Each mutant weakens ONE gate in a SELF-CONSISTENT COPY of the package: the copy's roots point into a sibling temporary directory (no mutant can create or burn the real namespace,
// read the private journal or reach a provider - the controls use a recorder fetch and an empty owner profile) and its CODE-SHA256SUMS.txt is REGENERATED after the mutation,
// so the copy passes its own manifest integrity and can only fail on the weakened gate. A mutant counts as DETECTED only when
//   (1) the controls RAN to their final summary line (a crash, syntax error, timeout or spawn failure is a harness ERROR, never a detection), and
//   (2) at least one control that failed is one of the controls that are RELEVANT to that gate (`expect`), not just any failure.
// Before any mutant two baselines must be fully green: the plain relocated copy and a copy with a harmless edit (comment) and refreshed sums; otherwise nothing is concluded.
//   node tests/recon-mutation-checks.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { copyTree, relocateRoots, writeSums } from './relocate.mjs'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-mutants-'))
const CONCURRENCY = 4
const TIMEOUT_MS = 600000

const C = 'recon-core.mjs', P = 'recon-pins.mjs', M = 'recon-permit.mjs', B = 'recon-bootstrap.mjs', I = 'recon-integrity.mjs', R = 'recon.mjs'
// [name, expect (regex over the TITLES of the controls that must be among the failed ones), [file, from, to]...]
const OVER_LINE = "if (over()) { try { await reader?.cancel() } catch { /* ignored */ }; finish('deadline', { status, bytes: size }); throw new Blocked('deadline') }"
const MUTANTS = [
  // allowlist
  ['allowlist ignores the HTTP method', /allowlist: wrong methods/, [C, 'if (e.method !== method || e.host !== u.hostname) continue', 'if (e.host !== u.hostname) continue']],
  ['allowlist ignores the host', /look-alike hosts/, [C, 'if (e.method !== method || e.host !== u.hostname) continue', 'if (e.method !== method) continue']],
  ['allowlist ignores the path', /allowlist: (paths, query sets|archive download)/, [C, 'const pathOk = e.path !== undefined ? u.pathname === e.path : new RegExp(e.pathPattern).test(u.pathname)', 'const pathOk = true']],
  ['allowlist ignores extra / missing query parameters', /allowlist: paths, query sets/, [C, 'if (pairs.length !== want.length || want.some', 'if (want.some']],
  ['allowlist accepts a non-synthetic Auth subject', /Auth lookup body must be exactly/, [C, ' || !SYNTHETIC_SUBJECT.test(b.email[0])', '']],
  ['allowlist accepts plain http / userinfo / ports', /allowlist: paths, query sets, scheme/, [C, "if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.port) throw new Blocked('allowlist-denied')", '']],
  // budgets, timeouts, redirects, sizes
  ['no per-entry request budget', /client: budgets/, [C, ' || (counts.get(entry.id) ?? 0) + 1 > entry.maxRequests', '']],
  ['no global request budget', /client: budgets/, [C, 'if (total + 1 > limits.maxRequests || ', 'if (']],
  ['redirects are followed', /redirect=error and a per-request timeout signal/, [C, "redirect: 'error', signal: signalFor", "redirect: 'follow', signal: signalFor"]],
  ['non-200 answers are accepted below 500', /no retry - every failure/, [C, 'if (status !== 200) {', 'if (status >= 500) {']],
  ['no response size cap', /larger than the entry cap|stop: an oversize/, [C, 'if (size > entry.maxResponseBytes || totalBytes + size > limits.maxTotalResponseBytes)', 'if (false)']],
  ['one retry after a transport failure', /no retry - every failure/, [C, "        finish(code)\n        throw new Blocked(code)\n      }\n      if (over())", "        finish(code)\n        res = await fetchImpl(urlString, { method, headers, body, redirect: 'error' })\n      }\n      if (over())"]],
  ['no durable INTENT before dispatch', /INTENT is durable/, [C, "ledger.event({ phase: 'INTENT', id: entry.id,", "void ({ phase: 'INTENT', id: entry.id,"]],
  ['the bearer token is attached to every host (including the public frontend)', /bearer token goes ONLY/, [C, "if (entry.auth === 'bearer') { headers.authorization", 'if (true) { headers.authorization']],
  // hard global deadline (CR3)
  ['no deadline check before a request starts', /deadline \(start\)|deadline stops everything/, [C, "if (now() >= deadlineAt) throw deny('deadline')", '']],
  ['a request may start exactly at the deadline', /deadline \(start\)/, [C, "if (now() >= deadlineAt) throw deny('deadline')", "if (now() > deadlineAt) throw deny('deadline')"]],
  ['the request signal is not limited by the budget left', /deadline \(signal\)|real signal on a loopback server/, [C, 'signalFor(Math.min(entry.timeoutMs, left))', 'signalFor(entry.timeoutMs)']],
  ['no deadline check after the headers (late status / redirect decided after the budget)', /deadline \(status\)/, [C, "if (over()) { try { await res.body?.cancel() } catch { /* ignored */ }; finish('deadline', { status: res.status }); throw new Blocked('deadline') }", '']],
  ['no deadline check while the body is read', /deadline \(body\)/, [C, OVER_LINE, '']],
  ['the end of the body is checked only after it was accepted', /deadline \(last read\)/, [C, `${OVER_LINE}\n          if (r.done) break`, `if (r.done) break\n          ${OVER_LINE}`]],
  ['an abort inside the budget is reported as an ordinary timeout', /deadline \(abort\)/, [C, "const abortCode = () => (limited || over() ? 'deadline' : 'timeout')", "const abortCode = () => 'timeout'"]],
  ['a completion exactly at the deadline is already too late', /exactly AT the deadline|finishes exactly at its deadline/, [C, 'const over = () => now() > deadlineAt', 'const over = () => now() >= deadlineAt']],
  ['a request is dispatched even when the budget ran out while its INTENT was written', /deadline \(intent\)/, [C, "if (left <= 0) { finish('deadline'); throw new Blocked('deadline') }", '']],
  ['the run itself may end after its deadline as a success', /deadline \(run\): non-request work|deadline \(completion instant\)/, [C, "if (!state.stop && completedAt - runStart > RECON.limits.globalDeadlineMs) {", 'if (false) {']],
  // hard deadline BETWEEN actions and at COMPLETION (V2)
  ['no deadline gate before the cached-login read', /deadline \(between actions/, [C, 'try { gate(); boot = profile', 'try { boot = profile']],
  ['the cached-login read happens before its deadline gate', /deadline \(between actions/, [C, "try { gate(); boot = profile === 'staging' ? readCachedLogin({ env, now }) : (cfg.bootstrap ?? readCachedLogin)({ env, now }) } catch (e) {", "try { boot = profile === 'staging' ? readCachedLogin({ env, now }) : (cfg.bootstrap ?? readCachedLogin)({ env, now }); gate() } catch (e) {"]],
  ['no deadline gate before a branch (so none before the consumed-journal read)', /deadline \(between actions\): the budget runs out DURING the write after the cached-login read/, [C, 'try { gate(); state.branches[name] = await fn(); }', 'try { state.branches[name] = await fn(); }']],
  ['the gate admits an action when exactly 0 budget is left', /deadline \(between actions/, [C, "if (now() - runStart >= RECON.limits.globalDeadlineMs) throw new Blocked('deadline')", "if (now() - runStart > RECON.limits.globalDeadlineMs) throw new Blocked('deadline')"]],
  ['finishedAtUtc is taken from a later clock reading than the verdict', /deadline \(completion instant\)/, [C, 'finishedAtUtc: new Date(completedAt).toISOString()', 'finishedAtUtc: new Date(now()).toISOString()']],
  ['the final ledger event is stamped with its own clock reading', /deadline \(completion instant\)/, [C, "ledger?.event({ phase: 'RESULT', status }, completedAt)", "ledger?.event({ phase: 'RESULT', status })"]],
  ['the STOP deadline of a late completion is stamped with its own clock reading', /deadline \(completion instant\)/, [C, "ledger.event({ phase: 'STOP', branch: 'run', code: 'deadline' }, completedAt)", "ledger.event({ phase: 'STOP', branch: 'run', code: 'deadline' })"]],
  ['a completion exactly at the deadline is a STOP', /deadline \(completion instant\)|finishes exactly at its deadline/, [C, "if (!state.stop && completedAt - runStart > RECON.limits.globalDeadlineMs) {", "if (!state.stop && completedAt - runStart >= RECON.limits.globalDeadlineMs) {"]],
  // branches
  ['functions pagination accepted', /next page of Functions/, [C, " || (body.nextPageToken !== undefined && body.nextPageToken !== '')", '']],
  ['Rules comparison always matches', /difference: (wrong Rules|Rules with different bytes|Rules still)/, [C, 'matchesPin: canonical === t.canonicalSha256 && raw === t.rawSha256 && bytes === t.sourceBytes', 'matchesPin: true']],
  ['frontend comparison always matches', /difference: (a frontend file|a stale root index)/, [C, 'const matches = r.sha256 === e.pinSha256 && r.bytes.length === e.maxResponseBytes', 'const matches = true']],
  ['the subject journal hash is not checked', /subject: the journal bytes changed/, [C, "if (sha256Hex(journalBytes) !== pin.source.sha256) throw new Blocked('subject-source-mismatch')", '']],
  ['the subject hash is not checked (any derived address is looked up)', /pinned subject hash is another subject/, [C, "if (sha256Hex(Buffer.from(email, 'utf8')) !== pin.subjectSha256) throw new Blocked('subject-source-mismatch')", '']],
  ['the evidence scan is skipped', /scanner: a token-looking value/, [C, 'const hits = scanEvidence(evDir, [token])', 'const hits = []']],
  // claim and INIT
  ['the namespace claim is a recursive mkdir', /claim: (a non-recursive mkdir|a competitor)/, [C, 'try { claimMkdir(evDir) }', 'try { claimMkdir(evDir, { recursive: true }) }']],
  ['the claim marker may overwrite', /claim: another claim error or an already present marker/, [C, "claimedAt: new Date(now()).toISOString(), codeSumsSha256: pins.hashes.codeSumsSha256 })}\\n`, { flag: 'wx' })", "claimedAt: new Date(now()).toISOString(), codeSumsSha256: pins.hashes.codeSumsSha256 })}\\n`, { flag: 'w' })"]],
  ['forbidden environment accepted', /INIT: forbidden environment/, [C, 'Object.entries(env).some(([k, v]) => v && FORBIDDEN_ENV.test(k))', 'false']],
  ['consumed / reserved namespaces accepted', /namespace gate itself/, [P, "if (RECON.consumedNames.includes(nameOf(evidenceDir))) problems.push('consumed or reserved namespace')", '']],
  ['production markers ignored', /INIT: a production (host )?marker/, [P, 'for (const v of values) for (const m of RECON.productionMarkers) if (String(v).toLowerCase().includes(m)) problems.push', 'for (const v of []) for (const m of RECON.productionMarkers) if (String(v).toLowerCase().includes(m)) problems.push']],
  // byte integrity (CR1)
  ['execute does not compare the actual bytes with the manifest', /integrity: .* changed after the permit was bound/, [C, 'if (integrity.length) return refuse(`integrity: ${integrity[0]}`)', '']],
  ['the byte integrity is checked only AFTER the namespace claim', /integrity: .* (changed after the permit was bound|is missing)/,
    [C, 'if (integrity.length) return refuse(`integrity: ${integrity[0]}`)', ''],
    [C, '  const state = { task: RECON.taskId, profile, startedAtUtc', "  { const late = integrityProblems(pkg); if (late.length) return refuse(`integrity: ${late[0]}`) }\n  const state = { task: RECON.taskId, profile, startedAtUtc"]],
  ['file hashes are not compared with the manifest', /integrity: .* changed after the permit was bound/, [I, 'if (sha(bytes) !== want) problems.push(`code hash ${rel}`)', '']],
  ['a missing listed file is ignored', /integrity: a listed helper is missing/, [I, 'catch { problems.push(`file missing: ${rel}`); continue }', 'catch { continue }']],
  ['unlisted files in the package directory are accepted', /integrity: an unlisted/, [I, 'for (const rel of present) if (rel !== SUMS_FILE && !listed.has(rel)) problems.push(`unlisted file: ${rel}`)', '']],
  ['unlisted relative imports are accepted', /integrity \(unit\)/, [I, 'if (!listed.has(target)) problems.push(`dependency not listed: ${target} (imported by ${rel})`)', '']],
  ['third-party imports are accepted', /integrity \(unit\)/, [I, "if (!spec.startsWith('.')) { problems.push(`dependency outside the package in ${rel}`); continue }", "if (!spec.startsWith('.')) continue"]],
  ['required files are not enforced in the manifest', /integrity \(unit\)|integrity: the manifest lacks a required helper/, [I, 'for (const f of REQUIRED_FILES) if (!listed.has(f)) problems.push(`required file not listed: ${f}`)', '']],
  ['plan / permit-draft do not check the integrity', /integrity \(offline launcher\)/, [R, "if (ip.length) { line('INIT_REFUSED', `reason=integrity: ${ip[0]}`); process.exit(3) }", '']],
  ['selftest does not run the byte check', /integrity: the selftest runs the same check/, [R, 'return { problems: integrityProblems(dir), files }', 'return { problems: [], files }']],
  // permit
  ['permit not bound to the package bytes', /a permit bound to other bytes/, [M, 'for (const [k, f] of bound) if (typeof facts[f]', 'for (const [k, f] of []) if (typeof facts[f]']],
  ['permit acknowledgements not required', /permit validity matrix/, [M, ' || ACK_KEYS.some(k => ack[k] !== true)', '']],
  ['permit validity longer than 2 h accepted', /permit validity matrix/, [M, "if (expires - approved > RECON.limits.maxPermitMs) problems.push('permit validity longer than 2 h')", '']],
  ['permit validity window ignored', /permit validity matrix/, [M, "if (!(approved <= nowMs && nowMs < expires)) problems.push('permit is not valid now')", '']],
  ['credential read decoupled from the Google branches', /permit validity matrix/, [M, "if (needsLogin !== ops.credentialConfigRead) problems.push('permit: credentialConfigRead must be on exactly when a Google API branch is on')", '']],
  // credential bootstrap
  ['a nearly expired cached token is accepted', /bootstrap: missing \/ unreadable/, [B, "if (remainingMs < minRemainingMs) throw new Blocked('credential-too-old')", '']],
  ['a token of any shape is accepted', /bootstrap: missing \/ unreadable/, [B, "if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4096 || /\\s/.test(accessToken) || !Number.isFinite(expiresAt)) throw new Blocked('credential-token-missing')", '']]
]

/** Builds a self-consistent copy: relocated roots, edits applied, manifest regenerated AFTER the edits. */
function build(name, edits) {
  const dir = path.join(TMP, name, 'pkg')
  copyTree(PKG, dir)
  relocateRoots(dir)
  for (const [file, from, to] of edits) {
    const f = path.join(dir, file)
    const s = fs.readFileSync(f, 'utf8')
    const n = s.split(from).length - 1
    if (n !== 1) throw new Error(`ANCHOR_${n === 0 ? 'MISSING' : 'AMBIGUOUS'} in ${file}: ${from.slice(0, 70)}`)
    const next = s.replace(from, () => to)
    if (next === s) throw new Error(`MUTATION_IS_A_NO_OP in ${file}`)
    fs.writeFileSync(f, next)
  }
  writeSums(dir)
  return dir
}
function runControls(dir) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(dir, 'tests', 'recon-negative-controls.mjs')], { cwd: dir, windowsHide: true })
    let out = '', err = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, TIMEOUT_MS)
    child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); resolve({ harnessError: `spawn: ${e.code ?? e.message}` }) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const summary = /^RECON_NEGATIVE_CONTROLS (PASS|FAIL) (\d+)\/(\d+)/m.exec(out)
      const failed = [...out.matchAll(/^FAIL (.*?)(?: :: .*)?$/gm)].map(m => m[1])
      if (timedOut) return resolve({ harnessError: 'timeout' })
      if (signal) return resolve({ harnessError: `signal ${signal}` })
      if (!summary) return resolve({ harnessError: `no summary line (exit ${code}): ${(err || out).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200)}` })
      resolve({ exit: code, verdict: summary[1], passed: Number(summary[2]), total: Number(summary[3]), failed })
    })
  })
}

/** The ONLY place that decides a verdict. A harness error is never a detection; a failure that is not one of the relevant controls is not a detection either. */
export function classify(r, expect) {
  if (r.harnessError) return { status: 'ERROR', detail: r.harnessError }
  if (r.verdict === 'PASS') return { status: 'SURVIVED', detail: `all ${r.total} controls passed` }
  const relevant = r.failed.filter(f => expect.test(f))
  if (relevant.length) return { status: 'DETECTED', detail: `${r.failed.length} failed, relevant: ${relevant[0].slice(0, 110)}` }
  return { status: 'IRRELEVANT_FAILURE', detail: `failed only: ${r.failed.slice(0, 3).map(f => f.slice(0, 80)).join(' | ')}` }
}

const results = []
const errors = []
// ── baselines (must be fully green before any mutant is judged) ─────────────────────────────────────────────────────────────────────────────
const baselines = [['no-op relocation (manifest regenerated)', []], ['harmless edit (a comment) with a regenerated manifest', [[C, '// ── pins and allowlist', '// ── pins and allowlist (harmless comment edit)']]]]
let baselineTotal = null
for (const [label, edits] of baselines) {
  let r
  try { r = await runControls(build(label.replace(/\W+/g, '-'), edits)) } catch (e) { r = { harnessError: e.message } }
  if (r.harnessError || r.exit !== 0 || r.verdict !== 'PASS') { console.log(`BASELINE_NOT_GREEN ${label}: ${r.harnessError ?? `${r.verdict} ${r.passed}/${r.total} failed=${r.failed?.join(' | ')}`}`); console.log('RECON_MUTATION_CHECKS ERROR baseline is not green - no mutant was judged'); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(2) }
  console.log(`BASELINE_OK ${label}: ${r.passed}/${r.total}`)
  baselineTotal ??= r.total
  if (r.total !== baselineTotal) { console.log('RECON_MUTATION_CHECKS ERROR the two baselines ran different numbers of controls'); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(2) }
}
// ── canaries: the harness itself must NOT count a crash or an unrelated failure as a detection ───────────────────────────────────────────────
{
  const synthetic = [
    [{ harnessError: 'timeout' }, /x/, 'ERROR'], [{ exit: 1, verdict: 'FAIL', passed: 1, total: 2, failed: ['some other control'] }, /relevant/, 'IRRELEVANT_FAILURE'],
    [{ exit: 0, verdict: 'PASS', passed: 2, total: 2, failed: [] }, /relevant/, 'SURVIVED'], [{ exit: 1, verdict: 'FAIL', passed: 1, total: 2, failed: ['the relevant control'] }, /relevant/, 'DETECTED']
  ]
  const wrong = synthetic.filter(([r, e, want]) => classify(r, e).status !== want)
  const live = [
    ['a SYNTAX ERROR in the engine (the controls crash)', /./, 'ERROR', [[C, "export const EXIT = Object.freeze({ ALL_MATCH: 0,", "}}} export const EXIT = Object.freeze({ ALL_MATCH: 0,"]]],
    ['a real weakening judged against a control of ANOTHER gate', /allowlist: wrong methods/, 'IRRELEVANT_FAILURE', [[M, ' || ACK_KEYS.some(k => ack[k] !== true)', '']]]
  ]
  const liveWrong = []
  await Promise.all(live.map(async ([label, expect, want, edits]) => {
    let r; try { r = await runControls(build(`canary-${label.length}`, edits)) } catch (e) { r = { harnessError: e.message } }
    const got = classify(r, expect).status
    console.log(`${got === want ? 'CANARY_OK' : 'CANARY_WRONG'} ${label}: ${got}`)
    if (got !== want) liveWrong.push(label)
  }))
  if (wrong.length || liveWrong.length) { console.log('RECON_MUTATION_CHECKS ERROR the harness classifies crashes or unrelated failures as detections'); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(2) }
}
// ── mutants ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let next = 0
async function worker() {
  for (;;) {
    const i = next++
    if (i >= MUTANTS.length) return
    const [name, expect, ...edits] = MUTANTS[i]
    let r
    try { r = await runControls(build(`m${i + 1}`, edits)) } catch (e) { r = { harnessError: e.message } }
    const { status, detail } = classify(r, expect)
    results[i] = { name, status, detail }
    console.log(`${status} ${name} :: ${detail}`)
    if (status === 'ERROR') errors.push(name)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
fs.rmSync(TMP, { recursive: true, force: true })
const detected = results.filter(r => r.status === 'DETECTED').length
const bad = results.filter(r => r.status !== 'DETECTED')
console.log(`RECON_MUTATION_CHECKS ${bad.length ? 'FAIL' : 'PASS'} detected=${detected}/${MUTANTS.length} baselines=${baselineTotal}/${baselineTotal}${bad.length ? ` not-detected=${bad.map(b => `${b.status}:${b.name}`).join(' | ')}` : ''}`)
process.exitCode = bad.length ? 1 : 0
