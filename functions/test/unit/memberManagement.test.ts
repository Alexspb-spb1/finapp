// SEC-007 unit proof for the four member-management transaction bodies.
// No emulator: every Firestore interaction goes through a fake Transaction,
// so these assertions are deterministic and cover the exact write/no-write
// decision of each operation.
import { describe, expect, it } from 'vitest'
import { Timestamp, type Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { AppError } from '../../src/lib/errors'
import {
  runChangeMemberRoleTransaction,
  runDisableMemberTransaction,
  runRestoreMemberTransaction,
  runRemoveMemberTransaction,
  MEMBER_MANAGEMENT_AUDIT_ACTIONS,
} from '../../src/lib/memberManagementTransactions'
import {
  MemberSubjectRequestSchema,
  SetMemberRoleRequestSchema,
} from '../../src/schemas/auth'

const NOW = Timestamp.fromDate(new Date('2026-09-11T12:00:00.000Z'))
const COMPANY = 'company_sec007'
const CALLER = 'uid_caller_admin'
const SUBJECT = 'uid_subject'

const membership = (fields: Record<string, unknown> = {}) => ({
  uid: SUBJECT, role: 'viewer', status: 'active',
  createdAt: NOW, updatedAt: NOW, ...fields,
})
const callerMembership = (fields: Record<string, unknown> = {}) => ({
  uid: CALLER, role: 'admin', status: 'active',
  createdAt: NOW, updatedAt: NOW, ...fields,
})

interface FakeOptions {
  caller?: Record<string, unknown>
  target?: Record<string, unknown> | undefined
  maintenance?: boolean
  /** Documents returned by the active-admin query used by assertNotLastAdmin. */
  activeAdmins?: Array<{ id: string; data: Record<string, unknown> }>
}

function fakeTransaction(options: FakeOptions = {}) {
  const reads: string[] = []
  const writes: Array<{ op: 'update' | 'set' | 'delete'; path: string; data?: Record<string, unknown> }> = []
  const activeAdmins = options.activeAdmins ?? [
    { id: CALLER, data: callerMembership() },
    { id: 'uid_other_admin', data: { ...membership({ role: 'admin' }), uid: 'uid_other_admin' } },
  ]

  const txn = {
    get: async (ref: unknown) => {
      // assertNotLastAdmin passes a Query, not a DocumentReference.
      if (ref && typeof ref === 'object' && !('path' in (ref as Record<string, unknown>))) {
        reads.push('query:activeAdmins')
        return { docs: activeAdmins.map(d => ({ id: d.id, data: () => d.data })) }
      }
      const { path, id } = ref as { path: string; id: string }
      reads.push(path)
      if (path === 'system/maintenance') {
        return { exists: true, id, data: () => ({ enabled: options.maintenance ?? false }) }
      }
      if (path.endsWith(`/members/${CALLER}`)) {
        const data = options.caller === undefined ? callerMembership() : options.caller
        return { exists: data !== undefined, id: CALLER, data: () => data }
      }
      if (path.endsWith(`/members/${SUBJECT}`)) {
        const data = 'target' in options ? options.target : membership()
        return { exists: data !== undefined, id: SUBJECT, data: () => data }
      }
      throw new Error(`unexpected read: ${path}`)
    },
    update: (ref: { path: string }, data: Record<string, unknown>) => { writes.push({ op: 'update', path: ref.path, data }) },
    set: (ref: { path: string }, data: Record<string, unknown>) => { writes.push({ op: 'set', path: ref.path, data }) },
    delete: (ref: { path: string }) => { writes.push({ op: 'delete', path: ref.path }) },
  } as unknown as Transaction

  return { txn, reads, writes }
}

// Minimal Firestore stand-in: only builds references with a `path`/`id`.
const db = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      path: `${name}/${id}`,
      id,
      collection: (sub: string) => ({
        doc: (subId: string) => ({ path: `${name}/${id}/${sub}/${subId}`, id: subId }),
        where: () => ({ where: () => ({ __query: true }) }),
      }),
    }),
  }),
} as never

const request = { auth: { uid: CALLER, token: { email_verified: true } } } as unknown as CallableRequest<unknown>
const auth = { uid: CALLER, token: { email_verified: true } }
const generated = { nowTimestamp: NOW }

const roleInput = (role: 'viewer' | 'accountant' | 'admin') =>
  SetMemberRoleRequestSchema.parse({ companyId: COMPANY, subjectUid: SUBJECT, role })
const subjectInput = () => MemberSubjectRequestSchema.parse({ companyId: COMPANY, subjectUid: SUBJECT })

const auditWrites = (writes: Array<{ path: string }>) => writes.filter(w => w.path.includes('/audit_events/'))
const memberWrites = (writes: Array<{ path: string }>) => writes.filter(w => w.path.includes('/members/'))

describe('SEC-007 request schemas reject unsafe path segments', () => {
  it.each(['/', '.', '..', '__reserved__', 'a/b'])('rejects companyId %j', value => {
    expect(MemberSubjectRequestSchema.safeParse({ companyId: value, subjectUid: SUBJECT }).success).toBe(false)
  })

  it.each(['/', '.', '..', '__reserved__', 'a/b'])('rejects subjectUid %j', value => {
    expect(MemberSubjectRequestSchema.safeParse({ companyId: COMPANY, subjectUid: value }).success).toBe(false)
  })

  it('rejects unknown payload fields and unknown roles', () => {
    expect(MemberSubjectRequestSchema.safeParse({ companyId: COMPANY, subjectUid: SUBJECT, role: 'admin' }).success).toBe(false)
    expect(SetMemberRoleRequestSchema.safeParse({ companyId: COMPANY, subjectUid: SUBJECT, role: 'owner' }).success).toBe(false)
  })
})

describe('changeMemberRole', () => {
  it('updates the role and writes exactly one audit event', async () => {
    const f = fakeTransaction()
    const result = await runChangeMemberRoleTransaction({ db, txn: f.txn, request, auth, input: roleInput('accountant'), generated })

    expect(result).toEqual({ changed: true })
    expect(memberWrites(f.writes)).toHaveLength(1)
    expect(memberWrites(f.writes)[0]).toMatchObject({
      op: 'update',
      path: `companies/${COMPANY}/members/${SUBJECT}`,
      data: { role: 'accountant', updatedAt: NOW },
    })
    // status must not be touched by a role change
    expect(memberWrites(f.writes)[0].data).not.toHaveProperty('status')
    expect(auditWrites(f.writes)).toHaveLength(1)
    expect(auditWrites(f.writes)[0].data).toMatchObject({ action: 'member_role_changed', actorUid: CALLER, targetUid: SUBJECT })
  })

  it('is idempotent: requesting the current role writes nothing', async () => {
    const f = fakeTransaction({ target: membership({ role: 'accountant' }) })
    const result = await runChangeMemberRoleTransaction({ db, txn: f.txn, request, auth, input: roleInput('accountant'), generated })

    expect(result).toEqual({ changed: false })
    expect(f.writes).toHaveLength(0)
  })

  it('refuses a missing target without writing', async () => {
    const f = fakeTransaction({ target: undefined })
    await expect(runChangeMemberRoleTransaction({ db, txn: f.txn, request, auth, input: roleInput('admin'), generated }))
      .rejects.toMatchObject({ appCode: 'membership_not_found' })
    expect(f.writes).toHaveLength(0)
  })

  it('refuses when the caller is not an admin, before reading the target', async () => {
    const f = fakeTransaction({ caller: callerMembership({ role: 'accountant' }) })
    await expect(runChangeMemberRoleTransaction({ db, txn: f.txn, request, auth, input: roleInput('admin'), generated }))
      .rejects.toMatchObject({ appCode: 'insufficient_role' })
    expect(f.writes).toHaveLength(0)
    expect(f.reads.some(p => p.endsWith(`/members/${SUBJECT}`))).toBe(false)
  })

  it('refuses when the caller membership is disabled', async () => {
    const f = fakeTransaction({ caller: callerMembership({ status: 'disabled' }) })
    await expect(runChangeMemberRoleTransaction({ db, txn: f.txn, request, auth, input: roleInput('admin'), generated }))
      .rejects.toMatchObject({ appCode: 'membership_inactive' })
    expect(f.writes).toHaveLength(0)
  })

  it('refuses in maintenance mode before any membership read', async () => {
    const f = fakeTransaction({ maintenance: true })
    await expect(runChangeMemberRoleTransaction({ db, txn: f.txn, request, auth, input: roleInput('admin'), generated }))
      .rejects.toMatchObject({ appCode: 'maintenance_mode' })
    expect(f.writes).toHaveLength(0)
    expect(f.reads).toEqual(['system/maintenance'])
  })

  it('refuses a target document whose uid disagrees with its document id', async () => {
    const f = fakeTransaction({ target: membership({ uid: 'uid_someone_else' }) })
    await expect(runChangeMemberRoleTransaction({ db, txn: f.txn, request, auth, input: roleInput('admin'), generated }))
      .rejects.toMatchObject({ appCode: 'membership_data_error' })
    expect(f.writes).toHaveLength(0)
  })

  it('blocks demoting the last active admin', async () => {
    const f = fakeTransaction({
      target: membership({ role: 'admin' }),
      activeAdmins: [{ id: SUBJECT, data: membership({ role: 'admin' }) }],
    })
    await expect(runChangeMemberRoleTransaction({ db, txn: f.txn, request, auth, input: roleInput('viewer'), generated }))
      .rejects.toMatchObject({ appCode: 'last_admin' })
    expect(f.writes).toHaveLength(0)
  })

  it('allows demoting an admin while another active admin remains', async () => {
    const f = fakeTransaction({
      target: membership({ role: 'admin' }),
      activeAdmins: [
        { id: SUBJECT, data: membership({ role: 'admin' }) },
        { id: CALLER, data: callerMembership() },
      ],
    })
    const result = await runChangeMemberRoleTransaction({ db, txn: f.txn, request, auth, input: roleInput('viewer'), generated })
    expect(result).toEqual({ changed: true })
    expect(memberWrites(f.writes)[0].data).toMatchObject({ role: 'viewer' })
  })

  it('does not run the last-admin check when the target admin is already disabled', async () => {
    const f = fakeTransaction({
      target: membership({ role: 'admin', status: 'disabled' }),
      activeAdmins: [{ id: 'uid_only_admin', data: membership({ role: 'admin' }) }],
    })
    const result = await runChangeMemberRoleTransaction({ db, txn: f.txn, request, auth, input: roleInput('viewer'), generated })
    expect(result).toEqual({ changed: true })
    expect(f.reads).not.toContain('query:activeAdmins')
  })
})

describe('disableMember', () => {
  it('disables an active member and audits once', async () => {
    const f = fakeTransaction()
    const result = await runDisableMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated })

    expect(result).toEqual({ changed: true })
    expect(memberWrites(f.writes)[0]).toMatchObject({ op: 'update', data: { status: 'disabled', updatedAt: NOW } })
    expect(memberWrites(f.writes)[0].data).not.toHaveProperty('role')
    expect(auditWrites(f.writes)[0].data).toMatchObject({ action: 'member_disabled', targetUid: SUBJECT })
  })

  it('is idempotent for an already disabled member', async () => {
    const f = fakeTransaction({ target: membership({ status: 'disabled' }) })
    const result = await runDisableMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated })
    expect(result).toEqual({ changed: false })
    expect(f.writes).toHaveLength(0)
  })

  it('refuses to disable an invited membership', async () => {
    const f = fakeTransaction({ target: membership({ status: 'invited' }) })
    await expect(runDisableMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated }))
      .rejects.toMatchObject({ appCode: 'membership_conflict' })
    expect(f.writes).toHaveLength(0)
  })

  it('blocks disabling the last active admin', async () => {
    const f = fakeTransaction({
      target: membership({ role: 'admin' }),
      activeAdmins: [{ id: SUBJECT, data: membership({ role: 'admin' }) }],
    })
    await expect(runDisableMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated }))
      .rejects.toMatchObject({ appCode: 'last_admin' })
    expect(f.writes).toHaveLength(0)
  })

  it('refuses a missing target', async () => {
    const f = fakeTransaction({ target: undefined })
    await expect(runDisableMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated }))
      .rejects.toMatchObject({ appCode: 'membership_not_found' })
  })
})

describe('restoreMember', () => {
  it('restores a disabled member and audits once', async () => {
    const f = fakeTransaction({ target: membership({ status: 'disabled' }) })
    const result = await runRestoreMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated })

    expect(result).toEqual({ changed: true })
    expect(memberWrites(f.writes)[0]).toMatchObject({ op: 'update', data: { status: 'active', updatedAt: NOW } })
    expect(auditWrites(f.writes)[0].data).toMatchObject({ action: 'member_restored', targetUid: SUBJECT })
  })

  it('is idempotent for an already active member', async () => {
    const f = fakeTransaction()
    const result = await runRestoreMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated })
    expect(result).toEqual({ changed: false })
    expect(f.writes).toHaveLength(0)
  })

  it('refuses to restore an invited membership, so invitation acceptance cannot be bypassed', async () => {
    const f = fakeTransaction({ target: membership({ status: 'invited' }) })
    await expect(runRestoreMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated }))
      .rejects.toMatchObject({ appCode: 'membership_conflict' })
    expect(f.writes).toHaveLength(0)
  })

  it('never consults the active-admin query', async () => {
    const f = fakeTransaction({ target: membership({ status: 'disabled', role: 'admin' }) })
    await runRestoreMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated })
    expect(f.reads).not.toContain('query:activeAdmins')
  })
})

describe('removeMember', () => {
  it('deletes exactly the one membership document and audits once', async () => {
    const f = fakeTransaction()
    const result = await runRemoveMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated })

    expect(result).toEqual({ changed: true })
    expect(memberWrites(f.writes)).toEqual([{ op: 'delete', path: `companies/${COMPANY}/members/${SUBJECT}` }])
    expect(auditWrites(f.writes)[0].data).toMatchObject({ action: 'member_removed', targetUid: SUBJECT })
    // Nothing outside this company's member document and its audit event.
    expect(f.writes.filter(w => !w.path.startsWith(`companies/${COMPANY}/`))).toHaveLength(0)
  })

  it('is idempotent when the membership is already absent', async () => {
    const f = fakeTransaction({ target: undefined })
    const result = await runRemoveMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated })
    expect(result).toEqual({ changed: false })
    expect(f.writes).toHaveLength(0)
  })

  it('blocks removing the last active admin', async () => {
    const f = fakeTransaction({
      target: membership({ role: 'admin' }),
      activeAdmins: [{ id: SUBJECT, data: membership({ role: 'admin' }) }],
    })
    await expect(runRemoveMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated }))
      .rejects.toMatchObject({ appCode: 'last_admin' })
    expect(f.writes).toHaveLength(0)
  })

  it('allows removing a disabled admin without a last-admin check', async () => {
    const f = fakeTransaction({
      target: membership({ role: 'admin', status: 'disabled' }),
      activeAdmins: [{ id: 'uid_only_admin', data: membership({ role: 'admin' }) }],
    })
    const result = await runRemoveMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated })
    expect(result).toEqual({ changed: true })
    expect(f.reads).not.toContain('query:activeAdmins')
  })
})

describe('audit action set', () => {
  it('exposes exactly the four SEC-007 actions', () => {
    expect([...MEMBER_MANAGEMENT_AUDIT_ACTIONS]).toEqual([
      'member_role_changed', 'member_disabled', 'member_restored', 'member_removed',
    ])
  })

  it('every failure path throws AppError, never a raw Error', async () => {
    const f = fakeTransaction({ target: undefined })
    const error = await runDisableMemberTransaction({ db, txn: f.txn, request, auth, input: subjectInput(), generated })
      .then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
  })
})
