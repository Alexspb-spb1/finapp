import type { AuthDataStatus } from '../store/authStore'

// Independent audit fix (SEC-004 PR #12, second round) — pure decision
// function for what Register.tsx should do in response to the CURRENT
// authStore state. Extracted specifically so this decision is
// unit-testable without React/Firebase side effects (no jsdom/RTL in this
// repo — see docs/remediation/reports/SEC-004.md, "Известные ограничения").
//
// Closes the reload-recovery gap: previously Register.tsx only reacted to
// `status === 'setup_incomplete'` — a user who (1) got setup_incomplete
// after a transient Firestore read failure right after a successful
// `createCompany` commit, (2) reloaded the page, and (3) had
// onAuthStateChanged successfully load the canonical profile/company into
// `'ready'` was left stranded on the registration form instead of being
// sent home.
export type RegistrationRecoveryAction =
  | { type: 'navigate_home' }
  | { type: 'show_retry' }
  | { type: 'show_re_entry' }
  | { type: 'wait' }
  | { type: 'none' }

export function resolveRegistrationRecovery(params: {
  status: AuthDataStatus
  hasCanonicalUser: boolean
  hasCanonicalCompany: boolean
  hasResumablePending: boolean
}): RegistrationRecoveryAction {
  // Only a fully-loaded, valid canonical profile AND company justify
  // leaving the registration flow — `status === 'ready'` alone is not
  // enough to trust (defensive: matches the same "both must be present"
  // contract authStore.loadReadyStateAfterSetup() itself enforces).
  if (params.status === 'ready' && params.hasCanonicalUser && params.hasCanonicalCompany) {
    return { type: 'navigate_home' }
  }
  if (params.status === 'setup_incomplete') {
    return params.hasResumablePending ? { type: 'show_retry' } : { type: 'show_re_entry' }
  }
  if (params.status === 'loading') return { type: 'wait' }
  // 'signed_out' and 'data_error' — never a false navigate to home, and
  // never silently reinterpreted as a resumable setup screen either.
  return { type: 'none' }
}
