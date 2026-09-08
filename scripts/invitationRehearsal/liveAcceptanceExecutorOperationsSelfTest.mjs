import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { FIXTURE_MUTATION_SLOT_SPECS } from './liveAcceptanceCore.mjs'
import { READ_ONLY_SLOT_SPECS } from './liveAcceptanceExecutorCore.mjs'
import { createFixedLiveScenarioOperations } from './liveAcceptanceExecutorOperations.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const state = { ownerAUid: 'owner_a', ownerBUid: 'owner_b', ownerMailboxUid: 'mailbox_uid',
  companyAId: 'company_a', companyBId: 'company_b', mailboxCancelledInviteId: 'invite_cancelled',
  mailboxFinalInviteId: 'invite_final', ownerBInviteId: 'invite_owner_b',
  mailboxCancelledCapabilitySha256: h('cap-cancelled'), mailboxPreviousCapabilitySha256: h('cap-old'),
  mailboxFinalCapabilitySha256: h('cap-final'), ownerBCapabilitySha256: h('cap-owner-b') }

test('fixed operation factory covers every slot and keeps secret inputs inside closures', async () => {
  const seen = [], reconciled = []
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
  const normal = operations.fixtures.acceptMailboxFinalInvite
  const normalPrepared = await normal.prepare(snapshot)
  await normal.dispatch({ requestSha256: normalPrepared.requestSha256, binding: normalPrepared.binding })
  await normal.readback({ requestSha256: normalPrepared.requestSha256, outcomeSha256: h('normal-outcome') })
  assert.deepEqual(reconciled, ['denyMailboxResendCooldown', 'acceptMailboxFinalInvite'])
})
