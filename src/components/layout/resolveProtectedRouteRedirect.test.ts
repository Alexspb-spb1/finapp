// Independent audit fix #2 on SEC-004 (PR #12) — this pure redirect decision
// has no React/Firebase imports, so it's directly unit-testable without a
// DOM/React renderer (this repo has no jsdom/React Testing Library setup —
// see docs/remediation/reports/SEC-004.md, "Известные ограничения").
import { describe, it, expect } from 'vitest'
import { resolveProtectedRouteRedirect } from './resolveProtectedRouteRedirect'

describe('resolveProtectedRouteRedirect', () => {
  it('does not redirect an authenticated user', () => {
    expect(resolveProtectedRouteRedirect({ isAuthenticated: true, status: 'ready' })).toBeNull()
  })

  it('redirects to /register (never /login) for an unauthenticated setup_incomplete user — avoids the "/ -> /login" loop', () => {
    expect(resolveProtectedRouteRedirect({ isAuthenticated: false, status: 'setup_incomplete' })).toBe('/register')
  })

  it('redirects a genuinely signed-out user to /login', () => {
    expect(resolveProtectedRouteRedirect({ isAuthenticated: false, status: 'signed_out' })).toBe('/login')
  })

  it('redirects an unauthenticated data_error state to /login (fail-closed — not treated as a resumable setup)', () => {
    expect(resolveProtectedRouteRedirect({ isAuthenticated: false, status: 'data_error' })).toBe('/login')
  })

  it('redirects an unauthenticated loading-leftover state to /login', () => {
    expect(resolveProtectedRouteRedirect({ isAuthenticated: false, status: 'loading' })).toBe('/login')
  })
})
