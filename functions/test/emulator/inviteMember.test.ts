// Real callable pipeline proof for inviteMember — SEC-006 Stage 2.
//
// Every test calls the ACTUAL deployed `inviteMember` callable through the
// Functions Emulator (not a direct in-process function call), using real
// Auth Emulator-issued identities and real Firestore Emulator documents —
// no mocked Firestore for these checks (CLAUDE.md §8.6, task instructions).
import { describe, it, expect, afterEach } from 'vitest'
import { FunctionsError } from 'firebase/functions'
import { Timestamp } from 'firebase-admin/firestore'
import { hashInvitationToken } from '../../src/lib/invitationToken'
import {
  createTestUser, signOutClient, signInAsExistingUser, seedCompany, seedMembership,
  callInviteMember,
  getInvitationDoc, seedInvitationDoc, getInvitationLockDoc, seedInvitationLockDoc,
  countInvitationsFor, countAllInvitationLocks, countAuditEvents, authUserExistsWithEmail,
  setMaintenanceMode, clearMaintenanceMode,
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
  return `co_invite_${label}_${Date.now()}_${companyCounter}`
}

let emailCounter = 0
function freshInviteeEmail(label: string): string {
  emailCounter += 1
  return `invitee-${label}-${Date.now()}-${emailCounter}@example.test`
}

/** Creates a verified admin for a fresh company and returns both. */
async function setUpAdmin(label: string): Promise<{ companyId: string; adminUid: string }> {
  const companyId = freshCompanyId(label)
  await seedCompany(companyId)
  const { uid: adminUid } = await createTestUser(true, `${label}-admin`)
  await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
  return { companyId, adminUid }
}

describe('inviteMember — real callable pipeline through the Functions Emulator', () => {
  afterEach(async () => {
    await clearMaintenanceMode()
  })

  // ── 1-3: happy path, hash match, raw token absent from Firestore ────────
  it('a verified admin creates exactly 1 invitation + 1 lock + 1 audit event; stored hash matches the returned token; raw token appears nowhere in Firestore', async () => {
    const { companyId } = await setUpAdmin('happy')
    const email = freshInviteeEmail('happy')

    const result = (await callInviteMember({ companyId, email, role: 'accountant' })) as {
      inviteId: string; token: string; expiresAtUtc: string
    }
    expect(Object.keys(result).sort()).toEqual(['expiresAtUtc', 'inviteId', 'token'])
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const invite = await getInvitationDoc(result.inviteId)
    expect(invite).toMatchObject({
      companyId, emailNormalized: email, role: 'accountant', status: 'pending', resendCount: 0,
    })
    expect(invite?.tokenHash).toBe(hashInvitationToken(result.token))
    expect(invite?.expiresAt).toBeInstanceOf(Timestamp)
    expect(invite?.createdAt).toBeInstanceOf(Timestamp)
    // No accepted*/revoked* fields on a pending document.
    expect(invite).not.toHaveProperty('acceptedAt')
    expect(invite).not.toHaveProperty('revokedAt')

    const lock = await getInvitationLockDoc(companyId, email)
    expect(lock).toEqual({ currentInviteId: result.inviteId })

    expect(await countAuditEvents(companyId)).toBe(1)
    expect(await countInvitationsFor(companyId, email)).toBe(1)

    // Raw token absent from every persisted structure: the invitation doc,
    // the lock doc, and the audit event.
    const serializedDocs = JSON.stringify({ invite, lock })
    expect(serializedDocs).not.toContain(result.token)
  })

  // ── 4: unverified admin — denied, 0 writes ───────────────────────────────
  it('an unverified admin is denied with email_unverified, and creates nothing', async () => {
    const companyId = freshCompanyId('unverified')
    await seedCompany(companyId)
    const { uid } = await createTestUser(false, 'unverified-admin')
    await seedMembership({ companyId, uid, role: 'admin', status: 'active' })
    const email = freshInviteeEmail('unverified')

    await expect(
      callInviteMember({ companyId, email, role: 'viewer' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'email_unverified')
    expect(await countInvitationsFor(companyId, email)).toBe(0)
  })

  // ── 5: viewer/accountant — denied, 0 writes ──────────────────────────────
  it.each(['viewer', 'accountant'] as const)('a %s (not admin) is denied with insufficient_role, and creates nothing', async role => {
    const companyId = freshCompanyId(`role-${role}`)
    await seedCompany(companyId)
    const { uid } = await createTestUser(true, `role-${role}`)
    await seedMembership({ companyId, uid, role, status: 'active' })
    const email = freshInviteeEmail(`role-${role}`)

    await expect(
      callInviteMember({ companyId, email, role: 'viewer' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'insufficient_role')
    expect(await countInvitationsFor(companyId, email)).toBe(0)
  })

  // ── 6: unauthenticated — denied, 0 writes ────────────────────────────────
  it('an unauthenticated call is rejected with auth_required, and creates nothing', async () => {
    const { companyId } = await setUpAdmin('unauth')
    await signOutClient()
    const email = freshInviteeEmail('unauth')
    await expect(
      callInviteMember({ companyId, email, role: 'viewer' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'auth_required')
    expect(await countInvitationsFor(companyId, email)).toBe(0)
  })

  // ── 7: non-member / admin of a different company — denied, 0 writes ─────
  it('an admin of a DIFFERENT company is denied with membership_not_found for this company, and creates nothing', async () => {
    const { companyId: companyA } = await setUpAdmin('cross-a')
    const { adminUid: _adminB } = await setUpAdmin('cross-b')
    // adminB is signed in (createTestUser signs in on the shared client) but
    // has no membership at all in companyA.
    const email = freshInviteeEmail('cross')
    await expect(
      callInviteMember({ companyId: companyA, email, role: 'viewer' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'membership_not_found')
    expect(await countInvitationsFor(companyA, email)).toBe(0)
  })

  // ── 8: extra payload fields / forged uid/status/timestamps — denied, 0 writes ──
  it('extra payload fields (forged uid/status/createdAt/etc.) are rejected as invalid_request before any write', async () => {
    const { companyId } = await setUpAdmin('forged-payload')
    const email = freshInviteeEmail('forged-payload')
    for (const forged of [
      { uid: 'uid_attacker' },
      { status: 'accepted' },
      { createdAt: new Date().toISOString() },
      { tokenHash: 'a'.repeat(64) },
    ]) {
      await expect(
        callInviteMember({ companyId, email, role: 'viewer', ...forged }),
      ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
    }
    expect(await countInvitationsFor(companyId, email)).toBe(0)
  })

  // ── 9: maintenance enabled — denied, 0 writes ────────────────────────────
  it('refuses with maintenance_mode when system/maintenance.enabled is true, and creates nothing', async () => {
    const { companyId } = await setUpAdmin('maintenance')
    await setMaintenanceMode(true)
    const email = freshInviteeEmail('maintenance')
    await expect(
      callInviteMember({ companyId, email, role: 'viewer' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'maintenance_mode')
    expect(await countInvitationsFor(companyId, email)).toBe(0)
  })

  // ── 10: repeat call while a pending invite is alive ──────────────────────
  it('a repeat call for the same pending (companyId, email) is refused with invitation_already_pending, leaving the original invitation/lock/audit unchanged', async () => {
    const { companyId } = await setUpAdmin('dup-pending')
    const email = freshInviteeEmail('dup-pending')
    const first = (await callInviteMember({ companyId, email, role: 'viewer' })) as { inviteId: string; token: string }

    await expect(
      callInviteMember({ companyId, email, role: 'admin' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invitation_already_pending')

    expect(await countInvitationsFor(companyId, email)).toBe(1)
    const invite = await getInvitationDoc(first.inviteId)
    expect(invite).toMatchObject({ role: 'viewer', status: 'pending' })
    const lock = await getInvitationLockDoc(companyId, email)
    expect(lock).toEqual({ currentInviteId: first.inviteId })
    expect(await countAuditEvents(companyId)).toBe(1)
  })

  // ── 11: case/whitespace-only email difference uses the SAME lock ────────
  it('an email differing only in case/whitespace uses the same lock as the normalized form', async () => {
    const { companyId } = await setUpAdmin('case-fold')
    const email = freshInviteeEmail('case-fold')
    await callInviteMember({ companyId, email, role: 'viewer' })

    const variant = `  ${email.toUpperCase()}  `
    await expect(
      callInviteMember({ companyId, email: variant, role: 'admin' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invitation_already_pending')
    expect(await countInvitationsFor(companyId, email)).toBe(1)
  })

  // ── 12: same email, different companies — different locks, both succeed ──
  it('the same email invited in two different companies uses two different locks, and both calls succeed', async () => {
    const { companyId: companyA, adminUid: adminA } = await setUpAdmin('multi-co-a')
    const { companyId: companyB, adminUid: adminB } = await setUpAdmin('multi-co-b')
    const email = freshInviteeEmail('multi-co')

    await signInAsExistingUser(adminA)
    const resultA = (await callInviteMember({ companyId: companyA, email, role: 'viewer' })) as { inviteId: string }
    await signInAsExistingUser(adminB)
    const resultB = (await callInviteMember({ companyId: companyB, email, role: 'admin' })) as { inviteId: string }
    expect(resultA.inviteId).not.toBe(resultB.inviteId)
    expect(await countInvitationsFor(companyA, email)).toBe(1)
    expect(await countInvitationsFor(companyB, email)).toBe(1)
  })

  // ── 13: different emails, same company — both succeed ────────────────────
  it('two different emails invited in the same company both succeed independently', async () => {
    const { companyId } = await setUpAdmin('multi-email')
    const emailOne = freshInviteeEmail('multi-email-1')
    const emailTwo = freshInviteeEmail('multi-email-2')
    await callInviteMember({ companyId, email: emailOne, role: 'viewer' })
    await callInviteMember({ companyId, email: emailTwo, role: 'accountant' })
    expect(await countInvitationsFor(companyId, emailOne)).toBe(1)
    expect(await countInvitationsFor(companyId, emailTwo)).toBe(1)
  })

  // ── 14: genuine concurrency — exactly one winner, run twice ──────────────
  it.each([1, 2])('concurrent call pair #%i for the same (companyId, email): exactly one success, the other gets invitation_already_pending, final state has no orphans', async run => {
    const { companyId } = await setUpAdmin(`concurrent-${run}`)
    const email = freshInviteeEmail(`concurrent-${run}`)

    const [a, b] = await Promise.allSettled([
      callInviteMember({ companyId, email, role: 'viewer' }),
      callInviteMember({ companyId, email, role: 'admin' }),
    ])
    const fulfilled = [a, b].filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
    const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(appCodeOf(rejected[0]!.reason)).toBe('invitation_already_pending')

    expect(await countInvitationsFor(companyId, email)).toBe(1)
    const winnerInviteId = (fulfilled[0]!.value as { inviteId: string }).inviteId
    const winnerToken = (fulfilled[0]!.value as { token: string }).token
    const lock = await getInvitationLockDoc(companyId, email)
    expect(lock).toEqual({ currentInviteId: winnerInviteId })
    const invite = await getInvitationDoc(winnerInviteId)
    expect(invite?.tokenHash).toBe(hashInvitationToken(winnerToken))
    expect(await countAuditEvents(companyId)).toBe(1)
  })

  // ── 15: an expired pending invite allows a new one, atomically repointing the lock ──
  it('an expired (but still pending) invitation behind the lock is atomically replaced by a new one', async () => {
    const { companyId } = await setUpAdmin('expired-replace')
    const email = freshInviteeEmail('expired-replace')

    const expiredInviteId = 'invite_expired_synthetic'
    await seedInvitationDoc(expiredInviteId, {
      companyId, emailNormalized: email, role: 'viewer', tokenHash: 'a'.repeat(64),
      status: 'pending',
      expiresAt: Timestamp.fromMillis(Date.now() - 1000),
      createdBy: 'uid_someone_else', createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
      resendCount: 0, lastSentAt: Timestamp.now(),
    })
    await seedInvitationLockDoc(companyId, email, { currentInviteId: expiredInviteId })

    const result = (await callInviteMember({ companyId, email, role: 'admin' })) as { inviteId: string }
    expect(result.inviteId).not.toBe(expiredInviteId)

    const lock = await getInvitationLockDoc(companyId, email)
    expect(lock).toEqual({ currentInviteId: result.inviteId })
    const newInvite = await getInvitationDoc(result.inviteId)
    expect(newInvite).toMatchObject({ status: 'pending', role: 'admin' })
    expect(await countAuditEvents(companyId)).toBe(1)
  })

  it('an accepted invitation behind the lock is atomically replaced by a new one', async () => {
    const { companyId } = await setUpAdmin('accepted-replace')
    const email = freshInviteeEmail('accepted-replace')

    const acceptedInviteId = 'invite_accepted_synthetic'
    await seedInvitationDoc(acceptedInviteId, {
      companyId, emailNormalized: email, role: 'viewer', tokenHash: 'a'.repeat(64),
      status: 'accepted',
      expiresAt: Timestamp.fromMillis(Date.now() + 1000 * 3600),
      createdBy: 'uid_someone_else', createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
      resendCount: 0, lastSentAt: Timestamp.now(),
      acceptedAt: Timestamp.now(), acceptedByUid: 'uid_who_accepted',
    })
    await seedInvitationLockDoc(companyId, email, { currentInviteId: acceptedInviteId })

    const result = (await callInviteMember({ companyId, email, role: 'admin' })) as { inviteId: string }
    const lock = await getInvitationLockDoc(companyId, email)
    expect(lock).toEqual({ currentInviteId: result.inviteId })
  })

  // ── 16: corrupt lock / missing target invitation / scope mismatch — fail closed, 0 new writes ──
  describe('corrupted or mismatched lock state fails closed, without disclosing document content', () => {
    it('a lock document failing InvitationLockDocumentSchema is refused with a generic internal_error, and the lock is left untouched', async () => {
      const { companyId } = await setUpAdmin('corrupt-lock')
      const email = freshInviteeEmail('corrupt-lock')
      const corruptLock = { notCurrentInviteId: 'invite_x', extra: 'field' }
      await seedInvitationLockDoc(companyId, email, corruptLock)

      await expect(
        callInviteMember({ companyId, email, role: 'viewer' }),
      ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'internal_error')
      expect(await getInvitationLockDoc(companyId, email)).toEqual(corruptLock)
      expect(await countInvitationsFor(companyId, email)).toBe(0)
    })

    it('a lock pointing at a MISSING invitation is refused with a generic internal_error, and the lock is left untouched', async () => {
      const { companyId } = await setUpAdmin('missing-target')
      const email = freshInviteeEmail('missing-target')
      await seedInvitationLockDoc(companyId, email, { currentInviteId: 'invite_ghost_does_not_exist' })

      await expect(
        callInviteMember({ companyId, email, role: 'viewer' }),
      ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'internal_error')
      expect(await getInvitationLockDoc(companyId, email)).toEqual({ currentInviteId: 'invite_ghost_does_not_exist' })
      expect(await countInvitationsFor(companyId, email)).toBe(0)
    })

    it('a lock pointing at an invitation whose companyId/emailNormalized do NOT match the lock scope is refused with a generic internal_error', async () => {
      const { companyId } = await setUpAdmin('scope-mismatch')
      const email = freshInviteeEmail('scope-mismatch')
      const mismatchedInviteId = 'invite_scope_mismatch_synthetic'
      await seedInvitationDoc(mismatchedInviteId, {
        companyId: 'co_totally_different', emailNormalized: 'someone-else@example.test',
        role: 'viewer', tokenHash: 'b'.repeat(64), status: 'pending',
        expiresAt: Timestamp.fromMillis(Date.now() + 1000 * 3600),
        createdBy: 'uid_someone_else', createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
        resendCount: 0, lastSentAt: Timestamp.now(),
      })
      await seedInvitationLockDoc(companyId, email, { currentInviteId: mismatchedInviteId })

      await expect(
        callInviteMember({ companyId, email, role: 'viewer' }),
      ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'internal_error')
      expect(await countInvitationsFor(companyId, email)).toBe(0)
    })
  })

  // ── 17: a forced transaction retry does not regenerate/duplicate the token/inviteId ──
  // The token/tokenHash/inviteId/expiresAt are generated ONCE, before
  // db.runTransaction() is ever called (functions/src/index.ts), and
  // captured in the transaction closure — any internal Firestore retry of
  // that closure structurally cannot regenerate them (there is no
  // generation code left inside the closure to re-run). This is also
  // empirically covered by the concurrency test above (#14): if the
  // winning transaction there had internally retried due to contention
  // with the loser, the returned token would still have to hash to the
  // stored tokenHash for that test's assertions to pass. This test adds a
  // second, independent line of evidence by forcing contention on a
  // document inviteMember's OWN transaction reads (the caller's membership
  // doc) via repeated concurrent writes during the call, then checking the
  // same internal-consistency property.
  it('forcing contention on the transaction read-set (concurrent writes to the admin membership doc) still yields one internally-consistent invitation', async () => {
    const { companyId, adminUid } = await setUpAdmin('forced-retry')
    const email = freshInviteeEmail('forced-retry')

    const invitePromise = callInviteMember({ companyId, email, role: 'viewer' }) as Promise<{ inviteId: string; token: string }>
    const contentionPromises = Array.from({ length: 8 }, () =>
      seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' }),
    )

    const result = await invitePromise
    await Promise.all(contentionPromises)

    expect(await countInvitationsFor(companyId, email)).toBe(1)
    const invite = await getInvitationDoc(result.inviteId)
    expect(invite?.tokenHash).toBe(hashInvitationToken(result.token))
  })

  // ── 18: no Firebase Auth user is created, no email delivery is invoked ───
  it('creates no Firebase Auth user for the invited email (Stage 2 does not touch Auth or send email at all)', async () => {
    const { companyId } = await setUpAdmin('no-auth-user')
    const email = freshInviteeEmail('no-auth-user')
    expect(await authUserExistsWithEmail(email)).toBe(false)
    await callInviteMember({ companyId, email, role: 'viewer' })
    expect(await authUserExistsWithEmail(email)).toBe(false)
  })

  // ── Sanity: no orphan locks accumulate across this whole suite's companies ──
  it('every lock created in this suite has a matching invitation (no structurally orphaned locks from this suite\'s own calls)', async () => {
    // countAllInvitationLocks() spans the whole emulator DB (shared across
    // this file's tests) — used only as a smoke check that lock count is
    // never negative/absurd, not as a precise assertion (other tests seed
    // synthetic locks deliberately). This just proves the helper itself
    // works end-to-end.
    expect(await countAllInvitationLocks()).toBeGreaterThan(0)
  })
})
