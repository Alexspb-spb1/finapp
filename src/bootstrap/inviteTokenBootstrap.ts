// Intentionally import-free: this module runs before the application's module
// graph is requested. Never persist this capability or attach it to window.
export interface InviteContext {
  inviteId: string
  token: string | null
}

let inviteContext: InviteContext | null = null

if (typeof window !== 'undefined') {
  const base = import.meta.env.BASE_URL
  const prefix = `${base}accept-invite/`
  const { pathname, search, hash } = window.location
  if (pathname.startsWith(prefix)) {
    const fragment = hash.slice(1)
    const parts = fragment.split('&')
    const tokens: string[] = []
    let malformedTokenKey = false
    const kept = parts.filter(part => {
      const [key, ...value] = part.split('=')
      // URLSearchParams tolerates broken percent escapes, allowing token%XX
      // and %74oken%XX to be scrubbed without treating them as capabilities.
      const decodedKey = new URLSearchParams(`${key}=`).keys().next().value ?? ''
      const invalidKey = decodedKey.startsWith('token%')
      if (decodedKey !== 'token' && !invalidKey) return true
      malformedTokenKey ||= invalidKey
      tokens.push(value.join('='))
      return false
    })

    // Scrub even malformed values, duplicate token parameters and invalid IDs.
    // A failure must stop startup, rather than load observers with the token.
    if (tokens.length > 0) {
      const remaining = kept.join('&')
      window.history.replaceState(window.history.state, '', `${pathname}${search}${remaining ? `#${remaining}` : ''}`)
    }

    let inviteId = ''
    try { inviteId = decodeURIComponent(pathname.slice(prefix.length)) } catch { /* fail closed */ }
    if (inviteId.length > 0 && inviteId.length <= 200 && !inviteId.includes('/')
      && inviteId !== '.' && inviteId !== '..' && !/^__.*__$/.test(inviteId)) {
      inviteContext = {
        inviteId,
        token: !malformedTokenKey && tokens.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(tokens[0]) ? tokens[0] : null,
      }
    }
  }
}

export function getInviteContext(): InviteContext | null {
  return inviteContext ? { ...inviteContext } : null
}

export function clearInviteToken(): void {
  if (inviteContext) inviteContext = { inviteId: inviteContext.inviteId, token: null }
}
