// Manual conflict-resolution decisions file — SEC-005.
//
// Loaded from an external path OUTSIDE the repository (--decisions-file).
// This module only validates/normalizes; reading the file and hashing its
// content happens in the CLI entry point.
import { isKnownRole, relationKey, type Decision, type DecisionResolution } from './types.ts'

const KNOWN_RESOLUTIONS: readonly DecisionResolution[] = ['confirm_role', 'accept_existing', 'exclude']

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
 * (companyId, uid) pair — never a permissive fallback. */
export function validateDecisions(raw: unknown): DecisionsValidationResult {
  const errors: DecisionsValidationError[] = []
  const decisions: Decision[] = []

  if (!Array.isArray(raw)) {
    return { ok: false, decisions: [], errors: [{ index: -1, message: 'decisions file must be a JSON array' }] }
  }

  const REQUIRED_FIELDS = ['uid', 'companyId', 'resolution', 'reason', 'reviewedBy', 'reviewedAt'] as const
  const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, 'role'])

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

    for (const field of REQUIRED_FIELDS) {
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
      companyId: rec.companyId as string,
      resolution: resolution as DecisionResolution,
      reason: rec.reason as string,
      reviewedBy: rec.reviewedBy as string,
      reviewedAt: rec.reviewedAt as string,
      ...(resolution === 'confirm_role' ? { role: rec.role as Decision['role'] } : {}),
    })
  })

  if (errors.length > 0) return { ok: false, decisions: [], errors }

  // Reject duplicate/contradictory decisions for the same pair — a decisions
  // file must have AT MOST one decision per (companyId, uid).
  const seen = new Map<string, number>()
  decisions.forEach((d, index) => {
    const key = relationKey(d.companyId, d.uid)
    const firstIndex = seen.get(key)
    if (firstIndex !== undefined) {
      errors.push({ index, message: `duplicate or contradicting decision for companyId=${d.companyId} uid=${d.uid} (first seen at index ${firstIndex})` })
    } else {
      seen.set(key, index)
    }
  })

  if (errors.length > 0) return { ok: false, decisions: [], errors }
  return { ok: true, decisions, errors: [] }
}
