import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ callable: vi.fn(), invoke: vi.fn() }))
vi.mock('firebase/functions', () => ({ httpsCallable: mocks.callable }))
vi.mock('./firebase', () => ({ functions: {} }))

const { memberApi, memberErrorMessage, MemberApiError } = await import('./memberApi')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.callable.mockReturnValue(mocks.invoke)
})

const appError = (appCode: string) => Object.assign(new Error('opaque'), { details: { appCode } })

describe('memberApi', () => {
  it.each([
    ['changeRole', 'changeMemberRole', { companyId: 'co', subjectUid: 'u', role: 'accountant' as const }],
    ['disable', 'disableMember', { companyId: 'co', subjectUid: 'u' }],
    ['restore', 'restoreMember', { companyId: 'co', subjectUid: 'u' }],
    ['remove', 'removeMember', { companyId: 'co', subjectUid: 'u' }],
  ])('%s calls the %s callable and returns the parsed result', async (method, callableName, input) => {
    mocks.invoke.mockResolvedValue({ data: { changed: true } })
    const api = memberApi as unknown as Record<string, (arg: unknown) => Promise<unknown>>

    await expect(api[method](input)).resolves.toEqual({ changed: true })
    expect(mocks.callable).toHaveBeenCalledWith({}, callableName)
    expect(mocks.invoke).toHaveBeenCalledWith(input)
  })

  it('passes through the idempotent changed:false result as success', async () => {
    mocks.invoke.mockResolvedValue({ data: { changed: false } })
    await expect(memberApi.disable({ companyId: 'co', subjectUid: 'u' })).resolves.toEqual({ changed: false })
  })

  it.each([
    ['last_admin', 'Нельзя убрать последнего администратора'],
    ['insufficient_role', 'только администратор'],
    ['membership_not_found', 'не найден'],
    ['membership_conflict', 'не допускает это действие'],
    ['maintenance_mode', 'на обслуживании'],
    ['email_unverified', 'Подтвердите ваш email'],
  ])('maps %s to a specific user-visible message', async (code, fragment) => {
    mocks.invoke.mockRejectedValue(appError(code))
    const error = await memberApi.remove({ companyId: 'co', subjectUid: 'u' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MemberApiError)
    expect((error as InstanceType<typeof MemberApiError>).code).toBe(code)
    expect(memberErrorMessage(error)).toContain(fragment)
  })

  it('never leaks an SDK message for an unknown code or a network failure', async () => {
    mocks.invoke.mockRejectedValue(new Error('FirebaseError: internal leak uid=123'))
    const error = await memberApi.disable({ companyId: 'co', subjectUid: 'u' }).catch((e: unknown) => e)

    expect(memberErrorMessage(error)).not.toContain('uid=123')
    expect(memberErrorMessage(error)).not.toContain('FirebaseError')
    expect(memberErrorMessage(error)).toContain('Не удалось выполнить действие')
  })

  it('rejects a malformed response instead of reporting success', async () => {
    mocks.invoke.mockResolvedValue({ data: { ok: true } })
    await expect(memberApi.restore({ companyId: 'co', subjectUid: 'u' })).rejects.toBeInstanceOf(MemberApiError)
  })

  it('refuses to send an invalid role or empty identifier', async () => {
    await expect(memberApi.changeRole({ companyId: 'co', subjectUid: 'u', role: 'owner' as never })).rejects.toBeTruthy()
    await expect(memberApi.remove({ companyId: '', subjectUid: 'u' })).rejects.toBeTruthy()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
