// Local emulator-only tests for the cleanup gate (owner rules 2026-09-15). Never used against staging.
// Rules evidence files here are SYNTHETIC copies of the stagingResources verify-current-rules
// journal shape: they exercise the gate's file validation and decision logic only.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const H = '714d0f91c60a582ee87dc7da82d6249b3106329f'
const OLD = 'f117e489f9549da9083c19bdf4104b3651aa500061aa52426f09cb6fe492adda'
const NEW = 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd'
const BASE = 'D:\\projects\\finapp\\.runtime'
const DOCS = 'http://127.0.0.1:8080/v1/projects/demo-finapp/databases/(default)/documents'
const owner = { authorization: 'Bearer owner', 'content-type': 'application/json' }
const results = []

const smoke = (rd, mode, extra = []) => spawnSync(process.execPath, ['m1-smoke.mjs', '--target', 'emulator', '--expected-head', H, '--run-dir', rd, '--mode', mode, ...extra], { encoding: 'utf8' })
const journal = rd => fs.readFileSync(path.join(rd, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
// Tolerant reader for the runs that deliberately damage the journal.
const journalSafe = rd => fs.readFileSync(path.join(rd, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return { event: 'UNPARSED_LINE' } } })
const inspect = (rd, mode, out) => spawnSync(process.execPath, ['m1-run-inspect.mjs', '--run-dir', rd, '--mode', mode, '--out', out], { encoding: 'utf8' })
const fixture = rd => JSON.parse(fs.readFileSync(path.join(rd, 'fixture.json'), 'utf8'))
const exists = async p => (await fetch(`${DOCS}/${p}`, { headers: owner })).status === 200
const loadRules = async file => (await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-finapp:securityRules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: fs.readFileSync(file, 'utf8') }] } }) })).status
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`) }

function evidence(rd, name, hash, finishedAt = new Date().toISOString()) {
  const file = path.join(rd, `${name}.jsonl`)
  fs.writeFileSync(file, `${JSON.stringify({ task: 'SEC-006 Stage 8', mode: 'verify-current-rules', project: 'finapp-staging', sourceHead: H, startedAt: finishedAt, canonicalSha256: hash, status: 'CURRENT_RULES_HASH_VERIFIED', finishedAt })}\n`)
  return file
}
const verifiedNew = rd => ['--rules-status', 'verified-new', '--rules-evidence', evidence(rd, `ev-new-${Date.now()}`, NEW)]

async function seeded(tag) {
  const rd = path.join(BASE, `m1-emu-gate-${tag}-${Date.now()}`)
  for (const mode of ['preflight', 'seed']) { const r = smoke(rd, mode); if (r.status !== 0) throw new Error(`${tag} ${mode}: ${r.stderr}`) }
  return rd
}
async function outcome(rd, extra) {
  const fx = fixture(rd)
  const before = journalSafe(rd).length
  const r = smoke(rd, 'cleanup', extra)
  const events = journalSafe(rd).slice(before)
  const recovery = fs.readdirSync(rd).filter(f => f.startsWith('recovery-manifest-')).sort()
  const manifest = recovery.length ? JSON.parse(fs.readFileSync(path.join(rd, recovery.at(-1)), 'utf8')) : null
  return {
    exit: r.status,
    refused: events.some(e => e.event === 'CLEANUP_REFUSED'),
    deletesSent: events.some(e => e.event === 'CLEANUP_DOCS_MAY_BE_SENT' || e.event === 'AUTH_DELETE_MAY_BE_SENT'),
    documentsStillPresent: await exists(`companies/${fx.companies.A.id}`) && await exists(`users/${fx.users.viewer.uid}`),
    failures: events.some(e => e.event === 'CLEANUP_REFUSED') ? manifest?.failures : undefined,
  }
}
const expectRefused = async (name, rd, extra, needle) => {
  const o = await outcome(rd, extra)
  record(name, o.exit === 3 && o.refused && !o.deletesSent && o.documentsStillPresent && o.failures?.some(f => f.includes(needle)), o)
}
const expectAllowed = async (name, rd, extra) => {
  const o = await outcome(rd, extra)
  record(name, o.exit === 0 && !o.refused && o.deletesSent && !o.documentsStillPresent, o)
}

// Rules failure during smoke: API against the pre-M1 Rules stops at an R-probe.
async function rulesFailureRun(tag) {
  const rd = await seeded(tag)
  await loadRules('D:/projects/finapp/.runtime/m1-baseline-main-6d713fe/firestore.rules')
  const api = smoke(rd, 'api')
  await loadRules('D:/projects/finapp/m1-release-714d0f91/firestore.rules')
  const stopEvent = journal(rd).filter(e => e.event === 'MODE_STOP').at(-1)
  if (api.status === 0 || !/^R[1-4]\./.test(stopEvent?.reason ?? '')) throw new Error(`${tag}: expected an R-probe STOP`)
  return rd
}

// ── Rules failure → cleanup only after a confirmed rollback ──────────────────
{
  const rd = await rulesFailureRun('rb-ok')
  await expectAllowed('T8 Rules failure + rollback exit 0 + baseline evidence after failure -> cleanup allowed', rd,
    ['--rules-status', 'rolled-back', '--rules-rollback-deploy-exit', '0', '--rules-evidence', evidence(rd, 'rb-verify', OLD)])
}
{
  const rd = await rulesFailureRun('rb-exit')
  await expectRefused('T9 Rules failure + rollback deploy exit 1 -> refused', rd,
    ['--rules-status', 'rolled-back', '--rules-rollback-deploy-exit', '1', '--rules-evidence', evidence(rd, 'rb-verify', OLD)], 'rollback deploy exit is not 0')
}
{
  const rd = await rulesFailureRun('rb-wronghash')
  await expectRefused('T10 Rules failure + evidence still shows reviewed Rules -> refused', rd,
    ['--rules-status', 'rolled-back', '--rules-rollback-deploy-exit', '0', '--rules-evidence', evidence(rd, 'rb-verify', NEW)], 'rollback not confirmed')
}
{
  const rd = await rulesFailureRun('rb-missing')
  await expectRefused('T11 Rules failure + no rollback evidence -> refused', rd,
    ['--rules-status', 'rolled-back', '--rules-rollback-deploy-exit', '0'], 'evidence file missing')
}
{
  const rd = await rulesFailureRun('rb-stale')
  await expectRefused('T12 Rules failure + evidence older than the failure -> refused', rd,
    ['--rules-status', 'rolled-back', '--rules-rollback-deploy-exit', '0', '--rules-evidence', evidence(rd, 'rb-verify', OLD, '2026-01-01T00:00:00.000Z')], 'predates the Rules failure')
}
{
  const rd = await rulesFailureRun('rb-claimed-ok')
  await expectRefused('T13 Rules failure + status verified-new -> refused', rd, verifiedNew(rd), 'requires a confirmed rollback')
}
{
  const rd = await rulesFailureRun('rb-unconfirmed')
  await expectRefused('T14 Rules failure + status unconfirmed -> refused', rd, ['--rules-status', 'unconfirmed'], 'Rules state unconfirmed')
}
{
  const rd = await seeded('untouched-after-seed')
  await expectRefused('T15 synthetic data exists + status untouched -> refused', rd, ['--rules-status', 'untouched'], 'status untouched is not acceptable')
}

// ── Manifest / STOP kind / ownership gates (with valid reviewed-Rules evidence) ──
{
  const rd = await seeded('integrity')
  const again = smoke(rd, 'seed')
  const kind = journal(rd).filter(e => e.event === 'MODE_STOP').at(-1)?.kind
  record('T3a repeated seed is an integrity STOP', again.status !== 0 && kind === 'integrity', { kind })
  await expectRefused('T3b integrity STOP -> refused', rd, verifiedNew(rd), 'G2 STOP in seed of kind integrity')
}
{
  const rd = await seeded('manifest')
  const fx = fixture(rd)
  fx.companies.A.name += ' tampered'
  fs.writeFileSync(path.join(rd, 'fixture.json'), `${JSON.stringify(fx, null, 2)}\n`)
  await expectRefused('T4 tampered manifest -> refused', rd, verifiedNew(rd), 'G1 manifest hash')
}
{
  const rd = await seeded('ownership')
  const fx = fixture(rd)
  const r = await fetch(`${DOCS}/companies/${fx.companies.A.id}?updateMask.fieldPaths=ownerId`, { method: 'PATCH', headers: owner, body: JSON.stringify({ fields: { ownerId: { stringValue: 'someone-else' } } }) })
  if (r.status !== 200) throw new Error('T5 setup')
  await expectRefused('T5 foreign owner -> refused', rd, verifiedNew(rd), 'G4 company A: owner/name/id mismatch')
}
{
  const rd = await seeded('killed')
  const child = spawn(process.execPath, ['m1-smoke.mjs', '--target', 'emulator', '--expected-head', H, '--run-dir', rd, '--mode', 'api'], { stdio: 'ignore' })
  await new Promise(resolve => {
    const timer = setInterval(() => {
      if (journal(rd).some(e => e.event === 'MUTATION_MAY_BE_SENT')) { clearInterval(timer); child.kill('SIGKILL'); resolve() }
    }, 50)
  })
  await new Promise(resolve => child.on('exit', resolve))
  await expectRefused('T6 killed mid-api -> refused', rd, verifiedNew(rd), 'G2 mode api never finished')
}
{
  const rd = await seeded('clean-path')
  await expectAllowed('T16 no failures + verified reviewed Rules -> cleanup allowed', rd, verifiedNew(rd))
}

// ── ACL guard stops seed before any Auth user is created ────────────────────
{
  const rd = path.join(BASE, `m1-emu-gate-acl-${Date.now()}`)
  if (smoke(rd, 'preflight').status !== 0) throw new Error('T17 preflight')
  const fx = fixture(rd)
  spawnSync('icacls', [rd, '/grant', '*S-1-5-32-545:(OI)(CI)R'], { stdio: 'ignore' })
  const r = smoke(rd, 'seed')
  const authCreateLogged = journal(rd).some(e => e.event === 'AUTH_CREATE_MAY_BE_SENT')
  const lookup = await (await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-finapp/accounts:lookup', { method: 'POST', headers: owner, body: JSON.stringify({ email: Object.values(fx.users).map(u => u.email) }) })).json()
  const usersFound = (lookup.users ?? []).length
  record('T17 foreign ACE on run dir -> seed STOP before Auth creation', r.status === 2 && /ACL not verified/.test(r.stderr) && !authCreateLogged && usersFound === 0, { exit: r.status, authCreateLogged, usersFound })
}

// ── Partial cleanup: STOP after deletes were sent -> exit 4, then read-only inventory ──
{
  const rd = await seeded('partial')
  const extra = verifiedNew(rd)
  // Deterministic fault: a test-only preload makes every Auth delete of THIS cleanup process fail
  // as a network error, i.e. after all document deletes were committed.
  const faulty = spawnSync(process.execPath, ['--require', path.resolve('tests', 'fault-auth-delete.cjs'), 'm1-smoke.mjs', '--target', 'emulator', '--expected-head', H, '--run-dir', rd, '--mode', 'cleanup', ...extra], { encoding: 'utf8' })
  const inv = smoke(rd, 'inventory')
  const files = fs.readdirSync(rd).filter(f => f.startsWith('inventory-'))
  const report = files.length ? JSON.parse(fs.readFileSync(path.join(rd, files[0]), 'utf8')) : null
  const stop = journal(rd).filter(e => e.event === 'MODE_STOP' && e.mode === 'cleanup').at(-1)
  record('T18 STOP after deletes sent -> exit 4; inventory records remainder read-only', faulty.status === 4 && stop?.kind === 'transport' && stop?.deletesMayHaveBeenSent === true && inv.status === 0 && report?.remainingDocumentCount === 0 && report?.authAccountsPresent.length === 3,
    { cleanupExit: faulty.status, stopKind: stop?.kind, inventoryExit: inv.status, remainingDocuments: report?.remainingDocumentCount, authAccountsRemaining: report?.authAccountsPresent.length })
}

// ── Indeterminate smoke outcomes: inspector fail-closed + real gate refusal ──
// The orchestrator answers an indeterminate outcome with one conservative rollback; when that
// rollback is not confirmed the real gate must refuse without deletes and leave a manifest.
{
  const rd = await seeded('indeterminate-kill')
  const child = spawn(process.execPath, ['m1-smoke.mjs', '--target', 'emulator', '--expected-head', H, '--run-dir', rd, '--mode', 'api'], { stdio: 'ignore' })
  await new Promise(resolve => {
    const timer = setInterval(() => {
      if (journalSafe(rd).some(e => e.event === 'MUTATION_MAY_BE_SENT')) { clearInterval(timer); child.kill('SIGKILL'); resolve() }
    }, 50)
  })
  await new Promise(resolve => child.on('exit', resolve))
  const out = path.join(rd, 'run-inspect-api.json')
  const ins = inspect(rd, 'api', out)
  const report = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null
  record('T19a api killed after MODE_START -> inspector exits 2 with classification indeterminate', ins.status === 2 && report?.classification === 'indeterminate' && report?.rulesFailure === false && report.problems.some(p => p.includes('api has no terminal event')),
    { exit: ins.status, classification: report?.classification, problems: report?.problems })
  await expectRefused('T19b indeterminate api + rollback deploy exit 1 -> cleanup refused, recovery manifest, no deletes', rd,
    ['--rules-status', 'rolled-back', '--rules-rollback-deploy-exit', '1', '--rules-evidence', evidence(rd, 'rb-verify', OLD)], 'rollback deploy exit is not 0')
}
{
  const rd = await seeded('journal-damage')
  fs.appendFileSync(path.join(rd, 'journal.jsonl'), '{"at":"2026-09-16T00:00:00.000Z","event":"MODE_ST\n')
  const out = path.join(rd, 'run-inspect-api.json')
  const ins = inspect(rd, 'api', out)
  const report = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null
  record('T20a damaged journal line -> inspector exits 2, journal not readable', ins.status === 2 && report?.classification === 'indeterminate' && report?.journalReadable === false && report.problems.some(p => p.includes('is not valid JSON')),
    { exit: ins.status, classification: report?.classification, problems: report?.problems })
  await expectRefused('T20b damaged journal -> cleanup gate cannot complete: refused, recovery manifest, no deletes', rd,
    ['--rules-status', 'rolled-back', '--rules-rollback-deploy-exit', '1', '--rules-evidence', evidence(rd, 'rb-verify', OLD)], 'G0 cleanup gate could not complete')
}

const failed = results.filter(r => !r.pass).length
console.log(`GATE_TESTS ${failed ? 'FAIL' : 'PASS'} ${results.length - failed}/${results.length}`)
process.exitCode = failed ? 1 : 0
