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
  type OwnerIdAnomalyRecord,
  type LegacyExtractionResult,
  type RelationSourceKind,
} from './types.ts'
import { computeFindingFingerprint } from './checksum.ts'

interface RawClaim {
  companyId: string
  roleValue: unknown
  kind: RelationSourceKind
}

interface RawClaimExtraction {
  claims: RawClaim[]
  /** `users/{uid}.companies` is PRESENT but not an array at all — independent
   * audit fixes, 4th round, item 3.4 (previously silently ignored). */
  companiesFieldNotArray: boolean
  /** `users/{uid}.companyId` is PRESENT but not a non-empty string —
   * independent audit fixes, 4th round, item 3.4 (previously silently
   * ignored — no claim, no record). */
  malformedCompanyId: boolean
  /** Count of `companies[]` array entries that could not be parsed into a
   * claim (not an object, or missing a usable `companyId`) — pre-existing
   * behavior, unchanged. */
  malformedEntryCount: number
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function sortedUniqueKinds(kinds: Iterable<RelationSourceKind>): RelationSourceKind[] {
  return Array.from(new Set(kinds)).sort()
}

function sortedUniqueRoles(roles: Iterable<Role>): Role[] {
  return Array.from(new Set(roles)).sort()
}

/** Extracts raw (unvalidated-role) claims for ONE user document — home
 * companyId/role plus companies[] entries — AND every source-container
 * anomaly detected along the way. Never trusts data.id for identity (rule
 * 1: uid is always the document ID) — id-mismatch handling happens in the
 * caller, before this function's claims are even collected.
 *
 * Independent audit fixes, 4th round, item 3.4: every anomaly below is
 * reported REGARDLESS of whether the SAME user document simultaneously has
 * another usable, valid claim — a corrupted container is never silently
 * masked by an unrelated valid one. */
function extractRawClaims(data: Record<string, unknown>): RawClaimExtraction {
  const claims: RawClaim[] = []
  let companiesFieldNotArray = false
  let malformedCompanyId = false
  let malformedEntryCount = 0

  if (data.companyId !== undefined) {
    if (isNonEmptyString(data.companyId)) {
      claims.push({ companyId: data.companyId, roleValue: data.role, kind: 'users.home' })
    } else {
      malformedCompanyId = true
    }
  }

  if (data.companies !== undefined) {
    if (Array.isArray(data.companies)) {
      for (const entry of data.companies) {
        if (entry === null || typeof entry !== 'object') { malformedEntryCount += 1; continue }
        const rec = entry as Record<string, unknown>
        if (!isNonEmptyString(rec.companyId)) { malformedEntryCount += 1; continue }
        claims.push({ companyId: rec.companyId, roleValue: rec.role, kind: 'users.companies[]' })
      }
    } else {
      companiesFieldNotArray = true
    }
  }

  return { claims, companiesFieldNotArray, malformedCompanyId, malformedEntryCount }
}

/** Pushes one `MalformedClaimRecord` per DISTINCT anomaly kind detected for
 * `uid` — never merged into a single record, so a decision can independently
 * target (and later independently go stale on) each one. Evidence is
 * intentionally empty ({}) for all three reasons: the anomaly is fully
 * described by (uid, reason) alone, and no raw offending value is ever
 * captured (task spec §8 / CLAUDE.md §6.6 — never log arbitrary document
 * content). */
function pushMalformedClaims(malformedClaims: MalformedClaimRecord[], uid: string, extraction: RawClaimExtraction): void {
  const emptyFingerprint = computeFindingFingerprint({})
  if (extraction.malformedCompanyId) {
    malformedClaims.push({ uid, reason: 'malformed_company_id', evidenceFingerprint: emptyFingerprint })
  }
  if (extraction.companiesFieldNotArray) {
    malformedClaims.push({ uid, reason: 'companies_field_not_array', evidenceFingerprint: emptyFingerprint })
  }
  if (extraction.malformedEntryCount > 0) {
    malformedClaims.push({ uid, reason: 'malformed_companies_entry', evidenceFingerprint: emptyFingerprint })
  }
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
  const unknownUsers: UnknownUserRecord[] = []
  const malformedClaims: MalformedClaimRecord[] = []

  // Orphan (missing_company) evidence is aggregated per (companyId, uid)
  // key BEFORE any OrphanRecord is emitted — independent audit fixes, 4th
  // round, item 3.3/3.4: a claim's source kind (and, if present, its role
  // claim) must survive into the orphan's evidence, not be discarded at the
  // point the orphan is detected.
  const orphanCompanyEvidence = new Map<string, { kinds: Set<RelationSourceKind>; validRoles: Set<Role>; hasInvalidRole: boolean }>()
  function recordOrphanEvidence(companyId: string, uid: string, kind: RelationSourceKind, roleValue: unknown): void {
    const key = relationKey(companyId, uid)
    let entry = orphanCompanyEvidence.get(key)
    if (!entry) { entry = { kinds: new Set(), validRoles: new Set(), hasInvalidRole: false }; orphanCompanyEvidence.set(key, entry) }
    entry.kinds.add(kind)
    // Independent audit fixes, 5th round (review of the 5th round's own
    // fix): a MISSING `role` field must be treated exactly like an
    // INVALID one, not silently ignored — this is the established
    // convention everywhere else in this file (see the confirmed/conflict
    // path below: `isKnownRole(claim.roleValue)` is false for `undefined`
    // too, so a claim with no role at all becomes `invalid_role`, same as
    // a corrupted string). The previous `roleValue !== undefined` guard
    // here meant a claim with literally no `role` field contributed no
    // evidence at all to an orphan's `hasInvalidRole` — an inconsistency
    // an independent reviewer's negative test caught directly.
    if (isKnownRole(roleValue)) entry.validRoles.add(roleValue)
    else entry.hasInvalidRole = true
  }

  // missing_user orphans (via companies.ownerId) are always sourced from
  // exactly one kind — recorded directly at push time, no aggregation map
  // needed.
  const orphans: OrphanRecord[] = []
  function pushMissingUserOrphan(companyId: string, uid: string): void {
    // companies.ownerId carries no role claim of its own — observedRoles/
    // proposedRole are always empty/null for missing_user orphans.
    const evidence = { sourceKinds: ['companies.ownerId'] as RelationSourceKind[], observedRoles: [] as Role[], hasInvalidRole: false }
    orphans.push({
      companyId, uid, reason: 'missing_user', sourceKinds: evidence.sourceKinds,
      observedRoles: [], hasInvalidRole: false, proposedRole: null,
      evidenceFingerprint: computeFindingFingerprint(evidence),
    })
  }

  for (const user of users) {
    const rawId = user.data.id
    if (rawId !== undefined && rawId !== user.docId) {
      const extraction = extractRawClaims(user.data)
      pushMalformedClaims(malformedClaims, user.docId, extraction)

      // Independent audit fix #4 (2nd round): a claim under an id-mismatched
      // document that points at a company which does NOT exist must stay a
      // `missing_company` ORPHAN, not a `user_id_mismatch` CONFLICT — orphans
      // can only ever be acknowledged via `exclude` (planner.ts never lets a
      // decision create a membership under a nonexistent company), whereas a
      // conflict could previously be waved through with `confirm_role` even
      // though the target company never existed.
      const seenCompanyIds = new Set(extraction.claims.map(c => c.companyId))
      for (const companyId of seenCompanyIds) {
        if (companyIds.has(companyId)) {
          const sourceKinds = sortedUniqueKinds(extraction.claims.filter(c => c.companyId === companyId).map(c => c.kind))
          conflicts.push({ companyId, uid: user.docId, reason: 'user_id_mismatch', sourceKinds, evidenceFingerprint: computeFindingFingerprint({ sourceKinds }) })
        } else {
          for (const claim of extraction.claims) {
            if (claim.companyId === companyId) recordOrphanEvidence(companyId, user.docId, claim.kind, claim.roleValue)
          }
        }
      }

      // Independent audit fix #3 (2nd round): an id-mismatched document with
      // NO usable claims at all (no companyId, no companies[] entries) must
      // never silently vanish — same "unknown user" treatment as a
      // normal (non-mismatched) user with zero usable relations.
      if (seenCompanyIds.size === 0) {
        unknownUsers.push({ uid: user.docId, reason: 'no_usable_relations', evidenceFingerprint: computeFindingFingerprint({}) })
      }
      continue
    }

    const extraction = extractRawClaims(user.data)
    pushMalformedClaims(malformedClaims, user.docId, extraction)

    if (extraction.claims.length === 0) {
      // Independent audit fix #6: a user with literally no usable relation
      // claim must never be silently invisible — recorded here; the CLI
      // orchestrator (which has access to existing membership documents)
      // filters out any uid already covered by a valid canonical membership
      // before surfacing this list (see backfill-memberships.ts).
      unknownUsers.push({ uid: user.docId, reason: 'no_usable_relations', evidenceFingerprint: computeFindingFingerprint({}) })
      continue
    }

    for (const claim of extraction.claims) {
      if (!companyIds.has(claim.companyId)) {
        recordOrphanEvidence(claim.companyId, user.docId, claim.kind, claim.roleValue)
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
        if (!kindsByKey.has(key)) kindsByKey.set(key, new Set())
        kindsByKey.get(key)!.add(claim.kind)
      }
    }
  }

  // Emit missing_company orphans from the aggregated evidence map.
  for (const [key, evidence] of orphanCompanyEvidence) {
    const [companyId, uid] = splitRelationKey(key)
    const sourceKinds = sortedUniqueKinds(evidence.kinds)
    const observedRoles = sortedUniqueRoles(evidence.validRoles)
    const hasInvalidRole = evidence.hasInvalidRole
    const findingEvidence = { sourceKinds, observedRoles, hasInvalidRole }
    // Independent audit fixes, 5th round, item 4: a proposed role is only
    // ever set for an UNAMBIGUOUS, valid claim (exactly one observed role,
    // no invalid claim alongside it) — never guessed at when zero,
    // multiple, or any invalid role was observed.
    const proposedRole: Role | null = observedRoles.length === 1 && !hasInvalidRole ? observedRoles[0]! : null
    orphans.push({
      companyId, uid, reason: 'missing_company', sourceKinds, observedRoles, hasInvalidRole, proposedRole,
      evidenceFingerprint: computeFindingFingerprint(findingEvidence),
    })
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
    const sourceKinds = sortedUniqueKinds(kindsByKey.get(key) ?? [])
    const observedRoles = sortedUniqueRoles(validRolesByKey.get(key) ?? [])
    const evidence = { sourceKinds, observedRoles, hasInvalidRole: true }
    conflicts.push({ companyId, uid, reason: 'mixed_role_validity', observedRoles, hasInvalidRole: true, sourceKinds, evidenceFingerprint: computeFindingFingerprint(evidence) })
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
      const observed = sortedUniqueRoles(roles)
      const sourceKinds = sortedUniqueKinds(kindsByKey.get(key) ?? [])
      const evidence = { sourceKinds, observedRoles: observed, hasInvalidRole: false }
      conflicts.push({ companyId, uid, reason: 'role_mismatch', observedRoles: observed, sourceKinds, evidenceFingerprint: computeFindingFingerprint(evidence) })
    } else {
      const onlyRole = Array.from(roles)[0]!
      const kinds = sortedUniqueKinds(kindsByKey.get(key) ?? [])
      confirmed.push({ companyId, uid, role: onlyRole, sources: kinds })
    }
  }

  const resolvedKeys = new Set<string>()
  for (const relation of confirmed) resolvedKeys.add(relationKey(relation.companyId, relation.uid))
  for (const key of conflictKeys) resolvedKeys.add(key)

  for (const key of invalidClaimKeys) {
    if (resolvedKeys.has(key)) continue // covered by confirmed, role_mismatch, or mixed_role_validity above
    const [companyId, uid] = splitRelationKey(key)
    const sourceKinds = sortedUniqueKinds(kindsByKey.get(key) ?? [])
    const evidence = { sourceKinds, hasInvalidRole: true }
    conflicts.push({ companyId, uid, reason: 'invalid_role', hasInvalidRole: true, sourceKinds, evidenceFingerprint: computeFindingFingerprint(evidence) })
  }

  const confirmedByKey = new Map<string, ConfirmedRelation>()
  for (const relation of confirmed) confirmedByKey.set(relationKey(relation.companyId, relation.uid), relation)

  const conflictedKeys = new Set<string>()
  for (const conflict of conflicts) conflictedKeys.add(relationKey(conflict.companyId, conflict.uid))

  const ownerAnomalies: OwnerAnomalyRecord[] = []
  const ownerIdAnomalies: OwnerIdAnomalyRecord[] = []

  for (const company of companies) {
    const ownerId = company.data.ownerId
    if (ownerId === undefined) continue // no owner claim at all — not an anomaly

    if (!isNonEmptyString(ownerId)) {
      // Independent audit fixes, 4th round, item 3.4: PRESENT but not a
      // usable string — previously silently treated the same as "absent".
      // Never decision-resolvable (see OwnerIdAnomalyRecord doc comment) —
      // there is no reliable uid here to attach a decision to.
      ownerIdAnomalies.push({ companyId: company.docId, reason: 'malformed_owner_id', evidenceFingerprint: computeFindingFingerprint({}) })
      continue
    }

    if (!userIds.has(ownerId)) {
      pushMissingUserOrphan(company.docId, ownerId)
      continue
    }

    const key = relationKey(company.docId, ownerId)
    if (conflictedKeys.has(key)) continue

    const existing = confirmedByKey.get(key)
    if (existing) {
      if (existing.role !== 'admin') {
        const evidence = { observedRoles: [existing.role] }
        conflicts.push({ companyId: company.docId, uid: ownerId, reason: 'owner_role_not_admin', observedRoles: [existing.role], evidenceFingerprint: computeFindingFingerprint(evidence) })
        const idx = confirmed.findIndex(r => r.companyId === company.docId && r.uid === ownerId)
        if (idx >= 0) confirmed.splice(idx, 1)
      }
    } else {
      ownerAnomalies.push({ companyId: company.docId, uid: ownerId, reason: 'owner_without_admin_membership', evidenceFingerprint: computeFindingFingerprint({}) })
    }
  }

  return { confirmed, conflicts, orphans, ownerAnomalies, unknownUsers, malformedClaims, ownerIdAnomalies }
}
