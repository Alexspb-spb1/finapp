// Local no-network stand-ins for the two LIVE read tools of the S1b flow, with their CLI contracts:
//   functionsCheck   (m1-functions-check.mjs --mode exact)
//   stagingResources (scripts/invitationRehearsal/stagingResources.mjs --mode verify-current-rules)
// Used only by the rehearsal profile (node --require stubs/no-network.cjs). Output shapes match what the downstream state checks read.
// Scenario file (M1_STUB_SCENARIO): { "reads": { "functions": ok|fail|drift-baseline|drift-m1|missing|extra|caps,
//                                                 "rules": r3|r2|unknown|raw-drift|bytes-drift|same-ruleset|fail-read } }
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPreloaded, scenario, claim, refuse, sameArgs, writeNew, H, RULES_PRE, RULES_TARGET, NEW_RULESET } from './stub-lib.mjs'

assertPreloaded()
const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXPECTED = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'expected-state-r3.json'), 'utf8'))
const [tool, ...args] = process.argv.slice(2)
const reads = scenario().reads ?? {}
const argAt = name => args[args.indexOf(name) + 1]
const now = () => new Date().toISOString()
const journalLine = (mode, extra) => `${JSON.stringify({ task: 'SEC-006 Stage 8', mode, project: 'finapp-staging', sourceHead: H, startedAt: now(), ...extra, finishedAt: now() })}\n`
const fnRecord = f => ({ id: f.id, state: 'ACTIVE', runtime: 'nodejs22', resources: { ...EXPECTED.caps }, revision: f.revision, build: f.build, sourceReferenceSha256: f.sourceReferenceSha256 })
const UNKNOWN_HASH = '0'.repeat(64)

if (tool === 'functionsCheck') {
  const out = argAt('--out'), expectedFile = argAt('--expected')
  if (!sameArgs(args, ['--mode', 'exact', '--expected-head', H, '--expected', expectedFile, '--out', out]) || path.basename(expectedFile ?? '') !== 'expected-state-r3.json') refuse(`functionsCheck arguments: ${JSON.stringify(args)}`)
  claim(`functionsCheck-${path.basename(out)}`, 1)
  const mode = reads.functions ?? 'ok'
  if (mode === 'fail') { console.error('M1_FUNCTIONS_CHECK_BLOCKED: state drift: unexpected function (stub)'); process.exit(2) }
  let functions = EXPECTED.functions.map(fnRecord)
  // Drifted reports are written with exit 0 so that the flow's INDEPENDENT local state check has to catch them.
  if (mode === 'drift-baseline') functions.find(f => f.id === 'createCompany').revision = 'createcompany-00002-new'
  if (mode === 'drift-m1') functions.find(f => f.id === 'listCompanyMembers').build = 'projects/860039810193/locations/us-central1/builds/00000000-0000-0000-0000-000000000000'
  if (mode === 'missing') functions = functions.filter(f => f.id !== 'removeMember')
  if (mode === 'extra') functions.push(fnRecord({ id: 'authzProbe', revision: 'authzprobe-00001-xyz', build: 'x', sourceReferenceSha256: 'x' }))
  if (mode === 'caps') functions.find(f => f.id === 'disableMember').resources.maxInstances = 3
  writeNew(out, `${JSON.stringify({ task: 'FINAPP-1.0-M1', mode: 'exact', project: 'finapp-staging', sourceHead: H, status: 'M1_FUNCTIONS_EXACT_STATE_VERIFIED', functions, stub: true }, null, 2)}\n`)
  console.log(`M1_FUNCTIONS_EXACT_STATE_VERIFIED: ${functions.length} functions (stub)`)
} else if (tool === 'stagingResources') {
  const mode = argAt('--mode'), out = argAt('--out'), expected = argAt('--expected-rules-hash')
  if (mode !== 'verify-current-rules' || !sameArgs(args, ['--mode', mode, '--project', 'finapp-staging', '--expected-head', H, '--expected-rules-hash', expected, '--out', out]) || expected !== RULES_TARGET) refuse(`stagingResources arguments: ${JSON.stringify(args)}`)
  claim(`stagingResources-${path.basename(out)}`, 1)
  const scenarioRules = reads.rules ?? 'r3'
  if (scenarioRules === 'fail-read') { console.error('STAGING_RESOURCES_STOPPED: the live Rules read failed (stub)'); process.exit(2) }
  const current = scenarioRules === 'r2' ? RULES_PRE : scenarioRules === 'unknown' ? UNKNOWN_HASH : RULES_TARGET
  if (current !== expected) {
    writeNew(out, journalLine(mode, { status: 'STAGING_RESOURCES_BLOCKED', observedCanonicalSha256: current }))
    console.error('STAGING_RESOURCES_STOPPED: current rules hash differs (stub)')
    process.exit(2)
  }
  const observed = {
    rulesetName: scenarioRules === 'same-ruleset' ? EXPECTED.rulesPre.rulesetName : NEW_RULESET,
    rawSha256: scenarioRules === 'raw-drift' ? '0'.repeat(64) : EXPECTED.rulesTarget.rawSha256,
    sourceBytes: scenarioRules === 'bytes-drift' ? EXPECTED.rulesTarget.sourceBytes + 1 : EXPECTED.rulesTarget.sourceBytes
  }
  writeNew(out, journalLine(mode, { ...observed, canonicalSha256: expected, status: 'CURRENT_RULES_HASH_VERIFIED' }))
  console.log('CURRENT_RULES_HASH_VERIFIED (stub)')
} else refuse(`unknown tool ${tool}`)
