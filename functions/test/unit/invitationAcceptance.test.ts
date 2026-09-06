import { createHash } from 'node:crypto'
import { Timestamp, type Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { describe, expect, it } from 'vitest'
import { db } from '../../src/lib/admin'
import { AppError } from '../../src/lib/errors'
import { performAcceptInvite, performPreviewInvite } from '../../src/index'
import { maskInvitationEmail, verifyInvitationToken } from '../../src/lib/invitationAccess'
import { runAcceptInviteTransaction } from '../../src/lib/acceptInviteTransaction'
import { AcceptInviteResponseSchema, PreviewInviteResponseSchema } from '../../src/schemas/invitation'

const NOW = Timestamp.fromDate(new Date('2026-09-06T12:00:00.000Z'))
const TOKEN = Buffer.alloc(32, 7).toString('base64url')
const HASH = createHash('sha256').update(TOKEN).digest('hex')
const COMPANY = 'company_accept_synthetic'
const UID = 'uid_accept_synthetic'
const EMAIL = 'invitee@example.test'
const ID = 'invite_accept_synthetic'
const request = (data: unknown = { inviteId: ID, token: TOKEN }, claims: Record<string, unknown> = {}) => ({
  data, auth: { uid: UID, token: { email: EMAIL, email_verified: true, ...claims } },
}) as unknown as CallableRequest<unknown>
const invitation = (fields: Record<string, unknown> = {}) => ({
  companyId: COMPANY, emailNormalized: EMAIL, role: 'accountant', tokenHash: HASH,
  status: 'pending', createdBy: 'uid_inviter_synthetic',
  createdAt: Timestamp.fromMillis(NOW.toMillis() - 120_000), updatedAt: NOW,
  expiresAt: Timestamp.fromMillis(NOW.toMillis() + 60_000), resendCount: 0,
  lastSentAt: null, ...fields,
})
const member = (fields: Record<string, unknown> = {}) => ({
  uid: UID, role: 'accountant', status: 'active',
  createdAt: Timestamp.fromMillis(NOW.toMillis() - 120_000), updatedAt: NOW, ...fields,
})

function fakeTransaction(options: {
  invite?: Record<string, unknown> | null
  membership?: Record<string, unknown>
  profile?: Record<string, unknown>
  company?: Record<string, unknown> | null
  lock?: Record<string, unknown> | null
  maintenance?: boolean
} = {}) {
  const reads: string[] = []
  const writes: Array<{ path: string; data: Record<string, unknown> }> = []
  const txn = {
    get: async (ref: { path: string; id: string }) => {
      expect(writes).toHaveLength(0) // Firestore forbids reads after writes.
      reads.push(ref.path)
      let data: Record<string, unknown> | undefined | null
      if (ref.path === 'system/maintenance') data = { enabled: options.maintenance ?? false }
      else if (ref.path === `invitations/${ID}`) data = options.invite === undefined ? invitation() : options.invite
      else if (ref.path.startsWith('invitationLocks/')) data = options.lock === undefined ? { currentInviteId: ID } : options.lock
      else if (ref.path === `companies/${COMPANY}`) data = options.company === undefined ? { id: COMPANY, name: 'Synthetic company' } : options.company
      else if (ref.path === `companies/${COMPANY}/members/${UID}`) data = options.membership
      else if (ref.path === `users/${UID}`) data = options.profile
      else throw new Error('Unexpected read in acceptance test')
      return { exists: data !== undefined && data !== null, id: ref.id, data: () => data }
    },
    set: (ref: { path: string }, data: Record<string, unknown>) => { writes.push({ path: ref.path, data }) },
    update: (ref: { path: string }, data: Record<string, unknown>) => { writes.push({ path: ref.path, data }) },
  } as unknown as Transaction
  const run = <T>(fn: (tx: Transaction) => Promise<T>) => fn(txn)
  return { txn, reads, writes, run }
}

describe('invitation access contract', () => {
  it('authenticates the raw token hash independently of document status', () => {
    expect(verifyInvitationToken(invitation(), HASH).companyId).toBe(COMPANY)
    for (const raw of [undefined, {}, invitation({ tokenHash: '0'.repeat(64) }), invitation({ tokenHash: 'bad', status: 'accepted' })]) {
      expect(() => verifyInvitationToken(raw, HASH)).toThrowError(new AppError('invite_invalid'))
    }
    expect(() => verifyInvitationToken(invitation({ role: 'bad' }), HASH)).toThrowError(new AppError('internal_error'))
  })

  it.each(['a@b.test', 'ab@xy.test', 'john@domain.test'])('masks short and long email addresses: %s', email => {
    const masked = maskInvitationEmail(email)
    expect(masked).toContain('***')
    expect(masked).not.toContain(email)
    expect(masked).not.toContain(email.split('@')[1])
  })

  it('returns only the approved minimal shapes', () => {
    const accepted = { companyId: COMPANY }
    const preview = { maskedEmail: 'i***@e***.test', companyDisplayName: 'Synthetic', roleLabel: 'Бухгалтер', expiresAt: NOW.toDate().toISOString() }
    expect(AcceptInviteResponseSchema.safeParse(accepted).success).toBe(true)
    expect(PreviewInviteResponseSchema.safeParse(preview).success).toBe(true)
    for (const key of ['token', 'tokenHash', 'emailNormalized', 'uid', 'role']) {
      expect(AcceptInviteResponseSchema.safeParse({ ...accepted, [key]: 'unexpected' }).success).toBe(false)
      expect(PreviewInviteResponseSchema.safeParse({ ...preview, [key]: 'unexpected' }).success).toBe(false)
    }
    expect(PreviewInviteResponseSchema.safeParse({ ...preview, companyId: COMPANY }).success).toBe(false)
  })
})

describe('acceptInvite transaction', () => {
  it('creates membership, legacy bridge, consumed invitation and audit in one transaction', async () => {
    const f = fakeTransaction()
    const result = await performAcceptInvite(request(), f.run, () => NOW)
    expect(result).toEqual({ companyId: COMPANY })
    expect(f.writes).toHaveLength(4)
    const membership = f.writes.find(w => w.path.includes('/members/'))!
    expect(membership.data).toMatchObject({ uid: UID, role: 'accountant', status: 'active', invitedBy: 'uid_inviter_synthetic' })
    const consumed = f.writes.find(w => w.path === `invitations/${ID}`)!
    expect(consumed.data).toMatchObject({ status: 'accepted', acceptedByUid: UID })
    const audit = f.writes.find(w => w.path.includes('/audit_events/'))!
    expect(Object.keys(audit.data).sort()).toEqual(['action', 'actorUid', 'createdAt', 'targetUid'])
    expect(audit.data).toMatchObject({ action: 'invite_accepted', actorUid: UID, targetUid: UID })
    expect(JSON.stringify(f.writes)).not.toContain(TOKEN)
    expect(JSON.stringify(f.writes)).not.toContain(HASH)
    expect(f.writes.some(w => w.path.startsWith('invitationLocks/'))).toBe(false)
  })

  it.each([
    [{ invite: null }, 'invite_invalid'],
    [{ invite: invitation({ tokenHash: '0'.repeat(64), status: 'revoked' }) }, 'invite_invalid'],
    [{ invite: invitation({ status: 'revoked', revokedAt: NOW, revokedBy: 'uid_inviter_synthetic' }) }, 'invite_revoked'],
    [{ invite: invitation({ status: 'accepted', acceptedAt: NOW, acceptedByUid: 'another_uid' }) }, 'invite_already_used'],
    [{ invite: invitation({ expiresAt: NOW }) }, 'invite_expired'],
    [{ invite: invitation({ createdAt: Timestamp.fromMillis(NOW.toMillis() + 1) }) }, 'internal_error'],
    [{ lock: null }, 'internal_error'],
    [{ lock: { broken: true } }, 'internal_error'],
    [{ lock: { currentInviteId: 'replacement_invite' } }, 'invite_invalid'],
    [{ company: null }, 'invite_invalid'],
    [{ membership: member({ role: 'admin' }) }, 'membership_conflict'],
    [{ membership: member({ uid: 'another_uid' }) }, 'membership_data_error'],
    [{ membership: member({ role: 'unknown' }) }, 'membership_data_error'],
    [{ profile: { id: UID, role: 'admin' } }, 'internal_error'],
    [{ maintenance: true }, 'maintenance_mode'],
  ] as const)('denies invalid state without queued writes (%s)', async (options, code) => {
    const f = fakeTransaction(options)
    await expect(performAcceptInvite(request(), f.run, () => NOW)).rejects.toMatchObject({ appCode: code })
    expect(f.writes).toHaveLength(0)
  })

  it.each([
    [{ email_verified: false }, 'email_unverified'],
    [{ email: 'attacker@example.test' }, 'invite_invalid'],
    [{ email: undefined }, 'invite_invalid'],
  ])('uses trusted verified email claims (%s)', async (claims, code) => {
    const f = fakeTransaction()
    await expect(performAcceptInvite(request(undefined, claims), f.run, () => NOW)).rejects.toMatchObject({ appCode: code })
    expect(f.writes).toHaveLength(0)
  })

  it('requires authentication and rejects privileged payload fields and invalid IDs before reads', async () => {
    const f = fakeTransaction()
    await expect(performAcceptInvite({ data: {} } as CallableRequest<unknown>, f.run, () => NOW)).rejects.toMatchObject({ appCode: 'auth_required' })
    for (const data of [{ inviteId: ID, token: TOKEN, role: 'admin' }, { inviteId: '../unsafe', token: TOKEN }]) {
      await expect(performAcceptInvite(request(data), f.run, () => NOW)).rejects.toMatchObject({ appCode: 'invalid_request' })
    }
    expect(f.reads).toHaveLength(0)
    expect(f.writes).toHaveLength(0)
  })

  it('same-UID accepted replay immediately returns without membership/profile/lock reads or any writes, even after expiry', async () => {
    const f = fakeTransaction({ invite: invitation({ status: 'accepted', acceptedAt: NOW, acceptedByUid: UID, expiresAt: NOW }) })
    await expect(performAcceptInvite(request(), f.run, () => NOW)).resolves.toEqual({ companyId: COMPANY })
    expect(f.reads).toEqual(['system/maintenance', `invitations/${ID}`])
    expect(f.writes).toHaveLength(0)
  })

  it('does not rewrite an already-active membership of the same role', async () => {
    const f = fakeTransaction({ membership: member() })
    await performAcceptInvite(request(), f.run, () => NOW)
    expect(f.writes.some(w => w.path.includes('/members/'))).toBe(false)
    expect(f.writes.filter(w => w.path.includes('/audit_events/'))).toHaveLength(1)
  })

  it.each(['disabled', 'invited'])('activates an existing %s membership with the invited role, preserving creation time', async status => {
    const original = member({ status, role: 'viewer' })
    const f = fakeTransaction({ membership: original })
    await performAcceptInvite(request(), f.run, () => NOW)
    expect(f.writes.find(w => w.path.includes('/members/'))?.data).toMatchObject({ status: 'active', role: 'accountant', createdAt: original.createdAt })
  })

  it('preserves another primary company in the legacy bridge and only updates the invited company entry', async () => {
    const profile = { id: UID, name: 'Synthetic name', email: EMAIL, role: 'admin', companyId: 'primary_company', createdAt: NOW.toDate().toISOString(), companies: [{ companyId: 'primary_company', role: 'admin' }, { companyId: COMPANY, role: 'viewer' }] }
    const f = fakeTransaction({ profile })
    await performAcceptInvite(request(), f.run, () => NOW)
    expect(f.writes.find(w => w.path === `users/${UID}`)?.data).toMatchObject({ role: 'admin', companyId: 'primary_company', companies: [{ companyId: 'primary_company', role: 'admin' }, { companyId: COMPANY, role: 'accountant' }] })
  })

  it('reevaluates expiry at every transaction attempt and never succeeds using an earlier timestamp', async () => {
    const a = fakeTransaction()
    const b = fakeTransaction()
    let nowCalls = 0
    const clock = () => (++nowCalls <= 2 ? NOW : Timestamp.fromMillis(NOW.toMillis() + 60_000))
    const run = async <T>(fn: (tx: Transaction) => Promise<T>) => { await fn(a.txn); return fn(b.txn) }
    await expect(performAcceptInvite(request(), run, clock)).rejects.toMatchObject({ appCode: 'invite_expired' })
    expect(a.writes).toHaveLength(4)
    expect(b.writes).toHaveLength(0)
  })

  it('does not consume an invitation that expires while transaction reads are waiting', async () => {
    const f = fakeTransaction()
    let clockCalls = 0
    const clock = () => (++clockCalls === 1 ? NOW : Timestamp.fromMillis(NOW.toMillis() + 60_000))
    await expect(performAcceptInvite(request(), f.run, clock)).rejects.toMatchObject({ appCode: 'invite_expired' })
    expect(f.reads).toContain(`users/${UID}`)
    expect(f.writes).toHaveLength(0)
  })

  it('checks verified email inside the transaction body as well', async () => {
    const f = fakeTransaction()
    const r = request(undefined, { email_verified: false })
    await expect(runAcceptInviteTransaction({ db, txn: f.txn, request: r, auth: r.auth!, inviteId: ID, tokenHash: HASH, now: NOW })).rejects.toMatchObject({ appCode: 'email_unverified' })
    expect(f.writes).toHaveLength(0)
  })
})

describe('previewInvite', () => {
  it('is pre-auth, read-only, and returns only masked metadata', async () => {
    const f = fakeTransaction()
    const r = { data: { inviteId: ID, token: TOKEN } } as CallableRequest<unknown>
    const result = await performPreviewInvite(r, f.run, () => NOW)
    expect(PreviewInviteResponseSchema.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({ companyDisplayName: 'Synthetic company', roleLabel: 'Бухгалтер' })
    expect(JSON.stringify(result)).not.toContain(EMAIL)
    expect(JSON.stringify(result)).not.toContain(COMPANY)
    expect(f.writes).toHaveLength(0)
  })

  it.each([
    [null, 'invite_invalid'],
    [invitation({ tokenHash: '0'.repeat(64) }), 'invite_invalid'],
    [invitation({ status: 'accepted', acceptedAt: NOW, acceptedByUid: UID }), 'invite_already_used'],
    [invitation({ status: 'revoked', revokedAt: NOW, revokedBy: UID }), 'invite_revoked'],
    [invitation({ expiresAt: NOW }), 'invite_expired'],
  ])('distinguishes terminal states only after token authentication (%s)', async (invite, code) => {
    const f = fakeTransaction({ invite })
    await expect(performPreviewInvite(request(), f.run, () => NOW)).rejects.toMatchObject({ appCode: code })
    expect(f.writes).toHaveLength(0)
  })
})
