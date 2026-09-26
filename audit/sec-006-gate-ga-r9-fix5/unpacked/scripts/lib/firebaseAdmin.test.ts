import { describe, it, expect } from 'vitest'
import { assertEnvironmentGuard, assertCycleExecutionAllowed, EnvironmentGuardError, CycleExecutionError } from './firebaseAdmin.ts'

describe('assertEnvironmentGuard — production is never the default', () => {
  it('throws when --project is not provided at all', () => {
    expect(() => assertEnvironmentGuard({
      environment: 'production', cliProjectId: undefined, envProjectId: undefined,
      firestoreEmulatorHost: undefined, confirmProjectId: undefined,
    })).toThrow(EnvironmentGuardError)
  })
})

describe('assertEnvironmentGuard — emulator', () => {
  it('requires FIRESTORE_EMULATOR_HOST', () => {
    expect(() => assertEnvironmentGuard({
      environment: 'emulator', cliProjectId: 'demo-finapp', envProjectId: undefined,
      firestoreEmulatorHost: undefined, confirmProjectId: undefined,
    })).toThrow(/FIRESTORE_EMULATOR_HOST/)
  })

  it('requires the project id to be exactly demo-finapp', () => {
    expect(() => assertEnvironmentGuard({
      environment: 'emulator', cliProjectId: 'some-other-project', envProjectId: undefined,
      firestoreEmulatorHost: '127.0.0.1:8080', confirmProjectId: undefined,
    })).toThrow(EnvironmentGuardError)
  })

  it('passes with the correct project id and emulator host set', () => {
    expect(assertEnvironmentGuard({
      environment: 'emulator', cliProjectId: 'demo-finapp', envProjectId: undefined,
      firestoreEmulatorHost: '127.0.0.1:8080', confirmProjectId: undefined,
    })).toBe('demo-finapp')
  })
})

describe('assertEnvironmentGuard — staging', () => {
  it('requires an exact --confirm-project match', () => {
    expect(() => assertEnvironmentGuard({
      environment: 'staging', cliProjectId: 'finapp-staging', envProjectId: undefined,
      firestoreEmulatorHost: undefined, confirmProjectId: 'finapp-stagng',
    })).toThrow(EnvironmentGuardError)
  })

  it('refuses if FIRESTORE_EMULATOR_HOST is set (ambiguous configuration)', () => {
    expect(() => assertEnvironmentGuard({
      environment: 'staging', cliProjectId: 'finapp-staging', envProjectId: undefined,
      firestoreEmulatorHost: '127.0.0.1:8080', confirmProjectId: 'finapp-staging',
    })).toThrow(EnvironmentGuardError)
  })

  it('passes with a correct exact confirmation', () => {
    expect(assertEnvironmentGuard({
      environment: 'staging', cliProjectId: 'finapp-staging', envProjectId: undefined,
      firestoreEmulatorHost: undefined, confirmProjectId: 'finapp-staging',
    })).toBe('finapp-staging')
  })
})

describe('assertEnvironmentGuard — production', () => {
  it('requires the exact production project id', () => {
    expect(() => assertEnvironmentGuard({
      environment: 'production', cliProjectId: 'finapp-prod', envProjectId: undefined,
      firestoreEmulatorHost: undefined, confirmProjectId: 'finapp-prod',
    })).toThrow(EnvironmentGuardError)
  })

  it('passes with the correct project id and confirmation', () => {
    expect(assertEnvironmentGuard({
      environment: 'production', cliProjectId: 'finapp-prod-10a83', envProjectId: undefined,
      firestoreEmulatorHost: undefined, confirmProjectId: 'finapp-prod-10a83',
    })).toBe('finapp-prod-10a83')
  })
})

describe('assertEnvironmentGuard — source conflicts are rejected before any I/O', () => {
  it('rejects a CLI/env project ID mismatch', () => {
    expect(() => assertEnvironmentGuard({
      environment: 'emulator', cliProjectId: 'demo-finapp', envProjectId: 'some-other-project',
      firestoreEmulatorHost: '127.0.0.1:8080', confirmProjectId: undefined,
    })).toThrow(EnvironmentGuardError)
  })
})

const ALL_ACTIONS = ['dry-run', 'apply', 'verify', 'rollback-from-report', 'rollback-from-plan', 'maintenance-enable', 'maintenance-disable'] as const

// ── SEC-005 staging authorization (EXTERNAL_ACTION_APPROVED: SEC-005 /
// ENVIRONMENT: staging) — emulator/staging allowed for any known action. ──
describe('assertCycleExecutionAllowed — emulator/staging allowed for any known action', () => {
  it.each(ALL_ACTIONS)('does not throw for emulator %s', action => {
    expect(() => assertCycleExecutionAllowed('emulator', action)).not.toThrow()
  })

  it.each(ALL_ACTIONS)('does not throw for staging %s — explicitly authorized this cycle', action => {
    expect(() => assertCycleExecutionAllowed('staging', action)).not.toThrow()
  })
})

// ── SEC-005 production authorization (PRODUCTION_ACTION_APPROVED:
// SEC-005 — production execution gate round: a controlled production
// cycle covering maintenance enable/disable, create-only apply against a
// verified resolved plan, verify, and rollback-from-report/
// rollback-from-plan as the emergency path). This supersedes the earlier,
// narrower PRODUCTION_PREFLIGHT_APPROVED: SEC-005 (dry-run only). ───────
describe('assertCycleExecutionAllowed — production allowed for the full SEC-005 action set', () => {
  it.each(ALL_ACTIONS)('does NOT throw for production %s — the exact scope PRODUCTION_ACTION_APPROVED: SEC-005 grants', action => {
    expect(() => assertCycleExecutionAllowed('production', action)).not.toThrow()
  })
})

// ── Independent audit fixes, production execution gate round, item 1:
// `action` is required and fully typed — no `undefined`-means-refused
// shortcut exists any more; an unknown/garbage value that somehow
// bypasses the type checker is refused fail-closed, for every
// environment, not just production. ─────────────────────────────────────
describe('assertCycleExecutionAllowed — unknown action is refused fail-closed, for every environment', () => {
  it.each(['emulator', 'staging', 'production'] as const)('throws CycleExecutionError for %s with an unrecognized action string', environment => {
    expect(() => assertCycleExecutionAllowed(environment, 'totally-unknown-action' as never)).toThrow(CycleExecutionError)
  })

  it('the unknown-action error message says so explicitly, not a generic "not authorized"', () => {
    try {
      assertCycleExecutionAllowed('emulator', 'totally-unknown-action' as never)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CycleExecutionError)
      expect((err as Error).message).toMatch(/unknown action/)
    }
  })
})
