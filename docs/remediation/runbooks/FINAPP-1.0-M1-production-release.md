# FINAPP-1.0-M1 — production release package for PR #28

**Status: PREPARED, NOT AUTHORIZED.** This document is a release envelope, not
evidence that production was inspected or changed. The only change in this
branch is this document. Do not run the external commands below until their
gates are filled with fresh private evidence, independently checked, and the
owner approves the exact target and rollback. The earlier permission for one
SEC-006 staging invitation is not production permission.

## Immutable inputs and scope

| Item | Pinned value |
|---|---|
| PR | [#28](https://github.com/Alexspb-spb1/finapp/pull/28), SEC-007 + SEC-011 + SEC-010 |
| Reviewed implementation HEAD | `8526a791ce3f62dee5a64aa239b795c609a39226` |
| Independent implementation PASS | `8f7d495f03b70a6f279f3622d61d5380db611a92`; later `8526a79` changes the report/plan only |
| Base `main` | `6d713fe77164b5d7f096a85509d73b43bd9dad13` |
| Firebase target | `finapp-prod-10a83` (`production` alias in `.firebaserc`) |
| Firestore | `(default)` database; live location and type must be rechecked |
| Rules source | PR HEAD `firestore.rules`, raw SHA-256 `f117e489f9549da9083c19bdf4104b3651aa500061aa52426f09cb6fe492adda` |
| Frontend | `https://alexspb-spb1.github.io/finapp/`, automatically published by successful `main` push CI |

At preparation time PR #28 is OPEN, not Draft, mergeable/clean. Both GitHub
checks (`ci`, `functions`) succeeded on the exact PR HEAD. Check those facts
again immediately before release; a changed HEAD or base invalidates this
package. The independent review did not inspect this operational envelope.

The intended production order is **Functions → Firestore Rules → merge PR
#28 / Pages**. Merge first is unsafe: `.github/workflows/deploy.yml` publishes
the new frontend automatically after `main` CI succeeds, while the old Rules
deny its canonical member reads. Deploy only `firestore:rules`, never the
`firestore` umbrella target: checked-in `firestore.indexes.json` contains an
empty `fieldOverrides` array and is not an inventory of live overrides.

## Gate 0 — local source and CI (no cloud access)

Work from a fresh, clean checkout of the reviewed **PR HEAD**, with Git
automatic CRLF conversion disabled before checkout. Do not build from this
documentation branch; its HEAD differs from the implementation HEAD. Pin
Node 24.16.0/npm 11.13.0 for the root and a compatible Node 22 for Functions.

```powershell
$ExpectedHead = '8526a791ce3f62dee5a64aa239b795c609a39226'
$Project = 'finapp-prod-10a83'
if ((git rev-parse HEAD).Trim() -cne $ExpectedHead) { throw 'PR HEAD changed' }
if (git status --porcelain --untracked-files=all) { throw 'Dirty checkout' }
if ((Get-Content .firebaserc -Raw | ConvertFrom-Json).projects.production -cne $Project) { throw 'Wrong Firebase project' }
if ((Get-FileHash .\firestore.rules -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'f117e489f9549da9083c19bdf4104b3651aa500061aa52426f09cb6fe492adda') { throw 'Rules bytes changed' }
node --version
npm --version
```

Require fresh GitHub `ci` and `functions` SUCCESS on `$ExpectedHead`, the same
base `main`, independent PASS still applicable, successful clean root and
Functions builds, Rules emulator tests and Functions emulator tests. The
existing exact-HEAD CI satisfies the automated tests if still current; do
not substitute the SEC-006 Windows run for PR #28's own CI. The Firebase
CLI is pinned by root `package-lock.json` to 15.24.0. Its local help confirms
both the named Functions filter and `firestore:rules`. Do not use
`firebase deploy --dry-run` as a read-only preflight: this CLI explicitly
warns that dry-run can still enable APIs.

## Gate 1 — private, read-only production preflight and backups

This gate has **not** run in this preparation environment: there is no
authenticated Firebase account here. It requires separate authorization to
read production metadata. Store receipts and full backup sources outside
Git, under a private directory; do not print tokens or raw account data.

1. Confirm the authenticated operator, exact project ID and `(default)`
   Firestore database. Capture fresh billing/API state, the active Rules
   release name and ruleset name, the full Rules source, indexes/field
   overrides, and all currently deployed Functions with generation, region,
   runtime, revision, build/source provenance and resource limits. Save
   time, byte count, SHA-256 and a read-back of each private receipt. The
   source **must be fetched from the active production Rules release**;
   neither `main:firestore.rules` nor a historic report is a live backup.
2. Compare the production Rules and Functions against a reviewed baseline.
   Stop on unknown changes, missing source provenance, extra unexpected
   Functions, disabled billing, mismatched location, or a resource setting
   that would be overwritten without review. Preserve a deployable copy of
   each existing Function version that this release would update, including
   dependencies/config, and prove that its rollback can be built. A
   metadata-only list of revision names is not a code backup.
3. Reconcile the SEC-005 production backfill and current canonical
   `companies/{companyId}/members/{uid}` coverage before switching Rules.
   The 2026-08-31 backup/verification establishes history, not current
   coverage. Use aggregate/private evidence; do not rerun the backfill or
   copy individual membership records into this report. Stop on missing or
   malformed active memberships, or an unknown maintenance-mode state.
4. Record immutable `BACKUP_REFERENCE` for the current Rules source/release,
   existing Function rollback artifacts, and a current protected data
   recovery point suitable for this production change. Record
   `ROLLBACK_REFERENCE` with the actual previous ruleset identifier,
   deployable old Functions and previous Pages commit/artifact. Test that
   all references can be read. Do not infer them from old documents.
5. Immediately before **each** write, re-read the applicable live
   fingerprint and stop on drift. A timeout or nonzero result requires
   read-only reconciliation; never blindly repeat a deploy or force it.

This inventory/backup step is deliberately a separate gate. Until its real
receipts and identifiers are available, no production approval document can
honestly name the backup/rollback references. Do not replace them with
placeholder strings.

## Gate 2 — scoped Functions deployment (only after approval)

From the clean pinned PR checkout, install and build Functions on Node 22.
Check the built `functions/lib/index.js` exports the thirteen named callables
and that the deployment archive excludes local secrets/logs. Do not deploy
`authzProbe`, indexes, Hosting, or every function by an umbrella selector.
The reviewed report calls for all thirteen named Functions; compare every
pre-existing production version and its rollback artifact in Gate 1 first.

```powershell
node node_modules/firebase-tools/lib/bin/firebase.js deploy --project finapp-prod-10a83 --only 'functions:acceptInvite,functions:cancelInvite,functions:createCompany,functions:getCompanyAccess,functions:inviteMember,functions:listInvitations,functions:previewInvite,functions:resendInvite,functions:changeMemberRole,functions:disableMember,functions:restoreMember,functions:removeMember,functions:listCompanyMembers' --non-interactive
```

Firebase may enable required APIs and create provider-managed build/image,
service-agent and Cloud Run resources; the thirteen HTTPS endpoints need
invocation access for the handlers to validate Firebase credentials. Review
those ordinary effects and possible billing before approval. Stop on an
unexpected IAM grant, API/terms request, deletion prompt, additional target,
or partial/uncertain deployment. Re-inventory the exact thirteen names and
revisions, requiring GEN_2, ACTIVE, `nodejs22`, `us-central1`, 256 MiB,
CPU 1, concurrency 1, min instances 0, max instances 1, timeout 60 s.
Verify existing callables still respond to a bounded, non-mutating check;
do not create a company or invite as an implicit smoke test.

## Gate 3 — Rules release (only after Gate 2 PASS)

Re-read and compare the active production release/ruleset to the private
Gate 1 backup immediately before this command. Confirm canonical coverage
and maintenance state again. `firestore:rules` writes the Rules referenced
in `firebase.json` and overwrites the live Rules; no indexes are included.

```powershell
node node_modules/firebase-tools/lib/bin/firebase.js deploy --project finapp-prod-10a83 --only firestore:rules --non-interactive
```

Fetch the new active release and full source. Require its canonical content
to match the reviewed PR Rules (normalizing line endings only if the Rules
API has transformed them, while keeping raw hashes separately). Check
anonymous/foreign/disabled membership denial and read-only active member
access with explicitly approved canary identities; never use a real
colleague as a mutation fixture. If denial, rollback evidence or access
cannot be verified, stop **before merge**.

## Gate 4 — PR merge and Pages (only after Gates 2–3 PASS)

Refresh PR #28 head/base/CI/review and verify no intervening merge to main.
Merge that exact HEAD with GitHub's protected normal merge mechanism; no
force-push or bypass. This is a separately authorized external publication:
the successful `main` push CI triggers `.github/workflows/deploy.yml`, which
builds with GitHub Secrets and publishes Pages. Capture the actual merged
commit, `main` CI run, Pages deployment run and artifact hash. Stop on a
different source SHA, failed build, missing secret or changed target.

Visit `https://alexspb-spb1.github.io/finapp/` and verify the deployed
asset corresponds to the new `main` build. Perform bounded role-based
smoke with owner-approved canary identities: admin roster and management,
viewer denied write controls, last-admin denial, secondary-company isolation,
logout/session switch. Any role-changing smoke must use named synthetic
memberships with an explicit cleanup/retention decision; it is **not**
implicitly authorized by a deploy approval. No production email is part of
this M1 release package.

## Safe stop and rollback

- Failure before Gate 2: no release write; preserve receipts and stop.
- Partial Functions result: inventory the real state; keep old Rules and
  frontend. Restore only affected Functions from verified prior artifacts
  under the separately approved rollback, after checking no intervening
  revision. Never delete an unknown function or use `--force`.
- Rules failure before merge: keep the old frontend. If the new release is
  active and the exact expected new ruleset still owns `cloud.firestore`,
  restore the captured prior ruleset/release using a reviewed targeted
  rollback command, then verify its source hash. No restore across drift.
- Pages failure after merge: retain the Functions/Rules state while
  diagnosing, or use an approved revert of the exact merge commit to
  republish the previous client. An old Git checkout alone does not roll
  back the live Pages site.
- Production data are not deleted or migrated by these deploy commands.
  Later member changes are real business writes and are not reversed by
  code/Rules rollback. Preserve backup and evidence until explicitly closed.

## Decision still required

The next **authorized** action is a bounded, read-only production metadata
and backup preflight, not deployment. It will fill the actual
`BACKUP_REFERENCE`, `ROLLBACK_REFERENCE`, drift checks and canary scope.
After those results are reviewed, a separate explicit approval must name
`FINAPP-1.0-M1`, project `finapp-prod-10a83`, the exact commands above,
the verified backup/rollback references and the Pages merge effect. Nothing
in this document authorizes a production call, merge, email or cleanup.
