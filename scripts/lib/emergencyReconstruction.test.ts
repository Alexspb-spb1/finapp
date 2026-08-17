// Final-round fix #1 (third pass): rollback-from-plan must perform the
// --expected-plan-sha256 integrity check and structural validation BEFORE
// assertMaintenanceModeActive() (a real Firestore read) or any
// per-candidate Firestore read/delete. This is proven directly here with
// a fake Firestore that COUNTS every `.get()`/`.delete()` call — a wrong
// hash (even in a production-shaped flow, with a fully valid, realistic
// dry-run report) must produce exactly zero of either.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Timestamp } from 'firebase-admin/firestore'
import type { Firestore } from 'firebase-admin/firestore'
import { runEmergencyReconstruction } from './emergencyReconstruction.ts'
import { sha256Hex } from './checksum.ts'
import { REPORT_SCHEMA_VERSION } from './report.ts'

const PROJECT_ID = 'finapp-prod-10a83'
const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)
const HEX64_C = 'c'.repeat(64)

function tempFile(name: string, content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sec005-emergency-recon-'))
  const path = join(dir, name)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

/** A read-counting, write-counting fake Firestore covering exactly the
 * two paths this module touches: `system/maintenance` (via
 * assertMaintenanceModeActive) and `companies/{companyId}/members/{uid}`
 * (the per-candidate reconstruction loop). */
function makeCountingDb(opts: {
  maintenanceDoc?: Record<string, unknown>
  membershipDocs?: Map<string, Record<string, unknown>>
}): { db: Firestore; getCount: () => number; deleteCount: () => number } {
  let getCount = 0
  let deleteCount = 0
  const db = {
    collection(name: string) {
      if (name === 'system') {
        return {
          doc(_id: string) {
            return {
              async get() {
                getCount++
                const data = opts.maintenanceDoc
                return { exists: data !== undefined, data: () => data }
              },
            }
          },
        }
      }
      if (name === 'companies') {
        return {
          doc(companyId: string) {
            return {
              collection(sub: string) {
                if (sub !== 'members') throw new Error(`unexpected subcollection: ${sub}`)
                return {
                  doc(uid: string) {
                    const key = JSON.stringify([companyId, uid])
                    return {
                      async get() {
                        getCount++
                        const data = opts.membershipDocs?.get(key)
                        return {
                          exists: data !== undefined,
                          data: () => data,
                          updateTime: Timestamp.now(),
                        }
                      },
                      async delete() {
                        deleteCount++
                      },
                      path: `companies/${companyId}/members/${uid}`,
                    }
                  },
                }
              },
            }
          },
        }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
  }
  return { db: db as unknown as Firestore, getCount: () => getCount, deleteCount: () => deleteCount }
}

const validDryRun = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  mode: 'dry-run',
  environment: 'production',
  projectId: PROJECT_ID,
  sourceGitSha: 'abc123def',
  sourceChecksum: HEX64_A,
  decisionsChecksum: HEX64_B,
  targetChecksum: HEX64_C,
  counts: { unresolved: 0 },
  plannedCreates: [{ companyId: 'co1', uid: 'u1', role: 'admin', status: 'active' }],
}

describe('runEmergencyReconstruction — operation order (final-round fix #1, third pass)', () => {
  it('a WRONG --expected-plan-sha256 in a production-shaped flow produces ZERO Firestore reads and ZERO deletes', async () => {
    const path = tempFile('dry-run.json', validDryRun)
    const { db, getCount, deleteCount } = makeCountingDb({ maintenanceDoc: { enabled: true, enabledAt: Timestamp.now() } })

    const result = await runEmergencyReconstruction({
      db, fromPlanPath: path, environment: 'production', projectId: PROJECT_ID,
      expectedPlanSha256: '0'.repeat(64), // deliberately wrong
      ackMaintenance: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(3)
    expect(getCount()).toBe(0)
    expect(deleteCount()).toBe(0)
  })

  it('a MISSING --expected-plan-sha256 also produces zero reads/deletes', async () => {
    const path = tempFile('dry-run.json', validDryRun)
    const { db, getCount, deleteCount } = makeCountingDb({ maintenanceDoc: { enabled: true, enabledAt: Timestamp.now() } })

    const result = await runEmergencyReconstruction({
      db, fromPlanPath: path, environment: 'production', projectId: PROJECT_ID,
      expectedPlanSha256: undefined,
      ackMaintenance: true,
    })

    expect(result.ok).toBe(false)
    expect(getCount()).toBe(0)
    expect(deleteCount()).toBe(0)
  })

  it('a CORRECT hash but structurally INVALID plan (wrong environment) is also refused with zero reads/deletes — validated BEFORE maintenance check', async () => {
    const badReport = { ...validDryRun, environment: 'staging' }
    const raw = JSON.stringify(badReport)
    const path = tempFile('dry-run.json', badReport)
    const { db, getCount, deleteCount } = makeCountingDb({ maintenanceDoc: { enabled: true, enabledAt: Timestamp.now() } })

    const result = await runEmergencyReconstruction({
      db, fromPlanPath: path, environment: 'production', projectId: PROJECT_ID,
      expectedPlanSha256: sha256Hex(raw),
      ackMaintenance: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(2)
    expect(getCount()).toBe(0)
    expect(deleteCount()).toBe(0)
  })

  it('a correct hash + valid structure, but missing --ack-maintenance-readonly for production, is refused with zero reads/deletes (before the maintenance READ, not just before the write)', async () => {
    const raw = JSON.stringify(validDryRun)
    const path = tempFile('dry-run.json', validDryRun)
    const { db, getCount, deleteCount } = makeCountingDb({ maintenanceDoc: { enabled: true, enabledAt: Timestamp.now() } })

    const result = await runEmergencyReconstruction({
      db, fromPlanPath: path, environment: 'production', projectId: PROJECT_ID,
      expectedPlanSha256: sha256Hex(raw),
      ackMaintenance: false,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(3)
    expect(getCount()).toBe(0) // assertMaintenanceModeActive() never even called
    expect(deleteCount()).toBe(0)
  })

  it('a correct hash + valid structure + production + ack given, but maintenance mode NOT active: exactly ONE read (the maintenance check), zero candidate reads/deletes', async () => {
    const raw = JSON.stringify(validDryRun)
    const path = tempFile('dry-run.json', validDryRun)
    const { db, getCount, deleteCount } = makeCountingDb({ maintenanceDoc: { enabled: false } })

    const result = await runEmergencyReconstruction({
      db, fromPlanPath: path, environment: 'production', projectId: PROJECT_ID,
      expectedPlanSha256: sha256Hex(raw),
      ackMaintenance: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(3)
    // The ONE read that DID happen is the maintenance check itself —
    // proves the order (hash+structure validated first, THEN exactly
    // this one real Firestore read), not that reads never happen at all.
    expect(getCount()).toBe(1)
    expect(deleteCount()).toBe(0)
  })

  it('happy path: correct hash + valid structure + emulator (no maintenance check) + exactly matching live document → deletes it', async () => {
    const raw = JSON.stringify({ ...validDryRun, environment: 'emulator', projectId: 'demo-finapp' })
    const path = tempFile('dry-run.json', { ...validDryRun, environment: 'emulator', projectId: 'demo-finapp' })
    const membershipDocs = new Map([
      [JSON.stringify(['co1', 'u1']), { uid: 'u1', role: 'admin', status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() }],
    ])
    const { db, getCount, deleteCount } = makeCountingDb({ membershipDocs })

    const result = await runEmergencyReconstruction({
      db, fromPlanPath: path, environment: 'emulator', projectId: 'demo-finapp',
      expectedPlanSha256: sha256Hex(raw),
      ackMaintenance: false,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.outcome.removed).toEqual([{ companyId: 'co1', uid: 'u1', path: 'companies/co1/members/u1' }])
      expect(result.outcome.refused).toHaveLength(0)
    }
    expect(getCount()).toBeGreaterThan(0) // no maintenance check for emulator — only the candidate read
    expect(deleteCount()).toBe(1)
  })

  it('a nonexistent --from-plan path is refused with zero reads/deletes', async () => {
    const { db, getCount, deleteCount } = makeCountingDb({ maintenanceDoc: { enabled: true, enabledAt: Timestamp.now() } })

    const result = await runEmergencyReconstruction({
      db, fromPlanPath: '/nonexistent/dry-run.json', environment: 'production', projectId: PROJECT_ID,
      expectedPlanSha256: HEX64_A,
      ackMaintenance: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(2)
    expect(getCount()).toBe(0)
    expect(deleteCount()).toBe(0)
  })
})
