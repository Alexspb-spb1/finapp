import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { runGateGaOrchestrator, makeJournal } from './gateGaOrchestratorCore.mjs'
import { claimOrResumeEmailIntent, recordRegisteredRecipient, markEmailSent } from './gateGaEmailVerificationCore.mjs'
import { claimRunManifest, updateRunManifest } from './gateGaRunManifestCore.mjs'
import { LEGACY_KNOWN } from './stage8LegacyResidualCore.mjs'

function zeroWriteAdapters() {
  const throwIfCalled = name => async () => { throw new Error(`must not call ${name} on a refused resume`) }
  return {
    async probeReadiness() { throw new Error('must not probe readiness on a refused resume') },
    async recipientPreflight() { throw new Error('must not preflight on a refused resume') },
    createAdminAndCompany: throwIfCalled('createAdminAndCompany'),
    reconcileAdminAndCompany: throwIfCalled('reconcileAdminAndCompany'),
    reconcileInvitation: throwIfCalled('reconcileInvitation'),
    findAuthUidByEmail: throwIfCalled('findAuthUidByEmail'),
    inviteRecipient: throwIfCalled('inviteRecipient'),
    registerRecipient: throwIfCalled('registerRecipient'),
    sendVerificationEmail: throwIfCalled('sendVerificationEmail'),
    checkVerification: throwIfCalled('checkVerification'),
    signInRecipient: throwIfCalled('signInRecipient'),
    acceptInvite: throwIfCalled('acceptInvite'),
    readCompanyRoleFor: throwIfCalled('readCompanyRoleFor'),
    auditEventCount: throwIfCalled('auditEventCount'),
    memberUpdatedAtMs: throwIfCalled('memberUpdatedAtMs'),
    findAuditEventPaths: throwIfCalled('findAuditEventPaths'),
    listChildCollections: throwIfCalled('listChildCollections'),
    readDoc: throwIfCalled('readDoc'),
    deleteDoc: throwIfCalled('deleteDoc'),
    deleteAuthUser: throwIfCalled('deleteAuthUser'),
    authUserExists: throwIfCalled('authUserExists'),
    authUserExistsByEmail: throwIfCalled('authUserExistsByEmail'),
    legacyInventory: throwIfCalled('legacyInventory'),
    legacyAdapters: {},
  }
}

const sha256 = v => createHash('sha256').update(v).digest('hex')
const HEAD = 'c84f7837bdbc0a27fea698080c779d273e8e15bb'

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-orchestrator-test-'))
  try { return await fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function fakeAdapters(overrides = {}) {
  const state = { firestore: new Map(), auth: new Map() }
  const calls = { claimAttempted: false, recipientPreflightCalled: false, deleteDoc: [], cleanupCalled: 0 }
  const put = (path, value) => state.firestore.set(path, value)
  const base = {
    async probeReadiness() { return { ready: true, httpStatus: 401, verdict: 'ready' } },
    async recipientPreflight(recipient) { calls.recipientPreflightCalled = true; return { project: 'demo-finapp', recipientSha256: sha256(recipient.trim().toLowerCase()), absent: true } },
    async createAdminAndCompany() {
      const companyId = 'co-fake-1'
      put(`companies/${companyId}`, {}); put(`company_data/${companyId}`, {}); put(`companies/${companyId}/members/admin-1`, {})
      put('users/admin-1', {}); put('user_bootstrap/admin-1', {})
      state.auth.set('admin-1', true)
      return { adminUid: 'admin-1', companyId, memberPath: `companies/${companyId}/members/admin-1`, dataPath: `company_data/${companyId}`, profilePath: 'users/admin-1', bootstrapPath: 'user_bootstrap/admin-1', adminIdToken: 'admin-token' }
    },
    async reconcileAdminAndCompany() {
      if (!state.auth.has('admin-1')) return { found: false }
      if (!state.firestore.has('user_bootstrap/admin-1')) return { found: true, orphaned: true, adminUid: 'admin-1' }
      const companyId = 'co-fake-1'
      return { found: true, orphaned: false, adminUid: 'admin-1', companyId, memberPath: `companies/${companyId}/members/admin-1`, dataPath: `company_data/${companyId}`, profilePath: 'users/admin-1', bootstrapPath: 'user_bootstrap/admin-1', adminIdToken: 'admin-token-reconciled' }
    },
    async reconcileInvitation() {
      if (!state.firestore.has('invitations/inv-1')) return { found: false }
      return { found: true, inviteId: 'inv-1', invitationPath: 'invitations/inv-1', lockPath: 'invitationLocks/lock-1' }
    },
    async findAuthUidByEmail() { return { uid: state.auth.has('recipient-1') ? 'recipient-1' : null } },
    async inviteRecipient() { put('invitations/inv-1', {}); return { inviteId: 'inv-1', invitationPath: 'invitations/inv-1', lockPath: null, token: 'tok-1' } },
    async registerRecipient() { put('users/recipient-1', {}); state.auth.set('recipient-1', true); state.verified = false; return { recipientUid: 'recipient-1', idToken: 'recipient-token', profilePath: 'users/recipient-1' } },
    async sendVerificationEmail() { state.verified = true; return { dispatched: true, oobCode: 'oob-1' } },
    async checkVerification({ recipientUid }) { return { uid: recipientUid, email: 'gate-ga-orchestrator-test@example.invalid', emailVerified: Boolean(state.verified) } },
    async signInRecipient() { return { idToken: 'recipient-token-fresh' } },
    async acceptInvite() { put('companies/co-fake-1/audit_events/ev-1', {}); return { ok: true, companyId: 'co-fake-1' } },
    async readCompanyRoleFor() { return { role: 'accountant' } },
    async auditEventCount() { return state.firestore.has('companies/co-fake-1/audit_events/ev-1') ? 1 : 0 },
    async memberUpdatedAtMs() { return 12345 },
    async findAuditEventPaths() { return ['companies/co-fake-1/audit_events/ev-1'] },
    async listChildCollections() { return ['members', 'audit_events'] },
    async readDoc(p) { return { exists: state.firestore.has(p), stateSha256: state.firestore.has(p) ? '11'.repeat(32) : null } },
    async deleteDoc(p) { calls.deleteDoc.push(p); state.firestore.delete(p) },
    async deleteAuthUser(uid) { state.auth.delete(uid) },
    async authUserExists(uid) { return state.auth.has(uid) },
    async authUserExistsByEmail() { return false },
    async legacyInventory() { return { ownerAAuth: { exists: false, uid: null }, ownerBAuth: { exists: false }, bootstrap: { exists: false, ownerUid: null }, companies: [] } },
    legacyAdapters: {
      async listChildCollections() { return [] }, async readDoc() { return { exists: false, stateSha256: null } },
      async deleteDoc() {}, async deleteAuthUser() {}, async authUserExists() { return false }, async authUserExistsByEmail() { return false },
    },
  }
  return { calls, state, adapters: { ...base, ...overrides } }
}

function baseOptions(dir, overrides = {}) {
  const recipient = 'gate-ga-orchestrator-test@example.invalid'
  return {
    profile: 'emulator', project: 'demo-finapp',
    seamExpectedHashes: { 'gateGaOrchestratorCore.mjs': 'skip' },
    readFile: async () => 'skip',
    recipient, ownerConfirmedRecipientSha256: sha256(recipient.trim().toLowerCase()),
    claimedDir: dir, sourceHead: HEAD, journal: makeJournal(),
    // DI-level orchestrator tests never touch real Windows ACLs — that
    // mechanism is proven for real, independently, by
    // gateGaPrivateDirAclSelfTest.mjs and by the real emulator/CLI E2E runs.
    ensureAcl: () => {}, verifyFileAcl: () => {},
    ...overrides,
  }
}
// seamExpectedHashes/readFile above intentionally trivial (returns 'skip'
// for every file) — this self-test targets the ORCHESTRATOR's sequencing,
// not seam-integrity (module A/B/C/E already prove that at unit level).
function skipIntegrity(options) { return { ...options, seamExpectedHashes: { x: sha256('skip') }, readFile: async () => 'skip' } }

test('positive: full sequence reaches PASS with real-shaped fake adapters (baseline for mutation copies)', async () => {
  await withTempDir(async dir => {
    const { adapters, calls } = fakeAdapters()
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.equal(result.status, 'PASS')
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
    assert.equal(result.emailsSent, 1)
    void calls
  })
})

test('run-id is claimed exactly once before any external creation call', async () => {
  await withTempDir(async dir => {
    const order = []
    const { adapters } = fakeAdapters({ async createAdminAndCompany() { order.push('createAdminAndCompany'); return fakeAdapters().adapters.createAdminAndCompany() } })
    await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    const claimFiles = fs.readdirSync(dir).filter(f => f.startsWith('run-id-claim-'))
    assert.equal(claimFiles.length, 1)
  })
})

test('recipient guard is actually consulted (not bypassable by an absent adapter call)', async () => {
  await withTempDir(async dir => {
    const { adapters, calls } = fakeAdapters()
    await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.equal(calls.recipientPreflightCalled, true)
  })
})

test('cleanup runs and reaches CLEANUP_COMPLETE_VERIFIED with zero remainder on a real PASS', async () => {
  await withTempDir(async dir => {
    const { adapters, state } = fakeAdapters()
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
    assert.equal(state.firestore.size, 0)
    assert.equal(state.auth.size, 0)
  })
})

test('cleanup also runs after a safely-classified STOP, not only after PASS', async () => {
  await withTempDir(async dir => {
    const { adapters, state } = fakeAdapters()
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, faults: { stopAfterPartial: true } }))
    assert.equal(result.flowOutcome.status, 'SAFE_STOP')
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
    assert.equal(state.firestore.size, 0)
    assert.equal(state.auth.size, 0)
  })
})

test('final status cannot be PASS while any residual document remains', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters({ async deleteDoc() { /* silently ineffective */ } })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.notEqual(result.status, 'PASS')
  })
})

test('exactly one email dispatch is required for PASS', async () => {
  await withTempDir(async dir => {
    // Deliberately never verified (sendVerificationEmail never flips
    // state.verified) — a short deadline/interval keeps this bounded even if
    // the early emailsSent!==1 guard is ever removed and the flow falls
    // through into a real poll that can then never succeed.
    const { adapters } = fakeAdapters({ async sendVerificationEmail() { return { dispatched: false, oobCode: null } } })
    const result = await runGateGaOrchestrator(skipIntegrity({
      ...baseOptions(dir), adapters, verificationDeadlineMs: 20, verificationIntervalMs: 5,
    }))
    assert.notEqual(result.status, 'PASS')
    assert.equal(result.emailsSent, 0)
  })
})

test('a second real email dispatch (fault-injected) is rejected, not just an absent one', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters()
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, faults: { doubleSendEmail: true } }))
    assert.notEqual(result.status, 'PASS')
    assert.equal(result.emailsSent, 2)
  })
})

test('legacy cleanup never runs on a non-matching residual, even when legacyCleanupApproved is supplied', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters({
      async legacyInventory() { return { ownerAAuth: { exists: true, uid: 'some-other-uid' }, ownerBAuth: { exists: false }, bootstrap: { exists: false, ownerUid: null }, companies: [] } },
    })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, legacyCleanupApproved: true }))
    assert.equal(result.legacyResidual.eligible, false)
    assert.equal(result.legacyCleanup.status, 'NOT_APPLICABLE')
  })
})

function eligibleLegacyInventory() {
  return {
    ownerAAuth: { exists: true, uid: LEGACY_KNOWN.ownerAUid }, ownerBAuth: { exists: false }, bootstrap: { exists: true, ownerUid: LEGACY_KNOWN.ownerAUid },
    companies: [{
      id: 'co-legacy-1', name: LEGACY_KNOWN.companyName, ownerUid: LEGACY_KNOWN.ownerAUid, ownerName: LEGACY_KNOWN.ownerName,
      legalType: LEGACY_KNOWN.legalType, idempotencyKeySha256: sha256(LEGACY_KNOWN.idempotencyKey), companyDataExists: true,
      subcollections: ['members', 'audit_events'], members: [{ uid: LEGACY_KNOWN.ownerAUid, role: 'admin' }],
      auditEvents: [{ id: 'ev-legacy-1', action: 'company_created' }],
    }],
  }
}

test('an eligible legacy residual without legacyCleanupApproved is PENDING_APPROVAL, and blocks a full PASS even though the current run itself succeeded', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters({ async legacyInventory() { return eligibleLegacyInventory() } })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.equal(result.legacyResidual.eligible, true)
    assert.equal(result.legacyCleanup.status, 'PENDING_APPROVAL')
    assert.notEqual(result.status, 'PASS', 'an eligible-but-unapproved legacy residual must never be silently treated as clean')
  })
})

test('an eligible legacy residual WITH legacyCleanupApproved is actually cleaned, and the current run still reaches PASS', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters({ async legacyInventory() { return eligibleLegacyInventory() } })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, legacyCleanupApproved: true }))
    assert.equal(result.legacyResidual.eligible, true)
    assert.equal(result.legacyCleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
    assert.equal(result.status, 'PASS')
  })
})

// --- R5: owner-in-the-loop email verification scenarios -----------------

test('verification polling continues across repeated false checks before succeeding (the poll loop actually loops end-to-end)', async () => {
  await withTempDir(async dir => {
    let checks = 0
    const { adapters } = fakeAdapters({
      async checkVerification({ recipientUid }) {
        checks++
        return { uid: recipientUid, email: 'gate-ga-orchestrator-test@example.invalid', emailVerified: checks >= 3 }
      },
    })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, verificationIntervalMs: 1 }))
    assert.equal(result.status, 'PASS')
    assert.ok(checks >= 3)
  })
})

test('verification timeout results in SAFE_STOP, with cleanup of everything this run created', async () => {
  await withTempDir(async dir => {
    const { adapters, state } = fakeAdapters({
      async checkVerification({ recipientUid }) { return { uid: recipientUid, email: 'gate-ga-orchestrator-test@example.invalid', emailVerified: false } },
    })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, faults: { verificationTimeout: true } }))
    assert.notEqual(result.status, 'PASS')
    assert.equal(result.flowOutcome.status, 'SAFE_STOP')
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
    assert.equal(state.firestore.size, 0)
    assert.equal(state.auth.size, 0)
  })
})

test('a second real email dispatch (fault-injected) never reaches PASS even though flowOutcome alone might look fine', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters()
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, faults: { doubleSendEmail: true } }))
    assert.equal(result.flowOutcome.status, 'SAFE_STOP')
    assert.equal(result.emailsSent, 2)
  })
})

test('indeterminate prior send (process died mid-dispatch) refuses to resend, never registers again, and still cleans up this run', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    const recipientSha256 = sha256(recipient.trim().toLowerCase())
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256 })
    let registerCalls = 0, sendCalls = 0
    const { adapters } = fakeAdapters({
      async registerRecipient() { registerCalls++; throw new Error('must not register on indeterminate resume') },
      async sendVerificationEmail() { sendCalls++; throw new Error('must not send on indeterminate resume') },
    })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.notEqual(result.status, 'PASS')
    assert.equal(registerCalls, 0)
    assert.equal(sendCalls, 0)
    assert.equal(result.emailsSent, 0)
    assert.ok(result.journal.some(e => e.status === 'EMAIL_SEND_INDETERMINATE'))
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
  })
})

test('resuming from a durable SENT checkpoint continues polling with the persisted recipientUid and reaches PASS without registering or sending again', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    const recipientSha256 = sha256(recipient.trim().toLowerCase())
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256 })
    recordRegisteredRecipient({ checkpointDir: dir, recipientSha256, recipientUid: 'recipient-1' })
    markEmailSent({ checkpointDir: dir, recipientSha256, recipientUid: 'recipient-1' })
    let registerCalls = 0, sendCalls = 0
    const { adapters, state } = fakeAdapters({
      async registerRecipient() { registerCalls++; throw new Error('must not register again on resume') },
      async sendVerificationEmail() { sendCalls++; throw new Error('must not send again on resume') },
    })
    state.firestore.set('users/recipient-1', {})
    state.auth.set('recipient-1', true)
    state.verified = true
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.equal(result.status, 'PASS')
    assert.equal(registerCalls, 0)
    assert.equal(sendCalls, 0)
    assert.equal(result.emailsSent, 0)
    assert.ok(result.journal.some(e => e.status === 'EMAIL_RESUMED_FROM_CHECKPOINT'))
  })
})

test('verification reported for a different uid/email is refused, never accepted as PASS', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters({
      async checkVerification() { return { uid: 'someone-else', email: 'attacker@example.invalid', emailVerified: true } },
    })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.notEqual(result.status, 'PASS')
    assert.ok(result.journal.some(e => e.status === 'VERIFICATION_POLL_FINISHED' && e.details.reason === 'UID_MISMATCH'))
  })
})

test('verification reported for the RIGHT uid but a DIFFERENT email is refused (expectedEmail is actually enforced, not just uid)', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters({
      async checkVerification({ recipientUid }) { return { uid: recipientUid, email: 'attacker@example.invalid', emailVerified: true } },
    })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.notEqual(result.status, 'PASS')
    assert.ok(result.journal.some(e => e.status === 'VERIFICATION_POLL_FINISHED' && e.details.reason === 'EMAIL_MISMATCH'))
  })
})

test('a second FRESH (non-resume) invocation reusing the same claimedDir is refused as a collision, not silently accepted', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters()
    const first = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.equal(first.status, 'PASS')

    let registerCalls = 0
    const { adapters: adapters2 } = fakeAdapters({ async registerRecipient() { registerCalls++; return fakeAdapters().adapters.registerRecipient() } })
    const second = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters: adapters2 }))
    assert.equal(second.status, 'SAFE_STOP')
    assert.equal(registerCalls, 0, 'a rejected collision must never reach the point of registering the recipient again')
  })
})

test('resume:true across two full orchestrator invocations for the same recipient never registers or sends again, and still reaches PASS', async () => {
  await withTempDir(async dir => {
    let registerCalls = 0, sendCalls = 0
    const built = fakeAdapters()
    const { state } = built
    const adapters = {
      ...built.adapters,
      async registerRecipient() {
        registerCalls++
        state.firestore.set('users/recipient-1', {}); state.auth.set('recipient-1', true); state.verified = false
        return { recipientUid: 'recipient-1', idToken: 'recipient-token', profilePath: 'users/recipient-1' }
      },
      async sendVerificationEmail() { sendCalls++; state.verified = true; return { dispatched: true, oobCode: 'oob-1' } },
    }
    const first = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.equal(first.status, 'PASS')
    assert.equal(registerCalls, 1)
    assert.equal(sendCalls, 1)

    const second = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, resume: true }))
    assert.equal(second.status, 'PASS')
    assert.equal(registerCalls, 1, 'no second registration across a resumed second invocation')
    assert.equal(sendCalls, 1, 'no second email across a resumed second invocation')
    assert.equal(second.emailsSent, 0)
    assert.ok(second.journal.some(e => e.status === 'RUN_RESUMED'))
    assert.ok(second.journal.some(e => e.status === 'ADMIN_AND_COMPANY_RESUMED'))
    assert.ok(second.journal.some(e => e.status === 'INVITATION_RESUMED'))
  })
})

test('a FRESH run refuses when the recipient Auth account already exists (module E\'s absent requirement, unaffected by resume support)', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters({
      async recipientPreflight(recipient) { return { project: 'demo-finapp', recipientSha256: sha256(recipient.trim().toLowerCase()), absent: false } },
    })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.equal(result.status, 'SAFE_STOP')
    assert.equal(result.reason, 'RECIPIENT_REFUSED')
    assert.ok(result.journal.some(e => e.status === 'RECIPIENT_REFUSED' && e.details.reason === 'recipient_guard_blocked'))
  })
})

test('resume:true allows the recipient Auth account to already exist (it is THIS run\'s own earlier registration), but still requires the confirmed hash to match', async () => {
  await withTempDir(async dir => {
    let registerCalls = 0, sendCalls = 0
    const built = fakeAdapters({
      async recipientPreflight(recipient) { return { project: 'demo-finapp', recipientSha256: sha256(recipient.trim().toLowerCase()), absent: false } },
    })
    const { state } = built
    const adapters = {
      ...built.adapters,
      async registerRecipient() {
        registerCalls++
        state.firestore.set('users/recipient-1', {}); state.auth.set('recipient-1', true); state.verified = false
        return { recipientUid: 'recipient-1', idToken: 'recipient-token', profilePath: 'users/recipient-1' }
      },
      async sendVerificationEmail() { sendCalls++; state.verified = true; return { dispatched: true, oobCode: 'oob-1' } },
    }
    // First run also sees absent:false here deliberately — this reproduces
    // the exact real scenario (gateGaResumeKillTest.mjs): registerRecipient
    // creates the account mid-flow, so by the time a resumed SECOND process
    // preflights, the (real) adapter would report absent:false too. A fresh
    // run's recipientPreflight override above matches that shape from the
    // start so both invocations use the identical fake.
    const firstAdapters = { ...adapters, async recipientPreflight(recipient) { return { project: 'demo-finapp', recipientSha256: sha256(recipient.trim().toLowerCase()), absent: true } } }
    const first = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters: firstAdapters }))
    assert.equal(first.status, 'PASS')

    const second = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, resume: true }))
    assert.equal(second.status, 'PASS')
    assert.equal(registerCalls, 1)
    assert.equal(sendCalls, 1)

    // A resumed run with a WRONG confirmed-recipient hash must still be refused.
    const thirdOptions = baseOptions(dir)
    const wrongResult = await runGateGaOrchestrator(skipIntegrity({ ...thirdOptions, ownerConfirmedRecipientSha256: sha256('someone-else@example.invalid'), adapters, resume: true }))
    assert.equal(wrongResult.status, 'SAFE_STOP')
  })
})

test('resume:true with no run manifest present is refused with zero adapter calls of any kind', async () => {
  await withTempDir(async dir => {
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters: zeroWriteAdapters(), resume: true }))
    assert.equal(result.status, 'SAFE_STOP')
    assert.equal(result.reason, 'RESUME_STATE_MISSING')
  })
})

test('resume:true with a corrupted run manifest is refused with zero adapter calls of any kind', async () => {
  await withTempDir(async dir => {
    const fs2 = await import('node:fs')
    const { runManifestPathFor } = await import('./gateGaRunManifestCore.mjs')
    fs2.writeFileSync(runManifestPathFor({ claimedDir: dir }), 'not json', { mode: 0o600 })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters: zeroWriteAdapters(), resume: true }))
    assert.equal(result.status, 'SAFE_STOP')
    assert.equal(result.reason, 'RESUME_STATE_CORRUPT')
  })
})

test('resume:true with a manifest for a different recipient/project/profile is refused as a mismatch, zero adapter calls', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    claimRunManifest({ claimedDir: dir, runId: 'gate-someotherrunidxxxxxxxxxxxxxx', project: 'demo-finapp', profile: 'emulator', recipientSha256: sha256('someone-else@example.invalid'), sourceHead: HEAD })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters: zeroWriteAdapters(), resume: true }))
    assert.equal(result.status, 'SAFE_STOP')
    assert.equal(result.reason, 'RESUME_STATE_MISMATCH')
  })
})

test('resume:true with a manifest for a different sourceHead is refused as a mismatch, zero adapter calls', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    const { claimRunId } = await import('./liveAcceptanceRunIdCore.mjs')
    const runId = 'gate-dddddddddddddddddddddddddddddd'
    claimRunId(runId, { claimedDir: dir, project: 'demo-finapp', sourceHead: HEAD })
    claimRunManifest({ claimedDir: dir, runId, project: 'demo-finapp', profile: 'emulator', recipientSha256: sha256(recipient.trim().toLowerCase()), sourceHead: 'b'.repeat(40) })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters: zeroWriteAdapters(), resume: true }))
    assert.equal(result.status, 'SAFE_STOP')
    assert.equal(result.reason, 'RESUME_STATE_MISMATCH')
  })
})

test('a failed private-directory ACL check (via the injectable ensureAcl) SAFE_STOPs before any adapter call of any kind — before any Auth user or email', async () => {
  await withTempDir(async dir => {
    const result = await runGateGaOrchestrator(skipIntegrity({
      ...baseOptions(dir), adapters: zeroWriteAdapters(),
      ensureAcl: () => { throw new Error('acl_tampered_for_test') },
    }))
    assert.equal(result.status, 'SAFE_STOP')
    assert.equal(result.reason, 'PRIVATE_DIR_ACL_REFUSED')
    assert.ok(result.journal.some(e => e.status === 'PRIVATE_DIR_ACL_REFUSED'))
    assert.equal(fs.readdirSync(dir).some(f => f.startsWith('run-id-claim-')), false, 'no run-id claim may be written once the ACL check has failed')
  })
})

test('an indeterminate resume with a durably-known recipientUid adds that uid to the cleanup ledger (nothing created is ever left outside the ledger)', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    const recipientSha256 = sha256(recipient.trim().toLowerCase())
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256 })
    recordRegisteredRecipient({ checkpointDir: dir, recipientSha256, recipientUid: 'recipient-1' })
    // Deliberately never markEmailSent — the checkpoint stays MAY_BE_SENT
    // with a known recipientUid, exactly what a crash between registration
    // and the send call leaves behind.
    const { adapters, state } = fakeAdapters()
    state.firestore.set('users/recipient-1', {}); state.auth.set('recipient-1', true)
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.notEqual(result.status, 'PASS')
    assert.ok(result.journal.some(e => e.status === 'EMAIL_SEND_INDETERMINATE' && e.details.recipientUidKnown === true))
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
    assert.equal(state.firestore.has('users/recipient-1'), false)
    assert.equal(state.auth.has('recipient-1'), false)
  })
})

test('resume:true with the run-id claim marker missing (manifest present but claim gone) is refused, zero adapter calls', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    claimRunManifest({ claimedDir: dir, runId: 'gate-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', project: 'demo-finapp', profile: 'emulator', recipientSha256: sha256(recipient.trim().toLowerCase()), sourceHead: HEAD })
    // Deliberately never wrote a run-id-claim-*.json file for this runId — a
    // manifest without its matching claim marker is inconsistent state.
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters: zeroWriteAdapters(), resume: true }))
    assert.equal(result.status, 'SAFE_STOP')
    assert.equal(result.reason, 'RESUME_STATE_CORRUPT')
  })
})

test('resume from phase CLAIMED with nothing externally created: reconciliation confirms absence, SAFE_STOPs with an empty-ledger no-op cleanup', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    const { claimRunId } = await import('./liveAcceptanceRunIdCore.mjs')
    const runId = 'gate-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    claimRunId(runId, { claimedDir: dir, project: 'demo-finapp', sourceHead: HEAD })
    claimRunManifest({ claimedDir: dir, runId, project: 'demo-finapp', profile: 'emulator', recipientSha256: sha256(recipient.trim().toLowerCase()), sourceHead: HEAD })
    let calls = 0
    const { adapters } = fakeAdapters({
      async createAdminAndCompany() { calls++; throw new Error('must not attempt admin creation from an indeterminate CLAIMED resume') },
    })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, resume: true }))
    assert.notEqual(result.status, 'PASS')
    assert.equal(calls, 0)
    assert.ok(result.journal.some(e => e.status === 'RESUME_RECONCILE_ADMIN_NOT_FOUND'))
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
  })
})

test('resume from phase CLAIMED with an orphaned admin Auth account (createCompany never committed): reconciled and cleaned up, never guessed forward', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    const { claimRunId } = await import('./liveAcceptanceRunIdCore.mjs')
    const runId = 'gate-dddddddddddddddddddddddddddddd'
    claimRunId(runId, { claimedDir: dir, project: 'demo-finapp', sourceHead: HEAD })
    claimRunManifest({ claimedDir: dir, runId, project: 'demo-finapp', profile: 'emulator', recipientSha256: sha256(recipient.trim().toLowerCase()), sourceHead: HEAD })
    const { adapters, state } = fakeAdapters({
      async createAdminAndCompany() { throw new Error('must not attempt admin creation from an indeterminate CLAIMED resume') },
    })
    // Admin Auth exists (a real external effect from a killed prior
    // attempt) but the bootstrap receipt does not — company was provably
    // never created.
    state.auth.set('admin-1', true)
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, resume: true }))
    assert.notEqual(result.status, 'PASS')
    assert.ok(result.journal.some(e => e.status === 'RESUME_RECONCILE_ADMIN_ORPHANED'))
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
    assert.equal(state.auth.has('admin-1'), false)
  })
})

test('resume from phase CLAIMED with admin+company both confirmed externally: reconciled and the run continues to PASS', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    const { claimRunId } = await import('./liveAcceptanceRunIdCore.mjs')
    const runId = 'gate-eeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    claimRunId(runId, { claimedDir: dir, project: 'demo-finapp', sourceHead: HEAD })
    claimRunManifest({ claimedDir: dir, runId, project: 'demo-finapp', profile: 'emulator', recipientSha256: sha256(recipient.trim().toLowerCase()), sourceHead: HEAD })
    let creationCalls = 0
    const { adapters, state } = fakeAdapters({
      async createAdminAndCompany() { creationCalls++; throw new Error('must not re-create admin/company once reconciliation finds them') },
    })
    state.auth.set('admin-1', true)
    state.firestore.set('user_bootstrap/admin-1', {})
    state.firestore.set('companies/co-fake-1', {}); state.firestore.set('company_data/co-fake-1', {})
    state.firestore.set('companies/co-fake-1/members/admin-1', {}); state.firestore.set('users/admin-1', {})
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, resume: true }))
    assert.equal(creationCalls, 0)
    assert.ok(result.journal.some(e => e.status === 'RESUME_RECONCILE_ADMIN_RECOVERED'))
    assert.equal(result.status, 'PASS')
  })
})

test('resume from phase ADMIN_CREATED with nothing externally created: reconciliation confirms absence, but still cleans up the admin/company that WAS confirmed', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    const { claimRunId } = await import('./liveAcceptanceRunIdCore.mjs')
    const runId = 'gate-cccccccccccccccccccccccccccccc'
    claimRunId(runId, { claimedDir: dir, project: 'demo-finapp', sourceHead: HEAD })
    claimRunManifest({ claimedDir: dir, runId, project: 'demo-finapp', profile: 'emulator', recipientSha256: sha256(recipient.trim().toLowerCase()), sourceHead: HEAD })
    const ledger = { runId, createdAuthUids: ['admin-1'], createdFirestorePaths: ['companies/co-fake-1'], casPaths: [], ownerMailboxUidCreated: false }
    updateRunManifest({ claimedDir: dir, fromPhase: 'CLAIMED', patch: { phase: 'ADMIN_CREATED', admin: { adminUid: 'admin-1', companyId: 'co-fake-1' }, ledger } })
    let inviteCalls = 0
    const { adapters, state } = fakeAdapters({
      async inviteRecipient() { inviteCalls++; throw new Error('must not attempt invite creation from an indeterminate ADMIN_CREATED resume') },
    })
    state.firestore.set('companies/co-fake-1', {}); state.auth.set('admin-1', true)
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, resume: true }))
    assert.notEqual(result.status, 'PASS')
    assert.equal(inviteCalls, 0)
    assert.ok(result.journal.some(e => e.status === 'RESUME_RECONCILE_INVITE_NOT_FOUND'))
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
    assert.equal(state.firestore.has('companies/co-fake-1'), false)
    assert.equal(state.auth.has('admin-1'), false)
  })
})

test('resume from phase ADMIN_CREATED where inviteMember already completed externally: reconciled (found via the lock) and cleaned up — never resumed into accept (no token)', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    const { claimRunId } = await import('./liveAcceptanceRunIdCore.mjs')
    const runId = 'gate-ffffffffffffffffffffffffffffff'
    claimRunId(runId, { claimedDir: dir, project: 'demo-finapp', sourceHead: HEAD })
    claimRunManifest({ claimedDir: dir, runId, project: 'demo-finapp', profile: 'emulator', recipientSha256: sha256(recipient.trim().toLowerCase()), sourceHead: HEAD })
    const ledger = { runId, createdAuthUids: ['admin-1'], createdFirestorePaths: ['companies/co-fake-1'], casPaths: [], ownerMailboxUidCreated: false }
    updateRunManifest({ claimedDir: dir, fromPhase: 'CLAIMED', patch: { phase: 'ADMIN_CREATED', admin: { adminUid: 'admin-1', companyId: 'co-fake-1' }, ledger } })
    const { adapters, state } = fakeAdapters({
      async inviteRecipient() { throw new Error('must not re-invite once reconciliation finds the existing invitation') },
    })
    state.firestore.set('companies/co-fake-1', {}); state.auth.set('admin-1', true)
    state.firestore.set('invitations/inv-1', {})
    // A real invitationLocks doc the lock-based reconciliation found —
    // independently re-checked below, mirroring the real E2E harness's own
    // independent post-cleanup remainder check, so a ledger that silently
    // drops this path (never queued for deletion) is actually caught here.
    state.firestore.set('invitationLocks/lock-1', {})
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, resume: true }))
    assert.notEqual(result.status, 'PASS')
    assert.ok(result.journal.some(e => e.status === 'RESUME_RECONCILE_INVITE_FOUND_NO_TOKEN'))
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
    assert.equal(state.firestore.has('invitations/inv-1'), false)
    assert.equal(state.firestore.has('invitationLocks/lock-1'), false)
    assert.equal(state.firestore.has('companies/co-fake-1'), false)
    assert.equal(state.auth.has('admin-1'), false)
  })
})

test('MAY_BE_SENT checkpoint with recipientUid unknown but the Auth account real: recovered by exact email lookup, durably recorded, then cleaned up', async () => {
  await withTempDir(async dir => {
    const recipient = 'gate-ga-orchestrator-test@example.invalid'
    const recipientSha256 = sha256(recipient.trim().toLowerCase())
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256 })
    // Deliberately never call recordRegisteredRecipient — the checkpoint on
    // disk still has recipientUid: null, exactly what a crash between
    // registerRecipient() returning and that durable write leaves behind.
    const { adapters, state } = fakeAdapters({
      async registerRecipient() { throw new Error('must not re-register once reconciliation finds the existing Auth account') },
    })
    // The recipient Auth account is real (created by the earlier, killed
    // attempt) even though the checkpoint never recorded its uid.
    state.auth.set('recipient-1', true)
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.notEqual(result.status, 'PASS')
    assert.ok(result.journal.some(e => e.status === 'RESUME_RECONCILE_RECIPIENT_UID_RECOVERED'))
    assert.ok(result.journal.some(e => e.status === 'EMAIL_SEND_INDETERMINATE' && e.details.recipientUidKnown === true))
    assert.equal(result.cleanup.status, 'CLEANUP_COMPLETE_VERIFIED')
    assert.equal(state.auth.has('recipient-1'), false)
    const { readEmailCheckpoint } = await import('./gateGaEmailVerificationCore.mjs')
    const recovered = readEmailCheckpoint({ checkpointDir: dir, recipientSha256 })
    assert.equal(recovered.recipientUid, 'recipient-1')
  })
})
