import { createHash } from 'node:crypto'
import { FIXTURE_MUTATION_SLOT_SPECS, READ_ONLY_CALLABLES } from './liveAcceptanceCore.mjs'
import { READ_ONLY_SLOT_SPECS } from './liveAcceptanceExecutorCore.mjs'

const blocked = () => { throw new Error('live_executor_operations_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const sha256 = value => createHash('sha256').update(value).digest('hex')
const jsonHash = value => sha256(JSON.stringify(value))
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

const denied = Object.freeze({
  denyMailboxResendCooldown: 'invitation_resend_cooldown', denyWrongIdentityAccept: 'invite_invalid',
  denyUnverifiedMailboxAccept: 'email_unverified', previewCancelledDenied: 'invite_revoked',
  previewFinalPreviousDenied: 'invite_invalid', mailboxCompanyBDenied: 'membership_not_found',
  ownerBCompanyADenied: 'membership_not_found',
})

function lockId(companyId, email) { return sha256(JSON.stringify([companyId, email])) }

export function createFixedLiveScenarioOperations({ authAdapter, callablePrimitive, reconciler, normalPath, secrets }) {
  if (!authAdapter || typeof authAdapter.slot !== 'function' || !callablePrimitive ||
      typeof callablePrimitive.prepare !== 'function' || typeof callablePrimitive.dispatchPrepared !== 'function' ||
      !reconciler || typeof reconciler.reconcile !== 'function' || typeof reconciler.captureBefore !== 'function' ||
      typeof reconciler.readReplayProof !== 'function' || typeof reconciler.registerIdempotencyMaterial !== 'function' ||
      !exactKeys(normalPath, ['prepare', 'dispatch', 'ownerMailboxUid', 'clearClipboard']) ||
      Object.values(normalPath).some(value => typeof value !== 'function') ||
      !exactKeys(secrets, ['mailbox', 'ownerAEmail', 'ownerBEmail', 'idempotencyA', 'idempotencyB']) ||
      Object.values(secrets).some(value => typeof value !== 'string' || !value)) blocked()

  const authOperation = (identity, subjectSha256) => {
    let operation = null
    return Object.freeze({ mode: 'provider-admin',
      async prepare() { operation = authAdapter.slot(identity, subjectSha256); return { requestSha256: operation.requestSha256, binding: operation.binding } },
      async dispatch(permit) { return operation.dispatch(permit) },
      async readback() { return operation.readback() },
    })
  }

  let mailboxRegistrationState = null

  const build = (slot, snapshot) => {
    const s = snapshot.state
    const table = {
      createCompanyA: ['createCompany', 'ownerA', { idempotencyKey: secrets.idempotencyA, ownerName: 'Stage8 Owner A', companyName: 'Stage8 Company A', legalType: 'ooo' },
        { identity: 'ownerA', actorUid: s.ownerAUid, idempotencyKeySha256: sha256(secrets.idempotencyA) }],
      createCompanyB: ['createCompany', 'ownerB', { idempotencyKey: secrets.idempotencyB, ownerName: 'Stage8 Owner B', companyName: 'Stage8 Company B', legalType: 'ooo' },
        { identity: 'ownerB', actorUid: s.ownerBUid, idempotencyKeySha256: sha256(secrets.idempotencyB) }],
      createMailboxCancelledInvite: ['inviteMember', 'ownerA', { companyId: s.companyAId, email: secrets.mailbox, role: 'accountant' },
        { identity: 'ownerA', actorUid: s.ownerAUid, companyId: s.companyAId, subjectSha256: sha256(secrets.mailbox), role: 'accountant' }],
      cancelMailboxInvite: ['cancelInvite', 'ownerA', { companyId: s.companyAId, inviteId: s.mailboxCancelledInviteId },
        { identity: 'ownerA', actorUid: s.ownerAUid, companyId: s.companyAId, invitationId: s.mailboxCancelledInviteId }],
      createMailboxFinalInvite: ['inviteMember', 'ownerA', { companyId: s.companyAId, email: secrets.mailbox, role: 'accountant' },
        { identity: 'ownerA', actorUid: s.ownerAUid, companyId: s.companyAId, subjectSha256: sha256(secrets.mailbox), role: 'accountant' }],
      denyMailboxResendCooldown: ['resendInvite', 'ownerA', { companyId: s.companyAId, inviteId: s.mailboxFinalInviteId },
        { identity: 'ownerA', actorUid: s.ownerAUid, companyId: s.companyAId, invitationId: s.mailboxFinalInviteId }],
      resendMailboxFinalInvite: ['resendInvite', 'ownerA', { companyId: s.companyAId, inviteId: s.mailboxFinalInviteId },
        { identity: 'ownerA', actorUid: s.ownerAUid, companyId: s.companyAId, invitationId: s.mailboxFinalInviteId }],
      denyWrongIdentityAccept: ['acceptInvite', 'ownerB', { inviteId: s.mailboxFinalInviteId, capabilitySha256: s.mailboxFinalCapabilitySha256 },
        { identity: 'ownerB', actorUid: s.ownerBUid, invitationId: s.mailboxFinalInviteId, capabilitySha256: s.mailboxFinalCapabilitySha256 }],
      denyUnverifiedMailboxAccept: ['acceptInvite', 'ownerMailbox', { inviteId: s.mailboxFinalInviteId, capabilitySha256: s.mailboxFinalCapabilitySha256 },
        { identity: 'ownerMailbox', actorUid: s.ownerMailboxUid, invitationId: s.mailboxFinalInviteId, capabilitySha256: s.mailboxFinalCapabilitySha256 }],
      acceptMailboxFinalInvite: ['acceptInvite', 'ownerMailbox', { inviteId: s.mailboxFinalInviteId, capabilitySha256: s.mailboxFinalCapabilitySha256 },
        { identity: 'ownerMailbox', actorUid: s.ownerMailboxUid, invitationId: s.mailboxFinalInviteId, capabilitySha256: s.mailboxFinalCapabilitySha256 }],
      replayMailboxFinalInvite: ['acceptInvite', 'ownerMailbox', { inviteId: s.mailboxFinalInviteId, capabilitySha256: s.mailboxFinalCapabilitySha256 },
        { identity: 'ownerMailbox', actorUid: s.ownerMailboxUid, invitationId: s.mailboxFinalInviteId, capabilitySha256: s.mailboxFinalCapabilitySha256 }],
      createOwnerBInvite: ['inviteMember', 'ownerA', { companyId: s.companyAId, email: secrets.ownerBEmail, role: 'viewer' },
        { identity: 'ownerA', actorUid: s.ownerAUid, companyId: s.companyAId, subjectSha256: sha256(secrets.ownerBEmail), role: 'viewer' }],
      acceptOwnerBInvite: ['acceptInvite', 'ownerB', { inviteId: s.ownerBInviteId, capabilitySha256: s.ownerBCapabilitySha256 },
        { identity: 'ownerB', actorUid: s.ownerBUid, invitationId: s.ownerBInviteId, capabilitySha256: s.ownerBCapabilitySha256 }],
    }
    return table[slot] ?? blocked()
  }

  const produced = (slot, sanitized, snapshot) => {
    if (slot === 'createCompanyA') return { companyAId: sanitized.companyId }
    if (slot === 'createCompanyB') return { companyBId: sanitized.companyId }
    if (slot === 'createMailboxCancelledInvite') return { mailboxCancelledInviteId: sanitized.inviteId,
      mailboxCancelledCapabilitySha256: sanitized.capabilitySha256, mailboxLockId: lockId(snapshot.state.companyAId, secrets.mailbox) }
    if (slot === 'createMailboxFinalInvite') return { mailboxFinalInviteId: sanitized.inviteId,
      mailboxFinalCapabilitySha256: sanitized.capabilitySha256, mailboxLockId: lockId(snapshot.state.companyAId, secrets.mailbox) }
    if (slot === 'resendMailboxFinalInvite') return { mailboxFinalCapabilitySha256: sanitized.capabilitySha256 }
    if (slot === 'createOwnerBInvite') return { ownerBInviteId: sanitized.inviteId,
      ownerBCapabilitySha256: sanitized.capabilitySha256, ownerBLockId: lockId(snapshot.state.companyAId, secrets.ownerBEmail) }
    return {}
  }

  const callableOperation = slot => {
    let handle = null, prepared = null, dispatched = null, made = null
    const mode = slot === 'acceptMailboxFinalInvite' ? 'held-normal-path' : 'bound-callback'
    return Object.freeze({ mode,
      async prepare(snapshot) {
        prepared = build(slot, snapshot); made = snapshot
        const [callable, identity, input, binding] = prepared
        await reconciler.captureBefore({ slot, binding, state: snapshot.state })
        if (mode === 'held-normal-path') {
          const result = await normalPath.prepare(callable)
          return { requestSha256: result.requestSha256, binding }
        }
        handle = callablePrimitive.prepare({ callable, identity, input })
        if (['createCompanyA', 'createCompanyB'].includes(slot)) {
          reconciler.registerIdempotencyMaterial({ slot, identity, actorUid: binding.actorUid,
            requestSha256: handle.requestSha256, callable, input })
        }
        return { requestSha256: handle.requestSha256, binding }
      },
      async dispatch(permit, bind) {
        const [callable] = prepared
        if (mode === 'held-normal-path') dispatched = await normalPath.dispatch(callable, permit)
        else {
          if (typeof bind !== 'function') blocked()
          dispatched = await callablePrimitive.dispatchPrepared(handle, { permit, journalKind: 'fixture', expectedAppCode: denied[slot] ?? null, bind })
        }
        const value = produced(slot, dispatched.sanitized ?? {}, made)
        return { requestSha256: permit.requestSha256, outcomeSha256: dispatched.outcomeSha256, producedSha256: jsonHash(value) }
      },
      async readback(input) {
        const value = produced(slot, dispatched?.sanitized ?? {}, made)
        const result = await reconciler.reconcile({ slot, ...input, binding: prepared[3], state: made.state,
          sanitized: dispatched?.sanitized ?? null, produced: value })
        if (!record(result) || !hex64(result.readbackSha256)) blocked()
        return { ...input, readbackSha256: result.readbackSha256, produced: value }
      },
    })
  }

  const readOnlyOperation = spec => {
    let handle = null, prepared = null, dispatched = null, snapshotState = null
    const mode = spec.slot === 'mailboxCompanyAAccountant' ? 'held-normal-path' : 'bound-callback'
    return Object.freeze({ mode,
      async prepare(snapshot) {
        const s = snapshot.state
        snapshotState = s
        const actorUid = { ownerA: s.ownerAUid, ownerB: s.ownerBUid, ownerMailbox: s.ownerMailboxUid }[spec.identity]
        const companyId = { companyA: s.companyAId, companyB: s.companyBId }[spec.entity]
        let input, binding
        if (spec.callable === 'listInvitations') { input = { companyId, pageSize: 20 }; binding = { identity: spec.identity, actorUid, companyId, expectation: spec.expectation } }
        else if (spec.callable === 'getCompanyAccess') { input = { companyId }; binding = { identity: spec.identity, actorUid, companyId, expectation: spec.expectation } }
        else {
          const invitationId = { mailboxCancelledInvite: s.mailboxCancelledInviteId, mailboxFinalInvite: s.mailboxFinalInviteId }[spec.entity]
          const capabilitySha256 = { mailboxCancelledCapability: s.mailboxCancelledCapabilitySha256,
            mailboxPreviousCapability: s.mailboxPreviousCapabilitySha256, mailboxFinalCapability: s.mailboxFinalCapabilitySha256 }[spec.capability]
          input = { inviteId: invitationId, capabilitySha256 }; binding = { identity: spec.identity, invitationId, capabilitySha256, expectation: spec.expectation }
        }
        prepared = { callable: spec.callable, identity: spec.identity, input, binding }
        await reconciler.captureBefore({ slot: spec.slot, binding, state: s })
        if (mode === 'held-normal-path') return { ...(await normalPath.prepare(spec.callable)), binding }
        handle = callablePrimitive.prepare(prepared)
        return { requestSha256: handle.requestSha256, binding }
      },
      async dispatch(permit, bind) {
        if (mode === 'held-normal-path') dispatched = await normalPath.dispatch(spec.callable, permit)
        else {
          if (typeof bind !== 'function' || !READ_ONLY_CALLABLES.includes(spec.callable)) blocked()
          dispatched = await callablePrimitive.dispatchPrepared(handle, { permit, journalKind: 'callable', expectedAppCode: denied[spec.slot] ?? null, bind })
        }
        return { requestSha256: permit.requestSha256, outcomeSha256: dispatched.outcomeSha256, producedSha256: jsonHash({}) }
      },
      async readback(input) {
        const result = await reconciler.reconcile({ slot: spec.slot, ...input, binding: prepared.binding,
          state: snapshotState, sanitized: dispatched?.sanitized ?? null, produced: {} })
        return { ...input, readbackSha256: result.readbackSha256, produced: {} }
      },
    })
  }

  const fixtures = Object.fromEntries(FIXTURE_MUTATION_SLOT_SPECS.map(spec => {
    if (spec.slot === 'createOwnerAAuth') return [spec.slot, authOperation('ownerA', sha256(secrets.ownerAEmail))]
    if (spec.slot === 'createOwnerBAuth') return [spec.slot, authOperation('ownerB', sha256(secrets.ownerBEmail))]
    if (spec.slot === 'createOwnerMailboxAuth') return [spec.slot, { mode: 'owner-handoff',
      async prepare(snapshot) {
        if (mailboxRegistrationState || !record(snapshot?.state)) blocked()
        mailboxRegistrationState = snapshot.state
        return { captured: true }
      }, dispatch: blocked,
      readback: input => reconciler.reconcile({ slot: spec.slot, ...input,
        state: mailboxRegistrationState, produced: { ownerMailboxUid: normalPath.ownerMailboxUid() } }) }]
    return [spec.slot, callableOperation(spec.slot)]
  }))
  const readOnly = Object.fromEntries(READ_ONLY_SLOT_SPECS.map(spec => [spec.slot, readOnlyOperation(spec)]))
  return Object.freeze({ fixtures: Object.freeze(fixtures), readOnly: Object.freeze(readOnly),
    clipboard: Object.freeze({ clear: normalPath.clearClipboard }) })
}
