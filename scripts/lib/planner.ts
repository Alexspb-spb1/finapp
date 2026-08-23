// Combines legacy extraction + manual decisions + existing membership
// documents + existing active-admin counts into a final, deterministic
// apply plan — SEC-005. Pure function, no Firestore I/O.
import {
  relationKey, splitRelationKey,
  type LegacyExtractionResult, type Decision, type PlanResult, type PlannedCreate,
  type ConflictRecord, type OrphanRecord, type OwnerAnomalyRecord, type UnknownUserRecord, type MalformedClaimRecord,
  type DanglingMembershipRecord, type DanglingMembershipReason, type FindingType,
} from './types.ts'
import { classifyExistingMembership, isStrictlyValidActiveMembership } from './membershipValidation.ts'
import { sortRelations, computeFindingFingerprint } from './checksum.ts'

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

/** One index entry per (identity, findingType) — decisions.ts already
 * rejects a decisions file containing two decisions for the same
 * (identity, findingType) pair, so this map is safe to build with a plain
 * `set()` (last-write, but duplicates were already refused upstream). */
function buildDecisionIndex(decisions: readonly Decision[]): Map<string, Decision> {
  const index = new Map<string, Decision>()
  for (const d of decisions) {
    const identity = d.companyId !== undefined ? relationKey(d.companyId, d.uid) : `user-level:${d.uid}`
    index.set(`${identity}::${d.findingType}`, d)
  }
  return index
}

interface DecisionLookup {
  decision: Decision
  /** True only when the decision's OWN recorded `evidenceFingerprint`
   * exactly equals the CURRENT finding's fingerprint — independent audit
   * fixes, 4th round, item 3.1. */
  fingerprintMatches: boolean
}

/** Looks up a decision for exactly (identity, findingType) — marks it used
 * (for later unused-decision detection) whenever found, REGARDLESS of
 * whether the fingerprint ends up matching (a decision that matched
 * identity+findingType but went stale on evidence is "used" — it is
 * reported as `staleDecisions`, not `unusedDecisions`; those are disjoint
 * categories). */
function lookupDecision(
  decisionIndex: ReadonlyMap<string, Decision>,
  usedKeys: Set<string>,
  identity: string,
  findingType: FindingType,
  currentFingerprint: string,
): DecisionLookup | undefined {
  const key = `${identity}::${findingType}`
  const decision = decisionIndex.get(key)
  if (!decision) return undefined
  usedKeys.add(key)
  return { decision, fingerprintMatches: decision.evidenceFingerprint === currentFingerprint }
}

export function buildPlan(params: BuildPlanParams): PlanResult {
  const { extraction, decisions, existingMemberships, existingActiveAdmins, allCompanyIds, allUserIds } = params
  const decisionIndex = buildDecisionIndex(decisions)
  const usedDecisionKeys = new Set<string>()
  const staleDecisions: Decision[] = []
  // Independent audit fixes, 5th round, item 4: every finding that WAS
  // successfully resolved this run, paired with the decision that resolved
  // it — closes the audit-trail gap where a resolved finding left zero
  // trace in the report.
  const resolvedConflicts: { finding: ConflictRecord; decision: Decision }[] = []
  const resolvedOrphans: { finding: OrphanRecord; decision: Decision }[] = []
  const resolvedOwnerAnomalies: { finding: OwnerAnomalyRecord; decision: Decision }[] = []
  const resolvedUnknownUsers: { finding: UnknownUserRecord; decision: Decision }[] = []
  const resolvedMalformedClaims: { finding: MalformedClaimRecord; decision: Decision }[] = []

  const confirmed = new Map(extraction.confirmed.map(r => [relationKey(r.companyId, r.uid), r]))
  const unresolvedConflicts: ConflictRecord[] = []
  const skipped: { companyId: string; uid: string }[] = []

  // ── Step 1: resolve legacy-source conflicts via decisions ──────────────
  for (const conflict of extraction.conflicts) {
    const key = relationKey(conflict.companyId, conflict.uid)
    const lookup = lookupDecision(decisionIndex, usedDecisionKeys, key, conflict.reason, conflict.evidenceFingerprint)
    if (!lookup) { unresolvedConflicts.push(conflict); continue }
    if (!lookup.fingerprintMatches) { staleDecisions.push(lookup.decision); unresolvedConflicts.push(conflict); continue }
    const decision = lookup.decision

    if (decision.resolution === 'confirm_role' && decision.role) {
      // Independent audit fix #4 (2nd round): re-verify the target company
      // and user both still exist before trusting a confirm_role decision —
      // a decision can never create a membership under a company/user that
      // does not exist, no matter what conflict record it is attached to.
      if (!confirmRoleTargetExists(conflict.companyId, conflict.uid, allCompanyIds, allUserIds)) {
        unresolvedConflicts.push(conflict)
      } else {
        confirmed.set(key, { companyId: conflict.companyId, uid: conflict.uid, role: decision.role, sources: [] })
        resolvedConflicts.push({ finding: conflict, decision })
      }
    } else if (decision.resolution === 'exclude') {
      // Acknowledged, no membership created — dropped silently (not a skip: nothing existed and nothing was planned).
      resolvedConflicts.push({ finding: conflict, decision })
    } else {
      // Defensive — decisions.ts's COMPATIBLE_RESOLUTIONS check should have
      // already refused any other resolution for this findingType.
      unresolvedConflicts.push(conflict)
    }
  }

  // ── Step 2: resolve owner anomalies via decisions ───────────────────────
  const unresolvedOwnerAnomalies: OwnerAnomalyRecord[] = []
  for (const anomaly of extraction.ownerAnomalies) {
    const key = relationKey(anomaly.companyId, anomaly.uid)
    const lookup = lookupDecision(decisionIndex, usedDecisionKeys, key, anomaly.reason, anomaly.evidenceFingerprint)
    if (!lookup) { unresolvedOwnerAnomalies.push(anomaly); continue }
    if (!lookup.fingerprintMatches) { staleDecisions.push(lookup.decision); unresolvedOwnerAnomalies.push(anomaly); continue }
    const decision = lookup.decision

    if (decision.resolution === 'confirm_role' && decision.role) {
      // Independent audit fix #4 (2nd round) — see Step 1 above.
      if (!confirmRoleTargetExists(anomaly.companyId, anomaly.uid, allCompanyIds, allUserIds)) {
        unresolvedOwnerAnomalies.push(anomaly)
      } else {
        confirmed.set(key, { companyId: anomaly.companyId, uid: anomaly.uid, role: decision.role, sources: [] })
        resolvedOwnerAnomalies.push({ finding: anomaly, decision })
      }
    } else if (decision.resolution === 'exclude') {
      // Acknowledged — owner intentionally left without membership.
      resolvedOwnerAnomalies.push({ finding: anomaly, decision })
    } else {
      unresolvedOwnerAnomalies.push(anomaly)
    }
  }

  // ── Step 3: orphans only need acknowledgement (exclude) — never create anything ──
  const unresolvedOrphans: OrphanRecord[] = []
  for (const orphan of extraction.orphans) {
    const key = relationKey(orphan.companyId, orphan.uid)
    const lookup = lookupDecision(decisionIndex, usedDecisionKeys, key, orphan.reason, orphan.evidenceFingerprint)
    if (lookup) {
      if (!lookup.fingerprintMatches) { staleDecisions.push(lookup.decision); unresolvedOrphans.push(orphan); continue }
      if (lookup.decision.resolution === 'exclude') { resolvedOrphans.push({ finding: orphan, decision: lookup.decision }); continue } // acknowledged
    }
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
      // Independent audit fixes, 4th round, item 3.1: this finding's
      // evidence is the EXISTING document's own role — if that role
      // changes between when a decision was written and this run, the
      // decision goes stale rather than silently applying to different
      // evidence.
      const evidence = { existingRole: typeof existingData?.role === 'string' ? existingData.role : null }
      const fingerprint = computeFindingFingerprint(evidence)
      const lookup = lookupDecision(decisionIndex, usedDecisionKeys, key, 'existing_membership_conflict', fingerprint)
      if (lookup && lookup.fingerprintMatches && lookup.decision.resolution === 'accept_existing') {
        skipped.push({ companyId: relation.companyId, uid: relation.uid })
        resolvedConflicts.push({ finding: { companyId: relation.companyId, uid: relation.uid, reason: 'existing_membership_conflict', evidenceFingerprint: fingerprint }, decision: lookup.decision })
      } else {
        if (lookup && !lookup.fingerprintMatches) staleDecisions.push(lookup.decision)
        unresolvedConflicts.push({ companyId: relation.companyId, uid: relation.uid, reason: 'existing_membership_conflict', evidenceFingerprint: fingerprint })
      }
    } else {
      // 'invalid' — never resolvable via accept_existing (or any other
      // decision) — no decision is even looked up.
      const evidence = { existingRole: typeof existingData?.role === 'string' ? existingData.role : null }
      unresolvedConflicts.push({ companyId: relation.companyId, uid: relation.uid, reason: 'existing_membership_conflict', evidenceFingerprint: computeFindingFingerprint(evidence) })
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
  // left is only removable via a matching, non-stale user-level `exclude`
  // decision — there is no other way to silently ignore it; the source
  // data must be fixed, or explicitly acknowledged.
  //
  // Independent audit fix #3 (3rd round): a membership document's own
  // schema being strictly valid is NOT enough to "count" here — it must
  // ALSO reference a company that actually exists. A membership dangling
  // under a `companyId` that no longer has a `companies/{companyId}`
  // document must never suppress an unknownUsers entry (that would let a
  // structurally-orphaned relic silently launder a genuinely-unresolved
  // user into looking resolved).
  const uidsWithValidMembership = new Set<string>()
  for (const [key, data] of existingMemberships) {
    const [companyId, uid] = splitRelationKey(key)
    if (!allCompanyIds.has(companyId)) continue
    if (isStrictlyValidActiveMembership(uid, data)) uidsWithValidMembership.add(uid)
  }
  function resolveUserLevel<T extends { uid: string; reason: FindingType; evidenceFingerprint: string }>(
    records: readonly T[],
    resolvedOut: { finding: T; decision: Decision }[],
  ): T[] {
    return records.filter(r => {
      const lookup = lookupDecision(decisionIndex, usedDecisionKeys, `user-level:${r.uid}`, r.reason, r.evidenceFingerprint)
      if (!lookup) return true
      if (!lookup.fingerprintMatches) { staleDecisions.push(lookup.decision); return true }
      if (lookup.decision.resolution === 'exclude') { resolvedOut.push({ finding: r, decision: lookup.decision }); return false }
      return true
    })
  }
  const unknownUsers: UnknownUserRecord[] = resolveUserLevel(
    extraction.unknownUsers.filter(u => !uidsWithValidMembership.has(u.uid)),
    resolvedUnknownUsers,
  )
  const malformedClaims: MalformedClaimRecord[] = resolveUserLevel(extraction.malformedClaims, resolvedMalformedClaims)

  // ── Step 7: existing-membership integrity — dangling documents ALWAYS blocking ──
  // Independent audit fix #3 (3rd round; follow-up correction after the
  // 3rd-round review flagged a fail-open in the first version of this
  // step). An EXISTING `companies/{companyId}/members/{uid}` document that
  // is strictly valid on its OWN schema (right shape, real Timestamps,
  // known role, active status) but references a company or user that does
  // not exist is dangling data — the document PHYSICALLY EXISTS in
  // Firestore regardless of anything this run's decisions say. No decision
  // of any kind is consulted — see DanglingMembershipRecord's doc comment.
  const danglingMemberships: DanglingMembershipRecord[] = []
  for (const [key, data] of existingMemberships) {
    const [companyId, uid] = splitRelationKey(key)
    if (!isStrictlyValidActiveMembership(uid, data)) continue // already untrusted on its own — not this step's concern
    const companyExists = allCompanyIds.has(companyId)
    const userExists = allUserIds.has(uid)
    if (companyExists && userExists) continue
    const reason: DanglingMembershipReason = companyExists ? 'existing_membership_missing_user' : 'existing_membership_missing_company'
    danglingMemberships.push({ companyId, uid, reason, evidenceFingerprint: computeFindingFingerprint({}) })
  }

  // ── Step 8: owner-id anomalies — ALWAYS blocking, never decision-resolvable ──
  // See OwnerIdAnomalyRecord's doc comment (types.ts) — no decision is ever
  // looked up for these.
  const ownerIdAnomalies = extraction.ownerIdAnomalies

  // ── Step 9: unused decisions — provided but never matched by ANY current finding ──
  // Independent audit fixes, 4th round, item 3.1 ("неиспользованные...
  // decisions должны блокировать apply и явно попадать в приватный отчёт").
  const unusedDecisions: Decision[] = []
  for (const [key, decision] of decisionIndex) {
    if (!usedDecisionKeys.has(key)) unusedDecisions.push(decision)
  }

  const applyAllowed =
    unresolvedConflicts.length === 0 &&
    unresolvedOrphans.length === 0 &&
    unresolvedOwnerAnomalies.length === 0 &&
    companiesWithoutAdmin.length === 0 &&
    unknownUsers.length === 0 &&
    malformedClaims.length === 0 &&
    danglingMemberships.length === 0 &&
    ownerIdAnomalies.length === 0 &&
    staleDecisions.length === 0 &&
    unusedDecisions.length === 0

  return {
    // Independent audit fix #4 (3rd round): `(a.companyId + a.uid).localeCompare(...)`
    // collides whenever one identifier's suffix matches the other's prefix
    // — e.g. companyId='a',uid='bc' and companyId='ab',uid='c' both
    // concatenate to "abc", making the two entries indistinguishable to the
    // comparator (non-deterministic relative order). `sortRelations()`
    // (checksum.ts) is the existing, already-proven collision-free
    // comparator — an actual two-field (companyId, then uid) comparison.
    plannedCreates: sortRelations(plannedCreates),
    skipped: sortRelations(skipped),
    unresolvedConflicts,
    unresolvedOrphans,
    unresolvedOwnerAnomalies,
    companiesWithoutAdmin,
    unknownUsers,
    malformedClaims,
    danglingMemberships,
    ownerIdAnomalies,
    staleDecisions,
    unusedDecisions,
    resolvedConflicts,
    resolvedOrphans,
    resolvedOwnerAnomalies,
    resolvedUnknownUsers,
    resolvedMalformedClaims,
    applyAllowed,
  }
}
