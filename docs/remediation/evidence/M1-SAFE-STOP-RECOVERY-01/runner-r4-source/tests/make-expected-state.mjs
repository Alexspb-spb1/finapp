// Packaging tool (run once): derives expected-state-r3.json.
//   functions + pre-release Rules  <- the rev8 staging run (its LAST read-only observation of finapp-staging)
//   target Rules                   <- firestore.rules of the clean release clone at HEAD 714d0f91
//   rollback reference             <- the round-2 file from git 8526a79 shipped in rules/ (CRLF-equivalence is asserted)
// It only READS the rev8 evidence and run directories and never opens fixture.json (synthetic passwords).
//   node tests/make-expected-state.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256hex, HEAD, PRIOR_HEAD, PROJECT, RULES_PRE, RULES_TARGET, EXPECTED_FORMAT, canonicalOf } from '../m1-state-lib.mjs'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE = 'D:\\projects\\finapp\\.runtime\\m1-stg-rev8-8526a79'
const RUN = 'D:\\projects\\finapp\\.runtime\\m1-staging-run-8526a79-rev8'
const RELEASE_CLONE = 'D:\\projects\\finapp\\m1-release-714d0f91'
const M1 = ['changeMemberRole', 'disableMember', 'restoreMember', 'removeMember', 'listCompanyMembers']
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')))

const finalFunctions = JSON.parse(read(EVIDENCE, 'm1-stg-functions-state-final-rev8.json').toString('utf8'))
const finalRules = JSON.parse(read(EVIDENCE, 'm1-stg-rules-state-final-rev8.jsonl').toString('utf8').split('\n').filter(Boolean).at(-1))
const functions = finalFunctions.functions
  .map(f => ({ id: f.id, group: M1.includes(f.id) ? 'm1' : 'baseline', revision: f.revision, build: f.build, sourceReferenceSha256: f.sourceReferenceSha256 }))
  .sort((a, b) => a.id.localeCompare(b.id))
const caps = finalFunctions.functions[0].resources

const target = fs.readFileSync(path.join(RELEASE_CLONE, 'firestore.rules'))
const blob = fs.readFileSync(path.join(PKG, 'rules', 'r2-8526a791-firestore.rules'))
const blobCrlf = Buffer.from(blob.toString('utf8').replace(/\n/g, '\r\n'))
if (canonicalOf(blob.toString('utf8')) !== RULES_PRE) throw new Error('round-2 blob is not the pre-release canonical hash')
if (sha256hex(blobCrlf) !== finalRules.rawSha256 || blobCrlf.length !== finalRules.sourceBytes) throw new Error('live pre-release raw bytes are not the CRLF form of the round-2 blob')
if (canonicalOf(target.toString('utf8')) !== RULES_TARGET || sha256hex(target) !== RULES_TARGET || target.includes(13)) throw new Error('release clone firestore.rules is not the LF round-3 file')

const pin = (root, name, rel) => { const b = read(root, rel); return { root: name, path: rel, sha256: sha256hex(b), bytes: b.length } }
const priorEvidence = [
  ...['orchestrator-result.json', 'orchestrator-state.json', 'orchestrator-journal.jsonl', 'm1-stg-functions-state-final-rev8.json', 'm1-stg-functions-state-pre-rev8.json',
    'm1-stg-rules-state-final-rev8.jsonl', 'm1-stg-rules-state-pre-rev8.jsonl'].map(r => pin(EVIDENCE, 'evidence', r)),
  ...['result-verify-clean-1790091986509.json', 'result-cleanup-1790091971187.json', 'journal.jsonl'].map(r => pin(RUN, 'run', r)),
]

const expected = {
  format: EXPECTED_FORMAT,
  revision: 'r3',
  derivedFrom: { evidence: 'm1-stg-rev8-8526a79', functionsFinalAt: finalFunctions.at, rulesFinalFinishedAt: finalRules.finishedAt, note: 'read-only derivation; fixture.json was not read' },
  project: PROJECT,
  sourceHead: HEAD,
  priorHead: PRIOR_HEAD,
  caps,
  functions,
  rulesPre: { rulesetName: finalRules.rulesetName, canonicalSha256: finalRules.canonicalSha256, rawSha256: finalRules.rawSha256, sourceBytes: finalRules.sourceBytes },
  rulesTarget: { canonicalSha256: canonicalOf(target.toString('utf8')), rawSha256: sha256hex(target), sourceBytes: target.length, source: 'git 714d0f91:firestore.rules (LF)' },
  rollback: {
    note: 'The rollback publishes the FRESH backup of the live pre-release Rules (CRLF form of the round-2 file); the blob is the reviewed text it must equal after CRLF normalisation.',
    canonicalSha256: RULES_PRE, blobFile: 'rules/r2-8526a791-firestore.rules', blobSha256: sha256hex(blob), blobBytes: blob.length,
    blobCrlfSha256: sha256hex(blobCrlf), blobCrlfBytes: blobCrlf.length,
  },
  priorEvidence,
  priorRunIds: ['bbb573d8', 'acf785fd'],
}
if (expected.rulesPre.canonicalSha256 !== RULES_PRE) throw new Error('prior evidence does not match the pre-release canonical hash')
fs.writeFileSync(path.join(PKG, 'expected-state-r3.json'), `${JSON.stringify(expected, null, 2)}\n`)
console.log(`expected-state-r3.json functions=${functions.length} pins=${priorEvidence.length} preRaw=${expected.rulesPre.rawSha256.slice(0, 8)} targetBytes=${target.length}`)
