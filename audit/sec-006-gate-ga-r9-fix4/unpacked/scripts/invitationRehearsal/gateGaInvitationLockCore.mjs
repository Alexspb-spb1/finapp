// gate-G-A invitation-lock id (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8).
//
// A byte-exact mirror of functions/src/schemas/invitation.ts's
// computeInvitationLockId(companyId, emailNormalized) — deliberately
// duplicated rather than imported (this script tree runs standalone,
// outside the Functions build) but kept provably identical: this file's
// own self-test asserts the SAME lock id functions/src actually writes to
// (via a real inviteMember call against the emulator, cross-checked
// against the lockPath the existing gateGaEmulatorAdapters.inviteRecipient
// discovers independently by query) — see gateGaInvitationLockSelfTest.mjs.
//
// Used ONLY for narrow, exact, read-only resume reconciliation: given a
// run's own (already-known, deterministic) companyId and the
// owner-confirmed recipient email, resume can point-read
// invitationLocks/{lockId} directly — never a broad scan — to discover
// whether inviteMember already completed externally before a crash
// prevented the local run manifest from ever recording it.
import { createHash } from 'node:crypto'

export function computeInvitationLockId(companyId, emailNormalized) {
  const serialized = JSON.stringify([companyId, emailNormalized])
  return createHash('sha256').update(serialized).digest('hex')
}
