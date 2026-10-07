// Controlled mutations of the v5 export polling (same method as mutation-checks.mjs: a COPY of the package with one deliberate defect; detected = the
// export polling tests of the copy fail). The originals are never edited.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MUT = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-mut-export-'))
const results = []
function mutant(name, from, to) {
  const dir = path.join(MUT, String(results.length + 1))
  fs.cpSync(PKG, dir, { recursive: true, filter: s => !s.includes(`${path.sep}results`) })
  const f = path.join(dir, 'm1-export.mjs')
  const text = fs.readFileSync(f, 'utf8')
  const pairs = Array.isArray(from) ? from : [[from, to]]
  let mutated = text
  for (const [a, b] of pairs) { if (!mutated.includes(a)) throw new Error(`anchor not found: ${a.slice(0, 60)}`); mutated = mutated.replace(a, () => b) }
  fs.writeFileSync(f, mutated)
  const r = spawnSync(process.execPath, [path.join(dir, 'tests', 'export-poll-tests.mjs')], { encoding: 'utf8', cwd: dir, timeout: 10 * 60 * 1000 })
  const failed = (r.stdout.match(/^FAIL .*$/gm) ?? []).map(l => l.slice(0, 110))
  const detected = r.status !== 0
  results.push({ mutation: name, detected, failed: failed.slice(0, 3) })
  console.log(`${detected ? 'DETECTED' : 'NOT DETECTED'} ${name} ${JSON.stringify(failed.slice(0, 2))}`)
}
function mutantOrch(name, from, to) {
  const dir = path.join(MUT, String(results.length + 1))
  fs.cpSync(PKG, dir, { recursive: true, filter: s => !s.includes(`${path.sep}results`) })
  const f = path.join(dir, 'm1-orchestrator.ps1')
  const text = fs.readFileSync(f, 'utf8')
  if (!text.includes(from)) throw new Error(`anchor not found: ${from.slice(0, 60)}`)
  fs.writeFileSync(f, text.replace(from, () => to))
  const r = spawnSync(process.execPath, [path.join(dir, 'tests', 'export-poll-tests.mjs')], { encoding: 'utf8', cwd: dir, timeout: 10 * 60 * 1000 })
  const failed = (r.stdout.match(/^FAIL .*$/gm) ?? []).map(l => l.slice(0, 110))
  const detected = r.status !== 0
  results.push({ mutation: name, detected, failed: failed.slice(0, 3) })
  console.log(`${detected ? 'DETECTED' : 'NOT DETECTED'} ${name} ${JSON.stringify(failed.slice(0, 2))}`)
}
mutant('E1 PROCESSING is no longer polled (treated as an unknown state: the first-answer failure of the staging run returns)', "if (state === 'INITIALIZING' || state === 'PROCESSING') return { state: 'RUNNING', problems: [] }", "if (state === 'INITIALIZING' || state === 'PROCESSING') return { state: 'UNKNOWN', problems: ['x'] }")
mutant('E2 a foreign output prefix is no longer detected', "if (outs.some(o => !prefixOk(o, prefix))) return", "if (false) return")
mutant('E3 the timeout is reported as SUCCESS', "if (now() + intervalMs > deadline) return expired(polls)", "if (now() + intervalMs > deadline) return { outcome: 'SUCCESS', problems: [], polls, operation: op, name: firstOp.name }")
mutant('E4 describe failures are not counted (endless retries until the deadline)', "if (failures >= 3) return", "if (failures >= 100000) return")
mutant('E5 the operation name of the describe answer is not compared', "if (parsed.op.name !== firstOp.name) return", "if (false) return")
mutant('E6 the independent listing is no longer required', "if (listProblems.length) finish('STOP'", "if (false) finish('STOP'")
mutant('E7 CANCELLED/CANCELLING are polled as if running', "['FAILED', 'CANCELLED', 'CANCELLING'].includes(state)", "['FAILED'].includes(state)")
mutant('E8 a done SUCCESSFUL operation without any output prefix is accepted', "if (!outs.length) return { state: 'UNKNOWN', problems: ['outputUriPrefix is not the requested prefix'] }", "")
mutant('E9 gcloud arguments are no longer restricted to the safe character set (id injection)', "if (args.some(a => !/^[A-Za-z0-9:/._=-]+$/.test(a))) throw", "if (false) throw")
mutant('E10 an operation of another project/database/shape is accepted (the name is not matched)', "const m = typeof op?.name === 'string' ? op.name.match(operationNamePattern(project)) : null", "const m = typeof op?.name === 'string' ? [op.name, op.name.split('/').pop()] : null")
mutant('E11 an unreadable first export answer is treated as success (parse problems ignored)', "const waited = parsed.problems ? { outcome: 'UNCERTAIN', problems: parsed.problems, polls: 0 } :", "const waited = parsed.problems ? { outcome: 'SUCCESS', problems: [], polls: 0, operation: { metadata: { operationState: 'SUCCESSFUL', startTime: new Date().toISOString() } }, name: 'x' } :")
mutant('E12 the polling uses another interval than 10 s in the staging profile', "export const POLL_INTERVAL_MS = 10 * 1000", "export const POLL_INTERVAL_MS = 1 * 1000")

mutant('E13 neither deadline check guards a slow describe (the auditor case: SUCCESSFUL after 1 810 001 ms is accepted)', [["    onPoll(polls, d)\n    if (now() > deadline) return expired(polls)\n","    onPoll(polls, d)\n"],["    if (now() > deadline) return expired(polls)\n    const v = classifyOperation(op, prefix)","    const v = classifyOperation(op, prefix)"]], '')
mutant("E14 the describe call gets no time limit (the 20 minute default of the export call)", "const d = await describe(id, Math.min(remaining, DESCRIBE_TIMEOUT_MS))", "const d = await describe(id)")
mutant("E15 the deadline counts from the first answer, not from the export request", "const deadline = startedAt + deadlineMs", "const deadline = now() + deadlineMs")
mutant("E16 the deadline is not checked before the first answer is judged (a late SUCCESSFUL first answer is accepted)", "    if (now() > deadline) return expired(polls)\n    const v = classifyOperation(op, prefix)", "    const v = classifyOperation(op, prefix)")
mutant("E17 the operation start time is not validated (an old operation is accepted)", "if (timeProblems.length) finish('UNCERTAIN'", "if (false) finish('UNCERTAIN'")
mutant("E18 the freshness anchor is the time of writing, not the operation/request start", "freshnessAnchor: freshnessAnchor(requestStartedAt, Date.parse(meta.startTime)) }", "freshnessAnchor: new Date().toISOString() }")
mutant("E19 an operation that started before the request is believable", "if (t < requestStartedAt - skewMs) return", "if (false) return")
mutantOrch('E20 the orchestrator counts the export age from finishedAt again', "Parse($State.export.freshnessAnchor", "Parse($State.export.finishedAt")

fs.rmSync(MUT, { recursive: true, force: true })
const undetected = results.filter(r => !r.detected).length
fs.mkdirSync(path.join(PKG, 'results'), { recursive: true })
fs.writeFileSync(path.join(PKG, 'results', 'mutation-checks-export.json'), `${JSON.stringify({ total: results.length, undetected, results, at: new Date().toISOString() }, null, 2)}\n`)
console.log(`EXPORT_MUTATION_CHECKS ${undetected ? 'FAIL' : 'PASS'} detected=${results.length - undetected}/${results.length}`)
process.exitCode = undetected ? 1 : 0
