#!/usr/bin/env node
// FINAPP-1.0-M1 R3 - local, network-free checks against expected-state-r3.json.
//
//   node m1-state-check.mjs --mode provenance --expected <abs> --evidence-root <abs dir> --run-root <abs dir> --out <new abs json>
//   node m1-state-check.mjs --mode functions  --expected <abs> --evidence <abs json>  --out <new abs json>
//   node m1-state-check.mjs --mode rules      --expected <abs> --evidence <abs jsonl> --canonical <sha256> --out <new abs json>
//   node m1-state-check.mjs --mode local-rules --expected <abs> --repo <abs release clone> --out <new abs json>
//
// local-rules: the clone's firestore.rules is exactly the pinned round-3 target and the round-2 reference shipped in
//             the package is the pinned file whose CRLF form equals the pinned live pre-release bytes.

// provenance: every pinned rev8 evidence file is unchanged and the pinned functions and pre-release Rules
//             agree with what rev8 last observed on staging; rev8 left no synthetic data (files are only READ).
// functions:  a written live-state report equals the pinned 13 functions exactly (independent of
//             the live tool that produced it).
// rules:      a verify-current-rules journal equals the pinned pre-release Rules (ruleset, raw hash, size)
//             when --canonical is the pre hash, or the pinned target Rules (raw hash, size, NEW ruleset)
//             when --canonical is the target hash.
// Exit 0 = OK, 2 = BLOCKED. The report lists problems only; it never echoes evidence contents.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareFunctions, localRulesProblems, validateExpected, verifyProvenance, verifyRulesEvidence } from './m1-state-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const abs = v => typeof v === 'string' && path.isAbsolute(v)
const readRel = (evidenceRoot, runRoot) => (root, rel) => {
  const base = root === 'evidence' ? evidenceRoot : root === 'run' ? runRoot : null
  if (!base || rel.includes('..')) return null
  const file = path.join(base, ...rel.split('/'))
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
if (isMain) {
  const argv = process.argv.slice(2)
  const o = {}
  let mode = null
  let problems = []
  try {
    if (argv.length % 2) throw new Error('usage')
    for (let i = 0; i < argv.length; i += 2) { if (Object.hasOwn(o, argv[i])) throw new Error('usage'); o[argv[i]] = argv[i + 1] }
    mode = o['--mode']
    const allowed = { provenance: ['--mode', '--expected', '--evidence-root', '--run-root', '--out'], functions: ['--mode', '--expected', '--evidence', '--out'], rules: ['--mode', '--expected', '--evidence', '--canonical', '--out'], 'local-rules': ['--mode', '--expected', '--repo', '--out'] }[mode]
    if (!allowed || Object.keys(o).length !== allowed.length || !allowed.every(k => Object.hasOwn(o, k))) throw new Error('usage')
    if (![o['--expected'], o['--out']].every(abs) || fs.existsSync(o['--out']) || !fs.existsSync(o['--expected'])) throw new Error('paths')
    const expected = JSON.parse(fs.readFileSync(o['--expected'], 'utf8'))
    const structural = validateExpected(expected)
    if (structural.length) problems = structural
    else if (mode === 'provenance') {
      if (![o['--evidence-root'], o['--run-root']].every(p => abs(p) && fs.existsSync(p))) throw new Error('paths')
      problems = verifyProvenance(expected, readRel(o['--evidence-root'], o['--run-root']))
    } else if (mode === 'functions') {
      if (!abs(o['--evidence']) || !fs.existsSync(o['--evidence'])) throw new Error('paths')
      const report = JSON.parse(fs.readFileSync(o['--evidence'], 'utf8'))
      if (report.project !== expected.project || report.sourceHead !== expected.sourceHead || report.status !== 'M1_FUNCTIONS_EXACT_STATE_VERIFIED') problems.push('functions report project/head/status')
      problems.push(...compareFunctions(report.functions, expected))
    } else if (mode === 'local-rules') {
      if (!abs(o['--repo']) || !fs.existsSync(path.join(o['--repo'], 'firestore.rules'))) throw new Error('paths')
      problems = localRulesProblems(expected, fs.readFileSync(path.join(o['--repo'], 'firestore.rules')), fs.readFileSync(path.join(HERE, ...expected.rollback.blobFile.split('/'))))
    } else {
      if (!abs(o['--evidence']) || !fs.existsSync(o['--evidence']) || !/^[0-9a-f]{64}$/.test(o['--canonical'])) throw new Error('paths')
      problems = verifyRulesEvidence(fs.readFileSync(o['--evidence'], 'utf8'), expected, o['--canonical'])
    }
  } catch (e) {
    problems = [`check could not run: ${String(e?.message ?? 'error').slice(0, 60)}`]
  }
  const status = problems.length ? 'BLOCKED' : 'OK'
  try { if (abs(o['--out']) && !fs.existsSync(o['--out'])) fs.writeFileSync(o['--out'], `${JSON.stringify({ mode, status, problems, at: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' }) } catch { /* the exit code still reports the result */ }
  console.log(`M1_STATE_CHECK_${String(mode).toUpperCase()}_${status}${problems.length ? ` problems=${problems.length}: ${problems.slice(0, 3).join('; ')}` : ''}`)
  process.exitCode = problems.length ? 2 : 0
}
