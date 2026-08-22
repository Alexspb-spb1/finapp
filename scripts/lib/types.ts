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

// Independent audit (2nd round) fix #6: a hand-built delimiter — even a
// carefully chosen one like "::" — is never truly collision-free, because
// companyId/uid come from untrusted legacy Firestore data and can contain
// ANY string content, including the delimiter itself, embedded NUL bytes,
// whitespace, or arbitrary Unicode. `relationKey('co::a', 'u1')` and
// `relationKey('co', ':a::u1')` must never be able to produce the same key.
//
// JSON.stringify of a 2-element string tuple is collision-free BY
// CONSTRUCTION: JSON string encoding escapes every character that could
// make the array boundary ambiguous (quotes, backslashes, control
// characters), so two different (companyId, uid) pairs can never serialize
// to the same JSON text. splitRelationKey() strictly re-validates the
// parsed shape (exactly a 2-element string array) rather than trusting it.
export function relationKey(companyId: string, uid: string): string {
  return JSON.stringify([companyId, uid])
}

export function splitRelationKey(key: string): [companyId: string, uid: string] {
  let parsed: unknown
  try {
    parsed = JSON.parse(key)
  } catch {
    throw new Error(`splitRelationKey: not a valid relation key (invalid JSON): ${key}`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw new Error(`splitRelationKey: not a valid relation key (expected a 2-element string tuple): ${key}`)
  }
  return [parsed[0], parsed[1]]
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
  | 'mixed_role_validity'
  | 'user_id_mismatch'
  | 'owner_role_not_admin'
  | 'existing_membership_conflict'

export interface ConflictRecord {
  companyId: string
  uid: string
  reason: ConflictReason
  /** Distinct KNOWN role claims observed (role_mismatch, mixed_role_validity,
   * owner_role_not_admin); never includes free-text field values beyond the
   * enum itself. */
  observedRoles?: string[]
  /** True when at least one claim contributing to this conflict had a role
   * value that failed `isKnownRole()` (invalid_role, mixed_role_validity) —
   * a safe boolean flag, deliberately never the raw invalid value itself
   * (independent audit fixes, 4th round, item 3.3/3.4). */
  hasInvalidRole?: boolean
  /** Sorted, deduplicated legacy-claim source kinds that produced this
   * conflict (role_mismatch, invalid_role, mixed_role_validity,
   * user_id_mismatch) — absent for owner_role_not_admin/
   * existing_membership_conflict, which are not legacy-claim-sourced in the
   * same sense. Independent audit fixes, 4th round, item 3.3. */
  sourceKinds?: RelationSourceKind[]
  /** Deterministic fingerprint of the normalized evidence above — see
   * checksum.ts's computeFindingFingerprint(). A decision only ever applies
   * to a finding whose (companyId, uid, reason, evidenceFingerprint) all
   * match exactly (independent audit fixes, 4th round, item 3.1). */
  evidenceFingerprint: string
}

export type OrphanReason = 'missing_company' | 'missing_user'

export interface OrphanRecord {
  companyId: string
  uid: string
  reason: OrphanReason
  /** Sorted, deduplicated source kinds whose claim(s) referenced the
   * missing company/user — `missing_user` (via companies.ownerId) is always
   * exactly `['companies.ownerId']`; `missing_company` is `['users.home']`,
   * `['users.companies[]']`, or both. Independent audit fixes, 4th round,
   * item 3.3 — previously discarded entirely at orphan-creation time. */
  sourceKinds: RelationSourceKind[]
  evidenceFingerprint: string
}

export interface OwnerAnomalyRecord {
  companyId: string
  uid: string
  reason: 'owner_without_admin_membership'
  evidenceFingerprint: string
}

/** A users/{uid} document with NO usable legacy relation claim at all (no
 * valid `companyId`/`companies[]` entry could even be attempted) — reported
 * so it is never silently invisible. Independent audit fix #6. */
export interface UnknownUserRecord {
  uid: string
  reason: 'no_usable_relations'
  evidenceFingerprint: string
}

/** A `users/{uid}` source container that is corrupted or unusable in a way
 * that must never be silently ignored, even when the SAME user document
 * simultaneously has another usable, valid relation claim (independent
 * audit fixes, 4th round, item 3.4):
 *   - `malformed_companies_entry` — one `companies[]` array entry is not an
 *     object, or has no usable `companyId` (pre-existing).
 *   - `companies_field_not_array` — `users/{uid}.companies` is PRESENT but
 *     not an array at all (previously silently ignored in its entirety).
 *   - `malformed_company_id` — `users/{uid}.companyId` is PRESENT but not a
 *     non-empty string (previously silently ignored — no claim, no record). */
export type MalformedClaimReason = 'malformed_companies_entry' | 'companies_field_not_array' | 'malformed_company_id'

export interface MalformedClaimRecord {
  uid: string
  reason: MalformedClaimReason
  evidenceFingerprint: string
}

/** `companies/{companyId}.ownerId` is PRESENT but not a non-empty string —
 * previously silently ignored (`if (!isNonEmptyString(ownerId)) continue`
 * treated "absent" and "present-but-corrupt" identically). Deliberately
 * NEVER decision-resolvable — same treatment as `DanglingMembershipRecord`:
 * there is no reliable uid to attach a decision to (the very field that
 * would identify one is what's corrupted), so the only way to clear this is
 * to repair `companies/{companyId}.ownerId` itself. Independent audit
 * fixes, 4th round, item 3.4. */
export type OwnerIdAnomalyReason = 'malformed_owner_id'

export interface OwnerIdAnomalyRecord {
  companyId: string
  reason: OwnerIdAnomalyReason
  evidenceFingerprint: string
}

/** The full space of finding "kinds" a manual decision can be bound to —
 * exactly the union of every `.reason` value produced across the record
 * types above, which are mutually disjoint string literals by construction.
 * Independent audit fixes, 4th round, item 3.1: a decision must specify
 * EXACTLY which finding type it resolves, so an `exclude` recorded for one
 * finding type (e.g. `missing_company`) can never silently apply to an
 * unrelated, later finding for the same (companyId, uid) pair (e.g. a
 * `role_mismatch` that appears once the company starts existing). */
export type FindingType = OrphanReason | ConflictReason | 'owner_without_admin_membership' | 'no_usable_relations' | MalformedClaimReason | OwnerIdAnomalyReason

/** Independent audit fix #3 (3rd round, follow-up correction): an EXISTING
 * `companies/{companyId}/members/{uid}` document that is strictly valid on
 * its OWN schema but references a company or user that does not actually
 * exist right now. Deliberately a SEPARATE type/reason space from
 * `OrphanRecord`/`OrphanReason` — a legacy-source orphan describes a claim
 * that was never migrated (nothing physically exists yet, and an `exclude`
 * decision legitimately closes the matter forever). A dangling membership
 * describes a document that DOES physically exist in Firestore right now;
 * no decision — relation-level or user-level — can ever make that document
 * stop existing, so none may acknowledge this away. It remains blocking
 * for as long as the document itself is not externally repaired/removed
 * (see planner.ts, "Step 7"). */
export type DanglingMembershipReason = 'existing_membership_missing_company' | 'existing_membership_missing_user'

export interface DanglingMembershipRecord {
  companyId: string
  uid: string
  reason: DanglingMembershipReason
  evidenceFingerprint: string
}

/** Output of the pure legacy-mapping stage — before decisions/existing-membership reconciliation. */
export interface LegacyExtractionResult {
  confirmed: ConfirmedRelation[]
  conflicts: ConflictRecord[]
  orphans: OrphanRecord[]
  ownerAnomalies: OwnerAnomalyRecord[]
  unknownUsers: UnknownUserRecord[]
  malformedClaims: MalformedClaimRecord[]
  /** Independent audit fixes, 4th round, item 3.4 — always blocking, never
   * decision-resolvable (see OwnerIdAnomalyRecord doc comment). */
  ownerIdAnomalies: OwnerIdAnomalyRecord[]
}

// ── Manual decisions ────────────────────────────────────────────────────────

export type DecisionResolution = 'confirm_role' | 'accept_existing' | 'exclude'

/** Which `DecisionResolution`s are even semantically meaningful for a given
 * `FindingType` — independent audit fixes, 4th round, item 3.1 ("`exclude`
 * для `missing_company` не может разрешать `role_mismatch`... `confirm_role`
 * и `accept_existing` должны разрешаться только для совместимых типов
 * finding"). Enforced both when validating a decisions file (decisions.ts)
 * and, redundantly and independently, at the point a decision is actually
 * applied (planner.ts) — a decision file that somehow slipped an
 * incompatible pairing past validateDecisions() can still never be honored
 * by buildPlan(). */
export const COMPATIBLE_RESOLUTIONS: Record<FindingType, readonly DecisionResolution[]> = {
  missing_company: ['exclude'],
  missing_user: ['exclude'],
  role_mismatch: ['confirm_role', 'exclude'],
  invalid_role: ['confirm_role', 'exclude'],
  mixed_role_validity: ['confirm_role', 'exclude'],
  user_id_mismatch: ['confirm_role', 'exclude'],
  owner_role_not_admin: ['confirm_role', 'exclude'],
  existing_membership_conflict: ['accept_existing', 'exclude'],
  owner_without_admin_membership: ['confirm_role', 'exclude'],
  no_usable_relations: ['exclude'],
  malformed_companies_entry: ['exclude'],
  companies_field_not_array: ['exclude'],
  malformed_company_id: ['exclude'],
  malformed_owner_id: [], // never decision-resolvable — see OwnerIdAnomalyRecord
}

export interface Decision {
  uid: string
  /** Omitted ONLY for a "user-level" decision (independent audit 2nd round
   * fix #3) — acknowledges an `unknownUsers`/`malformedClaims` entry, which
   * is keyed by uid alone (no companyId exists to target). A companyId-less
   * decision must have `resolution === 'exclude'` — `confirm_role` and
   * `accept_existing` always require a specific (companyId, uid) relation. */
  companyId?: string
  /** EXACTLY which finding this decision resolves — independent audit
   * fixes, 4th round, item 3.1. Required on every decision (no default,
   * no inference from `resolution` alone). */
  findingType: FindingType
  /** Must exactly equal the CURRENT finding's own `evidenceFingerprint`
   * (see e.g. `OrphanRecord.evidenceFingerprint`) for this decision to be
   * honored — independent audit fixes, 4th round, item 3.1. A stale
   * fingerprint (evidence changed since the decision was written) makes the
   * decision inert; it is then reported as `staleDecisions` and blocks
   * apply rather than being silently dropped. */
  evidenceFingerprint: string
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
  /** UNRESOLVED users with no usable legacy claim AND no existing valid
   * canonical membership anywhere. Independent audit fix #6 (1st round)
   * surfaced these; independent audit fix #3 (2nd round) made them
   * BLOCKING — apply/verify may not proceed while this is non-empty. A
   * user-level `exclude` decision (Decision with no `companyId`, matching
   * `uid`) acknowledges and removes an entry from this list. */
  unknownUsers: UnknownUserRecord[]
  /** UNRESOLVED malformed `companies[]` entries — same blocking/acknowledgement
   * model as `unknownUsers` above (2nd round fix #3). */
  malformedClaims: MalformedClaimRecord[]
  /** EXISTING membership documents that are strictly valid on their own
   * schema but reference a company or user that does not exist —
   * unconditionally blocking, NEVER decision-resolvable (3rd round
   * follow-up fix). See DanglingMembershipRecord for why this is a
   * separate list from `unresolvedOrphans` rather than reusing it. */
  danglingMemberships: DanglingMembershipRecord[]
  /** Independent audit fixes, 4th round, item 3.4 — always blocking, never
   * decision-resolvable. */
  ownerIdAnomalies: OwnerIdAnomalyRecord[]
  /** Decisions whose (identity, findingType) matched a CURRENT finding but
   * whose `evidenceFingerprint` did NOT — the evidence changed since the
   * decision was written (role/reason/source-kind/etc.), so the decision is
   * inert and the underlying finding stays unresolved. Independent audit
   * fixes, 4th round, item 3.1/3.2 (scenario 2). Always blocking — a stale
   * decision can never silently apply to different evidence. */
  staleDecisions: Decision[]
  /** Decisions that matched NO current finding at all (identity+findingType
   * absent from this run's extraction/plan) — e.g. the underlying problem
   * was already fixed, or the decision targets a typo'd/nonexistent pair.
   * Independent audit fixes, 4th round, item 3.1 ("неиспользованные...
   * decisions должны блокировать apply и явно попадать в приватный
   * отчёт") — always blocking, never silently ignored. */
  unusedDecisions: Decision[]
  /** True only when the plan may safely proceed to apply. */
  applyAllowed: boolean
}
