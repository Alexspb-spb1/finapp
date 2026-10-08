// M1-SAFE-STOP-RECOVERY-01 - emulator integration of the seed STOP -> cleanup recovery path with SYNTHETIC data only (demo-finapp, loopback).
// Requires the Auth and Firestore emulators (auth 9099, firestore 8080) and the firestore.rules the other emulator suites load.
//   node tests/seed-stop-recovery-emulator.mjs                                          (this package)
//   M1_PKG_UNDER_TEST=<other package dir> node tests/seed-stop-recovery-emulator.mjs     (the OLD package: scenario 1 must show the defect there)
// Each scenario runs the REAL m1-smoke.mjs (preflight, seed, cleanup, verify-clean, inventory) as separate processes; a fault-injection preload
// (--require, test only) makes the FIRST Auth account creation fail the way the consumed staging run failed. Nothing here reaches a cloud.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = process.env.M1_PKG_UNDER_TEST ? path.resolve(process.env.M1_PKG_UNDER_TEST) : path.resolve(HERE, '..')
const H = '714d0f91c60a582ee87dc7da82d6249b3106329f'
const NEW_RULES = 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd'
const BASE = path.join('D:\\projects\\finapp\\.runtime', `m1-r4-recovery-test-${Date.now()}`)
fs.mkdirSync(BASE)
const results = []
const record = (name, pass, detail) => { results.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); if (!pass && detail !== undefined) console.log('     detail: ' + JSON.stringify(detail).slice(0, 600)) }

// Loopback calls to the EMULATORS only, one connection per call (the emulators close idle keep-alive sockets, a pooled one would be reset).
const emulatorCall = (port, method, urlPath, body) => new Promise((resolve, reject) => {
  const headers = { authorization: 'Bearer owner', connection: 'close', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) }
  const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, res => { let t = ''; res.on('data', d => { t += d }); res.on('end', () => resolve({ status: res.statusCode, text: t })) })
  req.on('error', reject)
  req.end(body)
})
async function clearEmulators() {
  await emulatorCall(9099, 'DELETE', '/emulator/v1/projects/demo-finapp/accounts')
  await emulatorCall(8080, 'DELETE', '/emulator/v1/projects/demo-finapp/databases/(default)/documents')
}
const emulatorAccounts = async () => {
  const r = await emulatorCall(9099, 'POST', '/identitytoolkit.googleapis.com/v1/projects/demo-finapp/accounts:query', JSON.stringify({ returnSecureToken: false }))
  const j = JSON.parse(r.text)
  return Array.isArray(j.userInfo) ? j.userInfo.length : 0
}

function smoke(runDir, mode, extra = [], preload) {
  const args = [...(preload ? ['--require', path.join(HERE, preload)] : []), path.join(PKG, 'm1-smoke.mjs'), '--target', 'emulator', '--expected-head', H, '--run-dir', runDir, '--mode', mode, ...extra]
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000 })
  const journalFile = path.join(runDir, 'journal.jsonl')
  const journal = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const stops = journal.filter(e => e.event === 'MODE_STOP')
  return { status: r.status, out: r.stdout + r.stderr, journal, lastStop: stops.at(-1) }
}
function scenario(name) {
  const dir = path.join(BASE, name)
  fs.mkdirSync(dir)
  const evidence = path.join(dir, 'rules-evidence.jsonl')
  const now = new Date().toISOString()
  fs.writeFileSync(evidence, `${JSON.stringify({ task: 'SEC-006 Stage 8', mode: 'verify-current-rules', project: 'finapp-staging', sourceHead: H, startedAt: now, canonicalSha256: NEW_RULES, status: 'CURRENT_RULES_HASH_VERIFIED', finishedAt: now })}\n`)
  return { runDir: path.join(dir, 'run'), evidence, cleanupArgs: ['--rules-status', 'verified-new', '--rules-evidence', evidence] }
}

try {
  // ── scenario 1: the consumed run - the first Auth create fails in the CONNECT phase (nothing was sent) ─────────────────────────────────
  await clearEmulators()
  const s1 = scenario('s1-connect-timeout')
  const pre1 = smoke(s1.runDir, 'preflight')
  const seed1 = smoke(s1.runDir, 'seed', [], 'fault-auth-create-connect-timeout.cjs')
  const intent1 = seed1.journal.findIndex(e => e.event === 'AUTH_CREATE_MAY_BE_SENT' && e.key === 'admin')
  const after1 = seed1.journal.slice(intent1 + 1)
  record('s1 seed: the first Auth create fails in the connect phase -> exit 2, kind transport-not-dispatched (the old runner: kind transport)', pre1.status === 0 && seed1.status === 2 && seed1.lastStop?.kind === 'transport-not-dispatched' && seed1.lastStop?.reasonCode === 'connect-timeout' && seed1.lastStop?.dispatch === 'not-dispatched', { preflight: pre1.status, seed: seed1.status, stop: seed1.lastStop && { kind: seed1.lastStop.kind, reasonCode: seed1.lastStop.reasonCode, dispatch: seed1.lastStop.dispatch, elapsedMs: seed1.lastStop.elapsedMs } })
  record('s1 seed: intent-before-dispatch is kept (AUTH_CREATE_MAY_BE_SENT precedes the failure) and the proven non-dispatch is journaled for the same key before MODE_STOP', intent1 >= 0 && after1.some(e => e.event === 'AUTH_CREATE_NOT_DISPATCHED' && e.key === 'admin' && e.reasonCode === 'connect-timeout') && after1.findIndex(e => e.event === 'AUTH_CREATE_NOT_DISPATCHED') < after1.findIndex(e => e.event === 'MODE_STOP'))
  record('s1 seed: no second create (no retry): only one create intent, no company/commit intents, 0 acknowledged creates, 0 operator commits', seed1.journal.filter(e => e.event === 'AUTH_CREATE_MAY_BE_SENT').length === 1 && !seed1.journal.some(e => /CREATE_COMPANY|SEED_COMMIT/.test(e.event)) && seed1.lastStop?.counters?.authCreates === 0 && seed1.lastStop?.counters?.operatorCommits === 0)
  const accounts1 = await emulatorAccounts()
  const clean1 = smoke(s1.runDir, 'cleanup', s1.cleanupArgs)
  const verify1 = clean1.status === 0 ? smoke(s1.runDir, 'verify-clean') : { status: null }
  record('s1 RECOVERY: cleanup after a proven pre-dispatch stop completes (exit 0, zero deletes) and verify-clean passes - the OLD runner refuses (exit 3, G2/G3)', accounts1 === 0 && clean1.status === 0 && verify1.status === 0 && clean1.journal.some(e => e.event === 'CLEANUP_OK' && e.documentsDeleted === 0 && e.authUsersDeleted === 0), { accounts: accounts1, cleanup: clean1.status, verifyClean: verify1.status, failures: clean1.journal.filter(e => e.event === 'CLEANUP_REFUSED' || (e.event === 'MODE_STOP' && e.mode === 'cleanup')).map(e => e.reason ?? e.failures).slice(0, 2) })

  // ── scenario 2: the request WAS delivered (the account exists) and the connection died afterwards ─────────────────────────────────────
  await clearEmulators()
  const s2 = scenario('s2-reset-after-send')
  smoke(s2.runDir, 'preflight')
  const seed2 = smoke(s2.runDir, 'seed', [], 'fault-auth-create-reset-after-send.cjs')
  const accounts2 = await emulatorAccounts()
  record('s2 seed: a failure AFTER the request reached the provider (account created, answer lost) is NOT pre-dispatch: kind transport, dispatch unknown, no NOT_DISPATCHED event', seed2.status === 2 && seed2.lastStop?.kind === 'transport' && seed2.lastStop?.dispatch === 'unknown' && !seed2.journal.some(e => e.event === 'AUTH_CREATE_NOT_DISPATCHED') && accounts2 === 1, { seed: seed2.status, stop: seed2.lastStop && { kind: seed2.lastStop.kind, reasonCode: seed2.lastStop.reasonCode, dispatch: seed2.lastStop.dispatch }, accounts: accounts2 })
  const clean2 = smoke(s2.runDir, 'cleanup', s2.cleanupArgs)
  record('s2 FAIL-CLOSED: cleanup REFUSES (exit 3, no deletes) - the possibly created account has no recorded uid; it is still there afterwards', clean2.status === 3 && clean2.lastStop?.kind === 'cleanup-refused' && clean2.lastStop?.deletesMayHaveBeenSent === false && (await emulatorAccounts()) === 1 && /G2|G3/.test(clean2.lastStop?.reason ?? ''), { cleanup: clean2.status, reason: clean2.lastStop?.reason })

  // ── scenario 3: a LYING classification (pre-dispatch claimed, but the account was created) is still caught by the live lookup of cleanup ─────
  await clearEmulators()
  const s3 = scenario('s3-misclassified')
  smoke(s3.runDir, 'preflight')
  const seed3 = smoke(s3.runDir, 'seed', [], 'fault-auth-create-sent-but-connect-timeout.cjs')
  const accounts3 = await emulatorAccounts()
  const clean3 = smoke(s3.runDir, 'cleanup', s3.cleanupArgs)
  record('s3 BACKSTOP: even if a stop WAS wrongly classified as pre-dispatch, cleanup looks the exact synthetic subject up and REFUSES (G4) while the account exists - no deletes', seed3.lastStop?.kind === 'transport-not-dispatched' && accounts3 === 1 && clean3.status === 3 && /G4/.test(clean3.lastStop?.reason ?? '') && (await emulatorAccounts()) === 1, { seed: seed3.lastStop?.kind, accounts: accounts3, cleanup: clean3.status, reason: clean3.lastStop?.reason })

  // ── scenario 4: other stop kinds keep refusing (unchanged gates) ───────────────────────────────────────────────────────────────────────
  await clearEmulators()
  const s4 = scenario('s4-unexpected-stop-kind')
  smoke(s4.runDir, 'preflight')
  const seed4 = smoke(s4.runDir, 'seed', [], 'fault-auth-create-timeout-abort.cjs')
  const clean4 = smoke(s4.runDir, 'cleanup', s4.cleanupArgs)
  record('s4 an abort timeout (outcome unknown) keeps the old behaviour: kind transport, dispatch unknown, cleanup REFUSES (exit 3)', seed4.lastStop?.kind === 'transport' && seed4.lastStop?.reasonCode === 'abort-timeout' && seed4.lastStop?.dispatch === 'unknown' && clean4.status === 3, { seed: seed4.lastStop?.kind, code: seed4.lastStop?.reasonCode, cleanup: clean4.status })

  // ── scenarios 5-8: the proof is checked by the cleanup gate itself (a damaged or forged journal cannot unlock cleanup) ────────────────────
  const tamper = (runDir, fn) => { const f = path.join(runDir, 'journal.jsonl'); fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))).map(e => JSON.stringify(e)).join('\n') + '\n') }
  const forged = async (name, change) => {
    await clearEmulators()
    const s = scenario(name)
    smoke(s.runDir, 'preflight')
    smoke(s.runDir, 'seed', [], 'fault-auth-create-connect-timeout.cjs')
    tamper(s.runDir, change)
    const c = smoke(s.runDir, 'cleanup', s.cleanupArgs)
    return { status: c.status, reason: c.lastStop?.reason ?? '', accounts: await emulatorAccounts() }
  }
  const noProof = await forged('s5-proof-missing', events => events.filter(e => e.event !== 'AUTH_CREATE_NOT_DISPATCHED'))
  record('s5 the proof event is missing from the journal -> cleanup REFUSES (G3): a stop kind alone does not resolve a possibly sent creation', noProof.status === 3 && /G3/.test(noProof.reason), noProof)
  const badCode = await forged('s6-proof-code-not-connect-phase', events => events.map(e => (e.event === 'AUTH_CREATE_NOT_DISPATCHED' ? { ...e, reasonCode: 'connection-reset' } : e)))
  record('s6 the proof event carries a reason code outside the connect-phase set -> cleanup REFUSES (G3)', badCode.status === 3 && /G3/.test(badCode.reason), badCode)
  const wrongKind = await forged('s7-stop-kind-plain-transport', events => events.map(e => (e.event === 'MODE_STOP' && e.mode === 'seed' ? { ...e, kind: 'transport' } : e)))
  record('s7 the seed MODE_STOP is a plain transport stop (outcome unknown) even though a proof event exists -> cleanup REFUSES (G2)', wrongKind.status === 3 && /G2/.test(wrongKind.reason), wrongKind)
  const noDispatchField = await forged('s8-stop-without-dispatch-proof', events => events.map(e => (e.event === 'MODE_STOP' && e.mode === 'seed' ? { ...e, dispatch: 'unknown' } : e)))
  record('s8 a transport-not-dispatched stop whose dispatch field is not "not-dispatched" -> cleanup REFUSES (G2: without proof)', noDispatchField.status === 3 && /G2.*without proof/.test(noDispatchField.reason), noDispatchField)
  const gapProof = await forged('s9-proof-not-adjacent', events => { const i = events.findIndex(e => e.event === 'AUTH_CREATE_NOT_DISPATCHED'); const copy = events.slice(); const [proof] = copy.splice(i, 1); copy.splice(i + 1, 0, proof); return copy })
  record('s9 the proof event is not the event directly after the intent (something lies between them) -> cleanup REFUSES (G3)', gapProof.status === 3 && /G3/.test(gapProof.reason), gapProof)
} finally {
  await clearEmulators().catch(() => {})
}

const failed = results.filter(r => !r.pass).length
const out = path.join(HERE, '..', 'results')
if (!process.env.M1_PKG_UNDER_TEST) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'seed-stop-recovery-emulator.json'), `${JSON.stringify({ total: results.length, failed, results, at: new Date().toISOString() }, null, 2)}\n`) }
console.log(`SEED_STOP_RECOVERY_EMULATOR ${failed ? 'FAIL' : 'PASS'} ${results.length - failed}/${results.length}${process.env.M1_PKG_UNDER_TEST ? ` (package under test: ${PKG})` : ''}`)
process.exitCode = failed ? 1 : 0
