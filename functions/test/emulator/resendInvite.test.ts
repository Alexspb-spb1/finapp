// Real callable pipeline proof for resendInvite — SEC-006 Stage 4.
//
// Every test calls the ACTUAL deployed `resendInvite` callable through the
// Functions Emulator (not a direct in-process function call), using real
// Auth Emulator-issued identities and real Firestore Emulator documents —
// no mocked Firestore for these checks (CLAUDE.md §8.6, task instructions).
import { describe, it, expect, afterEach } from 'vitest'
import { FunctionsError } from 'firebase/functions'
import { createHash } from 'node:crypto'
import { Timestamp } from 'firebase-admin/firestore'
import { INVITATION_RESEND_COOLDOWN_MS, INVITATION_RESEND_LIMIT } from '../../src/schemas/invitation'
import {
  createTestUser, signOutClient, signInAsExistingUser, seedCompany, seedMembership,
  callResendInvite, callCancelInvite, callInviteMember,
  seedInvitationDoc, getInvitationDoc, getInvitationLockDoc, seedInvitationLockDoc,
  getMembershipsSnapshot, getAuditEvents, countAuditEvents,
  authUserExistsWithEmail, setMaintenanceMode, clearMaintenanceMode,
} from './helpers'

/** Independently computes SHA-256(rawToken) using node:crypto directly —
 * deliberately NOT the production `hashInvitationToken` helper, so this
 * genuinely re-derives the hash rather than tautologically re-checking
 * production's own function against itself (independent review, Stage 4
 * round 1, finding #3). */
function independentSha256Hex(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

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
  return `co_resend_${label}_${Date.now()}_${companyCounter}`
}

let emailCounter = 0
function freshEmail(label: string): string {
  emailCounter += 1
  return `invitee-resend-${label}-${Date.now()}-${emailCounter}@example.test`
}

async function setUpAdmin(label: string): Promise<{ companyId: string; adminUid: string }> {
  const companyId = freshCompanyId(label)
  await seedCompany(companyId)
  const { uid: adminUid } = await createTestUser(true, `${label}-admin`)
  await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
  return { companyId, adminUid }
}

interface InvitationOverrides {
  role?: 'viewer' | 'accountant' | 'admin'
  resendCount?: number
  lastSentAt?: Timestamp | null
  expiresAt?: Timestamp
}

/** A pending invitation "safely resendable right now": createdAt far enough in the past that the createdAt-based cooldown (used when lastSentAt is null) has long since elapsed, resendCount 0, expiresAt comfortably in the future. */
function buildResendableInvitation(companyId: string, email: string, overrides: InvitationOverrides = {}) {
  const now = Timestamp.now()
  const createdAt = Timestamp.fromMillis(now.toMillis() - (INVITATION_RESEND_COOLDOWN_MS + 60_000))
  return {
    companyId,
    emailNormalized: email,
    role: overrides.role ?? 'viewer',
    tokenHash: '0'.repeat(64),
    status: 'pending' as const,
    expiresAt: overrides.expiresAt ?? Timestamp.fromMillis(now.toMillis() + 1000 * 3600 * 24 * 7),
    createdBy: 'uid_seed_synthetic',
    createdAt,
    updatedAt: createdAt,
    resendCount: overrides.resendCount ?? 0,
    lastSentAt: overrides.lastSentAt !== undefined ? overrides.lastSentAt : null,
  }
}

function buildCorruptedInvitation(companyId: string, email: string) {
  return {
    companyId,
    emailNormalized: email,
    role: 'not-a-real-role',
    status: 'pending',
    expiresAt: Timestamp.now(),
    createdBy: 'uid_seed_synthetic',
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    resendCount: 0,
    lastSentAt: null,
    // tokenHash deliberately omitted — fails InvitationDocumentSchema.
  }
}

interface ResendInviteResult {
  inviteId: string
  token: string
  expiresAtUtc: string
}

interface DenialSnapshot {
  invite: Record<string, unknown> | undefined
  lock: Record<string, unknown> | undefined
  memberships: Array<{ id: string; data: Record<string, unknown> }>
  auditCount: number
}

async function snapshotForDenial(companyId: string, inviteId: string, email?: string): Promise<DenialSnapshot> {
  return {
    invite: await getInvitationDoc(inviteId),
    lock: email !== undefined ? await getInvitationLockDoc(companyId, email) : undefined,
    memberships: await getMembershipsSnapshot(companyId),
    auditCount: await countAuditEvents(companyId),
  }
}

/** Calls resendInvite with `payload`, asserts it rejects with `expectedAppCode`, and asserts the invitation/lock/memberships/audit-count snapshot is BYTE-IDENTICAL before and after. */
async function expectDenial(
  payload: unknown,
  expectedAppCode: string,
  companyId: string,
  inviteId: string,
  email?: string,
): Promise<void> {
  const before = await snapshotForDenial(companyId, inviteId, email)
  await expect(callResendInvite(payload)).rejects.toSatisfy((err: unknown) => appCodeOf(err) === expectedAppCode)
  const after = await snapshotForDenial(companyId, inviteId, email)
  expect(after).toEqual(before)
}

describe('resendInvite — real callable pipeline through the Functions Emulator', () => {
  afterEach(async () => {
    await clearMaintenanceMode()
  })

  // ── 1: happy path — hash rotated, protected fields unchanged, response shape ──
  it('a verified admin rotates the token of a resendable pending invitation', async () => {
    const { companyId } = await setUpAdmin('happy')
    const email = freshEmail('happy')
    const inviteId = 'invite_happy_resend'
    const seeded = buildResendableInvitation(companyId, email)
    await seedInvitationDoc(inviteId, seeded)
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    const before = Date.now()
    const result = (await callResendInvite({ companyId, inviteId })) as ResendInviteResult
    const after = Date.now()

    expect(Object.keys(result).sort()).toEqual(['expiresAtUtc', 'inviteId', 'token'])
    expect(result.inviteId).toBe(inviteId)
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const invite = await getInvitationDoc(inviteId)
    expect(invite?.tokenHash).not.toBe(seeded.tokenHash) // old hash replaced
    // Independent review, Stage 4 round 1, finding #3: not just "differs
    // from the old hash" and "looks like a token" — the persisted hash must
    // be EXACTLY SHA-256(the token actually returned to the caller).
    expect(invite?.tokenHash).toBe(independentSha256Hex(result.token))
    expect(invite?.resendCount).toBe(1)
    expect((invite?.expiresAt as Timestamp).toDate().toISOString()).toBe(result.expiresAtUtc)
    const lastSentMillis = (invite?.lastSentAt as Timestamp).toMillis()
    expect(lastSentMillis).toBeGreaterThanOrEqual(before)
    expect(lastSentMillis).toBeLessThanOrEqual(after)
    expect(invite?.updatedAt).toEqual(invite?.lastSentAt)

    // Protected fields: completely unchanged.
    expect(invite?.companyId).toBe(companyId)
    expect(invite?.emailNormalized).toBe(email)
    expect(invite?.role).toBe('viewer')
    expect(invite?.status).toBe('pending')
    expect((invite?.createdAt as Timestamp).isEqual(seeded.createdAt)).toBe(true)
    expect(invite?.createdBy).toBe('uid_seed_synthetic')

    // The lock is untouched.
    expect(await getInvitationLockDoc(companyId, email)).toEqual({ currentInviteId: inviteId })
  })

  // ── 2: response never leaks tokenHash/email/role ─────────────────────────
  it('the response never contains tokenHash, email, or role', async () => {
    const { companyId } = await setUpAdmin('response-shape')
    const email = freshEmail('response-shape')
    const inviteId = 'invite_response_shape'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    const result = (await callResendInvite({ companyId, inviteId })) as ResendInviteResult
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('0'.repeat(64))
    expect(serialized).not.toContain(email)
    expect(serialized).not.toContain('viewer')
  })

  // ── 3: cooldown boundary ───────────────────────────────────────────────────
  // Real wall-clock time elapses between seeding a fixture here and the
  // callable's own server-side "now" being captured (Functions Emulator
  // round trip, auth checks, etc.) — a margin of just 1ms either side of
  // the exact boundary would be flaky (observed in practice: a
  // "1ms-too-soon" fixture became "just past the boundary, allowed" by
  // the time the callable actually ran). Both directions use a multi-
  // second margin instead, comfortably clear of realistic test latency,
  // while still unambiguously testing "well inside the cooldown" vs.
  // "well past it" (the task's own boundary condition — elapsed >=
  // cooldown is allowed, < cooldown is refused — is exercised precisely
  // by the unit-level fake-transaction tests in
  // resendInviteTransaction.test.ts, which have no such latency at all).
  it('rejects with invitation_resend_cooldown well inside the 60s window, and allows it once well past the window', async () => {
    const { companyId } = await setUpAdmin('cooldown-boundary')

    const tooSoonEmail = freshEmail('cooldown-too-soon')
    const tooSoonInviteId = 'invite_cooldown_too_soon'
    const now1 = Timestamp.now()
    await seedInvitationDoc(tooSoonInviteId, buildResendableInvitation(companyId, tooSoonEmail, {
      lastSentAt: Timestamp.fromMillis(now1.toMillis() - (INVITATION_RESEND_COOLDOWN_MS - 5_000)), // 55s ago
    }))
    await seedInvitationLockDoc(companyId, tooSoonEmail, { currentInviteId: tooSoonInviteId })
    await expectDenial({ companyId, inviteId: tooSoonInviteId }, 'invitation_resend_cooldown', companyId, tooSoonInviteId, tooSoonEmail)

    const exactlyEmail = freshEmail('cooldown-exact')
    const exactlyInviteId = 'invite_cooldown_exact'
    const now2 = Timestamp.now()
    await seedInvitationDoc(exactlyInviteId, buildResendableInvitation(companyId, exactlyEmail, {
      lastSentAt: Timestamp.fromMillis(now2.toMillis() - (INVITATION_RESEND_COOLDOWN_MS + 5_000)), // 65s ago
    }))
    await seedInvitationLockDoc(companyId, exactlyEmail, { currentInviteId: exactlyInviteId })
    await expect(callResendInvite({ companyId, inviteId: exactlyInviteId })).resolves.toBeTruthy()
  })

  // ── 4: null lastSentAt uses createdAt as the cooldown baseline ───────────
  it('uses createdAt as the cooldown baseline when lastSentAt is null (first-ever resend)', async () => {
    const { companyId } = await setUpAdmin('null-last-sent')

    const tooSoonEmail = freshEmail('null-last-sent-too-soon')
    const tooSoonInviteId = 'invite_null_last_sent_too_soon'
    const now1 = Timestamp.now()
    await seedInvitationDoc(tooSoonInviteId, {
      ...buildResendableInvitation(companyId, tooSoonEmail),
      createdAt: Timestamp.fromMillis(now1.toMillis() - (INVITATION_RESEND_COOLDOWN_MS - 5_000)), // 55s ago
      lastSentAt: null,
    })
    await seedInvitationLockDoc(companyId, tooSoonEmail, { currentInviteId: tooSoonInviteId })
    await expectDenial({ companyId, inviteId: tooSoonInviteId }, 'invitation_resend_cooldown', companyId, tooSoonInviteId, tooSoonEmail)

    const okEmail = freshEmail('null-last-sent-ok')
    const okInviteId = 'invite_null_last_sent_ok'
    const now2 = Timestamp.now()
    await seedInvitationDoc(okInviteId, {
      ...buildResendableInvitation(companyId, okEmail),
      createdAt: Timestamp.fromMillis(now2.toMillis() - (INVITATION_RESEND_COOLDOWN_MS + 5_000)), // 65s ago
      lastSentAt: null,
    })
    await seedInvitationLockDoc(companyId, okEmail, { currentInviteId: okInviteId })
    await expect(callResendInvite({ companyId, inviteId: okInviteId })).resolves.toBeTruthy()
  })

  // ── 5: exact resend-limit boundary ────────────────────────────────────────
  it('allows a resend at resendCount 4 (becoming 5), and rejects with invitation_resend_limit_reached at resendCount 5', async () => {
    const { companyId } = await setUpAdmin('limit-boundary')

    const okEmail = freshEmail('limit-ok')
    const okInviteId = 'invite_limit_ok'
    await seedInvitationDoc(okInviteId, buildResendableInvitation(companyId, okEmail, { resendCount: INVITATION_RESEND_LIMIT - 1 }))
    await seedInvitationLockDoc(companyId, okEmail, { currentInviteId: okInviteId })
    await callResendInvite({ companyId, inviteId: okInviteId })
    expect((await getInvitationDoc(okInviteId))?.resendCount).toBe(INVITATION_RESEND_LIMIT)

    const blockedEmail = freshEmail('limit-blocked')
    const blockedInviteId = 'invite_limit_blocked'
    await seedInvitationDoc(blockedInviteId, buildResendableInvitation(companyId, blockedEmail, { resendCount: INVITATION_RESEND_LIMIT }))
    await seedInvitationLockDoc(companyId, blockedEmail, { currentInviteId: blockedInviteId })
    await expectDenial({ companyId, inviteId: blockedInviteId }, 'invitation_resend_limit_reached', companyId, blockedInviteId, blockedEmail)
  })

  // ── 6: authorization denials ──────────────────────────────────────────────
  it('an unauthenticated call is rejected with auth_required, and changes nothing', async () => {
    const { companyId } = await setUpAdmin('unauth')
    const email = freshEmail('unauth')
    const inviteId = 'invite_unauth'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })
    await signOutClient()

    await expectDenial({ companyId, inviteId }, 'auth_required', companyId, inviteId, email)
  })

  it('an unverified admin is denied with email_unverified, and changes nothing', async () => {
    const companyId = freshCompanyId('unverified')
    await seedCompany(companyId)
    const { uid } = await createTestUser(false, 'unverified-admin')
    await seedMembership({ companyId, uid, role: 'admin', status: 'active' })
    const email = freshEmail('unverified')
    const inviteId = 'invite_unverified'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    await expectDenial({ companyId, inviteId }, 'email_unverified', companyId, inviteId, email)
  })

  it.each(['viewer', 'accountant'] as const)('a %s (not admin) is denied with insufficient_role, and changes nothing', async role => {
    const companyId = freshCompanyId(`role-${role}`)
    await seedCompany(companyId)
    const { uid } = await createTestUser(true, `role-${role}`)
    await seedMembership({ companyId, uid, role, status: 'active' })
    const email = freshEmail(`role-${role}`)
    const inviteId = `invite_role_${role}`
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    await expectDenial({ companyId, inviteId }, 'insufficient_role', companyId, inviteId, email)
  })

  // ── 7: missing / cross-company — oracle-safe ─────────────────────────────
  it('an admin using their OWN companyId but an inviteId belonging to a DIFFERENT company gets invitation_not_found, and changes nothing', async () => {
    const { companyId: companyA } = await setUpAdmin('cross-a')
    const { companyId: companyB, adminUid: adminB } = await setUpAdmin('cross-b')
    const email = freshEmail('cross')
    const inviteId = 'invite_cross_company'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyA, email))
    await seedInvitationLockDoc(companyA, email, { currentInviteId: inviteId })

    await signInAsExistingUser(adminB)
    await expectDenial({ companyId: companyB, inviteId }, 'invitation_not_found', companyA, inviteId, email)
  })

  it('a missing inviteId gives the SAME invitation_not_found as a cross-company one (no existence oracle)', async () => {
    const { companyId } = await setUpAdmin('missing-invite')
    await expectDenial({ companyId, inviteId: 'invite_does_not_exist_at_all' }, 'invitation_not_found', companyId, 'invite_does_not_exist_at_all')
  })

  it('a corrupted invitation belonging to a DIFFERENT company gives the SAME invitation_not_found as a missing one, never internal_error', async () => {
    const { companyId: companyA } = await setUpAdmin('oracle-corrupted-a')
    const { companyId: companyB, adminUid: adminB } = await setUpAdmin('oracle-corrupted-b')
    const corruptedInviteId = 'invite_oracle_corrupted_foreign'
    const corruptedFixture = buildCorruptedInvitation(companyA, freshEmail('oracle-corrupted'))
    await seedInvitationDoc(corruptedInviteId, corruptedFixture)
    const missingInviteId = 'invite_oracle_truly_missing'

    await signInAsExistingUser(adminB)
    const [corruptedResult, missingResult] = await Promise.allSettled([
      callResendInvite({ companyId: companyB, inviteId: corruptedInviteId }),
      callResendInvite({ companyId: companyB, inviteId: missingInviteId }),
    ])
    expect(appCodeOf((corruptedResult as PromiseRejectedResult).reason)).toBe('invitation_not_found')
    expect(appCodeOf((missingResult as PromiseRejectedResult).reason)).toBe('invitation_not_found')
    expect(await getInvitationDoc(corruptedInviteId)).toEqual(corruptedFixture)
  })

  it('a corrupted invitation document belonging to the caller\'s OWN company causes a safe internal_error, nothing changes', async () => {
    const { companyId } = await setUpAdmin('corrupted')
    const inviteId = 'invite_corrupted'
    await seedInvitationDoc(inviteId, buildCorruptedInvitation(companyId, freshEmail('corrupted')))

    await expectDenial({ companyId, inviteId }, 'internal_error', companyId, inviteId)
  })

  // ── 8: maintenance mode ───────────────────────────────────────────────────
  it('refuses with maintenance_mode when system/maintenance.enabled is true, and changes nothing', async () => {
    const { companyId } = await setUpAdmin('maintenance')
    const email = freshEmail('maintenance')
    const inviteId = 'invite_maintenance'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })
    await setMaintenanceMode(true)

    await expectDenial({ companyId, inviteId }, 'maintenance_mode', companyId, inviteId, email)
  })

  // ── 9: accepted / revoked ─────────────────────────────────────────────────
  it('an ACCEPTED invitation cannot be resent — invitation_not_pending, nothing changes', async () => {
    const { companyId } = await setUpAdmin('already-accepted')
    const email = freshEmail('already-accepted')
    const inviteId = 'invite_already_accepted'
    const now = Timestamp.now()
    await seedInvitationDoc(inviteId, {
      ...buildResendableInvitation(companyId, email),
      status: 'accepted',
      acceptedAt: now,
      acceptedByUid: 'uid_who_accepted_synthetic',
    })
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    await expectDenial({ companyId, inviteId }, 'invitation_not_pending', companyId, inviteId, email)
  })

  it('a REVOKED invitation cannot be resent — invitation_not_pending, nothing changes', async () => {
    const { companyId } = await setUpAdmin('already-revoked')
    const email = freshEmail('already-revoked')
    const inviteId = 'invite_already_revoked'
    const now = Timestamp.now()
    await seedInvitationDoc(inviteId, {
      ...buildResendableInvitation(companyId, email),
      status: 'revoked',
      revokedAt: now,
      revokedBy: 'uid_other_admin_synthetic',
    })
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    await expectDenial({ companyId, inviteId }, 'invitation_not_pending', companyId, inviteId, email)
  })

  // ── 10: expired-but-still-active is resendable; already-replaced is NOT ──
  it('an EXPIRED but still pending-and-lock-active invitation can be resent (extends validity)', async () => {
    const { companyId } = await setUpAdmin('expired-active')
    const email = freshEmail('expired-active')
    const inviteId = 'invite_expired_active'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email, {
      expiresAt: Timestamp.fromMillis(Date.now() - 1000), // already expired
    }))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId }) // lock STILL points here

    const result = (await callResendInvite({ companyId, inviteId })) as ResendInviteResult
    const invite = await getInvitationDoc(inviteId)
    expect(invite?.status).toBe('pending')
    expect((invite?.expiresAt as Timestamp).toMillis()).toBeGreaterThan(Date.now()) // revived
    expect(result.inviteId).toBe(inviteId)
  })

  it('an invitation already SUPERSEDED by inviteMember\'s expired-replace (lock points elsewhere) cannot be resurrected by resend', async () => {
    const { companyId } = await setUpAdmin('already-superseded')
    const email = freshEmail('already-superseded')
    const oldInviteId = 'invite_already_superseded_old'
    // Still status: 'pending' in Firestore (inviteMember never touches the
    // old document when it replaces it) — this is EXACTLY the scenario
    // Stage 4's lock check exists for.
    const seeded = buildResendableInvitation(companyId, email, {
      expiresAt: Timestamp.fromMillis(Date.now() - 1000),
    })
    await seedInvitationDoc(oldInviteId, seeded)
    // The lock now points at a DIFFERENT (newer) invite — as if
    // inviteMember had already replaced the old one.
    await seedInvitationLockDoc(companyId, email, { currentInviteId: 'invite_the_new_active_one' })

    // Independent review, Stage 4 round 1, finding #4: full before/after
    // snapshot (invitation + the mismatched lock itself + memberships +
    // audit count), not just the target invitation's own fields.
    await expectDenial({ companyId, inviteId: oldInviteId }, 'internal_error', companyId, oldInviteId, email)
    // The old (superseded) invitation is left BYTE-IDENTICAL to what was
    // seeded — not just "still pending", the entire document is unchanged.
    expect(await getInvitationDoc(oldInviteId)).toEqual(seeded)
  })

  it('a missing lock document fails closed with the exact internal_error code and zero writes anywhere (independent review, Stage 4 round 1, finding #4)', async () => {
    const { companyId } = await setUpAdmin('missing-lock')
    const email = freshEmail('missing-lock')
    const inviteId = 'invite_missing_lock'
    const seeded = buildResendableInvitation(companyId, email)
    await seedInvitationDoc(inviteId, seeded)
    // No lock seeded at all.

    await expectDenial({ companyId, inviteId }, 'internal_error', companyId, inviteId, email)
    expect(await getInvitationDoc(inviteId)).toEqual(seeded)
  })

  it('a corrupted lock document (wrong field name) fails closed with the exact internal_error code and zero writes anywhere (independent review, Stage 4 round 1, finding #4)', async () => {
    const { companyId } = await setUpAdmin('corrupted-lock')
    const email = freshEmail('corrupted-lock')
    const inviteId = 'invite_corrupted_lock'
    const seeded = buildResendableInvitation(companyId, email)
    await seedInvitationDoc(inviteId, seeded)
    await seedInvitationLockDoc(companyId, email, { notCurrentInviteId: 'wrong-field-name' })

    await expectDenial({ companyId, inviteId }, 'internal_error', companyId, inviteId, email)
    expect(await getInvitationDoc(inviteId)).toEqual(seeded)
  })

  // ── contradictory chronology on the invitation itself ────────────────────
  // Independent review, Stage 4 round 1, finding #1 (a real defect): the
  // naive `lastSentAt ?? createdAt` baseline let a document with
  // `lastSentAt` earlier than `createdAt` slip through, because elapsed
  // time measured from `lastSentAt` alone can satisfy the cooldown even
  // though that chronology is impossible for a legitimately-written
  // document. Both fixtures below are exactly the ones the independent
  // review used to reproduce the defect.
  it('rejects with internal_error (not a successful rotation) when lastSentAt is earlier than createdAt', async () => {
    const { companyId } = await setUpAdmin('bad-chronology-lastsent')
    const email = freshEmail('bad-chronology-lastsent')
    const inviteId = 'invite_bad_chronology_lastsent'
    const now = Timestamp.now()
    // createdAt 30s ago, but lastSentAt claims a resend 120s ago — before
    // the invitation even existed.
    const corrupted = {
      ...buildResendableInvitation(companyId, email),
      createdAt: Timestamp.fromMillis(now.toMillis() - 30_000),
      lastSentAt: Timestamp.fromMillis(now.toMillis() - 120_000),
    }
    await seedInvitationDoc(inviteId, corrupted)
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    await expectDenial({ companyId, inviteId }, 'internal_error', companyId, inviteId, email)
    expect(await getInvitationDoc(inviteId)).toEqual(corrupted)
  })

  it('rejects with internal_error (not a successful rotation) when createdAt is in the future relative to lastSentAt', async () => {
    const { companyId } = await setUpAdmin('bad-chronology-created')
    const email = freshEmail('bad-chronology-created')
    const inviteId = 'invite_bad_chronology_created'
    const now = Timestamp.now()
    const corrupted = {
      ...buildResendableInvitation(companyId, email),
      createdAt: Timestamp.fromMillis(now.toMillis() + 1000 * 3600),
      lastSentAt: Timestamp.fromMillis(now.toMillis() - 120_000),
    }
    await seedInvitationDoc(inviteId, corrupted)
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    await expectDenial({ companyId, inviteId }, 'internal_error', companyId, inviteId, email)
    expect(await getInvitationDoc(inviteId)).toEqual(corrupted)
  })

  // ── 11: forged payload / forbidden document IDs ──────────────────────────
  it('extra payload fields (forged tokenHash/status/email/role/timestamps/uid) are rejected as invalid_request before any write', async () => {
    const { companyId } = await setUpAdmin('forged-payload')
    const email = freshEmail('forged-payload')
    const inviteId = 'invite_forged_payload'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    for (const forged of [
      { uid: 'uid_attacker' },
      { status: 'accepted' },
      { email: 'attacker@example.test' },
      { role: 'admin' },
      { tokenHash: 'a'.repeat(64) },
      { lastSentAt: new Date().toISOString() },
    ]) {
      await expectDenial({ companyId, inviteId, ...forged }, 'invalid_request', companyId, inviteId, email)
    }
  })

  describe('companyId/inviteId reject values that are not valid Firestore document IDs', () => {
    it.each(['company/with-slash', '.', '..', '__reserved__'])('rejects companyId %j with invalid_request', async companyId => {
      await setUpAdmin('forbidden-company-id')
      await expect(callResendInvite({ companyId, inviteId: 'invite_synthetic' }))
        .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
    })

    it.each(['invite/with-slash', '.', '..', '__reserved__'])('rejects inviteId %j with invalid_request', async inviteId => {
      const { companyId } = await setUpAdmin('forbidden-invite-id')
      await expect(callResendInvite({ companyId, inviteId }))
        .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
    })
  })

  // ── 12: audit event ────────────────────────────────────────────────────────
  it('creates exactly one audit event with the exact safe field set, action resent, and no email/role/token/tokenHash', async () => {
    const { companyId } = await setUpAdmin('audit')
    const email = freshEmail('audit')
    const inviteId = 'invite_audit'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    const result = (await callResendInvite({ companyId, inviteId })) as ResendInviteResult

    const auditEvents = await getAuditEvents(companyId)
    expect(auditEvents).toHaveLength(1)
    const auditEvent = auditEvents[0]!
    expect(Object.keys(auditEvent).sort()).toEqual(['action', 'actorUid', 'createdAt', 'targetUid'])
    expect(auditEvent.action).toBe('invitation_resent')
    expect(auditEvent.targetUid).toBeNull()
    const serializedAudit = JSON.stringify(auditEvent)
    expect(serializedAudit).not.toContain(email)
    expect(serializedAudit).not.toContain('viewer')
    expect(serializedAudit).not.toContain(result.token)
  })

  // ── 13: no unrelated writes on success ────────────────────────────────────
  it('a successful resend leaves the lock, other invitations, and memberships completely unchanged besides the target invitation and its one audit event', async () => {
    const { companyId } = await setUpAdmin('no-side-effects')
    const email = freshEmail('no-side-effects')
    const inviteId = 'invite_no_side_effects'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })
    const lockBefore = await getInvitationLockDoc(companyId, email)

    const otherInviteId = 'invite_unrelated_untouched'
    const otherEmail = freshEmail('unrelated')
    const otherSeeded = buildResendableInvitation(companyId, otherEmail)
    await seedInvitationDoc(otherInviteId, otherSeeded)
    const membershipsBefore = await getMembershipsSnapshot(companyId)

    await callResendInvite({ companyId, inviteId })

    expect(await getInvitationLockDoc(companyId, email)).toEqual(lockBefore)
    // Independent review, Stage 4 round 1, finding #4: compare the ENTIRE
    // sibling document, not just resendCount — a bug that mutated some
    // other field (e.g. tokenHash, status) would not have been caught by a
    // single-field check.
    expect(await getInvitationDoc(otherInviteId)).toEqual(otherSeeded)
    expect(await getMembershipsSnapshot(companyId)).toEqual(membershipsBefore)
    expect(await countAuditEvents(companyId)).toBe(1)
  })

  // ── 14: no Firebase Auth user is created ─────────────────────────────────
  it('creates no Firebase Auth user', async () => {
    const { companyId } = await setUpAdmin('no-auth-user')
    const email = freshEmail('no-auth-user')
    const inviteId = 'invite_no_auth_user'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    expect(await authUserExistsWithEmail(email)).toBe(false)
    await callResendInvite({ companyId, inviteId })
    expect(await authUserExistsWithEmail(email)).toBe(false)
  })

  // ── 15: genuine concurrency — one rotation, one cooldown rejection ───────
  it.each([1, 2])('concurrent resend pair #%i on the SAME invite: exactly one rotation, one resendCount increment, one audit event', async run => {
    const { companyId } = await setUpAdmin(`concurrent-${run}`)
    const email = freshEmail(`concurrent-${run}`)
    const inviteId = `invite_concurrent_${run}`
    const seeded = buildResendableInvitation(companyId, email)
    await seedInvitationDoc(inviteId, seeded)
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    const [a, b] = await Promise.allSettled([
      callResendInvite({ companyId, inviteId }),
      callResendInvite({ companyId, inviteId }),
    ])
    const fulfilled = [a, b].filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
    const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    // The loser raced against an invitation whose lastSentAt had just been
    // set by the winner (within the same logical "now"), so it always
    // fails on cooldown, never limit/lock/etc.
    expect(appCodeOf(rejected[0]!.reason)).toBe('invitation_resend_cooldown')

    const invite = await getInvitationDoc(inviteId)
    expect(invite?.resendCount).toBe(1) // incremented exactly once, not twice
    expect(invite?.tokenHash).not.toBe(seeded.tokenHash) // rotated exactly once
    // Independent review, Stage 4 round 1, finding #3: the persisted hash
    // matches SHA-256 of the WINNER's own returned token specifically.
    const winnerToken = (fulfilled[0]!.value as ResendInviteResult).token
    expect(invite?.tokenHash).toBe(independentSha256Hex(winnerToken))
    expect(await countAuditEvents(companyId)).toBe(1)
  })

  // ── 16: race with cancelInvite ────────────────────────────────────────────
  it('a genuine race between resendInvite and cancelInvite on the same pending invite: cancelInvite always wins eventually, resendInvite may or may not have also succeeded first', async () => {
    const { companyId } = await setUpAdmin('race-cancel')
    const email = freshEmail('race-cancel')
    const inviteId = 'invite_race_cancel'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    const [resendResult, cancelResult] = await Promise.allSettled([
      callResendInvite({ companyId, inviteId }),
      callCancelInvite({ companyId, inviteId }),
    ])

    // Unlike resendInvite-vs-inviteMember (below), this pairing is NOT
    // mutually exclusive: cancelInvite's only precondition is
    // `status === 'pending'`, and nothing a concurrent resendInvite does
    // ever changes `status` — a resend never blocks a cancel, whether it
    // runs before, during, or after. So cancelInvite always succeeds here
    // (assuming no third actor), and the final status is always
    // `revoked`. resendInvite is the only side whose outcome depends on
    // ordering: it succeeds if its own transaction reads/commits before
    // cancelInvite's, and fails with `invitation_not_pending` if it
    // observes (immediately, or after a Firestore-forced retry) the
    // already-revoked status.
    expect(cancelResult.status).toBe('fulfilled')
    const invite = await getInvitationDoc(inviteId)
    expect(invite?.status).toBe('revoked')

    if (resendResult.status === 'fulfilled') {
      // Both operations succeeded, sequentially (resend committed first,
      // leaving the invite pending-with-a-rotated-token for a moment,
      // then cancel revoked it) — two independent audit events.
      expect(await countAuditEvents(companyId)).toBe(2)
    } else {
      expect(appCodeOf((resendResult as PromiseRejectedResult).reason)).toBe('invitation_not_pending')
      expect(await countAuditEvents(companyId)).toBe(1)
    }
  })

  // ── 17: race with inviteMember's expired-replace ─────────────────────────
  it('a genuine race between resendInvite (on an expired invite) and a real inviteMember replacing it: exactly one wins, final state is consistent', async () => {
    const { companyId } = await setUpAdmin('race-replace')
    const email = freshEmail('race-replace')
    const oldInviteId = 'invite_race_replace_old'
    await seedInvitationDoc(oldInviteId, buildResendableInvitation(companyId, email, {
      expiresAt: Timestamp.fromMillis(Date.now() - 1000), // expired
    }))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: oldInviteId })

    const [resendResult, inviteResult] = await Promise.allSettled([
      callResendInvite({ companyId, inviteId: oldInviteId }),
      callInviteMember({ companyId, email, role: 'accountant' }),
    ])

    const lock = await getInvitationLockDoc(companyId, email)
    if (resendResult.status === 'fulfilled') {
      // resendInvite won: it extended the old invite's validity, so
      // inviteMember (reading a now-pending-and-non-expired invite behind
      // the lock) must have lost with invitation_already_pending, and the
      // lock must still point at the OLD invite.
      expect(lock).toEqual({ currentInviteId: oldInviteId })
      expect(appCodeOf((inviteResult as PromiseRejectedResult).reason)).toBe('invitation_already_pending')
      const oldInvite = await getInvitationDoc(oldInviteId)
      expect(oldInvite?.status).toBe('pending')
      expect((oldInvite?.expiresAt as Timestamp).toMillis()).toBeGreaterThan(Date.now())
    } else {
      // inviteMember won: it created a brand new invite and repointed the
      // lock at it BEFORE resendInvite's transaction could commit — on
      // retry, resendInvite re-reads the lock, finds it no longer points
      // at the old inviteId, and fails closed.
      expect(appCodeOf((resendResult as PromiseRejectedResult).reason)).toBe('internal_error')
      expect(inviteResult.status).toBe('fulfilled')
      const newInviteId = (inviteResult as PromiseFulfilledResult<{ inviteId: string }>).value.inviteId
      expect(lock).toEqual({ currentInviteId: newInviteId })
      const oldInvite = await getInvitationDoc(oldInviteId)
      expect(oldInvite?.status).toBe('pending') // left as-is, not resurrected
      expect(oldInvite?.resendCount).toBe(0) // never actually rotated
    }
  })

  // ── 18: forced transaction retry stays internally consistent ────────────
  // The AUTHORITATIVE proof that a retry cannot recompute the
  // token/hash/expiresAt/now is
  // functions/test/unit/resendInviteTransaction.test.ts (an injected
  // transaction runner invoking the update function twice against fake
  // Transactions, with generator/hasher call-count assertions). This
  // emulator test is a supplementary, best-effort empirical check: it
  // forces real contention on resendInvite's OWN transaction read-set
  // (the caller's membership doc) via repeated concurrent writes during a
  // real call.
  it('forcing contention on the transaction read-set (concurrent writes to the admin membership doc) still yields one internally-consistent rotation', async () => {
    const { companyId, adminUid } = await setUpAdmin('forced-retry')
    const email = freshEmail('forced-retry')
    const inviteId = 'invite_forced_retry'
    await seedInvitationDoc(inviteId, buildResendableInvitation(companyId, email))
    await seedInvitationLockDoc(companyId, email, { currentInviteId: inviteId })

    const resendPromise = callResendInvite({ companyId, inviteId }) as Promise<ResendInviteResult>
    const contentionPromises = Array.from({ length: 8 }, () =>
      seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' }),
    )

    const result = await resendPromise
    await Promise.all(contentionPromises)

    const invite = await getInvitationDoc(inviteId)
    expect(invite?.resendCount).toBe(1)
    expect((invite?.expiresAt as Timestamp).toDate().toISOString()).toBe(result.expiresAtUtc)
    expect(await countAuditEvents(companyId)).toBe(1)
  })
})
