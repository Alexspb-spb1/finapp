// Runtime validation of an apply-report before rollback — SEC-005,
// independent audit fix #3 (1st round).
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
//
// Independent audit fix #1 (3rd round): the original version only checked
// that each `rollbackManifest` entry had SOME matching `createdPaths`
// record — it never checked the reverse direction. A report with two
// `createdPaths` entries but only one `rollbackManifest` entry passed
// validation and produced a rollback that silently deleted only ONE of the
// two documents it actually created, reporting success. Validation now
// requires EXACT pair-set equality between `rollbackManifest` and
// `createdPaths` (same size, same set of (companyId, uid) pairs), strict
// structural validation of every entry in BOTH arrays (not just the
// manifest), and an explicit empty-manifest special case (valid only when
// createdPaths is ALSO empty and the report's own `counts.created` is 0 —
// so a manifest that was truncated to empty by mistake/tampering can never
// masquerade as "nothing to roll back").
import { isKnownRole, relationKey, splitRelationKey, type Role } from './types.ts'
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
  const counts = report.counts
  const hasValidCreatedCount = counts !== null && typeof counts === 'object' && !Array.isArray(counts) &&
    typeof (counts as Record<string, unknown>).created === 'number'
  if (!hasValidCreatedCount) errors.push('counts.created must be a number')

  if (errors.length > 0) return { ok: false, entries: [], errors }

  const manifestRaw = report.rollbackManifest as unknown[]
  const createdPathsRaw = report.createdPaths as unknown[]
  const plannedCreatesRaw = report.plannedCreates as unknown[]
  const reportedCreatedCount = (report.counts as Record<string, unknown>).created as number

  // ── Validate every createdPaths entry (previously only referenced, never
  // independently validated) ────────────────────────────────────────────
  const createdPathsByKey = new Map<string, { createTimeIso: string; updateTimeIso: string }>()
  for (let i = 0; i < createdPathsRaw.length; i++) {
    const entry = createdPathsRaw[i]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`createdPaths[${i}] must be an object`); continue
    }
    const rec = entry as Record<string, unknown>
    if (!isNonEmptyString(rec.companyId) || !isNonEmptyString(rec.uid) || !isNonEmptyString(rec.path)) {
      errors.push(`createdPaths[${i}] missing companyId/uid/path`); continue
    }
    if (rec.path !== canonicalMembershipPath(rec.companyId, rec.uid)) {
      errors.push(`createdPaths[${i}] path is not canonical (expected companies/{companyId}/members/{uid})`); continue
    }
    if (!isNonEmptyString(rec.createTimeIso) || !isNonEmptyString(rec.updateTimeIso)) {
      errors.push(`createdPaths[${i}] missing create/update time metadata`); continue
    }
    const key = relationKey(rec.companyId, rec.uid)
    if (createdPathsByKey.has(key)) {
      errors.push(`createdPaths[${i}] duplicates an earlier (companyId, uid) pair`); continue
    }
    createdPathsByKey.set(key, { createTimeIso: rec.createTimeIso, updateTimeIso: rec.updateTimeIso })
  }

  // ── Index plannedCreates by pair; a pair appearing more than once is
  // ambiguous and must never be trusted as "exactly one" record ──────────
  const plannedByKey = new Map<string, { role: unknown; status: unknown } | null>()
  for (let i = 0; i < plannedCreatesRaw.length; i++) {
    const entry = plannedCreatesRaw[i]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`plannedCreates[${i}] must be an object`); continue
    }
    const rec = entry as Record<string, unknown>
    if (!isNonEmptyString(rec.companyId) || !isNonEmptyString(rec.uid)) {
      errors.push(`plannedCreates[${i}] missing companyId/uid`); continue
    }
    const key = relationKey(rec.companyId, rec.uid)
    if (plannedByKey.has(key)) {
      plannedByKey.set(key, null) // ambiguous — more than one record for this pair
    } else {
      plannedByKey.set(key, { role: rec.role, status: rec.status })
    }
  }

  if (errors.length > 0) return { ok: false, entries: [], errors }

  // ── Validate every rollbackManifest entry structurally ──────────────────
  const manifestKeys = new Set<string>()
  const orderedManifestKeys: string[] = []
  for (let i = 0; i < manifestRaw.length; i++) {
    const entry = manifestRaw[i]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`rollbackManifest[${i}] must be an object`); continue
    }
    const rec = entry as Record<string, unknown>
    if (!isNonEmptyString(rec.companyId) || !isNonEmptyString(rec.uid) || !isNonEmptyString(rec.path)) {
      errors.push(`rollbackManifest[${i}] missing companyId/uid/path`); continue
    }
    if (rec.path !== canonicalMembershipPath(rec.companyId, rec.uid)) {
      errors.push(`rollbackManifest[${i}] path is not canonical (expected companies/{companyId}/members/{uid})`); continue
    }
    const key = relationKey(rec.companyId, rec.uid)
    if (manifestKeys.has(key)) {
      errors.push(`rollbackManifest[${i}] duplicates an earlier (companyId, uid) pair`); continue
    }
    manifestKeys.add(key)
    orderedManifestKeys.push(key)
  }

  if (errors.length > 0) return { ok: false, entries: [], errors }

  // ── Empty-manifest special case: only legitimate when NOTHING was ever
  // created, cross-checked against BOTH createdPaths and the report's own
  // counts.created — a manifest truncated to empty (by hand-editing or
  // corruption) while createdPaths/counts still show real creates must be
  // refused, not silently treated as "nothing to roll back". ─────────────
  if (manifestKeys.size === 0) {
    if (createdPathsByKey.size !== 0 || reportedCreatedCount !== 0) {
      return {
        ok: false, entries: [],
        errors: ['rollbackManifest is empty but createdPaths and/or counts.created indicate documents were actually created — refusing an incomplete rollback'],
      }
    }
    return { ok: true, entries: [], errors: [] }
  }

  // ── Exact pair-set equality between rollbackManifest and createdPaths ──
  // (2nd round finding: previously only manifest -> createdPaths was
  // checked; a createdPaths entry with no corresponding manifest entry —
  // i.e. a document that was created but silently dropped from the
  // manifest — went completely undetected.)
  if (manifestKeys.size !== createdPathsByKey.size) {
    return {
      ok: false, entries: [],
      errors: [`rollbackManifest has ${manifestKeys.size} entr${manifestKeys.size === 1 ? 'y' : 'ies'} but createdPaths has ${createdPathsByKey.size} — every created document must have exactly one manifest entry and vice versa`],
    }
  }
  for (const key of manifestKeys) {
    if (!createdPathsByKey.has(key)) {
      const [companyId, uid] = splitRelationKey(key)
      errors.push(`rollbackManifest entry (companyId=${companyId}, uid=${uid}) has no matching createdPaths entry`)
    }
  }
  if (errors.length > 0) return { ok: false, entries: [], errors }

  // ── Build validated entries — every pair must match exactly one valid
  // plannedCreates record ─────────────────────────────────────────────────
  const entries: ValidatedRollbackEntry[] = []
  for (const key of orderedManifestKeys) {
    const [companyId, uid] = splitRelationKey(key)
    const createdRecord = createdPathsByKey.get(key)!
    const plannedRecord = plannedByKey.get(key)
    if (!plannedRecord || !isKnownRole(plannedRecord.role) || plannedRecord.status !== 'active') {
      errors.push(`(companyId=${companyId}, uid=${uid}) has no matching plannedCreates entry with a valid, unambiguous expected role/status`)
      continue
    }
    entries.push({
      companyId, uid, path: canonicalMembershipPath(companyId, uid),
      expectedRole: plannedRecord.role, expectedStatus: 'active',
      createTimeIso: createdRecord.createTimeIso, updateTimeIso: createdRecord.updateTimeIso,
    })
  }

  if (errors.length > 0) return { ok: false, entries: [], errors }
  return { ok: true, entries, errors: [] }
}
