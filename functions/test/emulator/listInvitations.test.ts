// Real callable pipeline proof for listInvitations — SEC-006 Stage 2b.
//
// Every test calls the ACTUAL deployed `listInvitations` callable through
// the Functions Emulator (not a direct in-process function call), using
// real Auth Emulator-issued identities and real Firestore Emulator
// documents — no mocked Firestore for these checks (CLAUDE.md §8.6, task
// instructions).
import { describe, it, expect } from 'vitest'
import { FunctionsError } from 'firebase/functions'
import { Timestamp } from 'firebase-admin/firestore'
import { encodeInvitationsCursor } from '../../src/lib/invitationListing'
import { INVITATIONS_CURSOR_VERSION } from '../../src/schemas/invitation'
import {
  createTestUser, signOutClient, signInAsExistingUser, seedCompany, seedMembership,
  callListInvitations, seedInvitationDoc, seedInvitationLockDoc, getInvitationLockDoc,
  getInvitationsSnapshotForCompany, getMembershipsSnapshot, getAuditEvents,
  authUserExistsWithEmail,
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
  return `co_list_${label}_${Date.now()}_${companyCounter}`
}

let emailCounter = 0
function freshEmail(label: string): string {
  emailCounter += 1
  return `invitee-list-${label}-${Date.now()}-${emailCounter}@example.test`
}

async function setUpAdmin(label: string): Promise<{ companyId: string; adminUid: string }> {
  const companyId = freshCompanyId(label)
  await seedCompany(companyId)
  const { uid: adminUid } = await createTestUser(true, `${label}-admin`)
  await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
  return { companyId, adminUid }
}

interface RawInvitationOverrides {
  status?: 'pending' | 'accepted' | 'revoked'
  role?: 'viewer' | 'accountant' | 'admin'
}

function buildRawPendingInvitation(companyId: string, email: string, createdAt: Timestamp, overrides: RawInvitationOverrides = {}) {
  const base = {
    companyId,
    emailNormalized: email,
    role: overrides.role ?? 'viewer',
    tokenHash: '0'.repeat(64),
    expiresAt: Timestamp.fromMillis(createdAt.toMillis() + 1000 * 3600 * 24 * 7),
    createdBy: 'uid_seed_synthetic',
    createdAt,
    updatedAt: createdAt,
    resendCount: 0,
    lastSentAt: createdAt,
  }
  if (overrides.status === 'accepted') {
    return { ...base, status: 'accepted' as const, acceptedAt: createdAt, acceptedByUid: 'uid_who_accepted_synthetic' }
  }
  if (overrides.status === 'revoked') {
    return { ...base, status: 'revoked' as const, revokedAt: createdAt, revokedBy: 'uid_who_revoked_synthetic' }
  }
  return { ...base, status: 'pending' as const }
}

interface ListInvitationsResult {
  items: Array<{
    inviteId: string; emailNormalized: string; role: string; status: string
    createdAtUtc: string; expiresAtUtc: string; resendCount: number
    lastSentAtUtc: string | null; createdBy: string
  }>
  nextCursor: string | null
}

describe('listInvitations — real callable pipeline through the Functions Emulator', () => {
  // ── 1: verified admin gets only their own company's invitations ─────────
  it('a verified admin gets only invitations belonging to their own company', async () => {
    const { companyId, adminUid } = await setUpAdmin('own-company')
    const email = freshEmail('own-company')
    const t0 = Timestamp.now()
    await seedInvitationDoc('invite_own_company_1', buildRawPendingInvitation(companyId, email, t0))

    const { companyId: otherCompanyId } = await setUpAdmin('own-company-other')
    await seedInvitationDoc('invite_other_company_1', buildRawPendingInvitation(otherCompanyId, freshEmail('own-company-other'), t0))

    await signInAsExistingUser(adminUid)
    const result = (await callListInvitations({ companyId })) as ListInvitationsResult
    expect(result.items.map(i => i.inviteId)).toEqual(['invite_own_company_1'])
  })

  // ── 2-3: full item shape matches the contract; tokenHash/raw token absent ──
  it('the full item shape matches the contract exactly, with tokenHash and any raw token absent from the serialized response', async () => {
    const { companyId } = await setUpAdmin('item-shape')
    const email = freshEmail('item-shape')
    const t0 = Timestamp.now()
    const rawDoc = buildRawPendingInvitation(companyId, email, t0, { role: 'accountant' })
    await seedInvitationDoc('invite_item_shape', rawDoc)

    const result = (await callListInvitations({ companyId })) as ListInvitationsResult
    expect(result.items).toHaveLength(1)
    const item = result.items[0]!
    expect(Object.keys(item).sort()).toEqual([
      'createdAtUtc', 'createdBy', 'emailNormalized', 'expiresAtUtc',
      'inviteId', 'lastSentAtUtc', 'resendCount', 'role', 'status',
    ])
    expect(item).toMatchObject({
      inviteId: 'invite_item_shape',
      emailNormalized: email,
      role: 'accountant',
      status: 'pending',
      resendCount: 0,
      createdBy: 'uid_seed_synthetic',
    })
    expect(item.createdAtUtc).toBe(t0.toDate().toISOString())
    expect(Object.keys(result).sort()).toEqual(['items', 'nextCursor'])

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(rawDoc.tokenHash)
    expect(serialized).not.toContain('tokenHash')
    expect(serialized).not.toContain('lockId')
  })

  // ── 4: unauthenticated — auth_required ───────────────────────────────────
  it('an unauthenticated call is rejected with auth_required', async () => {
    const { companyId } = await setUpAdmin('unauth')
    await signOutClient()
    await expect(callListInvitations({ companyId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'auth_required')
  })

  // ── 5: unverified — email_unverified ─────────────────────────────────────
  it('an unverified admin is denied with email_unverified', async () => {
    const companyId = freshCompanyId('unverified')
    await seedCompany(companyId)
    const { uid } = await createTestUser(false, 'unverified-admin')
    await seedMembership({ companyId, uid, role: 'admin', status: 'active' })
    await expect(callListInvitations({ companyId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'email_unverified')
  })

  // ── 6: viewer/accountant — insufficient_role ─────────────────────────────
  it.each(['viewer', 'accountant'] as const)('a %s (not admin) is denied with insufficient_role', async role => {
    const companyId = freshCompanyId(`role-${role}`)
    await seedCompany(companyId)
    const { uid } = await createTestUser(true, `role-${role}`)
    await seedMembership({ companyId, uid, role, status: 'active' })
    await expect(callListInvitations({ companyId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'insufficient_role')
  })

  // ── 7: admin of a DIFFERENT company — denied, no cross-company read ──────
  it('an admin of a DIFFERENT company is denied with membership_not_found and never reads/returns that company\'s invitations', async () => {
    const { companyId: companyA } = await setUpAdmin('cross-a')
    await seedInvitationDoc('invite_cross_a_1', buildRawPendingInvitation(companyA, freshEmail('cross-a'), Timestamp.now()))
    await setUpAdmin('cross-b') // adminB stays signed in — no membership in companyA
    await expect(callListInvitations({ companyId: companyA })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'membership_not_found')
  })

  // ── 8: default page size is 20 ────────────────────────────────────────────
  it('defaults to pageSize 20 when omitted', async () => {
    const { companyId } = await setUpAdmin('default-page-size')
    const t0 = Timestamp.now()
    for (let i = 0; i < 25; i++) {
      await seedInvitationDoc(`invite_default_${i}`, buildRawPendingInvitation(companyId, freshEmail(`default-${i}`), Timestamp.fromMillis(t0.toMillis() - i * 1000)))
    }
    const result = (await callListInvitations({ companyId })) as ListInvitationsResult
    expect(result.items).toHaveLength(20)
    expect(result.nextCursor).not.toBeNull()
  })

  // ── 9: pageSize=50 works ──────────────────────────────────────────────────
  it('pageSize=50 returns up to 50 items', async () => {
    const { companyId } = await setUpAdmin('page-size-50')
    const t0 = Timestamp.now()
    for (let i = 0; i < 5; i++) {
      await seedInvitationDoc(`invite_p50_${i}`, buildRawPendingInvitation(companyId, freshEmail(`p50-${i}`), Timestamp.fromMillis(t0.toMillis() - i * 1000)))
    }
    const result = (await callListInvitations({ companyId, pageSize: 50 })) as ListInvitationsResult
    expect(result.items).toHaveLength(5)
    expect(result.nextCursor).toBeNull()
  })

  // ── 10-11-12: pagination has no dupes/skips; ties broken by document ID; last page nextCursor is null ──
  it('paginates deterministically with no duplicates/skips, breaks createdAt ties by document ID, and the last page has nextCursor: null', async () => {
    const { companyId } = await setUpAdmin('pagination')
    const t0 = Timestamp.fromMillis(1_700_000_000_000)
    const t1 = Timestamp.fromMillis(1_700_000_100_000)
    const t2 = Timestamp.fromMillis(1_700_000_200_000)
    const email = () => freshEmail('pagination')

    // invite_e and invite_c share t2; invite_d and invite_b share t1;
    // invite_a is alone at t0. Expected DESC order (createdAt desc, then
    // documentId desc as the tiebreaker): e, c, d, b, a.
    await seedInvitationDoc('invite_c', buildRawPendingInvitation(companyId, email(), t2))
    await seedInvitationDoc('invite_e', buildRawPendingInvitation(companyId, email(), t2))
    await seedInvitationDoc('invite_b', buildRawPendingInvitation(companyId, email(), t1))
    await seedInvitationDoc('invite_d', buildRawPendingInvitation(companyId, email(), t1))
    await seedInvitationDoc('invite_a', buildRawPendingInvitation(companyId, email(), t0))

    const collected: string[] = []
    let cursor: string | null | undefined
    let pages = 0
    do {
      const result: ListInvitationsResult = (await callListInvitations({ companyId, pageSize: 2, ...(cursor ? { cursor } : {}) })) as ListInvitationsResult
      collected.push(...result.items.map(i => i.inviteId))
      cursor = result.nextCursor
      pages += 1
      expect(pages).toBeLessThan(10) // guard against an infinite loop bug
    } while (cursor)

    expect(collected).toEqual(['invite_e', 'invite_c', 'invite_d', 'invite_b', 'invite_a'])
    expect(pages).toBe(3) // 2 + 2 + 1
  })

  // ── 13: malformed / cross-company cursor rejected ────────────────────────
  it('a malformed cursor is rejected with invalid_request', async () => {
    const { companyId } = await setUpAdmin('malformed-cursor')
    await expect(callListInvitations({ companyId, cursor: 'not-valid-base64url!!' }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
  })

  it('a cursor minted for a DIFFERENT companyId is rejected with invalid_request, never used to page into this company', async () => {
    const { companyId: companyA, adminUid: adminA } = await setUpAdmin('cursor-cross-a')
    const { companyId: companyB } = await setUpAdmin('cursor-cross-b')
    const foreignCursor = encodeInvitationsCursor({
      version: INVITATIONS_CURSOR_VERSION,
      companyId: companyB,
      createdAtSeconds: Math.floor(Date.now() / 1000),
      createdAtNanoseconds: 0,
      inviteId: 'invite_from_company_b',
    })
    await signInAsExistingUser(adminA)
    await expect(callListInvitations({ companyId: companyA, cursor: foreignCursor }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
  })

  // ── Independent review finding #1 (Stage 2b round 1): out-of-range/slash cursor via the REAL callable ──
  it('a cursor with createdAtSeconds outside Firestore\'s valid Timestamp range is rejected with invalid_request, never internal_error', async () => {
    const { companyId } = await setUpAdmin('cursor-out-of-range')
    const outOfRangeCursor = encodeInvitationsCursor({
      version: INVITATIONS_CURSOR_VERSION,
      companyId,
      createdAtSeconds: Number.MAX_SAFE_INTEGER,
      createdAtNanoseconds: 0,
      inviteId: 'invite_synthetic',
    })
    await expect(callListInvitations({ companyId, cursor: outOfRangeCursor }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
  })

  it('a cursor with an inviteId containing a "/" is rejected with invalid_request', async () => {
    const { companyId } = await setUpAdmin('cursor-slash-invite-id')
    const slashCursor = encodeInvitationsCursor({
      version: INVITATIONS_CURSOR_VERSION,
      companyId,
      createdAtSeconds: Math.floor(Date.now() / 1000),
      createdAtNanoseconds: 0,
      inviteId: 'invitations/some_other_id',
    })
    await expect(callListInvitations({ companyId, cursor: slashCursor }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
  })

  // ── Independent review finding #2 (Stage 2b round 2): exact Firestore Timestamp boundary values via the REAL callable ──
  it.each([
    ['one second below the documented minimum', -62_135_596_801],
    ['one second above the documented maximum', 253_402_300_800],
  ])('a cursor with createdAtSeconds exactly %s (%i) is rejected with invalid_request', async (_label, createdAtSeconds) => {
    const { companyId } = await setUpAdmin('cursor-exact-boundary')
    const cursor = encodeInvitationsCursor({
      version: INVITATIONS_CURSOR_VERSION,
      companyId,
      createdAtSeconds,
      createdAtNanoseconds: 0,
      inviteId: 'invite_synthetic',
    })
    await expect(callListInvitations({ companyId, cursor }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
  })

  // ── Independent review finding #1 (Stage 2b round 2): '.', '..', and '__reserved__' inviteId via the REAL callable ──
  it.each(['.', '..', '__reserved__'])('a cursor with inviteId %j (an invalid Firestore document ID) is rejected with invalid_request', async inviteId => {
    const { companyId } = await setUpAdmin('cursor-reserved-invite-id')
    const cursor = encodeInvitationsCursor({
      version: INVITATIONS_CURSOR_VERSION,
      companyId,
      createdAtSeconds: Math.floor(Date.now() / 1000),
      createdAtNanoseconds: 0,
      inviteId,
    })
    await expect(callListInvitations({ companyId, cursor }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
  })

  // ── 14: pending/accepted/revoked all display correctly ───────────────────
  it('pending, accepted, and revoked invitations are all listed with the correct status and fields', async () => {
    const { companyId } = await setUpAdmin('statuses')
    const t0 = Timestamp.now()
    await seedInvitationDoc('invite_status_pending', buildRawPendingInvitation(companyId, freshEmail('status-pending'), Timestamp.fromMillis(t0.toMillis() - 3000), { status: 'pending' }))
    await seedInvitationDoc('invite_status_accepted', buildRawPendingInvitation(companyId, freshEmail('status-accepted'), Timestamp.fromMillis(t0.toMillis() - 2000), { status: 'accepted' }))
    await seedInvitationDoc('invite_status_revoked', buildRawPendingInvitation(companyId, freshEmail('status-revoked'), Timestamp.fromMillis(t0.toMillis() - 1000), { status: 'revoked' }))

    const result = (await callListInvitations({ companyId })) as ListInvitationsResult
    const byId = Object.fromEntries(result.items.map(i => [i.inviteId, i]))
    expect(byId.invite_status_pending?.status).toBe('pending')
    expect(byId.invite_status_accepted?.status).toBe('accepted')
    expect(byId.invite_status_revoked?.status).toBe('revoked')
    // acceptedByUid/revokedBy must never appear, regardless of status.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('acceptedByUid')
    expect(serialized).not.toContain('revokedBy')
  })

  // ── 15: a corrupted invitation document fails the whole call closed ─────
  it('a corrupted invitation document (fails InvitationDocumentSchema) causes a safe internal_error, never a partial response', async () => {
    const { companyId } = await setUpAdmin('corrupted')
    const t0 = Timestamp.now()
    await seedInvitationDoc('invite_corrupted_valid_1', buildRawPendingInvitation(companyId, freshEmail('corrupted-valid'), Timestamp.fromMillis(t0.toMillis() - 1000)))
    // companyId + createdAt are kept VALID (they're the query's equality
    // filter / orderBy field — a document missing createdAt would simply
    // be excluded from the query result set by Firestore, never reaching
    // schema validation at all, which would make this test pass for the
    // wrong reason). What's actually corrupted here is a required field
    // the schema demands (tokenHash entirely absent, role invalid).
    await seedInvitationDoc('invite_corrupted_broken', {
      companyId,
      emailNormalized: freshEmail('corrupted-broken'),
      role: 'not-a-real-role',
      status: 'pending',
      expiresAt: Timestamp.fromMillis(t0.toMillis() + 1000 * 3600),
      createdBy: 'uid_seed_synthetic',
      createdAt: t0,
      updatedAt: t0,
      resendCount: 0,
      lastSentAt: null,
      // tokenHash deliberately omitted entirely.
    })

    await expect(callListInvitations({ companyId })).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'internal_error')
  })

  // ── Independent review finding #2 (Stage 2b round 1): the pageSize+1'th lookahead doc must be validated too ──
  it('a corrupted document that lands ONLY in the pageSize+1 lookahead slot still fails the whole call closed with internal_error', async () => {
    const { companyId } = await setUpAdmin('corrupted-lookahead')
    const t0 = Timestamp.now()
    const pageSize = 2
    // pageSize valid documents, newest-first...
    for (let i = 0; i < pageSize; i++) {
      await seedInvitationDoc(
        `invite_lookahead_valid_${i}`,
        buildRawPendingInvitation(companyId, freshEmail(`lookahead-valid-${i}`), Timestamp.fromMillis(t0.toMillis() - i * 1000)),
      )
    }
    // ...then ONE corrupted document strictly older than all of them, so
    // it sorts into the (pageSize+1)'th position — the lookahead slot that
    // gets discarded by a naive "validate only the sliced page"
    // implementation. It still has valid companyId/createdAt (so it's
    // included in the query result set at all) but an invalid role and no
    // tokenHash.
    await seedInvitationDoc(`invite_lookahead_corrupted`, {
      companyId,
      emailNormalized: freshEmail('lookahead-corrupted'),
      role: 'not-a-real-role',
      status: 'pending',
      expiresAt: Timestamp.fromMillis(t0.toMillis() + 1000 * 3600),
      createdBy: 'uid_seed_synthetic',
      createdAt: Timestamp.fromMillis(t0.toMillis() - pageSize * 1000),
      updatedAt: t0,
      resendCount: 0,
      lastSentAt: null,
    })

    await expect(callListInvitations({ companyId, pageSize }))
      .rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'internal_error')
  })

  // ── 16: invitations/locks/memberships/audit are byte-for-byte unchanged around the call ──
  it('leaves invitations, invitationLocks, memberships, and audit events completely unchanged before vs. after a successful call', async () => {
    const { companyId } = await setUpAdmin('no-side-effects')
    const t0 = Timestamp.now()
    const email = freshEmail('no-side-effects')
    await seedInvitationDoc('invite_no_side_effects', buildRawPendingInvitation(companyId, email, t0))
    // A lock is unrelated to reads, but listInvitations must never touch
    // invitationLocks either — seed one explicitly so there is something
    // concrete to prove stays untouched (independent review finding #3 on
    // SEC-006 Stage 2b round 1: the prior version of this test never
    // checked locks at all).
    await seedInvitationLockDoc(companyId, email, { currentInviteId: 'invite_no_side_effects' })

    const invitationsBefore = await getInvitationsSnapshotForCompany(companyId)
    const lockBefore = await getInvitationLockDoc(companyId, email)
    const membershipsBefore = await getMembershipsSnapshot(companyId)
    const auditBefore = await getAuditEvents(companyId)

    await callListInvitations({ companyId })

    const invitationsAfter = await getInvitationsSnapshotForCompany(companyId)
    const lockAfter = await getInvitationLockDoc(companyId, email)
    const membershipsAfter = await getMembershipsSnapshot(companyId)
    const auditAfter = await getAuditEvents(companyId)

    expect(invitationsAfter).toEqual(invitationsBefore)
    expect(lockAfter).toEqual(lockBefore)
    expect(lockAfter).toEqual({ currentInviteId: 'invite_no_side_effects' })
    expect(membershipsAfter).toEqual(membershipsBefore)
    expect(auditAfter).toEqual(auditBefore)
    expect(auditAfter).toHaveLength(0) // listInvitations itself never writes an audit event
  })

  // ── 17: no Firebase Auth user is created ─────────────────────────────────
  it('creates no Firebase Auth user', async () => {
    const { companyId } = await setUpAdmin('no-auth-user')
    const email = freshEmail('no-auth-user')
    await seedInvitationDoc('invite_no_auth_user', buildRawPendingInvitation(companyId, email, Timestamp.now()))
    expect(await authUserExistsWithEmail(email)).toBe(false)
    await callListInvitations({ companyId })
    expect(await authUserExistsWithEmail(email)).toBe(false)
  })

  // ── 18: no cross-company data ever appears in items or cursor ───────────
  it('never leaks another company\'s data into items or into the emitted nextCursor', async () => {
    const { companyId: companyA, adminUid: adminA } = await setUpAdmin('leak-a')
    const { companyId: companyB } = await setUpAdmin('leak-b')
    const t0 = Timestamp.now()
    // Two invitations in company A (so pageSize:1 forces a real nextCursor
    // to decode) plus one in company B, all sharing the same createdAt
    // instant to also exercise the tie-break path.
    await seedInvitationDoc('invite_leak_a_newer', buildRawPendingInvitation(companyA, freshEmail('leak-a-newer'), t0))
    await seedInvitationDoc('invite_leak_a_older', buildRawPendingInvitation(companyA, freshEmail('leak-a-older'), t0))
    await seedInvitationDoc('invite_leak_b', buildRawPendingInvitation(companyB, freshEmail('leak-b'), t0))

    await signInAsExistingUser(adminA)
    const result = (await callListInvitations({ companyId: companyA, pageSize: 1 })) as ListInvitationsResult
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.inviteId).not.toBe('invite_leak_b')
    expect(result.nextCursor).not.toBeNull()
    const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString('utf8')) as { companyId: string }
    expect(decoded.companyId).toBe(companyA)
    expect(decoded.companyId).not.toBe(companyB)
    expect(JSON.stringify(result)).not.toContain(companyB)

    // Following the cursor stays confined to company A too.
    const page2 = (await callListInvitations({ companyId: companyA, pageSize: 1, cursor: result.nextCursor! })) as ListInvitationsResult
    expect(page2.items.map(i => i.inviteId)).not.toContain('invite_leak_b')
  })
})
