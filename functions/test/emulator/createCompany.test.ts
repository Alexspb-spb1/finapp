// Real callable pipeline proof for createCompany — SEC-004.
//
// Every test calls the ACTUAL deployed `createCompany` callable through the
// Functions Emulator (not a direct in-process function call), using real
// Auth Emulator-issued identities and real Firestore Emulator documents —
// no mocked Firestore for these checks (CLAUDE.md §8.6, task instructions).
import { describe, it, expect, afterEach } from 'vitest'
import { FunctionsError } from 'firebase/functions'
import { Timestamp } from 'firebase-admin/firestore'
import {
  createTestUser, signOutClient, callCreateCompany,
  getCompanyDoc, getCompanyDataDoc, getMembershipDoc, getUserDoc, countCompaniesOwnedBy,
  seedRawUserDoc, getBootstrapReceipt, countAuditEvents,
  setMaintenanceMode, clearMaintenanceMode,
} from './helpers'

function appCodeOf(err: unknown): string | undefined {
  if (err instanceof FunctionsError) {
    const details = err.details as { appCode?: string } | undefined
    return details?.appCode
  }
  return undefined
}

const basePayload = {
  ownerName: 'Иван Иванов',
  companyName: 'Моя Компания',
  legalType: 'ooo' as const,
}

describe('createCompany — real callable pipeline through the Functions Emulator', () => {
  it('an unauthenticated call is rejected with auth_required', async () => {
    await signOutClient()
    await expect(
      callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'auth_required')
  })

  it('an UNVERIFIED email can still bootstrap the first company (deliberate SEC-004 exception — mandatory enforcement is SEC-013)', async () => {
    const { uid } = await createTestUser(false, 'unverified-bootstrap')
    const idempotencyKey = crypto.randomUUID()
    const result = (await callCreateCompany({ ...basePayload, idempotencyKey })) as { companyId: string }
    expect(result.companyId).toBeTruthy()
    const membership = await getMembershipDoc(result.companyId, uid)
    expect(membership?.role).toBe('admin')
  })

  it('successfully creates a company, admin membership, company_data, and users/{uid} bridge atomically', async () => {
    const { uid } = await createTestUser(true, 'happy')
    const idempotencyKey = crypto.randomUUID()
    const result = (await callCreateCompany({ ...basePayload, idempotencyKey })) as { companyId: string }
    expect(Object.keys(result)).toEqual(['companyId'])
    const companyId = result.companyId

    const company = await getCompanyDoc(companyId)
    expect(company).toMatchObject({ id: companyId, name: basePayload.companyName, legalType: 'ooo', ownerId: uid })

    const membership = await getMembershipDoc(companyId, uid)
    expect(membership).toMatchObject({ uid, role: 'admin', status: 'active' })
    expect(membership?.createdAt).toBeInstanceOf(Timestamp)

    const companyData = await getCompanyDataDoc(companyId)
    expect(companyData).toBeDefined()
    expect(Array.isArray(companyData?.categories)).toBe(true)
    expect((companyData?.categories as unknown[]).length).toBeGreaterThan(0)

    const userDoc = await getUserDoc(uid)
    expect(userDoc).toMatchObject({ id: uid, role: 'admin', companyId })
  })

  it('owner uid and admin membership come from Auth — a spoofed uid/ownerUid field in the payload is rejected as invalid_request', async () => {
    await createTestUser(true, 'spoof-uid')
    await expect(
      callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID(), uid: 'uid_attacker_supplied' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
    await expect(
      callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID(), ownerUid: 'uid_attacker_supplied' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
  })

  it('a spoofed companyId/role field in the payload is rejected as invalid_request', async () => {
    await createTestUser(true, 'spoof-privileged')
    await expect(
      callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID(), companyId: 'co_client_supplied' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
    await expect(
      callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID(), role: 'admin' }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
  })

  it('retry with the SAME idempotency key after a "lost response" returns the SAME companyId, without creating a second company', async () => {
    const { uid } = await createTestUser(true, 'retry-same-key')
    const idempotencyKey = crypto.randomUUID()
    const first = (await callCreateCompany({ ...basePayload, idempotencyKey })) as { companyId: string }
    const second = (await callCreateCompany({ ...basePayload, idempotencyKey })) as { companyId: string }
    expect(second.companyId).toBe(first.companyId)
    expect(await countCompaniesOwnedBy(uid)).toBe(1)
  })

  it('the SAME key with a DIFFERENT payload gives a stable idempotency_conflict', async () => {
    const { uid } = await createTestUser(true, 'conflict-payload')
    const idempotencyKey = crypto.randomUUID()
    await callCreateCompany({ ...basePayload, idempotencyKey })
    await expect(
      callCreateCompany({ ...basePayload, companyName: 'Другое название', idempotencyKey }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'idempotency_conflict')
    expect(await countCompaniesOwnedBy(uid)).toBe(1)
  })

  it('one uid cannot create two first companies even with a DIFFERENT idempotency key', async () => {
    const { uid } = await createTestUser(true, 'two-companies-diff-key')
    await callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID() })
    await expect(
      callCreateCompany({ ...basePayload, companyName: 'Вторая компания', idempotencyKey: crypto.randomUUID() }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'idempotency_conflict')
    expect(await countCompaniesOwnedBy(uid)).toBe(1)
  })

  it('two PARALLEL identical requests (same key) create exactly one company', async () => {
    const { uid } = await createTestUser(true, 'parallel-same-key')
    const idempotencyKey = crypto.randomUUID()
    const [a, b] = await Promise.allSettled([
      callCreateCompany({ ...basePayload, idempotencyKey }),
      callCreateCompany({ ...basePayload, idempotencyKey }),
    ])
    const companyIds = [a, b]
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
      .map(r => (r.value as { companyId: string }).companyId)
    expect(companyIds.length).toBeGreaterThan(0)
    expect(new Set(companyIds).size).toBe(1) // every successful call agrees on the same companyId
    expect(await countCompaniesOwnedBy(uid)).toBe(1)
  })

  it('two PARALLEL requests with DIFFERENT keys still result in exactly one company', async () => {
    const { uid } = await createTestUser(true, 'parallel-diff-key')
    const [a, b] = await Promise.allSettled([
      callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID() }),
      callCreateCompany({ ...basePayload, companyName: 'Другая компания', idempotencyKey: crypto.randomUUID() }),
    ])
    const fulfilled = [a, b].filter(r => r.status === 'fulfilled')
    const rejected = [a, b].filter(r => r.status === 'rejected')
    // Exactly one of the two concurrent bootstrap attempts may succeed.
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(await countCompaniesOwnedBy(uid)).toBe(1)
  })

  it('after all retries there is exactly ONE active admin membership for the owner', async () => {
    const { uid } = await createTestUser(true, 'one-admin-membership')
    const idempotencyKey = crypto.randomUUID()
    const first = (await callCreateCompany({ ...basePayload, idempotencyKey })) as { companyId: string }
    await callCreateCompany({ ...basePayload, idempotencyKey }) // retry
    const membership = await getMembershipDoc(first.companyId, uid)
    expect(membership).toMatchObject({ uid, role: 'admin', status: 'active' })
  })

  it('invalid request data (bad legalType) leaves no partial company/membership/company_data documents', async () => {
    const { uid } = await createTestUser(true, 'invalid-leaves-nothing')
    await expect(
      callCreateCompany({ ...basePayload, legalType: 'llc', idempotencyKey: crypto.randomUUID() }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
    expect(await countCompaniesOwnedBy(uid)).toBe(0)
    expect(await getUserDoc(uid)).toBeUndefined()
  })

  it('invalid INN for the declared legalType leaves no partial documents', async () => {
    const { uid } = await createTestUser(true, 'invalid-inn-leaves-nothing')
    await expect(
      callCreateCompany({ ...basePayload, inn: '123', idempotencyKey: crypto.randomUUID() }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'invalid_request')
    expect(await countCompaniesOwnedBy(uid)).toBe(0)
  })

  it('errors returned to the client never contain secret-like values from the request', async () => {
    await createTestUser(true, 'secretcheck')
    const secretInn = '9999999999'
    try {
      await callCreateCompany({ ...basePayload, companyName: 'SECRET_LEAKED_NAME', inn: 'not-a-number', idempotencyKey: crypto.randomUUID() })
      expect.unreachable('expected the call to fail for an invalid inn')
    } catch (err) {
      const serialized = JSON.stringify(
        err instanceof FunctionsError ? { code: err.code, details: err.details, message: err.message } : err,
      )
      expect(serialized).not.toContain('SECRET_LEAKED_NAME')
      expect(serialized).not.toContain(secretInn)
    }
  })

  // ── Independent audit fix #4: existing users/{uid} without a bootstrap receipt ──
  it('a uid with an EXISTING users/{uid} profile but no bootstrap receipt is rejected — never a second "first company", never overwrites the profile', async () => {
    const { uid } = await createTestUser(true, 'existing-legacy-profile')
    const legacyProfile = {
      id: uid, name: 'Legacy Name', email: 'legacy@example.test',
      role: 'admin', companyId: 'co_legacy_existing', createdAt: '2020-01-01T00:00:00.000Z',
      companies: [{ companyId: 'co_legacy_existing', role: 'admin' }],
      avatar: 'legacy-avatar-url',
    }
    await seedRawUserDoc(uid, legacyProfile)

    await expect(
      callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'idempotency_conflict')

    // Original profile (companies[]/avatar/legacy companyId) is untouched.
    expect(await getUserDoc(uid)).toEqual(legacyProfile)
    // No new "first company" was created for this uid, and no bootstrap
    // receipt/company/membership/company_data/audit event were left behind
    // by the transaction that threw mid-way (this IS the "error inside the
    // Firestore transaction leaves no partial documents" proof — the throw
    // happens after companyRef/membershipRef/companyDataRef are computed
    // but before any txn.set() call).
    expect(await countCompaniesOwnedBy(uid)).toBe(0)
    expect(await getBootstrapReceipt(uid)).toBeUndefined()
  })

  // ── Independent audit fix #5: test-gap closure ──────────────────────────
  it('a successful bootstrap creates the user_bootstrap/{uid} receipt', async () => {
    const { uid } = await createTestUser(true, 'creates-receipt')
    await callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID() })
    const receipt = await getBootstrapReceipt(uid)
    expect(receipt).toBeDefined()
    expect(receipt?.idempotencyKey).toBeTruthy()
    expect(receipt?.fingerprint).toBeTruthy()
  })

  it('a successful bootstrap creates exactly ONE audit event, and a retry does not create a second one', async () => {
    const { uid: _uid } = await createTestUser(true, 'one-audit-event')
    const idempotencyKey = crypto.randomUUID()
    const first = (await callCreateCompany({ ...basePayload, idempotencyKey })) as { companyId: string }
    expect(await countAuditEvents(first.companyId)).toBe(1)

    await callCreateCompany({ ...basePayload, idempotencyKey }) // retry, same key
    expect(await countAuditEvents(first.companyId)).toBe(1)
  })

  // ── SEC-005 production preflight: maintenance mode ──────────────────────
  describe('SEC-005 production preflight: maintenance mode', () => {
    afterEach(async () => {
      await clearMaintenanceMode()
    })

    it('refuses with maintenance_mode when system/maintenance.enabled is true, and creates nothing', async () => {
      await setMaintenanceMode(true)
      const { uid } = await createTestUser(true, 'maintenance-blocked')
      await expect(
        callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID() }),
      ).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'maintenance_mode')
      expect(await countCompaniesOwnedBy(uid)).toBe(0)
    })

    it('succeeds normally once maintenance mode is disabled again', async () => {
      await setMaintenanceMode(true)
      await clearMaintenanceMode()
      const { uid } = await createTestUser(true, 'maintenance-cleared')
      const result = (await callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID() })) as { companyId: string }
      expect(result.companyId).toBeTruthy()
      expect(await countCompaniesOwnedBy(uid)).toBe(1)
    })

    it('succeeds normally when system/maintenance does not exist at all (the default, pre-runbook state)', async () => {
      const { uid } = await createTestUser(true, 'maintenance-absent')
      await callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID() })
      expect(await countCompaniesOwnedBy(uid)).toBe(1)
    })

    // ── Final-round fix #2: TOCTOU race — maintenance check must be INSIDE the transaction ──
    it('closes the maintenance-mode TOCTOU race: enabling maintenance mode WHILE a createCompany call is in flight still creates zero documents', async () => {
      const { uid } = await createTestUser(true, 'maintenance-race')

      // Fired in the SAME tick, before awaiting anything.
      // callCreateCompany()'s real call goes through the Functions
      // Emulator's HTTP layer and performs SEVERAL sequential round trips
      // (adminAuth.getUser(), the bootstrap-receipt txn.get(), the
      // maintenance txn.get(), the user-profile txn.get(), then a
      // multi-document commit) before it can possibly succeed.
      // setMaintenanceMode() is a single, direct Admin SDK `.set()` — one
      // round trip. Firing it several times (not just once) closes the
      // remaining timing gap: ANY one of these landing inside
      // createCompany's transaction's live read-to-commit window is
      // enough to force Firestore's automatic optimistic-concurrency
      // retry — the whole point of reading system/maintenance via
      // `txn.get()` (requireNotInMaintenanceMode(db, txn) in
      // functions/src/lib/authz.ts) instead of a plain pre-transaction
      // read (the previous implementation, which this test would have
      // caught failing: a plain read taken before the race window could
      // pass, then the transaction could still commit after maintenance
      // mode went active).
      const createPromise = callCreateCompany({ ...basePayload, idempotencyKey: crypto.randomUUID() })
      const maintenancePromises = Array.from({ length: 8 }, () => setMaintenanceMode(true))

      await expect(createPromise).rejects.toSatisfy((err: unknown) => appCodeOf(err) === 'maintenance_mode')
      await Promise.all(maintenancePromises)
      expect(await countCompaniesOwnedBy(uid)).toBe(0)
    })
  })
})
