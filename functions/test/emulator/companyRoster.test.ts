// SEC-007 R1 — listCompanyMembers through the real emulators.
//
// The defect this closes: the roster used to come from a legacy
// `users where companyId == X` query, so a member of a SECONDARY company was
// invisible (their profile names their primary company) while a member whose
// membership had been revoked stayed listed forever.
import { afterEach, describe, expect, it } from 'vitest'
import { FunctionsError } from 'firebase/functions'
import { db } from '../../src/lib/admin'
import {
  createTestUser, signOutClient, seedCompany, seedMembership, seedRawMembershipDoc,
  seedRawUserDoc, setMaintenanceMode, clearMaintenanceMode, callWithEmulatorIdentity,
} from './helpers'

const codeOf = (error: unknown) => error instanceof FunctionsError
  ? (error.details as { appCode?: string })?.appCode
  : undefined

interface RosterEntry { uid: string; role: string; status: string; name: string | null; email: string | null }
const rosterOf = (value: unknown) => (value as { members: RosterEntry[] }).members

let sequence = 0
const freshCompany = (label: string) => `co_roster_${label}_${Date.now()}_${++sequence}`

describe('listCompanyMembers', () => {
  afterEach(async () => { await signOutClient(); await clearMaintenanceMode() })

  it('lists a SECONDARY-company member whose profile names a different company', async () => {
    const primary = freshCompany('primary')
    const secondary = freshCompany('secondary')
    await seedCompany(primary)
    await seedCompany(secondary)

    const { uid: adminUid } = await createTestUser(true, 'roster-admin')
    const { uid: guestUid } = await createTestUser(true, 'roster-guest')
    await seedMembership({ companyId: secondary, uid: adminUid, role: 'admin', status: 'active' })
    // The guest's canonical membership is in `secondary`, but the legacy
    // profile points at `primary` — the exact shape the old query missed.
    await seedMembership({ companyId: secondary, uid: guestUid, role: 'accountant', status: 'active' })
    await seedRawUserDoc(guestUid, {
      id: guestUid, name: 'Guest Person', email: 'guest@example.test',
      role: 'admin', companyId: primary, createdAt: '2026-01-01T00:00:00.000Z',
    })

    const members = rosterOf(await callWithEmulatorIdentity(adminUid, 'listCompanyMembers', { companyId: secondary }))

    expect(members.map(m => m.uid).sort()).toEqual([adminUid, guestUid].sort())
    const guest = members.find(m => m.uid === guestUid)!
    // Role and status come from the membership, never from the profile.
    expect(guest).toMatchObject({ role: 'accountant', status: 'active', name: 'Guest Person', email: 'guest@example.test' })
  })

  it('drops a member as soon as the membership document is removed, whatever the profile says', async () => {
    const companyId = freshCompany('revoked')
    await seedCompany(companyId)
    const { uid: adminUid } = await createTestUser(true, 'roster-revoke-admin')
    const { uid: goneUid } = await createTestUser(true, 'roster-revoke-target')
    await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: goneUid, role: 'viewer', status: 'active' })
    // Legacy profile keeps claiming this company after the revoke.
    await seedRawUserDoc(goneUid, {
      id: goneUid, name: 'Gone', email: 'gone@example.test',
      role: 'viewer', companyId, createdAt: '2026-01-01T00:00:00.000Z',
    })

    expect(rosterOf(await callWithEmulatorIdentity(adminUid, 'listCompanyMembers', { companyId })).map(m => m.uid))
      .toContain(goneUid)

    await callWithEmulatorIdentity(adminUid, 'removeMember', { companyId, subjectUid: goneUid })

    expect(rosterOf(await callWithEmulatorIdentity(adminUid, 'listCompanyMembers', { companyId })).map(m => m.uid))
      .not.toContain(goneUid)
  })

  it('reports the canonical role when the legacy profile disagrees', async () => {
    const companyId = freshCompany('mismatch')
    await seedCompany(companyId)
    const { uid: adminUid } = await createTestUser(true, 'roster-mismatch-admin')
    const { uid: targetUid } = await createTestUser(true, 'roster-mismatch-target')
    await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: targetUid, role: 'viewer', status: 'active' })
    await seedRawUserDoc(targetUid, {
      id: targetUid, name: 'Mismatch', email: 'mismatch@example.test',
      role: 'admin', companyId, createdAt: '2026-01-01T00:00:00.000Z',
    })

    const members = rosterOf(await callWithEmulatorIdentity(adminUid, 'listCompanyMembers', { companyId }))
    expect(members.find(m => m.uid === targetUid)).toMatchObject({ role: 'viewer' })
  })

  it('includes disabled members and reports their status', async () => {
    const companyId = freshCompany('disabled')
    await seedCompany(companyId)
    const { uid: adminUid } = await createTestUser(true, 'roster-disabled-admin')
    const { uid: targetUid } = await createTestUser(true, 'roster-disabled-target')
    await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: targetUid, role: 'viewer', status: 'disabled' })

    const members = rosterOf(await callWithEmulatorIdentity(adminUid, 'listCompanyMembers', { companyId }))
    expect(members.find(m => m.uid === targetUid)).toMatchObject({ status: 'disabled' })
  })

  it('still lists a member whose profile document is missing', async () => {
    const companyId = freshCompany('noprofile')
    await seedCompany(companyId)
    const { uid: adminUid } = await createTestUser(true, 'roster-noprofile-admin')
    await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: 'uid_without_profile', role: 'viewer', status: 'active' })

    const members = rosterOf(await callWithEmulatorIdentity(adminUid, 'listCompanyMembers', { companyId }))
    expect(members.find(m => m.uid === 'uid_without_profile')).toMatchObject({ role: 'viewer', name: null, email: null })
  })

  it('excludes a membership whose uid disagrees with its document id', async () => {
    const companyId = freshCompany('corrupt')
    await seedCompany(companyId)
    const { uid: adminUid } = await createTestUser(true, 'roster-corrupt-admin')
    await seedMembership({ companyId, uid: adminUid, role: 'admin', status: 'active' })
    await seedRawMembershipDoc(companyId, 'uid_ghost', {
      uid: 'uid_other', role: 'admin', status: 'active',
      createdAt: new Date(), updatedAt: new Date(),
    })

    const members = rosterOf(await callWithEmulatorIdentity(adminUid, 'listCompanyMembers', { companyId }))
    expect(members.map(m => m.uid)).toEqual([adminUid])
  })

  it.each(['viewer', 'accountant'] as const)('is readable by a %s member', async role => {
    const companyId = freshCompany(`read-${role}`)
    await seedCompany(companyId)
    const { uid } = await createTestUser(true, `roster-read-${role}`)
    await seedMembership({ companyId, uid, role, status: 'active' })

    const members = rosterOf(await callWithEmulatorIdentity(uid, 'listCompanyMembers', { companyId }))
    expect(members.map(m => m.uid)).toEqual([uid])
  })

  it('refuses a non-member, a disabled member and an unverified caller', async () => {
    const companyId = freshCompany('denied')
    await seedCompany(companyId)
    const { uid: outsider } = await createTestUser(true, 'roster-outsider')
    const { uid: disabled } = await createTestUser(true, 'roster-disabled-caller')
    const { uid: unverified } = await createTestUser(false, 'roster-unverified')
    await seedMembership({ companyId, uid: disabled, role: 'admin', status: 'disabled' })
    await seedMembership({ companyId, uid: unverified, role: 'admin', status: 'active' })

    await expect(callWithEmulatorIdentity(outsider, 'listCompanyMembers', { companyId }))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'membership_not_found')
    await expect(callWithEmulatorIdentity(disabled, 'listCompanyMembers', { companyId }))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'membership_inactive')
    await expect(callWithEmulatorIdentity(unverified, 'listCompanyMembers', { companyId }))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'email_unverified')
  })

  it('never leaks another company roster', async () => {
    const mine = freshCompany('mine')
    const theirs = freshCompany('theirs')
    await seedCompany(mine); await seedCompany(theirs)
    const { uid: adminUid } = await createTestUser(true, 'roster-iso-admin')
    const { uid: strangerUid } = await createTestUser(true, 'roster-iso-stranger')
    await seedMembership({ companyId: mine, uid: adminUid, role: 'admin', status: 'active' })
    await seedMembership({ companyId: theirs, uid: strangerUid, role: 'admin', status: 'active' })

    await expect(callWithEmulatorIdentity(adminUid, 'listCompanyMembers', { companyId: theirs }))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'membership_not_found')
    const members = rosterOf(await callWithEmulatorIdentity(adminUid, 'listCompanyMembers', { companyId: mine }))
    expect(members.map(m => m.uid)).toEqual([adminUid])
  })

  it.each([
    { companyId: '' },
    { companyId: '../escape' },
    { companyId: 'ok', extra: 'field' },
  ])('rejects malformed payload %j', async patch => {
    const companyId = freshCompany('payload')
    await seedCompany(companyId)
    const { uid } = await createTestUser(true, 'roster-payload')
    await seedMembership({ companyId, uid, role: 'admin', status: 'active' })

    await expect(callWithEmulatorIdentity(uid, 'listCompanyMembers', { companyId, ...patch }))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'invalid_request')
  })

  it('writes nothing', async () => {
    const companyId = freshCompany('readonly')
    await seedCompany(companyId)
    const { uid } = await createTestUser(true, 'roster-readonly')
    await seedMembership({ companyId, uid, role: 'admin', status: 'active' })

    const before = await db.collection('companies').doc(companyId).collection('members').get()
    const auditBefore = (await db.collection('companies').doc(companyId).collection('audit_events').get()).size
    await callWithEmulatorIdentity(uid, 'listCompanyMembers', { companyId })
    const after = await db.collection('companies').doc(companyId).collection('members').get()

    expect(after.docs.map(d => d.data())).toEqual(before.docs.map(d => d.data()))
    expect((await db.collection('companies').doc(companyId).collection('audit_events').get()).size).toBe(auditBefore)
  })

  it('is available during maintenance mode because it is read-only', async () => {
    const companyId = freshCompany('maintenance')
    await seedCompany(companyId)
    const { uid } = await createTestUser(true, 'roster-maintenance')
    await seedMembership({ companyId, uid, role: 'admin', status: 'active' })
    await setMaintenanceMode(true)

    const members = rosterOf(await callWithEmulatorIdentity(uid, 'listCompanyMembers', { companyId }))
    expect(members.map(m => m.uid)).toEqual([uid])
  })
})
