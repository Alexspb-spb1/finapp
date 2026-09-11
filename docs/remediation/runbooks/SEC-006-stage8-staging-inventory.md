# SEC-006 Stage 8 — staging inventory approval package

Status: **PREPARED — NOT EXECUTED**. This package permits read-only inventory
only after the owner approves it. The prior Stage 7 Pages approval does not
authorize Firebase inventory, deployment, Auth changes, or email.

## Artifact and targets

- Task: SEC-006 Stage 8, `scripts/invitationRehearsal/inventory.mjs` and
  `inventoryCore.mjs` at the final independently reviewed Stage 8 commit.
- The execution request must replace `REVIEWED_HEAD` below with that exact
  40-character SHA and include its independent PASS and CI reference.
  A branch name, historical SHA or uncommitted helper is not executable.
- Project: `finapp-staging` only; Firestore database `(default)`.
- Local checkout: `D:\projects\finapp\finapp-sec006-stage8`.
- New sanitized output file outside the checkout, under the existing private
  runtime directory. Never overwrite a previous inventory.
- No production project, financial documents, Auth user listing, mailbox,
  invitation token or credential content is requested in this package.

## Local preparation already available

Run from the Stage 8 checkout, using root Node 24.16.0 and installed locked
`firebase-tools` 15.24.0 dependencies:

```powershell
node scripts/invitationRehearsal/inventory.mjs --self-test
node scripts/invitationRehearsal/inventory.mjs --help
```

These paths never load Firebase auth/config modules and perform no cloud
requests. Eleven tests exercise project/SHA/dirty/environment guards before
auth, the GET path allowlist, active simulated requests and output filtering,
pagination, partial/unreachable inventory failures, Auth failure, changed
HEAD, cross-project API responses, canonical Rules hashing and redirect
rejection at the transport boundary. `npm run test:invitation-inventory`
runs this same required CI check. The native self-test file is named
`inventorySelfTest.mjs` so Vitest's migration suite does not collect it. The Node
test runner uses `--test-isolation=none` to avoid the extra child process
blocked by the Windows sandbox; test assertions remain enabled.

Existence-only inspection found `.env.staging.local` in the original
`D:\projects\finapp\finapp` worktree, absent in Stage 8. Values were not read.
This helper does not require/read/copy that file or any SDK config. Validation
and staging build belong to the later separately prepared release package.

## Commands for owner approval

The approval message must substitute a reviewed SHA and a unique new filename
before asking permission; the following is the command template, not a
permission to execute a placeholder:

```powershell
git status --short
git rev-parse HEAD
node scripts/invitationRehearsal/inventory.mjs --project finapp-staging --expected-head REVIEWED_HEAD --out D:\projects\finapp\.runtime\sec006-stage8-inventory-UNIQUE.json
```

The helper requires a clean checkout, exact HEAD before and after inventory,
an existing output parent outside the checkout, and an absent output file.
It obtains only the existing default `firebase login` account via the
installed CLI library. It calls `requireAuth` with that account and
`skipAutoAuth=true`; it requires the standard CLI login refresh token and
rejects access-token-only sessions before any request, so mid-run expiry
cannot enter the library's ADC fallback. It neither opens login nor falls back to ADC, credentials
files, environment tokens or a different account. Missing/expired unusable
access stops the run. Standard OAuth token refresh may contact Google's
token endpoint and refresh the CLI session cache; this is the sole
authentication operation beyond the resource GETs below. It does not grant
new permissions or enable APIs.

## Exact resource request allowlist

All resource requests use HTTPS **GET**, hardcoded origins and staging paths.
No generic URL, project selector, HTTP verb or arbitrary path is accepted.

| Origin | Path | Metadata used |
|---|---|---|
| `firebase.googleapis.com` | `/v1beta1/projects/finapp-staging` | Project ID and project number |
| `cloudfunctions.googleapis.com` | `/v1/projects/finapp-staging/locations/-/functions` | Gen 1 function identity, status, runtime, version and source-reference hash |
| `cloudfunctions.googleapis.com` | `/v2/projects/finapp-staging/locations/-/functions` | Gen 2 identity, state, runtime, revision and source-reference hash; filter `environment="GEN_2"` |
| `firestore.googleapis.com` | `/v1/projects/finapp-staging/databases/(default)` | Database identity, location and type |
| `firestore.googleapis.com` | `/v1/projects/finapp-staging/databases/(default)/collectionGroups/-/indexes` | Index definitions and state |
| `firestore.googleapis.com` | `/v1/projects/finapp-staging/databases/(default)/collectionGroups/-/fields` | Field-override count/hash; filter `indexConfig.usesAncestorConfig=false OR ttlConfig:*` |
| `firebaserules.googleapis.com` | `/v1/projects/finapp-staging/releases/cloud.firestore` | Exact active default-database release |
| `firebaserules.googleapis.com` | `/v1/projects/finapp-staging/rulesets/{validated-id}` | Source hash of the release's ruleset |
| `identitytoolkit.googleapis.com` | `/admin/v2/projects/finapp-staging/config` | Email/password flags and authorized domains |

Auth and Functions requests use response-field projections; runtime/build
environment values, secret references, SMTP settings and email template
bodies are not requested. The output uses an additional allowlist, hashing
source references instead of printing archive locations. API response/error
bodies are never logged. The CLI logger is silenced before auth; no CLI entry
point/update notifier, debug transport or debug file is enabled. The bounded
fetch wrapper rejects every URL/method outside the resource GET allowlist
and the sole standard OAuth refresh POST to
`https://www.googleapis.com/oauth2/v3/token`. Both resource requests and
token refresh force `redirect: error`, preventing credential forwarding to
a redirect target; endpoint/client overrides and disabled TLS are blocked.

Pagination is bounded to 100 pages per list, with repeated page tokens and
unreachable regions treated as failure. A resource request times out at 30
seconds. No permission/404/API-disabled error is converted into an empty
successful inventory. Rules paths and returned project/database/function
identities are checked. Malformed or unknown required structure blocks.

## Data, costs, outputs and safe-stop

This reads administrative metadata and Rules source, not stored financial
documents or Auth users. It creates one local sanitized JSON file. It creates
no cloud resource, triggers no builds, sends no email and enables no API.
Normal provider quota accounting may apply; no paid plan is activated.

Successful execution returns exit `0` and
`INVENTORY_COMPLETE_RELEASE_BLOCKED`, with `writesReady=false`. This is
intentionally not a successful rehearsal or deployment readiness claim.
Unknown Auth flags remain `null`; Rules mismatch is recorded explicitly;
every Function source archive's availability remains `NOT_VERIFIED`.

Exit `2` is a safe stop: no success report is written or overwritten. It
prints a fixed error without raw provider details. Inspect arguments, clean
HEAD, environment and access through approved safe means; do not retry with
alternative credentials or print raw API errors. If HEAD changes during
inventory, the report is rejected. Unrelated ignored local config changes
are outside Git's clean check; this helper never reads them.

Do not run `firebase deploy --dry-run` as local/read-only preparation:
installed CLI help explicitly states it **may enable APIs**. Do not run
`scripts/stagingVerify/run.mjs` without `--self-test`: its normal mode creates
and automatically deletes live synthetic Auth/Firestore fixtures.

## Backup and subsequent deployment decision

This package performs no cloud mutation requiring restoration, but its
metadata alone is **not a backup**. It never closes a rollback window or
deletes prior evidence. Before a later modifying package is approved:

1. Preserve and verify the active Rules source/release privately. A hash
   proves identity, not possession of a restorable copy.
2. For every existing Function that would be replaced, obtain a verified
   source/build artifact and needed deployment configuration through an
   explicitly approved protected procedure. A revision/source-reference
   hash or local Git commit does not prove the old archive still exists.
   Stop if an exact rollback cannot be established. No source archive or
   secret configuration is downloaded by this inventory helper.
3. Retain the full current index/field configuration privately for comparison;
   preserve unrelated indexes/overrides. The invitation listing index must
   become `READY`: `companyId ASC`, `createdAt DESC`, `__name__ DESC`.
4. Determine current billing/API availability, required resource limits and
   expected Cloud Build/Run/Artifact Registry costs in a separately reviewed
   read-only extension if needed. Unknown values do not authorize enabling
   services or accepting artifact-cleanup policies.
5. Verify the private staging Web SDK fingerprint and build, authorize an
   actual mailbox, review the verification action domain/template, and
   prepare named synthetic fixtures, retained ID manifest, smoke and rollback.
   Real passwords/tokens/mailbox values stay outside public Git and reports.

There is no Hosting configuration in `firebase.json`; a local staging build
can serve the owner rehearsal once ready. Creating Hosting/domain resources
requires explicit inclusion in a later package. Functions have no predeploy
build hook, so that package must build the locked Node 22 Functions artifact
explicitly and scope deployments by the exact approved export names.

No SEC-005 export/create/import/apply/backfill or maintenance action is part
of Stage 8 inventory. No deletion, cleanup or rollback action is implicitly
authorized by this document. Stage 8/SEC-006 stay open until the required
real verification email and complete external rehearsal are verified.
