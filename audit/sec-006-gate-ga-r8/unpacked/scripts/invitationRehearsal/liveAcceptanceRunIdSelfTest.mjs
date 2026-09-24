import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PRIOR_RUN_IDS, assertRunIdAllowed, claimRunId, generateRunId, readClaim,
} from './liveAcceptanceRunIdCore.mjs'

const HEAD = 'c84f7837bdbc0a27fea698080c779d273e8e15bb'
const withTempDir = fn => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-id-guard-'))
  try { return fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('generateRunId produces a fresh, valid, non-prior id from real entropy', () => {
  const a = generateRunId(), b = generateRunId()
  assert.match(a, /^[a-z][a-z0-9-]{7,39}$/)
  assert.match(b, /^[a-z][a-z0-9-]{7,39}$/)
  assert.notEqual(a, b)
  for (const prior of PRIOR_RUN_IDS) { assert.notEqual(a, prior); assert.notEqual(b, prior) }
})

test('generateRunId rejects a non-function/short/wrong-length random source', () => {
  assert.throws(() => generateRunId(() => Buffer.alloc(19)))
  assert.throws(() => generateRunId(() => 'not-a-buffer'))
  assert.throws(() => generateRunId(() => null))
})

test('assertRunIdAllowed rejects every known 2026-09-11 run-id exactly', () => {
  withTempDir(dir => {
    for (const prior of PRIOR_RUN_IDS) assert.throws(() => assertRunIdAllowed(prior, { claimedDir: dir }), /run_id_guard_blocked/)
  })
})

test('assertRunIdAllowed rejects malformed run-ids and non-absolute claim dirs', () => {
  withTempDir(dir => {
    assert.throws(() => assertRunIdAllowed('Gate-Upper-Not-Allowed', { claimedDir: dir }))
    assert.throws(() => assertRunIdAllowed('short', { claimedDir: dir }))
    assert.throws(() => assertRunIdAllowed('gate-' + 'a'.repeat(60), { claimedDir: dir }))
    assert.throws(() => assertRunIdAllowed('gate-abcdef01', { claimedDir: 'relative/path' }))
  })
})

test('assertRunIdAllowed refuses when any existing filename already references this run-id (manifest/evidence/namespace collision)', () => {
  withTempDir(dir => {
    const runId = generateRunId()
    fs.writeFileSync(path.join(dir, `unrelated-${runId}-journal.jsonl`), '{}')
    assert.throws(() => assertRunIdAllowed(runId, { claimedDir: dir }), /run_id_guard_blocked/)
  })
})

test('assertRunIdAllowed accepts a fresh run-id with an empty claim directory', () => {
  withTempDir(dir => {
    assert.equal(assertRunIdAllowed(generateRunId(), { claimedDir: dir }), true)
  })
})

test('claimRunId durably writes an exclusive marker before any external creation and rereads byte-identical', () => {
  withTempDir(dir => {
    const runId = generateRunId()
    const { markerPath, claimedAt } = claimRunId(runId, { claimedDir: dir, project: 'finapp-staging', sourceHead: HEAD })
    assert.equal(fs.existsSync(markerPath), true)
    const claim = readClaim(markerPath)
    assert.equal(claim.runId, runId)
    assert.equal(claim.project, 'finapp-staging')
    assert.equal(claim.sourceHead, HEAD)
    assert.equal(claim.claimedAt, claimedAt)
    if (process.platform !== 'win32') assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600)
  })
})

test('claimRunId refuses a second claim for the same run-id (wx + pre-check)', () => {
  withTempDir(dir => {
    const runId = generateRunId()
    claimRunId(runId, { claimedDir: dir, project: 'finapp-staging', sourceHead: HEAD })
    assert.throws(() => claimRunId(runId, { claimedDir: dir, project: 'finapp-staging', sourceHead: HEAD }), /run_id_guard_blocked/)
  })
})

test('claimRunId rejects a prior run-id, wrong project type, malformed head, or bad clock', () => {
  withTempDir(dir => {
    assert.throws(() => claimRunId(PRIOR_RUN_IDS[0], { claimedDir: dir, project: 'finapp-staging', sourceHead: HEAD }))
    const runId = generateRunId()
    assert.throws(() => claimRunId(runId, { claimedDir: dir, project: 42, sourceHead: HEAD }))
    assert.throws(() => claimRunId(runId, { claimedDir: dir, project: 'finapp-staging', sourceHead: 'not-a-head' }))
    assert.throws(() => claimRunId(runId, { claimedDir: dir, project: 'finapp-staging', sourceHead: HEAD, now: () => new Date(NaN) }))
  })
})

test('readClaim rejects a tampered or malformed marker file', () => {
  withTempDir(dir => {
    const bad = path.join(dir, 'tampered.json')
    fs.writeFileSync(bad, 'not json')
    assert.throws(() => readClaim(bad))
    fs.writeFileSync(bad, JSON.stringify({ version: 2, runId: 'gate-abcdefabcdefabcdefabcdefabcdefabcdefab' }))
    assert.throws(() => readClaim(bad))
  })
})
