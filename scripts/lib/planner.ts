// Combines legacy extraction + manual decisions + existing membership
// documents + existing active-admin counts into a final, deterministic
// apply plan — SEC-005. Pure function, no Firestore I/O.
import {
  relationKey, splitRelationKey,
  type LegacyExtractionResult, type Decision, type PlanResult, type PlannedCreate,
  type ConflictRecord, type OrphanRecord, type OwnerAnomalyRecord, type UnknownUserRecord, type MalformedClaimRecord,
} from './types.ts'
import { classifyExistingMembership, isStrictlyValidActiveMembership } from './membershipValidation.ts'

export interface BuildPlanParams {
  extraction: LegacyExtractionResult
  decisions: readonly Decision[]
  /** key = relationKey(companyId, uid); absent key = no existing doc. */
  existingMemberships: ReadonlyMap<string, Record<string, unknown>>
  /** companyId -> uids with an EXISTING STRICTLY VALID active admin membership (independent of anything this run plans to create). */
  existingActiveAdmins: ReadonlyMap<string, ReadonlySet<string>>
  /** ALL companies that exist right now (from companies/{companyId}), regardless of whether this run touches them — independent audit fix #1: the last-admin gate must cover every existing company, not only ones with a confirmed relation. */
  allCompanyIds: ReadonlySet<string>
  /** ALL users that exist right now (from users/{uid}) — independent audit
   * fix #4 (2nd round): every `confirm_role` decision is re-checked against
   * BOTH `allCompanyIds` and `allUserIds` before being trusted, so a
   * decision can never conjure a membership under a company or user that
   * does not actually exist. */
  allUserIds: ReadonlySet<string>
}

/** True only when a confirm_role decision's target (companyId, uid) both
 * still exist right now — independent audit fix #4 (2nd round). A conflict
 * or owner-anomaly record is only ever constructed by legacyMapping.ts for
 * companyId/uid values that existed AT EXTRACTION TIME, but re-checking
 * here, at the point a decision is actually applied, is the defense the
 * review asked for: "на всех путях confirm_role повторно проверяй
 * существование users/{uid} и companies/{companyId}". */
function confirmRoleTargetExists(companyId: string, uid: string, allCompanyIds: ReadonlySet<string>, allUserIds: ReadonlySet<string>): boolean {
  return allCompanyIds.has(companyId) && allUserIds.has(uid)
}

export function buildPlan(params: BuildPlanParams): PlanResult {
  const { extraction, decisions, existingMemberships, existingActiveAdmins, allCompanyIds, allUserIds } = params
  const decisionByKey = new Map(
    decisions.filter((d): d is Decision & { companyId: string } => d.companyId !== undefined)
      .map(d => [relationKey(d.companyId, d.uid), d]),
  )
  // User-level decisions (no companyId) — the only mechanism that can
  // acknowledge an unknownUsers/malformedClaims entry (independent audit
  // fix #3, 2nd round). Always resolution === 'exclude' (validated by
  // decisions.ts).
  const userLevelExcludedUids = new Set(
    decisions.filter(d => d.companyId === undefined && d.resolution === 'exclude').map(d => d.uid),
  )

  const confirmed = new Map(extraction.confirmed.map(r => [relationKey(r.companyId, r.uid), r]))
  const unresolvedConflicts: ConflictRecord[] = []
  const skipped: { companyId: string; uid: string }[] = []

  // ── Step 1: resolve legacy-source conflicts via decisions ──────────────
  for (const conflict of extraction.conflicts) {
    const key = relationKey(conflict.companyId, conflict.uid)
    const decision = decisionByKey.get(key)
    if (!decision) { unresolvedConflicts.push(conflict); continue }

    if (decision.resolution === 'confirm_role' && decision.role) {
      // Independent audit fix #4 (2nd round): re-verify the target company
      // and user both still exist before trusting a confirm_role decision —
      // a decision can never create a membership under a company/user that
      // does not exist, no matter what conflict record it is attached to.
      if (!confirmRoleTargetExists(conflict.companyId, conflict.uid, allCompanyIds, allUserIds)) {
        unresolvedConflicts.push(conflict)
      } else {
        confirmed.set(key, { companyId: conflict.companyId, uid: conflict.uid, role: decision.role, sources: [] })
      }
    } else if (decision.resolution === 'exclude') {
      // Acknowledged, no membership created — dropped silently (not a skip: nothing existed and nothing was planned).
    } else {
      // 'accept_existing' has no meaning for a legacy-source conflict (there
      // is no existing membership doc implicated here) — the conflict
      // stays unresolved rather than being silently waved through.
      unresolvedConflicts.push(conflict)
    }
  }

  // ── Step 2: resolve owner anomalies via decisions ───────────────────────
  const unresolvedOwnerAnomalies: OwnerAnomalyRecord[] = []
  for (const anomaly of extraction.ownerAnomalies) {
    const key = relationKey(anomaly.companyId, anomaly.uid)
    const decision = decisionByKey.get(key)
    if (!decision) { unresolvedOwnerAnomalies.push(anomaly); continue }

    if (decision.resolution === 'confirm_role' && decision.role) {
      // Independent audit fix #4 (2nd round) — see Step 1 above.
      if (!confirmRoleTargetExists(anomaly.companyId, anomaly.uid, allCompanyIds, allUserIds)) {
        unresolvedOwnerAnomalies.push(anomaly)
      } else {
        confirmed.set(key, { companyId: anomaly.companyId, uid: anomaly.uid, role: decision.role, sources: [] })
      }
    } else if (decision.resolution === 'exclude') {
      // Acknowledged — owner intentionally left without membership.
    } else {
      unresolvedOwnerAnomalies.push(anomaly)
    }
  }

  // ── Step 3: orphans only need acknowledgement (exclude) — never create anything ──
  const unresolvedOrphans: OrphanRecord[] = []
  for (const orphan of extraction.orphans) {
    const key = relationKey(orphan.companyId, orphan.uid)
    const decision = decisionByKey.get(key)
    if (decision && decision.resolution === 'exclude') continue // acknowledged
    unresolvedOrphans.push(orphan)
  }

  // ── Step 4: reconcile confirmed relations against existing membership docs ──
  // Independent audit fix #2: `accept_existing` may ONLY resolve
  // 'differs_but_valid' (a strictly well-formed, active membership that
  // simply holds a different role). A genuinely 'invalid' existing document
  // (uid mismatch, unknown role, inactive status, missing/malformed
  // timestamps, or extra fields) remains a blocking conflict regardless of
  // any decision — a decision can never launder a corrupted document into
  // "canonical".
  const plannedCreates: PlannedCreate[] = []
  for (const relation of confirmed.values()) {
    const key = relationKey(relation.companyId, relation.uid)
    const existingData = existingMemberships.get(key)
    const classification = classifyExistingMembership(relation.role, relation.uid, existingData)

    if (classification === 'not_found') {
      plannedCreates.push({ companyId: relation.companyId, uid: relation.uid, role: relation.role, status: 'active' })
    } else if (classification === 'exact_match') {
      skipped.push({ companyId: relation.companyId, uid: relation.uid })
    } else if (classification === 'differs_but_valid') {
      const decision = decisionByKey.get(key)
      if (decision && decision.resolution === 'accept_existing') {
        skipped.push({ companyId: relation.companyId, uid: relation.uid })
      } else {
        unresolvedConflicts.push({ companyId: relation.companyId, uid: relation.uid, reason: 'existing_membership_conflict' })
      }
    } else {
      // 'invalid' — never resolvable via accept_existing (or any other decision).
      unresolvedConflicts.push({ companyId: relation.companyId, uid: relation.uid, reason: 'existing_membership_conflict' })
    }
  }

  // ── Step 5: last-admin gate — EVERY existing company, not just touched ones ──
  // Independent audit fix #1: previously only companies with a confirmed
  // relation were checked, so a company with zero legacy relations AND zero
  // existing admin silently passed. Now every company in `allCompanyIds`
  // (i.e. every companies/{companyId} document that currently exists) is
  // checked, using `existingActiveAdmins` (already computed with the strict
  // validator — a corrupted document can never count as a protecting admin).
  const companiesWithoutAdmin: string[] = []
  for (const companyId of allCompanyIds) {
    const existingAdmins = existingActiveAdmins.get(companyId)
    const hasExistingAdmin = !!existingAdmins && existingAdmins.size > 0
    const hasPlannedAdmin = plannedCreates.some(c => c.companyId === companyId && c.role === 'admin')
    if (!hasExistingAdmin && !hasPlannedAdmin) companiesWithoutAdmin.push(companyId)
  }
  companiesWithoutAdmin.sort()

  // ── Step 6: unknown users / malformed claims — BLOCKING unless acknowledged ──
  // Independent audit fix #6 (1st round) surfaced these; fix #3 (2nd round)
  // makes them blocking. A uid already covered by a valid canonical
  // membership anywhere is never "unknown" in the first place. Anything
  // left is only removable via a user-level `exclude` decision
  // (`userLevelExcludedUids`) — there is no other way to silently ignore
  // it; the source data must be fixed, or explicitly acknowledged.
  const uidsWithValidMembership = new Set<string>()
  for (const [key, data] of existingMemberships) {
    const [, uid] = splitRelationKey(key)
    if (isStrictlyValidActiveMembership(uid, data)) uidsWithValidMembership.add(uid)
  }
  const unknownUsers: UnknownUserRecord[] = extraction.unknownUsers
    .filter(u => !uidsWithValidMembership.has(u.uid))
    .filter(u => !userLevelExcludedUids.has(u.uid))
  const malformedClaims: MalformedClaimRecord[] = extraction.malformedClaims
    .filter(m => !userLevelExcludedUids.has(m.uid))

  const applyAllowed =
    unresolvedConflicts.length === 0 &&
    unresolvedOrphans.length === 0 &&
    unresolvedOwnerAnomalies.length === 0 &&
    companiesWithoutAdmin.length === 0 &&
    unknownUsers.length === 0 &&
    malformedClaims.length === 0

  return {
    plannedCreates: plannedCreates.sort((a, b) => (a.companyId + a.uid).localeCompare(b.companyId + b.uid)),
    skipped: skipped.sort((a, b) => (a.companyId + a.uid).localeCompare(b.companyId + b.uid)),
    unresolvedConflicts,
    unresolvedOrphans,
    unresolvedOwnerAnomalies,
    companiesWithoutAdmin,
    unknownUsers,
    malformedClaims,
    applyAllowed,
  }
}
