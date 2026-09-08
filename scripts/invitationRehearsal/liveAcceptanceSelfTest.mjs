import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  CALLABLE_CAPS, FIXTURE_MUTATION_SLOT_SPECS, FIXTURE_MUTATION_SLOTS, OAUTH_REFRESH_URL, PINNED_DISCOVERY_SHA256, PROJECT, SCENARIO_NAMES, TOTAL_CALLABLE_CAP, appendJournalEvent,
  authorizePendingDispatchJournal, buildCleanupTargets, buildFixtureEnvelope, buildFixturePlan, liveAcceptanceGuard, liveAcceptanceTransport,
  classifyLiveEndpoint, prepareLiveAcceptance, recoverLiveAcceptanceJournal, sanitizePublicResult, validateCleanupTargets, validateCompleteJournal,
  validateFixturePlan, validateJournalTransition, validateMailboxDiscoveryReceipt,
} from './liveAcceptanceCore.mjs'

const at = '2026-09-08T12:00:00.000Z'
const receipt = Buffer.from(`{
  "task": "SEC-006 Stage 8 mailbox discovery",
  "status": "MAILBOX_DISCOVERY_COMPLETE",
  "project": "finapp-staging",
  "capturedAt": "2026-09-08T12:11:38.550Z",
  "accountExists": false,
  "account": null,
  "profile": {
    "profileExists": false,
    "profileFieldsSha256": null
  },
  "cloudMutations": 0,
  "emailsSent": 0,
  "sourceHead": "5e476df19c5ad3e90184a6191430d94c23fea99a"
}
`, 'utf8')
const h = char => char.repeat(64)
const sha = value => createHash('sha256').update(value).digest('hex')
const ids = {
  companyIds: { a: 'company_alpha', b: 'company_beta' },
  syntheticAuthUids: { ownerA: 'uid_owner_a', ownerB: 'uid_owner_b' },
  ownerMailboxUid: 'uid_owner_mailbox',
  lockIds: { mailbox: h('a'), ownerB: h('b') },
}

const plan = () => buildFixturePlan({ runId: 'stage8-run-001', mailboxSha256: h('c'), ...ids })
const observed = () => ({
  invitationIds: { mailboxCancelled: 'invite_1', mailboxFinal: 'invite_2', ownerBExisting: 'invite_3' },
  auditEventIds: [
    ['companyACreated', 'a'], ['companyBCreated', 'b'], ['mailboxCancelledCreated', 'a'],
    ['mailboxCancelled', 'a'], ['mailboxFinalCreated', 'a'], ['mailboxFinalResent', 'a'],
    ['mailboxFinalAccepted', 'a'], ['ownerBInviteCreated', 'a'], ['ownerBInviteAccepted', 'a'],
  ].map(([slot, company], index) => ({ slot, company, id: `audit_${index + 1}` })),
})

test('guard delegates exact clean 40-hex staging HEAD checks', () => {
  const head = 'd'.repeat(40)
  assert.doesNotThrow(() => liveAcceptanceGuard({ project: PROJECT, expectedHead: head }, { head, status: '', env: {} }))
  assert.throws(() => liveAcceptanceGuard({ project: 'production', expectedHead: head }, { head, status: '', env: {} }))
  assert.throws(() => liveAcceptanceGuard({ project: PROJECT, expectedHead: 'short' }, { head: 'short', status: '', env: {} }))
  assert.throws(() => liveAcceptanceGuard({ project: PROJECT, expectedHead: head }, { head, status: ' M file', env: {} }))
})

test('only the pinned absent-account discovery artifact is accepted', () => {
  const result = validateMailboxDiscoveryReceipt(receipt)
  assert.equal(result.receiptSha256, PINNED_DISCOVERY_SHA256)
  assert.equal(result.accountExists, false)
  for (const mutate of [
    value => { value.accountExists = true },
    value => { value.cloudMutations = 1 },
    value => { value.emailsSent = 1 },
    value => { value.sourceHead = 'd'.repeat(40) },
    value => { value.rawMailbox = 'owner@example.test' },
    value => { value.profile.profileFieldsSha256 = h('a') },
  ]) {
    const value = JSON.parse(receipt)
    mutate(value)
    assert.throws(() => validateMailboxDiscoveryReceipt(JSON.stringify(value)))
  }
  assert.throws(() => validateMailboxDiscoveryReceipt(Buffer.concat([receipt, Buffer.from(' ')])))
})

test('pure prepare preflight binds clean HEAD, receipt, mailbox hash and static files without leaking mailbox', async () => {
  const head = 'd'.repeat(40)
  const result = await prepareLiveAcceptance({
    options: { project: PROJECT, expectedHead: head, runId: 'stage8-run-001' },
    gitState: async () => ({ head, status: '', env: {} }), mailboxText: ' Owner@Example.Test ',
    discoveryReceipt: receipt, distFiles: [{ path: 'dist/index.html', sha256: h('a') }], now: () => at,
  })
  assert.equal(result.status, 'LIVE_ACCEPTANCE_PREPARED')
  assert.equal(result.cloudMutations, 0)
  assert.equal(result.emailsSent, 0)
  assert.equal(JSON.stringify(result).includes('owner@example.test'), false)
  await assert.rejects(() => prepareLiveAcceptance({
    options: { project: PROJECT, expectedHead: head, runId: 'stage8-run-001' },
    gitState: { head, status: '', env: {} }, mailboxText: 'owner@example.test', discoveryReceipt: receipt,
    distFiles: [{ path: '../secret', sha256: h('a') }], now: () => at,
  }))
})

test('fixture plan has exact bounded identities, paths, lock IDs and no raw mailbox', () => {
  const value = plan()
  assert.deepEqual(value.counts, { companies: 2, syntheticAuthUsers: 2, ownerMailboxAccounts: 1, invitations: 3, memberships: 4, invitationLocks: 2, auditEvents: 9 })
  assert.equal(value.companies.length, 2)
  assert.equal(value.authUsers.filter(row => row.disposition === 'DELETE').length, 2)
  assert.equal(value.authUsers.filter(row => row.disposition === 'PRESERVE_AUTH').length, 1)
  assert.equal(value.members.length, 4)
  assert.equal(value.members.some(row => row.path === 'companies/company_alpha/members/uid_owner_b'), true)
  assert.equal(value.locks.length, 2)
  assert.equal(JSON.stringify(value).includes('@'), false)
  assert.deepEqual(value.dynamicSlots.invitations, ['mailboxCancelled', 'mailboxFinal', 'ownerBExisting'])
  assert.equal(validateFixturePlan(value), true)
  assert.throws(() => { value.members.push({ path: 'companies/foreign/members/foreign' }) })
  const envelope = buildFixtureEnvelope({ runId: value.runId, mailboxSha256: value.mailboxSha256 })
  assert.equal(value.fixtureEnvelopeSha256.length, 64)
  assert.deepEqual(envelope.mutationSlots, FIXTURE_MUTATION_SLOTS)
})

test('fixture plan rejects unsafe run IDs, malformed or aliased exact IDs', () => {
  const base = { runId: 'stage8-run-001', mailboxSha256: h('c'), ...ids }
  for (const override of [
    { runId: '../escape' }, { runId: 'A-bad-run' }, { mailboxSha256: 'bad' },
    { companyIds: { a: 'same', b: 'same' } },
    { ownerMailboxUid: ids.syntheticAuthUids.ownerA },
    { lockIds: { mailbox: h('a'), ownerB: h('a') } },
    { companyIds: { ...ids.companyIds, extra: 'foreign' } },
  ]) assert.throws(() => buildFixturePlan({ ...base, ...override }))
})

const sequence = ({ planSha256 = h('e'), observationsSha256 = h('e') } = {}) => {
  let events = []
  const callableCounts = Object.fromEntries(Object.keys(CALLABLE_CAPS).map(name => [name, 0]))
  let totalCallableCount = 0
  const add = (status, details = {}) => { events = appendJournalEvent(events, { seq: events.length, status, at, details }) }
  add('PRECONDITIONS_VERIFIED')
  add('PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED', { envelopeSha256: h('d') })
  add('SCENARIOS_RUNNING')
  for (const [callable, count] of [['listInvitations', 6], ['previewInvite', 4], ['getCompanyAccess', 4]]) {
    for (let call = 0; call < count; call++) {
      callableCounts[callable]++
      totalCallableCount++
      add('CALLABLE_REQUEST_MAY_BE_SENT', { callable, callableCount: callableCounts[callable], totalCallableCount, requestSha256: h('a'), bindingSha256: h('f') })
      add('CALLABLE_REQUEST_RECONCILED', { callable, callableCount: callableCounts[callable], totalCallableCount, outcomeSha256: h('b'), readbackSha256: h('c'), bindingSha256: h('f') })
    }
  }
  FIXTURE_MUTATION_SLOTS.forEach((slot, index) => {
    const callable = FIXTURE_MUTATION_SLOT_SPECS[index].callable
    const callableCount = callable === null ? null : ++callableCounts[callable]
    if (callable !== null) totalCallableCount++
    add('FIXTURE_MUTATION_MAY_BE_SENT', { index, slot, callCount: index + 1, callable, callableCount, totalCallableCount, requestSha256: h('a') })
    add('FIXTURE_MUTATION_RECONCILED', {
      index, slot, callCount: index + 1, callable, callableCount, totalCallableCount,
      disposition: FIXTURE_MUTATION_SLOT_SPECS[index].disposition,
      outcomeSha256: h('b'), readbackSha256: h('c'),
    })
    if (index === 11) {
      add('EMAIL_REQUEST_MAY_BE_SENT', { requestSha256: h('c') })
      add('EMAIL_SENT', { outcomeSha256: h('d') })
      add('VERIFIED_SESSION_COMMITTED', { challengeSha256: h('f'), sessionProofSha256: h('e') })
    }
  })
  add('MATERIALIZED_FIXTURE_PLAN_COMMITTED', { planSha256 })
  add('ACCEPTANCE_VERIFIED', { observationsSha256 })
  add('CLEANUP_DEFERRED', { cleanupPlanSha256: h('e') })
  return events
}

test('journal is append-only, ordered and contains exactly one email dispatch pair', () => {
  const events = sequence()
  assert.equal(validateCompleteJournal(events), true)
  const firstMay = events.findIndex(row => row.status === 'FIXTURE_MUTATION_MAY_BE_SENT')
  assert.throws(() => validateJournalTransition(events.slice(0, firstMay), {
    seq: firstMay, status: 'FIXTURE_MUTATION_MAY_BE_SENT', at,
    details: {
      index: 1, slot: FIXTURE_MUTATION_SLOTS[1], callCount: 2,
      callable: 'createCompany', callableCount: 1, totalCallableCount: 15, requestSha256: h('a'),
    },
  }))
  assert.throws(() => validateJournalTransition(events, { seq: events.length, status: 'FAILED', at, details: { failureCode: 'VALIDATION' } }))
  assert.throws(() => validateCompleteJournal(events.filter(row => row.status !== 'EMAIL_SENT')))
})

test('unknown fixture mutation outcome is terminal until an explicit FAILED record', () => {
  let events = []
  const add = (status, details = {}) => { events = appendJournalEvent(events, { seq: events.length, status, at, details }) }
  add('PRECONDITIONS_VERIFIED')
  add('PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED', { envelopeSha256: h('d') })
  add('SCENARIOS_RUNNING')
  add('FIXTURE_MUTATION_MAY_BE_SENT', {
    index: 0, slot: FIXTURE_MUTATION_SLOTS[0], callCount: 1,
    callable: null, callableCount: null, totalCallableCount: 0, requestSha256: h('a'),
  })
  add('FIXTURE_MUTATION_UNCERTAIN', {
    index: 0, slot: FIXTURE_MUTATION_SLOTS[0], callable: null,
    callableCount: null, totalCallableCount: 0, outcomeSha256: h('b'),
  })
  assert.throws(() => appendJournalEvent(events, {
    seq: events.length, status: 'FIXTURE_MUTATION_MAY_BE_SENT', at,
    details: {
      index: 0, slot: FIXTURE_MUTATION_SLOTS[0], callCount: 1,
      callable: null, callableCount: null, totalCallableCount: 0, requestSha256: h('a'),
    },
  }))
  assert.doesNotThrow(() => appendJournalEvent(events, { seq: events.length, status: 'FAILED', at, details: { failureCode: 'FIXTURE_MUTATION_UNCERTAIN' } }))
})

test('journal rejects mailbox, tokens, passwords and token-bearing URLs', () => {
  const base = [{ seq: 0, status: 'PRECONDITIONS_VERIFIED', at, details: {} }]
  for (const details of [
    { email: 'redacted' }, { note: 'owner@example.test' }, { password: 'x' },
    { authorization: 'Bearer abc' }, { url: 'https://example.test/?oobCode=secret' },
    { tokenValue: 'opaque' },
  ]) assert.throws(() => validateJournalTransition(base, { seq: 1, status: 'PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED', at, details }))
})

test('dynamic transport allows one exact request and optional one OAuth refresh', async () => {
  const calls = []
  const transport = liveAcceptanceTransport(async (input, init) => { calls.push([String(input), init]); return { ok: true } })
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/u`
  const body = JSON.stringify({ fields: { safe: { booleanValue: true } } })
  const bodySha256 = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(body).digest('hex'))
  transport.authorizeRequest({ method: 'PATCH', url, bodySha256 })
  await transport.fetch(OAUTH_REFRESH_URL, { method: 'POST', body: 'refresh_token=private' })
  await transport.fetch(url, { method: 'PATCH', body })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(([, init]) => init.redirect === 'error'))
  assert.equal(calls[1][1].retries, 0)
  await assert.rejects(() => transport.fetch(url, { method: 'PATCH', body }))
})

test('transport blocks altered URL/body/method, duplicate authorization and library retry after throw', async () => {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${'k'.repeat(12)}`
  const body = '{"safe":true}'
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(body).digest('hex')
  for (const attempt of [
    [url.replace('accounts:signUp', 'projects/finapp-prod/accounts'), { method: 'POST', body }],
    [`${url}?extra=1`, { method: 'POST', body }],
    [url, { method: 'PATCH', body }],
    [url, { method: 'POST', body: `${body} ` }],
  ]) {
    const transport = liveAcceptanceTransport(async () => ({ ok: true }))
    transport.authorizeRequest({ method: 'POST', url, bodySha256: digest })
    await assert.rejects(() => transport.fetch(...attempt))
    await assert.rejects(() => transport.fetch(url, { method: 'POST', body }))
  }
  const transport = liveAcceptanceTransport(async () => { throw new Error('timeout') })
  transport.authorizeRequest({ method: 'POST', url, bodySha256: digest })
  assert.throws(() => transport.authorizeRequest({ method: 'POST', url, bodySha256: digest }))
  await assert.rejects(() => transport.fetch(url, { method: 'POST', body }))
  await assert.rejects(() => transport.fetch(url, { method: 'POST', body }))

  const refresh = liveAcceptanceTransport(async () => { throw new Error('refresh timeout') })
  refresh.authorizeRequest({ method: 'POST', url, bodySha256: digest })
  await assert.rejects(() => refresh.fetch(OAUTH_REFRESH_URL, { method: 'POST', body: 'refresh_token=private' }))
  await assert.rejects(() => refresh.fetch(url, { method: 'POST', body }))
})

test('endpoint allowlist rejects arbitrary same-host paths and invalid collection/document methods', () => {
  assert.equal(classifyLiveEndpoint('POST', `https://us-central1-${PROJECT}.cloudfunctions.net/acceptInvite`).kind, 'callable')
  assert.equal(classifyLiveEndpoint('GET', `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/system/maintenance`).kind, 'firestore')
  for (const [method, url] of [
    ['POST', 'https://identitytoolkit.googleapis.com/v1/arbitrary?key=kkkkkkkkkkkk'],
    ['GET', `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/financialRecords/x`],
    ['PATCH', `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/system/maintenance`],
    ['DELETE', `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users`],
    ['POST', `https://us-central1-${PROJECT}.cloudfunctions.net/arbitrary`],
  ]) assert.throws(() => classifyLiveEndpoint(method, url))
})

test('recovery rejects truncation, malformed, terminal and unknown request state while restoring counters', () => {
  const events = sequence()
  const resumable = events.slice(0, events.findIndex(row => row.status === 'MATERIALIZED_FIXTURE_PLAN_COMMITTED'))
  const bytes = `${resumable.map(JSON.stringify).join('\n')}\n`
  const recovered = recoverLiveAcceptanceJournal(bytes)
  assert.equal(recovered.reconciledMutations, 16)
  assert.equal(recovered.mutationDispatchCount, 16)
  assert.equal(recovered.writeReconciledCount, 12)
  assert.equal(recovered.noWriteReconciledCount, 3)
  assert.equal(recovered.idempotentReadbackCount, 1)
  assert.equal(recovered.callableCounts.previewInvite, 4)
  assert.equal(recovered.totalCallableCount, 27)
  assert.equal(recovered.emailRequestMayBeSentCount, 1)
  assert.equal(recovered.emailSentCount, 1)
  assert.throws(() => recoverLiveAcceptanceJournal(bytes.slice(0, -1)))
  assert.throws(() => recoverLiveAcceptanceJournal(`${bytes}{bad}\n`))
  const unknown = structuredClone(resumable)
  unknown[0].status = 'UNKNOWN_STATUS'
  assert.throws(() => recoverLiveAcceptanceJournal(`${unknown.map(JSON.stringify).join('\n')}\n`))
  assert.throws(() => recoverLiveAcceptanceJournal(`${events.map(JSON.stringify).join('\n')}\n`))
  const mayIndex = events.findIndex(row => row.status === 'EMAIL_REQUEST_MAY_BE_SENT')
  const pending = events.slice(0, mayIndex + 1)
  assert.equal(pending.at(-1).status, 'EMAIL_REQUEST_MAY_BE_SENT')
  assert.throws(() => recoverLiveAcceptanceJournal(`${pending.map(JSON.stringify).join('\n')}\n`))
})

test('pending-dispatch binder replays exact durable fixture/email journals and returns only safe frozen metadata', () => {
  const events = sequence()
  const jsonl = rows => `${rows.map(JSON.stringify).join('\n')}\n`
  const fixtureIndex = events.findIndex(row => row.status === 'FIXTURE_MUTATION_MAY_BE_SENT')
  const fixtureRows = events.slice(0, fixtureIndex + 1)
  const fixture = authorizePendingDispatchJournal(jsonl(fixtureRows), 'fixture')
  assert.deepEqual({ index: fixture.index, slot: fixture.slot, callCount: fixture.callCount, disposition: fixture.disposition }, {
    index: 0, slot: FIXTURE_MUTATION_SLOTS[0], callCount: 1, disposition: 'WRITE',
  })
  assert.equal(fixture.pendingSeq, fixtureRows.length - 1)
  assert.match(fixture.journalSha256, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(fixture), true)

  const emailIndex = events.findIndex(row => row.status === 'EMAIL_REQUEST_MAY_BE_SENT')
  const emailRows = events.slice(0, emailIndex + 1)
  const email = authorizePendingDispatchJournal(jsonl(emailRows), 'email')
  assert.equal(email.reconciledMutations, 12)
  assert.equal(email.emailRequestMayBeSentCount, 1)
  assert.equal('slot' in email, false)

  const badAt = structuredClone(fixtureRows)
  badAt[0].at = 'not-a-time'
  assert.throws(() => authorizePendingDispatchJournal(jsonl(badAt), 'fixture'))
  const badSeq = structuredClone(fixtureRows)
  badSeq.at(-1).seq += 1
  assert.throws(() => authorizePendingDispatchJournal(jsonl(badSeq), 'fixture'))
  const badTransition = fixtureRows.filter(row => row.status !== 'SCENARIOS_RUNNING')
  assert.throws(() => authorizePendingDispatchJournal(jsonl(badTransition), 'fixture'))
  assert.throws(() => authorizePendingDispatchJournal(jsonl(fixtureRows).slice(0, -1), 'fixture'))
  assert.throws(() => authorizePendingDispatchJournal(jsonl(events), 'fixture'))
  assert.throws(() => authorizePendingDispatchJournal(jsonl(fixtureRows), 'unknown'))
})

test('durable callable counters survive independent binders and block preview or total counter overflow', () => {
  let events = []
  const add = (status, details = {}) => { events = appendJournalEvent(events, { seq: events.length, status, at, details }) }
  const jsonl = rows => `${rows.map(JSON.stringify).join('\n')}\n`
  add('PRECONDITIONS_VERIFIED')
  add('PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED', { envelopeSha256: h('d') })
  add('SCENARIOS_RUNNING')
  for (let count = 1; count <= 6; count++) {
    add('CALLABLE_REQUEST_MAY_BE_SENT', { callable: 'previewInvite', callableCount: count, totalCallableCount: count, requestSha256: h('a'), bindingSha256: h('f') })
    add('CALLABLE_REQUEST_RECONCILED', { callable: 'previewInvite', callableCount: count, totalCallableCount: count, outcomeSha256: h('b'), readbackSha256: h('c'), bindingSha256: h('f') })
  }
  add('CALLABLE_REQUEST_MAY_BE_SENT', { callable: 'previewInvite', callableCount: 7, totalCallableCount: 7, requestSha256: h('a'), bindingSha256: h('f') })
  const binderA = authorizePendingDispatchJournal(jsonl(events), 'callable')
  assert.equal(binderA.callableCount, 7)
  assert.equal(binderA.callableCounts.previewInvite, 7)
  add('CALLABLE_REQUEST_RECONCILED', { callable: 'previewInvite', callableCount: 7, totalCallableCount: 7, outcomeSha256: h('b'), readbackSha256: h('c'), bindingSha256: h('f') })
  add('CALLABLE_REQUEST_MAY_BE_SENT', { callable: 'previewInvite', callableCount: 8, totalCallableCount: 8, requestSha256: h('a'), bindingSha256: h('f') })
  const binderB = authorizePendingDispatchJournal(jsonl(events), 'callable')
  assert.equal(binderB.callableCount, 8)
  assert.equal(binderB.totalCallableCount, 8)
  add('CALLABLE_REQUEST_RECONCILED', { callable: 'previewInvite', callableCount: 8, totalCallableCount: 8, outcomeSha256: h('b'), readbackSha256: h('c'), bindingSha256: h('f') })
  assert.throws(() => appendJournalEvent(events, {
    seq: events.length, status: 'CALLABLE_REQUEST_MAY_BE_SENT', at,
    details: { callable: 'previewInvite', callableCount: 9, totalCallableCount: 9, requestSha256: h('a'), bindingSha256: h('f') },
  }))
  assert.throws(() => appendJournalEvent(events.slice(0, 3), {
    seq: 3, status: 'CALLABLE_REQUEST_MAY_BE_SENT', at,
    details: { callable: 'previewInvite', callableCount: 1, totalCallableCount: 41, requestSha256: h('a'), bindingSha256: h('f') },
  }))
})

test('sendOob has one durable process permit and cannot replay after restart', async () => {
  const full = sequence()
  const mayIndex = full.findIndex(row => row.status === 'EMAIL_REQUEST_MAY_BE_SENT')
  const before = full.slice(0, mayIndex)
  const throughMay = full.slice(0, mayIndex + 1)
  const throughSent = full.slice(0, mayIndex + 2)
  const jsonl = rows => `${rows.map(JSON.stringify).join('\n')}\n`
  const body = JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken: 'private-in-memory' })
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(body).digest('hex')
  throughMay.at(-1).details.requestSha256 = digest
  throughSent.at(-2).details.requestSha256 = digest
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${'k'.repeat(12)}`
  let calls = 0
  const transport = liveAcceptanceTransport(async () => { calls++; return { ok: true } }, {
    recoveryJournal: jsonl(before), readJournal: () => jsonl(throughMay),
  })
  transport.reserveVerificationEmail(digest)
  transport.authorizeRequest({ method: 'POST', url, bodySha256: digest })
  await transport.fetch(url, { method: 'POST', body })
  assert.equal(calls, 1)
  assert.throws(() => transport.reserveVerificationEmail(digest))
  assert.throws(() => transport.authorizeRequest({ method: 'POST', url, bodySha256: digest }))
  const restarted = liveAcceptanceTransport(async () => assert.fail('must not dispatch'), {
    recoveryJournal: jsonl(throughSent), readJournal: () => jsonl(throughSent),
  })
  assert.throws(() => restarted.reserveVerificationEmail(digest))
  assert.throws(() => liveAcceptanceTransport(async () => {}, {
    recoveryJournal: jsonl(throughMay), readJournal: () => jsonl(throughMay),
  }))
})

test('cleanup is exact, bounded and preserves owner Auth behind CAS paths', () => {
  const value = plan()
  const dynamic = observed()
  const cleanup = buildCleanupTargets(value, dynamic)
  assert.deepEqual(cleanup.destructive.authUids, ['uid_owner_a', 'uid_owner_b'])
  assert.equal(cleanup.destructive.authUids.includes('uid_owner_mailbox'), false)
  assert.equal(cleanup.destructive.firestorePaths.length, 25)
  assert.deepEqual(cleanup.casRequired.firestorePaths, [
    'companies/company_alpha/members/uid_owner_mailbox', 'users/uid_owner_mailbox',
  ])
  assert.equal(validateCleanupTargets(value, cleanup, dynamic), true)
  assert.throws(() => validateCleanupTargets(value, {
    ...cleanup, destructive: { ...cleanup.destructive, firestorePaths: [...cleanup.destructive.firestorePaths, 'companies/foreign'] },
  }, dynamic))
  assert.throws(() => buildCleanupTargets(value, { ...dynamic, invitationIds: { ...dynamic.invitationIds, extra: 'invite_4' } }))
  assert.throws(() => buildCleanupTargets(value, { ...dynamic, auditEventIds: dynamic.auditEventIds.slice(0, 8) }))
  assert.throws(() => buildCleanupTargets(value, {
    ...dynamic, auditEventIds: dynamic.auditEventIds.map((row, index) => index === 1 ? { ...row, company: 'a' } : row),
  }))
})

test('public result exposes hashes, counts and safe scenario outcomes only', () => {
  const fixturePlan = plan()
  const observations = {
    readbacks: [
      'company-a', 'company-b', 'mailbox-membership', 'owner-b-membership',
      'mailbox-final-invitation', 'owner-b-invitation', 'mailbox-lock',
      'owner-b-lock', 'audit-events', 'owner-mailbox-profile',
    ].map((check, index) => ({ check, stateSha256: h(String((index % 6) + 1)), updateTime: `2026-09-08T12:00:${String(index).padStart(2, '0')}.123456789Z` })),
    callableCounts: {
      createCompany: 2, inviteMember: 3, listInvitations: 6, cancelInvite: 1,
      resendInvite: 2, previewInvite: 4, acceptInvite: 5, getCompanyAccess: 4,
    },
    transportCounts: { authorizedRequests: 50, dispatchedRequests: 50, oauthRefreshes: 2, verificationDispatches: 1 },
  }
  const observationsSha256 = sha(JSON.stringify(observations))
  const result = sanitizePublicResult({
    sourceHead: 'd'.repeat(40), plan: fixturePlan,
    journal: sequence({ planSha256: sha(JSON.stringify(fixturePlan)), observationsSha256 }), observations,
    scenarios: SCENARIO_NAMES.map(name => ({ name, status: 'PASS' })),
    startedAt: at, finishedAt: '2026-09-08T12:10:00.000Z',
  })
  assert.equal(result.status, 'LIVE_ACCEPTANCE_VERIFIED')
  assert.deepEqual(result.callableCaps, CALLABLE_CAPS)
  assert.equal(result.totalCallableCap, TOTAL_CALLABLE_CAP)
  assert.match(result.planSha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(result).includes('uid_owner'), false)
  assert.equal(JSON.stringify(result).includes('@'), false)
  assert.throws(() => sanitizePublicResult({
    sourceHead: 'd'.repeat(40), plan: fixturePlan, journal: sequence(), observations,
    scenarios: SCENARIO_NAMES.map((name, index) => index === 0 ? { name, status: 'PASS', email: 'owner@example.test' } : { name, status: 'PASS' }), startedAt: at, finishedAt: at,
  }))
  const tooMany = structuredClone(observations)
  tooMany.callableCounts.acceptInvite = 7
  assert.throws(() => sanitizePublicResult({
    sourceHead: 'd'.repeat(40), plan: fixturePlan, journal: sequence(), observations: tooMany,
    scenarios: SCENARIO_NAMES.map(name => ({ name, status: 'PASS' })), startedAt: at, finishedAt: at,
  }))
  const tooFewReads = structuredClone(observations)
  tooFewReads.callableCounts.previewInvite = 3
  assert.throws(() => sanitizePublicResult({
    sourceHead: 'd'.repeat(40), plan: fixturePlan, journal: sequence(), observations: tooFewReads,
    scenarios: SCENARIO_NAMES.map(name => ({ name, status: 'PASS' })), startedAt: at, finishedAt: at,
  }))
  const wrongScenario = SCENARIO_NAMES.map(name => ({ name, status: 'PASS' }))
  wrongScenario[2].name = 'unregistered-scenario'
  assert.throws(() => sanitizePublicResult({
    sourceHead: 'd'.repeat(40), plan: fixturePlan, journal: sequence(), observations,
    scenarios: wrongScenario, startedAt: at, finishedAt: at,
  }))
})
