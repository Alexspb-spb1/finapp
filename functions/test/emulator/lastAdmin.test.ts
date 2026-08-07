// assertNotLastAdmin — SEC-003. No mutating Cloud Function exists yet
// (SEC-004+), so these tests exercise assertNotLastAdmin exactly the way a
// future privileged command will: inside a Firestore transaction, guarding
// a membership mutation performed via the Admin SDK against the real
// Firestore Emulator.
import { describe, it, expect } from 'vitest'
import type { Transaction, DocumentReference } from 'firebase-admin/firestore'
import { db } from '../../src/lib/admin'
import { assertNotLastAdmin } from '../../src/lib/authz'
import { AppError, type AppErrorCode } from '../../src/lib/errors'
import { seedCompany, seedMembership, seedRawMembershipDoc } from './helpers'

async function attemptGuardedMutation(
  companyId: string,
  subjectUid: string,
  mutate: (txn: Transaction, ref: DocumentReference) => void,
): Promise<'ok' | AppErrorCode> {
  try {
    await db.runTransaction(async txn => {
      await assertNotLastAdmin(db, txn, companyId, subjectUid)
      const ref = db.collection('companies').doc(companyId).collection('members').doc(subjectUid)
      mutate(txn, ref)
    })
    return 'ok'
  } catch (err) {
    if (err instanceof AppError) return err.appCode
    throw err
  }
}

async function readMembership(companyId: string, uid: string) {
  const snap = await db.collection('companies').doc(companyId).collection('members').doc(uid).get()
  return snap.exists ? snap.data() : undefined
}

describe('assertNotLastAdmin — transaction-guarded last-admin invariant', () => {
  it('demoting the sole active admin is rejected with last_admin, and the document is left unchanged', async () => {
    const companyId = `co_lastadmin_demote_${Date.now()}`
    await seedCompany(companyId)
    await seedMembership({ companyId, uid: 'uid_sole_admin', role: 'admin', status: 'active' })

    const result = await attemptGuardedMutation(companyId, 'uid_sole_admin', (txn, ref) =>
      txn.update(ref, { role: 'viewer' }),
    )
    expect(result).toBe('last_admin')

    const after = await readMembership(companyId, 'uid_sole_admin')
    expect(after?.role).toBe('admin')
    expect(after?.status).toBe('active')
  })

  it('disabling the sole active admin is rejected with last_admin', async () => {
    const companyId = `co_lastadmin_disable_${Date.now()}`
    await seedCompany(companyId)
    await seedMembership({ companyId, uid: 'uid_sole_admin', role: 'admin', status: 'active' })

    const result = await attemptGuardedMutation(companyId, 'uid_sole_admin', (txn, ref) =>
      txn.update(ref, { status: 'disabled' }),
    )
    expect(result).toBe('last_admin')

    const after = await readMembership(companyId, 'uid_sole_admin')
    expect(after?.status).toBe('active')
  })

  it('deleting the sole active admin membership is rejected with last_admin', async () => {
    const companyId = `co_lastadmin_delete_${Date.now()}`
    await seedCompany(companyId)
    await seedMembership({ companyId, uid: 'uid_sole_admin', role: 'admin', status: 'active' })

    const result = await attemptGuardedMutation(companyId, 'uid_sole_admin', (txn, ref) => txn.delete(ref))
    expect(result).toBe('last_admin')

    const after = await readMembership(companyId, 'uid_sole_admin')
    expect(after).toBeDefined()
  })

  it('with two active admins, changing one is allowed and the other remains a valid active admin', async () => {
    const companyId = `co_twoadmins_${Date.now()}`
    await seedCompany(companyId)
    await seedMembership({ companyId, uid: 'uid_admin_x', role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: 'uid_admin_y', role: 'admin', status: 'active' })

    const result = await attemptGuardedMutation(companyId, 'uid_admin_x', (txn, ref) =>
      txn.update(ref, { role: 'viewer' }),
    )
    expect(result).toBe('ok')

    const x = await readMembership(companyId, 'uid_admin_x')
    const y = await readMembership(companyId, 'uid_admin_y')
    expect(x?.role).toBe('viewer')
    expect(y?.role).toBe('admin')
    expect(y?.status).toBe('active')
  })

  it('ownerId does not bypass the last-admin check', async () => {
    const companyId = `co_lastadmin_owner_${Date.now()}`
    // seedCompany's default ownerId is a synthetic value unrelated to the sole admin's uid.
    await seedCompany(companyId, 'uid_owner_not_the_admin')
    await seedMembership({ companyId, uid: 'uid_sole_admin', role: 'admin', status: 'active' })

    const result = await attemptGuardedMutation(companyId, 'uid_sole_admin', (txn, ref) =>
      txn.update(ref, { role: 'viewer' }),
    )
    expect(result).toBe('last_admin')
  })

  it('two concurrent demote-the-other-admin requests never leave the company with zero active admins', async () => {
    const companyId = `co_concurrent_${Date.now()}`
    await seedCompany(companyId)
    await seedMembership({ companyId, uid: 'uid_admin_x', role: 'admin', status: 'active' })
    await seedMembership({ companyId, uid: 'uid_admin_y', role: 'admin', status: 'active' })

    const [resultX, resultY] = await Promise.all([
      attemptGuardedMutation(companyId, 'uid_admin_x', (txn, ref) => txn.update(ref, { role: 'viewer' })),
      attemptGuardedMutation(companyId, 'uid_admin_y', (txn, ref) => txn.update(ref, { role: 'viewer' })),
    ])

    const results = [resultX, resultY].sort()
    // Exactly one demotion succeeds; the other is rejected because it would
    // have left zero active admins (whether Firestore serializes the two
    // transactions or retries one after the other's write invalidates its
    // read set, the OUTCOME must be: never both succeed).
    expect(results).toEqual(['last_admin', 'ok'])

    const x = await readMembership(companyId, 'uid_admin_x')
    const y = await readMembership(companyId, 'uid_admin_y')
    const stillActiveAdminCount = [x, y].filter(m => m?.role === 'admin' && m?.status === 'active').length
    expect(stillActiveAdminCount).toBe(1)
  })

  it('a corrupted document that merely matches role/status by field value does NOT count as a real admin — protects the true last admin (independent review finding #3)', async () => {
    const companyId = `co_lastadmin_corrupted_${Date.now()}`
    await seedCompany(companyId)
    // uid_real_admin is the ONLY genuinely valid active admin.
    await seedMembership({ companyId, uid: 'uid_real_admin', role: 'admin', status: 'active' })
    // uid_corrupted's document matches the query filter (role=admin,
    // status=active) but its own `uid` field does not match the document
    // ID — MembershipSchema/document-id checks should exclude it from the
    // active-admin count, exactly like requireActiveMember already does
    // for reads.
    await seedRawMembershipDoc(companyId, 'uid_corrupted', {
      uid: 'uid_someone_else_entirely', role: 'admin', status: 'active',
    })

    const result = await attemptGuardedMutation(companyId, 'uid_real_admin', (txn, ref) =>
      txn.update(ref, { role: 'viewer' }),
    )
    expect(result).toBe('last_admin')

    const after = await readMembership(companyId, 'uid_real_admin')
    expect(after?.role).toBe('admin')
  })

  it('a schema-invalid document (missing required fields) that matches the query filter does NOT count as a real admin', async () => {
    const companyId = `co_lastadmin_schemainvalid_${Date.now()}`
    await seedCompany(companyId)
    await seedMembership({ companyId, uid: 'uid_real_admin', role: 'admin', status: 'active' })
    // Matches the query (role/status fields present) but is missing
    // createdAt/updatedAt — fails MembershipSchema.
    await seedRawMembershipDoc(companyId, 'uid_schema_invalid', {
      uid: 'uid_schema_invalid', role: 'admin', status: 'active',
    })

    const result = await attemptGuardedMutation(companyId, 'uid_real_admin', (txn, ref) =>
      txn.update(ref, { status: 'disabled' }),
    )
    expect(result).toBe('last_admin')
  })
})
