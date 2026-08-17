// Independent audit fix #4 — computes the observed checksum/missing/differing
// state strictly from documents that were ACTUALLY read back, never
// substituting an expected value for an absent one. Pure function (no I/O)
// so partial-write-failure honesty is unit-testable without the emulator.
//
// Independent audit fix #7 (2nd round): a document is now reported as
// `differing` (and contributes `schemaValid: false` to the observed
// checksum) whenever it fails STRICT canonical-schema validation — not
// only when its role/status textually differs from the target. This
// closes the gap where a document with the "right" role/status but a
// wrong uid, missing/forged timestamps, or extra fields could otherwise
// pass verify/apply-completion checks.
import { relationKey } from './types.ts'
import { computeRelationSetChecksum } from './checksum.ts'
import { isStrictlyValidActiveMembership } from './membershipValidation.ts'

export interface TargetRelation {
  companyId: string
  uid: string
  role: string
  status: string
}

export interface ObservedState {
  observedChecksum: string
  missing: { companyId: string; uid: string }[]
  differing: { companyId: string; uid: string }[]
}

/** `readBack` must be the result of an ACTUAL Firestore read performed
 * after (or in lieu of, for verify) any writes — never a map that was
 * pre-populated with expected/intended values. A target relation with no
 * corresponding entry in `readBack` is recorded as MISSING (both in the
 * `missing[]` list and as a `role: 'MISSING'` sentinel fed into the
 * checksum) — it can never silently pass as if it had been created. */
export function computeObservedState(
  targetRelations: readonly TargetRelation[],
  readBack: ReadonlyMap<string, Record<string, unknown>>,
): ObservedState {
  const missing: { companyId: string; uid: string }[] = []
  const differing: { companyId: string; uid: string }[] = []

  const observedRelations = targetRelations.map(r => {
    const data = readBack.get(relationKey(r.companyId, r.uid))
    if (!data) {
      missing.push({ companyId: r.companyId, uid: r.uid })
      return { companyId: r.companyId, uid: r.uid, role: 'MISSING', status: 'MISSING', schemaValid: false }
    }
    const actualRole = typeof data.role === 'string' ? data.role : 'MISSING'
    const actualStatus = typeof data.status === 'string' ? data.status : 'MISSING'
    const schemaValid = isStrictlyValidActiveMembership(r.uid, data)
    if (!schemaValid || actualRole !== r.role || actualStatus !== r.status) {
      differing.push({ companyId: r.companyId, uid: r.uid })
    }
    return { companyId: r.companyId, uid: r.uid, role: actualRole, status: actualStatus, schemaValid }
  })

  return { observedChecksum: computeRelationSetChecksum(observedRelations), missing, differing }
}
