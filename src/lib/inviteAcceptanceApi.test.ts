import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ execute: vi.fn(), callable: vi.fn() }))
vi.mock('./firebase', () => ({ functions: {} }))
vi.mock('firebase/functions', () => ({ httpsCallable: mocks.callable }))
import { preview, accept, confirmCompanyAccess, inviteAcceptanceError } from './inviteAcceptanceApi'
beforeEach(() => { vi.resetAllMocks(); mocks.callable.mockReturnValue(mocks.execute) })
it('uses exact preview/accept/access contracts, with no requested role or uid', async () => {
  const input = { inviteId: 'invite', token: 'a'.repeat(43) }
  mocks.execute.mockResolvedValueOnce({ data: { maskedEmail: 'a***@example.test', companyDisplayName: 'Company', roleLabel: 'Бухгалтер', expiresAt: '2026-09-13T00:00:00.000Z' } })
    .mockResolvedValueOnce({ data: { companyId: 'company' } })
    .mockResolvedValueOnce({ data: { companyId: 'company', uid: 'user', role: 'accountant' } })
  await preview(input); await accept(input); await confirmCompanyAccess('company', 'user')
  expect(mocks.callable.mock.calls.map(call => call[1])).toEqual(['previewInvite', 'acceptInvite', 'getCompanyAccess'])
  expect(mocks.execute.mock.calls.map(call => call[0])).toEqual([input, input, { companyId: 'company' }])
})
it.each([
  { companyId: 'other', uid: 'user', role: 'viewer' },
  { companyId: 'company', uid: 'other', role: 'viewer' },
  { companyId: 'company', uid: 'user', role: 'owner' },
  { companyId: 'company', uid: 'user', role: 'viewer', token: 'private' },
])('rejects wrong or expanded access proof', async data => {
  mocks.execute.mockResolvedValue({ data })
  await expect(confirmCompanyAccess('company', 'user')).rejects.toThrow()
})
it('rejects raw metadata/errors without exposing invitation secrets', async () => {
  const secret = 'private_invitation_token'
  mocks.execute.mockResolvedValue({ data: { companyId: 'company', token: secret } })
  await expect(accept({ inviteId: 'i', token: secret })).rejects.toThrow('Не удалось')
  mocks.execute.mockRejectedValue({ message: secret, details: { appCode: secret }, cause: secret })
  try { await accept({ inviteId: 'i', token: secret }); expect.fail() } catch (error) {
    expect(inviteAcceptanceError(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(error).not.toHaveProperty('cause')
  }
})
