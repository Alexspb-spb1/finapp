// M1-SAFE-STOP-RECOVERY-01 - controlled mutations of the fix. Each mutant is a COPY of the package with one deliberate defect (the original is never edited);
// "detected" = the relevant test file of the copy fails. The emulator scenarios need the Auth and Firestore emulators (demo project) on 9099/8080.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MUT = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-mut-recovery-'))
const results = []
function mutant(name, file, from, to, suites) {
  const dir = path.join(MUT, String(results.length + 1))
  fs.cpSync(PKG, dir, { recursive: true, filter: s => !s.includes(`${path.sep}results`) })
  const f = path.join(dir, file)
  const text = fs.readFileSync(f, 'utf8')
  if (!text.includes(from)) throw new Error(`anchor not found in ${file}: ${from.slice(0, 70)}`)
  fs.writeFileSync(f, text.replace(from, () => to))
  const failed = []
  for (const suite of suites) {
    const r = spawnSync(process.execPath, [path.join(dir, 'tests', suite)], { encoding: 'utf8', cwd: dir, timeout: 20 * 60 * 1000 })
    failed.push(...(r.stdout.match(/^FAIL .*$/gm) ?? []).map(l => l.slice(0, 110)))
    if (r.status !== 0 && !(r.stdout.match(/^FAIL .*$/gm) ?? []).length) failed.push(`${suite} exited ${r.status}`)
    if (failed.length) break
  }
  const detected = failed.length > 0
  results.push({ mutation: name, detected, failed: failed.slice(0, 3) })
  console.log(`${detected ? 'DETECTED' : 'NOT DETECTED'} ${name} ${JSON.stringify(failed.slice(0, 2))}`)
}
const C = ['transport-classification-tests.mjs'], E = ['seed-stop-recovery-emulator.mjs'], CE = [...C, ...E]
const T = 'm1-transport.mjs', S = 'm1-smoke.mjs', K = 'm1-core.mjs'

mutant('R1 ECONNRESET is reported as a connect-phase failure (a delivered request would count as not dispatched)', T, "if (node?.code === 'ECONNRESET') return { reasonCode: 'connection-reset', dispatch: 'unknown' }", "if (node?.code === 'ECONNRESET') return { reasonCode: 'connect-timeout', dispatch: 'not-dispatched' }", C)
mutant('R2 the connect() syscall is no longer required for errno codes (ETIMEDOUT/ECONNREFUSED of a read count as connect-phase)', T, "CONNECT_PHASE_CODES.has(e.code) && e.syscall === 'connect'", 'CONNECT_PHASE_CODES.has(e.code)', C)
mutant('R3 the runner\'s own abort timeout is reported as a connect-phase failure', T, "if (top?.name === 'TimeoutError') return { reasonCode: 'abort-timeout', dispatch: 'unknown' }", "if (top?.name === 'TimeoutError') return { reasonCode: 'connect-timeout', dispatch: 'not-dispatched' }", C)
mutant('R4 an AggregateError is pre-dispatch when SOME attempt failed in connect()', T, 'codes.every(Boolean)', 'codes.some(Boolean)', C)
mutant('R5 every transport failure is classified transport-not-dispatched', T, "dispatch === 'not-dispatched' ? 'transport-not-dispatched' : 'transport'", "'transport-not-dispatched'", C)
mutant('R6 the STOP reason carries the raw text of the underlying error', T, "`network failure ${method} ${new URL(url).pathname.split('/').slice(-1)[0]}`", "`network failure ${method} ${new URL(url).pathname.split('/').slice(-1)[0]} ${String(error?.message)}`", C)
mutant('R7 a second request (retry/probe) is added next to the fetch', T, 'res = await fetch(url, {', "try { await fetch(url, { method: 'HEAD' }) } catch { /* probe */ }\n      res = await fetch(url, {", C)
mutant('R8 the elapsed time of the failed request is no longer recorded', T, 'elapsedMs: Date.now() - startedAt', 'elapsedMs: undefined', C)
mutant('R9 the TLS verification codes are dropped from the connect-phase set but unknown codes are accepted', T, "if (typeof e.code === 'string' && TLS_VERIFY_CODES.has(e.code)) return 'tls-verify'", "if (typeof e.code === 'string') return 'tls-verify'", C)
mutant('R10 the cleanup gate G3 never reports a creation without recorded identifier', S, "!provenNotDispatched(i, 'AUTH_CREATE_NOT_DISPATCHED', 'key', e.key)", 'false', E)
mutant('R11 the proof event may be anywhere after the intent (not necessarily the very next event)', S, "events[i + 1]?.event === event && events[i + 1][field] === value && PRE_DISPATCH_REASON_CODES.includes(events[i + 1].reasonCode)", "events.slice(i + 1).some(x => x.event === event && x[field] === value && PRE_DISPATCH_REASON_CODES.includes(x.reasonCode))", E)
mutant('R12 the proof event reason code is not checked against the connect-phase set', S, ' && PRE_DISPATCH_REASON_CODES.includes(events[i + 1].reasonCode)', '', E)
mutant('R13 a plain transport stop (unknown outcome) counts as a safe cleanup stop kind', K, "['assertion', 'ui-flow', 'transport-not-dispatched']", "['assertion', 'ui-flow', 'transport-not-dispatched', 'transport']", E)
mutant('R14 the G2 proof fields of a transport-not-dispatched stop are not verified', S, "if (e.event === 'MODE_STOP' && e.kind === 'transport-not-dispatched' && (e.dispatch !== 'not-dispatched' || !PRE_DISPATCH_REASON_CODES.includes(e.reasonCode))) failures.push(", 'if (false) failures.push(', E)
mutant('R15 the proof event is journaled for every transport stop, also when the outcome is unknown', S, "if (error instanceof Stop && error.dispatch === 'not-dispatched' && PRE_DISPATCH_REASON_CODES.includes(error.reasonCode)) log.append(", "if (error instanceof Stop && error.dispatch !== undefined) log.append(", E)
mutant('R16 the live exact-subject lookup no longer refuses an account that is not in the manifest (the backstop of a wrong classification)', S, "failures.push('G4 auth account does not match manifest')", 'void 0', E)
mutant('R17 the seed journals no proof after a connect-phase failure (the recovery path is dead)', S, "try { u.uid = await t.createAuthUser(u) } catch (error) { journalNotDispatched(log, 'AUTH_CREATE_NOT_DISPATCHED', { key: u.key }, error); throw error }", 'u.uid = await t.createAuthUser(u)', E)

fs.rmSync(MUT, { recursive: true, force: true })
const undetected = results.filter(r => !r.detected).length
fs.mkdirSync(path.join(PKG, 'results'), { recursive: true })
fs.writeFileSync(path.join(PKG, 'results', 'mutation-checks-recovery.json'), `${JSON.stringify({ total: results.length, undetected, results, at: new Date().toISOString() }, null, 2)}\n`)
console.log(`RECOVERY_MUTATION_CHECKS ${undetected ? 'FAIL' : 'PASS'} detected=${results.length - undetected}/${results.length}`)
process.exitCode = undetected ? 1 : 0
