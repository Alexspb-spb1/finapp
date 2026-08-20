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

// ── SEC-005 staging authorization (EXTERNAL_ACTION_APPROVED: SEC-005 /
// ENVIRONMENT: staging) — emulator/staging allowed for any mode. ─────────
describe('assertCycleExecutionAllowed — emulator/staging allowed for any mode', () => {
  it('does not throw for emulator, with or without a mode', () => {
    expect(() => assertCycleExecutionAllowed('emulator')).not.toThrow()
    expect(() => assertCycleExecutionAllowed('emulator', 'apply')).not.toThrow()
  })

  it('does not throw for staging, with or without a mode — explicitly authorized this cycle', () => {
    expect(() => assertCycleExecutionAllowed('staging')).not.toThrow()
    expect(() => assertCycleExecutionAllowed('staging', 'apply')).not.toThrow()
  })
})

// ── SEC-005 production authorization (PRODUCTION_PREFLIGHT_APPROVED:
// SEC-005 — "deploy maintenance protection, create+verify backup,
// read-only dry-run"; "Backfill/apply пока запрещён") — production is
// allowed ONLY for --mode dry-run, every other mode (and no mode at all)
// remains unconditionally refused. ─────────────────────────────────────
describe('assertCycleExecutionAllowed — production allowed ONLY for dry-run', () => {
  it('does NOT throw for production dry-run — the exact scope PRODUCTION_PREFLIGHT_APPROVED: SEC-005 grants', () => {
    expect(() => assertCycleExecutionAllowed('production', 'dry-run')).not.toThrow()
  })

  it('throws CycleExecutionError for production with no mode at all (e.g. scripts/ops/set-maintenance-mode.ts, which was not authorized this cycle)', () => {
    expect(() => assertCycleExecutionAllowed('production')).toThrow(CycleExecutionError)
  })

  it.each(['apply', 'verify', 'rollback-from-report', 'rollback-from-plan'] as const)(
    'throws CycleExecutionError for production %s — apply/backfill remains explicitly forbidden',
    mode => {
      expect(() => assertCycleExecutionAllowed('production', mode)).toThrow(CycleExecutionError)
    },
  )

  it('the production non-dry-run error message names PRODUCTION_ACTION_APPROVED, not the dry-run grant, as what is still missing', () => {
    try {
      assertCycleExecutionAllowed('production', 'apply')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CycleExecutionError)
      expect((err as Error).message).toMatch(/PRODUCTION_ACTION_APPROVED/)
    }
  })
})
