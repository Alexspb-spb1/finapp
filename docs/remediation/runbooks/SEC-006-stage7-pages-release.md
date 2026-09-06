# SEC-006 Stage 7 — static Pages release package

Prepared 2026-09-06, NOT EXECUTED. Applies only after independent PASS and
required CI for the exact PR HEAD supplied in the owner's approval message.
Merge invokes the existing Pages workflow, so handoff section8 requires a new
approval. Previous approval was Stage6 only and has already been used.

## Target, scope and expected changes

Repository Alexspb-spb1/finapp; branch remediation/SEC-006-stage-7-acceptance;
expected main 82934d2acfaaab79c6092cdbd67cd95e4189d645.
PR26: https://github.com/Alexspb-spb1/finapp/pull/26.
Independent PASS on implementation61c169d9837112e877d9716a7e81d6609a6e0671;
final delivery HEAD differs only by documented review/delivery records and is
given literally in the approval request. Use `$pr=26` below.
Target https://alexspb-spb1.github.io/finapp/.
Only a protected squash merge and static Pages publication, including the new
404 entry. No Firebase Functions/Rules/indexes deployment, sign-in, live Auth,
data reads/writes, invitations, real emails, maintenance or provider setup.
New getCompanyAccess is present in source but is NOT deployed by Pages; absent
backend fails closed. Full live invitation readiness remains Stage8 work.

## Preflight and execution

Set `$approvedHead` and `$pr` to the exact values in the owner's approval;
do not resolve HEAD dynamically as a substitute for expected-HEAD protection.
Require clean task tree, origin matching repository, unchanged base, reviewed
HEAD matching PR, independent PASS and ci/functions success at that HEAD.

```powershell
git status --short
git remote get-url origin
git fetch origin
git rev-parse origin/main
gh pr view $pr --json state,isDraft,baseRefName,headRefOid,statusCheckRollup
Get-FileHash -LiteralPath 'D:\projects\finapp\.runtime\pages-82934d2\artifact.tar' -Algorithm SHA256
gh api repos/Alexspb-spb1/finapp/actions/runs/34025377206/artifacts --jq '.artifacts[] | {id,name,expired}'
gh pr ready $pr
gh pr merge $pr --squash --match-head-commit $approvedHead
gh pr view $pr --json state,mergeCommit,headRefOid
git fetch origin
gh run list --branch main --limit 10 --json databaseId,headSha,status,conclusion,workflowName
```

Require main Git tree equal to reviewed tree, exact-main ci/functions success,
and Pages build/deploy success for that same merge SHA. Read back after any
timeout; never repeat a possibly completed merge blindly.

Download the new run's github-pages artifact into a NEW directory selected only
from the verified merge SHA. `$pagesRun`, `$mergedSha` and `$artifactDir` below
are outputs of the prior read-only checks, not permission to choose a target.

```powershell
gh run view $pagesRun --json headSha,status,conclusion,jobs
gh run download $pagesRun --name github-pages --dir $artifactDir
tar -tvf "$artifactDir\artifact.tar"
```

Verify inventory: regular files/directories only, no links, absolute paths or
parent traversal. Require index.html, identical404.html and referenced assets.
Only then create a fresh unpacked child and extract:

```powershell
New-Item -ItemType Directory -Path "$artifactDir\unpacked" -ErrorAction Stop
tar -xf "$artifactDir\artifact.tar" -C "$artifactDir\unpacked"
$env:FINAPP_BROWSER_TOOLS='D:\projects\finapp\.runtime'
node scripts/browser/pages-static-smoke.cjs $artifactDir $mergedSha
```

Helper compares served index/404/all JS/CSS with artifact SHA256, verifies the
unknown direct path serves identical404, opens fresh-browser login and missing-
token invitation page, blocks all nonstatic/Firebase requests and reports zero
Auth/data actions. Inspect screenshots; preserve JSON, hashes and artifact.

## Backup, rollback and safe stop

Existing local backup from Stage6, checked after its successful publication:
`D:/projects/finapp/.runtime/pages-82934d2/artifact.tar`;
SHA256 `440e7ea5311e7ba58f0794e7117da02a4352eae05de155a02d0a3c01e771b290`.
Prior Pages run34025377206, artifact9986884092, deploy job101465390193.
Before merge require artifact unexpired/reusable and local hash unchanged.
Preserve older pages-ff0ed16 backup too; rollback window remains open.

If new static smoke fails, approved emergency recovery is:

```powershell
gh run rerun 34025377206 --job 101465390193
gh run view 34025377206 --json headSha,status,conclusion,jobs
```

Verify old live index/JS/CSS hashes against preserved Stage6 artifact and public
login (the historical stage6-public-smoke.cjs helper in .runtime is preserved).
CLI contract verified; actual live rollback has not been rehearsed. If GitHub
cannot reuse the artifact, stop and report rather than silently rebuilding or
substituting. A source revert requires its own reviewed package.

Safe-stop: HEAD/base drift, missing PASS/checks/backup, any CI/deploy failure,
hash mismatch, browser module failure or unknown external result. No database
rollback or maintenance commands are involved. Never delete archives or close
the rollback window automatically.

Reads are GitHub metadata/artifacts and public static files. Changes are main
history and Pages content; existing Actions/Pages resources are used, no new
paid service is created. Account-specific incremental Actions billing is not
established; no invented cost estimate. Complete only this static release, then
proceed to Stage8 engineering/rehearsal preparation. Real Firebase/email release
and production multi-user verification need a separate concrete package.
