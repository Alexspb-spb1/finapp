// Deterministic regression tests for the evidence tooling (CR1): sanitizer, scan, user-name redaction, target binding, hashes, finalization and
// the verification driver. Synthetic data only; nothing is read from a real run. The collector under test is the byte-exact snapshot of the candidate package.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { collect, dropCredentialKeys, sanitizeEvidenceText, SECRET_LIKE } from '../runner-r4-source/tests/collect-results.mjs'
import { resolveTarget, scanSecrets, redactUserNames, scanUserNames, writeSums, verifySums, SECRET_PATTERNS, PACKAGE_NAME } from './results-tools.mjs'
import { finalize } from './finalize-results.mjs'
import { evaluateStep, runSteps, verdict } from './verify-driver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`) } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`) } }
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed') }
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'not equal'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`) }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-tooling-tests-'))
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const SYNTH_SECRET = 'M1!SyntheticOnlyValue_0123456789abcdef' // matches the secret pattern, belongs to nothing

// a synthetic rehearsal root: one case with a recovery manifest that embeds a fixture snapshot with password keys (the structure found by the audit)
function makeRehearsal(dir) {
  const c = path.join(dir, 'rules-failure-case-20261001-000000-001')
  w(path.join(c, 'orchestrator-result.json'), JSON.stringify({ status: 'SAFE_STOP', exit: 3 }))
  w(path.join(c, 'run', 'recovery-manifest-1.json'), JSON.stringify({ kind: 'recovery', runId: 'r1', fixtureSnapshot: { users: { admin: { email: 'admin@example.invalid', password: SYNTH_SECRET, uid: null }, member: { email: 'm@example.invalid', password: SYNTH_SECRET } }, tokens: [{ refresh_token: 'x' }] } }, null, 2))
  w(path.join(c, 'run', 'journal.jsonl'), `${JSON.stringify({ e: 'INTENT', password: SYNTH_SECRET, key: 'k' })}\n${JSON.stringify({ e: 'OK' })}\n`)
  w(path.join(c, 'run', 'fixture.json'), JSON.stringify({ users: { admin: { password: SYNTH_SECRET } } })) // must never be copied
  w(path.join(c, 'run', 'inventory-1.json'), JSON.stringify({ users: 0 }))
  return dir
}
function makePackage(parent, name = 'm1-r4-test') {
  const pkg = path.join(parent, name)
  w(path.join(pkg, 'results', 'README.txt'), 'x')
  return pkg
}

// ---- sanitizer (collector) ----
t('the collector drops credential keys structurally: no password key or value in the published copy, other fields kept', () => {
  const base = makeRehearsal(path.join(tmp, 'reh1')), pkg = makePackage(path.join(tmp, 'p1'))
  const r = collect({ pkg, base })
  const out = path.join(pkg, 'results', 'rehearsal', 'rules-failure-case-20261001-000000-001', 'run')
  const m = fs.readFileSync(path.join(out, 'recovery-manifest-1.json'), 'utf8')
  ok(!/"password"/.test(m) && !m.includes(SYNTH_SECRET) && !m.includes('refresh_token'), 'credential structure survived')
  const j = JSON.parse(m)
  eq([j.kind, j.runId, j.fixtureSnapshot.users.admin.email, j.fixtureSnapshot.users.admin.uid, j.fixtureSnapshot.users.member.email], ['recovery', 'r1', 'admin@example.invalid', null, 'm@example.invalid'])
  ok(!/"password"/.test(fs.readFileSync(path.join(out, 'journal.jsonl'), 'utf8')), 'jsonl credential key survived')
  eq(r.sanitizedFiles, 2); eq(r.dropped.password, 3); eq(r.dropped.refresh_token, 1)
  eq(scanSecrets(path.join(pkg, 'results')), [], 'scan after sanitizing')
})
t('control: the same synthetic input copied WITHOUT the sanitizer is caught by the scan (the test is sensitive)', () => {
  const base = makeRehearsal(path.join(tmp, 'reh2')), pkg = makePackage(path.join(tmp, 'p2'))
  const raw = path.join(pkg, 'results', 'raw', 'recovery-manifest-1.json')
  fs.mkdirSync(path.dirname(raw), { recursive: true })
  fs.copyFileSync(path.join(base, 'rules-failure-case-20261001-000000-001', 'run', 'recovery-manifest-1.json'), raw)
  const kinds = new Set(scanSecrets(path.join(pkg, 'results')).map(h => h.kind))
  ok(kinds.has('password-key') && kinds.has('m1-fixture-password') && kinds.has('refresh-token'), `kinds=${[...kinds]}`)
})
t('the fixture file is never copied and files without credentials are copied byte for byte', () => {
  const base = makeRehearsal(path.join(tmp, 'reh3')), pkg = makePackage(path.join(tmp, 'p3'))
  collect({ pkg, base })
  const dst = path.join(pkg, 'results', 'rehearsal', 'rules-failure-case-20261001-000000-001')
  ok(!fs.existsSync(path.join(dst, 'run', 'fixture.json')), 'fixture.json copied')
  eq(sha(path.join(dst, 'run', 'inventory-1.json')), sha(path.join(base, 'rules-failure-case-20261001-000000-001', 'run', 'inventory-1.json')))
})
t('the source rehearsal files are never modified by the collector', () => {
  const base = makeRehearsal(path.join(tmp, 'reh4')), pkg = makePackage(path.join(tmp, 'p4'))
  const f = path.join(base, 'rules-failure-case-20261001-000000-001', 'run', 'recovery-manifest-1.json'), before = sha(f)
  collect({ pkg, base }); eq(sha(f), before)
})
t('an unparseable .json evidence file aborts the collection (fail closed)', () => {
  const base = makeRehearsal(path.join(tmp, 'reh5')), pkg = makePackage(path.join(tmp, 'p5'))
  w(path.join(base, 'rules-failure-case-20261001-000000-001', 'run', 'result-1.json'), '{ not json')
  let msg = ''; try { collect({ pkg, base }) } catch (e) { msg = e.message }
  ok(msg.startsWith('UNPARSEABLE_EVIDENCE_FILE'), `msg=${msg}`)
})
t('a deliberately corrupted journal line is kept verbatim when harmless and withheld when it looks like a secret', () => {
  const base = makeRehearsal(path.join(tmp, 'reh5b')), pkg = makePackage(path.join(tmp, 'p5b'))
  const harmless = '{"e":"INTENT","k":"x" CORRUPT'
  const leaky = `{"e":"INTENT","password": "${SYNTH_SECRET}" CORRUPT`
  w(path.join(base, 'rules-failure-case-20261001-000000-001', 'run', 'journal.jsonl'), `${JSON.stringify({ e: 'A' })}\n${harmless}\n${leaky}\n${JSON.stringify({ e: 'B' })}\n`)
  const r = collect({ pkg, base })
  const out = fs.readFileSync(path.join(pkg, 'results', 'rehearsal', 'rules-failure-case-20261001-000000-001', 'run', 'journal.jsonl'), 'utf8').split('\n')
  eq(out[1], harmless); eq(JSON.parse(out[2]), { withheldUnparseableLine: true, length: leaky.length }); eq(r.withheldLines, 1)
  ok(!out.join('\n').includes(SYNTH_SECRET) && scanSecrets(path.join(pkg, 'results')).length === 0)
})
t('the collector secret-like pattern equals the final scan patterns (no drift)', () => {
  eq(SECRET_LIKE.source, SECRET_PATTERNS.map(([, r]) => r.source).join('|'))
})
t('the collector refuses a missing base and an output directory outside <pkg>/results', () => {
  const pkg = makePackage(path.join(tmp, 'p6')), base = makeRehearsal(path.join(tmp, 'reh6'))
  let a = '', b = '', c = ''
  try { collect({ pkg, base: path.join(tmp, 'nope') }) } catch (e) { a = e.message }
  try { collect({ pkg, base, out: path.join(tmp, 'elsewhere') }) } catch (e) { b = e.message }
  try { collect({ pkg, base, out: path.join(pkg, 'results') }) } catch (e) { c = e.message }
  eq([a, b, c], ['COLLECT_BASE_MISSING', 'COLLECT_OUT_OUTSIDE_PACKAGE_RESULTS', 'COLLECT_OUT_OUTSIDE_PACKAGE_RESULTS'])
  ok(fs.existsSync(path.join(tmp, 'p6', 'm1-r4-test', 'results', 'README.txt')), 'results root was wiped')
})
t('dropCredentialKeys / sanitizeEvidenceText: unit behaviour (case-insensitive names, arrays, no change -> null)', () => {
  const s = { dropped: {} }
  eq(dropCredentialKeys({ a: [{ Password: 'x', n: 1 }], apiKey: 'k', id_token: 't', keep: { Authorization: 'b' } }, s), { a: [{ n: 1 }], keep: {} })
  eq(s.dropped, { password: 1, apikey: 1, id_token: 1, authorization: 1 })
  eq(sanitizeEvidenceText('x.json', '{"a":1}', { dropped: {} }), null)
  eq(sanitizeEvidenceText('x.txt', 'password: x', { dropped: {} }), null)
})

// ---- scan / user names / sums / target binding ----
t('the secret patterns are the unchanged original set (not loosened)', () => {
  eq(SECRET_PATTERNS.map(([, r]) => r.source), ['M1![A-Za-z0-9_-]{20,}', '"password"\\s*:', 'AIza[0-9A-Za-z_-]{30,}', 'Bearer [A-Za-z0-9._-]{20,}', 'refresh_token'])
})
t('the scan reports file and kind only, never the matched text', () => {
  const pkg = makePackage(path.join(tmp, 'p7')); const r = path.join(pkg, 'results')
  w(path.join(r, 'a.json'), `{"password": "${SYNTH_SECRET}"}`)
  const hits = scanSecrets(r); ok(hits.length >= 1)
  ok(!JSON.stringify(hits).includes(SYNTH_SECRET), 'matched text leaked into the hit list')
})
t('user-name redaction replaces the name (also URL-encoded) in result files and the scan then finds none', () => {
  const pkg = makePackage(path.join(tmp, 'p8')); const r = path.join(pkg, 'results')
  w(path.join(r, 'x.json'), JSON.stringify({ p: 'C:\\Users\\SyntheticUser\\AppData', q: 'C%3A/Users/SyntheticUser/x' }))
  eq(scanUserNames(r, ['SyntheticUser']).length, 1)
  eq(redactUserNames(r, ['SyntheticUser']), 1)
  eq(scanUserNames(r, ['SyntheticUser']), [])
  ok(fs.readFileSync(path.join(r, 'x.json'), 'utf8').includes('<user>'))
})
t('target binding: the consumed R3 package, a missing target and a package without results are refused; nothing is written', () => {
  const r3 = path.join(tmp, 'm1-r3-staging'); w(path.join(r3, 'results', 'ps51.json'), '{"p":"C:\\\\Users\\\\SyntheticUser\\\\x"}')
  const before = sha(path.join(r3, 'results', 'ps51.json'))
  const errs = []
  for (const target of [r3, path.join(tmp, 'm1-r4-missing'), path.join(tmp, 'm1-r4-noresults'), undefined]) { if (target && target.endsWith('noresults')) fs.mkdirSync(target, { recursive: true }); try { resolveTarget(target) } catch (e) { errs.push(e.message) } }
  eq(errs, ['TARGET_NOT_A_CANDIDATE_PACKAGE', 'TARGET_MISSING', 'TARGET_HAS_NO_RESULTS', 'TARGET_REQUIRED'])
  ok(PACKAGE_NAME.test('m1-r4-staging') && !PACKAGE_NAME.test('m1-r3-staging'))
  eq(sha(path.join(r3, 'results', 'ps51.json')), before)
  const cli = spawnSync(process.execPath, [path.join(HERE, 'results-tools.mjs'), 'redact', '--pkg', r3, '--name', 'SyntheticUser'], { encoding: 'utf8' })
  ok(cli.status === 1 && /TARGET_NOT_A_CANDIDATE_PACKAGE/.test(cli.stderr), `status=${cli.status}`)
  eq(sha(path.join(r3, 'results', 'ps51.json')), before, 'the old results directory was edited')
})
t('sums: written, verified, and every change/extra/missing file is reported', () => {
  const pkg = makePackage(path.join(tmp, 'p9')); const r = path.join(pkg, 'results')
  w(path.join(r, 'a.txt'), 'a'); w(path.join(r, 'sub', 'b.txt'), 'b')
  writeSums(r); eq(verifySums(r), [])
  w(path.join(r, 'a.txt'), 'changed'); w(path.join(r, 'c.txt'), 'new'); fs.rmSync(path.join(r, 'sub', 'b.txt'))
  eq(verifySums(r).sort(), ['changed a.txt', 'missing sub/b.txt', 'unlisted c.txt'])
})

// ---- finalization: exit code and success marker ----
const okExec = () => ({ status: 0, stdout: 'ok\n' })
t('finalize: all steps succeed -> ok, exit 0', () => {
  const pkg = makePackage(path.join(tmp, 'p10')); const r = finalize({ pkg, base: 'unused', names: ['SyntheticUser'], exec: okExec })
  ok(r.ok && r.exitCode === 0 && r.steps.length === 8, `ok=${r.ok} steps=${r.steps.length}`)
})
t('finalize: a failing collector, code-sums or verify step -> not ok, exit 1, later steps not run', () => {
  for (const failing of ['collect-results.mjs', 'make-code-sums.mjs', 'm1-verify-sums.mjs']) {
    const pkg = makePackage(path.join(tmp, `p11-${failing}`))
    const r = finalize({ pkg, base: 'unused', names: ['SyntheticUser'], exec: args => path.basename(args[0]) === failing ? { status: 1, stdout: 'boom' } : okExec() })
    ok(!r.ok && r.exitCode === 1, `${failing}: ok=${r.ok} exit=${r.exitCode}`)
  }
})
t('finalize: a secret-pattern hit in the results -> exit 2, no sums written, no success', () => {
  const pkg = makePackage(path.join(tmp, 'p12')); w(path.join(pkg, 'results', 'leak.json'), `{"password": "${SYNTH_SECRET}"}`)
  const r = finalize({ pkg, base: 'unused', names: ['SyntheticUser'], exec: okExec })
  ok(!r.ok && r.exitCode === 2 && r.failedStep === 'scan', `ok=${r.ok} exit=${r.exitCode} step=${r.failedStep}`)
  ok(!fs.existsSync(path.join(pkg, 'results', 'SHA256SUMS.txt')), 'sums were written for dirty results')
})
t('finalize: the operating-system user name is redacted inside the target results before the scan', () => {
  const pkg = makePackage(path.join(tmp, 'p13')); w(path.join(pkg, 'results', 'x.txt'), 'C:\\Users\\SyntheticUser\\x')
  const r = finalize({ pkg, base: 'unused', names: ['SyntheticUser'], exec: () => okExec() })
  ok(r.ok, 'finalize failed')
  ok(!fs.readFileSync(path.join(pkg, 'results', 'x.txt'), 'utf8').includes('SyntheticUser'), 'name survived')
})
t('finalize CLI: a dirty fake package ends with a non-zero process exit code and never prints the success marker', () => {
  const pkg = path.join(tmp, 'm1-r4-fakecli')
  w(path.join(pkg, 'tests', 'collect-results.mjs'), `import fs from 'node:fs';fs.mkdirSync('results/rehearsal',{recursive:true});fs.writeFileSync('results/rehearsal/leak.json','{"password": "${SYNTH_SECRET}"}')`)
  w(path.join(pkg, 'tests', 'make-code-sums.mjs'), '')
  w(path.join(pkg, 'm1-verify-sums.mjs'), '')
  w(path.join(pkg, 'results', 'x.txt'), 'x')
  const r = spawnSync(process.execPath, [path.join(HERE, 'finalize-results.mjs'), '--pkg', pkg, '--base', tmp, '--name', 'SyntheticUser'], { encoding: 'utf8' })
  ok(r.status === 2, `exit=${r.status}`)
  ok(/RESULTS_FINALIZE_FAILED step=scan/.test(r.stdout) && !/RESULTS_FINALIZED\n/.test(r.stdout), r.stdout)
  ok(!r.stdout.includes(SYNTH_SECRET), 'secret printed')
})
t('finalize CLI: a clean fake package finalizes with exit 0 and the success marker', () => {
  const pkg = path.join(tmp, 'm1-r4-fakeok')
  w(path.join(pkg, 'tests', 'collect-results.mjs'), `import fs from 'node:fs';fs.mkdirSync('results/rehearsal',{recursive:true});fs.writeFileSync('results/rehearsal/a.json','{"a":1}')`)
  w(path.join(pkg, 'tests', 'make-code-sums.mjs'), ''); w(path.join(pkg, 'm1-verify-sums.mjs'), ''); w(path.join(pkg, 'results', 'x.txt'), 'x')
  const r = spawnSync(process.execPath, [path.join(HERE, 'finalize-results.mjs'), '--pkg', pkg, '--base', tmp, '--name', 'SyntheticUser'], { encoding: 'utf8' })
  ok(r.status === 0 && /^RESULTS_FINALIZED$/m.test(r.stdout), `exit=${r.status} ${r.stdout}`)
  eq(verifySums(path.join(pkg, 'results')), [])
})

// ---- verification driver ----
t('driver: a step that prints PASS but exits non-zero FAILS (the exit code decides)', () => { ok(!evaluateStep({ expect: /X PASS/ }, 2, 'X PASS 3/3').ok) })
t('driver: exit 0 without the expected line, or with an incomplete x/y, FAILS', () => {
  ok(!evaluateStep({ expect: /X PASS/ }, 0, 'nothing').ok)
  ok(!evaluateStep({ expect: /X PASS/ }, 0, 'X PASS 5/6').ok)
  ok(!evaluateStep({ expect: /MUT PASS/ }, 0, 'MUT PASS detected=19/20').ok)
  ok(evaluateStep({ expect: /X PASS/ }, 0, 'X PASS 6/6').ok && evaluateStep({}, 0, '').ok)
})
t('driver: one failing step among passing ones -> VERIFY_ALL_FAILED and the step is named; all passing -> VERIFY_ALL_PASS', () => {
  const steps = [{ name: 'a', expect: /A PASS/ }, { name: 'b', expect: /B PASS/ }, { name: 'c' }]
  const good = runSteps(steps, s => ({ status: 0, stdout: s.name === 'a' ? 'A PASS 1/1' : s.name === 'b' ? 'B PASS 2/2' : '' }))
  eq(verdict(good).marker, 'VERIFY_ALL_PASS steps=3')
  const bad = runSteps(steps, s => ({ status: s.name === 'b' ? 2 : 0, stdout: s.name === 'a' ? 'A PASS 1/1' : s.name === 'b' ? 'B PASS 2/2' : '' }))
  eq(verdict(bad).marker, 'VERIFY_ALL_FAILED failed=b'); eq(bad.length, 3, 'later steps must still run and be recorded')
})
t('driver: an executor that throws, and an empty step list, never give a success marker', () => {
  ok(!verdict(runSteps([{ name: 'x' }], () => { throw new Error('boom') })).ok)
  ok(!verdict([]).ok && verdict([]).marker.startsWith('VERIFY_ALL_FAILED'))
})
t('driver CLI: a failing step gives a non-zero process exit code and no VERIFY_ALL_PASS', () => {
  const pkg = path.join(tmp, 'm1-r4-drv'); w(path.join(pkg, 'tests', 'normalize-ps1-bom.mjs'), 'process.exit(3)')
  const dirs = ['rc', 'jdk', 'em', 'reh', 'work'].map(d => { const p = path.join(tmp, d); fs.mkdirSync(p, { recursive: true }); return p })
  const cli = ['--pkg', pkg, '--release-clone', dirs[0], '--jdk-bin', dirs[1], '--emulators-path', dirs[2], '--rehearsal-base', dirs[3], '--web-config', path.join(tmp, 'wc'), '--work', dirs[4], '--phases', 'local', '--only', 'normalize-bom']
  const r = spawnSync(process.execPath, [path.join(HERE, 'verify-driver.mjs'), ...cli], { encoding: 'utf8' })
  ok(r.status === 1 && /VERIFY_ALL_FAILED failed=normalize-bom/.test(r.stdout) && !/VERIFY_ALL_PASS/.test(r.stdout), `exit=${r.status} ${r.stdout}`)
  w(path.join(pkg, 'tests', 'normalize-ps1-bom.mjs'), 'process.exit(0)')
  const r2 = spawnSync(process.execPath, [path.join(HERE, 'verify-driver.mjs'), ...cli], { encoding: 'utf8' })
  ok(r2.status === 0 && /VERIFY_ALL_PASS steps=1/.test(r2.stdout), `exit=${r2.status} ${r2.stdout}`)
})
t('the historic summary of the earlier run is annotated as superseded and keeps its original contradictory lines', () => {
  const s = fs.readFileSync(path.join(HERE, '..', 'verification-run-summary.txt'), 'utf8')
  ok(/^# HISTORIC/.test(s) && /secretPatternHits=1/.test(s) && /RUN_ALL_R4_DONE/.test(s), 'annotation or original lines missing')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`TOOLING_TESTS ${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail}`)
process.exitCode = fail ? 1 : 0
