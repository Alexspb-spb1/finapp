// Local stand-ins for the two staging read tools the R3 release uses, with their exact CLI contracts:
//   functionsCheck   (m1-functions-check.mjs --mode exact)
//   stagingResources (scripts/invitationRehearsal/stagingResources.mjs backup-rules | verify-rules-backup | verify-current-rules)
// Output shapes match what downstream package steps read. No network.
// Scenario: rulesInitial = TARGET|OTHER (Rules state before the run; default: the pre-release round-2 Rules)
//           stagingTools.statePre / .stateFinal = pass | fail | drift-baseline | drift-m1 | missing | extra | caps
//           stagingTools.rulesDrift = ruleset | raw | bytes    (pre-release Rules verify with a different pin, exit 0)
//           stagingTools.backupRules = pass | fail             (the fresh backup of the live Rules cannot be taken)
//           stagingTools.backupVerify = pass | fail
//           stagingTools.targetDrift = raw | bytes | same-ruleset   (post-deploy target Rules verify with a different pin, exit 0)
//           stagingTools.postDeploy = fail                     (the post-deploy Rules read fails)
//           stagingTools.rulesFinal = fail                     (only the final Rules read fails)
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assertPreloaded, scenario, claim, refuse, sameArgs, writeNew, rulesState, H, RULES_PRE, RULES_TARGET, NEW_RULESET, ROLLBACK_RULESET } from './stub-lib.mjs'

assertPreloaded()
const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXPECTED = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'expected-state-r3.json'), 'utf8'))
const [tool, ...args] = process.argv.slice(2)
const s = scenario().stagingTools ?? {}
const outcome = (key, dflt = 'pass') => s[key] ?? dflt
const argAt = name => args[args.indexOf(name) + 1]
const sha = v => createHash('sha256').update(v).digest('hex')
const now = () => new Date().toISOString()
const journalLine = (mode, extra) => `${JSON.stringify({ task: 'SEC-006 Stage 8', mode, project: 'finapp-staging', sourceHead: H, startedAt: now(), ...extra, finishedAt: now() })}\n`
const fnRecord = f => ({ id: f.id, state: 'ACTIVE', runtime: 'nodejs22', resources: { ...EXPECTED.caps }, revision: f.revision, build: f.build, sourceReferenceSha256: f.sourceReferenceSha256 })
// The live pre-release Rules are the CRLF form of the round-2 file (the real raw hash equals this by construction).
const preLive = () => Buffer.from(fs.readFileSync(path.join(HERE, '..', EXPECTED.rollback.blobFile), 'utf8').replace(/\r?\n/g, '\r\n'))

if (tool === 'functionsCheck') {
  const out = argAt('--out'), expectedFile = argAt('--expected')
  const which = path.basename(out ?? '') === 'm1-stg-functions-state-pre-r3.json' ? 'statePre' : path.basename(out ?? '') === 'm1-stg-functions-state-final-r3.json' ? 'stateFinal' : null
  if (!which || !sameArgs(args, ['--mode', 'exact', '--expected-head', H, '--expected', expectedFile, '--out', out]) || path.basename(expectedFile ?? '') !== 'expected-state-r3.json' || !fs.existsSync(expectedFile)) refuse(`functionsCheck arguments: ${JSON.stringify(args)}`)
  claim(`functionsCheck-${which === 'statePre' ? 'pre' : 'final'}`, 1)
  const mode = outcome(which)
  if (mode === 'fail') { console.error('M1_FUNCTIONS_CHECK_BLOCKED: state drift: unexpected function (stub)'); process.exit(2) }
  let functions = EXPECTED.functions.map(fnRecord)
  // Drifted reports are written with exit 0 so that the orchestrator's INDEPENDENT local check has to catch them.
  if (mode === 'drift-baseline') functions.find(f => f.id === 'createCompany').revision = 'createcompany-00002-new'
  if (mode === 'drift-m1') functions.find(f => f.id === 'listCompanyMembers').build = 'projects/860039810193/locations/us-central1/builds/00000000-0000-0000-0000-000000000000'
  if (mode === 'missing') functions = functions.filter(f => f.id !== 'removeMember')
  if (mode === 'extra') functions.push({ ...fnRecord({ id: 'authzProbe', revision: 'authzprobe-00001-xyz', build: 'x', sourceReferenceSha256: 'x' }) })
  if (mode === 'caps') functions.find(f => f.id === 'disableMember').resources.maxInstances = 3
  writeNew(out, `${JSON.stringify({ task: 'FINAPP-1.0-M1', mode: 'exact', project: 'finapp-staging', sourceHead: H, status: 'M1_FUNCTIONS_EXACT_STATE_VERIFIED', functions, stub: true }, null, 2)}\n`)
  console.log(`M1_FUNCTIONS_EXACT_STATE_VERIFIED: ${functions.length} functions (stub)`)
} else if (tool === 'stagingResources') {
  const mode = argAt('--mode'), out = argAt('--out'), expected = argAt('--expected-rules-hash')
  const base = ['--mode', mode, '--project', 'finapp-staging', '--expected-head', H, '--expected-rules-hash', expected]
  if (mode === 'backup-rules') {
    const backup = argAt('--backup')
    if (!sameArgs(args, [...base, '--backup', backup, '--out', out]) || expected !== RULES_PRE || path.basename(backup ?? '') !== 'm1-stg-rules-before-r3.json' || path.basename(out ?? '') !== 'm1-stg-rules-backup-r3.jsonl') refuse(`stagingResources ${mode} arguments: ${JSON.stringify(args)}`)
    claim('stagingResources-backup-rules', 1)
    const st = rulesState()
    if (outcome('backupRules') !== 'pass' || st.current !== RULES_PRE) { console.error('STAGING_RESOURCES_STOPPED (stub): the live Rules are not the pre-release Rules or cannot be backed up'); process.exit(2) }
    const content = preLive().toString('utf8')
    const rulesetName = st.via === 'rollback' ? ROLLBACK_RULESET : EXPECTED.rulesPre.rulesetName
    writeNew(backup, `${JSON.stringify({ format: 'finapp-rules-backup-v1', project: 'finapp-staging', database: 'projects/finapp-staging/databases/(default)', sourceHead: H, capturedAt: now(),
      release: { name: 'projects/finapp-staging/releases/cloud.firestore', rulesetName }, rulesetName, source: { files: [{ name: 'firestore.rules', content }] },
      canonicalSha256: RULES_PRE, rawSha256: sha(content), sourceBytes: Buffer.byteLength(content) }, null, 2)}\n`)
    writeNew(out, journalLine(mode, { rulesetName, canonicalSha256: RULES_PRE, rawSha256: sha(content), sourceBytes: Buffer.byteLength(content), status: 'RULES_BACKUP_SAVED_VERIFIED' }))
    console.log('RULES_BACKUP_SAVED_VERIFIED (stub)')
  } else if (mode === 'verify-rules-backup') {
    const backup = argAt('--backup')
    if (!sameArgs(args, [...base, '--backup', backup, '--out', out]) || expected !== RULES_PRE || path.basename(backup ?? '') !== 'm1-stg-rules-before-r3.json' || !fs.existsSync(backup)) refuse(`stagingResources ${mode} arguments: ${JSON.stringify(args)}`)
    claim('stagingResources-verify-rules-backup', 1)
    // Local-only in the real tool as well: the backup must be a well-formed backup of the pre-release Rules.
    let ok = outcome('backupVerify') === 'pass'
    let rulesetName = EXPECTED.rulesPre.rulesetName
    try {
      const b = JSON.parse(fs.readFileSync(backup, 'utf8'))
      const content = b.source.files[0].content
      rulesetName = b.rulesetName
      ok = ok && b.format === 'finapp-rules-backup-v1' && b.rawSha256 === sha(content) && b.sourceBytes === Buffer.byteLength(content) && b.canonicalSha256 === RULES_PRE && sha(content.replace(/\r\n?/g, '\n')) === RULES_PRE
    } catch { ok = false }
    if (!ok) { console.error('STAGING_RESOURCES_STOPPED (stub): backup does not verify'); process.exit(2) }
    writeNew(out, journalLine(mode, { rulesetName, canonicalSha256: RULES_PRE, rawSha256: EXPECTED.rulesPre.rawSha256, sourceBytes: EXPECTED.rulesPre.sourceBytes, status: 'RULES_BACKUP_VERIFIED_LOCAL' }))
    console.log('RULES_BACKUP_VERIFIED_LOCAL (stub)')
  } else if (mode === 'verify-current-rules') {
    if (!sameArgs(args, [...base, '--out', out]) || ![RULES_PRE, RULES_TARGET].includes(expected)) refuse(`stagingResources verify-current-rules arguments: ${JSON.stringify(args)}`)
    const name = path.basename(out ?? '')
    if (!['m1-stg-rules-state-pre-r3.jsonl', 'm1-stg-rules-state-postdeploy-r3.jsonl', 'm1-stg-rules-state-final-r3.jsonl', 'm1-stg-rules-state-reverify-r3.jsonl', 'm1-stg-rules-rollback-verify-r3.jsonl'].includes(name)) refuse(`verify-current-rules output name ${name}`)
    claim(`stagingResources-verify-current-rules-${name}`, 1)
    const st = rulesState()
    if (name === 'm1-stg-rules-state-final-r3.jsonl' && outcome('rulesFinal') === 'fail') { console.error('STAGING_RESOURCES_STOPPED: final rules read failed (stub)'); process.exit(2) }
    if (name === 'm1-stg-rules-state-postdeploy-r3.jsonl' && outcome('postDeploy') === 'fail') { console.error('STAGING_RESOURCES_STOPPED: post-deploy rules read failed (stub)'); process.exit(2) }
    if (st.current !== expected) { writeNew(out, journalLine(mode, { status: 'STAGING_RESOURCES_BLOCKED', observedCanonicalSha256: st.current })); console.error('STAGING_RESOURCES_STOPPED: current rules hash differs (stub)'); process.exit(2) }
    const drift = outcome('rulesDrift', 'none')
    const target = outcome('targetDrift', 'none')
    let observed
    if (expected === RULES_PRE) {
      observed = {
        rulesetName: st.via === 'rollback' ? ROLLBACK_RULESET : drift === 'ruleset' ? 'projects/finapp-staging/rulesets/00000000-0000-0000-0000-000000000000' : EXPECTED.rulesPre.rulesetName,
        rawSha256: drift === 'raw' ? '0'.repeat(64) : EXPECTED.rulesPre.rawSha256,
        sourceBytes: drift === 'bytes' ? EXPECTED.rulesPre.sourceBytes + 1 : EXPECTED.rulesPre.sourceBytes,
      }
    } else {
      observed = {
        rulesetName: target === 'same-ruleset' ? EXPECTED.rulesPre.rulesetName : NEW_RULESET,
        rawSha256: target === 'raw' ? '0'.repeat(64) : EXPECTED.rulesTarget.rawSha256,
        sourceBytes: target === 'bytes' ? EXPECTED.rulesTarget.sourceBytes + 1 : EXPECTED.rulesTarget.sourceBytes,
      }
    }
    writeNew(out, journalLine(mode, { ...observed, canonicalSha256: expected, status: 'CURRENT_RULES_HASH_VERIFIED' }))
    console.log('CURRENT_RULES_HASH_VERIFIED (stub)')
  } else refuse(`stagingResources mode ${mode}`)
} else {
  refuse(`unknown staging tool ${tool}`)
}
