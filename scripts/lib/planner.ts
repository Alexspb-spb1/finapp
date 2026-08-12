// Combines legacy extraction + manual decisions + existing membership
// documents + existing active-admin counts into a final, deterministic
// apply plan — SEC-005. Pure function, no Firestore I/O.
import { relationKey, type LegacyExtractionResult, type Decision, type PlanResult, type PlannedCreate, type ConflictRecord, type OrphanRecord, type OwnerAnomalyRecord } from './types.ts'
import { classifyExistingMembership } from './membershipValidation.ts'

export interface BuildPlanParams {
  extraction: LegacyExtractionResult
  decisions: readonly Decision[]
  /** key = relationKey(companyId, uid); undefined/absent key = no existing doc. */
  existingMemberships: ReadonlyMap<string, Record<string, unknown>>
  /** companyId -> uids with an EXISTING valid active admin membership (independent of anything this run plans to create). */
  existingActiveAdmins: ReadonlyMap<string, ReadonlySet<string>>
}

export function buildPlan(params: BuildPlanParams): PlanResult {
  const { extraction, decisions, existingMemberships, existingActiveAdmins } = params
  const decisionByKey = new Map(decisions.map(d => [relationKey(d.companyId, d.uid), d]))

  const confirmed = new Map(extraction.confirmed.map(r => [relationKey(r.companyId, r.uid), r]))
  const unresolvedConflicts: ConflictRecord[] = []
  const skipped: { companyId: string; uid: string }[] = []

  // ── Step 1: resolve legacy-source conflicts via decisions ──────────────
  for (const conflict of extraction.conflicts) {
    const key = relationKey(conflict.companyId, conflict.uid)
    const decision = decisionByKey.get(key)
    if (!decision) { unresolvedConflicts.push(conflict); continue }

    if (decision.resolution === 'confirm_role' && decision.role) {
      confirmed.set(key, { companyId: conflict.companyId, uid: conflict.uid, role: decision.role, sources: [] })
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
      confirmed.set(key, { companyId: anomaly.companyId, uid: anomaly.uid, role: decision.role, sources: [] })
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
  const plannedCreates: PlannedCreate[] = []
  for (const relation of confirmed.values()) {
    const key = relationKey(relation.companyId, relation.uid)
    const existingData = existingMemberships.get(key)
    const classification = classifyExistingMembership(relation.role, relation.uid, existingData)

    if (classification === 'not_found') {
      plannedCreates.push({ companyId: relation.companyId, uid: relation.uid, role: relation.role, status: 'active' })
    } else if (classification === 'exact_match') {
      skipped.push({ companyId: relation.companyId, uid: relation.uid })
    } else {
      const decision = decisionByKey.get(key)
      if (decision && decision.resolution === 'accept_existing') {
        skipped.push({ companyId: relation.companyId, uid: relation.uid })
      } else {
        unresolvedConflicts.push({ companyId: relation.companyId, uid: relation.uid, reason: 'existing_membership_conflict' })
      }
    }
  }

  // ── Step 5: last-admin-per-company gate on the PROJECTED final state ───
  // Deliberately scoped to companies that have at least one CONFIRMED
  // relation (i.e. a real company doc this run is actually establishing
  // membership for) — orphans reference a company that doesn't even exist,
  // so they must never enter this gate.
  const touchedCompanyIds = new Set<string>()
  for (const r of confirmed.values()) touchedCompanyIds.add(r.companyId)

  const companiesWithoutAdmin: string[] = []
  for (const companyId of touchedCompanyIds) {
    const existingAdmins = existingActiveAdmins.get(companyId)
    const hasExistingAdmin = !!existingAdmins && existingAdmins.size > 0
    const hasPlannedAdmin = plannedCreates.some(c => c.companyId === companyId && c.role === 'admin')
    if (!hasExistingAdmin && !hasPlannedAdmin) companiesWithoutAdmin.push(companyId)
  }
  companiesWithoutAdmin.sort()

  const applyAllowed =
    unresolvedConflicts.length === 0 &&
    unresolvedOrphans.length === 0 &&
    unresolvedOwnerAnomalies.length === 0 &&
    companiesWithoutAdmin.length === 0

  return {
    plannedCreates: plannedCreates.sort((a, b) => (a.companyId + a.uid).localeCompare(b.companyId + b.uid)),
    skipped: skipped.sort((a, b) => (a.companyId + a.uid).localeCompare(b.companyId + b.uid)),
    unresolvedConflicts,
    unresolvedOrphans,
    unresolvedOwnerAnomalies,
    companiesWithoutAdmin,
    applyAllowed,
  }
}
