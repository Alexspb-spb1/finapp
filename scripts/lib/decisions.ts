// Manual conflict-resolution decisions file — SEC-005.
//
// Loaded from an external path OUTSIDE the repository (--decisions-file).
// This module only validates/normalizes; reading the file and hashing its
// content happens in the CLI entry point.
import {
  isKnownRole, relationKey, COMPATIBLE_RESOLUTIONS,
  type Decision, type DecisionResolution, type FindingType,
} from './types.ts'

const KNOWN_RESOLUTIONS: readonly DecisionResolution[] = ['confirm_role', 'accept_existing', 'exclude']
const KNOWN_FINDING_TYPES = new Set<FindingType>(Object.keys(COMPATIBLE_RESOLUTIONS) as FindingType[])
/** Finding types with NO `companyId` (keyed by uid alone) — every other
 * known finding type requires `companyId`. Independent audit fixes, 4th
 * round, item 3.1. `malformed_owner_id` is deliberately absent from BOTH
 * sets: it is company-scoped but never decision-resolvable at all (its
 * `COMPATIBLE_RESOLUTIONS` entry is empty), so any decision naming it is
 * rejected by the compatibility check below regardless of companyId. */
const USER_LEVEL_FINDING_TYPES = new Set<FindingType>(['no_usable_relations', 'malformed_companies_entry', 'companies_field_not_array', 'malformed_company_id'])
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

export interface DecisionsValidationError {
  index: number
  message: string
}

export interface DecisionsValidationResult {
  ok: boolean
  decisions: Decision[]
  errors: DecisionsValidationError[]
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** Validates the raw parsed JSON of a decisions file. Rejects (does not
 * silently drop) unknown fields, unknown roles/resolutions, missing
 * required fields, and duplicate/contradictory decisions for the same
 * (companyId, uid) pair — never a permissive fallback.
 *
 * Independent audit fix #3 (2nd round): `companyId` may be OMITTED to
 * express a "user-level" decision — the only way to acknowledge an
 * `unknownUsers`/`malformedClaims` entry, which is keyed by uid alone (no
 * companyId exists to target). A companyId-less decision must have
 * `resolution === 'exclude'` — `confirm_role`/`accept_existing` always
 * require a specific (companyId, uid) relation and cannot be user-level. */
export function validateDecisions(raw: unknown): DecisionsValidationResult {
  const errors: DecisionsValidationError[] = []
  const decisions: Decision[] = []

  if (!Array.isArray(raw)) {
    return { ok: false, decisions: [], errors: [{ index: -1, message: 'decisions file must be a JSON array' }] }
  }

  const ALWAYS_REQUIRED_FIELDS = ['uid', 'findingType', 'evidenceFingerprint', 'resolution', 'reason', 'reviewedBy', 'reviewedAt'] as const
  const ALLOWED_FIELDS = new Set([...ALWAYS_REQUIRED_FIELDS, 'companyId', 'role'])

  raw.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ index, message: 'decision must be an object' })
      return
    }
    const rec = entry as Record<string, unknown>

    const unknownFields = Object.keys(rec).filter(k => !ALLOWED_FIELDS.has(k))
    if (unknownFields.length > 0) {
      errors.push({ index, message: `unknown field(s): ${unknownFields.sort().join(', ')}` })
      return
    }

    for (const field of ALWAYS_REQUIRED_FIELDS) {
      if (!isNonEmptyString(rec[field])) {
        errors.push({ index, message: `missing or empty required field: ${field}` })
        return
      }
    }

    const resolution = rec.resolution as string
    if (!KNOWN_RESOLUTIONS.includes(resolution as DecisionResolution)) {
      errors.push({ index, message: `unknown resolution: ${resolution}` })
      return
    }

    const findingType = rec.findingType as string
    if (!KNOWN_FINDING_TYPES.has(findingType as FindingType)) {
      errors.push({ index, message: `unknown findingType: ${findingType}` })
      return
    }

    // Independent audit fixes, 4th round, item 3.1: `exclude` for
    // `missing_company` (or any other finding type) can never be silently
    // reinterpreted as resolving an unrelated finding type — a decision's
    // resolution must be one this SPECIFIC findingType actually accepts.
    const compatible = COMPATIBLE_RESOLUTIONS[findingType as FindingType]
    if (!compatible.includes(resolution as DecisionResolution)) {
      errors.push({ index, message: `resolution "${resolution}" is not valid for findingType "${findingType}" (allowed: ${compatible.length > 0 ? compatible.join(', ') : 'none — this finding type is never decision-resolvable'})` })
      return
    }

    if (!SHA256_HEX_PATTERN.test((rec.evidenceFingerprint as string).toLowerCase())) {
      errors.push({ index, message: 'evidenceFingerprint must be a 64-character hex SHA-256 digest' })
      return
    }

    const hasCompanyId = rec.companyId !== undefined
    if (hasCompanyId && !isNonEmptyString(rec.companyId)) {
      errors.push({ index, message: 'companyId, if present, must be a non-empty string' })
      return
    }
    const expectUserLevel = USER_LEVEL_FINDING_TYPES.has(findingType as FindingType)
    if (expectUserLevel && hasCompanyId) {
      errors.push({ index, message: `findingType "${findingType}" is user-level and must not specify companyId` })
      return
    }
    if (!expectUserLevel && !hasCompanyId) {
      errors.push({ index, message: `findingType "${findingType}" requires companyId` })
      return
    }

    if (resolution === 'confirm_role') {
      if (!isKnownRole(rec.role)) {
        errors.push({ index, message: 'confirm_role decision requires a valid role' })
        return
      }
    } else if (rec.role !== undefined) {
      errors.push({ index, message: `role is only allowed for confirm_role decisions` })
      return
    }

    if (Number.isNaN(Date.parse(rec.reviewedAt as string))) {
      errors.push({ index, message: 'reviewedAt must be a parseable date/time' })
      return
    }

    decisions.push({
      uid: rec.uid as string,
      findingType: findingType as FindingType,
      evidenceFingerprint: (rec.evidenceFingerprint as string).toLowerCase(),
      resolution: resolution as DecisionResolution,
      reason: rec.reason as string,
      reviewedBy: rec.reviewedBy as string,
      reviewedAt: rec.reviewedAt as string,
      ...(hasCompanyId ? { companyId: rec.companyId as string } : {}),
      ...(resolution === 'confirm_role' ? { role: rec.role as Decision['role'] } : {}),
    })
  })

  if (errors.length > 0) return { ok: false, decisions: [], errors }

  // Reject duplicate/contradictory decisions for the same (identity,
  // findingType) target — a decisions file must have AT MOST one decision
  // per (companyId, uid, findingType) relation-level finding, and AT MOST
  // one per (uid, findingType) user-level finding. Independent audit fixes,
  // 4th round, item 3.1: the SAME (companyId, uid) pair may legitimately
  // carry decisions for two DIFFERENT finding types (e.g. accumulated
  // across rounds) — only a genuine (identity, findingType) duplicate is
  // ambiguous. The two namespaces can never collide: relationKey() always
  // encodes a JSON 2-element array (starts with "["), the user-level key
  // below never does.
  const seen = new Map<string, number>()
  decisions.forEach((d, index) => {
    const identity = d.companyId !== undefined ? relationKey(d.companyId, d.uid) : `user-level:${d.uid}`
    const key = `${identity}::${d.findingType}`
    const firstIndex = seen.get(key)
    if (firstIndex !== undefined) {
      errors.push({ index, message: `duplicate or contradicting decision for uid=${d.uid}${d.companyId !== undefined ? ` companyId=${d.companyId}` : ' (user-level)'} findingType=${d.findingType} (first seen at index ${firstIndex})` })
    } else {
      seen.set(key, index)
    }
  })

  if (errors.length > 0) return { ok: false, decisions: [], errors }
  return { ok: true, decisions, errors: [] }
}
