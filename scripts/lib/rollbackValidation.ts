// Runtime validation of an apply-report before rollback — SEC-005,
// independent audit fix #3.
//
// A rollback source report is untrusted input (a file on disk that could
// have been hand-edited, come from a different environment/project, or be
// stale/corrupted) — this module validates it BEFORE any Firestore read or
// delete is attempted. Any structural problem (wrong schemaVersion, wrong
// mode, environment/project mismatch, duplicate or non-canonical manifest
// paths, a manifest entry with no matching createdPaths/plannedCreates
// record) rejects the ENTIRE rollback with zero deletions — never a
// partial best-effort interpretation of a report that cannot be trusted at
// all. (Partial rollback — some documents removed, some refused — is only
// ever a property of live Firestore state at delete time, handled
// separately in backfill-memberships.ts.)
import { isKnownRole, relationKey, type Role } from './types.ts'
import type { Environment } from './firebaseAdmin.ts'
import { REPORT_SCHEMA_VERSION } from './report.ts'

export interface ValidatedRollbackEntry {
  companyId: string
  uid: string
  path: string
  expectedRole: Role
  expectedStatus: 'active'
  createTimeIso: string
  updateTimeIso: string
}

export interface RollbackValidationResult {
  ok: boolean
  entries: ValidatedRollbackEntry[]
  errors: string[]
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function canonicalMembershipPath(companyId: string, uid: string): string {
  return `companies/${companyId}/members/${uid}`
}

export function validateSourceReportForRollback(
  raw: unknown,
  expected: { environment: Environment; projectId: string },
): RollbackValidationResult {
  const errors: string[] = []

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, entries: [], errors: ['source report must be a JSON object'] }
  }
  const report = raw as Record<string, unknown>

  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${REPORT_SCHEMA_VERSION}`)
  }
  if (report.mode !== 'apply') {
    errors.push(`mode must be "apply" (a rollback can only roll back an apply run) — got ${JSON.stringify(report.mode)}`)
  }
  if (report.environment !== expected.environment) {
    errors.push('environment does not match the current --environment')
  }
  if (report.projectId !== expected.projectId) {
    errors.push('projectId does not match the current --project')
  }
  if (!Array.isArray(report.rollbackManifest)) errors.push('rollbackManifest must be an array')
  if (!Array.isArray(report.createdPaths)) errors.push('createdPaths must be an array')
  if (!Array.isArray(report.plannedCreates)) errors.push('plannedCreates must be an array')

  if (errors.length > 0) return { ok: false, entries: [], errors }

  const manifest = report.rollbackManifest as unknown[]
  const createdPaths = report.createdPaths as unknown[]
  const plannedCreates = report.plannedCreates as unknown[]

  const seenPairs = new Set<string>()
  const entries: ValidatedRollbackEntry[] = []

  for (let i = 0; i < manifest.length; i++) {
    const entry = manifest[i]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`rollbackManifest[${i}] must be an object`); continue
    }
    const rec = entry as Record<string, unknown>
    if (!isNonEmptyString(rec.companyId) || !isNonEmptyString(rec.uid) || !isNonEmptyString(rec.path)) {
      errors.push(`rollbackManifest[${i}] missing companyId/uid/path`); continue
    }
    const canonicalPath = canonicalMembershipPath(rec.companyId, rec.uid)
    if (rec.path !== canonicalPath) {
      errors.push(`rollbackManifest[${i}] path is not canonical (expected companies/{companyId}/members/{uid})`); continue
    }
    const pairKey = relationKey(rec.companyId, rec.uid)
    if (seenPairs.has(pairKey)) {
      errors.push(`rollbackManifest[${i}] duplicates an earlier (companyId, uid) pair`); continue
    }
    seenPairs.add(pairKey)

    const createdRecord = createdPaths.find(c =>
      c !== null && typeof c === 'object' && !Array.isArray(c) &&
      (c as Record<string, unknown>).companyId === rec.companyId &&
      (c as Record<string, unknown>).uid === rec.uid,
    ) as Record<string, unknown> | undefined
    if (!createdRecord || !isNonEmptyString(createdRecord.createTimeIso) || !isNonEmptyString(createdRecord.updateTimeIso)) {
      errors.push(`rollbackManifest[${i}] has no matching createdPaths entry with create/update time metadata`); continue
    }

    const plannedRecord = plannedCreates.find(p =>
      p !== null && typeof p === 'object' && !Array.isArray(p) &&
      (p as Record<string, unknown>).companyId === rec.companyId &&
      (p as Record<string, unknown>).uid === rec.uid,
    ) as Record<string, unknown> | undefined
    if (!plannedRecord || !isKnownRole(plannedRecord.role) || plannedRecord.status !== 'active') {
      errors.push(`rollbackManifest[${i}] has no matching plannedCreates entry with a valid expected role/status`); continue
    }

    entries.push({
      companyId: rec.companyId,
      uid: rec.uid,
      path: rec.path,
      expectedRole: plannedRecord.role,
      expectedStatus: 'active',
      createTimeIso: createdRecord.createTimeIso,
      updateTimeIso: createdRecord.updateTimeIso,
    })
  }

  if (errors.length > 0) return { ok: false, entries: [], errors }
  return { ok: true, entries, errors: [] }
}
