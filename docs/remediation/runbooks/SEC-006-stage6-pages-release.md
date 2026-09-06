# SEC-006 Stage 6 — Pages release approval package

Prepared 2026-09-06. NOT EXECUTED. Separate owner approval is required because
merging PR25 starts the existing CI → GitHub Pages deployment automatically.

## Target and boundaries

- PR: https://github.com/Alexspb-spb1/finapp/pull/25
- Reviewed implementation: 3584d169c4d4cf48ddeac93b1e35b70a083cbf5a.
- Expected main: ff0ed1695f25e5cdb55b9cb9df8c35119b5164b0.
- Exact final PR HEAD is supplied in the approval request and MUST be assigned
  literally to $approvedHead below; do not replace it with an unchecked latest SHA.
- Target: GitHub Pages https://alexspb-spb1.github.io/finapp/,
  environment github-pages, existing .github/workflows/deploy.yml.
- This publishes the Stage6 frontend only. It does not deploy Firebase Functions,
  Rules, indexes or change Auth, memberships, invitations, financial data or
  maintenance. No real invitation/email/user action is part of smoke.
- Stage7 acceptance is not implemented and callable deployment is unverified.
  The UI states acceptance is unavailable; missing backend surfaces a safe error.
  This is not approval of a working multi-user production release.

## Preflight and exact command sequence (PowerShell)

Run in the Stage6 worktree after approval. Fill $approvedHead from the exact SHA
in the approved package. Stop on ANY unexpected state, command failure or timeout.

```powershell
$approvedHead = '<literal approved final PR HEAD>'
git fetch origin
if ((git rev-parse origin/main) -ne 'ff0ed1695f25e5cdb55b9cb9df8c35119b5164b0') { throw 'Main changed: review new base before proceeding' }
if ((git rev-parse origin/remediation/SEC-006-stage-6-invitation-ui) -ne $approvedHead) { throw 'Branch HEAD changed' }
if ((gh pr view 25 --json headRefOid --jq .headRefOid) -ne $approvedHead) { throw 'PR HEAD changed' }
gh pr checks 25
```

Require successful ci AND functions on that HEAD, independent PASS and a clean
agreed diff. Recheck backend/Rules/deployment workflow unchanged. Preserve any
unknown dirty worktree; do not reset it. No --admin/force/skip checks.

```powershell
gh pr ready 25
gh pr merge 25 --squash --match-head-commit $approvedHead
gh pr view 25 --json state,mergeCommit,headRefOid
git fetch origin
gh run list --branch main --limit 10 --json databaseId,headSha,status,conclusion,workflowName
```

Read back state if merge times out; never repeat blindly. Record merge SHA and
require ci/functions success for THAT main SHA. Find Deploy to GitHub Pages run
for exactly that SHA; record its run ID, wait for build/deploy success and inspect
its artifact. Do not infer deployment success from merge/CI alone.

```powershell
gh run view <new-main-ci-run-id> --json headSha,status,conclusion,jobs
gh run view <new-pages-run-id> --json headSha,status,conclusion,jobs
gh run download <new-pages-run-id> --name github-pages --dir <new-isolated-artifact-directory>
```

The angle-bracket IDs/directories above are outputs of the preceding verified
read-only lookup, not permission to select another commit or target. Extract the
artifact in a NEW isolated directory, inventory files and calculate SHA256 for
index/assets. Public smoke fetches only /finapp/ and its referenced static assets
using TLS, comparing content/hashes with the actual new artifact. Open public
/#/login and ensure no blank page/module errors. Do not sign in, create users,
open financial data, send mail or exercise live callables under this package.

## Backup, rollback and freshness

Previous successful Pages run:
https://github.com/Alexspb-spb1/finapp/actions/runs/34021179792
Source ff0ed1695f25e5cdb55b9cb9df8c35119b5164b0; build and deploy success.
Artifact ID 9985542927, github-pages, 576150 bytes, not expired when inspected.
Downloaded immutable local backup:
D:/projects/finapp/.runtime/pages-ff0ed16/artifact.tar
SHA256: 47d1cbb24098b35850a4b600c1b4f86125179f0ae57dab284d2c69225f079486
Archive inventory verified: index.html, icons.svg, favicon.svg,
assets/index-BnJ3xhND.css, assets/index-BAeBVzRV.js.

Before merge recheck remote artifact availability and local SHA256. Preserve it;
no automatic archive/backup deletion or closing of the rollback window.

```powershell
gh api repos/Alexspb-spb1/finapp/actions/runs/34021179792/artifacts --jq '.artifacts[] | {id,name,expired}'
Get-FileHash -LiteralPath 'D:\projects\finapp\.runtime\pages-ff0ed16\artifact.tar' -Algorithm SHA256
```

Prepared emergency recovery if the new static frontend fails smoke: rerun the
previous Pages deploy job against its original successful run/artifact, then
verify the old static hashes. CLI contract verified via gh run rerun --help;
actual rollback execution has NOT been rehearsed against live Pages.

```powershell
gh run rerun 34021179792 --job 101454033835
gh run view 34021179792 --json headSha,status,conclusion,jobs
```

If GitHub cannot reuse the old artifact, stop and report; do not silently rebuild
or substitute another artifact. A durable source rollback can use a separately
reviewed revert PR; it also publishes Pages. The old artifact restores the old
invitation UI, so it is emergency recovery, not authorization to use admin signup.
No database rollback is necessary for a static-only publication. No maintenance
is enabled or disabled, so there is no maintenance-removal criterion here.

## Resources, risks and completion

Reads: GitHub metadata/artifacts and public static files. Changes: main history
via protected squash merge and Pages static publication. Existing configured
Actions/Pages resources are used; no new paid service, email provider, Firebase
mutation or secret read/setup is requested. Incremental billed Actions usage is
account-dependent and not established here; no numeric cost is invented.

Safe-stop: SHA/base drift, missing independent PASS/check, unexpected dirty diff,
missing/expired backup, CI/deployment failure, static hash mismatch, unknown
result of merge/deployment, or any need for live Firebase access. Record exact
state and preserve rollback artifact. Do not repeat uncertain external mutations.

Postconditions: PR merged at expected HEAD; exact main CI green; Pages deployment
for matching SHA successful; served index/assets match artifact; public login
loads. Record actual URL, deployed SHA, run/artifact/hash and backup state.
SEC-006 remains open; proceed to Stage7 only after this stage's permitted merge
and verification. Any backend/email/staging/production-data work needs a new,
fully prepared section-8 package and permission.