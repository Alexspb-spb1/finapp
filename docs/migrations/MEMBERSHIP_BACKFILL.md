# Membership backfill — SEC-005

Migrates legacy `users/{uid}.role` / `users/{uid}.companyId` /
`users/{uid}.companies[]` / `companies/{companyId}.ownerId` into the
canonical `companies/{companyId}/members/{uid}` documents defined by
[ADR-001](../adr/001-company-membership-and-roles.md).

Tool: `scripts/backfill-memberships.ts` (root devDependency `firebase-admin`,
run directly via Node's native TypeScript support — no build step, no
`ts-node`, no `functions/node_modules`).

**Status of this document**: describes the tool as implemented and verified
against the **Firestore Emulator**, and now also verified end-to-end
against real **staging** (`finapp-staging`) — a full dry-run → decisions →
apply → verify → rollback rehearsal was executed using synthetic fixture
data under an explicit `STAGING_FIXTURE_ACTION_APPROVED: SEC-005` grant,
and `finapp-staging` was confirmed fully restored to its pre-rehearsal
empty state afterward — see "Staging authorization" and "Full staging
rehearsal" below. **Production execution is NOT unconditionally refused
anymore.** The repository owner has granted `PRODUCTION_ACTION_APPROVED:
SEC-005`, and the cycle-execution gate (`assertCycleExecutionAllowed()`)
was widened accordingly to authorize the full controlled production
cycle — see "Production execution" below for the current gate state, and
the "Independent audit fixes — production execution gate round" /
"— production execution gate audit-fix round" changelog sections near
the end for exactly what changed and when. **No individual production
step (maintenance enable, backup, apply, verify, disable, or rollback)
has actually been run yet** — only two READ-ONLY production dry-runs have
executed, each under its own separate, narrower grant (see
`docs/remediation/reports/SEC-005.md`); the gate being open in code is a
precondition for a real execution, not the execution itself, and a
SEPARATE, explicit owner command is still required before any individual
step runs.

**This document was updated after an independent review returned
`REVIEW_RESULT: CHANGES REQUIRED`** — see "Independent audit fixes" near the
end for the 7 categories of fixes applied. The sections above/below that
already reflect the fixed behavior (existing-membership classification,
path-safety scope, rollback precondition, partial-write-failure proof).

**This document was updated a SECOND time after a follow-up independent
review, also `REVIEW_RESULT: CHANGES REQUIRED`** — see "Independent audit
fixes — second round" at the very end for the 7 additional categories fixed
(verify strictness, real Timestamp enforcement, blocking unknown
users/malformed claims, confirm_role re-validation, full decisionsChecksum,
collision-free relationKey, schema-strict observed state). Every section
below already reflects this second round's fixed behavior.

**This document was updated a THIRD time after a follow-up independent
review, also `REVIEW_RESULT: CHANGES REQUIRED`** — see "Independent audit
fixes — third round" at the very end for the 4 additional categories fixed
(rollback manifest pair-set completeness, durable post-create accounting
via WriteResult, existing-membership integrity against missing
companies/users, collision-free plannedCreates/skipped ordering). Every
section below already reflects this third round's fixed behavior.

**This document was updated a FOURTH time to correct a fail-open found in
the third round's own fix** — see "Independent audit fixes —
dangling-memberships correction" at the very end, and "Dangling existing
memberships" below, for the corrected (and now authoritative) behavior:
NO decision can ever clear a dangling existing membership from blocking
`apply`/`verify` — only repairing the underlying data can.

**This document was updated a FIFTH time to record staging authorization**
— see "Staging authorization" below. The repository owner granted
`EXTERNAL_ACTION_APPROVED: SEC-005` / `ENVIRONMENT: staging`; the CLI's
cycle-execution gate (`assertCycleExecutionAllowed()`,
`scripts/lib/firebaseAdmin.ts`) now lets `--environment staging` proceed.
Production is unaffected — still refused unconditionally.

**This document was updated a SIXTH time (doc-only) to record a full
staging rehearsal** — see "Full staging rehearsal" at the end, and the new
"`verify` requires the same `--decisions-file` as `apply`" operational
rule in "Idempotency" below. The repository owner granted a separate,
broader authorization, `STAGING_FIXTURE_ACTION_APPROVED: SEC-005`
("Разрешаю создать и удалить только синтетические тестовые данные в
finapp-staging для полной репетиции. Production запрещён."), covering
create+delete of synthetic fixture data for a full dry-run/apply/
verify/rollback cycle against `finapp-staging`. No code changed this
round.

**This document was updated a SEVENTH time to correct the production
preflight design after an independent review found 9 categories of
blocking issues** in an earlier, never-committed preflight (delivered only
in chat) — see "Production mode-specific requirements", "Production
rollback — `import` is not an exact rollback", "Emergency scenario: lost
apply-report", "Maintenance/read-only mode", "Restore verification —
members collection group", and the corrected "Future production
execution" section below, plus `docs/remediation/reports/SEC-005.md`,
section "Исправления production preflight по итогам независимого
ревью", for the full technical writeup. Summary: the backup command now
includes the `members` collection group; `import` is no longer called an
exact rollback; a real maintenance/read-only mechanism (Firestore Rules +
an explicit Admin SDK check in `createCompany`) replaces the previously
proposed "accept the risk window"; the `ROLLBACK_REFERENCE` scheme is now
two-phase (pre-apply: an existing dry-run report cross-checked by
checksum; post-apply: the apply report's own SHA-256, printed
separately); `--backup-reference`/`--rollback-reference`/
`--ack-maintenance-readonly` are now really verified
(`scripts/lib/productionSafety.ts`), not just checked for presence.
**The production gate (`assertCycleExecutionAllowed`) is unchanged and
still refuses `production` unconditionally** — nothing in this round
weakens it. Production was not read or modified at any point in this
round.

**This document was updated an EIGHTH time after `PRODUCTION_PREFLIGHT_APPROVED:
SEC-005` opened the gate for `--mode dry-run` only**, and after two
subsequent, separately-authorized READ-ONLY production dry-runs actually
ran against `finapp-prod-10a83` — see "Production preflight authorization"
below and `docs/remediation/reports/SEC-005.md` for the anonymized
results. `apply`/`verify`/`rollback-from-report`/`rollback-from-plan`
remained refused for production throughout this round.

**This document was updated a NINTH time after `PRODUCTION_ACTION_APPROVED:
SEC-005` opened the gate for the FULL SEC-005 action set** (dry-run,
apply, verify, rollback-from-report, rollback-from-plan,
maintenance-enable, maintenance-disable) — see "Production execution"
below, "Independent audit fixes — production execution gate round", and
"— production execution gate audit-fix round" (an independent review's
follow-up fixes to that round — import-safety of the maintenance
transaction module, fail-closed `--disable` on an unverifiable `enabled`
field, no-repeated-CLI-flags, and several corrected runbook claims,
including this banner) near the end. **No individual production
apply/verify/maintenance/rollback step has actually been executed** — see
the "Status of this document" paragraph above for the current, accurate
summary.

## Data model — legacy → canonical mapping

| Legacy source | Canonical target |
|---|---|
| `users/{uid}.companyId` + `users/{uid}.role` | one `companies/{companyId}/members/{uid}` candidate (`role` from `.role`) |
| `users/{uid}.companies[]` entries `{companyId, role}` | one candidate per entry |
| `companies/{companyId}.ownerId` | a *signal*, not a source — see "Owner handling" below |

No other fields are ever read from `users/{uid}` or `companies/{companyId}`.
`uid` is always the `users/{uid}` document ID; `companyId` is always the
`companies/{companyId}` document ID that a legacy field references. The
canonical document created is always:

```ts
{
  uid: string
  role: 'viewer' | 'accountant' | 'admin'
  status: 'active'
  createdAt: Timestamp   // server-assigned at apply time
  updatedAt: Timestamp   // server-assigned at apply time
  // invitedBy is NEVER invented — omitted unless a decision explicitly supplies it
}
```

## Confirmed / conflict / orphan / owner-anomaly definitions

- **Confirmed relation** — every valid-role claim found for a `(companyId, uid)`
  pair agrees on the same role (including a single claim). Duplicate sources
  with the *same* role are deduplicated, not treated as a conflict.
- **Conflict** — a `(companyId, uid)` pair that cannot be safely migrated
  without a human decision:
  - `role_mismatch` — two+ **valid** roles claimed for the same pair.
  - `invalid_role` — every claim for the pair has an unknown/empty/corrupt
    role value. **Never defaulted** — an invalid role is dropped, never
    coerced to `viewer` or anything else.
  - `mixed_role_validity` — a `(companyId, uid)` pair has BOTH a valid-role
    claim and an invalid-role claim from different sources — never silently
    resolved via the valid claim alone.
  - `user_id_mismatch` — `users/{uid}.id` is present and does not equal the
    document ID, AND the referenced company exists. Every claim whose
    company does NOT exist is a `missing_company` **orphan** instead (2nd
    round fix #4) — this matters because a `confirm_role` decision can
    resolve a conflict but can never create a membership under a company
    that does not exist, so keeping such a claim classified as a orphan is
    what makes that structurally impossible rather than merely discouraged.
    An id-mismatched document with NO usable claims at all is reported as
    an `unknownUsers` entry rather than silently disappearing.
  - `owner_role_not_admin` — `companies/{companyId}.ownerId` has a confirmed
    membership claim, but it is not `admin`.
  - `existing_membership_conflict` — an existing
    `companies/{companyId}/members/{uid}` document exists and is **not** an
    exact match. This includes both cases: the document is strictly valid
    but has a *different* role (`differs_but_valid`), or it fails strict
    validation entirely — unknown role, `status !== 'active'`, uid mismatch,
    missing/malformed timestamps, or extra/unexpected fields
    (`invalid`, `scripts/lib/membershipValidation.ts`). **Only the
    `differs_but_valid` case may ever be resolved by an `accept_existing`
    decision** — an `invalid` existing document remains a blocking conflict
    regardless of decision (see "Independent audit fixes" below).
- **Orphan** — a `(companyId, uid)` LEGACY CLAIM (from `users/{uid}` or
  `companies/{companyId}.ownerId`) that references something that doesn't
  exist. Nothing has been migrated yet for an orphan — there is no
  document in Firestore at stake, only a claim that will never become one:
  - `missing_company` — a legacy field names a `companyId` with no
    `companies/{companyId}` document.
  - `missing_user` — `companies/{companyId}.ownerId` names a uid with no
    `users/{uid}` document.
  Orphans are **never** turned into a membership — "excluded without a
  record" per the task's rule 8 means no membership document is ever
  created for them, but the orphan itself IS recorded in the report and
  still requires an `exclude` decision before `apply` will proceed (a
  deliberate extra safety gate: every orphan must be human-reviewed once,
  even though the outcome — no membership — never changes). This
  decision-resolvable contract is unchanged and applies ONLY to legacy
  claims — see "Dangling existing memberships" below for the structurally
  different case of a document that already physically exists.

## Dangling existing memberships (never decision-resolvable)

A **dangling existing membership** is a different, structurally stronger
problem than an orphan: an ALREADY-EXISTING
`companies/{companyId}/members/{uid}` document — one that is strictly
schema-valid on its own (right shape, real Timestamps, known role, active
status) — but whose `companyId` or `uid` does not exist right now
(`isStrictlyValidActiveMembership()` only ever checks the document's own
fields; it says nothing about whether its parent company or referenced
user still exist). Unlike an orphan, this document is REAL and PHYSICALLY
PRESENT in Firestore.

Reported as `DanglingMembershipRecord` (`companyId`, `uid`, `reason`:
`'existing_membership_missing_company'` | `'existing_membership_missing_user'`)
in its own report field, `danglingMemberships` — a completely separate
list from `orphans`, so the two behaviors can never be confused by a
report reader or by the code:

- **No decision of any kind — relation-level (`companyId`+`uid`) or
  user-level (`uid` only) — can ever clear an entry from this list.**
  `apply` and `verify` both refuse (non-zero exit, `applyAllowed: false`,
  `verification.matchesTarget: false`) for as long as ANY dangling
  membership exists, regardless of what a decisions file says.
- The only way to stop this from blocking is to actually **repair the
  underlying data** — create the missing `companies/{companyId}` or
  `users/{uid}` document, or delete the dangling membership document
  itself — outside this tool, before the next run. The next `dry-run`/
  `apply`/`verify` will then simply not observe it as dangling anymore,
  because the check re-derives from live Firestore state every run; it is
  never a persisted "acknowledged" flag.
- A dangling admin membership never satisfies the last-admin gate for a
  real company (`computeExistingActiveAdmins()` requires the uid to exist
  in `allUserIds`), and a dangling membership under a missing company
  never suppresses an `unknownUsers` entry for that uid
  (`allCompanyIds` is checked before a membership counts as coverage) —
  both of these checks read company/user existence directly from live
  Firestore state and are completely independent of `danglingMemberships`
  or any decision.

(This corrects an earlier version of this tool where a dangling membership
was reported as an ordinary, decision-resolvable orphan — a relation-level
`exclude` decision could remove it from the orphan listing even though the
document itself remained in Firestore, which meant `applyAllowed`/`verify`
could report success while a corrupted document was still present. See
"Independent audit fixes" below, the dangling-memberships correction, for
the full history.)
- **Owner anomaly** (`owner_without_admin_membership`) — the company's
  `ownerId` has NO membership claim at all for that company. The owner is
  **never** auto-granted admin — this only surfaces the case for a manual
  decision.

## Owner (`ownerId`) handling — exact rules

`ownerId` is a *signal to check*, never a source of authorization on its
own (ADR-001, "ownerId semantics"):

1. Owner has a confirmed `admin` membership claim → accepted, no anomaly.
2. Owner has a confirmed **non-admin** membership claim → `owner_role_not_admin`
   **conflict** (never silently upgraded to admin).
3. Owner has no membership claim at all, but a `users/{uid}` doc exists →
   `owner_without_admin_membership` **anomaly**.
4. Owner uid has no `users/{uid}` doc at all → `missing_user` **orphan**.

## Decisions file

Passed via `--decisions-file /absolute/path/outside/this/repository.json` —
**never** committed to Git (see ".gitignore" below). JSON array of:

```json
[
  {
    "uid": "REDACTED_UID",
    "companyId": "REDACTED_COMPANY_ID",
    "findingType": "role_mismatch",
    "evidenceFingerprint": "<64-hex-char SHA-256 — copy from the CURRENT dry-run report's matching conflicts[] entry>",
    "resolution": "confirm_role",
    "role": "admin",
    "reason": "Confirmed with company owner via support ticket #1234 on 2026-01-15.",
    "reviewedBy": "alice@example.test",
    "reviewedAt": "2026-01-15T10:00:00.000Z"
  },
  {
    "uid": "REDACTED_UID_2",
    "companyId": "REDACTED_COMPANY_ID_2",
    "findingType": "missing_company",
    "evidenceFingerprint": "<64-hex-char SHA-256 — from the CURRENT dry-run report's matching orphans[] entry>",
    "resolution": "exclude",
    "reason": "Former contractor, access intentionally not migrated.",
    "reviewedBy": "alice@example.test",
    "reviewedAt": "2026-01-15T10:05:00.000Z"
  },
  {
    "uid": "REDACTED_UID_3",
    "findingType": "no_usable_relations",
    "evidenceFingerprint": "<64-hex-char SHA-256 — from the CURRENT dry-run report's matching unknownUsers[] entry>",
    "resolution": "exclude",
    "reason": "Confirmed dead account with support — has no companyId/companies[] claim at all, safe to leave unmigrated.",
    "reviewedBy": "alice@example.test",
    "reviewedAt": "2026-01-15T10:10:00.000Z"
  }
]
```

**Changed in the 4th independent-audit round (finding-bound decisions —
see "Independent audit fixes — 4th round" at the end of this document for
the full rationale): every decision now MUST specify `findingType` (exactly
which kind of finding it resolves — one of `OrphanReason`/`ConflictReason`/
`'owner_without_admin_membership'`/`'no_usable_relations'`/
`MalformedClaimReason`, see `scripts/lib/types.ts`'s `FindingType`) and
`evidenceFingerprint` (a 64-hex-char SHA-256, copied verbatim from the
matching entry's own `evidenceFingerprint` field in the CURRENT dry-run
report — every `conflicts`/`orphans`/`ownerAnomalies`/`unknownUsers`/
`malformedClaims` entry in the report now carries this field). A decision
only ever applies when `(companyId, uid)` (or `uid` alone for a user-level
decision), `findingType`, AND `evidenceFingerprint` ALL match the current
finding exactly — an old decisions file written against a v1-schema report
(before this round) has neither field and MUST be recreated against a
fresh dry-run's v2 report.**

The third entry above has **no `companyId` at all** — a "user-level"
decision (2nd round fix #3). This is the ONLY way to acknowledge an
`unknownUsers` or `malformedClaims` entry, both of which are keyed by `uid`
alone (there is no `companyId` to target — the whole point of those two
lists is that no usable relation claim could even be extracted). A
companyId-less decision MUST have `resolution: "exclude"` — `confirm_role`
and `accept_existing` always require a specific `(companyId, uid)` relation
and are rejected by `scripts/lib/decisions.ts` if `companyId` is omitted.

Resolutions — now gated per-`findingType` by `COMPATIBLE_RESOLUTIONS`
(`scripts/lib/types.ts`), enforced independently at BOTH decisions-file
validation time (`scripts/lib/decisions.ts`) AND again defensively inside
`buildPlan()` (`scripts/lib/planner.ts`) at the moment a decision is
actually applied:
- `confirm_role` — requires `role` (`viewer`|`accountant`|`admin`) AND a
  `companyId`. Compatible `findingType`s: `role_mismatch`, `invalid_role`,
  `mixed_role_validity`, `user_id_mismatch`, `owner_role_not_admin`.
  Resolves a conflict or owner anomaly by creating that membership — but
  ONLY after re-verifying, at the moment the decision is applied, that BOTH
  the target company and the target user still exist (`scripts/lib/planner.ts`,
  `confirmRoleTargetExists()`, 2nd round fix #4). **Cannot** target an
  orphan (`missing_company`/`missing_user`) — a decision can never create a
  missing company or user; `COMPATIBLE_RESOLUTIONS['missing_company']` is
  `['exclude']` only, enforced structurally (4th round).
- `accept_existing` — the ONLY compatible `findingType` is
  `existing_membership_conflict`, and only when the underlying document is
  `differs_but_valid` (a strictly-schema-valid, active document with merely
  a different role): treats the existing document as canonical; nothing is
  written. Its evidence is `{ existingRole }` — the existing document's own
  role at the moment the finding was produced; if that role changes before
  `apply` runs, the decision's `evidenceFingerprint` no longer matches and
  it goes stale (see "stale decisions" below). **Never** resolves an
  `invalid` existing document (unknown role, disabled/non-active status,
  uid mismatch, missing timestamps, or extra fields) — that stays a
  blocking conflict no matter what the decision says (no decision is even
  looked up for an `invalid` classification).
- `exclude` — acknowledges a conflict/orphan/owner-anomaly (with a
  `companyId`); no membership is ever created for that pair. WITHOUT a
  `companyId`, acknowledges a user-level `unknownUsers`/`malformedClaims`
  entry instead (2nd round fix #3) — the only resolution valid in that form.
  Compatible with every `findingType` except `malformed_owner_id`, which is
  NEVER decision-resolvable at all (`COMPATIBLE_RESOLUTIONS['malformed_owner_id']
  === []`) — same treatment as a dangling membership (see below): the
  corrupted `companies/{companyId}.ownerId` field is the only thing that
  would identify a target, so there is no reliable identity to attach a
  decision to; the field itself must be repaired.

**Stale and unused decisions (4th round) are now BLOCKING, reported
explicitly, and never silently dropped:**
- A **stale** decision is one whose `(companyId, uid)`/`uid` and
  `findingType` matched a CURRENT finding, but whose `evidenceFingerprint`
  did NOT — the underlying evidence (role, source kind, existing document's
  role, etc.) changed since the decision was written. The finding stays
  unresolved, and the decision is listed in the report's `staleDecisions`
  (`counts.staleDecisions`).
- An **unused** decision is one that matched NO current finding at all
  (e.g. the underlying problem was already fixed, or the target was
  mistyped). Listed in `unusedDecisions` (`counts.unusedDecisions`).
- Both make `applyAllowed: false` (and therefore block `apply`/`verify`)
  until the decisions file is corrected — either by re-deriving a fresh
  `evidenceFingerprint` from the current dry-run report (stale case) or by
  removing the decision entirely (unused case).

Validation (`scripts/lib/decisions.ts`) rejects, with no permissive
fallback: non-array input, unknown fields, unknown `resolution`/`role`/
`findingType` values, a `resolution` incompatible with the given
`findingType`, a non-hex-64 `evidenceFingerprint`, missing required fields
(now including `findingType`/`evidenceFingerprint`), an unparseable
`reviewedAt`, a `findingType`/`companyId` mismatch (company-scoped finding
types require `companyId`; user-level ones forbid it), and
duplicate/contradicting decisions for the same `(companyId, uid,
findingType)` triple (or the same `(uid, findingType)` for two user-level
decisions — a separate namespace from relation-level pairs, so a user-level
and a relation-level decision for the SAME uid never collide; the SAME
`(companyId, uid)` MAY carry decisions for two DIFFERENT `findingType`s).
`--decisions-file`'s SHA-256 (over the canonicalized, order-independent
decision list, now including `findingType`/`evidenceFingerprint` — see
"Checksums" below) is recorded in every report as `decisionsChecksum`, so a
report can always be tied back to exactly which decisions produced it
without the decisions file itself ever being committed.

## CLI reference

```text
node scripts/backfill-memberships.ts \
  --mode dry-run|apply|verify|rollback-from-report|rollback-from-plan (default: dry-run)
  --environment emulator|staging|production           (REQUIRED, no default)
  --project <project-id>                               (REQUIRED, no default)
  --confirm-project <project-id>                        (staging/production only, exact match required)
  --decisions-file /absolute/path/outside/repo.json     (optional)
  --report-path /absolute/path/outside/repo/report.json (REQUIRED)
  --from-report /absolute/path/to/an/apply-report.json  (rollback-from-report only)
  --expected-report-sha256 <64-hex-char SHA-256>        (rollback-from-report only, REQUIRED)
  --from-plan /absolute/path/to/a/dry-run-report.json   (rollback-from-plan only)
  --expected-plan-sha256 <64-hex-char SHA-256>          (rollback-from-plan only, REQUIRED)
  --ack-emergency-reconstruction                        (rollback-from-plan only, REQUIRED)
  --backup-reference /absolute/path/to/backup-manifest.json    (production apply only)
  --rollback-reference /absolute/path/to/a/dry-run-report.json (production apply only)
  --expected-plan-sha256 <64-hex-char SHA-256>          (rollback-from-plan REQUIRED; production apply REQUIRED as of the 4th independent-audit round — verified against --rollback-reference's raw bytes before any parsing)
  --ack-maintenance-readonly                                    (production apply/rollback-from-report/rollback-from-plan only)
```

`--apply` is a convenience alias for `--mode apply`. **Every flag — value-
bearing or boolean — may be given at most once** (4th round, item 3.7):
`--mode` and `--apply` together, a repeated `--mode`, or a repeated
security-sensitive/path/hash/reference flag is refused outright as
ambiguous (`scripts/lib/cli.ts`) — there is no "last argument wins"
anywhere in this parser.

### Production mode-specific requirements

**Corrected four times after independent review.** An earlier,
never-committed preflight used a single blanket check
(`backup-reference`/`rollback-reference`/`ack-maintenance` required for
ANY non-`verify` production mode) — fixed in the first preflight-safety
round. A follow-up review then found `rollback-from-report` had no
integrity check on `--from-report` itself, and the "lost apply-report"
emergency scenario had no real recovery path — both fixed
(`--expected-report-sha256`, `rollback-from-plan`) in the final round. A
SECOND follow-up review of that same final round found `rollback-from-plan`
itself had no equivalent integrity check on `--from-plan` — fixed
(`--expected-plan-sha256`). A THIRD follow-up review then found that
`rollback-from-plan`'s new integrity check was itself checked AFTER the
maintenance-mode check (a real Firestore read) rather than before — fixed
below by reordering. **Production execution gate round**: none of the
per-flag requirements in the table below changed — they are the
independent protections `apply`/`rollback-from-report`/`rollback-from-plan`
must ALWAYS pass, regardless of the cycle gate's own state. What changed
is the cycle gate itself (`assertCycleExecutionAllowed()`,
`scripts/lib/firebaseAdmin.ts`): production is now authorized for every
mode in this table, under `PRODUCTION_ACTION_APPROVED: SEC-005` — see
"Maintenance/read-only mode" above for the equivalent change to
`maintenance-enable`/`maintenance-disable`. The actual per-mode
requirements, implemented in `scripts/backfill-memberships.ts`,
`scripts/lib/productionSafety.ts`, and
`scripts/lib/emergencyReconstruction.ts`:

| Mode | `--backup-reference` | `--rollback-reference` | `--ack-maintenance-readonly` | `--expected-report-sha256` | `--expected-plan-sha256` | `--ack-emergency-reconstruction` | Maintenance mode checked live? |
|---|---|---|---|---|---|---|---|
| `dry-run` | not required | not required | not required | n/a | n/a | n/a | no — dry-run writes nothing |
| `apply` | **required, strictly verified** (`verifyBackupReference` — see "Backup reference verification" below) | **required, strictly verified in two phases: Phase A (`verifyRollbackPlanFileIntegrity`) reads `--rollback-reference`'s raw bytes, checks their SHA-256 against `--expected-plan-sha256` BEFORE any JSON parsing, and only THEN — once the hash matches — parses the JSON and structurally validates it; both the hash check and the subsequent parsing/validation complete before any credential acquisition or Firestore I/O. Phase B (`matchRollbackPlanAgainstCurrent`), called only after Phase A succeeds, then compares `sourceGitSha`/`sourceChecksum`/`sourceStateChecksum`/`decisionsChecksum`/`targetChecksum` AND `plannedCreates` (direct structural comparison, not just checksums) — all five values (the source Git revision plus four checksums) plus `plannedCreates` must exactly match this run's own values** (see "Two-phase ROLLBACK_REFERENCE" below) | required | n/a | **required** — checked FIRST, before JSON parsing/credential acquisition/Firestore I/O | n/a | **yes, checked FIRST** (`assertMaintenanceModeActive` — its `enabledAt` anchors the backup-freshness check; fail-closed) |
| `verify` | not required | not required | not required | n/a | n/a | n/a | no — verify only reads |
| `rollback-from-report` | not required | not required | required | **required** — verified against `--from-report`'s actual bytes BEFORE any parsing/I/O | n/a | n/a | **yes** (`assertMaintenanceModeActive`, fail-closed) |
| `rollback-from-plan` | not required | not required | required | n/a | **required, checked FIRST** — verified against `--from-plan`'s actual bytes, and the plan structurally validated, BEFORE `assertMaintenanceModeActive()` or any candidate read/delete (final-round fix #1, third pass — see `runEmergencyReconstruction()`, `scripts/lib/emergencyReconstruction.ts`) | **required** — explicit acknowledgement this is the degraded, last-resort path | **yes, checked AFTER the hash/structure checks above** (`assertMaintenanceModeActive`, fail-closed) |

Any production-safety check failing for `apply`/`rollback-from-report`/
`rollback-from-plan` refuses BEFORE the first write/delete (exit 3 for a
verification failure; the `--expected-report-sha256`/`--expected-plan-sha256`
integrity checks also refuse with exit 3, checked before even parsing
`--from-report`/`--from-plan` as JSON) — the same exit code family as the
project-ID guards below, since this is the same class of "precondition
not met" failure.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (dry-run always; apply with 0 write failures; verify matching target) |
| 1 | Apply refused (unresolved items, including unknown users/malformed claims) or had write failures; verify found drift OR the plan was not fully resolved (2nd round fix #1 — `matchesTarget` requires `plan.applyAllowed` too, not just checksum equality); rollback/rollback-from-plan had refused deletions |
| 2 | CLI argument error, decisions-file error, or a structurally invalid `--from-report`/`--from-plan` (wrong schema, wrong mode, unresolved dry-run, etc.) |
| 3 | Environment/project guard failure (wrong project, missing confirmation, etc.), a production-safety precondition failed (unverifiable backup/rollback reference, maintenance mode not active), OR `--from-report` does not match `--expected-report-sha256` (tampered/wrong/swapped report — checked before any parsing) |
| 4 | Refused: the cycle-execution gate (`assertCycleExecutionAllowed()`) does not authorize this (environment, action) pair. As of the production execution gate round (`PRODUCTION_ACTION_APPROVED: SEC-005`), production is authorized for all five `ReportMode`s — since `--mode`/`--apply` are themselves restricted to known values by argument parsing (exit 2 otherwise), exit 4 is no longer reachable for `--environment production` via any value the CLI accepts; it remains the gate's genuine refusal code, defense-in-depth against an internal/unrecognized action value. `staging`/`emulator` are authorized for every action, same as before. |

### Environment/project guards (enforced BEFORE any credential acquisition or Firestore read)

| Environment | Required `--project` | Extra requirement |
|---|---|---|
| `emulator` | `demo-finapp` | `FIRESTORE_EMULATOR_HOST` must be set |
| `staging` | `finapp-staging` | `--confirm-project finapp-staging` (exact match) |
| `production` | `finapp-prod-10a83` | `--confirm-project finapp-prod-10a83`; for `apply`/`rollback-from-report` specifically, the mode-specific requirements above (verified backup/rollback references, maintenance mode) |

A mismatch between `--project` and `GCLOUD_PROJECT`/`GOOGLE_CLOUD_PROJECT`
is refused immediately, before any credential is acquired. Production is
never a default — `--environment` and `--project` have no defaults at all.
The Admin SDK resolves credentials itself (Application Default
Credentials); this tool never reads or logs a service-account file.

**Cycle-scoped execution authorization** (`assertCycleExecutionAllowed()`,
`scripts/lib/firebaseAdmin.ts`) is a SEPARATE gate from the project-ID
consistency table above — it decides whether THIS remediation cycle is
allowed to run against a given external environment AT ALL, independent of
whether the flags are individually well-formed. `--environment emulator`
and `--environment staging` are both currently allowed to proceed past
this gate for ANY mode (staging under the `EXTERNAL_ACTION_APPROVED:
SEC-005` / `ENVIRONMENT: staging` grant — see "Staging authorization"
below).

**Current state (production execution gate round —
`PRODUCTION_ACTION_APPROVED: SEC-005`): `--environment production` is
allowed past this gate for all seven `CycleExecutionAction` values** —
`dry-run`, `apply`, `verify`, `rollback-from-report`,
`rollback-from-plan`, `maintenance-enable`, `maintenance-disable`
(`scripts/lib/firebaseAdmin.ts`'s `PRODUCTION_ALLOWED_ACTIONS`). This
supersedes the earlier `PRODUCTION_PREFLIGHT_APPROVED: SEC-005` grant,
which authorized only `dry-run` (see "Production preflight authorization"
below for that grant's history and what was actually run under it — two
read-only dry-runs, both before this wider grant).

This gate answers only "has ANY grant authorized this (environment,
action) pair THIS cycle" — it is independent of, and does not substitute
for, the mode-specific safety preconditions enforced elsewhere in this
tool for `apply`/`rollback-from-report`/`rollback-from-plan` (verified
backup/rollback references, live maintenance-mode check, two-phase
rollback-plan integrity verification, create-only writes). Those
preconditions still apply in full and are unaffected by this gate being
open. Passing this gate is necessary but not sufficient to actually run
`apply` (or any other production action) successfully.

**A real production execution (maintenance enable → verified backup →
apply → verify → maintenance disable, or an emergency rollback) still
requires a SEPARATE, explicit command from the repository owner naming
the specific action to run** — this gate being open in the code is a
precondition, not the authorization itself. See "Production execution"
below.

## Emulator walkthrough (safe — run this)

```bash
# Terminal 1
npm run firebase:emulators

# Terminal 2 — seed via the Emulator UI (http://127.0.0.1:4000) or any script,
# then:
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/backfill-memberships.ts \
  --environment emulator --project demo-finapp \
  --report-path /tmp/sec005-dry-run.json

# Review /tmp/sec005-dry-run.json, resolve conflicts in a decisions file, then:
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/backfill-memberships.ts \
  --environment emulator --project demo-finapp --apply \
  --decisions-file /tmp/sec005-decisions.json \
  --report-path /tmp/sec005-apply.json

# apply prints (for EVERY environment, not just production — final-round
# fix #5, second round):
#   Apply report SHA-256 (record this as the ROLLBACK_REFERENCE for this run): <sha256 hex>
# Copy that value — --expected-report-sha256 below requires it exactly.
# If you didn't capture the printed line, recompute it yourself instead of
# guessing: `sha256sum /tmp/sec005-apply.json` (Linux/macOS) or
# `Get-FileHash /tmp/sec005-apply.json -Algorithm SHA256` (PowerShell) — both
# must match scripts/lib/checksum.ts's sha256Hex() exactly (SHA-256 over the
# raw file bytes, lowercase hex).

# Verify:
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/backfill-memberships.ts \
  --environment emulator --project demo-finapp --mode verify \
  --decisions-file /tmp/sec005-decisions.json \
  --report-path /tmp/sec005-verify.json

# Rollback (emulator only, in this cycle) — --expected-report-sha256 is
# REQUIRED for every environment, not just production:
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/backfill-memberships.ts \
  --environment emulator --project demo-finapp --mode rollback-from-report \
  --from-report /tmp/sec005-apply.json \
  --expected-report-sha256 <the SHA-256 printed by apply above> \
  --report-path /tmp/sec005-rollback.json
```

`npm run test:migration` runs the full automated proof of this flow
(`firebase emulators:exec --project demo-finapp --only firestore "vitest run
scripts --no-file-parallelism"` — `--no-file-parallelism` is required
because two emulator-backed test files independently wipe the SAME shared
`demo-finapp` project in their own `beforeEach` hooks; see "Independent
audit fixes — production preflight, final round" for why).

## Staging authorization (EXTERNAL_ACTION_APPROVED: SEC-005 / ENVIRONMENT: staging)

The repository owner granted `EXTERNAL_ACTION_APPROVED: SEC-005` /
`ENVIRONMENT: staging`. `--environment staging` now proceeds past the
cycle-execution gate (`assertCycleExecutionAllowed()`); the project-ID
consistency guards in the table above are unchanged and still apply in
full.

**Originally, only `--mode dry-run` was authorized under this specific
grant** — the owner could review real anonymized counts/checksums before
deciding whether to authorize `apply`. **Updated**: a separate, broader
grant, `STAGING_FIXTURE_ACTION_APPROVED: SEC-005`, was given afterward,
explicitly authorizing `apply`/`rollback` against `finapp-staging` for
SYNTHETIC fixture data only, for a full rehearsal — see "Full staging
rehearsal" below for what was actually run. `apply` against real
(non-synthetic) legacy data in `finapp-staging` is still NOT authorized —
neither grant covers that.

```bash
node scripts/backfill-memberships.ts \
  --environment staging --project finapp-staging --confirm-project finapp-staging \
  --mode dry-run --report-path /absolute/path/outside/repo/sec005-staging-dry-run.json
```

The full report (written only to the absolute, outside-the-repo
`--report-path` above) contains uid/companyId and is never committed,
never printed to stdout, and never pasted into a session transcript —
see "No PII in Git" below. Only the safe aggregate summary that
`printSafeSummary()` prints to stdout (mode, environment, projectId,
counts, checksums — no identifiers) is safe to share/quote.

Once `apply` for staging IS separately authorized, the same
`--environment staging --project finapp-staging --confirm-project
finapp-staging` flags apply, after reviewing the dry-run report and
preparing a decisions file for every conflict/orphan/owner-anomaly it
found:

```bash
node scripts/backfill-memberships.ts \
  --environment staging --project finapp-staging --confirm-project finapp-staging \
  --apply --decisions-file /absolute/path/outside/repo/sec005-staging-decisions.json \
  --report-path /absolute/path/outside/repo/sec005-staging-apply.json
```

## Production preflight authorization (PRODUCTION_PREFLIGHT_APPROVED: SEC-005)

The repository owner granted:

```text
PRODUCTION_PREFLIGHT_APPROVED: SEC-005 — разрешаю deploy maintenance-защиты,
создание и проверку backup и read-only dry-run в finapp-prod-10a83.
Backfill/apply пока запрещён.
```

This is narrower than, and distinct from, CLAUDE.md §5's
`PRODUCTION_ACTION_APPROVED` grant (which would additionally require a
verified `BACKUP_REFERENCE`/`ROLLBACK_REFERENCE` and would authorize
`apply` itself). It covers exactly three actions against real production
infrastructure, in this order:

1. **Deploy** the already-emulator-tested maintenance-mode-aware
   `firestore.rules` and `functions` (the `isMaintenanceModeActive()`
   Rules gate and `createCompany`'s `requireNotInMaintenanceMode()`
   check) to `finapp-prod-10a83`.
2. **Create and verify** a real production backup (`gcloud firestore
   export`, including `members`, restored to an isolated project and
   checksum-verified) — producing a VERIFICATION-ONLY manifest with
   independently verified counts/checksums; NOT valid as an
   `--backup-reference` for `apply` (see below for why).
3. **Run `--mode dry-run`** against `finapp-prod-10a83` — read-only,
   writes nothing.

`apply`/backfill remains explicitly forbidden by this grant
("Backfill/apply пока запрещён") — this is NOT
`PRODUCTION_ACTION_APPROVED`, and does not authorize creating a single
`companies/{companyId}/members/{uid}` document in production.

**Maintenance mode is deliberately NOT enabled under this grant.** None of
the three authorized actions require it: `gcloud firestore export` doesn't
consult it, backup verification happens entirely in an isolated restore
project, and `--mode dry-run` never checks maintenance mode live (see
"Production mode-specific requirements" above — only `apply`/
`rollback-from-report`/`rollback-from-plan` do). Enabling
`system/maintenance` would have a real effect on live production users
(blocking client Firestore writes and `createCompany`) that this grant
did not explicitly request, so it was treated as out of scope for this
round.

**Code change enabling this, AT THE TIME OF THIS GRANT**: `assertCycleExecutionAllowed()`
(`scripts/lib/firebaseAdmin.ts`) allowed `environment === 'production'`
to proceed past the cycle-execution gate ONLY when `mode === 'dry-run'` —
every other production mode (`apply`, `verify`, `rollback-from-report`,
`rollback-from-plan`) remained unconditionally refused. This code change
was the ONLY thing this specific round actually did — deploy, backup
creation/verification, and the real production dry-run itself each
required their own separate go-ahead and were not performed as part of
THIS round. **Superseded by the production execution gate round** (see
that changelog section near the end of this document): a later, broader
`PRODUCTION_ACTION_APPROVED: SEC-005` grant opened the gate for the full
SEC-005 action set — see "Production execution" above for the current
state. See "Environment/project guards" above and
`docs/remediation/reports/SEC-005.md` for the full technical writeup and
history.

**The backup created under this grant is verification-only — it can
NEVER be used as `--backup-reference` for a future `apply`.** Two
independent reasons: (1) `MAX_BACKUP_AGE_MS` (24h) will almost certainly
have elapsed by the time a separate `PRODUCTION_ACTION_APPROVED` round
for `apply` is authorized; (2) `verifyBackupReference()` requires
`createdAtUtc >= system/maintenance.enabledAt`, and maintenance mode is
deliberately not enabled under this grant, so this backup has no valid
`enabledAt` to satisfy that check against. A future `apply` will require
its OWN fresh backup, taken AFTER maintenance mode has been separately
authorized and enabled — see "Production execution" below for
that full sequence. This preflight's backup exists solely to prove the
export → import → checksum-verify → manifest mechanism works end-to-end
against real production data.

## Production execution (PRODUCTION_ACTION_APPROVED: SEC-005 — gate open, execution pending a separate command)

`PRODUCTION_ACTION_APPROVED: SEC-005` has been granted by the repository
owner, covering a controlled production cycle: maintenance enable →
verified backup → create-only apply against a verified resolved plan →
verify → maintenance disable → rollback-from-report/rollback-from-plan as
the emergency path. **The production execution gate round** (see the
changelog section of that name at the end of this document) opened
`assertCycleExecutionAllowed()` (`scripts/lib/firebaseAdmin.ts`) for
exactly these actions in production — the `apply`/rollback/maintenance
commands below are, as of that round, no longer refused by the cycle gate
itself.

**This is a code/test/documentation preparation round only — no step
below has actually been executed against real production.** The owner's
grant explicitly separates "prepare the gate" from "execute a specific
step", requiring its own distinct command before ANY of maintenance
enable, backup creation, apply, verify, maintenance disable, or rollback
actually runs. Two READ-ONLY production dry-runs (Step 5a-equivalent) have
been executed, each under its own explicit, narrower grant — see
`docs/remediation/reports/SEC-005.md` for their anonymized results and
exact scope. This section documents the exact intended flow for the
REMAINING (apply/rollback) steps, corrected after independent review (see
the changelog note at the top of this document), ready to run once each
step's own execution command is given.

**Step order corrected after independent review (final round).** An
earlier draft of this section ran backup BEFORE enabling maintenance mode
— meaning the backup could capture a snapshot while clients could still
be writing. The corrected order below moves maintenance mode to BEFORE
backup, and adds the separate Rules/Functions deploy as its own explicit
first step (item 8):

### Step 1 — maintenance-mode-aware Rules and Functions (prerequisite already verified — do not redeploy without separate authorization)

`firestore.rules`'s `isMaintenanceModeActive()` gate and
`functions/src/lib/authz.ts`'s `requireNotInMaintenanceMode()` check
inside `createCompany` (both implemented and emulator-tested in this
repository) only take effect once actually deployed to the production
Firebase project. **This deploy already happened and was independently
verified during the production preflight** (see "Production preflight
authorization" below for the grant it ran under and how it was verified
live against `finapp-prod-10a83`) — it is a completed prerequisite check
for this cycle, not an open step.

**Do not re-run `firebase deploy` as part of this cycle.** A deploy is
its own separate, explicitly-authorized action under CLAUDE.md §5,
independent of this migration cycle's `PRODUCTION_ACTION_APPROVED:
SEC-005` grant — that grant covers the maintenance/backup/apply/verify/
rollback cycle described below, not a Rules/Functions redeploy. If the
deployed Rules/Functions are ever suspected to be stale or reverted,
STOP and request a separate deploy authorization rather than assuming
Steps 2 onward are safe to proceed with.

### Step 2 — confirm `system/maintenance` is in a known, disabled state (read-only precheck)

```bash
node scripts/ops/set-maintenance-mode.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --disable --task-id SEC-005 --operator <your-identifier>
```

**This is a precheck, not a bootstrap.** `--disable` against a
`system/maintenance` document that does not exist is a safe,
**idempotent no-op** — it returns `changed: false` and does **not**
create `{enabled: false}` or any other document (see
"Maintenance/read-only mode" below, and
`scripts/ops/maintenanceModeTransaction.ts`'s `transactionalDisable()`).

**Read this step's result before doing anything else. It is a decision
point, not a formality:**

- **Non-zero exit code → STOP.** Do not proceed to Step 3. Something
  other than a clean no-op or a clean disable happened (e.g. the record
  belongs to a different task — see `scripts/ops/maintenanceModeCli.ts`'s
  exit codes) and must be understood before touching production further.
- **`changed: true` → STOP, even though the exit code is 0.** This means
  the command found an ALREADY-ENABLED `system/maintenance` record for
  `taskId: SEC-005` and just transactionally disabled it. An enabled
  SEC-005 maintenance record at the START of a new cycle — before this
  cycle's own Step 3 has run — can only mean a PREVIOUS SEC-005
  production cycle left it enabled: that cycle may have stopped after
  `enable` or after `apply` but before `verify`/`disable` (Step 7/Step 8
  never ran). **Do not start a new cycle on top of an unexplained
  previous one.** Before doing anything else:
  1. Check `docs/remediation/reports/SEC-005.md`'s production-actions log
     for the most recent production cycle and its recorded outcome.
  2. Check whether a prior `apply` report, `verify` report, or rollback
     record exists for that cycle (absolute paths outside this
     repository, per "Production execution" above) and inspect them.
  3. Establish, and record in `docs/remediation/reports/SEC-005.md`,
     whether that prior cycle's `apply` ran, whether `verify` confirmed
     the migrated state, and whether it was left mid-cycle or genuinely
     abandoned.
  4. Only once that prior cycle's outcome is established and recorded may
     a new cycle begin — and only under its own fresh authorization from
     the repository owner, the same as any other production action.
- **`changed: false` → safe to proceed to Step 3.** This is the only
  outcome that requires no further investigation: either the document
  never existed, or it already existed disabled for `taskId: SEC-005` —
  both mean no unexplained prior cycle is currently holding maintenance
  mode active.

### Step 3 — enable maintenance mode (BEFORE backup — see "Maintenance/read-only mode" below)

```bash
node scripts/ops/set-maintenance-mode.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --enable --reason "SEC-005 membership backfill" --task-id SEC-005 --operator <your-identifier>
```

**Must happen BEFORE Step 4 (backup)** — a backup taken before maintenance
mode was enabled cannot be trusted as a write-frozen, consistent snapshot,
and `verifyBackupReference()` (Step 6) enforces this ordering
programmatically by comparing the backup manifest's `createdAtUtc`
against this step's `enabledAt`, read live from Firestore at apply time —
not merely documented as a suggested order.

### Step 4 — backup (BASE-003 mechanism, corrected scope)

```bash
gcloud firestore export gs://<backup-bucket>/sec005-prod-backup-<date> \
  --project=finapp-prod-10a83 \
  --collection-ids=users,companies,company_data,members
```

**`members` is now included.** Firestore managed export's
`--collection-ids` matches by collection ID across the WHOLE database —
the same semantics as a `collectionGroup()` query — so `members` in this
list captures every `companies/{companyId}/members/{uid}` document
project-wide, regardless of nesting depth. The BASE-003-derived command
used in an earlier, never-committed draft of this preflight omitted
`members` entirely, which would have made the backup useless for
undoing exactly what this tool's `apply` creates. Record the resulting
manifest (BASE-003.md §6.1 schema, extended per "Backup reference
verification" below) at an absolute path outside the repository — this is
the file `--backup-reference` will point to.

### Step 5 — dry-run / review / resolved dry-run (produces the pre-apply `--rollback-reference`)

**Corrected after independent review (final round, second pass, item 4)** —
a single, decisions-less dry-run cannot become `--rollback-reference`:
`matchRollbackPlanAgainstCurrent()` (Phase B of the two-phase
`--rollback-reference` verification) requires the reference's
`decisionsChecksum` to EXACTLY match apply's own (see "Two-phase
ROLLBACK_REFERENCE" below) — a dry-run run WITHOUT `--decisions-file` has
the EMPTY-array `decisionsChecksum`, which can never match an apply that
actually supplies a real decisions file. The correct sequence has THREE
sub-steps, not one:

**5a. Discovery dry-run** (no `--decisions-file` yet — this is purely to
find what needs a decision):

```bash
node scripts/backfill-memberships.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --mode dry-run --report-path /absolute/path/outside/repo/sec005-prod-discovery-dry-run.json
```

Review the report; prepare `/absolute/path/outside/repo/sec005-prod-decisions.json`
for every conflict/orphan/owner-anomaly it found.

**5b. Resolved dry-run** (the SAME `--decisions-file` apply will use — this
report, not the discovery one, is the actual `--rollback-reference`):

```bash
node scripts/backfill-memberships.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --mode dry-run --decisions-file /absolute/path/outside/repo/sec005-prod-decisions.json \
  --report-path /absolute/path/outside/repo/sec005-prod-resolved-dry-run.json
```

Confirm `counts.unresolved === 0` in this report — if not, the decisions
file is still incomplete; go back to 5a's findings.

**5c. Save this report's SHA-256 — SEPARATELY from the report file itself,
BEFORE `apply` runs.** Needed once explicitly, as `--expected-plan-sha256`,
IF an emergency `rollback-from-plan` is ever needed later (see "Emergency
scenario: apply-report lost" below):

```bash
sha256sum /absolute/path/outside/repo/sec005-prod-resolved-dry-run.json
# or: Get-FileHash ... -Algorithm SHA256   (PowerShell)
```

**Record this value in a location INDEPENDENT of the plan file itself**
— an incident/runbook log, a ticket, a password manager note, anything
that is not simply "another copy sitting next to the plan file on the
same disk". **Corrected after independent review (final round, third
pass, item 2)**: an earlier version of this step allowed recomputing this
hash FROM the surviving plan file itself, after an incident, if the
originally-recorded value was lost. That defeats the entire purpose of
`--expected-plan-sha256` — a hash computed from the very file it is
supposed to validate can never detect that the file was tampered with; it
always "matches itself" by construction, tampered or not. The hash's
value as an integrity check comes ENTIRELY from having been recorded
independently, at a moment (right now, in Step 5c, before any incident)
when the file's own integrity was not in question. If this
independently-recorded value is ever lost or cannot be produced from
anywhere other than the plan file being validated, the correct outcome is
`BLOCKED — требуется действие владельца` (see "If the independently-saved
hash is lost" in "Emergency scenario: apply-report lost" below) — never
"just recompute it from the file you're trying to verify".

This is the value this document calls `<resolved-dry-run-sha256>` below.

### Step 6 — apply

**Uses the SAME `--decisions-file` as Step 5b**, and Step 5b's report
(not Step 5a's) as `--rollback-reference`:

```bash
node scripts/backfill-memberships.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --apply --decisions-file /absolute/path/outside/repo/sec005-prod-decisions.json \
  --report-path /absolute/path/outside/repo/sec005-prod-apply.json \
  --backup-reference /absolute/path/outside/repo/sec005-prod-backup-manifest.json \
  --rollback-reference /absolute/path/outside/repo/sec005-prod-resolved-dry-run.json \
  --expected-plan-sha256 <resolved-dry-run-sha256> \
  --ack-maintenance-readonly
```

Phase A (`verifyRollbackPlanFileIntegrity()`) reads `--rollback-reference`'s
raw bytes and checks their SHA-256 against `--expected-plan-sha256` BEFORE
any JSON parsing; only once that hash matches does it parse the JSON and
structurally validate it. Both the hash check and the subsequent
parsing/validation complete before any credential acquisition or Firestore
I/O. Phase B (`matchRollbackPlanAgainstCurrent()`), called only after
Phase A succeeds, then cross-checks `sourceGitSha`, `sourceChecksum`,
`sourceStateChecksum`, `decisionsChecksum`, AND `targetChecksum` between
this `--rollback-reference` and THIS apply run's own computed values, plus
`plannedCreates` directly — all five values (the source Git revision plus
four checksums) plus `plannedCreates` must match exactly. Using Step 5b's
report with the SAME `--decisions-file` is what makes this possible;
Step 5a's report (or a dry-run with a different/no decisions file) will
be refused here, before any write.

On success, the tool prints (never embeds in the report itself):

```text
Apply report SHA-256 (record this as the ROLLBACK_REFERENCE for this run): <sha256 hex>
```

**Record this hash** — it is both the `ROLLBACK_REFERENCE` AND the
required `--expected-report-sha256` for a subsequent `rollback-from-report`
call, if one is ever needed (see "Two-phase ROLLBACK_REFERENCE" below).

### Step 7 — verify (still BEFORE disabling maintenance mode)

```bash
node scripts/backfill-memberships.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --mode verify --decisions-file /absolute/path/outside/repo/sec005-prod-decisions.json \
  --report-path /absolute/path/outside/repo/sec005-prod-verify.json
```

Use the SAME `--decisions-file` as `apply` (see "Idempotency" above).

### Step 8 — disable maintenance mode (ONLY after verify passes)

```bash
node scripts/ops/set-maintenance-mode.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --disable --task-id SEC-005 --operator <your-identifier>
```

Neither this tool nor `set-maintenance-mode.ts` disables maintenance mode
automatically as a side effect of anything — doing so would risk a window
between `verify` and disabling in which a client could write before the
operator has confirmed the migrated state is correct. This is always a
deliberate, separate manual step.

### Rollback, if needed (see "Production rollback" below for the exact command)

```bash
node scripts/ops/set-maintenance-mode.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --enable --reason "SEC-005 rollback" --task-id SEC-005 --operator <your-identifier>

node scripts/backfill-memberships.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --mode rollback-from-report --from-report /absolute/path/outside/repo/sec005-prod-apply.json \
  --expected-report-sha256 <the SHA-256 printed after apply, Step 6> \
  --report-path /absolute/path/outside/repo/sec005-prod-rollback.json \
  --ack-maintenance-readonly
```

Maintenance mode must be re-enabled (same as Step 3) before running this,
for the same reason it is required before `apply`.

### Step 9 — close the production execution gate (separate PR, after the cycle completes)

**Required after a successful production cycle (or after a completed
rollback) finishes.** Once Steps 1–8 (or the rollback path) have
actually run against production, `PRODUCTION_ALLOWED_ACTIONS` in
`scripts/lib/firebaseAdmin.ts` must be narrowed back down — most likely
to empty, or to only whatever the NEXT authorized production action is
— in a separate PR, so the gate does not stay open for
`apply`/`maintenance-enable`/etc. against production indefinitely after
this cycle's authorized work is done.

**This is an operational process, not a runtime-checked constraint in
the current code.** Nothing in `assertCycleExecutionAllowed()` itself
expires, time-limits, or auto-closes `PRODUCTION_ALLOWED_ACTIONS` after
a cycle completes — it is a static `ReadonlySet` that stays exactly as
wide as the last commit left it until a human edits it again. Treat "the
gate closes after the cycle" as a required follow-up task for whoever
runs Steps 1–8, not as something the code will enforce on its own.

## Backup reference verification

`--backup-reference` (production `apply` only) must point to a local
manifest file matching the BASE-003 schema
(`docs/remediation/reports/BASE-003.md`, §6.1), extended by SEC-005,
verified by `verifyBackupReference()` (`scripts/lib/productionSafety.ts`)
before any write. **Strengthened in the final preflight-safety round**
(independent review items 1 and 3) — the schema now requires a great deal
more than "the file parses and has the right project ID":

- `manifest.productionProjectId === 'finapp-prod-10a83'` — the manifest
  must actually be for this production project, not a stale or
  differently-scoped backup.
- `manifest.createdAtUtc` must be a valid timestamp.
- `manifest.firestore.exportOperationId` must be a non-empty string —
  identifies exactly which `gcloud firestore export` operation produced
  this manifest (traceable to `gcloud firestore operations describe`).
- `manifest.firestore.exportStatus === 'SUCCESS'` — a failed or
  in-progress export can never be used as a backup basis.
- `manifest.firestore.collectionIds` must include `"members"`, OR
  `manifest.firestore.scope === 'full'` — **this is the fix for
  independent-review item 1**: a manifest whose export command omitted the
  `members` collection group (the original, BASE-003-derived command,
  `--collection-ids=users,companies,company_data`, had exactly this gap)
  is rejected outright, with an error message naming "members"/"collection
  group" explicitly.
- `manifest.firestore.membersCount`, `.companiesCount`, `.usersCount`, and
  `.companyDataDocsCount` must each be a non-negative integer — not merely
  present, but a real, well-formed count (a negative number or a `1.5`
  float is refused).
- `manifest.firestore.membersChecksum` must be present as a valid
  64-character hex SHA-256 digest — **strengthened in the final
  preflight-safety round, second pass (item 3)**: the SOURCE (production)
  `members` checksum, computed at export time, so it can be compared
  against the restore's own checksum below (not merely a count, which
  could hide a doc-for-doc substitution with the same total).
- `manifest.restore.verificationResult === 'PASS'` — **this is the fix for
  independent-review item 2**: the backup must have actually been
  restored to an isolated project and verified there (see "Restore
  verification" below), not merely exported. `manifest.restore.membersCount`
  must be a non-negative integer AND equal `manifest.firestore.membersCount`
  (the restore confirmed the SAME count the export claimed — not just any
  count); `manifest.restore.membersChecksum` must ALSO be a valid
  64-character hex SHA-256 digest AND EXACTLY EQUAL
  `manifest.firestore.membersChecksum` (final-round fix #3, second round —
  previously only checked for presence, never actually compared to the
  source checksum); `manifest.restore.verifiedAtUtc` must be a valid
  timestamp AND satisfy `manifest.createdAtUtc <= restore.verifiedAtUtc
  <= nowIso` (final-round fix #4, third pass) — a restore cannot have
  been verified before the backup it restores was even created, and
  cannot have been verified in the future relative to the moment `apply`
  actually runs; either would mean the timestamps are fabricated or
  internally inconsistent, not merely unusual.
- **`manifest.createdAtUtc` must be AT OR AFTER the live, currently-active
  `system/maintenance.enabledAt`** (read via `assertMaintenanceModeActive()`,
  checked BEFORE this function is even called — see "Production
  mode-specific requirements" above) — a backup taken before maintenance
  mode was enabled cannot be trusted as a write-frozen, consistent
  snapshot. This is the mechanism, not just documentation, behind Step 3
  (enable maintenance) coming before Step 4 (backup) in "Future production
  execution" above.
- `manifest.createdAtUtc` must be no older than `MAX_BACKUP_AGE_MS` (24
  hours, `scripts/lib/productionSafety.ts`'s `MAX_BACKUP_AGE_MS`) relative
  to the moment `apply` runs, and not in the future — a stale backup is
  refused, not silently accepted as "good enough".

This is a real content check, not a presence check — passing
`--backup-reference` pointing at an unrelated, failed, un-restored,
`members`-less, stale, or pre-maintenance manifest refuses `apply` (exit
3) before any Firestore write, the same way a missing flag would.

**Recorded in the report's safe audit section (final-round fix #5, third
pass).** On success, `verifyBackupReference()`'s returned `membersChecksum`
(the SOURCE checksum — the SAME value `firestore.membersChecksum` and
`restore.membersChecksum` were just confirmed to exactly equal) is stored
in `report.productionSafety.backupReference.membersChecksum`, alongside
the existing `sha256`/`createdAtUtc`/`membersCount` fields — included in
`printSafeSummary()`'s stdout output like the rest of `productionSafety`.
Its presence there is itself proof the source/restore checksum match
succeeded, not merely an echo of an unverified manifest field.

## Restore verification — members collection group

BASE-003 (`docs/runbooks/BACKUP_AND_RESTORE.md`) already designed and
performed one real restore-to-isolated-project cycle
(`finapp-restore-20260725-4rxl`), verified by matching checksums — that
mechanism is unchanged and not owned by this task. What SEC-005 adds is a
requirement specific to this migration: **any restore performed as part
of, or in preparation for, a SEC-005 production cycle must additionally
verify the `members` collection group**, not just
`users`/`companies`/`company_data`:

1. Confirm the export that produced the backup actually included
   `members` in `--collection-ids` — enforced automatically by
   `verifyBackupReference()`'s required `firestore.membersCount` field
   (see "Backup reference verification" above); a manifest without it can
   never become a valid `--backup-reference` in the first place.
2. After `gcloud firestore import` into an isolated restore project,
   count the restored `companies/*/members/*` documents
   (`gcloud firestore export`'s own collection-group semantics, or a
   simple `collectionGroup('members').count()` read against the restored
   project) and confirm it **equals** `firestore.membersCount` from the
   backup manifest.
3. Compute a SHA-256 checksum over the restored `members` documents using
   the same mechanism this tool already uses for its own checksums
   (`scripts/lib/checksum.ts`'s canonical-JSON + SHA-256 approach), and
   ALSO compute the equivalent checksum over the SOURCE (production)
   `members` documents at export time — record both in the manifest as
   `firestore.membersChecksum` (source) and `restore.membersChecksum`
   (restored). **Strengthened in the final preflight-safety round, second
   pass (item 3)**: `verifyBackupReference()` now requires BOTH to be
   present as valid 64-character hex SHA-256 digests AND requires them to
   be EXACTLY EQUAL — not just a raw count match (which could hide a
   doc-for-doc substitution with the same total), and not just checking
   that `restore.membersChecksum` exists (which could be any value at all
   without ever being compared to the source).
4. This restore-verification procedure is **not automated by this tool**
   in this round — it requires a real GCP project and a real restore
   cycle, which is out of scope for a round explicitly constrained to
   never read or modify production (and a restore-to-isolated-project
   test, while not touching production Firestore data directly, still
   involves real GCP infrastructure this round's authorization does not
   cover). It is documented here as a required manual/scripted runbook
   step, honestly marked as unexecuted in this round — see "Known
   limitations" in `docs/remediation/reports/SEC-005.md` for this round.

## Two-phase ROLLBACK_REFERENCE (closes the circular reference)

An earlier, never-committed preflight draft required `--rollback-reference`
BEFORE `apply`, but the only thing `rollback-from-report` actually consumes
is the path to the apply report — which does not exist yet before `apply`
runs. That is circular.

The resolution splits `ROLLBACK_REFERENCE` into two distinct, non-circular
phases:

1. **Pre-apply** (`--rollback-reference` flag, verified in two phases by
   `scripts/lib/productionSafety.ts`):
   - **Phase A — `verifyRollbackPlanFileIntegrity()`**: reads
     `--rollback-reference`'s raw bytes and checks their SHA-256 against
     `--expected-plan-sha256` BEFORE any JSON parsing — structural
     validation is not possible before parsing, so it can only happen
     AFTER the hash check succeeds: only once the hash matches does this
     function parse the JSON and structurally validate its content
     (delegating to `validateStrictDryRunReportContent()`). Both the hash
     check and the subsequent parsing/validation complete BEFORE any
     credential acquisition or Firestore I/O, and before
     `matchRollbackPlanAgainstCurrent()` (Phase B) is even called. Takes no
     Firestore/db parameter at all, so it is structurally impossible for a
     tampered or wrong-hash reference to cause any Firestore I/O. Points to
     an EXISTING **dry-run** report, STRICTLY validated — a minimal
     forged/incomplete JSON is rejected, not merely "close enough":
     - `schemaVersion` matches this tool's own current
       `REPORT_SCHEMA_VERSION`;
     - `mode === 'dry-run'` (rejecting an apply report outright — this is
       what makes the self-referential case structurally impossible);
     - `environment === 'production'` and `projectId === '--project'`'s
       value — a staging or emulator dry-run can never authorize a
       production apply;
     - `sourceGitSha` is present, non-empty, and never `"unknown"` — a
       dry-run whose own build could not be traced to a commit can never
       authorize production, and neither can a CURRENT apply run whose own
       `sourceGitSha` is `"unknown"` (checked first, before the reference
       file is even read);
     - `sourceChecksum`, `sourceStateChecksum`, `decisionsChecksum`, and
       `targetChecksum` are each present as a well-formed 64-character hex
       SHA-256 digest — not just "some string";
     - `counts.unresolved === 0` — a dry-run plan that still has unresolved
       conflicts/orphans/anomalies/companies-without-admin cannot be
       treated as fully reviewed and approved;
     - the full resolved-findings audit trail (`resolvedConflicts`/
       `resolvedOrphans`/`resolvedOwnerAnomalies`/`resolvedUnknownUsers`/
       `resolvedMalformedClaims`, plus `staleDecisions`/`unusedDecisions`)
       is present, deeply valid, and reconstructs `decisionsChecksum`
       exactly — see "Counts and checksum contract" below;
     - `plannedCreates` contains no duplicate `(companyId, uid)` pair.
   - **Phase B — `matchRollbackPlanAgainstCurrent()`**: pure comparison,
     no I/O of any kind — takes the ALREADY-verified Phase A result and
     THIS run's own freshly-computed values. `sourceGitSha`,
     `sourceChecksum`, `sourceStateChecksum`, `decisionsChecksum`, AND
     `targetChecksum` — all five values (the source Git revision plus four
     checksums) — must exactly equal THIS apply run's own
     computed values, PLUS `plannedCreates` must match directly (structural
     comparison, not just checksums), not `targetChecksum` alone —
     proving the dry-run was built from the exact same code, the exact
     same legacy source data, AND the exact same `--decisions-file`, not
     merely a dry-run that happens to compute a coincidentally-matching
     final `targetChecksum`. This is why apply's `--decisions-file` must
     be the SAME one used to produce the "resolved dry-run" report passed
     as `--rollback-reference` — see "Production execution", Step
     5, above. Phase B can never even be reached if Phase A rejected the
     reference file.
   This is not a description of a future rollback — it is proof the
   operator actually looked at a genuine, fully-resolved plan, built from
   the exact same code/data/decisions, before running `apply`.
2. **Post-apply** (printed to stdout, never embedded in the report file
   itself — a file cannot contain a hash of itself): the SHA-256 of the
   just-written apply-report file (`sha256OfFile()`, computed after
   `writeReport()` returns). This value is what a LATER
   `rollback-from-report` call must be identified by — recorded by the
   operator outside the tool (e.g. in the incident/runbook log), since the
   tool has no persistent store of its own to write it to. **Strengthened
   in the final preflight-safety round (independent review item 6)**: this
   is no longer merely an audit trail — `rollback-from-report` now
   REQUIRES this exact value via `--expected-report-sha256` and refuses
   (before even parsing `--from-report` as JSON) if it doesn't match the
   file's actual bytes. See "Production rollback" below.

## Production rollback — `import` is not an exact rollback

**Corrected after independent review.** An earlier, never-committed
preflight draft described `gcloud firestore import` of the pre-apply
backup as a way to "roll back production" after a failed apply. This is
inaccurate and unsafe to rely on: Firestore `import` is a MERGE/OVERWRITE
operation — it restores documents that were present in the backup, but it
does **not** delete documents that were created after the backup and are
absent from it. That is exactly what this tool's `apply` does: create NEW
`companies/{companyId}/members/{uid}` documents. A full `import` of the
pre-apply backup will restore any documents `apply` may have
overwritten, but will leave every newly-created membership document in
place, untouched.

**`rollback-from-report` is the primary, and only supported, rollback
mechanism for undoing an `apply`.** It performs targeted, per-document
deletion of exactly the documents `apply` created (via `createdPaths` in
the apply report), under a Firestore `lastUpdateTime` precondition — this
is the only mechanism that can reliably undo *creation*, which is all
`apply` ever does (it never modifies or deletes an existing document).

```bash
node scripts/backfill-memberships.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --mode rollback-from-report --from-report <path-to-the-apply-report.json> \
  --expected-report-sha256 <the SHA-256 printed by apply as "Apply report SHA-256"> \
  --report-path /absolute/path/outside/repo/sec005-prod-rollback.json \
  --ack-maintenance-readonly
```

**`--expected-report-sha256` is REQUIRED** (final preflight-safety round,
independent review item 6) — `sha256Hex()` of `--from-report`'s actual raw
bytes is computed and compared against this value BEFORE the file is even
parsed as JSON, let alone before any Firestore read/delete. A tampered,
swapped, or corrupted report is refused outright (exit 3), never silently
accepted just because it happens to still pass the structural validation
below.

## Emergency scenario: apply-report lost

`rollback-from-report` requires the apply report file — by design, it is
never committed to Git, never stored in Firestore, and never printed in
full to stdout. If it is genuinely lost (disk failure, accidental
deletion, etc.), `rollback-from-report` is unavailable — there is no
`--from-report` to point it at, and `--expected-report-sha256` above has
nothing to be verified against either.

**Corrected after independent review (final round, item 7): this no
longer falls back to a blind Firestore `import`.** An earlier version of
this section proposed importing the pre-apply backup as an emergency
substitute — but `import` cannot delete anything (see "Production
rollback" above), so it could never actually undo the *creation* `apply`
performed; it was never a real fix for a lost apply report, only a
different, riskier problem dressed up as one.

### `--mode rollback-from-plan` — reconstruction from a verified dry-run report

If a dry-run report from immediately before the lost `apply` still
exists — the SAME Step 5b "resolved dry-run" report that was used as
`--rollback-reference` (see "Two-phase ROLLBACK_REFERENCE" above and
Step 5c's saved SHA-256 above) — it can be used to RECONSTRUCT rollback
candidates, with real Firestore state cross-checked before every single
deletion:

```bash
node scripts/backfill-memberships.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --mode rollback-from-plan --from-plan /absolute/path/outside/repo/sec005-prod-resolved-dry-run.json \
  --expected-plan-sha256 <resolved-dry-run-sha256, saved in Step 5c> \
  --report-path /absolute/path/outside/repo/sec005-prod-emergency-rollback.json \
  --ack-maintenance-readonly --ack-emergency-reconstruction
```

- **`--expected-plan-sha256` is REQUIRED** (final-round fix #1, second
  round) — `sha256Hex()` of `--from-plan`'s actual raw bytes is computed
  and compared BEFORE the file is even parsed as JSON, let alone before
  any Firestore read/delete (final-round fix #1, third pass: this
  ordering is now enforced BEFORE `assertMaintenanceModeActive()` too —
  see `scripts/lib/emergencyReconstruction.ts` — so a wrong or missing
  hash produces ZERO Firestore reads of ANY kind, not just zero deletes).
  **This value MUST be the one saved independently in Step 5c — never
  recomputed from the surviving `--from-plan` file itself** (corrected
  after independent review, final round, third pass, item 2: recomputing
  the expected hash from the very file it is meant to validate can never
  catch tampering, since a file always "matches itself"). If the
  independently-saved Step 5c value is lost, see "If the
  independently-saved hash is lost" below — never substitute a
  freshly-recomputed value.
- `--from-plan` is then validated by the SAME strict structural checks
  `--rollback-reference` uses — real schema, matching environment/project,
  all checksums well-formed, `counts.unresolved === 0`, no duplicate
  `(companyId, uid)` pairs in `plannedCreates`. A minimal forged or
  incomplete file is rejected before any Firestore access.
- `--ack-emergency-reconstruction` is a SEPARATE, additional
  acknowledgement from `--ack-maintenance-readonly` — the operator must
  explicitly accept that this is the degraded, last-resort path, never a
  default choice.
- For each candidate `(companyId, uid, role, status)` from the dry-run's
  `plannedCreates`, the tool reads the LIVE document right now and deletes
  it ONLY if it exists, matches the candidate's `uid`/`role`/`status`
  EXACTLY, and passes strict canonical-schema validation — under the SAME
  `lastUpdateTime` delete precondition `rollback-from-report` uses. A
  candidate with no live document is skipped (nothing to delete, not an
  error — recorded in the report's `emergencyReconstruction.skippedNotFound`).
  A candidate whose live document does NOT match exactly is REFUSED, never
  guessed at (`emergencyReconstruction.refused`, with a reason).
- **This is deliberately weaker evidence than a real apply report.** A
  genuine `rollback-from-report` deletes exactly the documents `apply`'s
  own `WriteResult`s proved were created by THIS run. `rollback-from-plan`
  can only prove "a document matching what was planned exists now" — it
  cannot prove THIS specific apply run is what created it (a different,
  unrelated write landing on the exact same planned `(companyId, uid)`
  pair with the exact same role/status, in the window between the
  surviving dry-run and now, is not distinguishable by this mechanism).
  This is exactly why it requires the separate
  `--ack-emergency-reconstruction` acknowledgement and is documented as a
  last resort, not a substitute for `rollback-from-report`.

### If the independently-saved hash is lost: BLOCKED — manual recovery

**Added after independent review (final round, third pass, item 2).** If
the surviving dry-run report (Step 5b's file) still exists, but the
independently-recorded SHA-256 from Step 5c is lost (never written down,
the incident/runbook log itself was affected, etc.), `rollback-from-plan`
is NOT usable — even though the plan file itself is sitting right there.
**Do not recompute the hash from the surviving file and pass it as
`--expected-plan-sha256`.** That would make the integrity check
tautological: a hash computed from the exact file being validated always
"matches" that file, whether or not the file was tampered with, corrupted,
or silently substituted at some point since Step 5c. The check's entire
value comes from the expected value having been recorded independently,
at a moment before any incident — recomputing it now provides zero
additional assurance over just trusting the file blindly, which is
exactly the "accept the risk" outcome this whole mechanism exists to
prevent.

The honest status in this situation is `BLOCKED — требуется действие
владельца`, same as the next case below:

1. The operator does NOT run `rollback-from-plan` with a freshly-computed
   hash.
2. Proceed to "If no dry-run report survives either" below — from a
   security standpoint, a surviving plan file with no independently
   verifiable hash provides no more assurance than no plan file at all.

### If no dry-run report survives either: BLOCKED — manual recovery

If neither the apply report NOR a matching dry-run report (with its
independently-saved hash) survives, this tool has **no automated recovery
path**, and none should be improvised. The honest status is `BLOCKED —
требуется действие владельца`:

1. The operator manually reviews `companies/*/members/*` in the Firebase
   Console (or via an ad-hoc, reviewed read-only script) against whatever
   external record exists of what the migration was intended to do
   (decisions file, ticket, runbook log).
2. Any document believed to have been created by this migration is
   deleted manually, one at a time, with each deletion individually
   reviewed by the operator — never scripted/bulk without inspection.
3. This is explicitly NOT something this tool automates, and no future
   round should add an "auto-recover from nothing" mode — the entire
   point of `rollback-from-report`'s and `rollback-from-plan`'s design is
   that every deletion is justified by verifiable evidence (an apply
   report's `WriteResult`s, or a dry-run's `plannedCreates` cross-checked
   against live state); a mode with no evidence at all to check against
   would just be a blind, unverifiable delete loop — exactly the "accept
   the risk" failure mode this whole preflight redesign exists to avoid.

## Maintenance/read-only mode

**Corrected after independent review** — "accept the risk window" (no
mechanism to block writes during production `apply`) was the earlier,
never-committed draft's proposal, and is explicitly disallowed. A real
mechanism is implemented, spanning the two genuinely different places
Firestore writes can originate:

- **Client Firestore writes** — `firestore.rules` adds
  `isMaintenanceModeActive()`, which reads `system/maintenance` (a
  single document, never client-writable — no rule permits writing it, so
  it falls through to the existing deny-by-default catch-all). Every
  client write rule for `users`/`companies`/`company_data` now also
  requires `!isMaintenanceModeActive()`.
- **Admin SDK writes from `createCompany`** — Firestore Rules never apply
  to Admin SDK callers at all, so the Rules change above has zero effect
  on this path. `functions/src/lib/authz.ts`'s
  `requireNotInMaintenanceMode(db, txn)` is called as the very first
  statement inside `createCompany`'s bootstrap transaction (right after
  the transaction starts, before the existing-user read and before any
  write) and throws a `maintenance_mode` `AppError` (`failed-precondition`)
  when active.
  **Closed a TOCTOU race in the final preflight-safety round (independent
  review item 2).** The original implementation called
  `requireNotInMaintenanceMode(db)` as a plain, PRE-transaction read
  (right after `requireAuth`, before `runBootstrapIdempotent` even
  started) — an operator enabling maintenance mode a moment after that
  read passed, but before the transaction it was meant to gate had
  actually committed, would not have stopped that transaction from
  creating a company. Reading via `txn.get()` instead makes
  `system/maintenance` part of the TRANSACTION's own read set: Firestore
  guarantees that if any document a transaction read is modified by
  another completed write before that transaction commits, the SDK
  automatically retries the whole transaction function — including
  re-running this exact check — rather than allowing a stale read to
  reach commit. A concurrent `system/maintenance` write landing anywhere
  between this read and `createCompany`'s commit therefore forces a retry
  that observes the new value and refuses, exactly the same pattern
  already used by `assertNotLastAdmin()` in the same file. Proven directly
  by a real emulator race test
  (`functions/test/emulator/createCompany.test.ts`, "closes the
  maintenance-mode TOCTOU race") — not just asserted in a comment.
- **Fail-closed on both sides.** A Firestore read failure while checking
  `system/maintenance` is treated identically to `enabled === true`
  (refuse) — never as "maintenance is off". Applied consistently in
  `requireNotInMaintenanceMode()` (functions) and
  `assertMaintenanceModeActive()` (`scripts/lib/productionSafety.ts`,
  used by this tool's own `apply`/`rollback-from-report`/
  `rollback-from-plan`).
- **Ordering, enforced by the tool itself**: `apply`,
  `rollback-from-report`, and `rollback-from-plan` all call
  `assertMaintenanceModeActive(db)` — which does a REAL Firestore read,
  not just checking that `--ack-maintenance-readonly` was passed — before
  performing any write or delete. For `apply` specifically, this check
  runs FIRST, before `--backup-reference` is even read, because its
  `enabledAt` anchors the backup-freshness check (see "Backup reference
  verification" above). Maintenance mode must therefore already be active
  (enabled by the operator as Step 3 of the production runbook, above)
  before `apply` can proceed. Disabling it is a deliberate manual step,
  done only AFTER `verify` passes (Step 8) — neither this tool nor
  `scripts/ops/set-maintenance-mode.ts` ever disables it automatically, to
  avoid a window between verification and re-enabling client writes in
  which a client could write against an unverified state.
  **`rollback-from-plan` is the one exception to "maintenance mode checked
  first" — corrected after independent review (final round, third pass,
  item 1)**: an earlier version checked maintenance mode BEFORE verifying
  `--expected-plan-sha256`/validating `--from-plan`'s structure, meaning a
  tampered or wrong `--from-plan` file could still trigger one real
  Firestore read (the maintenance check) before being refused.
  `runEmergencyReconstruction()` (`scripts/lib/emergencyReconstruction.ts`)
  now runs the hash check and structural validation FIRST — pure,
  file-local work with zero Firestore I/O — and only calls
  `assertMaintenanceModeActive()` afterward, if both passed. Proven
  directly by a unit test using a Firestore stub that counts every
  `.get()`/`.delete()` call: a wrong `--expected-plan-sha256`, even in an
  otherwise fully valid production-shaped flow, produces exactly zero of
  either (`scripts/lib/emergencyReconstruction.test.ts`).

### `scripts/ops/set-maintenance-mode.ts` — the real operator script (item 8)

A REAL, tested script — not illustrative pseudocode — for enabling/
disabling `system/maintenance`, reusing the exact SAME
`assertEnvironmentGuard()`/`assertCycleExecutionAllowed()` guards as
`scripts/backfill-memberships.ts` (there is exactly one place in this
codebase that decides whether production is authorized this cycle — this
script does not duplicate or bypass it):

```bash
node scripts/ops/set-maintenance-mode.ts \
  --environment <emulator|staging|production> --project <project-id> [--confirm-project <project-id>] \
  --enable --reason <why> --task-id <e.g. SEC-005> --operator <your-identifier>

node scripts/ops/set-maintenance-mode.ts \
  --environment <emulator|staging|production> --project <project-id> [--confirm-project <project-id>] \
  --disable --task-id <e.g. SEC-005> --operator <your-identifier>
```

- `--operator <identifier>` is REQUIRED for both actions — every
  enable/disable transition must be attributable to a specific person.
- `--task-id <e.g. SEC-005>` is REQUIRED for both `--enable` and
  `--disable` (production execution gate round — previously `--enable`-only;
  `--disable` needs it too, so the script can identify WHICH task's
  maintenance record it is targeting). For `--environment production`,
  `--task-id` must be exactly `SEC-005` — the only task currently granted
  a production maintenance-mode authorization — checked entirely in
  argument parsing, before any credential acquisition or Firestore I/O.
- Every write to `system/maintenance` runs inside a Firestore
  **transaction** (`transactionalEnable()`/`transactionalDisable()`,
  exported from the import-safe `scripts/ops/maintenanceModeTransaction.ts`
  — kept separate from `set-maintenance-mode.ts`'s CLI entrypoint
  specifically so it can be imported directly by tests without triggering
  argv parsing/`main()` as a side effect of the import — and unit-tested
  directly against the emulator,
  `scripts/ops/maintenanceModeTransaction.emulator.test.ts`) — a concurrent
  modification between the read and the write aborts and Firestore
  automatically retries against the new state, so two racing calls can
  never both "win" or produce a torn/mixed write.
- `--enable` is allowed only when `system/maintenance` does not exist yet,
  or exists with `enabled === false` (verifiably, strictly disabled — a
  malformed/non-boolean `enabled` field on an existing document is treated
  as unverifiable and refused, never silently trusted). When allowed, it
  does a FULL overwrite (`set()`, not merge) — a fresh enable must never
  inherit stale `reason`/`taskId`/`enabledBy` fields from a previous
  maintenance cycle on the same document. Writes `enabled: true`,
  `enabledAt: FieldValue.serverTimestamp()`, `enabledBy`, `reason`,
  `taskId`. **`--enable` against an already-enabled record is refused
  outright (exit 1), the document left completely untouched** — a second,
  accidental `--enable` can never reset `enabledAt` or discard the
  existing audit trail; disable it first to start a genuinely new window.
- `--disable` is allowed only against a maintenance record whose own
  `taskId` field exactly matches the `--task-id` supplied — **refusing to
  disable a different task's maintenance window is enforced by the script
  itself, not merely by convention** (exit 1, document left untouched).
  When the identity matches AND `enabled === true`, it does a MERGING
  write (`set(..., {merge: true})`) — deliberately PRESERVES the
  historical `enabledAt`/`enabledBy`/`reason`/`taskId` fields for audit,
  only flipping `enabled: false` and adding `disabledAt`/`disabledBy`.
  Disabling a record that does not exist at all, or one that is already
  disabled for the SAME `--task-id`, is a safe, **idempotent no-op**
  (exit 0, no write at all). **Any OTHER value of the existing record's
  `enabled` field — missing, `null`, a string, a number, an object — is
  fail-closed: refused outright (`MaintenanceModeStateError`, exit 1,
  document left untouched), never treated as "assume disabled" or "assume
  enabled".**
  **`--disable` against a MISSING document is a no-op only — it does
  NOT create `{enabled: false}` or any document at all.** Step 2 of the
  production runbook above uses `--disable` only as a read-only
  precheck of the document's current state, never as a way to bootstrap
  it into existence.
- **The production gate is now open for `maintenance-enable`/
  `maintenance-disable`** (production execution gate round —
  `PRODUCTION_ACTION_APPROVED: SEC-005`; see "Production mode-specific
  requirements" above and `scripts/lib/firebaseAdmin.ts`'s
  `PRODUCTION_ALLOWED_ACTIONS`), superseding the earlier unconditional
  closure. `assertCycleExecutionAllowed()` is still checked before
  `initFirestore()`/any credential acquisition, same as always — it now
  simply answers "yes" for these two actions in production, the same way
  it already did for `dry-run`. This gate opening is, as of this
  round, PREPARATION ONLY: no production maintenance-mode transition has
  actually been executed — see
  `docs/remediation/reports/SEC-005.md`, "production execution gate round"
  for the exact scope of what was (and was not) run.

## Counts and checksum contract

Every report (`scripts/lib/report.ts`, currently **`schemaVersion: 4`** —
see the "Independent audit fixes" changelog sections at the end of this
document for the full version history; every current validator
(`validateStrictDryRunReportContent()`/`validateSourceReportForRollback()`)
rejects a v1, v2, OR v3 report outright, with a clear error explaining
that a NEW `--mode dry-run` against the CURRENT tool is required — an
older report can never be reinterpreted as current) includes: `mode`,
`environment`, `projectId`, `sourceGitSha` (for production, now a
FAIL-CLOSED-verified commit SHA proving a clean tracked worktree — see
"source revision verification" in the 4th-round section), `runId` (a
`crypto.randomUUID()` — **never** `Date.now()` for identity/ordering),
`startedAt`/`finishedAt`, the full `counts` object (`usersRead` …
`ownerWithoutAdminMembership`, `companiesWithoutAdmin` …
`staleDecisions` … `unusedDecisions` … `unresolved`), the private
`companiesWithoutAdmin: string[]` array (the actual companyIds the
last-admin gate blocked on — populated from `plan.companiesWithoutAdmin`
for dry-run/apply/verify, always `[]` for rollback modes; never printed to
the safe stdout summary — only its COUNT, via `counts.companiesWithoutAdmin`,
reaches stdout), and five checksums:

- **`sourceChecksum`** — SHA-256 over the canonicalized, `companyId`-then-`uid`-sorted
  set of *confirmed* candidate relations (`companyId`, `uid`, `role`).
- **`sourceStateChecksum`** (4th round) — a BROADER SHA-256, over the full
  normalized migration-relevant source state:
  confirmed relations WITH their source kinds; conflicts (reason +
  evidenceFingerprint); orphans (reason + evidenceFingerprint); owner
  anomalies; unknown users; malformed claims/owner-id anomalies; the SET of
  company/user IDs that currently exist; and a normalized projection of
  every existing membership document (`companyId`, `uid`, `role`, `status`,
  schema-validity). Unlike `sourceChecksum` above (which only ever covered
  `confirmed`), changing ANY migration-relevant fact — a conflict's
  observed roles, an orphan's source kind, whether a user/company exists,
  an existing membership's role — changes `sourceStateChecksum`
  (`scripts/lib/checksum.ts`'s `computeFullSourceStateChecksum()`). Never
  includes arbitrary unrelated Firestore fields, and never printed with raw
  identifiers — only the hex digest itself is safe for stdout.
- **`decisionsChecksum`** — SHA-256 over the canonicalized decisions array,
  where each decision is normalized to ALL 9 of its meaningful fields —
  `uid`, `companyId` (`null` for a user-level decision), `findingType`,
  `evidenceFingerprint`, `resolution`, `role` (`null` unless
  `confirm_role`), `reason`, `reviewedBy`, `reviewedAt` — before hashing
  (`scripts/lib/checksum.ts`'s `computeDecisionsChecksum()` takes the full
  typed `Decision[]`, not a partial shape). Changing ANY one of those 9
  fields changes the checksum — including `findingType` or
  `evidenceFingerprint` alone, which is exactly what makes a decision
  finding-bound (see "Decisions file" above); sorting is by the canonical
  JSON of each normalized decision itself, so it stays fully deterministic
  and order-independent (empty-array checksum when no `--decisions-file`
  is given, or when the audit trail below is genuinely empty).

  For a `--rollback-reference`/`--from-plan` used in production,
  `decisionsChecksum` is not merely present as a hex digest — it must be
  **reconstructible from the report's own audit trail**:
  `validateStrictDryRunReportContent()` collects every decision from the
  five `resolvedX[].decision` arrays (`resolvedConflicts`/`resolvedOrphans`/
  `resolvedOwnerAnomalies`/`resolvedUnknownUsers`/`resolvedMalformedClaims`)
  plus `staleDecisions` and `unusedDecisions`, validates that combined set
  as ONE batch (catching a decision duplicated across buckets, which
  per-item validation cannot see), and requires
  `computeDecisionsChecksum()` of that collected set to exactly equal
  `report.decisionsChecksum` — a decision silently missing from every
  bucket, or a duplicated `{finding, decision}` pair, is refused outright.
- **`targetChecksum`** — SHA-256 over the canonicalized, sorted set of
  relations the run INTENDS to exist afterward (planned creates + already-matching
  skips), role+status only (`schemaValid` always implicitly `true` for a target
  relation, see `observedChecksum` below).
- **`observedChecksum`** — same shape, computed from an ACTUAL read-back
  after `apply`/`verify`; `null` for `dry-run` (nothing was applied yet),
  and also `null` whenever the read-back itself failed outright (see
  `readBackError` below — 3rd round fix #2).
  Each observed relation also carries an explicit `schemaValid` flag (2nd
  round fix #7: `isStrictlyValidActiveMembership()` run against the
  read-back document) — a document with the "right" role/status but a wrong
  uid, forged/missing timestamps, or extra fields produces `schemaValid:
  false`, which changes `observedChecksum` even though role/status alone
  would have matched.
- **`readBackError`** (`string | null`) — non-null only when the post-write
  read-back call itself failed (as opposed to an individual target relation
  simply being absent, which is `missing[]`) — an honest signal that
  `observedChecksum`/`verification` could not be computed at all this run.
  Exit code stays non-zero whenever this is set.

All checksums are computed via `scripts/lib/checksum.ts`: canonical
(recursively key-sorted) JSON, SHA-256 hex. Timestamps (`createdAt`/`updatedAt`)
are **excluded** from every checksum — they are server-assigned and not
part of "did the intended relation set get created"; two runs that create
the identical logical relation set produce the identical `targetChecksum`
even though their Firestore `Timestamp` values differ. The sort is always
`companyId` then `uid`, so **Firestore query result order never affects any
checksum** (verified directly — see tests). `companyId`/`uid` pairing
itself is encoded collision-free via `relationKey()`/`splitRelationKey()`
(2nd round fix #6: a canonical `JSON.stringify([companyId, uid])` tuple,
not a hand-chosen delimiter) — two different pairs can never produce the
same key, even when one identifier contains the other's delimiter,
whitespace, or Unicode content.

## Idempotency

Every write is **create-only** (`DocumentReference.create()`, which the
Admin SDK enforces with a "does not exist" precondition — nothing this tool
does can silently overwrite a document that appeared between planning and
apply, even under a race). Planning always happens in full — reading every
legacy source, every existing membership, and validating every decision —
**before** the first write. A repeated `apply` run against unchanged source
data creates 0 new documents, changes 0 existing documents, and produces
the identical `targetChecksum` (proven by `scripts/backfill-memberships.emulator.test.ts`).

**Operational rule — `verify` must be given the SAME `--decisions-file` as
the `apply` it is checking.** Decisions are never persisted anywhere in
Firestore — they are an ephemeral input file the operator supplies each
run. `verify` re-plans from scratch every time; if a conflict was resolved
via a decision at `apply` time but `verify` is run without that same
decisions file (or a different one), the conflict correctly reappears as
unresolved, and `applyAllowed`/`verification.matchesTarget` both become
`false`. This is **not a defect** — it is the direct, intended consequence
of decisions never being stored — but it is easy to trip over operationally
(running a "quick verify" without remembering the decisions file used at
apply time looks identical to a real drift/failure at first glance).
Confirmed directly against real `finapp-staging` during the SEC-005 full
staging rehearsal — see "Full staging rehearsal" below.

## Partial-write-failure handling

Each planned create is attempted independently (`scripts/lib/applyWrites.ts`,
`createPlannedRelations()`) and its outcome (success or failure) is recorded
individually in `createdPaths`/`writeFailures` — the report **never claims**
the whole migration was atomic. If N of M planned creates succeed, the
report shows exactly which N paths were created and which failed with what
error, and the exit code is non-zero.

**Durable accounting after a successful create (3rd round fix #2).** A
successful creation is captured SOLELY from `DocumentReference.create()`'s
own `WriteResult` — there is no follow-up `get()` call to confirm it, so
there is no read that could fail and erase a known-successful create from
the report. (`writeResult.writeTime` IS both the `createTime` and
`updateTime` of a freshly created document, so no accuracy is lost by not
re-reading it.) The broader post-write read-back — used to compute
`observedChecksum`/`missing`/`differing` across ALL target relations, not
just the ones just created — is separately wrapped
(`readBackObservedState()`): if THAT call fails outright (not an individual
document, the whole read), the failure is captured as `readBackError:
string | null` on the report instead of propagating as an uncaught
rejection that would have aborted the process before `writeReport()` ever
ran (which would have silently discarded the already-known
`createdPaths`/`rollbackManifest`). The exit code stays non-zero whenever
`readBackError` is non-null.

**Report-write durability (3rd round fix #2).** `assertReportPathWritable()`
(`scripts/lib/report.ts`) proves the report destination is writable —
directory creatable, permissions sufficient — via a zero-byte probe
write+delete at the exact target path, called immediately after path-safety
validation and BEFORE any credential acquisition or Firestore write. Losing
the ability to write the report only after `apply` has already created (or
`rollback` has already deleted) real documents would leave an unrecoverable
audit/rollback gap. `writeReport()` itself now writes to a temporary file in
the same directory and atomically renames it into place — a crash or
interruption mid-write can never leave a truncated/corrupted report at the
target path.

The observed checksum (`scripts/lib/observedState.ts`,
`computeObservedState()`) is computed **exclusively from documents actually
read back** after the writes — a target relation with no corresponding
read-back entry is recorded in `missing[]` and contributes a `'MISSING'`
sentinel to the checksum input, **never** the expected/target value. This
means a partial write failure necessarily produces a non-matching
`observedChecksum`, a non-zero exit code (`mode === 'apply' &&
observedChecksum !== targetChecksum` → exit 1), and an honest `missing[]`
list in the report — proven directly at the unit level
(`scripts/lib/observedState.test.ts`, "partial write failure" case). A
genuine mid-batch Firestore write failure is still not exercised as a live
race against the real emulator in this cycle (single synchronous CLI
process, no injection point) — see `docs/remediation/reports/SEC-005.md`,
"Известные ограничения" for why the unit-level proof is treated as
sufficient (the same function is used for both apply and verify).

## Rollback

`--mode rollback-from-report --from-report <apply-report.json>` first
runtime-validates the **entire source report** before touching Firestore at
all (`scripts/lib/rollbackValidation.ts`, `validateSourceReportForRollback`):
correct `schemaVersion`, `mode === 'apply'`, matching `environment`/`projectId`,
every `rollbackManifest` entry AND every `createdPaths` entry independently
validated (canonical path `companies/{companyId}/members/{uid}`, no
duplicate pairs within either array — 3rd round fix #1: `createdPaths`
entries were previously never validated on their own, only looked up), and
**exact pair-set equality between `rollbackManifest` and `createdPaths`** —
not just "every manifest entry has a matching createdPaths record" but also
the reverse: every `createdPaths` record has a matching manifest entry. A
report with two created documents but only one manifest entry (the exact
bug the 3rd round review flagged) is now rejected outright rather than
producing a partial rollback that silently leaves one document behind while
reporting success. An empty `rollbackManifest` is accepted as valid ONLY
when `createdPaths` is ALSO empty and the report's own `counts.created` is
`0` — a manifest truncated to empty while `createdPaths`/`counts.created`
still show real creates is refused, never treated as "nothing to roll
back". Every entry is also cross-referenced against `plannedCreates` (must
have a known `role` and `status === 'active'`, and must be **exactly one**
unambiguous record for that pair — a duplicate/ambiguous `plannedCreates`
entry for the same pair is rejected, never resolved by taking "the first
one"). **Any single structural problem — a tampered report, wrong-project
report, a non-apply report, or an incomplete manifest/createdPaths pair-set
— rejects the entire rollback with zero deletions attempted.**

Only once the source report validates does the tool attempt deletions, one
per manifest entry, and only if, right now:
1. the document still exists;
2. `uid`/`role`/`status` still match what was created;
3. its Firestore `createTime`/`updateTime` metadata still exactly match
   what was recorded at apply time (proves it was never modified since);
4. the delete itself succeeds under a Firestore `lastUpdateTime` precondition
   (`ref.delete({ lastUpdateTime: snap.updateTime })`) — closing the race
   window between the pre-delete read and the delete call itself: a
   concurrent modification landing in that exact window causes the
   precondition to fail and the deletion to be refused, not silently lost.

Any mismatch refuses that specific deletion (never a partial "best effort"
delete) and records it as a conflict in the rollback report. Verified
against the real emulator: a document modified after backfill is correctly
refused, never deleted; a tampered/wrong-project source report is refused
before any Firestore I/O.

## No PII in Git

The full report (uid/companyId are treated as sensitive identifiers) and
any decisions file are **never** committed. `--report-path`,
`--decisions-file`, and `--from-report` **all** go through the same shared
check (`scripts/lib/pathSafety.ts`, `assertPathOutsideRepo`) — resolving
symlinked ancestors and comparing case-insensitively on Windows/macOS — and
this check runs **immediately after CLI argument parsing, before any
credential acquisition or Firestore I/O**: an invalid path for any of the
three flags leaves zero writes and zero reads. Only safe aggregates (mode,
environment, projectId, counts, checksums) are ever printed to stdout.
`.gitignore` additionally blocks the conventional local filenames
(`*.membership-backfill-report.json`, `/migration-reports/`) as
defense-in-depth, in case an operator forgets the repo-outside requirement.

## Independent audit fixes

An independent review of this tool returned `REVIEW_RESULT: CHANGES
REQUIRED` with 7 categories of blocking findings. All 7 were fixed in a
follow-up commit on this same branch; the full technical writeup (per-fix
rationale, new modules, and the new red→green test list) is in
`docs/remediation/reports/SEC-005.md`, section "Исправления по итогам
независимого аудита". Summary:

1. The last-admin gate now checks **every existing company**, not only
   companies with a confirmed legacy relation, and never counts a
   structurally-corrupted document as a protecting admin.
2. `accept_existing` now only ever resolves a strictly-schema-valid, active,
   role-differing existing membership — never an invalid one.
3. Rollback now runtime-validates the entire source report before any I/O
   and closes the read→delete race with a Firestore `lastUpdateTime`
   precondition.
4. The observed checksum is computed exclusively from actually-read
   documents, never substituting expected values for missing ones.
5. All three path flags (`--report-path`, `--decisions-file`,
   `--from-report`) are validated as outside-the-repo before any credential
   acquisition or Firestore I/O, not just `--report-path` after I/O began.
6. Users with no usable legacy relation are surfaced in a new `unknownUsers`
   list instead of silently disappearing; malformed `companies[]` entries
   are reflected in the report; a pair with both a valid and an invalid role
   claim becomes a `mixed_role_validity` conflict instead of an
   auto-confirmed relation.
7. `readAllExistingMemberships()` now validates the full Firestore path
   shape and only ever accepts documents at exactly
   `companies/{companyId}/members/{uid}` — a foreign or nested `members`
   document elsewhere in Firestore can no longer influence planning,
   checksums, or the admin gate.

## Independent audit fixes — second round

A follow-up independent review, also `REVIEW_RESULT: CHANGES REQUIRED`,
found 7 more categories of blocking findings — deeper issues than the first
round, in the strictness of `verify` itself and the Timestamp/checksum
machinery underneath it. All 7 were fixed in a second follow-up commit on
this same branch; the full technical writeup is in
`docs/remediation/reports/SEC-005.md`, section "Исправления по итогам
ПОВТОРНОГО независимого аудита". Summary:

1. `verify`'s `matchesTarget` used to be pure checksum equality — which
   could be trivially, falsely `true` when both the target and observed
   relation sets were EMPTY (e.g. a company whose only relation is an
   unresolved conflict). It now also requires `plan.applyAllowed`, zero
   `missing`/`differing` entries, in addition to the checksum match.
2. Timestamp validation switched from duck-typing (any object with numeric
   `seconds`/`nanoseconds`, or any object with a `toDate()` function) to a
   real `instanceof Timestamp` check against `firebase-admin/firestore`'s
   own class — a plain JSON-shaped map or a forged `toDate()` no longer
   passes as a valid membership timestamp.
3. `unknownUsers` and `malformedClaims` are now BLOCKING — `applyAllowed`
   requires both to be empty. The only way to clear an entry is a new
   "user-level" decision (a `Decision` with no `companyId`, `resolution:
   "exclude"` only) or fixing the source data so the entry stops being
   extracted; there is no silent-ignore path.
4. Every `confirm_role` decision is re-verified, at the moment it is
   applied, against the company and user actually existing right now
   (`allCompanyIds`/`allUserIds`) — and a `user_id_mismatch` claim
   referencing a company that does not exist is now classified as a
   `missing_company` orphan (never resolvable via `confirm_role`) instead
   of a conflict.
5. `decisionsChecksum` is computed from the FULL normalized 7-field decision
   shape (`uid`, `companyId`, `resolution`, `role`, `reason`, `reviewedBy`,
   `reviewedAt`), sorted by each decision's own canonical JSON — changing
   any single field changes the checksum, deterministically.
6. `relationKey()`/`splitRelationKey()` switched from a hand-chosen `"::"`
   delimiter to a canonical `JSON.stringify([companyId, uid])` tuple —
   collision-free by construction, including when an identifier contains
   the old delimiter, whitespace, or Unicode content.
7. `computeObservedState()` now flags a document as `differing` (and
   contributes `schemaValid: false` to the checksum) whenever it fails
   strict canonical-schema validation — not only when its role/status
   textually differs from the target.

## Independent audit fixes — third round

A follow-up independent review, also `REVIEW_RESULT: CHANGES REQUIRED`,
found 4 more categories of blocking findings. All 4 were fixed in a third
follow-up commit on this same branch; the full technical writeup is in
`docs/remediation/reports/SEC-005.md`, section "Исправления по итогам
ТРЕТЬЕГО независимого аудита". Summary:

1. `validateSourceReportForRollback()` used to check only that every
   `rollbackManifest` entry had a matching `createdPaths` record — never
   the reverse. A report with two created documents but only one manifest
   entry passed validation and produced a rollback that silently deleted
   only one of the two documents while reporting success. It now requires
   exact pair-set equality between `rollbackManifest` and `createdPaths`,
   independently validates every entry in BOTH arrays (canonical path, no
   duplicates), requires an empty manifest to also have empty
   `createdPaths` AND `counts.created === 0`, and requires every created
   pair to match exactly one (never an ambiguous/duplicate)
   `plannedCreates` record.
2. `ref.create()` and its follow-up `ref.get()` used to share one
   try/catch — a successful create followed by a failed metadata read was
   recorded as a write failure and dropped entirely from
   `createdPaths`/`rollbackManifest`. `scripts/lib/applyWrites.ts`'s
   `createPlannedRelations()` now determines success solely from
   `DocumentReference.create()`'s own `WriteResult` (no second read at
   all), and the broader post-write read-back is separately wrapped so a
   failure there is recorded as an honest `readBackError` on the report
   instead of aborting the process before the report is ever written.
   `assertReportPathWritable()` proves the report destination is writable
   before any Firestore write; `writeReport()` now writes atomically
   (temp file + rename).
3. A membership document's own schema being valid was never enough on its
   own — a document under a company that no longer exists could suppress
   an `unknownUsers` entry, and a valid-looking admin membership whose uid
   had no `users/{uid}` document could satisfy the last-admin gate for a
   real company. Both are now cross-checked against `allCompanyIds`/
   `allUserIds` and, when dangling, surfaced as blocking. **Corrected in a
   follow-up fix** (see "Dangling existing memberships" above and
   "Independent audit fixes — dangling-memberships correction" below): the
   first version of this fix reported these as ordinary orphans, which a
   relation-level `exclude` decision could remove from the listing even
   though the document itself remained in Firestore — this has been fixed
   so NO decision of any kind can ever clear a dangling membership; only
   repairing the underlying data can.
4. `plannedCreates`/`skipped` sorting used
   `(a.companyId + a.uid).localeCompare(...)`, which collides whenever one
   identifier's suffix matches the other's prefix (e.g. `('a','bc')` and
   `('ab','c')` both concatenate to `"abc"`). `planner.ts` now uses the
   existing, already-proven collision-free `sortRelations()` helper
   (`checksum.ts`) instead.

## Independent audit fixes — dangling-memberships correction

A follow-up review of the same PR found that the third round's fix #3
("existing orphaned membership integrity") was itself fail-open: it
reported dangling existing memberships in `unresolvedOrphans` and let a
relation-level `exclude` decision remove the entry, even though the
document itself remained physically present in Firestore. If the affected
company had another valid admin, `applyAllowed` could become `true` (and
`verify` could report success) with the corrupted document still sitting
there, undetected.

Fixed in a single follow-up commit, `fix(sec-005): keep dangling
memberships fail-closed`. Full write-up in
`docs/remediation/reports/SEC-005.md`, section "Коррекция: dangling
memberships остаются fail-closed". Summary:

- Dangling existing memberships now live in their own report field,
  `danglingMemberships` (`DanglingMembershipRecord`/
  `DanglingMembershipReason`, `scripts/lib/types.ts`) — structurally
  separate from `orphans`, which stays exactly as documented for
  legacy-source claims.
- **No decision — relation-level or user-level — is ever consulted for
  this list.** The only way to stop a dangling membership from blocking
  `apply`/`verify` is to repair the actual data (create the missing
  company/user, or delete the dangling document) before the next run.
- `ReportCounts.danglingMemberships` and `counts.unresolved` both reflect
  this honestly.
- See "Dangling existing memberships" near the top of this document for
  the corrected, authoritative description of this behavior — the
  "Confirmed / conflict / orphan / owner-anomaly definitions" section and
  this document no longer claim that excluding a dangling membership
  "just dismisses the listing"; excluding it is not possible at all.

## Staging authorization — implementation notes

The repository owner granted `EXTERNAL_ACTION_APPROVED: SEC-005` /
`ENVIRONMENT: staging` (production explicitly excluded: "Production
запрещён"). Implemented in a single commit, `fix(sec-005): allow staging
execution, keep production unconditionally blocked`. Full write-up in
`docs/remediation/reports/SEC-005.md`, section "Staging authorization
(EXTERNAL_ACTION_APPROVED: SEC-005)".

- New `assertCycleExecutionAllowed(environment)`
  (`scripts/lib/firebaseAdmin.ts`) — a gate deliberately SEPARATE from
  `assertEnvironmentGuard()`'s project-ID consistency checks, since a
  cycle's authorization for one external environment says nothing about
  another. Replaces the previous blanket `if (environment !== 'emulator')
  return 4` in `scripts/backfill-memberships.ts`'s `main()`.
- `emulator` and `staging` both pass this gate now; `production` throws
  `CycleExecutionError` UNCONDITIONALLY — the function never inspects
  `--backup-reference`/`--rollback-reference`/`--ack-maintenance-readonly`
  or any other flag before refusing `production`.
- Unit-tested directly (`scripts/lib/firebaseAdmin.test.ts`) and, for the
  production-refusal direction, also proven end-to-end via the real CLI
  binary (`scripts/backfill-memberships.emulator.test.ts`) — safe to do
  because `production` is refused BEFORE `initFirestore()` is ever called,
  so no real I/O of any kind is attempted. The staging-allowed direction
  is intentionally NOT proven via a live CLI invocation against
  `finapp-staging` in the automated test suite — doing so would require
  letting the process attempt a real (or credential-failing) Firestore
  connection, which is out of scope for `npm run test:migration`; it is
  proven directly at the unit level instead, against the exact function
  this gate is implemented with.
- This round performed exactly one real action against `finapp-staging`:
  a single `--mode dry-run` run. `apply` against staging was NOT run —
  see `docs/remediation/reports/SEC-005.md` for the safe aggregate
  counts/checksums and whether a live connection to `finapp-staging` was
  actually reachable from this environment.

## Full staging rehearsal (STAGING_FIXTURE_ACTION_APPROVED: SEC-005)

The repository owner granted a separate, broader authorization:

```text
STAGING_FIXTURE_ACTION_APPROVED: SEC-005
```

— "Разрешаю создать и удалить только синтетические тестовые данные в
finapp-staging для полной репетиции. Production запрещён." This explicitly
covers creating AND deleting synthetic fixture data for a full
dry-run → decisions → apply → verify → rollback cycle. Full write-up
(anonymized, doc-only round — no code changed) in
`docs/remediation/reports/SEC-005.md`, section "Полная staging rehearsal
(STAGING_FIXTURE_ACTION_APPROVED: SEC-005)". Summary:

- Synthetic fixture (tag `9d544063`): 2 companies + 3 users, deliberately
  shaped to exercise a `role_mismatch` conflict, a `missing_company`
  orphan, and a clean happy-path relation in the same run.
- `dry-run` correctly detected exactly 1 `role_mismatch` and 1
  `missing_company`, `applyAllowed: false`.
- `apply` with a decisions file resolving both created exactly 2 canonical
  membership documents; `unresolved: 0`; checksums matched; exit 0.
- `verify` WITHOUT the decisions file correctly showed `applyAllowed:
  false` again (the conflict resurfacing without its decision — see the
  new operational rule in "Idempotency" above); `verify` WITH the same
  decisions file showed `applyAllowed: true` and a fully matching checksum
  — **PASS**.
- `rollback-from-report` removed both created documents; a follow-up
  `dry-run` showed `existingMembershipsRead: 0`, identical to the
  pre-apply state.
- All 5 fixture documents (2 companies + 3 users) were then deleted
  directly (outside this tool — it never writes to `users`/`companies`
  itself); a final `dry-run` showed 0/0/0 across every count, with
  `sourceChecksum`/`targetChecksum` identical to the very first pre-fixture
  check — `finapp-staging` fully restored to how it was found.
- Every full JSON report was written only to an absolute path outside the
  repository, never opened/pasted in full, and deleted after the safe
  aggregate summary was extracted. The two temporary Admin-SDK
  seed/cleanup scripts lived inside the repo only for the seconds needed
  to run them and were deleted immediately after each use.
- Production was not referenced by any command this round.

## Independent audit fixes — production preflight

An independent review of the production preflight (an earlier,
never-committed round — delivered only in chat, never in this document)
found 9 categories of blocking issues: `members` missing from the backup
scope, no restore verification for memberships, `import` mislabeled as an
exact rollback, no emergency playbook for a lost apply-report, "accept the
risk window" proposed instead of a real maintenance mechanism, imprecise
mode-specific CLI requirements, a circular `ROLLBACK_REFERENCE`,
unverified backup/rollback/maintenance references, and a requirement to
keep the production gate unconditionally closed. All 9 are fixed in this
document and in code, in a single commit `fix(sec-005): correct
production preflight safety design`. Full technical writeup:
`docs/remediation/reports/SEC-005.md`, section "Исправления production
preflight по итогам независимого ревью". Summary:

1. The backup command now includes `members` in `--collection-ids`; a
   backup manifest without a `firestore.membersCount` field is rejected
   by `verifyBackupReference()` and can never become a valid
   `--backup-reference`.
2. Restore verification for the `members` collection group (count +
   checksum against the manifest) is documented as a required runbook
   step — see "Restore verification — members collection group" above.
3. `import` is no longer called an exact rollback anywhere in this
   document — it is explicitly described as MERGE/OVERWRITE, which
   cannot delete documents `apply` created. `rollback-from-report` is the
   sole primary rollback mechanism — see "Production rollback — `import`
   is not an exact rollback" above.
4. A last-resort emergency playbook for a lost apply-report is documented
   — see "Emergency scenario: apply-report lost" above.
5. A real maintenance/read-only mechanism is implemented: Firestore Rules
   block client writes; `requireNotInMaintenanceMode()` blocks Admin SDK
   writes from `createCompany` (Rules never apply to Admin SDK callers,
   so this needed its own separate check). Both sides are fail-closed.
   "Accept the risk window" is no longer proposed anywhere. See
   "Maintenance/read-only mode" above.
6. Mode-specific CLI requirements are corrected into an explicit table
   (dry-run/apply/verify/rollback-from-report each have their own,
   different requirements) — see "Production mode-specific requirements"
   above.
7. `ROLLBACK_REFERENCE` is now a two-phase scheme: pre-apply, an existing
   dry-run report cross-checked by `targetChecksum`; post-apply, a
   separately-printed SHA-256 of the apply report itself. See "Two-phase
   ROLLBACK_REFERENCE" above.
8. `--backup-reference`/`--rollback-reference`/`--ack-maintenance-readonly`
   are now really verified (`scripts/lib/productionSafety.ts`), not just
   checked for presence, and the verified results (hashes/timestamps
   only, never raw paths or Firestore identifiers) are recorded in the
   report's `productionSafety` field, included in the safe stdout
   summary.
9. `scripts/lib/firebaseAdmin.ts`'s `assertCycleExecutionAllowed()` was
   NOT touched this round — `production` is still refused
   unconditionally, independent of any flag.

**Production was not read or modified at any point in this round** — all
verification is against the Firestore Emulator and unit-level fake
Firestore stubs.

## Independent audit fixes — production preflight, final round

A follow-up independent review of the production preflight (the round
directly above) found 9 remaining blocking issues — deeper than before:
the runbook order didn't actually enable maintenance mode before backup,
`createCompany`'s maintenance check had a TOCTOU race, the backup manifest
schema was too loose (no export operation ID, no integer count
enforcement, no restore-verification requirement, no freshness/ordering
check), the pre-apply dry-run reference accepted a near-empty forged JSON,
`--backup-reference`/`--rollback-reference` bypassed the shared
outside-the-repo path check, `rollback-from-report` had no integrity
check on `--from-report` itself, and the "lost apply-report" emergency
scenario still fell back to a blind `import`. All 9 are fixed in this
document and in code, in a single commit `fix(sec-005): close final
production preflight review findings`. Full technical writeup:
`docs/remediation/reports/SEC-005.md`, section "Исправления production
preflight по итогам финального независимого ревью". Summary:

1. **Runbook step order corrected**: guards (Rules/Functions deploy, a
   separate authorized action) → create `system/maintenance` disabled →
   ENABLE maintenance → backup → dry-run/review → apply → verify →
   disable maintenance. See "Future production execution" above (Steps
   1–8) — maintenance is now enabled BEFORE backup, not after.
2. **TOCTOU race closed in `createCompany`**: `system/maintenance` is now
   read via `txn.get()` INSIDE the same Firestore transaction that
   creates company/user/membership/receipt
   (`requireNotInMaintenanceMode(db, txn)`,
   `functions/src/lib/authz.ts`), not via a plain pre-transaction read.
   Proven by a real emulator race test — see "Maintenance/read-only mode"
   above.
3. **Backup manifest schema strengthened**: exact `productionProjectId`,
   a real `firestore.exportOperationId`, `firestore.exportStatus ===
   'SUCCESS'`, `collectionIds` containing `"members"` (or `scope ===
   'full'`), every count a non-negative integer, valid timestamps,
   `restore.verificationResult === 'PASS'` with a matching
   `restore.membersCount`/`membersChecksum`, and `createdAtUtc` both AT OR
   AFTER the live `system/maintenance.enabledAt` AND within
   `MAX_BACKUP_AGE_MS` of "now". See "Backup reference verification"
   above.
4. **Dry-run reference validation strengthened**: full `schemaVersion`,
   `mode === 'dry-run'`, `environment === 'production'`, matching
   `projectId`, non-empty `sourceGitSha`, all three checksums as
   well-formed SHA-256 hex, and `counts.unresolved === 0` — a minimal
   forged JSON (`{mode: 'dry-run', targetChecksum: '...'}`) is rejected
   outright. Factored into a shared `verifyStrictDryRunReport()`
   (`scripts/lib/productionSafety.ts`), reused by both
   `verifyRollbackPlanReference()` and the new `rollback-from-plan` mode.
   See "Two-phase ROLLBACK_REFERENCE" above.
5. **`--backup-reference`/`--rollback-reference` now go through
   `assertPathOutsideRepo()`** in `main()`, before any credential
   acquisition or Firestore I/O — previously they went straight to
   `readFileSync()` inside `productionSafety.ts`, bypassing the same
   outside-the-repo check every other path flag already had.
6. **`rollback-from-report` now requires `--expected-report-sha256`**,
   verified against `--from-report`'s actual raw bytes BEFORE the file is
   even parsed as JSON — a tampered, corrupted, or swapped report is
   refused outright (exit 3). See "Production rollback" above.
7. **The lost-apply-report emergency scenario no longer falls back to a
   blind `import`.** A new `--mode rollback-from-plan` reconstructs
   candidates from a separately-verified dry-run report's
   `plannedCreates`, deleting a live document ONLY if it exactly matches
   the plan and passes strict schema validation, under the same
   `lastUpdateTime` precondition `rollback-from-report` uses — explicitly
   weaker evidence than a real apply report, requiring its own
   `--ack-emergency-reconstruction`. If no dry-run report survives
   either, the documented outcome is honest `BLOCKED — требуется действие
   владельца` manual recovery, not an improvised automated one. See
   "Emergency scenario: apply-report lost" above.
8. **A real, tested operator script** (`scripts/ops/set-maintenance-mode.ts`
   + `scripts/ops/maintenanceModeCli.ts`) replaces the earlier
   "illustrative" placeholder for enabling/disabling `system/maintenance`
   — reuses the exact same `assertEnvironmentGuard()`/
   `assertCycleExecutionAllowed()` guards as the main migration tool, so
   production remains refused (exit 4) with zero writes, proven by a real
   emulator test. The separate future deploy of maintenance-mode-aware
   Rules/Functions is documented as its own explicit Step 1, requiring
   its own authorization (CLAUDE.md §5). See "Maintenance/read-only mode"
   above.
9. `scripts/lib/firebaseAdmin.ts`'s `assertCycleExecutionAllowed()` was
   NOT touched this round either — `production` is still refused
   unconditionally, independent of any flag.

**Production was not read or modified at any point in this round** — all
verification is against the Firestore Emulator and unit-level fake
Firestore stubs. One incidental environmental fix landed alongside these:
`npm run test:migration` now passes `--no-file-parallelism` to `vitest`
(`package.json`) — adding the second emulator-backed test file
(`scripts/ops/set-maintenance-mode.emulator.test.ts`) exposed a
pre-existing hazard where two test files independently wiping the SAME
shared `demo-finapp` Firestore Emulator project in their own `beforeEach`
hooks could race under vitest's default cross-file parallelism, producing
spurious failures unrelated to any code defect (root-caused and confirmed
by running the affected test in isolation, where it passed reliably).

## Independent audit fixes — production preflight, final round, second pass

A SECOND follow-up independent review of the "final round" above found 5
more categories of blocking issues in that round's own fixes. All 5 are
fixed here, in code and documentation, in a single commit
`fix(sec-005): close second pass of final production preflight review`.
Full technical writeup: `docs/remediation/reports/SEC-005.md`, section
"Исправления SEC-005 по итогам второго прохода финального независимого
ревью". Summary:

1. **`rollback-from-plan` now requires `--expected-plan-sha256`**,
   verified against `--from-plan`'s actual raw bytes BEFORE any JSON
   parsing or Firestore read/delete — the exact same integrity-check
   pattern `rollback-from-report`'s `--expected-report-sha256` already
   used, extended to close the equivalent gap in the newer emergency
   mode. See "Emergency scenario: apply-report lost" above.
2. **`--rollback-reference` is now linked to the CURRENT apply run
   exactly**: `verifyRollbackPlanReference()` requires `sourceGitSha`,
   `sourceChecksum`, `decisionsChecksum`, AND `targetChecksum` to ALL
   match, not `targetChecksum` alone. A production run whose OWN
   `sourceGitSha` is `"unknown"` is refused outright, before the
   reference file is even read. `plannedCreates` is now also checked for
   duplicate `(companyId, uid)` pairs. See "Two-phase ROLLBACK_REFERENCE"
   above.
3. **Backup manifest now requires a SOURCE members checksum too**:
   `firestore.membersChecksum` (new field, valid 64-hex SHA-256) is
   required alongside the existing `restore.membersChecksum`, and the two
   must be EXACTLY EQUAL — previously `restore.membersChecksum` was only
   checked for presence, never actually compared to anything. See "Backup
   reference verification" above.
4. **Runbook Step 5 corrected**: a single decisions-less dry-run can never
   become `--rollback-reference` now that item 2 requires an exact
   `decisionsChecksum` match — the runbook is now discovery dry-run (no
   decisions) → prepare decisions file → RESOLVED dry-run (same
   `--decisions-file` apply will use) → save its SHA-256 → apply (same
   `--decisions-file`, this resolved report as `--rollback-reference`).
   The emergency `rollback-from-plan` example now uses this saved SHA-256
   as `--expected-plan-sha256`. See "Future production execution", Step
   5, above.
5. **Emulator/staging rollback examples corrected**: `apply` now prints
   its report's SHA-256 for EVERY environment, not just production (the
   print was gated to `environment === 'production'` even though
   `--expected-report-sha256` was already unconditionally required for
   `rollback-from-report`) — the emulator walkthrough's rollback command
   now actually matches what the CLI requires, with a fallback
   `sha256sum`/`Get-FileHash` recipe documented for when the printed line
   wasn't captured. See "Emulator walkthrough" above.

**Production was not read or modified at any point in this round** — all
verification is against the Firestore Emulator and unit-level fake
Firestore stubs.

## Independent audit fixes — production preflight, final round, third pass

A THIRD follow-up independent review found 5 more categories of blocking
issues in the second pass above. All 5 are fixed here, in code and
documentation, in a single commit `fix(sec-005): close third pass of
final production preflight review`. Full technical writeup:
`docs/remediation/reports/SEC-005.md`, section "Исправления SEC-005 по
итогам третьего прохода финального независимого ревью". Summary:

1. **`rollback-from-plan`'s operation order corrected**: the
   `--expected-plan-sha256` integrity check and structural validation now
   run BEFORE `assertMaintenanceModeActive()` (a real Firestore read) or
   any candidate read/delete — previously the maintenance check ran
   first, meaning a tampered/wrong `--from-plan` in a production-shaped
   flow could still trigger one real Firestore read before being refused.
   Extracted into a new module, `scripts/lib/emergencyReconstruction.ts`
   (`runEmergencyReconstruction()`), specifically so this order is
   directly unit-testable with a read-counting fake Firestore
   (`scripts/lib/emergencyReconstruction.test.ts`) — a wrong hash, even
   with a fully valid, realistic dry-run report, now produces exactly
   zero `.get()`/`.delete()` calls. See "Maintenance/read-only mode"
   above.
2. **Removed the "recompute the hash from the surviving plan" runbook
   advice.** Recomputing `--expected-plan-sha256` from the very file it
   is meant to validate can never detect tampering (a file always
   "matches itself"). Step 5c now says explicitly: save the hash
   SEPARATELY from the plan file, BEFORE `apply` runs; if that
   independently-saved value is ever lost, the documented outcome is
   `BLOCKED — требуется действие владельца`, same as losing the plan file
   itself — never a freshly-recomputed substitute. See "Future production
   execution", Step 5c, and "Emergency scenario: apply-report lost", "If
   the independently-saved hash is lost", above.
3. **`--expected-report-sha256`/`--expected-plan-sha256` are now
   case-normalized to lowercase at CLI parse time** — PowerShell's
   `Get-FileHash -Algorithm SHA256` (which the docs point operators at)
   prints UPPERCASE hex by default, while `sha256Hex()` always produces
   lowercase; without normalization, a correctly-copied UPPERCASE value
   would have been rejected as a "mismatch" even though the underlying
   bytes matched. `SHA256_HEX_PATTERN`'s case-insensitive format check was
   already correct; the actual `===` comparison against the computed hash
   was not. Covered by new tests using uppercase and mixed-case input.
4. **Backup manifest now requires `createdAtUtc <= restore.verifiedAtUtc
   <= nowIso`** — a restore verified before its own backup was created,
   or verified in the future relative to when `apply` runs, is refused.
   See "Backup reference verification" above.
5. **`ProductionSafetyAudit.backupReference` now includes
   `membersChecksum`** — populated only after `verifyBackupReference()`
   has already confirmed `firestore.membersChecksum` and
   `restore.membersChecksum` exactly match, so its presence in the
   report's safe audit section is itself proof that comparison succeeded.
   Covered by a new `report.test.ts` suite (round-trip through
   `writeReport()`, and inclusion in `printSafeSummary()`'s stdout
   output).

**Production was not read or modified at any point in this round** — all
verification is against the Firestore Emulator and unit-level fake
Firestore stubs.

## Independent audit fixes — 4th round

A fourth independent-audit round, run against the merged doc-only PR #16
state (base SHA `3e70252faa7d7f48191a58c6e669b9fede82a247`), found 7
categories of blocking issues not covered by any earlier round. All 7 are
addressed here, on branch `remediation/SEC-005-independent-audit-fixes`.
**Production and staging were not read or modified at any point in this
round** — every fix is proven by pure unit tests (`scripts/lib/**.test.ts`)
and/or the real Firestore Emulator (`npm run test:migration`,
`scripts/backfill-memberships.emulator.test.ts`); `SEC-006` was not
started. This section documents the CODE-LEVEL contract; see
`docs/remediation/reports/SEC-005.md` for the full round narrative,
verification evidence, and CI status. **This round is doc+code only —
submitted as a Draft PR for independent review; `READY_FOR_REVIEW` is the
executor's own status, not a `REVIEW_RESULT: PASS`.**

### 3.1 — Finding-bound manual decisions

Previously, a decision was matched to a finding by identity alone
(`(companyId, uid)` or `uid`) — an old `exclude` recorded for a
`missing_company` orphan could silently "resolve" an unrelated LATER
finding at the same identity (e.g. a `role_mismatch` once the company
started existing). Fixed by requiring every `Decision` to carry
`findingType` (exactly which kind of finding — see `FindingType`,
`scripts/lib/types.ts`) and `evidenceFingerprint` (a SHA-256 over the
finding's own normalized evidence — `computeFindingFingerprint()`,
`scripts/lib/checksum.ts`). A decision is honored only when identity,
`findingType`, AND `evidenceFingerprint` ALL match the CURRENT finding
exactly (`buildPlan()`, `scripts/lib/planner.ts`). Resolution/findingType
compatibility is enforced by `COMPATIBLE_RESOLUTIONS`, checked
independently at both decisions-file validation time
(`scripts/lib/decisions.ts`) and again inside `buildPlan()`.
Stale (identity+findingType matched, fingerprint did not) and unused (no
current finding matched at all) decisions are now surfaced explicitly
(`PlanResult.staleDecisions`/`unusedDecisions`, report `counts.staleDecisions`/
`counts.unusedDecisions`) and always block `apply`/`verify`. Full contract:
see "Decisions file" above.

### 3.2 — Full source-state checksum

`sourceChecksum` only ever covered `extraction.confirmed` — it could not
prove the REST of the migration-relevant source (conflicts, orphans,
owner/malformed anomalies, which users/companies exist, existing
membership documents) was unchanged between two runs. Added
`sourceStateChecksum` (`computeFullSourceStateChecksum()`,
`scripts/lib/checksum.ts`) — see "Counts and checksum contract" above for
its exact contract. Never includes arbitrary unrelated Firestore fields;
never logs raw identifiers.

### 3.3 — Report schema v2 and evidence preservation

`REPORT_SCHEMA_VERSION` bumped `1 -> 2`. v1 discarded a finding's
originating evidence (which legacy source kind produced it, what roles
were observed, whether an invalid role was involved) at the moment the
record was created — structurally impossible to recover afterward (this
exact gap was independently identified and confirmed during a prior,
separate SEC-005 preflight round's local analysis of a real production
`missing_company` orphan). Every finding record now carries this evidence
directly:
- `OrphanRecord.sourceKinds` — sorted, deduplicated `RelationSourceKind[]`
  (`'users.home'`/`'users.companies[]'`/`'companies.ownerId'`) that
  produced the claim.
- `ConflictRecord.observedRoles`/`.hasInvalidRole`/`.sourceKinds` — valid
  observed roles (never a raw invalid value), a safe boolean flag for
  "at least one claim had an unrecognized role", and contributing source
  kinds.
- Every record (`OrphanRecord`, `ConflictRecord`, `OwnerAnomalyRecord`,
  `UnknownUserRecord`, `MalformedClaimRecord`, `OwnerIdAnomalyRecord`,
  `DanglingMembershipRecord`) carries `evidenceFingerprint`.
`validateStrictDryRunReportContent()`/`validateSourceReportForRollback()`
(`scripts/lib/productionSafety.ts`/`scripts/lib/rollbackValidation.ts`)
reject `schemaVersion !== 2` outright with a clear "wrong schema version"
error — a v1 report (from before this round) can never be accepted as
`--rollback-reference`/`--from-report`/`--from-plan`. The strict validator
was also independently strengthened (see 3.6 below). A production dry-run
report from BEFORE this round is stale by definition: **the old (pre-4th-round)
production dry-run result is no longer valid — a NEW production dry-run,
under a fresh `PRODUCTION_PREFLIGHT_APPROVED: SEC-005` or equivalent grant,
is required after this round merges. Any decisions file written against
that old dry-run's v1 report must be recreated from scratch against the
new v2 report (old decisions have neither `findingType` nor
`evidenceFingerprint` and are rejected by `scripts/lib/decisions.ts`
outright). The verification-only backup taken during the earlier
production preflight round was NEVER a valid `--backup-reference` for
`apply` in the first place (see "Important: this preflight's backup is
verification-only, NOT for apply" — freshness and maintenance-mode-ordering
requirements) and remains unusable for that purpose regardless of this
round. `apply` remains unconditionally refused for production
(`assertCycleExecutionAllowed()`, unchanged) — nothing in this round
touches that gate.**

### 3.4 — Fail-closed for corrupted legacy source containers

Previously silently ignored (no claim, no record, no trace at all):
`users/{uid}.companies` present but not an array; `users/{uid}.companyId`
present but not a usable string; `companies/{companyId}.ownerId` present
but not a usable string. Now all three become typed, BLOCKING findings —
reported even when the SAME user/company simultaneously has another valid
relation (`scripts/lib/legacyMapping.ts`):
- `companies_field_not_array`/`malformed_company_id` — new
  `MalformedClaimReason` values, user-level (acknowledgeable only via a
  user-level `exclude` decision, same mechanism as the pre-existing
  `malformed_companies_entry`).
- `malformed_owner_id` — a NEW record type, `OwnerIdAnomalyRecord`
  (`LegacyExtractionResult.ownerIdAnomalies`/`PlanResult.ownerIdAnomalies`),
  company-scoped, always blocking, and — like `DanglingMembershipRecord` —
  deliberately NEVER decision-resolvable: the corrupted `ownerId` field is
  the only thing that could identify a target, so there is no reliable
  identity to attach a decision to. Only repairing
  `companies/{companyId}.ownerId` itself clears it.
`companies.ownerId` simply being ABSENT (field not present at all) remains
correctly treated as "no owner claim" — not an anomaly.

### 3.5 — Verified source Git revision

`git rev-parse HEAD` alone proves only which commit is checked out, not
that the working tree still matches it — a locally modified tracked file
(staged, unstaged, or untracked-and-not-gitignored) meant `sourceGitSha`
could describe code that was NOT actually what ran. New module
`scripts/lib/sourceRevision.ts` (`assertCleanTrackedSourceRevision()`,
dependency-injected — `SourceRevisionDeps` — so the safety-critical order
is unit-testable with fake git-command results, never by mutating the real
checkout inside a test): checks `git status --porcelain` is empty BEFORE
`git rev-parse HEAD`, both BEFORE any credential acquisition or Firestore
I/O; throws `SourceRevisionError` (never a degraded placeholder like
`'unknown'`) on a dirty tree, a git-command failure, or a syntactically
invalid commit SHA. Wired into `scripts/backfill-memberships.ts`'s
`main()` for `--environment production` (any mode that reaches this point
— currently only `dry-run`, and automatically also `apply` once a future
round authorizes it) — a dirty production worktree now fails BEFORE
`initFirestore()` is ever called. Non-production environments keep the
existing lenient `readSourceGitSha()` (best-effort, `'unknown'` fallback)
— only production is required to prove this by task spec.

### 3.6 — Independent SHA-verified plan for production apply

`--expected-plan-sha256` previously only protected `rollback-from-plan`;
`--rollback-reference` for a production `apply` had no equivalent
integrity check on its own raw bytes. Fixed
(`scripts/lib/productionSafety.ts`'s `verifyRollbackPlanReference()`,
`scripts/backfill-memberships.ts`): `--expected-plan-sha256` is now
REQUIRED for a production `apply` too, checked against
`--rollback-reference`'s raw bytes BEFORE JSON parsing, credential
acquisition, or Firestore I/O — a tampered/swapped plan produces zero
reads and zero writes. After the hash check, `validateStrictDryRunReportContent()`
was independently strengthened: every `plannedCreates[].role` must be a
`KNOWN_ROLES` value (previously any non-empty string was accepted);
`.status` must be exactly `'active'`; every `counts.*` field must be a
non-negative integer; `counts.plannedCreates` must equal the actual
`plannedCreates` array length; `counts.unresolved === 0` must agree with
the sum of its component counts (an internally-inconsistent report is
refused). `verifyRollbackPlanReference()` also now performs a DIRECT
structural comparison of `plannedCreates` against the current run's own
plan (`plannedCreatesExactlyMatch()`, order-independent) — not reliance on
`targetChecksum` matching alone.

### 3.7 — Unambiguous CLI

`scripts/lib/cli.ts`'s argument parser now tracks every flag it has seen
and refuses a repeat outright — value-bearing or boolean, no exceptions —
so there is no "last argument wins" anywhere. `--apply` and an explicit
`--mode` together are refused too (two ways of saying the same thing,
never a legitimate combination, even when they happen to agree).

### Regression tests added

Pure unit coverage: `scripts/lib/checksum.test.ts` (finding fingerprints,
full source-state checksum — order-independence and per-field
sensitivity), `scripts/lib/decisions.test.ts` (finding-bound contract,
resolution compatibility, duplicate-by-triple), `scripts/lib/legacyMapping.test.ts`
(evidence capture, all three new fail-closed anomaly kinds, evidence
present alongside another valid claim), `scripts/lib/planner.test.ts`
(exclude-for-one-findingType-does-not-resolve-another, stale/unused
decisions, owner-id anomaly always blocking, malformed-source-with-
concurrent-valid-claim), `scripts/lib/productionSafety.test.ts`
(schema-v2 role/status/count strictness, plan-sha mismatch before parsing,
direct `plannedCreates` comparison). Real-behavior/zero-I/O coverage:
`scripts/lib/emergencyReconstruction.test.ts` (unchanged pattern, schema-v2
fixtures), `scripts/backfill-memberships.emulator.test.ts` (finding-bound
decisions end-to-end against the real Firestore Emulator, including the
new "confirm_role for missing_company is rejected outright" case). All
pre-existing idempotency/last-admin/rollback/TOCTOU/path-safety/dangling-
membership tests remain green, run twice consecutively for stability
(`npm run test:migration`, back-to-back).

## Independent audit fixes — 5th round

A fifth independent-audit round, run against PR #17's head at the time
(`4d3158a234353514700de0bc6c2425edf736eb13`), found 6 blocking logical
defects in the 4th round's own implementation — the CI-green, doc-complete
state of that round was not sufficient proof of correctness. All 6 are
addressed here, on the same branch (`remediation/SEC-005-independent-audit-fixes`).
**Production and staging were not read or modified at any point in this
round**; `SEC-006` was not started. See
`docs/remediation/reports/SEC-005.md` for the full round narrative.

### 1 — `sourceStateChecksum` was computed but never enforced

The 4th round added `computeFullSourceStateChecksum()` and wrote it into
every report, but `StrictDryRunReportFields` never required it and
`verifyRollbackPlanReference()` still only compared the older, narrower
`sourceChecksum` — a production report entirely missing
`sourceStateChecksum` was accepted. Fixed: `sourceStateChecksum` is now a
required field of `StrictDryRunReportFields`, validated as SHA-256 hex by
`validateStrictDryRunReportContent()`, and compared directly in
`matchRollbackPlanAgainstCurrent()` (see item 2 below) alongside
`sourceChecksum` — a mismatch in either is refused.

### 2 — `--expected-plan-sha256` was checked AFTER Firestore I/O

The 4th round's `verifyRollbackPlanReference()` did the hash+structural
check first internally, but the CALLER (`scripts/backfill-memberships.ts`)
invoked it only deep inside the `apply` branch — AFTER `initFirestore()`
and AFTER `readAllUsers()`/`readAllCompanies()`/`readAllExistingMemberships()`
had already run for every mode, apply included. The documented "wrong hash
→ zero Firestore I/O" guarantee did not hold as implemented. Fixed by
splitting the single function into two:
- `verifyRollbackPlanFileIntegrity(path, expectedPlanSha256, expectedProjectId)`
  — reads `--rollback-reference`, checks its raw-byte SHA-256, and
  structurally validates it via `validateStrictDryRunReportContent()`.
  Takes **no Firestore/db parameter at all** — structurally incapable of
  Firestore I/O, not merely documented as such.
- `matchRollbackPlanAgainstCurrent(verified, current)` — a pure comparison
  (`sourceGitSha`, `sourceChecksum`, `sourceStateChecksum`,
  `decisionsChecksum`, `targetChecksum`, and a direct `plannedCreates`
  structural match) against the current run's own computed values, no I/O
  of any kind.

`scripts/backfill-memberships.ts`'s `main()` now calls
`verifyRollbackPlanFileIntegrity()` for a production `apply` BEFORE
`initFirestore()` is ever called; `matchRollbackPlanAgainstCurrent()` runs
later, once the plan is computed. A wrong `--expected-plan-sha256` now
throws and returns before line 227's `initFirestore()` — proven by
`scripts/backfill-memberships.orchestration.test.ts` (source-order
assertion plus the zero-Firestore-parameter signature check) and by
`scripts/lib/emergencyReconstruction.test.ts`'s existing read/delete
counters for the equivalent `rollback-from-plan` path.

### 3 — Strict validator wrongly rejected a correctly-resolved orphan

`ReportCounts.missingCompanies`/`.missingUsers` count every orphan
DISCOVERED this run, including ones a decision already excluded.
`validateStrictDryRunReportContent()`'s internal-consistency check summed
these DISCOVERED totals into its expected `unresolved` total — so the real
SEC-005 production scenario (1 `missing_company` discovered, correctly
excluded by decision, 0 unresolved) was wrongly rejected as
internally-inconsistent. Fixed by adding `unresolvedMissingCompanies`/
`unresolvedMissingUsers` (post-decision, sourced from
`plan.unresolvedOrphans`) alongside the unchanged discovered-total fields;
only the new unresolved-only fields feed the consistency check.

### 4 — Incomplete evidence preservation and no resolved-findings audit trail

`OrphanRecord` lacked `observedRoles`/`hasInvalidRole`/`proposedRole`
(present on `ConflictRecord` since the 4th round, but never added to
orphans) — a missing role was not flagged as invalid, and a
single-valid-role orphan carried no proposal. Separately, a resolved
finding (a decision applying `exclude`, `accept_existing`, etc.) vanished
from the report entirely — only the still-unresolved subset was recorded,
with no trace of what was resolved, how, or by which decision. Fixed:
`OrphanRecord` now carries `observedRoles`/`hasInvalidRole`/`proposedRole`
(mirroring `ConflictRecord`); `PlanResult`/`MembershipBackfillReport` gained
`resolvedConflicts`/`resolvedOrphans`/`resolvedOwnerAnomalies`/
`resolvedUnknownUsers`/`resolvedMalformedClaims` — each an array of
`{finding, decision}` pairs — populated by `buildPlan()` at every
successful-resolution point. `REPORT_SCHEMA_VERSION` bumped `2 -> 3` for
both changes; `validateStrictDryRunReportContent()`/
`validateSourceReportForRollback()` reject `schemaVersion !== 3` outright,
so a v1 or v2 report can never be accepted as `--rollback-reference`/
`--from-report`/`--from-plan`. As with the 4th round's schema bump, any
production dry-run report from before this round is stale by definition —
a new dry-run is required before the next authorized production round.

### 5 — CLI accepted mode-incompatible flag combinations

The 4th round's CLI hardening (duplicate-flag rejection, `--apply`+`--mode`
mutual exclusion) checked that a mode's REQUIRED flags were present, but
never that a flag belonging to a DIFFERENT mode was absent — e.g.
`--mode dry-run --from-report … --expected-report-sha256 …` parsed
successfully even though `dry-run` reads neither flag. Fixed: `cli.ts` now
enforces a strict per-mode allowlist (`MODE_ALLOWED_FLAGS`, on top of a
small `UNIVERSAL_FLAGS` set valid for every mode) — any flag not universal
and not on the current mode's list is refused outright, after mode
resolution and before any required-flag check.

### 6 — Missing regression tests

`scripts/lib/sourceRevision.ts` (added in the 4th round) had zero dedicated
unit tests despite being a fail-closed, production-apply-gating check.
Added `scripts/lib/sourceRevision.test.ts` — dirty tree (staged/unstaged/
untracked), `runGitStatus`/`runGitRevParse` throwing, order enforcement
(rev-parse never called when status is dirty or fails), and malformed/
empty/wrong-length/non-hex SHA output, all via the module's injected
`SourceRevisionDeps` fakes — never by mutating this repo's real checkout.
Added `scripts/backfill-memberships.orchestration.test.ts` for item 2's
zero-Firestore-I/O claim (see above).

### Regression tests added

`scripts/lib/cli.test.ts` (mode-specific allowlist: each cross-mode flag
combination the reviewer flagged now throws, each mode's own legitimate
flag set still parses); `scripts/lib/sourceRevision.test.ts` (new file, see
item 6); `scripts/backfill-memberships.orchestration.test.ts` (new file,
see item 6); `scripts/lib/productionSafety.test.ts` (`sourceStateChecksum`
required and compared, the exact "1 missing_company discovered + correctly
excluded → 0 unresolved" scenario from item 3, Phase A/Phase B split with a
dedicated "Phase A alone needs no `current` value" case);
`scripts/lib/planner.test.ts`/`scripts/lib/checksum.test.ts` (updated
`OrphanRecord` fixtures for the new required evidence fields);
`scripts/lib/report.test.ts` (schema v3 fields round-trip);
`scripts/lib/emergencyReconstruction.test.ts` (fixture updated to include
`sourceStateChecksum` — this round's item 1 fix made it a required field,
which the existing fixture predates). All pre-existing tests remain green;
`npm run test:migration` run twice consecutively for stability.

## Independent audit fixes — 5th round, review of the round's own fix

A follow-up independent-review round, run against this branch's HEAD after
the 5th round above, confirmed items 1/2/3 of that round genuinely fixed
but found 3 further blocking defects IN THAT ROUND'S OWN FIX, plus one
test-adequacy gap. All are addressed here, same branch, same PR.
**Production and staging were not read or modified.** `SEC-006` not
started.

### 1 — Missing `role` was still treated as valid orphan evidence

`legacyMapping.ts`'s `recordOrphanEvidence()` set `hasInvalidRole = true`
only when `roleValue !== undefined` — a relation with NO `role` field at
all (as opposed to a present-but-wrong one) contributed no evidence at all,
leaving `hasInvalidRole: false`. This was inconsistent with the
CONFIRMED/CONFLICT path elsewhere in the same file, which already treats a
missing role exactly like an invalid one (`isKnownRole(undefined)` is
`false`, so `invalidClaimKeys` picks it up either way — see the existing
"treats a missing role field the same way" test). Fixed by removing the
`roleValue !== undefined` guard — a missing role and an invalid role now
both set `hasInvalidRole: true` for orphan evidence too. (Unrelated:
`pushMissingUserOrphan()`'s `hasInvalidRole: false` for `companies.ownerId`
orphans is intentionally unchanged — that source carries no role claim of
any kind, so there is nothing to be invalid.)

### 2 — CLI allowlist wrongly treated `--decisions-file` as universal

`--decisions-file` is read unconditionally near the top of `main()`, but
its result (`decisionsResult`) is only ever consumed by `buildPlan()` for
`dry-run`/`verify`/`apply` — `rollback-from-report`/`rollback-from-plan`
return from a dedicated rollback function before it is touched again. The
5th round's own `UNIVERSAL_FLAGS` incorrectly included it, so
`--mode rollback-from-report --decisions-file x` parsed successfully even
though `x` is silently ignored. Fixed by moving `--decisions-file` out of
`UNIVERSAL_FLAGS` and into only `dry-run`/`verify`/`apply`'s
`MODE_ALLOWED_FLAGS` entries.

### 3 — Schema v3's resolved-findings audit trail was not actually required

`validateStrictDryRunReportContent()` checks `schemaVersion === 3` but
never verified that v3's own defining feature — the resolved-findings
audit trail (`resolvedConflicts`/`resolvedOrphans`/`resolvedOwnerAnomalies`/
`resolvedUnknownUsers`/`resolvedMalformedClaims`) — was actually present. A
report claiming `schemaVersion: 3` but missing this audit trail entirely
was accepted. Fixed: each of the 5 fields must be present as an array of
`{finding, decision}`-shaped objects (structural presence, not a full
re-validation against `decisions.ts`'s complete schema — that would
duplicate decision-file validation for data this tool itself produces).

### 4 — Orchestration proof was textual, not executable

The previous round's `scripts/backfill-memberships.orchestration.test.ts`
proved "plan-hash check precedes `initFirestore()`" by reading
`backfill-memberships.ts`'s source text and checking substring order
(`indexOf()`) — a real claim about the code, but not an EXECUTABLE proof
that the real running program never acquires credentials on a wrong hash.
Fixed by extracting the production-apply preflight (flag-presence checks +
the plan-file-integrity call) out of `main()` into a new exported,
dependency-injected function, `runProductionApplyPreflight()`
(`scripts/lib/productionSafety.ts`) — `main()` calls this function
directly (not a parallel reimplementation of its body), so a test that
injects a COUNTING FAKE for its `acquireFirestore` dependency (which
`main()` wires to the real `initFirestore`) and gives it a wrong plan hash
is observing the real call site's behavior:
- Wrong hash: `verifyPlanFile` throws, `acquireFirestore` is called **zero**
  times.
- Correct hash: `verifyPlanFile` succeeds, `acquireFirestore` is called
  **exactly once**, strictly after verification.

`scripts/backfill-memberships.orchestration.test.ts` was narrowed to a
much smaller, honestly-scoped "wiring" guard (main() actually delegates to
the tested function rather than reimplementing or bypassing it) — the
executable behavioral proof lives entirely in
`scripts/lib/productionSafety.test.ts`'s `runProductionApplyPreflight`
describe block.

### Regression tests added

`scripts/lib/legacyMapping.test.ts` (missing-role orphan now flagged
`hasInvalidRole: true`; missing role vs. invalid role parity; the
unaffected valid-single-role case still gets a `proposedRole`);
`scripts/lib/cli.test.ts` (`--decisions-file` rejected under both rollback
modes, still accepted under `verify`/`apply`); `scripts/lib/productionSafety.test.ts`
(schema v3's 5 resolved-findings fields required in all three `validDryRun`
fixtures; new `runProductionApplyPreflight` describe block — wrong-hash
zero-acquisition, correct-hash exactly-once-after-verification, argument
pass-through, and each of the 4 required-flag presence checks refusing
before either dependency is touched); `scripts/backfill-memberships.orchestration.test.ts`
(rewritten — wiring-only checks); `scripts/lib/emergencyReconstruction.test.ts`
(fixture gains the 5 resolved-findings fields, required by item 3 above).
All pre-existing tests remain green; `npm run test:migration` run twice
consecutively for stability.

## Independent audit fixes — 5th round, 2nd follow-up review

A second follow-up independent-review round confirmed the previous
round's 4 fixes correct, but found one further blocking defect: the
resolved-findings audit trail's schema-v3 validation was shallow.
**Production and staging were not read or modified.** `SEC-006` not
started.

### The defect

`validateStrictDryRunReportContent()`'s resolved-findings check (added the
previous round) only verified that `finding`/`decision` were present,
non-array objects — never their actual content. Two independent negative
tests proved the gap:
- A report claiming `missingCompanies: 1, unresolvedMissingCompanies: 0`
  with `resolvedOrphans: []` was accepted — the orphan simply vanished,
  accounted for neither as unresolved nor as resolved.
- `resolvedOrphans: [{ finding: {}, decision: {} }]` was accepted —
  structurally present, semantically empty.

### The fix

`scripts/lib/productionSafety.ts` gained two new validators, applied to
every entry of all 5 resolved-findings arrays:
- `validateResolvedFindingRecord()` — validates `finding` against its
  actual record type's shape: `uid` (required), `companyId` (required for
  conflicts/orphans/owner-anomalies, must be ABSENT for the user-level
  unknown-users/malformed-claims types), `reason` (must be one of that
  finding type's real reason literals), `evidenceFingerprint` (SHA-256
  hex).
- `validateResolvingDecisionRecord()` — validates `decision` against
  `Decision`'s shape (`uid`, optional `companyId`, `findingType`,
  `evidenceFingerprint`, `resolution` ∈ `DecisionResolution`, `reason`,
  `reviewedBy`, `reviewedAt` as a valid timestamp, `role` required when
  `resolution === 'confirm_role'`), THEN cross-checks that `decision` is
  genuinely THE decision that resolved THIS `finding`: `findingType ===
  finding.reason`, `evidenceFingerprint` equality, `uid`/`companyId`
  identity equality, and resolution/finding-type compatibility via the
  existing `COMPATIBLE_RESOLUTIONS` map (e.g. `confirm_role` for a
  `missing_company` orphan is rejected — only `exclude` is compatible).

Separately, the discovered/unresolved/resolved reconciliation the
previous round was missing is now enforced directly: `counts.missingCompanies`
must equal `counts.unresolvedMissingCompanies` PLUS the count of
`resolvedOrphans` entries whose `finding.reason === 'missing_company'`
(same for `missingUsers`). This is the only such reconciliation possible —
conflicts/ownerAnomalies/unknownUsers/malformedClaims only ever expose an
UNRESOLVED-only count in `ReportCounts` (no discovered-total field for
those), so there is nothing to reconcile their `resolvedX` arrays against
beyond the deep structural/cross-field validation above.

### Regression tests added

`scripts/lib/productionSafety.test.ts` — a `resolvedMissingCompanyOrphan()`
fixture helper producing a genuinely consistent `{finding, decision}` pair,
plus: rejects "1 missing_company discovered, 0 unresolved" with an empty
`resolvedOrphans` (the reviewer's first negative example); rejects
`{finding: {}, decision: {}}` (the second); accepts the same scenario when
backed by a real, consistent `resolvedOrphans` entry (the reviewer's
requested positive test); rejects mismatched `evidenceFingerprint`,
mismatched `findingType`, mismatched `uid`, mismatched `companyId`,
resolution incompatible with the finding's reason, an invalid `reason` for
the array's finding type, an invalid `reviewedAt`, and a user-level finding
(`resolvedUnknownUsers`) whose `finding.companyId` is present when it must
be absent. The existing "accepts 1 missing_company + 0 unresolved" test
from the previous round was itself updated to supply a real
`resolvedOrphans` entry — it was previously passing only because the
validator did not yet check the array's content. All pre-existing tests
remain green; `npm run test:migration` run twice consecutively for
stability.

## Independent audit fixes — 5th round, 3rd follow-up review

A third follow-up independent-review round found the previous round's deep
resolvedX validation was still incomplete in three ways, all confirmed by
independent negative tests against real crafted reports. **Production and
staging were not read or modified.** `SEC-006` not started.

### The three gaps

1. **The report's UNRESOLVED finding arrays were never required or
   validated at all.** A report entirely missing `conflicts`/`orphans`/
   `unknownUsers`/`malformedClaims`/`danglingMemberships`/`ownerIdAnomalies`/
   `staleDecisions`/`unusedDecisions` still passed.
2. **`resolvedOrphans`' `finding` was only checked for the fields common
   to every finding type** (uid/companyId/reason/evidenceFingerprint) —
   `OrphanRecord`'s own required fields (`sourceKinds`/`observedRoles`/
   `hasInvalidRole`/`proposedRole`) were never checked, so an
   `OrphanRecord` missing all four still passed.
3. **`decision` objects were validated by a hand-rolled, parallel
   reimplementation** of `decisions.ts`'s real contract — it never
   rejected unknown fields (`{..., unexpected: 'x'}` passed) and never
   forbade `role` when `resolution !== 'confirm_role'`.

### The fix

`scripts/lib/productionSafety.ts` now has a dedicated shape validator per
record type (`validateConflictRecordShape`/`validateOrphanRecordShape`/
`validateOwnerAnomalyRecordShape`/`validateUnknownUserRecordShape`/
`validateMalformedClaimRecordShape`/`validateDanglingMembershipRecordShape`/
`validateOwnerIdAnomalyRecordShape`) — each checks every field the real
`types.ts` interface defines (required vs. optional, exact reason
literals, array-of-known-role/source-kind contents, and — for
`OrphanRecord` — that `proposedRole` is derivably consistent with
`observedRoles`/`hasInvalidRole`, matching the record type's own doc
comment) and rejects any field not in that type's allowed set. The SAME
validator is applied to a finding whether it appears in an unresolved
array (`report.orphans[i]`) or as the `finding` half of a resolved pair
(`report.resolvedOrphans[i].finding`) — the shape is identical either way.

`decision` validation was replaced entirely with a call to
`decisions.ts`'s own `validateDecisions()` — the SAME function that
validates an operator's `--decisions-file` — so the two contracts can
never drift apart again; this alone closes gap 3 (unknown-field rejection
and the `role`-forbidden-unless-`confirm_role` rule come for free).

Every unresolved array's length is now reconciled against its
corresponding `counts` field (`conflicts.length === counts.conflicts`,
`orphans.length === counts.unresolvedMissingCompanies +
counts.unresolvedMissingUsers`, etc.) — since `counts.unresolved === 0` is
already required for any of these validators to accept a report at all,
every one of these arrays is required to be empty in practice, but the
presence-and-shape check now actually enforces that rather than merely
implying it via an unrelated count.

### Regression tests added

`scripts/lib/productionSafety.test.ts` — a report missing all required
unresolved arrays; each unresolved array missing individually (parametrized
over all 9); an unresolved array whose length disagrees with its `counts`
field; a `resolvedOrphans` entry whose `OrphanRecord` lacks
`sourceKinds`/`observedRoles`/`hasInvalidRole`/`proposedRole`; a decision
carrying `role` alongside `resolution: 'exclude'`; a decision carrying an
unknown field; and a full, realistic, internally-consistent schema-v3
report (one `missing_company` orphan correctly resolved by `exclude`,
every other array empty) — accepted. All three `validDryRun` fixtures
across the file gained the 9 required unresolved-array fields (empty, to
match their all-zero default counts). All pre-existing tests remain green;
`npm run test:migration` run twice consecutively for stability.

## Independent audit fixes — 5th round, 4th follow-up review

A fourth follow-up independent-review round found two further blocking
gaps: the resolved/stale/unused audit trail was never cross-checked
against `decisionsChecksum` (allowing a decision to silently vanish from
every audit-trail bucket while every other check stayed internally
consistent), and the last-admin gate's blocked companies
(`plan.companiesWithoutAdmin`) had no dedicated count or array anywhere in
the report despite already contributing to `counts.unresolved`.
**Production and staging were not read or modified.** `SEC-006` not
started.

### 1 — decisionsChecksum was not linked to the audit trail

`decisionsChecksum` (the checksum over the FULL original `--decisions-file`,
computed once by `readDecisionsFile()`) was validated only for format
(SHA-256 hex) — nothing proved it was actually reconstructible from the
report's own resolved/stale/unused audit trail. A report could claim a
`decisionsChecksum` matching a real decisions file while silently DROPPING
one of its decisions from every bucket — every other check stayed
internally consistent (each bucket's own contents were valid; there was
simply one fewer entry than there should have been), so the omission was
invisible to a reviewer relying on the report alone.

Fixed in `scripts/lib/productionSafety.ts`'s `validateStrictDryRunReportContent()`:
- Every decision is collected from EXACTLY the five `resolvedX[].decision`
  arrays plus `staleDecisions`/`unusedDecisions`, combined into ONE list.
- That list is validated as a SINGLE batch via `decisions.ts`'s
  `validateDecisions()` (not per-item) — a single call over the whole set
  catches a decision duplicated ACROSS buckets (present in, say, both
  `resolvedOrphans` and `staleDecisions`), which per-item validation could
  never see. In practice this specific cross-bucket scenario is also
  independently caught earlier by the pre-existing `counts.unresolved ===
  0` / component-sum consistency check, since `staleDecisions`/
  `unusedDecisions` being non-empty always makes `unresolved` non-zero —
  the two checks reinforce each other.
- The validated, normalized decisions are re-hashed with
  `computeDecisionsChecksum()` and compared byte-for-byte against
  `report.decisionsChecksum` — any mismatch (missing, duplicated, or
  altered decision) is refused.
- Each resolved finding IDENTITY (`companyId?`, `uid`, `reason`,
  `evidenceFingerprint`) is separately required to appear exactly once
  across all five `resolvedX` arrays combined — a `{finding, decision}`
  pair duplicated within (or across) the resolved buckets is refused even
  before the checksum comparison runs.

Because `verifyRollbackPlanFileIntegrity()` (Phase A) delegates to
`validateStrictDryRunReportContent()`, this check applies transitively to
the whole `--rollback-reference` pipeline — `matchRollbackPlanAgainstCurrent()`
(Phase B) can never even be reached for a report with a missing or
duplicated audit trail; Phase A already refuses it first.

### 2 — companiesWithoutAdmin was not exposed in the report

`plan.companiesWithoutAdmin.length` (companies whose projected final state
— existing active admins + planned admin creates — has zero admin) was
already summed into `counts.unresolved` and already blocked
`applyAllowed`, but had no dedicated `counts.companiesWithoutAdmin` field
and no corresponding array anywhere in the report — a reviewer could see
the last-admin gate had blocked something, but never WHICH company, from
the report alone.

Fixed:
- `ReportCounts` gained `companiesWithoutAdmin: number` (included in the
  strict validator's non-negative-integer check and in the
  `unresolvedComponents` consistency sum, alongside the pre-existing
  `ownerWithoutAdminMembership`).
- `MembershipBackfillReport` gained a private `companiesWithoutAdmin:
  string[]` field — populated from `plan.companiesWithoutAdmin` in every
  mode that computes a plan (dry-run/apply/verify), `[]` for every
  rollback mode (which never computes one). Never printed to the safe
  stdout summary (`printSafeSummary()` only ever echoes `report.counts`,
  never this array directly) — only the count reaches stdout.
- `validateStrictDryRunReportContent()` requires the array present, every
  entry a non-empty string, no duplicates, and its length matching
  `counts.companiesWithoutAdmin` exactly.
- **`REPORT_SCHEMA_VERSION` bumped `3 -> 4`** — a v3 (or earlier) report
  can never satisfy the new required field; the schemaVersion-mismatch
  error message now explicitly says a new `--mode dry-run` against the
  current tool is required.

### Regression tests added

`scripts/lib/productionSafety.test.ts` — two new nested `describe` blocks
inside `verifyStrictDryRunReport`: "decisionsChecksum <-> audit trail
reconciliation" (a decision reflected in `decisionsChecksum` but absent
from every array; the same malformed report also rejected at Phase A of
`verifyRollbackPlanFileIntegrity` before Phase B is ever reached; a
duplicated `{finding, decision}` pair within `resolvedOrphans`; a decision
simultaneously claimed as resolved and stale; a `decisionsChecksum` that
simply doesn't match the collected audit trail; zero decisions accepted;
a full multi-bucket audit trail — one resolved orphan + one resolved
conflict — accepted) and "companiesWithoutAdmin" (length-vs-count
mismatch, duplicate companyId, empty-string entry, non-string entry,
`unresolved === 0` with `companiesWithoutAdmin` non-zero, and the
empty/zero happy path). All three `validDryRun` fixtures across the file
now use a computed `EMPTY_DECISIONS_CHECKSUM` (`computeDecisionsChecksum([])`)
instead of an arbitrary hex value, and gained `companiesWithoutAdmin: []`.
`scripts/backfill-memberships.emulator.test.ts` — a real end-to-end case:
a company with zero legacy relations and zero existing admin is surfaced
as `companiesWithoutAdmin` in both dry-run (reports it, exit 0) and apply
(blocked by it, exit 1) reports, against the real Firestore Emulator. All
pre-existing tests remain green; `npm run test:migration` run twice
consecutively for stability (508/508 both times).

## Independent audit fixes — production execution gate round

Following two independently-audited, owner-approved production read-only
dry-runs (a discovery run, and a resolved run against a single
owner-approved `exclude` decision — see
`docs/remediation/reports/SEC-005.md` for their anonymized results), the
repository owner granted `PRODUCTION_ACTION_APPROVED: SEC-005` — a
controlled production cycle covering maintenance enable, verified backup,
create-only apply against the verified resolved plan, verify, maintenance
disable, and rollback-from-report/rollback-from-plan as the emergency
path. This round prepares the code, tests, and documentation for that
cycle. **No production or staging action was taken in this round** — no
maintenance-mode change, no backup, no apply, no verify, no rollback. The
grant itself requires a SEPARATE, explicit execution command before any
individual step actually runs.

### 1 — `assertCycleExecutionAllowed()` redesigned around explicit, typed actions

The previous signature (`assertCycleExecutionAllowed(environment, mode?)`)
made the authorization decision hinge on an OPTIONAL parameter — a caller
that forgot to pass `mode` got the SAME refusal as an explicitly
disallowed one, which happened to be safe (fail-closed by omission) but
relied on that coincidence rather than the type system. Redesigned:
- A new, exported `CycleExecutionAction` union covers every action ANY
  part of the SEC-005 tooling can attempt: the five `ReportMode`s, plus
  `maintenance-enable`/`maintenance-disable` (`scripts/ops/set-maintenance-mode.ts`,
  which has no `ReportMode` concept of its own).
- `action` is now a REQUIRED parameter — there is no `undefined` shortcut
  a caller can pass to mean "refused"; the type checker enforces that
  every call site names exactly which action it is attempting.
- A `KNOWN_ACTIONS` set fail-closes on any value that somehow bypasses the
  type checker (e.g. an `as` cast from untrusted input) — for EVERY
  environment, not just production.
- A `PRODUCTION_ALLOWED_ACTIONS` set (currently identical to
  `KNOWN_ACTIONS` — the full action set, reflecting the new grant's full
  scope) replaces the old `mode !== 'dry-run'` check. `emulator`/`staging`
  remain authorized for any known action, unchanged.
- Both call sites (`scripts/backfill-memberships.ts`,
  `scripts/ops/set-maintenance-mode.ts`) now pass an explicit action; no
  environment variable, arbitrary string, or optional flag can widen or
  bypass this gate — the same closed design as before, just with a wider
  authorized set and no optional-parameter ambiguity.

This gate answers ONLY "has ANY grant authorized this (environment,
action) pair at all" — it does not itself verify maintenance state, backup
freshness, plan integrity, or worktree cleanliness. None of those
INDEPENDENT protections (`scripts/lib/productionSafety.ts`'s live
maintenance check / backup freshness / two-phase rollback-plan
verification / create-only writes; `scripts/lib/sourceRevision.ts`'s clean
tracked worktree) were touched or weakened this round.

### 2 — `scripts/ops/set-maintenance-mode.ts` hardened for production admission

Previously a straightforward, non-transactional `set()`/`set(...,
{merge:true})` pair, with the production gate doing all the safety work
(unconditional refusal). With that gate now open for
`maintenance-enable`/`maintenance-disable`, the script itself needed real
protections:
- Every write to `system/maintenance` now happens inside a Firestore
  **transaction** (`transactionalEnable()`/`transactionalDisable()`, both
  exported and unit-tested directly) — a concurrent modification between
  the transaction's read and write aborts and Firestore automatically
  retries against the new state, so two racing calls can never both "win"
  or produce a torn/mixed write.
- `--enable` is allowed only when the document does not exist, or exists
  with `enabled === false` STRICTLY (not merely "not `true`" — a
  malformed/non-boolean `enabled` field is treated as unverifiable and
  refused). Against an already-enabled record, `--enable` now REFUSES
  (`MaintenanceModeStateError`, exit 1) rather than silently overwriting —
  the document is left completely untouched, `enabledAt` included.
- `--disable` now requires `--task-id` too (previously `--enable`-only),
  and refuses to disable a record whose own `taskId` field does not match
  the one supplied — a caller can never disable a different task's
  maintenance window, even by accident. Disabling a record that does not
  exist, or one already disabled for the SAME task, is a safe, idempotent
  no-op (`changed: false`, exit 0, no write at all).
- For `--environment production`, `--task-id` must be exactly `SEC-005` —
  the only task currently granted a production maintenance-mode
  authorization — checked entirely inside argument parsing
  (`maintenanceModeCli.ts`), with zero credential acquisition or Firestore
  I/O, regardless of the cycle gate's own state.
- The cycle-execution gate is still checked before `initFirestore()` — the
  script now passes `'maintenance-enable'`/`'maintenance-disable'`
  explicitly, matching item 1 above.

### Regression tests added

`scripts/lib/firebaseAdmin.test.ts` — `assertCycleExecutionAllowed`
rewritten: every known action accepted for `emulator`/`staging` AND now
`production` (parametrized over all seven); an unrecognized action string
refused fail-closed for every environment, with a distinct "unknown
action" error message. `scripts/ops/maintenanceModeCli.test.ts` —
`--disable` now requires `--task-id`; `--environment production` requires
`--task-id` exactly `"SEC-005"`; `emulator`/`staging` allow any
`--task-id` (the production-only restriction does not apply).
`scripts/ops/maintenanceModeTransaction.emulator.test.ts` (new file) —
`transactionalEnable()`/`transactionalDisable()` tested directly against
the real Firestore Emulator: enable from missing/verifiably-disabled;
enable refused (document untouched) when already enabled; enable refused
on an unverifiable (non-boolean) existing `enabled` field; disable is a
no-op when no document exists; disable refused (document untouched) for a
different `taskId`; disable succeeds and preserves the historical audit
fields; disable is an idempotent no-op for an already-disabled SEC-005
record; two concurrent `transactionalEnable()` calls — exactly one
succeeds, the other is refused, never both, never a mixed write; a
concurrent enable/disable pair against the same document resolves to an
internally-consistent final state (never `enabled: true` with a
`disabledAt` set, or vice versa). `scripts/ops/set-maintenance-mode.emulator.test.ts` —
updated `--disable` calls to include `--task-id`; the old, now-FALSE
"production refused unconditionally" test replaced with a safe,
zero-I/O test proving a non-`SEC-005` `--task-id` is refused for
production by argument parsing alone; added CLI-spawn-level (not just
direct-function-level) coverage for cross-task disable refusal, idempotent
disable, and already-enabled refusal, confirming the full argument-parsing
→ gate → transaction wiring end to end.
`scripts/backfill-memberships.emulator.test.ts` — the three now-FALSE
"production refused (exit 4)" tests for `apply`/`verify`/`rollback-from-report`/
`rollback-from-plan` were removed (production is no longer refused for
these — asserting otherwise would be asserting something false); replaced
with a single safe test proving an unrecognized `--mode` value is refused
by argument parsing, before the cycle gate or any I/O, for ANY
environment. The ALLOW side of the gate for production is proven
exhaustively at the unit level only
(`scripts/lib/firebaseAdmin.test.ts`) — deliberately never via the real
CLI binary against `--environment production` in the automated suite,
since doing so would (with the gate now open) proceed toward real
credential acquisition and Firestore I/O against the real
`finapp-prod-10a83` project, which an automated test suite must never
risk. All pre-existing apply/rollback safety tests remain green;
`npm run test:migration` run twice consecutively for stability
(538/538 both times).

## Independent audit fixes — production execution gate audit-fix round

An independent review of PR #18 (the production execution gate round
above) returned `REVIEW_RESULT: CHANGES_REQUIRED`, identifying 4
categories of blocking issues. This round is code/test/doc fixes only —
**no production or staging action was taken**; the PR remained Draft.

### 1 — `set-maintenance-mode.ts` unconditionally called `main()` at import time

The reviewer reproduced: `await import('./scripts/ops/set-maintenance-mode.ts')`
printed `Argument error: --environment is required...` and set
`process.exitCode = 2`, purely as a side effect of the import — because
the file's bottom-level `main().then(...)` runs unconditionally whenever
the module is evaluated, regardless of who imported it or why. The
emulator tests for `transactionalEnable()`/`transactionalDisable()` had
been importing those functions FROM this file, meaning the test suite
itself depended on this accidental "it happens not to crash the whole
process" behavior.

**Fix**: moved `transactionalEnable()`, `transactionalDisable()`,
`MaintenanceModeStateError`, and `MaintenanceTransitionResult` into a new,
side-effect-free module, `scripts/ops/maintenanceModeTransaction.ts` —
no argv parsing, no `main()` call, nothing runs merely by importing it.
`set-maintenance-mode.ts` is now a pure CLI entrypoint: it imports the
transaction functions from the new module and otherwise only parses argv
and calls `main()`. `scripts/ops/maintenanceModeTransaction.emulator.test.ts`
now imports from the new module instead.

**Regression test**: `scripts/ops/maintenanceModeImportSafety.test.ts`
(new file) spawns a genuinely separate `node` process (in-process
assertions cannot reproduce this class of bug, since `process.argv`/
`process.exitCode` inside the SAME vitest worker belong to the test
runner, not to a simulated CLI invocation) that imports
`maintenanceModeTransaction.ts` alone, with both CLI-nonsensical argv
(`--environment production --enable`) and empty argv, and asserts exit
code 0, `stdout` containing a plain "import succeeded" marker, and EMPTY
`stderr` — proving no CLI logic and no `process.exitCode` mutation occur
merely from the import. The same test, pointed at
`set-maintenance-mode.ts` instead, was manually confirmed to reproduce
the reviewer's exact finding (exit 2, "Argument error" on stderr) before
this fix, and to no longer apply to `set-maintenance-mode.ts` after it
(that file is not expected to be import-safe — it is a CLI entrypoint by
design; only the new module needs to be).

### 2 — `transactionalDisable()` was not fail-closed on a malformed `enabled` field

Previously, after the `taskId` match check, `transactionalDisable()`
branched only on `data.enabled === false` (idempotent no-op) vs.
"anything else" (proceed to disable) — so a document with `enabled`
missing entirely, `null`, a string, a number, or an object would be
silently treated as "currently enabled" and disabled without complaint,
exactly the class of bug `transactionalEnable()` already guarded against
for the mirror case (a non-boolean-false `enabled` there is refused, not
silently trusted).

**Fix**: `transactionalDisable()` (`scripts/ops/maintenanceModeTransaction.ts`)
now requires, after the `taskId` match, EXACTLY `enabled === true`
(proceed to disable) or `enabled === false` (idempotent no-op) — any
other value throws `MaintenanceModeStateError` with the document left
completely untouched.

**Regression tests**: added to
`scripts/ops/maintenanceModeTransaction.emulator.test.ts` — missing
`enabled` field, a string `enabled`, `null` `enabled`, a number
`enabled`, and an object `enabled`, each asserting a thrown
`MaintenanceModeStateError` AND that the document is byte-for-byte
unchanged (`toEqual` against the pre-call read). The pre-existing
cross-task-disable, idempotent-disable, and concurrent-modification tests
are unchanged.

### 3 — `maintenanceModeCli.ts` allowed silent "last value wins" for every flag

Unlike `scripts/lib/cli.ts` (the main tool's parser, which rejects any
repeated flag outright — see its `markSeenOnce()`), the maintenance-mode
parser accepted a repeated `--project`, `--reason`, `--operator`, or any
other flag, with the LAST occurrence silently winning — e.g. `--operator
alice --operator mallory` parsed successfully as `operator: 'mallory'`
with no indication the command was ambiguous.

**Fix**: `parseMaintenanceModeCliArgs()` now has the same `markSeenOnce()`
pattern as `scripts/lib/cli.ts` — EVERY flag (`--environment`,
`--project`, `--confirm-project`, `--enable`, `--disable`, `--reason`,
`--task-id`, `--operator`) throws `MaintenanceModeCliArgError` on a
second occurrence, even when the repeated value is identical to the
first.

**Regression tests**: `scripts/ops/maintenanceModeCli.test.ts` gained a
parametrized case per value-bearing flag (`--environment`, `--project`,
`--confirm-project`, `--reason`, `--task-id`, `--operator`) plus
dedicated cases for `--enable`/`--disable`, all asserting the specific
"was specified more than once" message; and two CLI-level tests
(repeated `--operator`, repeated `--task-id` against `--environment
production`) confirming the parser — which never performs any I/O at
all — refuses before `set-maintenance-mode.ts` would go on to call
`assertEnvironmentGuard()`/`initFirestore()`.

### 4 — runbook drift from the actual CLI/gate behavior

Several passages in "Production execution" and
"`scripts/ops/set-maintenance-mode.ts` — the real operator script" still
described superseded or simply incorrect behavior:

- The "allowed past this gate ONLY for `--mode dry-run`" passage was
  still describing the PRE-`PRODUCTION_ACTION_APPROVED` state, even
  though this document's own "Production execution" section (added in
  the prior round) already correctly described the widened gate — the
  two sections contradicted each other. Rewritten to state the current
  seven-action authorized set plainly, and to clarify the gate answers
  only "is this (environment, action) pair authorized this cycle", never
  a substitute for `apply`'s independent safety preconditions.
- Step 1 claimed the maintenance-mode-aware Rules/Functions deploy was
  "separate, out of scope for this cycle" as if still pending — it was
  already deployed and independently verified during the production
  preflight round. Rewritten as a completed prerequisite check, with an
  explicit warning against re-deploying without separate CLAUDE.md §5
  authorization.
- Step 2 called `--disable` against a possibly-missing document a
  "bootstrap" that establishes `{enabled: false}` — false:
  `transactionalDisable()` against a missing document is a no-op that
  writes nothing at all (see `scripts/ops/maintenanceModeTransaction.ts`).
  Rewritten as a read-only precheck of the document's current state, with
  an explicit correction that it does not create anything.
- The matching false claim under "the real operator script" ("this is
  also what makes `--disable` safe to use as the ... bootstrap in Step 2")
  was removed and replaced with an explicit statement of the fail-closed
  `enabled`-field behavior from fix #2 above.
- Steps 2 and 8's `--disable` command examples were missing `--task-id
  SEC-005` (now required for every `--disable`, including production,
  since the earlier "`--enable`-only" round) — added to both, and to the
  emergency-rollback command block.
- Added a new Step 9 requiring the gate to be narrowed back down again in
  a separate PR after a real production cycle (or rollback) completes,
  with an explicit note that this is an operational follow-up process,
  not something the current code enforces or expires automatically.
- The top-of-document "Status of this document" banner still asserted
  "Production execution remains unconditionally refused" — stale since
  `PRODUCTION_ACTION_APPROVED: SEC-005` was granted in the prior round.
  Rewritten to state the actual current status (gate open for the full
  action set; no individual step actually executed yet), and two missing
  "this document was updated" entries (preflight-approval round,
  execution-gate round) were added to the running list at the top for
  consistency with every earlier round.

**Regression test**: `scripts/ops/maintenanceModeRunbookDocContract.test.ts`
(new file) — extracts every CONCRETE (no remaining `<placeholder>` token
other than the documented `<your-identifier>` operator convention)
`node scripts/ops/set-maintenance-mode.ts` invocation from this document
and feeds it through the REAL `parseMaintenanceModeCliArgs()`, asserting
none of them throw, and that every `--environment production` example
parses with `taskId === 'SEC-005'`. This is a genuine regression test,
not a hand-maintained duplicate of the CLI's rules — a future doc edit
that drifts from the actual parser (e.g. dropping a now-required
`--task-id`) fails this test against the CURRENT parser, the same way
this round's Step 2/Step 8 gap would have been caught automatically had
this test existed beforehand.

### Verification

`npm run typecheck`, `npm run lint`,
`npx vitest run scripts/lib scripts/ops scripts/backfill-memberships.orchestration.test.ts`,
`npm run test:migration` (twice consecutively), `npm run test:unit`,
`npm run test:staging-preflight`, `npm run test:rules`, `npm run build`,
plus `functions/`'s full lint/typecheck/build/unit/emulator suite — see
`docs/remediation/reports/SEC-005.md`, "production execution gate
audit-fix round", for the exact commands and results.
