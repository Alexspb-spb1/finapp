// Real callable pipeline proof for cancelInvite — SEC-006 Stage 3.
//
// Every test calls the ACTUAL deployed `cancelInvite` callable through the
// Functions Emulator (not a direct in-process function call), using real
// Auth Emulator-issued identities and real Firestore Emulator documents —
// no mocked Firestore for these checks (CLAUDE.md §8.6, task instructions).
import { describe, it, expect, afterEach } from 'vitest'
import { FunctionsError } from 'firebase/functions'
import { Timestamp } from 'firebase-admin/firestore'
import {
  createTestUser, signOutClient, signInAsExistingUser, seedCompany, seedMembership,
  callCancelInvite, seedInvitationDoc, getInvitationDoc,
  getInvitationLockDoc, seedInvitationLockDoc,
  getInvitationsSnapshotForCompany, getMembershipsSnapshot, getAuditEvents, countAuditEvents,
  authUserExistsWithEmail, setMaintenanceMode, clearMaintenanceMode,
} from './helpers'

function appCodeOf(err: unknown): string | undefined {
  if (err instanceof FunctionsError) {
    const details = err.details as { appCode?: string } | undefined
    return details?.appCode
  }
  return undefined
}

let companyCounter = 0
function freshCompanyId(label: string): string {
  companyCounter += 1
  return `co_cancel_${label}_${Date.now()}_${companyCounter}`
}

let emailCounter = 0
function freshEmail(label: string): string {
  emailCounter += 1
  return `invitee-cancel-${label}-${Date.now()}-${emailCounter}@example.test`
}

async function setUpAdmin(label: string): Promise<{ companyId: string; adminUid: string }> {
  const companyId = freshCompanyId(label)
  await seedCompany(companyId)
  const { uid: adminUid } = await createTestUser(true, `${label}-admin`)
  await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
  return { companyId, adminUid }
}

function buildRawPendingInvitation(companyId: string, email: string, createdAt: Timestamp) {
  return {
    companyId,
    emailNormalized: email,
    role: 'viewer' as const,
    tokenHash: '0'.repeat(64),
    status: 'pending' as const,
    expiresAt: Timestamp.fromMillis(createdAt.toMillis() + 1000 * 3600 * 24 * 7),
    createdBy: 'uid_seed_synthetic',
    createdAt,
    updatedAt: createdAt,
    resendCount: 0,
    lastSentAt: createdAt,
  }
}

interface CancelInviteResult {
  inviteId: string
  revokedAtUtc: string
}

/** Snapshots invitations/memberships/audit for a company — used for "unrelated state is untouched" assertions. */
async function snapshotCompanyState(companyId: string) {
  return {
    invitations: await getInvitationsSnapshotForCompany(companyId),
    memberships: await getMembershipsSnapshot(companyId),
    audit: await getAuditEvents(companyId),
  }
}

describe('cancelInvite — real callable pipeline through the Functions Emulator', () => {
  afterEach(async () => {
    await clearMaintenanceMode()
  })

  // ── 1-2: happy path, exact response shape, document transitions to revoked ──
  it('a verified admin cancels a pending invitation belonging to their own company', async () => {
    const { companyId } = await setUpAdmin('happy')
    const email = freshEmail('happy')
    const inviteId = 'invite_happy_cancel'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))

    const before = Date.now()
    const result = (await callCancelInvite({ companyId, inviteId })) as CancelInviteResult
    const after = Date.now()

    expect(Object.keys(result).sort()).toEqual(['inviteId', 'revokedAtUtc'])
    expect(result.inviteId).toBe(inviteId)
    const revokedAtMillis = Date.parse(result.revokedAtUtc)
    expect(revokedAtMillis).toBeGreaterThanOrEqual(before)
    expect(revokedAtMillis).toBeLessThanOrEqual(after)

    const invite = await getInvitationDoc(inviteId)
    expect(invite).toMatchObject({ status: 'revoked', revokedBy: expect.any(String) })
    expect((invite?.revokedAt as Timestamp).toDate().toISOString()).toBe(result.revokedAtUtc)
    // Everything else about the document is unchanged (role/email/tokenHash/etc).
    expect(invite?.emailNormalized).toBe(email)
    expect(invite?.role).toBe('viewer')
    expect(invite?.tokenHash).toBe('0'.repeat(64))
  })

  // ── 3: response never leaks token/tokenHash/email/role ──────────────────
  it('the response never contains tokenHash, email, or role', async () => {
    const { companyId } = await setUpAdmin('response-shape')
    const email = freshEmail('response-shape')
    const inviteId = 'invite_response_shape'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))

    const result = (await callCancelInvite({ companyId, inviteId })) as CancelInviteResult
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('0'.repeat(64)) // tokenHash
    expect(serialized).not.toContain(email)
    expect(serialized).not.toContain('viewer')
  })

  // ── 4: unauthenticated ────────────────────────────────────────────────────
  it('an unauthenticated call is rejected with auth_required, and changes nothing', async () => {
    const { companyId } = await setUpAdmin('unauth')
    const email = freshEmail('unauth')
    const inviteId = 'invite_unauth'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))
    await signOutClient()

    await expect(callCancelInvite({ companyId, inviteId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'auth_required')
    expect((await getInvitationDoc(inviteId))?.status).toBe('pending')
  })

  // ── 5: unverified ─────────────────────────────────────────────────────────
  it('an unverified admin is denied with email_unverified, and changes nothing', async () => {
    const companyId = freshCompanyId('unverified')
    await seedCompany(companyId)
    const { uid } = await createTestUser(false, 'unverified-admin')
    await seedMembership({ companyId, uid, role: 'admin', status: 'active' })
    const email = freshEmail('unverified')
    const inviteId = 'invite_unverified'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))

    await expect(callCancelInvite({ companyId, inviteId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'email_unverified')
    expect((await getInvitationDoc(inviteId))?.status).toBe('pending')
  })

  // ── 6: viewer/accountant ──────────────────────────────────────────────────
  it.each(['viewer', 'accountant'] as const)('a %s (not admin) is denied with insufficient_role, and changes nothing', async role => {
    const companyId = freshCompanyId(`role-${role}`)
    await seedCompany(companyId)
    const { uid } = await createTestUser(true, `role-${role}`)
    await seedMembership({ companyId, uid, role, status: 'active' })
    const email = freshEmail(`role-${role}`)
    const inviteId = `invite_role_${role}`
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))

    await expect(callCancelInvite({ companyId, inviteId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'insufficient_role')
    expect((await getInvitationDoc(inviteId))?.status).toBe('pending')
  })

  // ── 7: cross-company — oracle-safe (not found vs. wrong company look identical) ──
  it('an admin using their OWN companyId but an inviteId belonging to a DIFFERENT company gets invitation_not_found, and changes nothing', async () => {
    const { companyId: companyA } = await setUpAdmin('cross-a')
    const { companyId: companyB, adminUid: adminB } = await setUpAdmin('cross-b')
    const email = freshEmail('cross')
    const inviteId = 'invite_cross_company'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyA, email, Timestamp.now()))

    await signInAsExistingUser(adminB)
    await expect(callCancelInvite({ companyId: companyB, inviteId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invitation_not_found')
    expect((await getInvitationDoc(inviteId))?.status).toBe('pending')
  })

  it('a missing inviteId gives the SAME invitation_not_found as a cross-company one (no existence oracle)', async () => {
    const { companyId } = await setUpAdmin('missing-invite')
    await expect(callCancelInvite({ companyId, inviteId: 'invite_does_not_exist_at_all' }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invitation_not_found')
  })

  it('an admin acting as a DIFFERENT company they are not a member of gets membership_not_found', async () => {
    const { companyId: companyA } = await setUpAdmin('membership-cross-a')
    await setUpAdmin('membership-cross-b') // adminB stays signed in, has no membership in companyA
    await expect(callCancelInvite({ companyId: companyA, inviteId: 'invite_irrelevant' }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'membership_not_found')
  })

  // ── 8: maintenance mode ───────────────────────────────────────────────────
  it('refuses with maintenance_mode when system/maintenance.enabled is true, and changes nothing', async () => {
    const { companyId } = await setUpAdmin('maintenance')
    const email = freshEmail('maintenance')
    const inviteId = 'invite_maintenance'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))
    await setMaintenanceMode(true)

    await expect(callCancelInvite({ companyId, inviteId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'maintenance_mode')
    expect((await getInvitationDoc(inviteId))?.status).toBe('pending')
  })

  // ── 9: already accepted / already revoked ────────────────────────────────
  it('an already-ACCEPTED invitation cannot be cancelled — invitation_not_pending, document unchanged', async () => {
    const { companyId } = await setUpAdmin('already-accepted')
    const email = freshEmail('already-accepted')
    const inviteId = 'invite_already_accepted'
    const now = Timestamp.now()
    await seedInvitationDoc(inviteId, {
      ...buildRawPendingInvitation(companyId, email, now),
      status: 'accepted',
      acceptedAt: now,
      acceptedByUid: 'uid_who_accepted_synthetic',
    })

    const before = await getInvitationDoc(inviteId)
    await expect(callCancelInvite({ companyId, inviteId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invitation_not_pending')
    expect(await getInvitationDoc(inviteId)).toEqual(before)
  })

  it('an already-REVOKED invitation cannot be cancelled again — invitation_not_pending, document unchanged', async () => {
    const { companyId } = await setUpAdmin('already-revoked')
    const email = freshEmail('already-revoked')
    const inviteId = 'invite_already_revoked'
    const now = Timestamp.now()
    await seedInvitationDoc(inviteId, {
      ...buildRawPendingInvitation(companyId, email, now),
      status: 'revoked',
      revokedAt: now,
      revokedBy: 'uid_other_admin_synthetic',
    })

    const before = await getInvitationDoc(inviteId)
    await expect(callCancelInvite({ companyId, inviteId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invitation_not_pending')
    expect(await getInvitationDoc(inviteId)).toEqual(before)
  })

  // ── 10: corrupted document ────────────────────────────────────────────────
  it('a corrupted invitation document (fails InvitationDocumentSchema) causes a safe internal_error, document left untouched', async () => {
    const { companyId } = await setUpAdmin('corrupted')
    const inviteId = 'invite_corrupted'
    await seedInvitationDoc(inviteId, {
      companyId,
      emailNormalized: freshEmail('corrupted'),
      role: 'not-a-real-role',
      status: 'pending',
      expiresAt: Timestamp.now(),
      createdBy: 'uid_seed_synthetic',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      resendCount: 0,
      lastSentAt: null,
      // tokenHash deliberately omitted.
    })
    const before = await getInvitationDoc(inviteId)

    await expect(callCancelInvite({ companyId, inviteId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'internal_error')
    expect(await getInvitationDoc(inviteId)).toEqual(before)
  })

  // ── 11: extra/forged payload fields ───────────────────────────────────────
  it('extra payload fields (forged uid/status/revokedBy/etc.) are rejected as invalid_request before any write', async () => {
    const { companyId } = await setUpAdmin('forged-payload')
    const email = freshEmail('forged-payload')
    const inviteId = 'invite_forged_payload'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))

    for (const forged of [
      { uid: 'uid_attacker' },
      { status: 'revoked' },
      { revokedBy: 'uid_attacker' },
      { revokedAt: new Date().toISOString() },
    ]) {
      await expect(callCancelInvite({ companyId, inviteId, ...forged }))
        .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
    }
    expect((await getInvitationDoc(inviteId))?.status).toBe('pending')
  })

  // ── 12: audit event — exact safe field set, correct action, no PII ────────
  it('creates exactly one audit event with the exact safe field set and no email/role/token/tokenHash', async () => {
    const { companyId } = await setUpAdmin('audit')
    const email = freshEmail('audit')
    const inviteId = 'invite_audit'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))

    await callCancelInvite({ companyId, inviteId })

    const auditEvents = await getAuditEvents(companyId)
    expect(auditEvents).toHaveLength(1)
    const auditEvent = auditEvents[0]!
    expect(Object.keys(auditEvent).sort()).toEqual(['action', 'actorUid', 'createdAt', 'targetUid'])
    expect(auditEvent.action).toBe('invitation_cancelled')
    expect(auditEvent.targetUid).toBeNull()
    expect(JSON.stringify(auditEvent)).not.toContain(email)
    expect(JSON.stringify(auditEvent)).not.toContain('0'.repeat(64))
  })

  // ── 13: invitationLocks are left completely untouched ────────────────────
  it('leaves invitationLocks, other invitations, memberships, and audit events for the company completely unrelated/unchanged besides the target invitation and its own audit event', async () => {
    const { companyId } = await setUpAdmin('no-side-effects')
    const email = freshEmail('no-side-effects')
    const inviteId = 'invite_no_side_effects'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))
    // The lock still points at this (now soon-to-be-cancelled) invitation —
    // cancelInvite must not touch it at all (see runCancelInviteTransaction's
    // own comment: a revoked target behind the lock is already safely
    // replaceable by inviteMember, so there is nothing to clean up here).
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })
    const lockBefore = await getInvitationLockDoc(companyId, email)

    const otherInviteId = 'invite_unrelated_untouched'
    const otherEmail = freshEmail('unrelated')
    await seedInvitationDoc(otherInviteId, buildRawPendingInvitation(companyId, otherEmail, Timestamp.now()))
    const membershipsBefore = await getMembershipsSnapshot(companyId)

    await callCancelInvite({ companyId, inviteId })

    const lockAfter = await getInvitationLockDoc(companyId, email)
    expect(lockAfter).toEqual(lockBefore)
    expect(lockAfter).toEqual({ currentInviteId: inviteId })

    const otherInvite = await getInvitationDoc(otherInviteId)
    expect(otherInvite?.status).toBe('pending') // completely untouched

    const membershipsAfter = await getMembershipsSnapshot(companyId)
    expect(membershipsAfter).toEqual(membershipsBefore)

    expect(await countAuditEvents(companyId)).toBe(1) // only the one event for the cancelled invite
  })

  // ── 14: no Firebase Auth user is created ─────────────────────────────────
  it('creates no Firebase Auth user', async () => {
    const { companyId } = await setUpAdmin('no-auth-user')
    const email = freshEmail('no-auth-user')
    const inviteId = 'invite_no_auth_user'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))

    expect(await authUserExistsWithEmail(email)).toBe(false)
    await callCancelInvite({ companyId, inviteId })
    expect(await authUserExistsWithEmail(email)).toBe(false)
  })

  // ── 15: genuine concurrency — exactly one winner, run twice ──────────────
  it.each([1, 2])('concurrent cancel pair #%i on the SAME pending invite: exactly one success, the other gets invitation_not_pending, final state revoked exactly once', async run => {
    const { companyId } = await setUpAdmin(`concurrent-${run}`)
    const email = freshEmail(`concurrent-${run}`)
    const inviteId = `invite_concurrent_${run}`
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))

    const [a, b] = await Promise.allSettled([
      callCancelInvite({ companyId, inviteId }),
      callCancelInvite({ companyId, inviteId }),
    ])
    const fulfilled = [a, b].filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
    const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(appCodeOf(rejected[0]!.reason)).toBe('invitation_not_pending')

    const invite = await getInvitationDoc(inviteId)
    expect(invite?.status).toBe('revoked')
    expect(await countAuditEvents(companyId)).toBe(1) // exactly one cancellation recorded, not two
  })

  // ── 16: forced transaction retry stays internally consistent ────────────
  // The AUTHORITATIVE proof that a retry cannot recompute revokedAt is
  // functions/test/unit/cancelInviteTransaction.test.ts (an injected
  // transaction runner invoking the update function twice against fake
  // Transactions). This emulator test is a supplementary, best-effort
  // empirical check: it forces real contention on cancelInvite's OWN
  // transaction read-set (the caller's membership doc) via repeated
  // concurrent writes during a real call.
  it('forcing contention on the transaction read-set (concurrent writes to the admin membership doc) still yields exactly one consistent cancellation', async () => {
    const { companyId, adminUid } = await setUpAdmin('forced-retry')
    const email = freshEmail('forced-retry')
    const inviteId = 'invite_forced_retry'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))

    const cancelPromise = callCancelInvite({ companyId, inviteId }) as Promise<CancelInviteResult>
    const contentionPromises = Array.from({ length: 8 }, () =>
      seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' }),
    )

    const result = await cancelPromise
    await Promise.all(contentionPromises)

    const invite = await getInvitationDoc(inviteId)
    expect(invite?.status).toBe('revoked')
    expect((invite?.revokedAt as Timestamp).toDate().toISOString()).toBe(result.revokedAtUtc)
    expect(await countAuditEvents(companyId)).toBe(1)
  })

  // ── 17: unrelated company state is fully untouched by a successful call ──
  it('does not touch a completely unrelated second company\'s state at all', async () => {
    const { companyId, adminUid } = await setUpAdmin('isolation-a')
    const { companyId: otherCompanyId } = await setUpAdmin('isolation-b')
    const email = freshEmail('isolation')
    const inviteId = 'invite_isolation'
    await seedInvitationDoc(inviteId, buildRawPendingInvitation(companyId, email, Timestamp.now()))

    const otherBefore = await snapshotCompanyState(otherCompanyId)
    await signInAsExistingUser(adminUid)
    await callCancelInvite({ companyId, inviteId })
    const otherAfter = await snapshotCompanyState(otherCompanyId)

    expect(otherAfter).toEqual(otherBefore)
  })
})
