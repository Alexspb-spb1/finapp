import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ execute: vi.fn(), callable: vi.fn() }))
vi.mock('./firebase', () => ({ functions: {} }))
vi.mock('firebase/functions', () => ({ httpsCallable: mocks.callable }))
import { buildInvitationLink, invitationApi, invitationErrorMessage } from './invitationApi'

const link = { inviteId: 'invite-1', token: 'a'.repeat(43), expiresAtUtc: '2026-09-13T00:00:00.000Z' }
const item = {
  inviteId: 'invite-1', emailNormalized: 'person@example.test', role: 'viewer', status: 'pending',
  createdAtUtc: '2026-09-06T00:00:00.000Z', expiresAtUtc: link.expiresAtUtc,
  resendCount: 0, lastSentAtUtc: null, createdBy: 'admin-1',
}
beforeEach(() => { vi.resetAllMocks(); mocks.callable.mockReturnValue(mocks.execute) })
describe('invitation callable wire contracts', () => {
  it('uses only the existing callable names and exact request fields', async () => {
    mocks.execute.mockResolvedValueOnce({ data: link }).mockResolvedValueOnce({ data: { items: [item], nextCursor: 'cursor_1' } })
      .mockResolvedValueOnce({ data: { inviteId: link.inviteId, revokedAtUtc: '2026-09-06T00:00:00.000Z' } }).mockResolvedValueOnce({ data: link })
    await expect(invitationApi.create({ companyId: 'company-1', email: 'person@example.test', role: 'viewer' })).resolves.toEqual(link)
    await expect(invitationApi.list({ companyId: 'company-1', cursor: 'cursor_0', pageSize: 20 })).resolves.toEqual({ items: [item], nextCursor: 'cursor_1' })
    await invitationApi.cancel({ companyId: 'company-1', inviteId: link.inviteId })
    await invitationApi.resend({ companyId: 'company-1', inviteId: link.inviteId })
    expect(mocks.callable.mock.calls.map(args => args[1])).toEqual(['inviteMember', 'listInvitations', 'cancelInvite', 'resendInvite'])
    expect(mocks.execute.mock.calls.map(args => args[0])).toEqual([
      { companyId: 'company-1', email: 'person@example.test', role: 'viewer' },
      { companyId: 'company-1', cursor: 'cursor_0', pageSize: 20 },
      { companyId: 'company-1', inviteId: 'invite-1' }, { companyId: 'company-1', inviteId: 'invite-1' },
    ])
  })
  it.each([
    { ...link, tokenHash: 'private-hash' }, { ...link, token: 'short' }, { ...link, expiresAtUtc: 'tomorrow' },
  ])('rejects malformed create/resend responses without leaking values', async data => {
    mocks.execute.mockResolvedValue({ data })
    for (const task of [invitationApi.create({ companyId: 'c', email: 'e@example.test', role: 'admin' }), invitationApi.resend({ companyId: 'c', inviteId: 'i' })]) {
      await expect(task).rejects.toThrow('Не удалось выполнить запрос')
    }
  })
  it.each([
    { items: [{ ...item, role: 'owner' }], nextCursor: null },
    { items: [{ ...item, token: link.token }], nextCursor: null },
    { items: [{ ...item, resendCount: 6 }], nextCursor: null },
    { items: [{ ...item, status: 'expired' }], nextCursor: null },
    { items: [{ ...item, lastSentAtUtc: undefined }], nextCursor: null },
    { items: [item], nextCursor: 'contains space' },
    { items: [item], nextCursor: null, tokenHash: 'private' },
  ])('rejects invalid or expanded list response', async data => {
    mocks.execute.mockResolvedValue({ data })
    await expect(invitationApi.list({ companyId: 'c' })).rejects.toThrow('Не удалось выполнить запрос')
  })
  it('rejects expanded cancellation result', async () => {
    mocks.execute.mockResolvedValue({ data: { inviteId: 'i', revokedAtUtc: item.createdAtUtc, emailNormalized: item.emailNormalized } })
    await expect(invitationApi.cancel({ companyId: 'c', inviteId: 'i' })).rejects.toThrow('Не удалось выполнить запрос')
  })
  it('uses an allowlisted appCode and never raw messages, details, stack or cause', async () => {
    mocks.execute.mockRejectedValue({ message: link.token, details: { appCode: 'invitation_resend_cooldown', token: link.token } })
    await expect(invitationApi.resend({ companyId: 'c', inviteId: 'i' })).rejects.toThrow('через 60 секунд')
    mocks.execute.mockRejectedValue({ message: link.token, details: { appCode: link.token } })
    try { await invitationApi.list({ companyId: 'c' }); expect.fail('must reject') } catch (error) {
      expect(invitationErrorMessage(error)).not.toContain(link.token)
      expect(JSON.stringify(error)).not.toContain(link.token)
      expect(error).not.toHaveProperty('cause')
    }
    expect(invitationErrorMessage(new Error(link.token))).not.toContain(link.token)
  })
  it('builds a basename-aware path with token only in fragment', () => {
    const url = new URL(buildInvitationLink(link, 'https://app.example.test', '/finapp/'))
    expect(url.pathname).toBe('/finapp/accept-invite/invite-1')
    expect(url.search).toBe('')
    expect(url.hash).toBe(`#token=${link.token}`)
    expect(buildInvitationLink(link, 'https://app.example.test', '/')).toBe(`https://app.example.test/accept-invite/invite-1#token=${link.token}`)
  })
})
