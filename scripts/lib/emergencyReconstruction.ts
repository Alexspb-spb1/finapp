// Emergency reconstruction (--mode rollback-from-plan) — SEC-005 final
// round, third pass, item 1.
//
// Extracted from scripts/backfill-memberships.ts into its own testable
// module for exactly one reason: backfill-memberships.ts cannot be
// `import`ed by a unit test (its module-level `main().then(...)` call
// would execute the whole CLI as a side effect of loading the file), so
// the SAFETY-CRITICAL ORDER of operations here — integrity check →
// structural validation → maintenance-mode check → Firestore reads/
// deletes — could previously only be proven by spawning the real CLI
// against a real Firestore Emulator. That still happens (see
// backfill-memberships.emulator.test.ts), but this module additionally
// lets a fast, no-emulator unit test inject a Firestore stub that COUNTS
// `.get()`/`.delete()` calls and assert they are exactly zero when the
// integrity check fails — see emergencyReconstruction.test.ts.
import { readFileSync } from 'node:fs'
import type { Firestore } from 'firebase-admin/firestore'
import { sha256Hex } from './checksum.ts'
import {
  validateStrictDryRunReportContent, assertMaintenanceModeActive, ProductionSafetyError,
  type MaintenanceModeStatus,
} from './productionSafety.ts'
import { isStrictlyValidActiveMembership } from './membershipValidation.ts'
import type { Environment } from './firebaseAdmin.ts'
import type { EmergencyReconstructionRefusal } from './report.ts'

export interface EmergencyReconstructionParams {
  db: Firestore
  fromPlanPath: string
  environment: Environment
  projectId: string
  expectedPlanSha256: string | undefined
  ackMaintenance: boolean
}

export interface EmergencyReconstructionOutcome {
  removed: { companyId: string; uid: string; path: string }[]
  skippedNotFound: { companyId: string; uid: string }[]
  refused: EmergencyReconstructionRefusal[]
  sourceDryRunSha256: string
  targetChecksum: string
  maintenanceMode: MaintenanceModeStatus | null
}

export type EmergencyReconstructionResult =
  | { ok: true; outcome: EmergencyReconstructionOutcome }
  | { ok: false; errorMessage: string; exitCode: number }

/**
 * Runs the full rollback-from-plan sequence in the SAFETY-CRITICAL ORDER
 * (final-round fix #1, third pass): reads `--from-plan`, verifies its
 * SHA-256 against `--expected-plan-sha256`, and structurally validates its
 * content — ALL of this BEFORE `assertMaintenanceModeActive()` (a real
 * Firestore read) or the per-candidate reconstruction loop (more
 * Firestore reads/deletes) ever run. A wrong/missing hash, or invalid
 * structure, therefore produces ZERO Firestore reads and ZERO deletes.
 *
 * Previously (second-round fix #1) the maintenance-mode check ran FIRST —
 * meaning a production call with a tampered/wrong `--from-plan` would
 * still perform one real Firestore read (`assertMaintenanceModeActive`)
 * before the integrity check ever got a chance to refuse. That ordering
 * is corrected here.
 */
export async function runEmergencyReconstruction(params: EmergencyReconstructionParams): Promise<EmergencyReconstructionResult> {
  const { db, fromPlanPath, environment, projectId, expectedPlanSha256, ackMaintenance } = params

  let fromPlanRaw: string
  try {
    fromPlanRaw = readFileSync(fromPlanPath, 'utf8')
  } catch {
    return { ok: false, errorMessage: '--from-plan could not be read.', exitCode: 2 }
  }

  const actualPlanSha256 = sha256Hex(fromPlanRaw)
  if (actualPlanSha256 !== expectedPlanSha256) {
    return {
      ok: false,
      errorMessage: `--from-plan content does not match --expected-plan-sha256 (expected ${expectedPlanSha256}, got ${actualPlanSha256}) — the plan may have been tampered with, corrupted, or is the wrong file.`,
      exitCode: 3,
    }
  }

  let strictContent
  try {
    strictContent = validateStrictDryRunReportContent(fromPlanRaw, projectId, environment)
  } catch (err) {
    if (err instanceof ProductionSafetyError) return { ok: false, errorMessage: `--from-plan ${err.message}`, exitCode: 2 }
    throw err
  }

  // Same production-safety requirement as rollback-from-report — this is
  // still a production write. --ack-emergency-reconstruction (validated by
  // the CLI's own parseCliArgs() for this mode) is a SEPARATE, additional
  // acknowledgement from --ack-maintenance-readonly: the operator must
  // explicitly accept that this is the degraded, weaker-evidence recovery
  // path, not the normal one. This is the FIRST real Firestore read in
  // this whole function — deliberately after both checks above.
  let maintenanceMode: MaintenanceModeStatus | null = null
  if (environment === 'production') {
    if (!ackMaintenance) {
      return { ok: false, errorMessage: '--ack-maintenance-readonly is required for a production emergency reconstruction.', exitCode: 3 }
    }
    try {
      maintenanceMode = await assertMaintenanceModeActive(db)
    } catch (err) {
      if (err instanceof ProductionSafetyError) return { ok: false, errorMessage: err.message, exitCode: 3 }
      throw err
    }
  }

  const removed: { companyId: string; uid: string; path: string }[] = []
  const skippedNotFound: { companyId: string; uid: string }[] = []
  const refused: EmergencyReconstructionRefusal[] = []

  for (const candidate of strictContent.plannedCreates) {
    const ref = db.collection('companies').doc(candidate.companyId).collection('members').doc(candidate.uid)
    const snap = await ref.get()
    if (!snap.exists) { skippedNotFound.push({ companyId: candidate.companyId, uid: candidate.uid }); continue }
    const data = snap.data()!
    if (data.uid !== candidate.uid || data.role !== candidate.role || data.status !== candidate.status) {
      refused.push({ companyId: candidate.companyId, uid: candidate.uid, reason: 'live document does not exactly match the planned candidate (uid/role/status) — refusing to guess' })
      continue
    }
    if (!isStrictlyValidActiveMembership(candidate.uid, data as Record<string, unknown>)) {
      refused.push({ companyId: candidate.companyId, uid: candidate.uid, reason: 'live document does not pass strict membership schema validation' })
      continue
    }
    try {
      await ref.delete({ lastUpdateTime: snap.updateTime! })
      removed.push({ companyId: candidate.companyId, uid: candidate.uid, path: ref.path })
    } catch {
      refused.push({ companyId: candidate.companyId, uid: candidate.uid, reason: 'concurrent modification detected at delete time' })
    }
  }

  return {
    ok: true,
    outcome: {
      removed, skippedNotFound, refused,
      sourceDryRunSha256: actualPlanSha256,
      targetChecksum: strictContent.targetChecksum,
      maintenanceMode,
    },
  }
}
