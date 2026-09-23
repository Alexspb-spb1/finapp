import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { runGateGaOrchestrator, makeJournal } from './gateGaOrchestratorCore.mjs'
import { claimOrResumeEmailIntent, markEmailSent } from './gateGaEmailVerificationCore.mjs'

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

test('legacy cleanup never runs on a non-matching residual, even when confirmation is supplied', async () => {
  await withTempDir(async dir => {
    const { adapters } = fakeAdapters({
      async legacyInventory() { return { ownerAAuth: { exists: true, uid: 'some-other-uid' }, ownerBAuth: { exists: false }, bootstrap: { exists: false, ownerUid: null }, companies: [] } },
    })
    const result = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters, faults: { confirmLegacyCleanup: true } }))
    assert.equal(result.legacyResidual.eligible, false)
    assert.equal(result.legacyCleanup.status, 'NOT_APPLICABLE')
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

test('a second full run for the same recipient after a prior PASS never registers or sends again, and still reaches PASS', async () => {
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

    const second = await runGateGaOrchestrator(skipIntegrity({ ...baseOptions(dir), adapters }))
    assert.equal(second.status, 'PASS')
    assert.equal(registerCalls, 1, 'no second registration across a full second run')
    assert.equal(sendCalls, 1, 'no second email across a full second run')
    assert.equal(second.emailsSent, 0)
  })
})
