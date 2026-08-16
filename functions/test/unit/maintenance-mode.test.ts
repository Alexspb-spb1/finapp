// requireNotInMaintenanceMode — SEC-005 production preflight.
//
// Uses a hand-built fake Firestore (same pattern as
// authz-firestore-errors.test.ts) since Firestore Rules never apply to
// this Admin SDK check — it needs its own direct unit coverage, separate
// from tests/rules/firestore.rules.test.ts's client-write coverage.
import { describe, it, expect, vi } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'
import { requireNotInMaintenanceMode } from '../../src/lib/authz'
import { AppError } from '../../src/lib/errors'

function fakeMaintenanceDb(doc: Record<string, unknown> | undefined): Firestore {
  const docRef = { get: vi.fn().mockResolvedValue({ exists: doc !== undefined, data: () => doc }) }
  const collectionRef = { doc: vi.fn().mockReturnValue(docRef) }
  return { collection: vi.fn().mockReturnValue(collectionRef) } as unknown as Firestore
}

function fakeMaintenanceDbThatThrows(): Firestore {
  const docRef = { get: vi.fn().mockRejectedValue(new Error('simulated Firestore outage')) }
  const collectionRef = { doc: vi.fn().mockReturnValue(docRef) }
  return { collection: vi.fn().mockReturnValue(collectionRef) } as unknown as Firestore
}

describe('requireNotInMaintenanceMode', () => {
  it('resolves (does not throw) when system/maintenance does not exist', async () => {
    await expect(requireNotInMaintenanceMode(fakeMaintenanceDb(undefined))).resolves.toBeUndefined()
  })

  it('resolves when enabled is false', async () => {
    await expect(requireNotInMaintenanceMode(fakeMaintenanceDb({ enabled: false }))).resolves.toBeUndefined()
  })

  it('throws maintenance_mode when enabled === true', async () => {
    await expect(requireNotInMaintenanceMode(fakeMaintenanceDb({ enabled: true }))).rejects.toEqual(
      expect.objectContaining({ appCode: 'maintenance_mode' }),
    )
  })

  it('is fail-closed: a Firestore read error is treated the same as enabled === true, never as "maintenance is off"', async () => {
    await expect(requireNotInMaintenanceMode(fakeMaintenanceDbThatThrows())).rejects.toEqual(
      expect.objectContaining({ appCode: 'maintenance_mode' }),
    )
  })

  it('never logs anything from the underlying Firestore error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(requireNotInMaintenanceMode(fakeMaintenanceDbThatThrows())).rejects.toBeInstanceOf(AppError)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore(); warnSpy.mockRestore()
  })
})
