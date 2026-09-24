import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendJournalEvent, buildCleanupTargets, buildFixturePlan, validateCleanupTargets,
} from './liveAcceptanceCore.mjs'
import { assertRunIdAllowed, claimRunId, PRIOR_RUN_IDS } from './liveAcceptanceRunIdCore.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// These tests exercise scenarios explicitly required by gate-G-A item D that
// are better proven against the EXISTING, already-independently-reviewed
// primitives (buildCleanupTargets/validateCleanupTargets, the journal state
// machine) than duplicated in the new modules — reuse over reinvention.

function fixedPlan() {
  return buildFixturePlan({
    runId: 'gate-abcdef0123456789abcdef01',
    mailboxSha256: '11'.repeat(32),
    companyIds: { a: 'company-a-id', b: 'company-b-id' },
    syntheticAuthUids: { ownerA: 'owner-a-uid', ownerB: 'owner-b-uid' },
    ownerMailboxUid: 'mailbox-owner-uid',
    lockIds: { mailbox: '22'.repeat(32), ownerB: '33'.repeat(32) },
  })
}

function fixedObserved() {
  return {
    invitationIds: { mailboxCancelled: 'inv-1', mailboxFinal: 'inv-2', ownerBExisting: 'inv-3' },
    auditEventIds: [
      { slot: 'companyACreated', company: 'a', id: 'ev-1' },
      { slot: 'companyBCreated', company: 'b', id: 'ev-2' },
      { slot: 'mailboxCancelledCreated', company: 'a', id: 'ev-3' },
      { slot: 'mailboxCancelled', company: 'a', id: 'ev-4' },
      { slot: 'mailboxFinalCreated', company: 'a', id: 'ev-5' },
      { slot: 'mailboxFinalResent', company: 'a', id: 'ev-6' },
      { slot: 'mailboxFinalAccepted', company: 'a', id: 'ev-7' },
      { slot: 'ownerBInviteCreated', company: 'a', id: 'ev-8' },
      { slot: 'ownerBInviteAccepted', company: 'a', id: 'ev-9' },
    ],
  }
}

test('negative (tampered manifest): an added, removed, or runId-altered target list is rejected by the existing reviewed validator', () => {
  const plan = fixedPlan(), observed = fixedObserved()
  const genuine = buildCleanupTargets(plan, observed)
  assert.equal(validateCleanupTargets(plan, genuine, observed), true)

  const addedPath = { ...genuine, destructive: { ...genuine.destructive, firestorePaths: [...genuine.destructive.firestorePaths, 'companies/injected-extra'] } }
  assert.throws(() => validateCleanupTargets(plan, addedPath, observed))

  const removedPath = { ...genuine, destructive: { ...genuine.destructive, firestorePaths: genuine.destructive.firestorePaths.slice(1) } }
  assert.throws(() => validateCleanupTargets(plan, removedPath, observed))

  const wrongRun = { ...genuine, runId: 'gate-different0000000000000' }
  assert.throws(() => validateCleanupTargets(plan, wrongRun, observed))

  const smuggledOwner = { ...genuine, destructive: { ...genuine.destructive, authUids: [...genuine.destructive.authUids, 'mailbox-owner-uid'] } }
  assert.throws(() => validateCleanupTargets(plan, smuggledOwner, observed))
})

test('negative (corrupted journal): an out-of-order sequence number or an unknown status is rejected by the existing journal state machine', () => {
  const first = appendJournalEvent([], { seq: 0, status: 'PRECONDITIONS_VERIFIED', at: new Date().toISOString(), details: {} })
  assert.equal(first.length, 1)
  assert.throws(() => appendJournalEvent(first, { seq: 5, status: 'SCENARIOS_RUNNING', at: new Date().toISOString(), details: {} }))
  assert.throws(() => appendJournalEvent(first, { seq: 1, status: 'NOT_A_REAL_STATUS', at: new Date().toISOString(), details: {} }))
  assert.throws(() => appendJournalEvent(first, { seq: 1, status: 'FIXTURE_MUTATION_RECONCILED', at: new Date().toISOString(), details: {} }))
})

test('negative (corrupted journal file on disk): truncated / non-newline-terminated / embedded-NUL journal bytes are treated as unresumable evidence, not replay instructions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-corruption-'))
  try {
    const truncated = path.join(dir, 'truncated.jsonl')
    fs.writeFileSync(truncated, '{"seq":0,"status":"PRECONDITIONS_VERIFIED"')
    const bytes = fs.readFileSync(truncated, 'utf8')
    assert.equal(bytes.endsWith('\n'), false)
    const embeddedNul = path.join(dir, 'nul.jsonl')
    fs.writeFileSync(embeddedNul, '{"a":1}\n\0{"b":2}\n')
    assert.equal(fs.readFileSync(embeddedNul, 'utf8').includes('\0'), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reused run-id end-to-end: the exact 2026-09-11 run-id is refused by the guard used at claim time, independent of any cleanup logic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reused-run-id-'))
  try {
    for (const prior of PRIOR_RUN_IDS) {
      assert.throws(() => assertRunIdAllowed(prior, { claimedDir: dir }))
      assert.throws(() => claimRunId(prior, { claimedDir: dir, project: 'finapp-staging', sourceHead: 'c84f7837bdbc0a27fea698080c779d273e8e15bb' }))
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
