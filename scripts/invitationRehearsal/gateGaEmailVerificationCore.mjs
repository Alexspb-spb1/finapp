// gate-G-A owner-in-the-loop email verification (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R6).
// Scope: exactly the single verification email — a durable, recipient-keyed
// checkpoint that makes "at most one email, ever, for this recipient" a
// filesystem-enforced fact (not a runtime counter), plus bounded polling for
// the owner's real click (Firebase Auth's emailVerified flag), resumable
// across process restarts without ever re-sending.
//
// R6: the recipient's Auth password is now a real CSPRNG secret, generated
// once at claim time and persisted ONLY in this checkpoint file (mode 0o600,
// outside the repository, never git-tracked) — never derived from the email,
// never logged, never written to the orchestrator journal or the run's
// output/result JSON. `readEmailCheckpoint`'s caller is responsible for never
// forwarding `recipientPassword` anywhere but a signUp/signIn adapter call;
// see gateGaOrchestratorCore.mjs's journal.append calls, none of which ever
// receive the checkpoint object itself, and the secret-scan self-test in
// gateGaEmailVerificationSelfTest.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const blocked = reason => { throw new Error(`gate_ga_email_verification_blocked:${reason ?? ''}`) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export const EMAIL_STATUSES = Object.freeze(['MAY_BE_SENT', 'SENT', 'VERIFIED'])
export const EMAIL_CHECKPOINT_VERSION = 2

// CSPRNG, never derived from the recipient's identity — a real secret, not a
// deterministic function of public input.
export function generateRecipientPassword() {
  return `GateGA-${randomBytes(24).toString('base64url')}!Aa1`
}

export function checkpointPathFor({ checkpointDir, recipientSha256 }) {
  if (typeof checkpointDir !== 'string' || !path.isAbsolute(checkpointDir)) blocked('bad_checkpoint_dir')
  if (typeof recipientSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(recipientSha256)) blocked('bad_recipient_sha256')
  return path.join(checkpointDir, `email-checkpoint-${recipientSha256}.json`)
}

export function readEmailCheckpoint({ checkpointDir, recipientSha256, io = fs }) {
  const p = checkpointPathFor({ checkpointDir, recipientSha256 })
  if (!io.existsSync(p)) return null
  let value
  try { value = JSON.parse(io.readFileSync(p, 'utf8')) } catch { blocked('checkpoint_corrupt') }
  if (!record(value) || value.version !== EMAIL_CHECKPOINT_VERSION || value.recipientSha256 !== recipientSha256 ||
      !EMAIL_STATUSES.includes(value.status) || typeof value.recipientPassword !== 'string' || value.recipientPassword.length < 16) blocked('checkpoint_corrupt')
  return value
}

function durableWrite(p, value, io, flag) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  let fd
  try {
    fd = io.openSync(p, flag, 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset)
      if (!Number.isSafeInteger(written) || written < 1) blocked('short_write')
      offset += written
    }
    io.fsyncSync(fd)
  } finally { if (fd !== undefined) io.closeSync(fd) }
  if (!io.readFileSync(p).equals(bytes)) blocked('reread_mismatch')
}

/**
 * Called BEFORE any send attempt. `fresh:true` means no checkpoint existed —
 * one was just durably claimed (exclusive `wx`) and the caller MAY proceed
 * to send exactly once. `fresh:false` means a checkpoint already existed for
 * this exact recipient — the caller MUST NOT send again under any
 * circumstance and must instead branch on `checkpoint.status`:
 *   'MAY_BE_SENT' -> the previous attempt's outcome is unknown; refuse
 *     (SAFE_STOP with recovery evidence), never resend, never poll.
 *   'SENT' or 'VERIFIED' -> resume: reuse checkpoint.recipientUid and go
 *     straight to polling (a 'VERIFIED' checkpoint's poll returns instantly).
 */
export function claimOrResumeEmailIntent({ checkpointDir, recipientSha256, now = () => new Date(), io = fs, generatePassword = generateRecipientPassword }) {
  const existing = readEmailCheckpoint({ checkpointDir, recipientSha256, io })
  if (existing) return Object.freeze({ fresh: false, checkpoint: Object.freeze(existing) })
  const p = checkpointPathFor({ checkpointDir, recipientSha256 })
  const value = {
    version: EMAIL_CHECKPOINT_VERSION, recipientSha256, status: 'MAY_BE_SENT',
    recipientUid: null, recipientPassword: generatePassword(), sentAt: null, updatedAt: now().toISOString(),
  }
  durableWrite(p, value, io, 'wx')
  return Object.freeze({ fresh: true, checkpoint: Object.freeze(value) })
}

export function markEmailSent({ checkpointDir, recipientSha256, recipientUid, now = () => new Date(), io = fs }) {
  const existing = readEmailCheckpoint({ checkpointDir, recipientSha256, io })
  if (!existing || existing.status !== 'MAY_BE_SENT') blocked('cannot_mark_sent_from_this_state')
  if (typeof recipientUid !== 'string' || !recipientUid) blocked('bad_recipient_uid')
  const value = { ...existing, status: 'SENT', recipientUid, sentAt: now().toISOString(), updatedAt: now().toISOString() }
  durableWrite(checkpointPathFor({ checkpointDir, recipientSha256 }), value, io, 'w')
  return Object.freeze(value)
}

// Idempotent on a checkpoint that is already 'VERIFIED': a crash between
// this write and the caller's subsequent acceptInvite would otherwise make
// every resume from that window fail with a spurious CAS refusal, even
// though the owner really did verify. 'MAY_BE_SENT' remains structurally
// unreachable, so a send can never be skipped by mistake.
export function markEmailVerified({ checkpointDir, recipientSha256, now = () => new Date(), io = fs }) {
  const existing = readEmailCheckpoint({ checkpointDir, recipientSha256, io })
  if (!existing || (existing.status !== 'SENT' && existing.status !== 'VERIFIED')) blocked('cannot_mark_verified_from_this_state')
  if (existing.status === 'VERIFIED') return Object.freeze(existing)
  const value = { ...existing, status: 'VERIFIED', updatedAt: now().toISOString() }
  durableWrite(checkpointPathFor({ checkpointDir, recipientSha256 }), value, io, 'w')
  return Object.freeze(value)
}

/**
 * Bounded polling for the owner's real click. `checkAuth(recipientUid)` must
 * resolve to `{uid, email, emailVerified}` (an adapter call — never a
 * network call from this file). Returns immediately on a mismatch (a
 * different account ever reporting verified is never accepted), on
 * verification, or on deadline; never retries past the deadline; any
 * thrown error from checkAuth propagates (fail-closed — "Auth polling
 * error" is a caller-visible failure, not silently retried forever).
 */
export async function pollForVerification({
  checkAuth, recipientUid, expectedEmail, deadlineMs, intervalMs,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(),
}) {
  if (typeof checkAuth !== 'function' || typeof recipientUid !== 'string' || !recipientUid) blocked('bad_poll_args')
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) blocked('bad_poll_bounds')
  const deadline = now() + deadlineMs
  let attempts = 0
  while (now() < deadline) {
    attempts++
    const result = await checkAuth(recipientUid)
    if (!record(result) || typeof result.emailVerified !== 'boolean') blocked('bad_check_auth_result')
    if (result.uid !== undefined && result.uid !== recipientUid) return Object.freeze({ verified: false, reason: 'UID_MISMATCH', attempts })
    if (result.email !== undefined && expectedEmail !== undefined && result.email !== expectedEmail) return Object.freeze({ verified: false, reason: 'EMAIL_MISMATCH', attempts })
    if (result.emailVerified === true) return Object.freeze({ verified: true, attempts })
    if (now() >= deadline) break
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
  }
  return Object.freeze({ verified: false, reason: 'TIMEOUT', attempts })
}
