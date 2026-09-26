import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { FIXTURE_MUTATION_SLOT_SPECS } from './liveAcceptanceCore.mjs'
import { READ_ONLY_SLOT_SPECS } from './liveAcceptanceExecutorCore.mjs'
import { createFixedLiveScenarioOperations, createHeldAdminInvitationOperations } from './liveAcceptanceExecutorOperations.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const state = { ownerAUid: 'owner_a', ownerBUid: 'owner_b', ownerMailboxUid: 'mailbox_uid',
  companyAId: 'company_a', companyBId: 'company_b', mailboxCancelledInviteId: 'invite_cancelled',
  mailboxFinalInviteId: 'invite_final', ownerBInviteId: 'invite_owner_b',
  mailboxCancelledCapabilitySha256: h('cap-cancelled'), mailboxPreviousCapabilitySha256: h('cap-old'),
  mailboxFinalCapabilitySha256: h('cap-final'), ownerBCapabilitySha256: h('cap-owner-b') }

test('fixed operation factory covers every slot and keeps secret inputs inside closures', async () => {
  const seen = [], reconciled = [], idempotency = []
  const authAdapter = { slot(identity, subjectSha256) { return { requestSha256: h(`auth-${identity}`), binding: { identity, subjectSha256 },
    async dispatch(permit) { return { requestSha256: permit.requestSha256, outcomeSha256: h('auth-outcome'), producedSha256: h('{}') } },
    async readback() { return { requestSha256: h(`auth-${identity}`), outcomeSha256: h('auth-outcome'), readbackSha256: h('auth-readback'), produced: {} } } } } }
  const callablePrimitive = {
    prepare(value) { seen.push(value); return { requestSha256: h(JSON.stringify(value)) } },
    async dispatchPrepared(_handle, value) { await value.bind({ method: 'POST', url: 'https://us-central1-finapp-staging.cloudfunctions.net/fixed', postData: '{}' })
      return { outcomeSha256: h('outcome'), sanitized: { disposition: 'DENIED', appCode: value.expectedAppCode } } },
  }
  const normalPath = { async prepare() { return { requestSha256: h('normal') } },
    async dispatch(_callable, permit) { return { requestSha256: permit.requestSha256, outcomeSha256: h('normal-outcome') } },
    ownerMailboxUid: () => state.ownerMailboxUid, clearClipboard: async () => {} }
  const operations = createFixedLiveScenarioOperations({ authAdapter, callablePrimitive,
    reconciler: {
      async captureBefore() {},
      registerIdempotencyMaterial(value) { idempotency.push(structuredClone(value)) },
      async reconcile(value) { reconciled.push(value.slot); return { readbackSha256: h(`readback-${value.slot}`) } },
      readReplayProof() { return {} },
    },
    normalPath, secrets: { mailbox: 'mailbox@example.invalid', ownerAEmail: 'owner-a@example.invalid',
      ownerBEmail: 'owner-b@example.invalid', idempotencyA: 'idem-a', idempotencyB: 'idem-b' } })
  assert.deepEqual(Object.keys(operations.fixtures), FIXTURE_MUTATION_SLOT_SPECS.map(row => row.slot))
  assert.deepEqual(Object.keys(operations.readOnly), READ_ONLY_SLOT_SPECS.map(row => row.slot))
  const snapshot = { state }
  const denied = operations.fixtures.denyMailboxResendCooldown
  const prepared = await denied.prepare(snapshot)
  let binds = 0
  const dispatched = await denied.dispatch({ requestSha256: prepared.requestSha256, binding: prepared.binding }, async () => { binds++; return { action: 'continue' } })
  const readback = await denied.readback({ requestSha256: prepared.requestSha256, outcomeSha256: dispatched.outcomeSha256 })
  assert.equal(binds, 1); assert.match(readback.readbackSha256, /^[a-f0-9]{64}$/)
  assert.equal(seen[0].input.inviteId, state.mailboxFinalInviteId)
  assert.equal(JSON.stringify({ prepared, dispatched, readback }).includes('mailbox@example.invalid'), false)
  const companyPrepareResults = []
  for (const slot of ['createCompanyA', 'createCompanyB']) companyPrepareResults.push(await operations.fixtures[slot].prepare(snapshot))
  assert.deepEqual(idempotency.map(row => row.slot), ['createCompanyA', 'createCompanyB'])
  assert.deepEqual(idempotency.map(row => row.input.idempotencyKey), ['idem-a', 'idem-b'])
  assert.equal(JSON.stringify(companyPrepareResults).includes('idem-a'), false)
  assert.equal(JSON.stringify(companyPrepareResults).includes('idem-b'), false)
  assert.equal(JSON.stringify({ seen, reconciled }).includes('idem-a'), true)
  assert.equal(JSON.stringify(Object.values(operations)).includes('idem-a'), false)
  const normal = operations.fixtures.acceptMailboxFinalInvite
  const normalPrepared = await normal.prepare(snapshot)
  await normal.dispatch({ requestSha256: normalPrepared.requestSha256, binding: normalPrepared.binding })
  await normal.readback({ requestSha256: normalPrepared.requestSha256, outcomeSha256: h('normal-outcome') })
  assert.deepEqual(reconciled, ['denyMailboxResendCooldown', 'acceptMailboxFinalInvite'])
})

test('held admin operations own prepare, dispatch and semantic readback state', async () => {
  const mailbox = 'mailbox@example.invalid', mailboxSha256 = h(mailbox), calls = []
  const inviteSanitized = { disposition: 'SUCCESS', inviteId: 'invite_ui', capabilitySha256: h('capability'),
    expiresAtUtc: '2026-09-15T12:00:00.000Z' }
  const listSanitized = { disposition: 'SUCCESS', itemCount: 1, itemsSha256: h('items'), nextCursorPresent: false }
  const reconciler = {
    async assertCompanyInvitationsEmpty(companyId) { calls.push(['empty', companyId]); return { empty: true, resultCount: 0,
      companyIdSha256: h(companyId), querySha256: h('query'), readTime: '2026-09-08T12:00:00.000Z' } },
    async captureBefore(value) { calls.push(['capture', value.slot]) },
    async reconcile(value) { calls.push(['reconcile', value.slot, structuredClone(value)]); return { readbackSha256: h(value.slot) } },
  }
  const adminDriver = {
    async open() { calls.push(['open']) },
    async prepareCancelledInvitation() { calls.push(['prepare-invite']); return { requestSha256: h('invite-request') } },
    async dispatchCancelledInvitation(permit) { calls.push(['dispatch-invite']); return { requestSha256: permit.requestSha256,
      outcomeSha256: h('invite-outcome'), sanitized: inviteSanitized } },
    async takePreparedPostCreateList() { calls.push(['prepare-list']); return { requestSha256: h('list-request') } },
    async dispatchPostCreateList(permit) { calls.push(['dispatch-list']); return { requestSha256: permit.requestSha256,
      outcomeSha256: h('list-outcome'), sanitized: listSanitized } },
  }
  const operations = createHeldAdminInvitationOperations({ reconciler, adminDriver, mailbox, mailboxSha256 })
  await assert.rejects(() => operations.invitation.readback({}), /live_executor_operations_blocked/)
  const snapshot = { state }
  const preparedInvite = await operations.invitation.prepare(snapshot)
  const dispatchedInvite = await operations.invitation.dispatch({ requestSha256: preparedInvite.requestSha256,
    binding: preparedInvite.binding })
  const inviteReadback = await operations.invitation.readback({ requestSha256: preparedInvite.requestSha256,
    outcomeSha256: dispatchedInvite.outcomeSha256 })
  assert.deepEqual(Object.keys(inviteReadback.produced).sort(),
    ['mailboxCancelledCapabilitySha256', 'mailboxCancelledInviteId', 'mailboxLockId'])
  const preparedList = await operations.list.prepare({ state: { ...state, ...inviteReadback.produced } })
  const dispatchedList = await operations.list.dispatch({ requestSha256: preparedList.requestSha256, binding: preparedList.binding })
  const listReadback = await operations.list.readback({ requestSha256: preparedList.requestSha256,
    outcomeSha256: dispatchedList.outcomeSha256 })
  assert.deepEqual(listReadback.produced, {})
  assert.deepEqual(calls.map(row => row.slice(0, 2)), [
    ['empty', 'company_a'], ['open'], ['prepare-invite'], ['capture', 'createMailboxCancelledInvite'],
    ['dispatch-invite'], ['reconcile', 'createMailboxCancelledInvite'], ['prepare-list'],
    ['capture', 'listCancelledPending'], ['dispatch-list'], ['reconcile', 'listCancelledPending'],
  ])
  const inviteReconcile = calls.find(row => row[0] === 'reconcile' && row[1] === 'createMailboxCancelledInvite')[2]
  assert.equal(inviteReconcile.state.companyAId, state.companyAId)
  assert.deepEqual(inviteReconcile.sanitized, inviteSanitized)
  assert.equal(inviteReconcile.produced.mailboxCancelledInviteId, inviteSanitized.inviteId)
  assert.equal(JSON.stringify({ preparedInvite, dispatchedInvite, inviteReadback, preparedList, dispatchedList, listReadback }).includes(mailbox), false)
})
