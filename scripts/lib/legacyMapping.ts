// Pure legacy -> canonical relation extraction for the SEC-005 membership
// backfill tool. NO Firestore I/O in this module — it only transforms
// already-read raw documents into candidate relations, conflicts, orphans,
// owner anomalies, unknown users, and malformed claims. This is what makes
// the hardest rules unit-testable without the emulator.
//
// Source fields (strictly limited to these, per REMEDIATION_PLAN.md SEC-005
// and docs/adr/001-company-membership-and-roles.md "Legacy migration implications"):
//   users/{uid}.companyId
//   users/{uid}.role
//   users/{uid}.companies[]  ({ companyId, role }[])
//   companies/{companyId}.ownerId
import {
  isKnownRole,
  relationKey,
  splitRelationKey,
  type RawUserDoc,
  type RawCompanyDoc,
  type Role,
  type ConfirmedRelation,
  type ConflictRecord,
  type OrphanRecord,
  type OwnerAnomalyRecord,
  type UnknownUserRecord,
  type MalformedClaimRecord,
  type LegacyExtractionResult,
  type RelationSourceKind,
} from './types.ts'

interface RawClaim {
  companyId: string
  roleValue: unknown
  kind: RelationSourceKind
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Extracts raw (unvalidated-role) claims for ONE user document — home
 * companyId/role plus companies[] entries. Never trusts data.id for
 * identity (rule 1: uid is always the document ID) — id-mismatch handling
 * happens in the caller, before this function's claims are even collected.
 * `malformed` collects companies[] entries that could not even be parsed
 * into a claim (independent audit fix #6) — reported, never silently
 * dropped. */
function extractRawClaims(data: Record<string, unknown>, malformed: { count: number }): RawClaim[] {
  const claims: RawClaim[] = []

  if (isNonEmptyString(data.companyId)) {
    claims.push({ companyId: data.companyId, roleValue: data.role, kind: 'users.home' })
  }

  if (Array.isArray(data.companies)) {
    for (const entry of data.companies) {
      if (entry === null || typeof entry !== 'object') { malformed.count += 1; continue }
      const rec = entry as Record<string, unknown>
      if (!isNonEmptyString(rec.companyId)) { malformed.count += 1; continue }
      claims.push({ companyId: rec.companyId, roleValue: rec.role, kind: 'users.companies[]' })
    }
  }

  return claims
}

export function extractLegacyRelations(
  users: readonly RawUserDoc[],
  companies: readonly RawCompanyDoc[],
): LegacyExtractionResult {
  const companyIds = new Set(companies.map(c => c.docId))
  const userIds = new Set(users.map(u => u.docId))

  const validRolesByKey = new Map<string, Set<Role>>()
  const kindsByKey = new Map<string, Set<RelationSourceKind>>()
  const invalidClaimKeys = new Set<string>()
  const conflicts: ConflictRecord[] = []
  const orphans: OrphanRecord[] = []
  const unknownUsers: UnknownUserRecord[] = []
  const malformedClaims: MalformedClaimRecord[] = []

  for (const user of users) {
    const rawId = user.data.id
    if (rawId !== undefined && rawId !== user.docId) {
      const malformed = { count: 0 }
      const claims = extractRawClaims(user.data, malformed)
      if (malformed.count > 0) malformedClaims.push({ uid: user.docId, reason: 'malformed_companies_entry' })

      // Independent audit fix #4 (2nd round): a claim under an id-mismatched
      // document that points at a company which does NOT exist must stay a
      // `missing_company` ORPHAN, not a `user_id_mismatch` CONFLICT — orphans
      // can only ever be acknowledged via `exclude` (planner.ts never lets a
      // decision create a membership under a nonexistent company), whereas a
      // conflict could previously be waved through with `confirm_role` even
      // though the target company never existed.
      const seenCompanyIds = new Set(claims.map(c => c.companyId))
      for (const companyId of seenCompanyIds) {
        if (companyIds.has(companyId)) {
          conflicts.push({ companyId, uid: user.docId, reason: 'user_id_mismatch' })
        } else {
          orphans.push({ companyId, uid: user.docId, reason: 'missing_company' })
        }
      }

      // Independent audit fix #3 (2nd round): an id-mismatched document with
      // NO usable claims at all (no companyId, no companies[] entries) must
      // never silently vanish — same "unknown user" treatment as a
      // normal (non-mismatched) user with zero usable relations.
      if (seenCompanyIds.size === 0) {
        unknownUsers.push({ uid: user.docId, reason: 'no_usable_relations' })
      }
      continue
    }

    const malformed = { count: 0 }
    const claims = extractRawClaims(user.data, malformed)
    if (malformed.count > 0) malformedClaims.push({ uid: user.docId, reason: 'malformed_companies_entry' })

    if (claims.length === 0) {
      // Independent audit fix #6: a user with literally no usable relation
      // claim must never be silently invisible — recorded here; the CLI
      // orchestrator (which has access to existing membership documents)
      // filters out any uid already covered by a valid canonical membership
      // before surfacing this list (see backfill-memberships.ts).
      unknownUsers.push({ uid: user.docId, reason: 'no_usable_relations' })
      continue
    }

    for (const claim of claims) {
      if (!companyIds.has(claim.companyId)) {
        orphans.push({ companyId: claim.companyId, uid: user.docId, reason: 'missing_company' })
        continue
      }

      const key = relationKey(claim.companyId, user.docId)
      if (isKnownRole(claim.roleValue)) {
        if (!validRolesByKey.has(key)) validRolesByKey.set(key, new Set())
        validRolesByKey.get(key)!.add(claim.roleValue)
        if (!kindsByKey.has(key)) kindsByKey.set(key, new Set())
        kindsByKey.get(key)!.add(claim.kind)
      } else {
        invalidClaimKeys.add(key)
      }
    }
  }

  // Independent audit fix #6: a pair with BOTH a valid-role claim and an
  // invalid-role claim must become a conflict — never silently confirmed
  // via the valid claim while ignoring the corrupted one.
  const mixedKeys = new Set<string>()
  for (const key of invalidClaimKeys) {
    if (validRolesByKey.has(key)) mixedKeys.add(key)
  }
  for (const key of mixedKeys) {
    const [companyId, uid] = splitRelationKey(key)
    conflicts.push({ companyId, uid, reason: 'mixed_role_validity' })
  }

  const confirmed: ConfirmedRelation[] = []
  const conflictKeys = new Set<string>(mixedKeys)
  for (const entry of validRolesByKey) {
    const key = entry[0]
    if (mixedKeys.has(key)) continue // already reported as mixed_role_validity above
    const roles = entry[1]
    const [companyId, uid] = splitRelationKey(key)
    if (roles.size > 1) {
      conflictKeys.add(key)
      const observed = Array.from(roles).sort()
      conflicts.push({ companyId, uid, reason: 'role_mismatch', observedRoles: observed })
    } else {
      const onlyRole = Array.from(roles)[0]!
      const kinds = Array.from(kindsByKey.get(key) ?? []).sort()
      confirmed.push({ companyId, uid, role: onlyRole, sources: kinds })
    }
  }

  const resolvedKeys = new Set<string>()
  for (const relation of confirmed) resolvedKeys.add(relationKey(relation.companyId, relation.uid))
  for (const key of conflictKeys) resolvedKeys.add(key)

  for (const key of invalidClaimKeys) {
    if (resolvedKeys.has(key)) continue // covered by confirmed, role_mismatch, or mixed_role_validity above
    const [companyId, uid] = splitRelationKey(key)
    conflicts.push({ companyId, uid, reason: 'invalid_role' })
  }

  const confirmedByKey = new Map<string, ConfirmedRelation>()
  for (const relation of confirmed) confirmedByKey.set(relationKey(relation.companyId, relation.uid), relation)

  const conflictedKeys = new Set<string>()
  for (const conflict of conflicts) conflictedKeys.add(relationKey(conflict.companyId, conflict.uid))

  const ownerAnomalies: OwnerAnomalyRecord[] = []

  for (const company of companies) {
    const ownerId = company.data.ownerId
    if (!isNonEmptyString(ownerId)) continue

    if (!userIds.has(ownerId)) {
      orphans.push({ companyId: company.docId, uid: ownerId, reason: 'missing_user' })
      continue
    }

    const key = relationKey(company.docId, ownerId)
    if (conflictedKeys.has(key)) continue

    const existing = confirmedByKey.get(key)
    if (existing) {
      if (existing.role !== 'admin') {
        conflicts.push({ companyId: company.docId, uid: ownerId, reason: 'owner_role_not_admin', observedRoles: [existing.role] })
        const idx = confirmed.findIndex(r => r.companyId === company.docId && r.uid === ownerId)
        if (idx >= 0) confirmed.splice(idx, 1)
      }
    } else {
      ownerAnomalies.push({ companyId: company.docId, uid: ownerId, reason: 'owner_without_admin_membership' })
    }
  }

  return { confirmed, conflicts, orphans, ownerAnomalies, unknownUsers, malformedClaims }
}
