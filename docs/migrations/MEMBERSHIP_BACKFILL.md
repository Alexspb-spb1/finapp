# Membership backfill — SEC-005

Migrates legacy `users/{uid}.role` / `users/{uid}.companyId` /
`users/{uid}.companies[]` / `companies/{companyId}.ownerId` into the
canonical `companies/{companyId}/members/{uid}` documents defined by
[ADR-001](../adr/001-company-membership-and-roles.md).

Tool: `scripts/backfill-memberships.ts` (root devDependency `firebase-admin`,
run directly via Node's native TypeScript support — no build step, no
`ts-node`, no `functions/node_modules`).

**Status of this document**: describes the tool as implemented and verified
against the **Firestore Emulator only** (SEC-005 Phase A). Staging rehearsal
and production execution are **not authorized and have not been run** — see
"Future staging rehearsal and production execution" at the end.

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
- **Orphan** — a relation that references something that doesn't exist:
  - `missing_company` — a legacy field names a `companyId` with no
    `companies/{companyId}` document.
  - `missing_user` — `companies/{companyId}.ownerId` names a uid with no
    `users/{uid}` document.
  Orphans are **never** turned into a membership — "excluded without a
  record" per the task's rule 8 means no membership document is ever
  created for them, but the orphan itself IS recorded in the report and
  still requires an `exclude` decision before `apply` will proceed (a
  deliberate extra safety gate: every orphan must be human-reviewed once,
  even though the outcome — no membership — never changes).
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
    "resolution": "confirm_role",
    "role": "admin",
    "reason": "Confirmed with company owner via support ticket #1234 on 2026-01-15.",
    "reviewedBy": "alice@example.test",
    "reviewedAt": "2026-01-15T10:00:00.000Z"
  },
  {
    "uid": "REDACTED_UID_2",
    "companyId": "REDACTED_COMPANY_ID_2",
    "resolution": "exclude",
    "reason": "Former contractor, access intentionally not migrated.",
    "reviewedBy": "alice@example.test",
    "reviewedAt": "2026-01-15T10:05:00.000Z"
  },
  {
    "uid": "REDACTED_UID_3",
    "resolution": "exclude",
    "reason": "Confirmed dead account with support — has no companyId/companies[] claim at all, safe to leave unmigrated.",
    "reviewedBy": "alice@example.test",
    "reviewedAt": "2026-01-15T10:10:00.000Z"
  }
]
```

The third entry above has **no `companyId` at all** — a "user-level"
decision (2nd round fix #3). This is the ONLY way to acknowledge an
`unknownUsers` or `malformedClaims` entry, both of which are keyed by `uid`
alone (there is no `companyId` to target — the whole point of those two
lists is that no usable relation claim could even be extracted). A
companyId-less decision MUST have `resolution: "exclude"` — `confirm_role`
and `accept_existing` always require a specific `(companyId, uid)` relation
and are rejected by `scripts/lib/decisions.ts` if `companyId` is omitted.

Resolutions:
- `confirm_role` — requires `role` (`viewer`|`accountant`|`admin`) AND a
  `companyId`. Resolves a conflict or owner anomaly by creating that
  membership — but ONLY after re-verifying, at the moment the decision is
  applied, that BOTH the target company and the target user still exist
  (`scripts/lib/planner.ts`, `confirmRoleTargetExists()`, 2nd round fix #4).
  **Cannot** target an orphan (a decision can never create a missing
  company or user) — this is enforced structurally: a claim referencing a
  nonexistent company is never even classified as a resolvable conflict in
  the first place, it is a `missing_company` orphan.
- `accept_existing` — only meaningful for an `existing_membership_conflict`
  that is `differs_but_valid` (a strictly-schema-valid, active document with
  merely a different role): treats the existing document as canonical;
  nothing is written. **Never** resolves an `invalid` existing document
  (unknown role, disabled/non-active status, uid mismatch, missing
  timestamps, or extra fields) — that stays a blocking conflict no matter
  what the decision says.
- `exclude` — acknowledges a conflict/orphan/owner-anomaly (with a
  `companyId`); no membership is ever created for that pair. WITHOUT a
  `companyId`, acknowledges a user-level `unknownUsers`/`malformedClaims`
  entry instead (2nd round fix #3) — the only resolution valid in that form.

Validation (`scripts/lib/decisions.ts`) rejects, with no permissive
fallback: non-array input, unknown fields, unknown `resolution`/`role`
values, missing required fields, an unparseable `reviewedAt`, a
companyId-less decision whose resolution is not `exclude`, and
duplicate/contradicting decisions for the same `(companyId, uid)` pair (or
the same `uid` for two user-level decisions — a separate namespace from
relation-level pairs, so a user-level and a relation-level decision for the
SAME uid never collide).
`--decisions-file`'s SHA-256 (over the canonicalized, order-independent
decision list — see "Checksums" below) is recorded in every report as
`decisionsChecksum`, so a report can always be tied back to exactly which
decisions produced it without the decisions file itself ever being
committed.

## CLI reference

```text
node scripts/backfill-memberships.ts \
  --mode dry-run|apply|verify|rollback-from-report   (default: dry-run)
  --environment emulator|staging|production           (REQUIRED, no default)
  --project <project-id>                               (REQUIRED, no default)
  --confirm-project <project-id>                        (staging/production only, exact match required)
  --decisions-file /absolute/path/outside/repo.json     (optional)
  --report-path /absolute/path/outside/repo/report.json (REQUIRED)
  --from-report /absolute/path/to/an/apply-report.json  (rollback-from-report only)
  --backup-reference <id>                               (production only)
  --rollback-reference <id>                              (production only)
  --ack-maintenance-readonly                             (production only)
```

`--apply` is a convenience alias for `--mode apply`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (dry-run always; apply with 0 write failures; verify matching target) |
| 1 | Apply refused (unresolved items, including unknown users/malformed claims) or had write failures; verify found drift OR the plan was not fully resolved (2nd round fix #1 — `matchesTarget` requires `plan.applyAllowed` too, not just checksum equality); rollback had refused deletions |
| 2 | CLI argument or decisions-file error |
| 3 | Environment/project guard failure (wrong project, missing confirmation, etc.) |
| 4 | Refused: this cycle does not authorize staging/production execution (Phase A only) |

### Environment/project guards (enforced BEFORE any credential acquisition or Firestore read)

| Environment | Required `--project` | Extra requirement |
|---|---|---|
| `emulator` | `demo-finapp` | `FIRESTORE_EMULATOR_HOST` must be set |
| `staging` | `finapp-staging` | `--confirm-project finapp-staging` (exact match) |
| `production` | `finapp-prod-10a83` | `--confirm-project finapp-prod-10a83`, `--backup-reference`, `--rollback-reference`, `--ack-maintenance-readonly` |

A mismatch between `--project` and `GCLOUD_PROJECT`/`GOOGLE_CLOUD_PROJECT`
is refused immediately, before any credential is acquired. Production is
never a default — `--environment` and `--project` have no defaults at all.
The Admin SDK resolves credentials itself (Application Default
Credentials); this tool never reads or logs a service-account file.

**In this cycle (SEC-005 Phase A), the CLI refuses to run against anything
other than `--environment emulator`, regardless of flags** — see `main()`'s
explicit guard in `scripts/backfill-memberships.ts`. This is deliberate:
the guards above are implemented and unit-tested, but staging/production
execution requires separate, explicit authorization not granted in this
task cycle.

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

# Verify:
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/backfill-memberships.ts \
  --environment emulator --project demo-finapp --mode verify \
  --report-path /tmp/sec005-verify.json

# Rollback (emulator only, in this cycle):
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/backfill-memberships.ts \
  --environment emulator --project demo-finapp --mode rollback-from-report \
  --from-report /tmp/sec005-apply.json --report-path /tmp/sec005-rollback.json
```

`npm run test:migration` runs the full automated proof of this flow
(`firebase emulators:exec --project demo-finapp --only firestore "vitest run scripts"`).

## Future staging rehearsal (template — NOT run in this cycle)

Requires `EXTERNAL_ACTION_APPROVED: SEC-005` / `ENVIRONMENT: staging` from
the repository owner first.

```bash
node scripts/backfill-memberships.ts \
  --environment staging --project finapp-staging --confirm-project finapp-staging \
  --mode dry-run --report-path /absolute/path/outside/repo/sec005-staging-dry-run.json
```

Then, after manual review of the dry-run report and a decisions file for
every conflict/orphan/owner-anomaly:

```bash
node scripts/backfill-memberships.ts \
  --environment staging --project finapp-staging --confirm-project finapp-staging \
  --apply --decisions-file /absolute/path/outside/repo/sec005-staging-decisions.json \
  --report-path /absolute/path/outside/repo/sec005-staging-apply.json
```

## Future production execution (template — NOT run in this cycle)

Requires `PRODUCTION_ACTION_APPROVED: SEC-005`, a verified `BACKUP_REFERENCE`,
and a verified `ROLLBACK_REFERENCE` from the repository owner, PLUS a
successful, reviewed staging rehearsal first. The app should be placed in
maintenance/read-only mode for the duration of the apply.

```bash
node scripts/backfill-memberships.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --mode dry-run --report-path /absolute/path/outside/repo/sec005-prod-dry-run.json

# After manual review + decisions file + maintenance mode enabled:
node scripts/backfill-memberships.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --apply --decisions-file /absolute/path/outside/repo/sec005-prod-decisions.json \
  --report-path /absolute/path/outside/repo/sec005-prod-apply.json \
  --backup-reference <verified-backup-id> --rollback-reference <verified-rollback-doc> \
  --ack-maintenance-readonly

# Immediately after:
node scripts/backfill-memberships.ts \
  --environment production --project finapp-prod-10a83 --confirm-project finapp-prod-10a83 \
  --mode verify --report-path /absolute/path/outside/repo/sec005-prod-verify.json
```

## Counts and checksum contract

Every report (`scripts/lib/report.ts`, `schemaVersion: 1`) includes:
`mode`, `environment`, `projectId`, `sourceGitSha`, `runId` (a `crypto.randomUUID()`
— **never** `Date.now()` for identity/ordering), `startedAt`/`finishedAt`,
the full `counts` object (`usersRead` … `unresolved`), and four checksums:

- **`sourceChecksum`** — SHA-256 over the canonicalized, `companyId`-then-`uid`-sorted
  set of *confirmed* candidate relations (`companyId`, `uid`, `role`).
- **`decisionsChecksum`** — SHA-256 over the canonicalized decisions array,
  where each decision is normalized to ALL 7 of its meaningful fields —
  `uid`, `companyId` (`null` for a user-level decision), `resolution`,
  `role` (`null` unless `confirm_role`), `reason`, `reviewedBy`,
  `reviewedAt` — before hashing (2nd round fix #5:
  `scripts/lib/checksum.ts`'s `computeDecisionsChecksum()` takes the full
  typed `Decision[]`, not a partial shape). Changing ANY one of those 7
  fields changes the checksum; sorting is by the canonical JSON of each
  normalized decision itself, so it stays fully deterministic and
  order-independent (empty-array checksum when no `--decisions-file` is
  given).
- **`targetChecksum`** — SHA-256 over the canonicalized, sorted set of
  relations the run INTENDS to exist afterward (planned creates + already-matching
  skips), role+status only (`schemaValid` always implicitly `true` for a target
  relation, see `observedChecksum` below).
- **`observedChecksum`** — same shape, computed from an ACTUAL read-back
  after `apply`/`verify`; `null` for `dry-run` (nothing was applied yet).
  Each observed relation also carries an explicit `schemaValid` flag (2nd
  round fix #7: `isStrictlyValidActiveMembership()` run against the
  read-back document) — a document with the "right" role/status but a wrong
  uid, forged/missing timestamps, or extra fields produces `schemaValid:
  false`, which changes `observedChecksum` even though role/status alone
  would have matched.

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

## Partial-write-failure handling

Each planned create is attempted independently and its outcome (success or
failure) is recorded individually in `createdPaths`/`writeFailures` — the
report **never claims** the whole migration was atomic. If N of M planned
creates succeed, the report shows exactly which N paths were created and
which failed with what error, and the exit code is non-zero.

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
every `rollbackManifest` entry using the exact canonical path
`companies/{companyId}/members/{uid}` with no duplicate pairs, and every
entry cross-referenced against both `createdPaths` (must have matching
`createTimeIso`/`updateTimeIso`) and `plannedCreates` (must have a known
`role` and `status === 'active'`). **Any single structural problem — a
tampered report, wrong-project report, or a non-apply report — rejects the
entire rollback with zero deletions attempted.**

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
