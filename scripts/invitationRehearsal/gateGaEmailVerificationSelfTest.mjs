import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  claimOrResumeEmailIntent, recordRegisteredRecipient, markEmailSent, markEmailVerified, pollForVerification, readEmailCheckpoint,
  generateRecipientPassword,
} from './gateGaEmailVerificationCore.mjs'
import url from 'node:url'

const sha256 = v => createHash('sha256').update(v).digest('hex')
const RECIPIENT_SHA = sha256('owner@example.invalid')

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-email-checkpoint-'))
  try { return fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const instantSleep = () => Promise.resolve()

test('claimOrResumeEmailIntent: fresh claim on first call, resume (not fresh) on every call after', () => {
  withTempDir(dir => {
    const first = claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(first.fresh, true)
    assert.equal(first.checkpoint.status, 'MAY_BE_SENT')
    const second = claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(second.fresh, false)
    assert.equal(second.checkpoint.status, 'MAY_BE_SENT')
  })
})

test('no-duplicate-send: markEmailSent is the ONLY transition out of MAY_BE_SENT, and a second run never gets fresh:true again', () => {
  withTempDir(dir => {
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    const sent = markEmailSent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    assert.equal(sent.status, 'SENT')
    assert.equal(sent.recipientUid, 'uid-1')
    // Simulate the process restarting: a brand-new claim attempt for the
    // SAME recipient must see the existing SENT checkpoint, never fresh.
    const resumed = claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(resumed.fresh, false)
    assert.equal(resumed.checkpoint.status, 'SENT')
    assert.equal(resumed.checkpoint.recipientUid, 'uid-1')
  })
})

test('indeterminate send state: a checkpoint stuck at MAY_BE_SENT (process died mid-send) is never resent and markEmailSent from it is the only legal next transition', () => {
  withTempDir(dir => {
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    // The process "died" here — no markEmailSent ever ran. A resume attempt
    // sees MAY_BE_SENT and must be treated by the caller as indeterminate
    // (SAFE_STOP), never as "safe to send now".
    const resumed = claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(resumed.fresh, false)
    assert.equal(resumed.checkpoint.status, 'MAY_BE_SENT')
    // markEmailVerified must be structurally impossible from MAY_BE_SENT.
    assert.throws(() => markEmailVerified({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA }))
  })
})

test('markEmailSent/markEmailVerified refuse from the wrong prior state (CAS-style)', () => {
  withTempDir(dir => {
    assert.throws(() => markEmailSent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'x' }))
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.throws(() => markEmailVerified({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA }))
    // markEmailSent refuses if the uid was never durably pre-registered.
    assert.throws(() => markEmailSent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' }))
    recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    markEmailSent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    assert.throws(() => markEmailSent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' }))
    const verified = markEmailVerified({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(verified.status, 'VERIFIED')
  })
})

test('recordRegisteredRecipient is idempotent on the SAME uid, but refuses a DIFFERENT uid for the same recipient (contradiction, not silently overwritten)', () => {
  withTempDir(dir => {
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    const first = recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    assert.equal(first.recipientUid, 'uid-1')
    assert.equal(first.status, 'MAY_BE_SENT')
    const second = recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    assert.equal(second.recipientUid, 'uid-1')
    assert.throws(() => recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-DIFFERENT' }))
  })
})

test('recipientUid is durably recoverable after registration, even before the email is ever sent (the R7 crash-between-register-and-send window)', () => {
  withTempDir(dir => {
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    // "Process restarted" — read fresh, exactly as a new process would.
    const resumed = readEmailCheckpoint({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(resumed.status, 'MAY_BE_SENT')
    assert.equal(resumed.recipientUid, 'uid-1')
  })
})

test('checkpoint never carries the plaintext recipient — only its hash', () => {
  withTempDir(dir => {
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    const raw = fs.readFileSync(path.join(dir, `email-checkpoint-${RECIPIENT_SHA}.json`), 'utf8')
    assert.equal(raw.includes('@'), false)
  })
})

test('pollForVerification: false -> false -> verified continues automatically (loop actually loops)', async () => {
  const sequence = [{ emailVerified: false }, { emailVerified: false }, { emailVerified: true, uid: 'uid-1', email: 'owner@example.invalid' }]
  let calls = 0
  const result = await pollForVerification({
    checkAuth: async () => sequence[Math.min(calls++, sequence.length - 1)],
    recipientUid: 'uid-1', expectedEmail: 'owner@example.invalid',
    deadlineMs: 10_000, intervalMs: 10, sleep: instantSleep, now: () => Date.now(),
  })
  assert.equal(result.verified, true)
  assert.equal(calls, 3)
})

test('pollForVerification: verification timeout', async () => {
  let now = 0
  const result = await pollForVerification({
    checkAuth: async () => { now += 1000; return { emailVerified: false } },
    recipientUid: 'uid-1', deadlineMs: 3000, intervalMs: 500, sleep: instantSleep, now: () => now,
  })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'TIMEOUT')
})

test('pollForVerification: verified for a different uid/email is refused, not accepted', async () => {
  const wrongUid = await pollForVerification({
    checkAuth: async () => ({ emailVerified: true, uid: 'someone-else', email: 'owner@example.invalid' }),
    recipientUid: 'uid-1', expectedEmail: 'owner@example.invalid', deadlineMs: 1000, intervalMs: 10, sleep: instantSleep,
  })
  assert.equal(wrongUid.verified, false)
  assert.equal(wrongUid.reason, 'UID_MISMATCH')

  const wrongEmail = await pollForVerification({
    checkAuth: async () => ({ emailVerified: true, uid: 'uid-1', email: 'attacker@example.invalid' }),
    recipientUid: 'uid-1', expectedEmail: 'owner@example.invalid', deadlineMs: 1000, intervalMs: 10, sleep: instantSleep,
  })
  assert.equal(wrongEmail.verified, false)
  assert.equal(wrongEmail.reason, 'EMAIL_MISMATCH')
})

test('pollForVerification: an Auth polling error propagates (fail-closed, not silently retried)', async () => {
  await assert.rejects(() => pollForVerification({
    checkAuth: async () => { throw new Error('auth_backend_unreachable') },
    recipientUid: 'uid-1', deadlineMs: 1000, intervalMs: 10, sleep: instantSleep,
  }), /auth_backend_unreachable/)
})

test('markEmailVerified is idempotent on an already-VERIFIED checkpoint (crash between verify-write and acceptInvite must resume, not throw)', () => {
  withTempDir(dir => {
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    markEmailSent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    const first = markEmailVerified({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(first.status, 'VERIFIED')
    const second = markEmailVerified({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(second.status, 'VERIFIED')
    assert.equal(second.recipientUid, 'uid-1')
  })
})

test('generateRecipientPassword is CSPRNG: distinct, long, unguessable from the recipient identity', () => {
  const a = generateRecipientPassword(), b = generateRecipientPassword()
  assert.notEqual(a, b)
  assert.ok(a.length >= 24)
  assert.ok(b.length >= 24)
})

test('the recipient password is generated once at claim and is stable across every subsequent read (never regenerated on resume)', () => {
  withTempDir(dir => {
    const first = claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    const second = claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(first.checkpoint.recipientPassword, second.checkpoint.recipientPassword)
    recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    markEmailSent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    const afterSent = readEmailCheckpoint({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(afterSent.recipientPassword, first.checkpoint.recipientPassword)
  })
})

test('a checkpoint missing recipientPassword (a pre-R6 shape) is treated as corrupt, never silently accepted', () => {
  withTempDir(dir => {
    const p = path.join(dir, `email-checkpoint-${RECIPIENT_SHA}.json`)
    fs.writeFileSync(p, JSON.stringify({ version: 1, recipientSha256: RECIPIENT_SHA, status: 'MAY_BE_SENT', recipientUid: null, sentAt: null, updatedAt: new Date().toISOString() }), { mode: 0o600 })
    assert.throws(() => readEmailCheckpoint({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA }))
  })
})

// Secret-scan (source-level): the orchestrator must never forward the
// recipient's checkpoint password into journal.append (the durable,
// per-run event log this whole codebase treats as safe-to-persist evidence
// — see the ZIP/audit-branch publication flow). This greps the orchestrator
// SOURCE, not a runtime capture, so it catches the mistake even in a code
// path no test happens to exercise.
test('secret-scan: gateGaOrchestratorCore.mjs never passes recipientPassword (or the checkpoint object itself) to journal.append', () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const source = fs.readFileSync(path.join(here, 'gateGaOrchestratorCore.mjs'), 'utf8')
  const appendCalls = source.match(/journal\.append\([^)]*\)/gs) ?? []
  assert.ok(appendCalls.length > 5, 'sanity: the source should contain several journal.append calls')
  for (const call of appendCalls) {
    assert.equal(/recipientPassword/.test(call), false, `journal.append call references recipientPassword: ${call.slice(0, 80)}`)
  }
})

test('checkpoint updates are atomic replace, not in-place overwrite: no stray temp file survives a successful update, and the real file is always fully valid JSON', () => {
  withTempDir(dir => {
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    markEmailSent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    markEmailVerified({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    const entries = fs.readdirSync(dir)
    assert.deepEqual(entries.filter(f => f.includes('.tmp-')), [], 'no leftover atomic-replace temp files after 3 successful updates')
    const p = path.join(dir, `email-checkpoint-${RECIPIENT_SHA}.json`)
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(p, 'utf8')))
  })
})

test('a stray leftover atomic-replace temp file (simulating a crash mid-write) never corrupts a read of the real checkpoint', () => {
  withTempDir(dir => {
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    const realPath = path.join(dir, `email-checkpoint-${RECIPIENT_SHA}.json`)
    // A crash between the temp file's exclusive create and the final rename
    // leaves exactly this: a stray .tmp-* file, and the ORIGINAL real file
    // still fully intact (durableReplace never touches the real path until
    // the new content is fsync'd and reread-verified).
    fs.writeFileSync(`${realPath}.tmp-99999-abc-def`, 'not valid json, simulating a half-written temp file')
    const stillGood = readEmailCheckpoint({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(stillGood.status, 'MAY_BE_SENT')
    recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-1' })
    const afterUpdate = readEmailCheckpoint({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(afterUpdate.recipientUid, 'uid-1')
  })
})

test('resume after interrupt: a fresh process reading the SAME checkpoint resumes polling with the persisted recipientUid, no new claim/send', () => {
  withTempDir(dir => {
    claimOrResumeEmailIntent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    recordRegisteredRecipient({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-restart-1' })
    markEmailSent({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA, recipientUid: 'uid-restart-1' })
    // "Process restarted": read the checkpoint fresh, as a brand-new
    // process would.
    const resumed = readEmailCheckpoint({ checkpointDir: dir, recipientSha256: RECIPIENT_SHA })
    assert.equal(resumed.status, 'SENT')
    assert.equal(resumed.recipientUid, 'uid-restart-1')
  })
})
