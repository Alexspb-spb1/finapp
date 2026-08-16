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

/** A users/{uid} document with NO usable legacy relation claim at all (no
 * valid `companyId`/`companies[]` entry could even be attempted) — reported
 * so it is never silently invisible. Independent audit fix #6. */
export interface UnknownUserRecord {
  uid: string
  reason: 'no_usable_relations'
}

/** A `users/{uid}.companies[]` array entry that could not even be parsed
 * into a claim (not an object, or missing a usable `companyId`) — reported
 * rather than silently dropped. Independent audit fix #6. */
export interface MalformedClaimRecord {
  uid: string
  reason: 'malformed_companies_entry'
}

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
}

/** Output of the pure legacy-mapping stage — before decisions/existing-membership reconciliation. */
export interface LegacyExtractionResult {
  confirmed: ConfirmedRelation[]
  conflicts: ConflictRecord[]
  orphans: OrphanRecord[]
  ownerAnomalies: OwnerAnomalyRecord[]
  unknownUsers: UnknownUserRecord[]
  malformedClaims: MalformedClaimRecord[]
}

// ── Manual decisions ────────────────────────────────────────────────────────

export type DecisionResolution = 'confirm_role' | 'accept_existing' | 'exclude'

export interface Decision {
  uid: string
  /** Omitted ONLY for a "user-level" decision (independent audit 2nd round
   * fix #3) — acknowledges an `unknownUsers`/`malformedClaims` entry, which
   * is keyed by uid alone (no companyId exists to target). A companyId-less
   * decision must have `resolution === 'exclude'` — `confirm_role` and
   * `accept_existing` always require a specific (companyId, uid) relation. */
  companyId?: string
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
  /** True only when the plan may safely proceed to apply. */
  applyAllowed: boolean
}
