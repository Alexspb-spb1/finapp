import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLEANUP_MAX, assertNoUnexpectedSubcollections, classifyCleanupEligibility,
  executeManifestCleanup, validateLedger,
} from './liveAcceptanceCleanupCore.mjs'
import { FIXTURE_MUTATION_SLOT_SPECS } from './liveAcceptanceCore.mjs'

const RUN_ID = 'gate-abcdef0123456789abcdef01'
const FRAGMENTS = Object.freeze(['owner-a-uid', 'co-a'])
const WRITE_SLOTS = FIXTURE_MUTATION_SLOT_SPECS.filter(s => s.disposition === 'WRITE' || s.disposition === 'IDEMPOTENT_READBACK').map(s => s.slot)
const allStates = value => Object.fromEntries(WRITE_SLOTS.map(slot => [slot, value]))

function fakeJournal() {
  const events = []
  return { events, append(status, details) { events.push({ status, details: structuredClone(details) }) } }
}

function fakeLedger(overrides = {}) {
  return {
    runId: RUN_ID,
    createdAuthUids: ['owner-a-uid'],
    ownerMailboxUidCreated: true,
    createdFirestorePaths: ['companies/co-a', 'companies/co-a/company_data/data', 'companies/co-a/members/owner-a-uid', 'companies/co-a/audit_events/ev1'],
    casPaths: ['companies/co-a/members/mailbox-uid'],
    ...overrides,
  }
}

function fakeAdapters(overrides = {}, ledger = fakeLedger()) {
  const calls = { listChildCollections: [], readDoc: [], deleteDoc: [], deleteAuthUser: [] }
  const existingPaths = new Set([...ledger.createdFirestorePaths, ...ledger.casPaths])
  const existingUids = new Set(ledger.createdAuthUids)
  const base = {
    async listChildCollections(path) { calls.listChildCollections.push(path); return ['company_data', 'members', 'audit_events'] },
    async readDoc(path) {
      calls.readDoc.push(path)
      return existingPaths.has(path) ? { exists: true, stateSha256: '11'.repeat(32) } : { exists: false, stateSha256: null }
    },
    async deleteDoc(path) { calls.deleteDoc.push(path); existingPaths.delete(path) },
    async deleteAuthUser(uid) { calls.deleteAuthUser.push(uid); existingUids.delete(uid) },
    async authUserExists(uid) { return existingUids.has(uid) },
    async authUserExistsByEmail() { return false },
  }
  return { calls, adapters: { ...base, ...overrides } }
}

test('classifyCleanupEligibility blocks on any UNCERTAIN write-slot and lists them', () => {
  const states = { ...allStates('NOT_STARTED'), createCompanyA: 'RECONCILED', createMailboxFinalInvite: 'UNCERTAIN' }
  const result = classifyCleanupEligibility(states)
  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'UNCERTAIN_SLOTS')
  assert.deepEqual(result.uncertainSlots, ['createMailboxFinalInvite'])
})

test('classifyCleanupEligibility accepts an all-NOT_STARTED and an all-RECONCILED run', () => {
  assert.equal(classifyCleanupEligibility(allStates('NOT_STARTED')).eligible, true)
  assert.deepEqual(classifyCleanupEligibility(allStates('NOT_STARTED')).reconciledSlots, [])
  assert.equal(classifyCleanupEligibility(allStates('RECONCILED')).eligible, true)
  assert.deepEqual(classifyCleanupEligibility(allStates('RECONCILED')).reconciledSlots, WRITE_SLOTS)
})

test('classifyCleanupEligibility accepts a mixed partial run (some RECONCILED, some NOT_STARTED — STOP after partial creation)', () => {
  const partial = { ...allStates('NOT_STARTED'), createOwnerAAuth: 'RECONCILED', createCompanyA: 'RECONCILED' }
  const result = classifyCleanupEligibility(partial)
  assert.equal(result.eligible, true)
  assert.deepEqual(result.reconciledSlots, ['createOwnerAAuth', 'createCompanyA'])
})

test('classifyCleanupEligibility rejects unknown states and missing slots', () => {
  assert.throws(() => classifyCleanupEligibility({ ...allStates('NOT_STARTED'), createCompanyA: 'WEIRD' }))
  const missing = allStates('NOT_STARTED'); delete missing.createCompanyA
  assert.throws(() => classifyCleanupEligibility(missing))
})

test('validateLedger accepts a well-formed ledger and rejects a runId mismatch', () => {
  assert.equal(validateLedger(fakeLedger(), { runId: RUN_ID, allowedIdFragments: FRAGMENTS }), true)
  assert.throws(() => validateLedger(fakeLedger(), { runId: 'gate-different0000000000000', allowedIdFragments: FRAGMENTS }))
})

test('validateLedger rejects oversized, duplicate, or CAS-overlapping destructive sets', () => {
  assert.throws(() => validateLedger(fakeLedger({ createdAuthUids: ['a', 'b', 'c'] }), { runId: RUN_ID, allowedIdFragments: FRAGMENTS }))
  assert.throws(() => validateLedger(fakeLedger({ createdFirestorePaths: Array.from({ length: 26 }, (_, i) => `companies/co-${i}`) }), { runId: RUN_ID, allowedIdFragments: FRAGMENTS }))
  assert.throws(() => validateLedger(fakeLedger({ createdFirestorePaths: ['companies/co-a', 'companies/co-a'] }), { runId: RUN_ID, allowedIdFragments: FRAGMENTS }))
  const overlap = fakeLedger(); overlap.createdFirestorePaths = [...overlap.createdFirestorePaths, overlap.casPaths[0]]
  assert.throws(() => validateLedger(overlap, { runId: RUN_ID, allowedIdFragments: FRAGMENTS }))
})

test('negative (foreign document): a path or uid that does not belong to this run is refused even inside an otherwise well-formed ledger', () => {
  const foreignPath = fakeLedger({ createdFirestorePaths: [...fakeLedger().createdFirestorePaths, 'companies/someone-elses-company/company_data/data'] })
  assert.throws(() => validateLedger(foreignPath, { runId: RUN_ID, allowedIdFragments: FRAGMENTS }))
  const foreignUid = fakeLedger({ createdAuthUids: ['owner-a-uid', 'stage8-mtww3p0r-1ae5cb84b43c285e-ownerA'] })
  assert.throws(() => validateLedger(foreignUid, { runId: RUN_ID, allowedIdFragments: FRAGMENTS }))
})

test('validateLedger requires non-empty allowedIdFragments (cannot be bypassed by omission)', () => {
  assert.throws(() => validateLedger(fakeLedger(), { runId: RUN_ID, allowedIdFragments: [] }))
  assert.throws(() => validateLedger(fakeLedger(), { runId: RUN_ID }))
})

test('assertNoUnexpectedSubcollections passes on the known set and flags an extra collection', async () => {
  const clean = await assertNoUnexpectedSubcollections(['companies/co-a'], async () => ['company_data', 'members', 'audit_events'])
  assert.equal(clean.clean, true)
  const dirty = await assertNoUnexpectedSubcollections(['companies/co-a'], async () => ['company_data', 'members', 'audit_events', 'unexpected_extra'])
  assert.equal(dirty.clean, false)
  assert.deepEqual(dirty.unexpected, ['unexpected_extra'])
})

test('executeManifestCleanup: full positive run deletes exactly the ledger and verifies clean', async () => {
  const journal = fakeJournal()
  const { calls, adapters } = fakeAdapters()
  const result = await executeManifestCleanup({ runId: RUN_ID, slotStates: allStates('RECONCILED'), ledger: fakeLedger(), adapters, journal, allowedIdFragments: FRAGMENTS })
  assert.equal(result.status, 'CLEANUP_COMPLETE_VERIFIED')
  assert.deepEqual(result.deleted.authUids, ['owner-a-uid'])
  assert.equal(result.deleted.firestorePaths.length, 4)
  assert.deepEqual(calls.deleteDoc, fakeLedger().createdFirestorePaths)
  assert.deepEqual(calls.deleteAuthUser, ['owner-a-uid'])
  // The CAS-preserved mailbox membership must never be handed to deleteDoc.
  assert.equal(calls.deleteDoc.includes('companies/co-a/members/mailbox-uid'), false)
  assert.ok(journal.events.some(e => e.status === 'CLEANUP_COMPLETE_VERIFIED'))
})

test('executeManifestCleanup: partial-creation ledger (STOP after only 2 of 16 slots) cleans up exactly those two and verifies clean', async () => {
  const journal = fakeJournal()
  const partialLedger = fakeLedger({
    createdFirestorePaths: ['companies/co-a', 'companies/co-a/members/owner-a-uid'],
    casPaths: [],
  })
  const { calls, adapters } = fakeAdapters({}, partialLedger)
  const states = { ...allStates('NOT_STARTED'), createOwnerAAuth: 'RECONCILED', createCompanyA: 'RECONCILED' }
  const result = await executeManifestCleanup({ runId: RUN_ID, slotStates: states, ledger: partialLedger, adapters, journal, allowedIdFragments: FRAGMENTS })
  assert.equal(result.status, 'CLEANUP_COMPLETE_VERIFIED')
  assert.equal(calls.deleteDoc.length, 2)
  assert.equal(calls.deleteAuthUser.length, 1)
})

test('executeManifestCleanup: noop ledger short-circuits with zero adapter calls', async () => {
  const journal = fakeJournal()
  const { calls, adapters } = fakeAdapters()
  const empty = fakeLedger({ createdAuthUids: [], createdFirestorePaths: [], casPaths: [] })
  const result = await executeManifestCleanup({ runId: RUN_ID, slotStates: allStates('NOT_STARTED'), ledger: empty, adapters, journal, allowedIdFragments: FRAGMENTS })
  assert.equal(result.status, 'CLEANUP_COMPLETE_VERIFIED')
  assert.equal(calls.deleteDoc.length, 0)
  assert.equal(calls.deleteAuthUser.length, 0)
  assert.equal(calls.listChildCollections.length, 0)
})

test('negative: UNCERTAIN slot refuses cleanup with zero deletions and a recovery-manifest journal entry', async () => {
  const journal = fakeJournal()
  const { calls, adapters } = fakeAdapters()
  const states = { ...allStates('NOT_STARTED'), createCompanyA: 'UNCERTAIN' }
  const result = await executeManifestCleanup({ runId: RUN_ID, slotStates: states, ledger: fakeLedger(), adapters, journal, allowedIdFragments: FRAGMENTS })
  assert.equal(result.status, 'CLEANUP_REFUSED')
  assert.equal(result.reason, 'UNCERTAIN_SLOTS')
  assert.equal(calls.deleteDoc.length, 0)
  assert.equal(calls.deleteAuthUser.length, 0)
  assert.ok(journal.events.some(e => e.status === 'SAFE_STOP' && e.details.reason === 'UNCERTAIN_SLOTS'))
})

test('negative: unexpected subcollection refuses ALL deletion for the run, not just that company', async () => {
  const journal = fakeJournal()
  const { calls, adapters } = fakeAdapters({ async listChildCollections() { return ['company_data', 'members', 'audit_events', 'mystery'] } })
  const result = await executeManifestCleanup({ runId: RUN_ID, slotStates: allStates('RECONCILED'), ledger: fakeLedger(), adapters, journal, allowedIdFragments: FRAGMENTS })
  assert.equal(result.status, 'CLEANUP_REFUSED')
  assert.equal(result.reason, 'UNEXPECTED_SUBCOLLECTION')
  assert.equal(calls.deleteDoc.length, 0)
})

test('negative: CAS precondition failure (mailbox membership missing/changed) refuses before any delete', async () => {
  const journal = fakeJournal()
  const { calls, adapters } = fakeAdapters({ async readDoc() { return { exists: false, stateSha256: null } } })
  const result = await executeManifestCleanup({ runId: RUN_ID, slotStates: allStates('RECONCILED'), ledger: fakeLedger(), adapters, journal, allowedIdFragments: FRAGMENTS })
  assert.equal(result.status, 'CLEANUP_REFUSED')
  assert.equal(result.reason, 'CAS_PRECONDITION_FAILED')
  assert.equal(calls.deleteDoc.length, 0)
})

test('negative: partial deletion stops immediately on first failure and reports CLEANUP_PARTIAL', async () => {
  const journal = fakeJournal()
  let count = 0
  const { calls, adapters } = fakeAdapters({ async deleteDoc(path) { count++; calls.deleteDoc.push(path); if (count === 2) throw new Error('boom') } })
  const result = await executeManifestCleanup({ runId: RUN_ID, slotStates: allStates('RECONCILED'), ledger: fakeLedger(), adapters, journal, allowedIdFragments: FRAGMENTS })
  assert.equal(result.status, 'CLEANUP_PARTIAL')
  assert.equal(result.deleted.firestorePaths.length, 1)
  assert.equal(calls.deleteDoc.length, 2)
  assert.equal(calls.deleteAuthUser.length, 0)
  assert.ok(journal.events.some(e => e.status === 'RECOVERY_REQUIRED'))
})

test('negative: verify-clean catches a leftover document after reported-successful deletes -> CLEANUP_VERIFY_MISMATCH', async () => {
  const journal = fakeJournal()
  const { adapters } = fakeAdapters({ async readDoc(path) {
    if (path === 'companies/co-a/members/mailbox-uid') return { exists: true, stateSha256: '11'.repeat(32) }
    return { exists: true, stateSha256: null }
  } })
  const result = await executeManifestCleanup({ runId: RUN_ID, slotStates: allStates('RECONCILED'), ledger: fakeLedger(), adapters, journal, allowedIdFragments: FRAGMENTS })
  assert.equal(result.status, 'CLEANUP_VERIFY_MISMATCH')
  assert.ok(result.remainder.length > 0)
  assert.ok(journal.events.some(e => e.status === 'RECOVERY_REQUIRED'))
})

test('negative: verify-clean by email catches a remaining Auth account even when uid/doc checks pass', async () => {
  const journal = fakeJournal()
  const { adapters } = fakeAdapters({ async authUserExistsByEmail() { return true } })
  const result = await executeManifestCleanup({ runId: RUN_ID, slotStates: allStates('RECONCILED'), ledger: fakeLedger(), adapters, journal, allowedIdFragments: FRAGMENTS })
  assert.equal(result.status, 'CLEANUP_VERIFY_MISMATCH')
  assert.deepEqual(result.remainder, [{ kind: 'auth-email' }])
})

test('mutation-significance: a ledger claiming more than CLEANUP_MAX auth uids is rejected (guard is load-bearing, not decorative)', () => {
  assert.equal(CLEANUP_MAX.authUids, 2)
  assert.throws(() => validateLedger(fakeLedger({ createdAuthUids: ['a', 'b', 'c'] }), { runId: RUN_ID, allowedIdFragments: FRAGMENTS }))
})
