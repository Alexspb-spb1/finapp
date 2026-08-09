import type { AuthDataStatus } from '../../store/authStore'

// Independent audit fix #2 (SEC-004 PR #12): extracted into its own module
// (not inline in ProtectedRoute.tsx) so this redirect DECISION is
// unit-testable without a DOM/React renderer — this repo has no
// jsdom/React Testing Library setup (see docs/remediation/reports/SEC-004.md,
// "Известные ограничения") — and so ProtectedRoute.tsx keeps exporting only
// its default component (react-refresh/only-export-components). See
// src/components/layout/ProtectedRoute.test.ts.
export function resolveProtectedRouteRedirect(params: {
  isAuthenticated: boolean
  status: AuthDataStatus
}): '/login' | '/register' | null {
  if (params.isAuthenticated) return null
  // A Firebase Auth session exists but the server-side company setup never
  // completed (authStore.getAuthDataStatus() === 'setup_incomplete'):
  // sending this user to /login would just re-authenticate the SAME Auth
  // account (signInWithEmailAndPassword succeeds), land back on "/", and
  // bounce to /login again — a visible "/ -> /login" loop with no way to
  // ever finish registration. Route to /register instead, which renders the
  // resumable setup_incomplete screen for an already-authenticated user.
  if (params.status === 'setup_incomplete') return '/register'
  return '/login'
}
