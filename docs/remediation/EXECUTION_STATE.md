# Execution checkpoint

Updated: 2026-09-06. Status: READY_FOR_RELEASE_APPROVAL — SEC-006 Stage 8
Functions API activation plus inventory rerun, subject to final delivery-HEAD
CI below. Current live inventory remains BLOCKED by SERVICE_DISABLED.

- Scope: stabilization stages 0–8; stage9 excluded. Engineering, separate
  agents/review and expected-HEAD merges authorized. External actions require
  a concrete approved package under handoff section8. SEC-005 is complete:
  never repeat production backfill, imports or maintenance.
- Worktree: D:/projects/finapp/finapp-sec006-stage8.
- Branch: remediation/SEC-006-stage-8-rehearsal.
- Base/main: 2d73f13c474269283dd653233bb3d38a47185120.
- Stage7 PR26 MERGED after independent final PASS by /root/stage7_review on
  888c53e6ffd4017b6efe2da7a5ae0a72c27eb1d8 and exact-HEAD CI.
  Protected squash merge and owner-approved Pages publication executed.
  Reviewed and merged tree: bb0ddd76c306aeb3c85629c7324721bcd88ba52a.
  PR: https://github.com/Alexspb-spb1/finapp/pull/26.
  Main CI SUCCESS: https://github.com/Alexspb-spb1/finapp/actions/runs/34027637579.
  Pages SUCCESS: https://github.com/Alexspb-spb1/finapp/actions/runs/34027763508.
  These states and SHA were freshly rechecked after context recovery.
- Stage7 actual Pages artifact9987612172 downloaded and compared with live
  index/404/all JS/CSS. Static public login/missing-token invite PASS,
  Auth/data actions0, page errors0. This is static publication evidence only.
  Local evidence: D:/projects/finapp/.runtime/pages-2d73f13/public-smoke.json.
  artifact.tar SHA256:
  19260403b2d355cbd7842b8aa98d4253cfba24b18d31ae8f8635bbadebfc7996.
- Stage6 PR25/main82934d2 previously merged and static-verified. Preserved
  backups: D:/projects/finapp/.runtime/pages-ff0ed16/ and
  D:/projects/finapp/.runtime/pages-82934d2/. No rollback or cleanup executed;
  rollback window remains open. Never replay Stage6/7 releases from old text.
- Stage8 local checks PASS: root248, Rules126, migration570, preflight5,
  Rules TypeScript; Functions344unit/224emulator on Node22; installs, lint,
  types and builds. Inventory self-test11 PASS and required in CI.
  Frozen browser helper full PASS:13 contexts, pageErrors0, token URL/storage
  leaks0. One known legacy currency request hard-blocked; live actions0.
  Evidence: docs/remediation/evidence/SEC-006-stage8/ (artifact hashes/screenshot).
  Production source/Rules/indexes/lockfiles unchanged.
- Independent /root/stage7_review found and verified fixes for
  inventory redirects, CLI auth fallback, Windows environment casing and safe
  browser diagnostic handling. REVIEW_RESULT PASS on implementation HEAD
  9d875cf07415b83938728d1ffea2698b197e0318, no authorship by reviewer.
  Inventory/browser code and evidence remain identical to that reviewed commit.
  A separate API activation helper was added after the approved inventory's
  SERVICE_DISABLED result. Independent /root/stage7_review PASS on
  8065e3a4f0368daba7a1409e9f515be9ba524675 (delta base a5b70c7), no authorship.
  This delivery update records documentation only; activation code/tests and
  runbook match that PASS. Resolve delivery HEAD from local Git and PR27.
- Draft PR27: https://github.com/Alexspb-spb1/finapp/pull/27 (UNMERGED).
  Final delivery HEAD is local HEAD/PR headRefOid, which must match.
  CI source: https://github.com/Alexspb-spb1/finapp/pull/27/checks.
  Confirm ci/functions SUCCESS for that exact HEAD before inventory execution;
  do not substitute an earlier run. Final delivery message supplies SHA/run.
- Owner approved and executed the a5b70c7 read-only inventory package after
  exact CI34029148879 and independent final PASS. Result: INVENTORY_BLOCKED,
  no success report. Safe diagnostics: project200/database200/functionsV1 403,
  reason SERVICE_DISABLED. Existing CLI/environment guards PASS.
  Private evidence: D:/projects/finapp/.runtime/sec006-stage8-inventory-a5b70c7-blocked.json.
  No cloud writes, deployment, API activation or email occurred.
- Remaining cloud Functions/Rules/index/Auth configuration and rollback readiness
  are UNKNOWN; a disabled API is not evidence that no Functions exist.
  Owner supplied a private mailbox for the future email package; that is not
  email-sending authorization and the address must not enter public evidence.
- Activation package: runbooks/SEC-006-stage8-functions-api.md, new helper plus
  12 local self-tests PASS and mandatory CI step; prior inventory11 still PASS.
  At most one native enable POST, complete fsynced journal before dispatch,
  separate before/after states, fixed-target read-only preflight/poll/recovery.
  Normal provider-managed activation effects are included in the proposed
  scope; billing upgrade, new terms acceptance, manual IAM/API expansion,
  deployment, cleanup and email remain excluded. No activation authorized yet.
- Next: verify final delivery-HEAD CI and request the exact activation plus
  inventory-rerun package; execute neither until separately approved.
  Do not blindly repeat the failed inventory or replay Stage7 publication.
  Resolve current local HEAD and PR headRefOid; they must match reviewed delivery
  code and green CI. The final approval message supplies exact SHA and new path.
  Merge triggers Pages and needs its own package approval. Do not run existing
  stagingVerify live harness under read-only approval (it writes/deletes fixtures).
  Firebase deploy --dry-run may enable APIs and is not a read-only preflight.
- SEC006 remains OPEN. Phase1 is copy-link with Firebase verification;
  actual mailbox/link and live release criteria remain. General legacy
  Auth/state weaknesses belong to SEC008/009/STATE001 and members Rules SEC011.
  Do not advance through an unmet gate or claim production readiness.

Resume: inspect actual diff, GitHub and this checkpoint. Local emulators are
temporary; verify processes/ports before reuse. Do not replay external actions.
