# SEC-006 Stage 8 — staging backend deployment and passive smoke

Status: **REVIEWABLE DEPLOYMENT CANDIDATE — NOT APPROVED OR EXECUTED**.
This is the next §8 package, not an extension of API-activation permission.
The final approval envelope must attach the reviewed HEAD, independent PASS,
exact-head CI and passive-smoke evidence. Its SHA is supplied outside this
file to avoid a self-referencing commit. The task PR may remain Draft; no
Pages merge is needed for the local staging frontend.

## Verified baseline and target

The owner-approved `dd8f049753d21161278efe76e3aefc340a4d9922` inventory at
2026-09-06 12:20:58 UTC established:

| Item | Observed value |
|---|---|
| Project/database | `finapp-staging` / `(default)`, location `eur3` |
| Functions API | Activation completed; fresh service state `ENABLED` |
| Existing Functions | None in both generation inventories |
| Composite indexes | None |
| Field overrides | One; metadata hash `af2e9e80c150cc9a6b2f4c5f5bae330dacb214d7a104188fa5ef4fcfad3c6aee` |
| Active Rules release | `projects/finapp-staging/releases/cloud.firestore` |
| Active Rules ruleset | `projects/finapp-staging/rulesets/01da0ec2-a6b0-4b17-b533-81195a573359` |
| Active canonical Rules SHA-256 | `b0f6c045e908bc632a4b24381c3c1164ccca95834761b2dc68d460bce6524c8f` |
| Local canonical Rules SHA-256 | `15bbc0050dd1ed2259c921818794b4f234c4457ad3e66ee2d0fa1da6d148f89d` |
| Auth | Email/password enabled; authorized domains include `localhost`, `finapp-staging.firebaseapp.com`, `finapp-staging.web.app` |

Private evidence:
`D:\projects\finapp\.runtime\sec006-functions-api-dd8f049.jsonl` and
`D:\projects\finapp\.runtime\sec006-stage8-inventory-dd8f049.json`.
These are a baseline, not fresh preflight or a Rules backup. Any drift must
be inspected before writes. An unexpected existing Function changes the
rollback problem and stops this initial-deployment package.

Targets are staging only: eight Functions in `us-central1`, Firestore
`(default)`, and a local static server at `http://localhost:5176/finapp/`.
This package creates no Auth users or Firestore fixtures and sends no email.
Real-email rehearsal is deferred to its subsequent prepared approval
package. No production project/domain, GitHub Secrets, production backfill
or maintenance action.

## Prepared implementation and final approval envelope

1. Final reviewed source SHA, independent PASS and exact-head CI belong in
   the concrete approval envelope. Runtime
   caps are now explicit and locally checked: Node 22, `us-central1`,
   `256MiB`, CPU `1`, concurrency `1`, min instances `0`, max instances `1`,
   timeout `60s`. All nine local exports carry the settings; deploy only
   the eight approved exports below. Recheck the actual compiled manifest.
2. Proposed budget envelope for owner approval: **up to USD 5 as a planning
   estimate for this initial bounded deployment and passive verification**.
   This is not an enforced spending cap or a claim that the owner has already
   accepted it. Plan for eight initial Functions build jobs (normally one per
   callable), one scoped CLI deployment invocation for eight Functions, one
   additive index create if absent, one Rules publication and the read-only/
   static checks; zero fixture, email or callable invocations. Provider/CLI
   internal requests and retries are native deployment behavior; this is not
   a claim of one HTTP deployment request or a fixed internal retry count.
   No billing upgrade, unrelated work or blind redeploy is included. Provider
   billing can differ from the estimate; retained images/logs/storage can
   continue accruing cost. `minInstances=0` and maxInstances are not a hard
   monetary limit, and no automatic artifact deletion is authorized.
3. The implemented local artifact verifier checks all file hashes, Firebase
   config hash and fresh SDK sourceHash over the actual upload file set,
   detecting unexpected additions. The verifier also refuses local Functions
   .env*, .secret* and runtimeconfig entries: Firebase can read configuration
   before archive exclusions apply. The prepared v2 bundle below passed local
   staging fingerprint/build and source packaging checks; preserve
   it unchanged after approval.
4. Implemented `stagingResources.mjs` and deployment metadata checks are
   part of independent review. Resources self-tests cover backup corruption, field
   preservation, pagination, durable journaling and single native create.
   A GET-only preflight must confirm existing billing and no Functions;
   postflight checks exactly eight Functions, caps, revisions and build/source
   reference fingerprints. Those fingerprints do not attest that deployed
   bytes equal the local SDK sourceHash; artifact recoverability remains
   `NOT_VERIFIED`. The local artifact guard and recorded CLI deployment
   sequence provide separate source evidence.
5. Attach the completed local static smoke results to the approval envelope:
   serve the staging artifact with a fresh browser
   and all non-loopback browser requests blocked. No login, callable POST,
   Auth lookup, fixture or real-email action belongs to this package.

The implementation, command contracts and artifacts are concrete. Execution
remains subject to the final evidence envelope and explicit owner approval
of this scope and proposed cost allowance.

## Prepared artifact identity

Directory: `D:\projects\finapp\.runtime\sec006-stage8-release-prepared-v2`.

| Artifact | Expected identity |
|---|---|
| `functions-source.zip` SHA-256 | `9b7150dfd3868cb8c975f737c57da2192c02dfd676321e6fb63757d60eff97a9` |
| Firebase SDK sourceHash (SHA-1) | `197c9987d160b0e99e9ee7fb3f45ad653eebd9be` |
| `artifact-manifest.json` SHA-256 | `d640980257cdefec7c4424b9629b601a9fb24a98f47e64b4ec1d4b38ccd9ce6d` |
| Contents | 94 Functions source/compiled files, 16 staging static files; config hash in manifest |

The earlier non-v2 bundle is retained rejected evidence, not deployable: the
default package unexpectedly included an emulator log. The actual reviewed
`firebase.json.functions.ignore` now excludes logs, env/secret files,
node_modules and `.git`. The SDK packaging check must use these real ignore
settings; comparing only a manually selected file list is insufficient.

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\projects\finapp\.runtime\sec006-stage8-release-prepared-v2\functions-source.zip'
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\projects\finapp\.runtime\sec006-stage8-release-prepared-v2\artifact-manifest.json'
node scripts/invitationRehearsal/verifyReleaseArtifact.mjs --manifest D:\projects\finapp\.runtime\sec006-stage8-release-prepared-v2\artifact-manifest.json --expected-manifest-sha d640980257cdefec7c4424b9629b601a9fb24a98f47e64b4ec1d4b38ccd9ce6d --expected-head REVIEWED_HEAD
```

The artifact verifier is local-only, requires clean reviewed HEAD and checks
the complete manifest file set, file hashes, config hash and freshly
computed SDK sourceHash. It detects unexpected additional upload files and
verifies the retained ZIP hash; it does not regenerate the ZIP;
no credentials or network are used. Use Node 24 for these helper checks;
Functions build/emulator runtime remains explicitly Node 22.

## Exact build and deploy command contracts

Run from `D:\projects\finapp\finapp-sec006-stage8`. Do not run installs
concurrently with builds/tests on Windows. The Functions package has no
predeploy build hook; `firebase deploy` alone does not establish the right
compiled artifact.

The following are **preparation commands already completed**, not instructions
to rebuild during the approved release. Execution consumes the verified
prepared artifact. Prepend Node 22 to PATH as well as invoking its executable,
because npm child scripts such as `tsc` otherwise may resolve host Node 24.
Restore the original Node 24 PATH before root builds/tests/helper commands.

```powershell
$functionsBuildPath = $env:Path
try {
  $env:Path = 'D:\projects\finapp\.runtime\node_modules\node\bin;' + $functionsBuildPath
  & 'D:\projects\finapp\.runtime\node_modules\node\bin\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' --prefix functions ci
  if ($LASTEXITCODE -ne 0) { throw 'Functions install failed' }
  & 'D:\projects\finapp\.runtime\node_modules\node\bin\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' --prefix functions run build
  if ($LASTEXITCODE -ne 0) { throw 'Functions build failed' }
} finally {
  $env:Path = $functionsBuildPath
}
npm.cmd run build:staging
```

The final package must provide the concrete SHA/hash/manifest comparison
commands before these external commands:

```powershell
node node_modules/firebase-tools/lib/bin/firebase.js deploy --project finapp-staging --only 'functions:createCompany,functions:inviteMember,functions:listInvitations,functions:cancelInvite,functions:resendInvite,functions:previewInvite,functions:acceptInvite,functions:getCompanyAccess' --non-interactive
node node_modules/firebase-tools/lib/bin/firebase.js deploy --project finapp-staging --only firestore:rules --non-interactive
```

Use the reviewed artifact unchanged, exact project ID and explicit filters.
`authzProbe` is excluded: the acceptance path confirms membership through
`getCompanyAccess`; a ninth test-only public endpoint is unnecessary.
No blanket Functions deploy, `--force`, deployment retry after unknown
result, Rules/indexes combination or `firestore:indexes` deploy.

Execution order for the eventual combined approval:

1. Verify reviewed HEAD/artifacts locally; run deployment metadata preflight.
2. Capture/verify the fresh Rules backup before any remote write.
3. Ensure the one additive index and confirm `READY`, retaining all prior
   metadata and the field override.
4. Repeat deployment preflight immediately before the scoped eight-Function
   deploy, with a new output path; require no pre-existing Functions.
5. Deploy Functions, then run strict deployment postflight. If deployment is
   partial/uncertain or reports nonzero, reconcile with the ordinary inventory
   read-only before any retry; do not proceed to Rules on unresolved state.
6. Recheck the current Rules baseline immediately before deploying only
   `firestore:rules`. Then verify the new Rules hash and index `READY`.
7. Verify tokenless local static pages in a fresh browser with non-loopback
   browser traffic blocked. Retain metadata/backup/operation/smoke evidence.

```powershell
node scripts/invitationRehearsal/deploymentCheck.mjs --mode preflight --project finapp-staging --expected-head REVIEWED_HEAD --out D:\projects\finapp\.runtime\stage8-deployment-preflight-REVIEWED_HEAD.json
node scripts/invitationRehearsal/deploymentCheck.mjs --mode postflight --project finapp-staging --expected-head REVIEWED_HEAD --out D:\projects\finapp\.runtime\stage8-deployment-postflight-REVIEWED_HEAD.json
```

These checks are GET-only, require existing billing and validate the exact
deployment state. Strict postflight returns no success report for partial
Functions, resource-cap drift or disabled billing. For read-only reconciliation
after an unknown/nonzero deploy, use the broader existing inventory command
with a new private output (never a blind deploy retry):

```powershell
node scripts/invitationRehearsal/inventory.mjs --project finapp-staging --expected-head REVIEWED_HEAD --out D:\projects\finapp\.runtime\stage8-deployment-reconcile-REVIEWED_HEAD.json
```

## Permitted ordinary deployment effects to state in approval

The installed Firebase CLI `deploy/functions/prepare.js` ensures the
following prerequisite services for this v2 Node deployment:

- `cloudfunctions.googleapis.com` (already enabled, but recheck);
- `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`;
- `run.googleapis.com`, `eventarc.googleapis.com`, `pubsub.googleapis.com`,
  `storage.googleapis.com` for v2 preparation.

The CLI also checks Runtime Config availability; this package does not use
Runtime Config or application secrets. No Secret Manager activation is
needed by these exports. The CLI explicitly requests Pub/Sub and Eventarc
service identities during v2 preparation, including this HTTP-only path.
Cloud Functions/Build/Run/Artifact Registry can provision their ordinary
provider-managed service agents, source buckets, build/image artifacts and
underlying services. The final approval must describe these dependencies
and effects rather than promise that only eight Function objects appear.

The callable HTTPS endpoints require ordinary public HTTP invocation at
their eight function/service resources so Firebase Auth/token checks can
run inside the callable handler, including token-based pre-auth preview.
This endpoint invocation policy is part of deployment authorization; it
does not grant direct public Firestore access. No operator is granted new
project roles, no arbitrary service account is introduced and no manual
project-wide IAM change is authorized. If deployment needs an additional
operator grant, billing upgrade, terms acceptance or unexpected resource,
stop with the exact required change.

Provider-managed prerequisite effects and generated build/image resources
may incur cost. Bound the planned number of builds, Functions, instances,
scenario requests, fixtures and emails in the final package. Existing
billing status must permit deployment; this package never changes it.

## Fresh Rules backup before any remote write

The existing inventory saved only a hash and ruleset name. Before changing
Rules, use the existing protected CLI session to:

1. GET `https://firebaserules.googleapis.com/v1/projects/finapp-staging/releases/cloud.firestore`.
2. Require the expected active ruleset reference, even if a different release
   points at identical source. GET
   `https://firebaserules.googleapis.com/v1/projects/finapp-staging/rulesets/01da0ec2-a6b0-4b17-b533-81195a573359`.
3. Save the complete Rules source files and release metadata in a new
   private backup directory. Check complete byte writes and disk sync,
   read the saved files back, and record their raw and canonical hashes.
4. Require canonical normalization `CRLF→LF`, then remaining `CR→LF`, UTF-8
   SHA-256 to equal the recorded active hash above. Record capture time,
   project/database, exact source names, byte counts and immutable backup
   paths. No fixture or deployment starts before verified backup completion.
5. Immediately before Rules deployment, refetch the release and active hash;
   stop on drift. After deployment, refetch and require the reviewed local
   Rules hash. Keep both prior and new references and source copies.

This uses the same GET contracts as installed `lib/gcp/rules.js`. No
Firestore data export, migration or production backup command is required.
The backup must remain available throughout the rollback window.

Implemented executable commands (replace `REVIEWED_HEAD` with the approved
40-character SHA and retain the exact new private paths in that approval):

```powershell
node scripts/invitationRehearsal/stagingResources.mjs --mode backup-rules --project finapp-staging --expected-head REVIEWED_HEAD --expected-rules-hash b0f6c045e908bc632a4b24381c3c1164ccca95834761b2dc68d460bce6524c8f --backup D:\projects\finapp\.runtime\stage8-rules-before-REVIEWED_HEAD.json --out D:\projects\finapp\.runtime\stage8-rules-backup-REVIEWED_HEAD.jsonl
node scripts/invitationRehearsal/stagingResources.mjs --mode verify-rules-backup --project finapp-staging --expected-head REVIEWED_HEAD --expected-rules-hash b0f6c045e908bc632a4b24381c3c1164ccca95834761b2dc68d460bce6524c8f --backup D:\projects\finapp\.runtime\stage8-rules-before-REVIEWED_HEAD.json --out D:\projects\finapp\.runtime\stage8-rules-localverify-REVIEWED_HEAD.jsonl
node scripts/invitationRehearsal/stagingResources.mjs --mode verify-current-rules --project finapp-staging --expected-head REVIEWED_HEAD --expected-rules-hash b0f6c045e908bc632a4b24381c3c1164ccca95834761b2dc68d460bce6524c8f --out D:\projects\finapp\.runtime\stage8-rules-predeploy-REVIEWED_HEAD.jsonl
```

The local backup verification mode never loads CLI auth or calls the network.
The backup JSON contains full raw source and release metadata, with raw and
canonical hashes and byte count. The helper binds the documented baseline
hash to its exact observed ruleset name. All cloud modes additionally confirm
the database identity/type/location `eur3`. Re-run the current Rules gate
immediately before the scoped Rules deployment, using a new journal path if
needed. After deployment use the same mode with the reviewed new hash
`15bbc0050dd1ed2259c921818794b4f234c4457ad3e66ee2d0fa1da6d148f89d`.

## Additive invitation index; preserve the field override

Never deploy the checked-in `{fieldOverrides: []}` to staging wholesale: one
live override exists and its contents have not been inventoried publicly.
Freshly list all indexes/field overrides and preserve their private metadata
and hash. Confirm no existing configuration changed before/after the additive
operation. If an exact matching index already exists, reuse it and wait for
`READY`; do not create another one.

The vetted installed `lib/firestore/api.js#createIndex` contract is:

```text
POST https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/collectionGroups/invitations/indexes
```

```json
{
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "companyId", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" },
    { "fieldPath": "__name__", "order": "DESCENDING" }
  ]
}
```

The helper must journal the before-state and request uncertainty before
dispatch, disable repeated native create dispatch, and immediately retain
the returned operation/index name privately. Poll only the exact returned
operation and verify index state through GET. On timeout/conflict/unknown
result, read current indexes and resolve identity/state before any further
action. `READY` is required here; the actual real `listInvitations` query
remains a rehearsal criterion for the subsequent fixture package. No
field/index DELETE/PATCH or automatic rollback deletion.

```powershell
node scripts/invitationRehearsal/stagingResources.mjs --mode ensure-index --project finapp-staging --expected-head REVIEWED_HEAD --expected-field-overrides-hash af2e9e80c150cc9a6b2f4c5f5bae330dacb214d7a104188fa5ef4fcfad3c6aee --out D:\projects\finapp\.runtime\stage8-index-create-REVIEWED_HEAD.jsonl
node scripts/invitationRehearsal/stagingResources.mjs --mode verify-index --project finapp-staging --expected-head REVIEWED_HEAD --expected-field-overrides-hash af2e9e80c150cc9a6b2f4c5f5bae330dacb214d7a104188fa5ef4fcfad3c6aee --out D:\projects\finapp\.runtime\stage8-index-verify-REVIEWED_HEAD.jsonl
```

The private before-POST journal retains full prior indexes and field-override
metadata, not merely hashes. Other index definitions and the approved field
hash must still match after creation. Polling is bounded to 24 reads with
five-second waits; request/auth/library retries can extend wall time. On
uncertainty or an existing index still building, `verify-index` is the
read-only reconciliation command; it never issues POST. No blind re-create.

## Deferred rehearsal — excluded from this approval

The following describes remaining SEC-006 acceptance work, not actions in
this deployment-only package. A subsequent reviewed package will supply
fixture counts, mailbox handling and execution commands. Do not execute
the existing emulator browser runner against live staging.

The final runner must declare bounded counts before approval. Use unique
run-scoped synthetic Auth identities, two synthetic companies, memberships,
profiles and a manifest of exact created IDs; never read or modify unrelated
companies or financial documents. Generate fixture credentials in memory;
store neither passwords nor raw invitation/verification tokens in reports,
logs, browser traces or persisted app storage. The manifest may privately
retain entity IDs, disposition and safe timestamps for later review.

Required paths written by the existing callables are bounded to those
fixtures: `users/{uid}`, `user_bootstrap/{uid}`, `companies/{companyId}`,
`companies/{companyId}/members/{uid}`, `company_data/{companyId}`,
`companies/{companyId}/audit_events/{id}`, `invitations/{inviteId}` and
`invitationLocks/{lockId}`. Financial contents remain synthetic/empty.
Do not run SEC-005 or toggle `system/maintenance`; if its state prevents
the approved callable, stop instead of changing it.

Run these scenarios against the deployed backend and the exact staging
static build, recording sanitized outcomes and revision/hash evidence:

1. Admin creates/lists/cancels/rotates an invitation via callable; no Auth
   user is created by invitation creation. Verify cooldown and old-token
   invalidation. Roles/cross-company denial use synthetic accounts only.
2. New invitee opens the actual copy-link; synchronous fragment removal,
   safe preview, registration with their own password, and no financial
   import/read before confirmed membership.
3. Send one real Firebase verification email to the privately approved
   recipient through `sendEmailVerification`. Any additional real email
   must be within the approved maximum; do not automatically spam retries.
   Never administratively mark this real invitee verified.
4. Only after the local staging server is running and smoke-checked, provide
   its working invitation link privately and ask the owner to open the
   received email. Keep the invitation tab open: the capability is in
   memory only. Do not ask the owner to use an unavailable/offline stand.
5. Return to the invitation tab, reload Auth and force-refresh the ID token,
   accept, confirm `getCompanyAccess` and enter only the fixture company.
   Check same-UID replay, wrong identity denial and no partial access.
6. Existing synthetic invitee, viewer/accountant denial, company switch,
   two-tab logout, direct link/reload and network loss/recovery. Confirm
   the tested access state, not only HTTP success or rendered screenshots.

If the real mailbox already has a staging account, do not reset its password
or overwrite its profile. Preserve the account and prepare its exact
existing-user flow/affected-profile backup for review, or use another
explicitly approved mailbox. Synthetic existing-user success is separate
from the genuine verification-email evidence. No third-party email provider
is introduced; manual copy-link remains phase 1.

## Postconditions, partial deployment and rollback

Successful deployment evidence includes fresh eight-Function inventory and
revisions/resource settings, current Rules hash, invitation index `READY`,
unchanged pre-existing field override, staging bundle/static hashes,
passive tokenless static smoke and retained backup/operation manifests.
Synthetic live scenarios and actual Auth/email verification are deferred;
their missing results prevent closure of SEC-006. Do not claim production
readiness from this deployment or a partial rehearsal.

The CLI may exit nonzero **after Functions successfully deployed** when no
Artifact Registry cleanup policy exists. Installed
`deploy/functions/prompts.js#promptForCleanupPolicyDays` explicitly throws
in non-interactive mode instead of setting a policy. Do not retry deployment
or add `--force`; establish actual Function/revision state read-only and
report the separate cleanup-policy outcome. Do not configure automatic
artifact deletion or close the rollback window to make the command green.

Rollback principles:

- Before writes, fresh Functions inventory must still be empty. Therefore
  there is no pre-existing Function code to restore. Record every created
  function/revision. If reversal is requested, remove only the newly created
  named Functions after confirming their identity and any intervening use;
  no automatic deletion or wildcard cleanup is included.
- An emergency Rules restore, only if explicitly included in the final
  approval, uses PATCH to the exact release with
  `{ "release": { "name": "projects/finapp-staging/releases/cloud.firestore", "rulesetName": "projects/finapp-staging/rulesets/01da0ec2-a6b0-4b17-b533-81195a573359" } }`.
  Require the current release/hash still equals this run's deployed Rules
  before restoring and verify the old hash afterward. Do not recreate a
  release on an unknown error or restore across unrelated later changes.
- Keep the additive index, dependencies, images, source backups, fixture
  data and journal until a separate cleanup/rollback decision. Reverting
  client/server code does not restore Auth or Firestore data.
- A timeout/unknown mutation outcome first requires read-only reconciliation
  of the exact operation and resources. No blind retry. Stop the rehearsal
  on incorrect rights, unexpected real data, hash drift or partial access.
- No maintenance is enabled by this package; there is therefore no automatic
  maintenance-removal step or permission to issue historical commands.

The final approval may explicitly bundle the verified backup, additive index,
scoped Functions/Rules deployment and passive static smoke. Once
that concrete package is approved, perform its authorized commands without
asking again between steps. Any resource, data, access or cost change beyond
the approved envelope needs a revised concrete package.
