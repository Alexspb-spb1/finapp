import { describe, it, expect } from 'vitest'
import { assertEnvironmentGuard, EnvironmentGuardError } from './firebaseAdmin.ts'

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
