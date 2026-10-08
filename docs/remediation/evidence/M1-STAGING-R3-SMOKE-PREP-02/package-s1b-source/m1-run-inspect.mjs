#!/usr/bin/env node
// FINAPP-1.0-M1 R3 - fail-closed inspection of a smoke run journal for the orchestrator.
//
//   node m1-run-inspect.mjs --run-dir <abs> --mode <seed|ui|api|ui-r3> --out <new abs json>
//
// The orchestrator calls this after a smoke mode exited non-zero. The report never guesses:
//
//   confirmed-rules-failure      the journal is completely readable, the failed mode has a
//                                MODE_START, exactly one trusted terminal MODE_STOP, no other
//                                mode is unfinished or conflicting, and that terminal event
//                                reports an R1-R9 Rules probe;
//   confirmed-non-rules-failure  same trust conditions, terminal reason is not an R1-R4 probe;
//   indeterminate                anything else: unreadable or damaged journal, missing
//                                MODE_START, missing / duplicated / mismatched terminal event,
//                                an unfinished mode, or a terminal MODE_PASS for a mode that
//                                the orchestrator saw fail.
//
// R1-R9 is derived ONLY from the trusted terminal event of the failed mode, never from any
// other line. The exit code is 0 only for a confirmed classification and 2 for indeterminate
// or a usage error, so the caller may treat any non-zero exit as indeterminate without
// parsing the report. The run directory is never modified.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MODES = Object.freeze(['seed', 'ui', 'api', 'ui-r3'])
export const R_PROBE = /^R[1-9]\./
export const CONFIRMED = Object.freeze(['confirmed-rules-failure', 'confirmed-non-rules-failure'])

/** Pure classifier. `rawLines` are the journal lines as read from disk (null when the journal
 *  could not be read), `mode` is the smoke mode that exited non-zero. The result stays
 *  indeterminate unless every trust condition above holds. */
export function classifyJournal(rawLines, mode) {
  const problems = []
  const report = {
    mode: mode ?? null, classification: 'indeterminate', rulesFailure: false, indeterminate: true,
    journalReadable: false, journalLines: 0, parsedEvents: 0, trustedTerminal: null, seedStarted: false, problems,
  }
  if (!MODES.includes(mode)) { problems.push(`unknown mode ${String(mode)}`); return report }
  if (!Array.isArray(rawLines)) { problems.push('journal could not be read'); return report }

  const lines = rawLines.filter(l => typeof l === 'string' && l.length > 0)
  report.journalLines = lines.length
  const events = []
  for (let i = 0; i < lines.length; i++) {
    let e
    try { e = JSON.parse(lines[i]) } catch { problems.push(`journal line ${i + 1} is not valid JSON`); return report }
    if (e === null || typeof e !== 'object' || Array.isArray(e) || typeof e.event !== 'string') {
      problems.push(`journal line ${i + 1} is not an event object`)
      return report
    }
    events.push(e)
  }
  report.journalReadable = true
  report.parsedEvents = events.length
  report.seedStarted = events.some(e => e.event === 'MODE_START' && e.mode === 'seed')

  // Every mode must be a closed MODE_START ... MODE_PASS|MODE_STOP segment. An overlap, a
  // mismatched terminal event or an unfinished segment makes the whole journal untrustworthy.
  const segments = []
  let open = null
  for (const e of events) {
    if (e.event === 'MODE_START') {
      if (open) { problems.push(`mode ${open.mode} never finished before ${String(e.mode)} started`); return report }
      if (typeof e.mode !== 'string' || !e.mode) { problems.push('MODE_START without a mode'); return report }
      open = { mode: e.mode }
      continue
    }
    if (e.event !== 'MODE_PASS' && e.event !== 'MODE_STOP') continue
    if (!open) { problems.push(`${e.event} for ${String(e.mode)} without a MODE_START`); return report }
    if (e.mode !== open.mode) { problems.push(`${e.event} for ${String(e.mode)} while ${open.mode} was open`); return report }
    segments.push({ mode: open.mode, terminal: e })
    open = null
  }
  if (open) { problems.push(`mode ${open.mode} has no terminal event`); return report }

  if (!events.some(e => e.event === 'MODE_START' && e.mode === mode)) { problems.push(`no MODE_START for ${mode}`); return report }
  const mine = segments.filter(s => s.mode === mode)
  if (mine.length !== 1) { problems.push(`${mine.length} terminal events for ${mode}, exactly one is required`); return report }
  const terminal = mine[0].terminal
  if (terminal.event !== 'MODE_STOP') { problems.push(`${mode} ended with ${terminal.event}, not with a MODE_STOP`); return report }

  const reason = typeof terminal.reason === 'string' ? terminal.reason : ''
  report.trustedTerminal = {
    event: terminal.event, mode: terminal.mode, kind: typeof terminal.kind === 'string' ? terminal.kind : null,
    reason: reason.slice(0, 200), at: typeof terminal.at === 'string' ? terminal.at : null,
  }
  report.rulesFailure = R_PROBE.test(reason)
  report.classification = report.rulesFailure ? 'confirmed-rules-failure' : 'confirmed-non-rules-failure'
  report.indeterminate = false
  return report
}

/** Reads the journal of `runDir` read-only and classifies the failure of `mode`. */
export function inspectRun(runDir, mode) {
  const journal = path.join(runDir, 'journal.jsonl')
  let rawLines = null
  let readProblem = null
  try {
    rawLines = fs.readFileSync(journal, 'utf8').split('\n')
  } catch (e) {
    readProblem = fs.existsSync(journal) ? `journal unreadable: ${e.code ?? e.message}` : 'journal file missing'
  }
  const report = classifyJournal(rawLines, mode)
  if (readProblem) report.problems.unshift(readProblem)
  report.runDirExists = fs.existsSync(runDir)
  report.journalExists = fs.existsSync(journal)
  if (!report.runDirExists || !report.journalExists) {
    report.classification = 'indeterminate'
    report.indeterminate = true
    report.rulesFailure = false
  }
  return report
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
if (isMain) {
  const args = process.argv.slice(2)
  const o = {}
  for (let i = 0; i < args.length; i += 2) o[args[i]] = args[i + 1]
  try {
    if (args.length !== 6 || !path.isAbsolute(o['--run-dir'] ?? '') || !MODES.includes(o['--mode']) || !path.isAbsolute(o['--out'] ?? '') || fs.existsSync(o['--out'])) {
      throw new Error('usage: --run-dir <abs> --mode <seed|ui|api|ui-r3> --out <new abs json>')
    }
    const report = inspectRun(o['--run-dir'], o['--mode'])
    fs.writeFileSync(o['--out'], `${JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' })
    console.log(`M1_RUN_INSPECTED mode=${report.mode} classification=${report.classification} rulesFailure=${report.rulesFailure} problems=${report.problems.length}`)
    process.exitCode = CONFIRMED.includes(report.classification) ? 0 : 2
  } catch (e) {
    console.log(`M1_RUN_INSPECT_STOP ${e.message}`)
    process.exitCode = 2
  }
}
