// requireActiveMember's fail-closed behavior on a genuine Firestore read
// error is exercised here with a hand-built fake Firestore (a real local
// emulator outage isn't something we can deterministically force in CI) —
// the membership-status scenario matrix itself (missing/invited/disabled/
// corrupted/role mismatch/cross-company/last-admin) is covered against the
// REAL Firestore Emulator in test/emulator/.
import { describe, it, expect, vi } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'
import { requireActiveMember } from '../../src/lib/authz'
import { AppError } from '../../src/lib/errors'

function fakeFirestoreThatThrowsOnMemberRead(): Firestore {
  const memberDocRef = { get: vi.fn().mockRejectedValue(new Error('simulated Firestore outage')) }
  const membersCollectionRef = { doc: vi.fn().mockReturnValue(memberDocRef) }
  const companyDocRef = { collection: vi.fn().mockReturnValue(membersCollectionRef) }
  const companiesCollectionRef = { doc: vi.fn().mockReturnValue(companyDocRef) }
  return { collection: vi.fn().mockReturnValue(companiesCollectionRef) } as unknown as Firestore
}

describe('requireActiveMember — Firestore read failure', () => {
  it('is fail-closed: a Firestore read error becomes membership_data_error, never a permissive default', async () => {
    const db = fakeFirestoreThatThrowsOnMemberRead()
    await expect(requireActiveMember(db, 'co_a', 'uid_1')).rejects.toEqual(
      expect.objectContaining({ appCode: 'membership_data_error' }),
    )
  })

  it('never logs anything from the underlying Firestore error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeFirestoreThatThrowsOnMemberRead()
    await expect(requireActiveMember(db, 'co_a', 'uid_1')).rejects.toBeInstanceOf(AppError)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore(); warnSpy.mockRestore()
  })
})
