// Independent audit fix (SEC-004 PR #12, second round) — pure logic tests,
// no React/Firebase imports, no jsdom/RTL needed.
import { describe, it, expect } from 'vitest'
import { resolveRegistrationRecovery } from './registrationRecovery'

describe('resolveRegistrationRecovery', () => {
  it('loading -> wait (no navigate, no step change)', () => {
    expect(resolveRegistrationRecovery({
      status: 'loading', hasCanonicalUser: false, hasCanonicalCompany: false, hasResumablePending: false,
    })).toEqual({ type: 'wait' })
  })

  it('setup_incomplete WITH a resumable pending record -> show_retry', () => {
    expect(resolveRegistrationRecovery({
      status: 'setup_incomplete', hasCanonicalUser: false, hasCanonicalCompany: false, hasResumablePending: true,
    })).toEqual({ type: 'show_retry' })
  })

  it('setup_incomplete WITHOUT a resumable pending record -> show_re_entry', () => {
    expect(resolveRegistrationRecovery({
      status: 'setup_incomplete', hasCanonicalUser: false, hasCanonicalCompany: false, hasResumablePending: false,
    })).toEqual({ type: 'show_re_entry' })
  })

  it('ready with a valid canonical user AND company -> navigate_home (this is the reload-recovery fix)', () => {
    expect(resolveRegistrationRecovery({
      status: 'ready', hasCanonicalUser: true, hasCanonicalCompany: true, hasResumablePending: false,
    })).toEqual({ type: 'navigate_home' })
  })

  it('data_error -> never navigates home', () => {
    const result = resolveRegistrationRecovery({
      status: 'data_error', hasCanonicalUser: false, hasCanonicalCompany: false, hasResumablePending: false,
    })
    expect(result.type).not.toBe('navigate_home')
    expect(result).toEqual({ type: 'none' })
  })

  it('signed_out -> never navigates home', () => {
    const result = resolveRegistrationRecovery({
      status: 'signed_out', hasCanonicalUser: false, hasCanonicalCompany: false, hasResumablePending: false,
    })
    expect(result.type).not.toBe('navigate_home')
    expect(result).toEqual({ type: 'none' })
  })

  it('defensive: status ready but missing canonical company is never treated as navigate_home', () => {
    const result = resolveRegistrationRecovery({
      status: 'ready', hasCanonicalUser: true, hasCanonicalCompany: false, hasResumablePending: false,
    })
    expect(result.type).not.toBe('navigate_home')
  })

  it('defensive: status ready but missing canonical user is never treated as navigate_home', () => {
    const result = resolveRegistrationRecovery({
      status: 'ready', hasCanonicalUser: false, hasCanonicalCompany: true, hasResumablePending: false,
    })
    expect(result.type).not.toBe('navigate_home')
  })
})
