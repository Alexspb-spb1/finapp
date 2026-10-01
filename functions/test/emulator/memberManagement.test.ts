// SEC-007 — the four member-management callables through the real Functions,
// Auth and Firestore emulators. Every call below is a real HTTPS callable
// request signed by a real Auth Emulator identity; no in-process shortcut.
import { afterEach, describe, expect, it } from 'vitest'
import { FunctionsError } from 'firebase/functions'
import { db } from '../../src/lib/admin'
import {
  createTestUser, signOutClient,
  seedCompany, seedMembership, seedRawMembershipDoc,
  getMembershipDoc, getAuditEvents, countAuditEvents,
  setMaintenanceMode, clearMaintenanceMode,
  callWithEmulatorIdentity, authUserExistsWithEmail,
} from './helpers'
import { adminAuth } from '../../src/lib/admin'

type Command = 'changeMemberRole' | 'disableMember' | 'restoreMember' | 'removeMember'

const codeOf = (error: unknown) => error instanceof FunctionsError
  ? (error.details as { appCode?: string })?.appCode
  : undefined

let sequence = 0
const freshCompany = (label: string) => `co_sec007_${label}_${Date.now()}_${++sequence}`

async function membersOf(companyId: string) {
  const snap = await db.collection('companies').doc(companyId).collection('members').get()
  return snap.docs.map(d => ({ id: d.id, data: d.data() })).sort((a, b) => a.id.localeCompare(b.id))
}

/** Full before/after state used to prove a denial wrote nothing at all. */
async function snapshot(companyId: string) {
  return { members: await membersOf(companyId), auditCount: await countAuditEvents(companyId) }
}

async function expectDenied(uid: string, command: Command, payload: unknown, appCode: string, companyId: string) {
  const before = await snapshot(companyId)
  await expect(callWithEmulatorIdentity(uid, command, payload))
    .rejects.toSatisfy((e: unknown) => codeOf(e) === appCode)
  expect(await snapshot(companyId)).toEqual(before)
}

/** Company with one admin caller plus one target member. */
async function setUp(label: string, targetRole: 'viewer' | 'accountant' | 'admin' = 'viewer', targetStatus: 'active' | 'disabled' | 'invited' = 'active') {
  const companyId = freshCompany(label)
  await seedCompany(companyId)
  const { uid: adminUid } = await createTestUser(true, `${label}-admin`)
  const { uid: targetUid } = await createTestUser(true, `${label}-target`)
  await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
  await seedMembership({ companyId, uid: targetUid, role: targetRole, status: targetStatus })
  return { companyId, adminUid, targetUid }
}

describe('SEC-007 member management through real emulators', () => {
  afterEach(async () => { await signOutClient(); await clearMaintenanceMode() })

  // ── happy paths ─────────────────────────────────────────────────────────
  it('changeMemberRole updates only role/updatedAt and writes one audit event', async () => {
    const { companyId, adminUid, targetUid } = await setUp('role-happy')
    const before = await getMembershipDoc(companyId, targetUid)

    const result = await callWithEmulatorIdentity(adminUid, 'changeMemberRole', { companyId, subjectUid: targetUid, role: 'accountant' })
    expect(result).toEqual({ changed: true })

    const after = await getMembershipDoc(companyId, targetUid)
    expect(after).toMatchObject({ uid: targetUid, role: 'accountant', status: 'active' })
    expect(after?.createdAt).toEqual(before?.createdAt)
    expect(after?.invitedBy).toEqual(before?.invitedBy)

    const events = await getAuditEvents(companyId)
    const event = events.find(e => e.action === 'member_role_changed')!
    expect(Object.keys(event).sort()).toEqual(['action', 'actorUid', 'createdAt', 'targetUid'])
    expect(event).toMatchObject({ actorUid: adminUid, targetUid })
  })

  it('disableMember then restoreMember round-trips status and audits each change once', async () => {
    const { companyId, adminUid, targetUid } = await setUp('disable-restore')

    expect(await callWithEmulatorIdentity(adminUid, 'disableMember', { companyId, subjectUid: targetUid })).toEqual({ changed: true })
    expect((await getMembershipDoc(companyId, targetUid))?.status).toBe('disabled')

    expect(await callWithEmulatorIdentity(adminUid, 'restoreMember', { companyId, subjectUid: targetUid })).toEqual({ changed: true })
    const restored = await getMembershipDoc(companyId, targetUid)
    expect(restored).toMatchObject({ status: 'active', role: 'viewer' })

    const actions = (await getAuditEvents(companyId)).map(e => e.action).sort()
    expect(actions).toEqual(['member_disabled', 'member_restored'])
  })

  it('removeMember deletes the membership without touching the Firebase Auth account', async () => {
    const { companyId, adminUid, targetUid } = await setUp('remove-happy')
    const email = (await adminAuth.getUser(targetUid)).email!

    expect(await callWithEmulatorIdentity(adminUid, 'removeMember', { companyId, subjectUid: targetUid })).toEqual({ changed: true })

    expect(await getMembershipDoc(companyId, targetUid)).toBeUndefined()
    // The global account must survive — removal revokes ONE company only.
    expect(await authUserExistsWithEmail(email)).toBe(true)
    await expect(adminAuth.getUser(targetUid)).resolves.toMatchObject({ uid: targetUid })
    expect((await getAuditEvents(companyId)).map(e => e.action)).toEqual(['member_removed'])
  })

  it('removeMember revokes only the named company and leaves other memberships intact', async () => {
    const { companyId, adminUid, targetUid } = await setUp('remove-multi')
    const otherCompanyId = freshCompany('remove-multi-other')
    await seedCompany(otherCompanyId)
    await seedMembership({ companyId: otherCompanyId, uid: targetUid, role: 'accountant', status: 'active' })

    await callWithEmulatorIdentity(adminUid, 'removeMember', { companyId, subjectUid: targetUid })

    expect(await getMembershipDoc(companyId, targetUid)).toBeUndefined()
    expect(await getMembershipDoc(otherCompanyId, targetUid)).toMatchObject({ role: 'accountant', status: 'active' })
  })

  // ── idempotency ─────────────────────────────────────────────────────────
  it('repeating each operation in its target state changes nothing and adds no audit event', async () => {
    const { companyId, adminUid, targetUid } = await setUp('idempotent')

    await callWithEmulatorIdentity(adminUid, 'changeMemberRole', { companyId, subjectUid: targetUid, role: 'accountant' })
    await callWithEmulatorIdentity(adminUid, 'disableMember', { companyId, subjectUid: targetUid })
    const settled = await snapshot(companyId)

    expect(await callWithEmulatorIdentity(adminUid, 'changeMemberRole', { companyId, subjectUid: targetUid, role: 'accountant' })).toEqual({ changed: false })
    expect(await callWithEmulatorIdentity(adminUid, 'disableMember', { companyId, subjectUid: targetUid })).toEqual({ changed: false })
    expect(await snapshot(companyId)).toEqual(settled)

    // removeMember twice: second call is a safe no-op, not an error.
    expect(await callWithEmulatorIdentity(adminUid, 'removeMember', { companyId, subjectUid: targetUid })).toEqual({ changed: true })
    const afterRemove = await snapshot(companyId)
    expect(await callWithEmulatorIdentity(adminUid, 'removeMember', { companyId, subjectUid: targetUid })).toEqual({ changed: false })
    expect(await snapshot(companyId)).toEqual(afterRemove)
  })

  // ── negative roles / authorization ──────────────────────────────────────
  it.each(['viewer', 'accountant'] as const)('a %s caller is refused insufficient_role for every operation', async role => {
    const companyId = freshCompany(`role-${role}`)
    await seedCompany(companyId)
    const { uid: callerUid } = await createTestUser(true, `caller-${role}`)
    const { uid: targetUid } = await createTestUser(true, `target-${role}`)
    await seedMembership({ companyId, uid: callerUid, role, status: 'active' })
    await seedMembership({ companyId, uid: targetUid, role: 'viewer', status: 'active' })

    await expectDenied(callerUid, 'changeMemberRole', { companyId, subjectUid: targetUid, role: 'admin' }, 'insufficient_role', companyId)
    await expectDenied(callerUid, 'disableMember', { companyId, subjectUid: targetUid }, 'insufficient_role', companyId)
    await expectDenied(callerUid, 'restoreMember', { companyId, subjectUid: targetUid }, 'insufficient_role', companyId)
    await expectDenied(callerUid, 'removeMember', { companyId, subjectUid: targetUid }, 'insufficient_role', companyId)
  })

  it('a disabled admin cannot manage members', async () => {
    const companyId = freshCompany('disabled-admin')
    await seedCompany(companyId)
    const { uid: callerUid } = await createTestUser(true, 'disabled-admin')
    const { uid: targetUid } = await createTestUser(true, 'disabled-admin-target')
    await seedMembership({ companyId, uid: callerUid, role: 'admin', status: 'disabled' })
    await seedMembership({ companyId, uid: targetUid, role: 'viewer', status: 'active' })

    await expectDenied(callerUid, 'disableMember', { companyId, subjectUid: targetUid }, 'membership_inactive', companyId)
  })

  it('a caller with no membership in the company is refused', async () => {
    const { companyId, targetUid } = await setUp('outsider')
    const { uid: outsiderUid } = await createTestUser(true, 'outsider')

    await expectDenied(outsiderUid, 'removeMember', { companyId, subjectUid: targetUid }, 'membership_not_found', companyId)
  })

  it('an unverified admin is refused', async () => {
    const companyId = freshCompany('unverified')
    await seedCompany(companyId)
    const { uid: callerUid } = await createTestUser(false, 'unverified-admin')
    const { uid: targetUid } = await createTestUser(true, 'unverified-target')
    await seedMembership({ companyId, uid: callerUid, role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: targetUid, role: 'viewer', status: 'active' })

    await expectDenied(callerUid, 'disableMember', { companyId, subjectUid: targetUid }, 'email_unverified', companyId)
  })

  // ── cross-company isolation ─────────────────────────────────────────────
  it('an admin of company A cannot manage a member of company B', async () => {
    const a = await setUp('iso-a')
    const b = await setUp('iso-b')

    // Admin A targets B's member while naming B's company: no membership in B.
    await expectDenied(a.adminUid, 'changeMemberRole', { companyId: b.companyId, subjectUid: b.targetUid, role: 'admin' }, 'membership_not_found', b.companyId)

    // Admin A names their OWN company but B's subject. There is no such
    // document under company A, so removeMember takes its idempotent
    // "already absent" path: it writes nothing and returns changed:false.
    // This is also oracle-safe — the response is identical to that for a uid
    // that exists nowhere, so company A's admin learns nothing about B.
    const beforeForeignRemove = await snapshot(a.companyId)
    expect(await callWithEmulatorIdentity(a.adminUid, 'removeMember', { companyId: a.companyId, subjectUid: b.targetUid }))
      .toEqual({ changed: false })
    expect(await snapshot(a.companyId)).toEqual(beforeForeignRemove)

    // Company B is untouched by either attempt.
    expect(await getMembershipDoc(b.companyId, b.targetUid)).toMatchObject({ role: 'viewer', status: 'active' })
    expect(await countAuditEvents(b.companyId)).toBe(0)
  })

  // ── last-admin protection ───────────────────────────────────────────────
  it('the sole active admin cannot demote, disable or remove themselves', async () => {
    const companyId = freshCompany('sole-admin')
    await seedCompany(companyId)
    const { uid: adminUid } = await createTestUser(true, 'sole-admin')
    await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })

    await expectDenied(adminUid, 'changeMemberRole', { companyId, subjectUid: adminUid, role: 'viewer' }, 'last_admin', companyId)
    await expectDenied(adminUid, 'disableMember', { companyId, subjectUid: adminUid }, 'last_admin', companyId)
    await expectDenied(adminUid, 'removeMember', { companyId, subjectUid: adminUid }, 'last_admin', companyId)
  })

  it('a disabled admin does not count toward the active-admin set', async () => {
    const companyId = freshCompany('disabled-not-counted')
    await seedCompany(companyId)
    const { uid: activeAdmin } = await createTestUser(true, 'active-admin')
    const { uid: disabledAdmin } = await createTestUser(true, 'disabled-admin2')
    await seedMembership({ companyId, uid: activeAdmin, role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: disabledAdmin, role: 'admin', status: 'disabled' })

    // Only one ACTIVE admin exists, so demoting them must still be refused.
    await expectDenied(activeAdmin, 'changeMemberRole', { companyId, subjectUid: activeAdmin, role: 'viewer' }, 'last_admin', companyId)
  })

  it('a corrupted admin document is not counted as a real admin', async () => {
    const companyId = freshCompany('corrupt-admin')
    await seedCompany(companyId)
    const { uid: adminUid } = await createTestUser(true, 'corrupt-caller')
    await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
    // uid disagrees with the document id — must not prop up the admin count.
    await seedRawMembershipDoc(companyId, 'uid_ghost_admin', {
      uid: 'uid_different', role: 'admin', status: 'active',
      createdAt: new Date(), updatedAt: new Date(),
    })

    await expectDenied(adminUid, 'disableMember', { companyId, subjectUid: adminUid }, 'last_admin', companyId)
  })

  it('two concurrent demotions of the last two admins leave exactly one admin', async () => {
    const companyId = freshCompany('concurrent-demote')
    await seedCompany(companyId)
    const { uid: adminA } = await createTestUser(true, 'concurrent-a')
    const { uid: adminB } = await createTestUser(true, 'concurrent-b')
    await seedMembership({ companyId, uid: adminA, role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: adminB, role: 'admin', status: 'active' })

    // Each admin tries to demote the other at the same instant.
    const [first, second] = await Promise.allSettled([
      callWithEmulatorIdentity(adminA, 'changeMemberRole', { companyId, subjectUid: adminB, role: 'viewer' }),
      callWithEmulatorIdentity(adminB, 'changeMemberRole', { companyId, subjectUid: adminA, role: 'viewer' }),
    ])

    const fulfilled = [first, second].filter(r => r.status === 'fulfilled')
    const rejected = [first, second].filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // Which fail-closed code the loser sees depends on commit order, and all
    // of them are correct refusals: if the loser's own demotion committed
    // first it is no longer an admin (`insufficient_role`); if the loser is
    // still an admin it is now the only one (`last_admin`). Both leave the
    // company with an admin, which is the invariant that matters.
    expect(['last_admin', 'insufficient_role']).toContain(codeOf(rejected[0].reason))

    const admins = (await membersOf(companyId)).filter(m => m.data.role === 'admin' && m.data.status === 'active')
    expect(admins).toHaveLength(1)
    expect((await getAuditEvents(companyId)).filter(e => e.action === 'member_role_changed')).toHaveLength(1)
  })

  it('two concurrent removals of the last two admins leave exactly one admin', async () => {
    const companyId = freshCompany('concurrent-remove')
    await seedCompany(companyId)
    const { uid: adminA } = await createTestUser(true, 'concurrent-rm-a')
    const { uid: adminB } = await createTestUser(true, 'concurrent-rm-b')
    await seedMembership({ companyId, uid: adminA, role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: adminB, role: 'admin', status: 'active' })

    const results = await Promise.allSettled([
      callWithEmulatorIdentity(adminA, 'removeMember', { companyId, subjectUid: adminB }),
      callWithEmulatorIdentity(adminB, 'removeMember', { companyId, subjectUid: adminA }),
    ])

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    // Same reasoning as the concurrent demotion test: the loser is refused
    // either because it is now the last admin, or because the winner already
    // deleted the loser's own membership, so it can no longer authorize.
    expect(['last_admin', 'membership_not_found']).toContain(codeOf(rejected[0].reason))

    const admins = (await membersOf(companyId)).filter(m => m.data.role === 'admin' && m.data.status === 'active')
    expect(admins).toHaveLength(1)
    expect((await getAuditEvents(companyId)).filter(e => e.action === 'member_removed')).toHaveLength(1)
  })

  it('a third admin cannot concurrently strip the company of its last two admins', async () => {
    // Stable caller: the caller's own authorization can never be invalidated
    // mid-race here, so the refusal is unambiguously the last-admin guard.
    const companyId = freshCompany('concurrent-third')
    await seedCompany(companyId)
    const { uid: caller } = await createTestUser(true, 'concurrent-third-caller')
    const { uid: adminA } = await createTestUser(true, 'concurrent-third-a')
    const { uid: adminB } = await createTestUser(true, 'concurrent-third-b')
    await seedMembership({ companyId, uid: caller, role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: adminA, role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: adminB, role: 'admin', status: 'active' })

    // Three admins: concurrently demoting two of them must leave the caller.
    const results = await Promise.allSettled([
      callWithEmulatorIdentity(caller, 'changeMemberRole', { companyId, subjectUid: adminA, role: 'viewer' }),
      callWithEmulatorIdentity(caller, 'changeMemberRole', { companyId, subjectUid: adminB, role: 'viewer' }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2)

    // Now the caller is the sole admin and cannot demote itself, sequentially
    // or concurrently.
    const selfAttempts = await Promise.allSettled([
      callWithEmulatorIdentity(caller, 'changeMemberRole', { companyId, subjectUid: caller, role: 'viewer' }),
      callWithEmulatorIdentity(caller, 'disableMember', { companyId, subjectUid: caller }),
    ])
    expect(selfAttempts.filter(r => r.status === 'fulfilled')).toHaveLength(0)
    for (const attempt of selfAttempts) {
      expect(codeOf((attempt as PromiseRejectedResult).reason)).toBe('last_admin')
    }

    const admins = (await membersOf(companyId)).filter(m => m.data.role === 'admin' && m.data.status === 'active')
    expect(admins.map(a => a.id)).toEqual([caller])
  })

  // ── state-transition rules ──────────────────────────────────────────────
  it('an invited membership can be neither disabled nor restored', async () => {
    const { companyId, adminUid, targetUid } = await setUp('invited-state', 'viewer', 'invited')

    await expectDenied(adminUid, 'disableMember', { companyId, subjectUid: targetUid }, 'membership_conflict', companyId)
    await expectDenied(adminUid, 'restoreMember', { companyId, subjectUid: targetUid }, 'membership_conflict', companyId)
  })

  it('a missing target is refused for role/disable/restore', async () => {
    const { companyId, adminUid } = await setUp('missing-target')
    const absent = 'uid_never_existed'

    await expectDenied(adminUid, 'changeMemberRole', { companyId, subjectUid: absent, role: 'admin' }, 'membership_not_found', companyId)
    await expectDenied(adminUid, 'disableMember', { companyId, subjectUid: absent }, 'membership_not_found', companyId)
    await expectDenied(adminUid, 'restoreMember', { companyId, subjectUid: absent }, 'membership_not_found', companyId)
  })

  it('a corrupted target membership is refused with membership_data_error', async () => {
    const companyId = freshCompany('corrupt-target')
    await seedCompany(companyId)
    const { uid: adminUid } = await createTestUser(true, 'corrupt-target-admin')
    await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
    await seedRawMembershipDoc(companyId, 'uid_corrupt_target', {
      uid: 'uid_corrupt_target', role: 'superuser', status: 'active',
      createdAt: new Date(), updatedAt: new Date(),
    })

    await expectDenied(adminUid, 'changeMemberRole', { companyId, subjectUid: 'uid_corrupt_target', role: 'viewer' }, 'membership_data_error', companyId)
  })

  // ── maintenance mode and payload validation ─────────────────────────────
  it('maintenance mode blocks every operation', async () => {
    const { companyId, adminUid, targetUid } = await setUp('maintenance')
    await setMaintenanceMode(true)

    await expectDenied(adminUid, 'changeMemberRole', { companyId, subjectUid: targetUid, role: 'admin' }, 'maintenance_mode', companyId)
    await expectDenied(adminUid, 'disableMember', { companyId, subjectUid: targetUid }, 'maintenance_mode', companyId)
    await expectDenied(adminUid, 'removeMember', { companyId, subjectUid: targetUid }, 'maintenance_mode', companyId)
  })

  it.each([
    { role: 'owner' },
    { role: 'ADMIN' },
    { subjectUid: '' },
    { companyId: '../escape' },
    { subjectUid: '__proto__' },
    { extra: 'field' },
  ])('rejects malformed payload %j as invalid_request', async patch => {
    const { companyId, adminUid, targetUid } = await setUp('payload')
    const payload = { companyId, subjectUid: targetUid, role: 'accountant', ...patch }

    await expectDenied(adminUid, 'changeMemberRole', payload, 'invalid_request', companyId)
  })

  it('an unauthenticated caller is refused', async () => {
    const { companyId, targetUid } = await setUp('unauth')
    await signOutClient()
    // Deliberately not using callWithEmulatorIdentity: no identity at all.
    const { getFunctions, connectFunctionsEmulator, httpsCallable } = await import('firebase/functions')
    const { initializeApp, deleteApp } = await import('firebase/app')
    const app = initializeApp({ projectId: 'demo-finapp', apiKey: 'emulator-only-synthetic-key' }, `anon-sec007-${Date.now()}`)
    try {
      const fns = getFunctions(app)
      connectFunctionsEmulator(fns, '127.0.0.1', 5001)
      await expect(httpsCallable(fns, 'disableMember')({ companyId, subjectUid: targetUid }))
        .rejects.toSatisfy((e: unknown) => codeOf(e) === 'auth_required')
    } finally {
      await deleteApp(app)
    }
  })
})
