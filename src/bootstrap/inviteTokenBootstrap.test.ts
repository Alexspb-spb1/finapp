// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const token = 'A'.repeat(43)
const route = '/finapp/accept-invite/invite-123'

async function load(url: string) {
  history.replaceState({ preserved: true }, '', url)
  vi.resetModules()
  return import('./inviteTokenBootstrap')
}

describe('invitation capability bootstrap', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    // Vitest serves files from / independently of Vite's production base.
    vi.stubEnv('BASE_URL', '/finapp/')
    localStorage.clear()
    sessionStorage.clear()
  })

  it('captures privately and scrubs synchronously before downstream external observers', async () => {
    const fetchObserver = vi.fn(async (_url: string, _init: RequestInit) => new Response())
    vi.stubGlobal('fetch', fetchObserver)
    const bootstrap = await load(`${route}?lang=ru#token=${token}`)
    // Simulated downstream telemetry actually sends the observed document URL.
    await fetch('https://observer.example.test/collect', { method: 'POST', body: location.href })
    expect(fetchObserver).toHaveBeenCalledExactlyOnceWith('https://observer.example.test/collect', {
      method: 'POST', body: `http://localhost:3000${route}?lang=ru`,
    })
    expect(bootstrap.getInviteContext()).toEqual({ inviteId: 'invite-123', token })
    expect(history.state).toEqual({ preserved: true })
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    bootstrap.getInviteContext()!.token = 'changed-copy'
    expect(bootstrap.getInviteContext()!.token).toBe(token)
    bootstrap.clearInviteToken()
    expect(bootstrap.getInviteContext()).toEqual({ inviteId: 'invite-123', token: null })
    vi.unstubAllGlobals()
  })

  it.each(['token', 'token=', 'token=%ZZ', 'token=short', `token=${token}&token=${token}`, '%74oken=short', `token%XX=${token}`, `%74oken%XX=${token}`])(
    'scrubs malformed token fragment %s without losing other fragments', async fragment => {
      const bootstrap = await load(`${route}?lang=ru#section=help&${fragment}&anchor=original%20value`)
      expect(location.pathname + location.search + location.hash).toBe(`${route}?lang=ru#section=help&anchor=original%20value`)
      expect(bootstrap.getInviteContext()).toEqual({ inviteId: 'invite-123', token: null })
    },
  )

  it.each(['/finapp/', '/finapp/#/login', '/other/accept-invite/invite-123', '/finapp/not-accept-invite/invite-123'])(
    'does not capture an unrelated route %s', async url => {
      const bootstrap = await load(url.includes('#') ? url : `${url}#section`)
      expect(bootstrap.getInviteContext()).toBeNull()
      expect(location.pathname + location.search + location.hash).toBe(url.includes('#') ? url : `${url}#section`)
    },
  )

  it('never captures a token from another base path', async () => {
    const bootstrap = await load(`/other/accept-invite/invite-123#token=${token}`)
    expect(bootstrap.getInviteContext()).toBeNull()
  })

  it('uses the configured base without rewriting pathname, query or unrelated anchor', async () => {
    vi.stubEnv('BASE_URL', '/nested/project/')
    const bootstrap = await load(`/nested/project/accept-invite/invite-123?q=keep#token=${token}&details`)
    expect(bootstrap.getInviteContext()).toEqual({ inviteId: 'invite-123', token })
    expect(location.pathname + location.search + location.hash).toBe('/nested/project/accept-invite/invite-123?q=keep#details')
  })

  it.each(['', 'nested/id', '%2F', '%ZZ', '__reserved__', 'a'.repeat(201)])('rejects malformed ID %s but scrubs its token', async id => {
    const bootstrap = await load(`/finapp/accept-invite/${id}#token=${token}`)
    expect(bootstrap.getInviteContext()).toBeNull()
    expect(location.hash).toBe('')
  })

  it('retains only module memory through internal transitions and cannot recover after reload', async () => {
    const bootstrap = await load(`${route}#token=${token}`)
    history.replaceState(null, '', `${route}#/login`)
    expect(bootstrap.getInviteContext()!.token).toBe(token)
    vi.resetModules()
    const reloaded = await import('./inviteTokenBootstrap')
    expect(reloaded.getInviteContext()!.token).toBeNull()
  })

  it('fails startup closed if the browser refuses to scrub', async () => {
    history.replaceState(null, '', `${route}#token=${token}`)
    vi.spyOn(history, 'replaceState').mockImplementation(() => { throw new Error('blocked') })
    vi.resetModules()
    await expect(import('./inviteTokenBootstrap')).rejects.toThrow('blocked')
  })
})
