// FINAPP-1.0-M1 R3 - pure checks of the EXPECTED staging state before the release and of the Rules target.
// No I/O and no network: every function takes already-read data, so the same code is used by the
// live-state tool, the independent evidence check, the local provenance check and the tests.
//
// Pinned state (staging, finapp-staging, observed read-only by rev8 on 2026-09-22):
//   functions  exactly the 13 callables rev7 deployed (8 SEC-006 baseline + 5 M1); the Functions source
//              did not change between 8526a79 and 714d0f91, so this release deploys NO Functions;
//   rules pre  the round-2 reviewed Rules (git 8526a79) that rev7 deployed: this is the state the release
//              starts from AND the rollback target (it is read live and backed up before the deploy);
//   rules target  the round-3 Rules at HEAD 714d0f91 (raw == canonical: the release clone has LF endings).
import { createHash } from 'node:crypto'

export const sha256hex = value => createHash('sha256').update(value).digest('hex')
export const HEAD = '714d0f91c60a582ee87dc7da82d6249b3106329f'
export const PRIOR_HEAD = '8526a791ce3f62dee5a64aa239b795c609a39226'
export const PROJECT = 'finapp-staging'
export const RULES_PRE = 'f117e489f9549da9083c19bdf4104b3651aa500061aa52426f09cb6fe492adda'
export const RULES_TARGET = 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd'
export const EXPECTED_FORMAT = 'finapp-m1-expected-state-v2'
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const HEX64 = /^[0-9a-f]{64}$/
const CAP_KEYS = Object.freeze(['memory', 'cpu', 'concurrency', 'minInstances', 'maxInstances', 'timeoutSeconds'])
export const canonicalOf = text => sha256hex(String(text).replace(/\r\n?/g, '\n'))

/** Structural validation of the pinned expected-state file itself. Returns problems. */
export function validateExpected(expected) {
  const p = []
  if (!record(expected) || expected.format !== EXPECTED_FORMAT) return ['expected-state format']
  if (expected.project !== PROJECT || expected.sourceHead !== HEAD || expected.priorHead !== PRIOR_HEAD) p.push('expected-state project/head')
  const fns = expected.functions
  if (!Array.isArray(fns) || fns.length !== 13) p.push('expected-state must pin exactly 13 functions')
  else {
    if (new Set(fns.map(f => f.id)).size !== 13) p.push('expected-state duplicate function ids')
    if (fns.filter(f => f.group === 'baseline').length !== 8 || fns.filter(f => f.group === 'm1').length !== 5) p.push('expected-state must pin 8 baseline and 5 m1 functions')
    for (const f of fns) if (typeof f.id !== 'string' || !f.id.length || typeof f.revision !== 'string' || !f.revision.startsWith(`${f.id.toLowerCase()}-`) || typeof f.build !== 'string' || !HEX64.test(f.sourceReferenceSha256 ?? '')) p.push(`expected-state function ${f?.id}`)
  }
  if (!record(expected.caps) || CAP_KEYS.some(k => !Object.hasOwn(expected.caps, k))) p.push('expected-state caps')
  const pre = expected.rulesPre
  if (!record(pre) || typeof pre.rulesetName !== 'string' || pre.canonicalSha256 !== RULES_PRE || !HEX64.test(pre.rawSha256 ?? '') || !Number.isInteger(pre.sourceBytes)) p.push('expected-state rulesPre pin')
  const target = expected.rulesTarget
  if (!record(target) || target.canonicalSha256 !== RULES_TARGET || target.rawSha256 !== RULES_TARGET || !Number.isInteger(target.sourceBytes) || target.sourceBytes < 1) p.push('expected-state rulesTarget pin')
  const r2 = expected.rollback
  if (!record(r2) || r2.canonicalSha256 !== RULES_PRE || !HEX64.test(r2.blobSha256 ?? '') || !Number.isInteger(r2.blobBytes) || typeof r2.blobFile !== 'string') p.push('expected-state rollback pin')
  if (!Array.isArray(expected.priorEvidence) || !expected.priorEvidence.length) p.push('expected-state prior evidence pins')
  return p
}

/** Live/evidence function records versus the pinned state. Exact set, exact identity, exact caps. */
export function compareFunctions(observed, expected) {
  const problems = []
  if (!Array.isArray(observed)) return ['functions missing']
  if (observed.length !== expected.functions.length) problems.push(`function count ${observed.length} != ${expected.functions.length}`)
  const ids = observed.map(f => f?.id)
  if (new Set(ids).size !== ids.length) problems.push('duplicate function in observed state')
  for (const want of expected.functions) {
    const got = observed.find(f => f?.id === want.id)
    if (!got) { problems.push(`missing function ${want.id}`); continue }
    if (got.state !== 'ACTIVE') problems.push(`${want.id} state ${got.state}`)
    if (got.runtime !== 'nodejs22') problems.push(`${want.id} runtime ${got.runtime}`)
    if (!record(got.resources) || CAP_KEYS.some(k => got.resources[k] !== expected.caps[k]) || Object.keys(got.resources).length !== CAP_KEYS.length) problems.push(`${want.id} caps changed`)
    for (const key of ['revision', 'build', 'sourceReferenceSha256']) if (got[key] !== want[key]) problems.push(`${want.id} ${key} changed`)
  }
  for (const id of ids) if (!expected.functions.some(f => f.id === id)) problems.push(`unexpected function ${id}`)
  return problems
}

/**
 * A verify-current-rules journal (exactly one JSON line) versus the pinned Rules.
 *   pre    (canonical = RULES_PRE)    ruleset, raw hash and size equal the pinned round-2 deployment;
 *   target (canonical = RULES_TARGET) raw hash and size equal the pinned round-3 file and the live
 *                                     ruleset is a NEW one (different from the pre-release ruleset).
 * `head` is the sourceHead the journal must carry (this release, or the prior release for provenance).
 */
export function verifyRulesEvidence(text, expected, expectedHash, head = HEAD) {
  const problems = []
  const lines = String(text).split('\n').filter(Boolean)
  if (lines.length !== 1) return [`rules evidence must be exactly one line, found ${lines.length}`]
  let e
  try { e = JSON.parse(lines[0]) } catch { return ['rules evidence unreadable'] }
  if (!record(e)) return ['rules evidence not an object']
  if (e.mode !== 'verify-current-rules' || e.project !== PROJECT || e.sourceHead !== head) problems.push('rules evidence mode/project/head')
  if (e.status !== 'CURRENT_RULES_HASH_VERIFIED') problems.push(`rules evidence status ${e.status}`)
  if (e.canonicalSha256 !== expectedHash) problems.push('rules evidence canonical hash differs from the requested one')
  if (Number.isNaN(Date.parse(e.finishedAt))) problems.push('rules evidence finishedAt')
  if (expectedHash === expected.rulesPre.canonicalSha256) {
    if (e.rulesetName !== expected.rulesPre.rulesetName) problems.push('pre-release Rules ruleset differs from the pinned one')
    if (e.rawSha256 !== expected.rulesPre.rawSha256) problems.push('pre-release Rules raw hash differs from the pinned one')
    if (e.sourceBytes !== expected.rulesPre.sourceBytes) problems.push('pre-release Rules size differs from the pinned one')
  } else if (expectedHash === expected.rulesTarget.canonicalSha256) {
    if (e.rawSha256 !== expected.rulesTarget.rawSha256) problems.push('target Rules raw hash differs from the pinned one')
    if (e.sourceBytes !== expected.rulesTarget.sourceBytes) problems.push('target Rules size differs from the pinned one')
    if (typeof e.rulesetName !== 'string' || !e.rulesetName.startsWith(`projects/${PROJECT}/rulesets/`) || e.rulesetName === expected.rulesPre.rulesetName) problems.push('target Rules must be a new ruleset, not the pre-release one')
  } else problems.push('requested canonical hash is neither the pre-release nor the target Rules')
  return problems
}

/**
 * Local, network-free: the repository Rules file is exactly the pinned round-3 target (LF endings), the round-2
 * reference shipped in the package is the pinned file, and the pinned live raw bytes of the pre-release Rules are
 * exactly the CRLF form of that reference (so the rollback publishes the reviewed text, nothing else).
 */
export function localRulesProblems(expected, targetBytes, blobBytes) {
  const p = validateExpected(expected)
  if (p.length) return p
  if (sha256hex(targetBytes) !== expected.rulesTarget.rawSha256 || targetBytes.length !== expected.rulesTarget.sourceBytes || canonicalOf(targetBytes.toString('utf8')) !== expected.rulesTarget.canonicalSha256) p.push('repository firestore.rules is not the pinned round-3 target')
  if (targetBytes.includes(13)) p.push('target Rules contain CR bytes (the release clone must keep LF line endings)')
  if (sha256hex(blobBytes) !== expected.rollback.blobSha256 || blobBytes.length !== expected.rollback.blobBytes || canonicalOf(blobBytes.toString('utf8')) !== expected.rulesPre.canonicalSha256) p.push('shipped round-2 reference is not the pinned file')
  const crlf = Buffer.from(blobBytes.toString('utf8').replace(/\r?\n/g, '\r\n'))
  if (sha256hex(crlf) !== expected.rulesPre.rawSha256 || crlf.length !== expected.rulesPre.sourceBytes) p.push('the pinned pre-release raw bytes are not the CRLF form of the round-2 reference')
  return p
}

/**
 * Local provenance: every pinned evidence file of the prior (rev8) run exists with the pinned hash and
 * size, and the pinned functions and pre-release Rules agree with what rev8 last observed on staging.
 * `read(root, rel)` returns a Buffer or null.
 */
export function verifyProvenance(expected, read) {
  const problems = validateExpected(expected)
  if (problems.length) return problems
  const cache = new Map()
  const get = (root, rel) => { const k = `${root}/${rel}`; if (!cache.has(k)) cache.set(k, read(root, rel)); return cache.get(k) }
  for (const pin of expected.priorEvidence) {
    const buf = get(pin.root, pin.path)
    if (!buf) { problems.push(`missing ${pin.root}/${pin.path}`); continue }
    if (buf.length !== pin.bytes || sha256hex(buf) !== pin.sha256) problems.push(`changed ${pin.root}/${pin.path}`)
  }
  if (problems.length) return problems
  const json = (root, rel) => JSON.parse(get(root, rel).toString('utf8').replace(/^﻿/, ''))
  try {
    const result = json('evidence', 'orchestrator-result.json')
    if (result.status !== 'STAGE_PASS' || result.head !== PRIOR_HEAD || result.stop !== null) problems.push('prior result is not the recorded STAGE_PASS')
    if (result.rules?.reviewedRulesVerified !== true || result.rules?.rollbackAttempted !== false) problems.push('prior result: reviewed Rules not verified or a rollback was attempted')
    if (result.cleanup?.branch !== 'CLEANUP_COMPLETE_VERIFIED' || result.cleanup?.verifyCleanExit !== 0) problems.push('prior result: cleanup was not completed and verified')

    const finalFunctions = json('evidence', 'm1-stg-functions-state-final-rev8.json')
    if (finalFunctions.status !== 'M1_FUNCTIONS_EXACT_STATE_VERIFIED' || finalFunctions.sourceHead !== PRIOR_HEAD) problems.push('prior final functions status')
    problems.push(...compareFunctions(finalFunctions.functions, expected).map(x => `pinned functions vs prior final state: ${x}`))
    problems.push(...verifyRulesEvidence(get('evidence', 'm1-stg-rules-state-final-rev8.jsonl').toString('utf8'), expected, RULES_PRE, PRIOR_HEAD).map(x => `prior final Rules: ${x}`))

    const clean = json('run', 'result-verify-clean-1790091986509.json')
    const docs = clean.results?.find(r => r.step === 'verify-clean.documents-absent')
    const auth = clean.results?.find(r => r.step === 'verify-clean.auth-absent')
    if (clean.status !== 'PASS' || docs?.pass !== true || docs?.detail?.remaining !== 0 || auth?.pass !== true || auth?.detail?.byUid !== 0 || auth?.detail?.byEmail !== 0) problems.push('prior verify-clean did not record zero remaining synthetic data')
    const runEvents = get('run', 'journal.jsonl').toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    const last = runEvents.at(-1)
    if (last?.event !== 'MODE_PASS' || last?.mode !== 'verify-clean') problems.push('prior run journal does not end with a passed verify-clean')
  } catch (e) {
    problems.push(`provenance unreadable: ${String(e?.message ?? e).slice(0, 80)}`)
  }
  return problems
}
