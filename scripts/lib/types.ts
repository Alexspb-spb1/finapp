// Shared types for the SEC-005 membership backfill tool.
//
// Canonical target document — matches docs/adr/001-company-membership-and-roles.md
// and src/schemas/auth.ts / functions/src/schemas/auth.ts MembershipSchema
// field-for-field. This module intentionally does NOT import those schemas
// (scripts/ is a standalone root-level tool, not the client bundle or the
// functions/ package) — the shape is kept in sync by contract, documented
// in docs/migrations/MEMBERSHIP_BACKFILL.md.

export const KNOWN_ROLES = ['viewer', 'accountant', 'admin'] as const
export type Role = (typeof KNOWN_ROLES)[number]

export function isKnownRole(value: unknown): value is Role {
  return typeof value === 'string' && (KNOWN_ROLES as readonly string[]).includes(value)
}

/** Raw users/{uid} document as read from Firestore — untrusted, possibly malformed. */
export interface RawUserDoc {
  docId: string
  data: Record<string, unknown>
}

/** Raw companies/{companyId} document as read from Firestore — untrusted. */
export interface RawCompanyDoc {
  docId: string
  data: Record<string, unknown>
}

/** Raw companies/{companyId}/members/{uid} document as read from Firestore. */
export interface RawMembershipDoc {
  companyId: string
  uid: string
  data: Record<string, unknown>
}

/** One (companyId, uid) pair with a role claim, and where that claim came from. */
export type RelationSourceKind = 'users.home' | 'users.companies[]' | 'companies.ownerId'

export interface RelationSource {
  kind: RelationSourceKind
  role: Role
}

// Built via String.fromCharCode (not a literal in source) so the exact
// delimiter character is unambiguous no matter how this file is edited or
// re-encoded — two ASCII colons, never producible by a Firestore document ID.
const RELATION_KEY_DELIMITER = String.fromCharCode(58, 58)

/** A relation pair key with an explicit, unambiguous delimiter — companyId
 * and uid can never collide across it. Always use this (and splitRelationKey)
 * rather than hand-building "companyId+uid" strings. */
export function relationKey(companyId: string, uid: string): string {
  return companyId + RELATION_KEY_DELIMITER + uid
}

export function splitRelationKey(key: string): [companyId: string, uid: string] {
  const parts = key.split(RELATION_KEY_DELIMITER)
  return [parts[0] ?? '', parts[1] ?? '']
}

export interface ConfirmedRelation {
  companyId: string
  uid: string
  role: Role
  sources: RelationSourceKind[]
}

export type ConflictReason =
  | 'role_mismatch'
  | 'invalid_role'
  | 'user_id_mismatch'
  | 'owner_role_not_admin'
  | 'existing_membership_conflict'

export interface ConflictRecord {
  companyId: string
  uid: string
  reason: ConflictReason
  /** Distinct role claims observed (only for role_mismatch); never includes free-text field values beyond the enum itself. */
  observedRoles?: string[]
}

export type OrphanReason = 'missing_company' | 'missing_user'

export interface OrphanRecord {
  companyId: string
  uid: string
  reason: OrphanReason
}

export interface OwnerAnomalyRecord {
  companyId: string
  uid: string
  reason: 'owner_without_admin_membership'
}

/** Output of the pure legacy-mapping stage — before decisions/existing-membership reconciliation. */
export interface LegacyExtractionResult {
  confirmed: ConfirmedRelation[]
  conflicts: ConflictRecord[]
  orphans: OrphanRecord[]
  ownerAnomalies: OwnerAnomalyRecord[]
}

// ── Manual decisions ────────────────────────────────────────────────────────

export type DecisionResolution = 'confirm_role' | 'accept_existing' | 'exclude'

export interface Decision {
  uid: string
  companyId: string
  resolution: DecisionResolution
  reason: string
  reviewedBy: string
  reviewedAt: string
  /** Required only when resolution === 'confirm_role'. */
  role?: Role
}

// ── Existing membership documents (already in Firestore) ───────────────────

export type ExistingMembershipClassification = 'exact_match' | 'differs'

export interface ExistingMembershipCheck {
  companyId: string
  uid: string
  classification: ExistingMembershipClassification
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export interface PlannedCreate {
  companyId: string
  uid: string
  role: Role
  status: 'active'
  invitedBy?: string
}

export interface PlanResult {
  plannedCreates: PlannedCreate[]
  skipped: { companyId: string; uid: string }[]
  unresolvedConflicts: ConflictRecord[]
  unresolvedOrphans: OrphanRecord[]
  unresolvedOwnerAnomalies: OwnerAnomalyRecord[]
  /** Companies whose PROJECTED final state (existing active admins + planned admin creates) has zero active admin. */
  companiesWithoutAdmin: string[]
  /** True only when the plan may safely proceed to apply. */
  applyAllowed: boolean
}
