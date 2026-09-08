import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { CALLABLE_CAPS, FIXTURE_MUTATION_SLOT_SPECS, READBACK_CHECKS, TRANSPORT_CAPS } from './liveAcceptanceCore.mjs'
import {
  ACTIVE_RULES_SHA256, FIELD_OVERRIDES_SHA256, LIVE_FUNCTIONS, READ_ONLY_SLOT_SPECS,
  assertPrivateRecoveryMaterial, createDurableLiveJournal, createLiveStagingExecutor, createRealCooldownGate,
  createVisibleOwnerHandoff, runFreshLivePreflight, validateAcceptanceObservationBundle,
  validateExecutorStateAliases, readPrivateExecutorRecovery,
} from './liveAcceptanceExecutorCore.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const observedAt = '2026-09-08T12:00:00.000Z'
const nowMs = () => Date.parse(observedAt)
const head = 'a'.repeat(40)
const functionItems = LIVE_FUNCTIONS.map(name => ({
  name, state: 'ACTIVE', generation: 2, runtime: 'nodejs22', region: 'us-central1',
  memory: '256Mi', cpu: 1, concurrency: 1, minInstances: 0, maxInstances: 1, timeoutSeconds: 60,
}))
const expectedPreflight = {
  sourceHead: head, functionsSha256: h(JSON.stringify(functionItems)), authMetadataSha256: h('auth-metadata'),
  stagingFingerprint: h('six-fields'), mailboxSha256: h('owner-subject'),
}

function preflightAdapters(override = {}) {
  return {
    project: async () => ({ projectId: 'finapp-staging', databaseId: '(default)', databaseLocation: 'eur3',
      databaseType: 'FIRESTORE_NATIVE', billingEnabled: true, sourceHead: head, observedAt }),
    functions: async () => ({ items: functionItems, inventorySha256: expectedPreflight.functionsSha256,
      authzProbeAbsent: true, sourceHead: head, observedAt }),
    rules: async () => ({ canonicalSha256: ACTIVE_RULES_SHA256, observedAt }),
    indexes: async () => ({ invitationIndexState: 'READY', fieldOverrideCount: 1,
      fieldOverridesSha256: FIELD_OVERRIDES_SHA256, observedAt }),
    auth: async () => ({ emailPasswordEnabled: true, userSignupDisabled: false, verificationMethodPresent: true,
      verificationTemplateMetadataPresent: true, callbackDomainPresent: true,
      metadataSha256: expectedPreflight.authMetadataSha256, observedAt }),
    maintenance: async () => ({ state: 'ABSENT', observedAt }),
    subjectAbsence: async () => ({ mailboxSha256: expectedPreflight.mailboxSha256,
      accountExists: false, profileExists: false, observedAt }),
    build: async () => ({ sourceHead: head, stagingFingerprint: expectedPreflight.stagingFingerprint,
      servedFrom: 'http://127.0.0.1:5177', sixFieldsVerified: true, observedAt }),
    ...override,
  }
}

function newJournal(t, now = () => observedAt, io = fs) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finapp-live-executor-'))
  const repoRoot = path.join(base, 'repo'), evidence = path.join(base, 'evidence')
  fs.mkdirSync(repoRoot); fs.mkdirSync(evidence)
  t.after(() => { fs.rmSync(base, { recursive: true, force: true }) })
  const filename = path.join(evidence, 'journal.jsonl')
  return { filename, repoRoot, journal: createDurableLiveJournal({ filename, repoRoot, now, io }) }
}

test('fresh preflight requires all eight current fail-closed adapters before writes', async () => {
  const receipt = await runFreshLivePreflight({ adapters: preflightAdapters(), expected: expectedPreflight, now: nowMs })
  assert.equal(receipt.status, 'PRECONDITIONS_VERIFIED')
  assert.equal(receipt.cloudMutations, 0)
  assert.equal(JSON.stringify(receipt).includes('@'), false)
  await assert.rejects(() => runFreshLivePreflight({
    adapters: preflightAdapters({ maintenance: async () => ({ state: 'ACTIVE', observedAt }) }),
    expected: expectedPreflight, now: nowMs,
  }))
  await assert.rejects(() => runFreshLivePreflight({
    adapters: preflightAdapters({ subjectAbsence: async () => ({ mailboxSha256: expectedPreflight.mailboxSha256,
      accountExists: true, profileExists: false, observedAt }) }), expected: expectedPreflight, now: nowMs,
  }))
  await assert.rejects(() => runFreshLivePreflight({
    adapters: preflightAdapters({ rules: async () => ({ canonicalSha256: h('drift'), observedAt }) }),
    expected: expectedPreflight, now: nowMs,
  }))
})

test('durable journal uses wx, fsyncs every transition and rejects reuse or an in-checkout path', t => {
  let fsyncs = 0
  const io = new Proxy(fs, { get(target, property) {
    if (property === 'fsyncSync') return descriptor => { fsyncs++; return target.fsyncSync(descriptor) }
    return Reflect.get(target, property)
  } })
  const { filename, repoRoot, journal } = newJournal(t, () => observedAt, io)
  journal.append('PRECONDITIONS_VERIFIED')
  journal.append('PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED', { envelopeSha256: h('envelope') })
  assert.equal(journal.events().length, 2)
  assert.equal(journal.bytes().toString('utf8').endsWith('\n'), true)
  assert.equal(fsyncs, 2)
  const closed = journal.close()
  assert.equal(closed.eventCount, 2)
  assert.equal(fsyncs, 3)
  assert.throws(() => createDurableLiveJournal({ filename, repoRoot }))
  assert.throws(() => createDurableLiveJournal({ filename: path.join(repoRoot, 'journal.jsonl'), repoRoot }))

  const failingIo = new Proxy(fs, { get(target, property) {
    if (property === 'fsyncSync') return () => { throw new Error('synthetic fsync failure') }
    return Reflect.get(target, property)
  } })
  const failed = newJournal(t, () => observedAt, failingIo).journal
  assert.throws(() => failed.append('PRECONDITIONS_VERIFIED'))
  assert.throws(() => failed.append('PRECONDITIONS_VERIFIED'))
})

test('real cooldown requires both wall and monotonic clocks to advance by 60 seconds', async () => {
  let wall = 1_000, monotonic = 10
  const sleeps = []
  const gate = createRealCooldownGate({ wallNow: () => wall, monotonicNow: () => monotonic,
    sleep: async ms => { sleeps.push(ms); wall += ms; monotonic += ms } })
  gate.start()
  assert.equal(gate.isReady(), false)
  const proof = await gate.wait()
  assert.ok(proof.wallElapsedMs >= 60_000)
  assert.ok(proof.monotonicElapsedMs >= 60_000)
  assert.ok(sleeps.length >= 60)
  assert.equal(gate.isReady(), true)
  await assert.rejects(() => gate.wait())

  let backwards = 100
  const rollback = createRealCooldownGate({ wallNow: () => backwards, monotonicNow: () => backwards,
    sleep: async () => { backwards-- } })
  rollback.start()
  await assert.rejects(() => rollback.wait())
})

test('visible owner handoff exposes commitments and booleans without generic page access', async () => {
  const calls = []
  const methods = {
    inspectBoundary: async () => ({ visible: true, persistent: false, fragmentRemovedBeforeInit: true,
      financialModulesLoaded: false, cachedCompanyDataLoaded: false, capabilityPersisted: false }),
    confirmCredentialReady: async () => ({ ready: true, minimumLengthSatisfied: true }),
    prepareRegistration: async () => ({ requestSha256: h('registration'), binding: { identity: 'ownerMailbox', subjectSha256: expectedPreflight.mailboxSha256 } }),
    dispatchRegistration: async permit => ({ requestSha256: permit.requestSha256, outcomeSha256: h('registered') }),
    prepareVerification: async () => ({ requestSha256: h('verification') }),
    dispatchVerification: async permit => ({ requestSha256: permit.requestSha256, outcomeSha256: h('sent') }),
    confirmVerifiedSession: async challenge => ({ ...challenge, verified: true, reloaded: true, forcedRefresh: true }),
    close: async () => { calls.push('closed') },
  }
  const handoff = createVisibleOwnerHandoff({
    openSession: async options => { calls.push(options); return methods },
    pause: async value => { calls.push(value); return { acknowledged: true } },
  })
  await handoff.open()
  await handoff.awaitCredentialReady()
  const registration = await handoff.prepareRegistration()
  assert.equal('value' in registration, false)
  assert.equal((await handoff.dispatchRegistration({ requestSha256: registration.requestSha256 })).outcomeSha256, h('registered'))
  const verification = await handoff.prepareVerification()
  await handoff.dispatchVerification({ requestSha256: verification.requestSha256 })
  const challenge = { challengeSha256: h('session-challenge') }
  const proof = await handoff.awaitVerifiedSession(challenge)
  assert.equal(proof.sessionProofSha256, h(JSON.stringify({ ...challenge, verified: true, reloaded: true, forcedRefresh: true })))
  await handoff.close()
  assert.equal(calls[0].headless, false)
  assert.equal(calls[0].recordHar, false)
  assert.equal(JSON.stringify(calls).includes('@'), false)
  const leaking = createVisibleOwnerHandoff({ openSession: async () => ({ ...methods, evaluate: async () => 'private' }), pause: async () => ({ acknowledged: true }) })
  await assert.rejects(() => leaking.open())
})

function fixtureRows() {
  const ownerA = 'uid_owner_a', ownerB = 'uid_owner_b', ownerSubject = 'uid_owner_subject'
  const companyA = 'company_alpha', companyB = 'company_beta'
  const cancelled = 'invite_cancelled', final = 'invite_final', existing = 'invite_existing'
  const cancelledCapability = h('cancelled-capability'), oldFinalCapability = h('old-final-capability')
  const finalCapability = h('final-capability'), existingCapability = h('existing-capability')
  const subjectLock = h('subject-lock'), existingLock = h('existing-lock')
  return [
    ['createOwnerAAuth', { identity: 'ownerA', subjectSha256: h('owner-a-subject') }, { ownerAUid: ownerA }],
    ['createCompanyA', { identity: 'ownerA', actorUid: ownerA, idempotencyKeySha256: h('idem-a') }, { companyAId: companyA }],
    ['createOwnerBAuth', { identity: 'ownerB', subjectSha256: h('owner-b-subject') }, { ownerBUid: ownerB }],
    ['createCompanyB', { identity: 'ownerB', actorUid: ownerB, idempotencyKeySha256: h('idem-b') }, { companyBId: companyB }],
    ['createMailboxCancelledInvite', { identity: 'ownerA', actorUid: ownerA, companyId: companyA,
      subjectSha256: expectedPreflight.mailboxSha256, role: 'accountant' },
    { mailboxCancelledInviteId: cancelled, mailboxCancelledCapabilitySha256: cancelledCapability, mailboxLockId: subjectLock }],
    ['cancelMailboxInvite', { identity: 'ownerA', actorUid: ownerA, companyId: companyA, invitationId: cancelled }, {}],
    ['createMailboxFinalInvite', { identity: 'ownerA', actorUid: ownerA, companyId: companyA,
      subjectSha256: expectedPreflight.mailboxSha256, role: 'accountant' },
    { mailboxFinalInviteId: final, mailboxFinalCapabilitySha256: oldFinalCapability, mailboxLockId: subjectLock }],
    ['denyMailboxResendCooldown', { identity: 'ownerA', actorUid: ownerA, companyId: companyA, invitationId: final }, {}],
    ['resendMailboxFinalInvite', { identity: 'ownerA', actorUid: ownerA, companyId: companyA, invitationId: final },
    { mailboxFinalCapabilitySha256: finalCapability }],
    ['createOwnerMailboxAuth', { identity: 'ownerMailbox', subjectSha256: expectedPreflight.mailboxSha256 }, { ownerMailboxUid: ownerSubject }],
    ['denyWrongIdentityAccept', { identity: 'ownerB', actorUid: ownerB, invitationId: final, capabilitySha256: finalCapability }, {}],
    ['denyUnverifiedMailboxAccept', { identity: 'ownerMailbox', actorUid: ownerSubject, invitationId: final, capabilitySha256: finalCapability }, {}],
    ['acceptMailboxFinalInvite', { identity: 'ownerMailbox', actorUid: ownerSubject, invitationId: final, capabilitySha256: finalCapability }, {}],
    ['createOwnerBInvite', { identity: 'ownerA', actorUid: ownerA, companyId: companyA, subjectSha256: h('owner-b-subject'), role: 'viewer' },
    { ownerBInviteId: existing, ownerBCapabilitySha256: existingCapability, ownerBLockId: existingLock }],
    ['acceptOwnerBInvite', { identity: 'ownerB', actorUid: ownerB, invitationId: existing, capabilitySha256: existingCapability }, {}],
    ['replayMailboxFinalInvite', { identity: 'ownerMailbox', actorUid: ownerSubject, invitationId: final, capabilitySha256: finalCapability }, {}],
  ]
}

function observationBundle(callableCounts, state) {
  const times = index => `2026-09-08T12:01:${String(index).padStart(2, '0')}.123456789Z`
  return {
    readbacks: READBACK_CHECKS.map((check, index) => ({ check, stateSha256: h(`readback-${index}`), updateTime: times(index) })),
    auditEvents: [
      ['companyACreated', 'a'], ['companyBCreated', 'b'], ['mailboxCancelledCreated', 'a'],
      ['mailboxCancelled', 'a'], ['mailboxFinalCreated', 'a'], ['mailboxFinalResent', 'a'],
      ['mailboxFinalAccepted', 'a'], ['ownerBInviteCreated', 'a'], ['ownerBInviteAccepted', 'a'],
    ].map(([slot, company], index) => ({ slot, company, id: `audit_${index}`, stateSha256: h(`audit-${index}`),
      createTime: times(index + 10), updateTime: times(index + 10) })),
    replay: {
      invitationUpdateTimeBefore: times(30), invitationUpdateTimeAfter: times(30),
      membershipUpdateTimeBefore: times(31), membershipUpdateTimeAfter: times(31),
      profileUpdateTimeBefore: times(32), profileUpdateTimeAfter: times(32),
      auditCountBefore: 9, auditCountAfter: 9,
    },
    callableCounts,
    transportCounts: { authorizedRequests: 25, dispatchedRequests: 25, oauthRefreshes: 0, verificationDispatches: 1 },
    state,
  }
}

function readOnlyBinding(spec, state) {
  const actorUid = { ownerA: state.ownerAUid, ownerB: state.ownerBUid, ownerMailbox: state.ownerMailboxUid }[spec.identity]
  const companyId = { companyA: state.companyAId, companyB: state.companyBId }[spec.entity]
  if (spec.callable === 'listInvitations') return { identity: spec.identity, actorUid, companyId, expectation: spec.expectation }
  if (spec.callable === 'previewInvite') return {
    identity: spec.identity,
    invitationId: { mailboxCancelledInvite: state.mailboxCancelledInviteId, mailboxFinalInvite: state.mailboxFinalInviteId }[spec.entity],
    capabilitySha256: {
      mailboxCancelledCapability: state.mailboxCancelledCapabilitySha256,
      mailboxPreviousCapability: state.mailboxPreviousCapabilitySha256,
      mailboxFinalCapability: state.mailboxFinalCapabilitySha256,
    }[spec.capability],
    expectation: spec.expectation,
  }
  return { identity: spec.identity, actorUid, companyId, expectation: spec.expectation }
}

test('executor orders exact slot commitments, enforces cooldown and emits cleanup plan only', async t => {
  const { journal } = newJournal(t)
  let wall = 0, monotonic = 0
  const gate = createRealCooldownGate({ wallNow: () => wall, monotonicNow: () => monotonic,
    sleep: async ms => { wall += ms; monotonic += ms } })
  const executor = createLiveStagingExecutor({ journal, preflightAdapters: preflightAdapters(), expectedPreflight,
    initial: { runId: 'stage8-run-001', mailboxSha256: expectedPreflight.mailboxSha256,
      ownerASubjectSha256: h('owner-a-subject'), ownerBSubjectSha256: h('owner-b-subject') }, nowMs, cooldownGate: gate })
  await executor.start()

  const rows = fixtureRows()
  let readOnlyIndex = 0
  const executeReadOnly = async (spec, bindingOverride = null) => {
    const safeState = executor.snapshot().state
    const requestSha256 = h(`request-${spec.slot}`), outcomeSha256 = h(`outcome-${spec.slot}`)
    const binding = bindingOverride ?? readOnlyBinding(spec, safeState)
    return executor.executeReadOnlyCallable({ slot: spec.slot, callable: spec.callable, requestSha256, binding,
      dispatch: async permit => {
        assert.equal(permit.slot, spec.slot)
        assert.equal(permit.bindingSha256, h(JSON.stringify({ slot: spec.slot, callable: spec.callable, binding })))
        return { requestSha256: permit.requestSha256, outcomeSha256, producedSha256: h('{}') }
      },
      readback: async () => ({ requestSha256, outcomeSha256, readbackSha256: h(`readback-${spec.slot}`), produced: {} }) })
  }
  for (let index = 0; index < rows.length; index++) {
    const [slot, binding, produced] = rows[index]
    const requestSha256 = h(`request-${slot}`), outcomeSha256 = h(`outcome-${slot}`)
    const execute = () => executor.executeFixtureSlot({ slot, requestSha256, binding,
      dispatch: async permit => {
        assert.equal(permit.slot, slot)
        assert.equal(permit.requestSha256, requestSha256)
        assert.equal(Buffer.from(permit.journalBytes).toString('utf8').includes('FIXTURE_MUTATION_MAY_BE_SENT'), true)
        return { requestSha256, outcomeSha256, producedSha256: h(JSON.stringify(produced)) }
      },
      readback: async () => ({ requestSha256, outcomeSha256, readbackSha256: h(`readback-${slot}`), produced }) })
    if (slot === 'resendMailboxFinalInvite') {
      await assert.rejects(execute)
      await executor.awaitResendCooldown()
    }
    if (slot === 'acceptMailboxFinalInvite') {
      await assert.rejects(execute)
      const challenge = executor.verificationSessionChallenge()
      const verified = { ...challenge, verified: true, reloaded: true, forcedRefresh: true }
      assert.throws(() => executor.markVerifiedSession({ ...verified, sessionProofSha256: h(JSON.stringify(verified)) }))
      const sessionMethods = {
        inspectBoundary: async () => ({ visible: true, persistent: false, fragmentRemovedBeforeInit: true,
          financialModulesLoaded: false, cachedCompanyDataLoaded: false, capabilityPersisted: false }),
        confirmCredentialReady: async () => ({ ready: true, minimumLengthSatisfied: true }),
        prepareRegistration: async () => ({ requestSha256: h('unused-registration'), binding: {} }),
        dispatchRegistration: async () => ({}), prepareVerification: async () => ({ requestSha256: h('unused-verification') }),
        dispatchVerification: async () => ({}),
        confirmVerifiedSession: async value => ({ ...value, verified: true, reloaded: true, forcedRefresh: true }), close: async () => {},
      }
      const handoff = createVisibleOwnerHandoff({ openSession: async () => sessionMethods, pause: async () => ({ acknowledged: true }) })
      await handoff.open()
      const proof = await handoff.awaitVerifiedSession(challenge)
      executor.markVerifiedSession(proof)
      await handoff.close()
      assert.equal(journal.events().at(-1).status, 'VERIFIED_SESSION_COMMITTED')
    }
    await execute()
    if (slot === 'denyUnverifiedMailboxAccept') {
      const requestSha256 = h('verification-request'), outcomeSha256 = h('verification-sent')
      await executor.executeVerificationEmail({ requestSha256,
        dispatch: async permit => ({ requestSha256: permit.requestSha256, outcomeSha256 }) })
    }
    if (index === 4) {
      const [blockedSlot, blockedBinding] = rows[index + 1]
      let dispatches = 0
      const eventCount = journal.events().length
      await assert.rejects(() => executor.executeFixtureSlot({
        slot: blockedSlot, requestSha256: h('skip-required-read-only'), binding: blockedBinding,
        dispatch: async () => { dispatches++; return {} }, readback: async () => ({}),
      }))
      assert.equal(dispatches, 0)
      assert.equal(journal.events().length, eventCount)
    }
    while (READ_ONLY_SLOT_SPECS[readOnlyIndex]?.afterFixtureCount === index + 1) {
      const spec = READ_ONLY_SLOT_SPECS[readOnlyIndex]
      if (spec.slot === 'previewFinalPreviousDenied') {
        const mismatchedPair = readOnlyBinding(spec, executor.snapshot().state)
        mismatchedPair.invitationId = executor.snapshot().state.mailboxCancelledInviteId
        await assert.rejects(() => executeReadOnly(spec, mismatchedPair))
      }
      await executeReadOnly(spec)
      if (spec.slot === 'previewCancelledActive') await assert.rejects(() => executeReadOnly(spec))
      readOnlyIndex++
    }
  }
  assert.equal(readOnlyIndex, READ_ONLY_SLOT_SPECS.length)
  const plan = executor.materializeFixturePlan()
  assert.equal(plan.companies[0].id, 'company_alpha')
  const counts = Object.fromEntries(Object.keys(CALLABLE_CAPS).map(name => [name, 0]))
  for (const event of journal.events()) if (['FIXTURE_MUTATION_MAY_BE_SENT', 'CALLABLE_REQUEST_MAY_BE_SENT'].includes(event.status) && event.details.callable) counts[event.details.callable]++
  const rawBundle = observationBundle(counts, executor.snapshot().state)
  const { state: ignoredState, ...bundle } = rawBundle
  assert.ok(ignoredState)
  assert.throws(() => validateAcceptanceObservationBundle(plan, {
    ...bundle, replay: { ...bundle.replay, auditCountBefore: 7, auditCountAfter: 7 },
  }, executor.snapshot().state, journal.events()))
  const validated = executor.verifyAcceptance(bundle)
  assert.match(validated.observationsSha256, /^[a-f0-9]{64}$/)
  const cleanup = executor.buildCleanupPlanOnly(bundle)
  assert.equal(cleanup.status, 'CLEANUP_PLAN_ONLY')
  assert.equal(cleanup.executionEnabled, false)
  assert.deepEqual(cleanup.targets.destructive.authUids, ['uid_owner_a', 'uid_owner_b'])
  assert.equal(cleanup.targets.destructive.authUids.includes('uid_owner_subject'), false)
  assert.equal(journal.events().at(-1).status, 'CLEANUP_DEFERRED')
  const recovery = readPrivateExecutorRecovery(journal)
  assert.equal(recovery.lifecycle, 'COMPLETE')
  assert.equal(Object.keys(recovery.fixtureSlots).length, FIXTURE_MUTATION_SLOT_SPECS.length)
  assert.equal(Object.values(recovery.fixtureSlots).every(row => row.state === 'RECONCILED'), true)
  assert.equal(Object.values(recovery.readOnlySlots).every(row => row.state === 'RECONCILED'), true)
  assert.equal(recovery.verificationEmail.state, 'SENT')
  journal.close()
})

test('executor fails closed on slot/body/ID drift and observation replay changes', async t => {
  const { journal } = newJournal(t)
  const executor = createLiveStagingExecutor({ journal, preflightAdapters: preflightAdapters(), expectedPreflight,
    initial: { runId: 'stage8-run-002', mailboxSha256: expectedPreflight.mailboxSha256,
      ownerASubjectSha256: h('owner-a-subject'), ownerBSubjectSha256: h('owner-b-subject') }, nowMs,
    cooldownGate: createRealCooldownGate({ wallNow: () => 0, monotonicNow: () => 0, sleep: async () => {} }) })
  await executor.start()
  await assert.rejects(() => executor.executeFixtureSlot({ slot: 'createCompanyA', requestSha256: h('wrong-order'), binding: {}, dispatch: async () => ({}), readback: async () => ({}) }))
  await assert.rejects(() => executor.executeFixtureSlot({ slot: 'createOwnerAAuth', requestSha256: h('body'),
    binding: { identity: 'ownerA', subjectSha256: h('foreign-subject') }, dispatch: async () => ({}), readback: async () => ({}) }))
  assert.equal(journal.events().at(-1).status, 'SCENARIOS_RUNNING')

  const requestSha256 = h('body'), outcomeSha256 = h('outcome')
  await executor.executeFixtureSlot({ slot: 'createOwnerAAuth', requestSha256,
    binding: { identity: 'ownerA', subjectSha256: h('owner-a-subject') },
    dispatch: async () => ({ requestSha256, outcomeSha256, producedSha256: h(JSON.stringify({ ownerAUid: 'uid_owner_a' })) }),
    readback: async () => ({ requestSha256: h('altered-body'), outcomeSha256, readbackSha256: h('readback'), produced: { ownerAUid: 'uid_owner_a' } })
  }).then(() => assert.fail('altered readback must be terminal'), () => {})
  assert.equal(journal.events().at(-2).status, 'FIXTURE_MUTATION_UNCERTAIN')
  assert.equal(journal.events().at(-1).status, 'FAILED')
  const uncertainRecovery = readPrivateExecutorRecovery(journal)
  assert.equal(uncertainRecovery.lifecycle, 'RECOVERY_REQUIRED')
  assert.equal(uncertainRecovery.fixtureSlots.createOwnerAAuth.state, 'UNCERTAIN')
  assert.equal(uncertainRecovery.fixtureSlots.createCompanyA.state, 'NOT_STARTED')

  const fakePlan = { version: 0 }
  assert.throws(() => validateAcceptanceObservationBundle(fakePlan, {}, {}, []))
  const aliases = {
    ownerAUid: 'owner_a', ownerBUid: 'owner_b', ownerMailboxUid: 'owner_subject',
    companyAId: 'company_a', companyBId: 'company_b', mailboxCancelledInviteId: 'invite_1',
    mailboxFinalInviteId: 'invite_2', ownerBInviteId: 'invite_3', mailboxLockId: h('lock-a'), ownerBLockId: h('lock-b'),
    mailboxCancelledCapabilitySha256: h('cap-a'), mailboxPreviousCapabilitySha256: h('cap-b'),
    mailboxFinalCapabilitySha256: h('cap-c'), ownerBCapabilitySha256: h('cap-d'),
  }
  assert.equal(validateExecutorStateAliases(aliases), true)
  for (const override of [
    { ownerBUid: aliases.ownerAUid }, { companyBId: aliases.ownerAUid },
    { mailboxFinalInviteId: aliases.companyAId }, { ownerBLockId: aliases.mailboxLockId },
    { ownerBCapabilitySha256: aliases.mailboxFinalCapabilitySha256 }, { ownerBLockId: aliases.mailboxFinalCapabilitySha256 },
  ]) assert.throws(() => validateExecutorStateAliases({ ...aliases, ...override }))
  journal.close()

  const aliasJournal = newJournal(t).journal
  const aliasExecutor = createLiveStagingExecutor({ journal: aliasJournal, preflightAdapters: preflightAdapters(), expectedPreflight,
    initial: { runId: 'stage8-run-003', mailboxSha256: expectedPreflight.mailboxSha256,
      ownerASubjectSha256: h('owner-a-subject'), ownerBSubjectSha256: h('owner-b-subject') }, nowMs })
  await aliasExecutor.start()
  const firstRequest = h('first-request'), firstOutcome = h('first-outcome'), firstProduced = { ownerAUid: 'uid_owner_a' }
  await aliasExecutor.executeFixtureSlot({ slot: 'createOwnerAAuth', requestSha256: firstRequest,
    binding: { identity: 'ownerA', subjectSha256: h('owner-a-subject') },
    dispatch: async () => ({ requestSha256: firstRequest, outcomeSha256: firstOutcome, producedSha256: h(JSON.stringify(firstProduced)) }),
    readback: async () => ({ requestSha256: firstRequest, outcomeSha256: firstOutcome, readbackSha256: h('first-readback'), produced: firstProduced }) })
  const aliasRequest = h('alias-request'), aliasOutcome = h('alias-outcome'), aliasProduced = { companyAId: 'uid_owner_a' }
  await assert.rejects(() => aliasExecutor.executeFixtureSlot({ slot: 'createCompanyA', requestSha256: aliasRequest,
    binding: { identity: 'ownerA', actorUid: 'uid_owner_a', idempotencyKeySha256: h('alias-idem') },
    dispatch: async () => ({ requestSha256: aliasRequest, outcomeSha256: aliasOutcome, producedSha256: h(JSON.stringify(aliasProduced)) }),
    readback: async () => ({ requestSha256: aliasRequest, outcomeSha256: aliasOutcome, readbackSha256: h('alias-readback'), produced: aliasProduced }) }))
  assert.equal(aliasJournal.events().at(-2).status, 'FIXTURE_MUTATION_UNCERTAIN')
  assert.equal(aliasJournal.events().at(-1).status, 'FAILED')
  aliasJournal.close()
})

test('private recovery safety rejects credentials, provider errors and raw capabilities', () => {
  assert.equal(assertPrivateRecoveryMaterial({ idempotencyKey: 'idem-safe-1234567890', capabilitySha256: h('capability') }), true)
  for (const value of [
    { password: 'synthetic-password' },
    { providerBody: { opaque: true } },
    { providerError: 'permission denied' },
    { rawCapability: 'raw-invite-capability' },
    { value: 'owner@example.invalid' },
    { value: 'Bearer opaque-credential' },
  ]) assert.throws(() => assertPrivateRecoveryMaterial(value))
})
