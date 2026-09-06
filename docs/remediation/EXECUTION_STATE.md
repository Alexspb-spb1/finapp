# Execution checkpoint

Updated: 2026-09-06. Status: IN_PROGRESS — SEC-006 Stage 8 staging release
preparation. Approved dd8f049 API activation and full inventory SUCCEEDED.
Do not repeat activation; no deployment or real email has occurred.

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
  At that browser/inventory checkpoint, production source/Rules/indexes and
  lockfiles were unchanged. The subsequent runtime configuration delta below
  changes Functions deployment descriptors; handler logic remains unchanged.
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
- Later owner explicitly approved dd8f049753d21161278efe76e3aefc340a4d9922
  activation+inventory package. Exact-head CI34031548167 and final PASS rechecked.
  API DISABLED -> ENABLED verified at2026-09-06T12:20:27.1Z, single activation.
  Full inventory complete at12:20:58.448Z: no deployed v1/v2 Functions, no
  composite indexes; database(default) eur3/FIRESTORE_NATIVE; field overrides1.
  Active Rules b0f6c045e908bc632a4b24381c3c1164ccca95834761b2dc68d460bce6524c8f
  differs from local15bbc0050dd1ed2259c921818794b4f234c4457ad3e66ee2d0fa1da6d148f89d.
  Email/password enabled; domainslocalhost/stagingfirebaseapp/stagingwebapp.
  Backup source not downloaded; billing/deployment/real email still unverified.
  Evidence: D:/projects/finapp/.runtime/sec006-functions-api-dd8f049.jsonl and
  D:/projects/finapp/.runtime/sec006-stage8-inventory-dd8f049.json.
  Never replay prior SERVICE_DISABLED attempts or the successful activation.
  Owner supplied a private mailbox for the future email package; that is not
  email-sending authorization and the address must not enter public evidence.
- Activation package: runbooks/SEC-006-stage8-functions-api.md, new helper plus
  12 local self-tests PASS and mandatory CI step; prior inventory11 still PASS.
  At most one native enable POST, complete fsynced journal before dispatch,
  separate before/after states, fixed-target read-only preflight/poll/recovery.
  Normal provider-managed activation effects are included in the proposed
  scope; billing upgrade, new terms acceptance, manual IAM/API expansion,
  deployment, cleanup and email remain excluded. Activation scope executed.
- Runtime deployment settings now explicit on all nine callable exports:
  us-central1, 256MiB, CPU1, concurrency1, minInstances0, maxInstances1,
  timeout60s. Deployment allowlist contains eight functions, excluding
  authzProbe. Functions354 unit and224 emulator tests PASS; preliminary independent caps
  review found no blockers. Final combined review/CI still required.
  These settings apply per function and are not a monetary spending cap.
- Private staging build and configuration fingerprint PASS. Local SDK source
  package and per-file/static manifest retained under
  D:/projects/finapp/.runtime/sec006-stage8-release-prepared-v2/.
  Explicit Functions upload exclusions prevent diagnostic logs/local secret
  files entering the archive. Prior package retained as rejected diagnostic.
  No live staging frontend has been opened; dist now contains staging config,
  so do not reuse it with the demo-finapp browser helper.
- New release helpers: staging resources14 and deployment metadata17 native
  tests PASS on host Node24. Root lint/types PASS (one existing Balance.tsx
  dependency warning). Independent preliminary review found no blockers,
  including94 archive entry hashes. Final commit review, CI and local artifact
  guard receipts belong to the private approval envelope, not this earlier
  activation approval:
  D:/projects/finapp/.runtime/SEC-006-stage8-staging-release-approval.md.
  Resolve that envelope and actual Git/PR HEAD before any external execution.
- Candidate4749bbf independent PASS, Functions CI PASS; root CI34034292369
  failed one unchanged migration refusal test at5875ms vs5000ms timeout
  (569/570 passed). Narrow local reproduction PASS in2.43s, unchanged refusal
  assertions verified; slow CI child phase not identified. New exact-head CI
  required; no timeout bump or live maintenance.
  Additional local artifact guard now rejects Functions dotenv/secret/runtime
  configuration even when ignored by upload/Git;7 fixture tests added to CI.
- Next: prepare bounded staging deployment package: private Rules
  backup+fresh hash before replacement, additive index preserving override,
  scoped8 Functions, runtime resource caps, staged SDK build and passive
  metadata verification. Auth fixtures and real-email scenario are deferred
  to the next concrete package. Owner budget preference requested;
  no deployment authorized yet. Existing billing must be verified enabled;
  no billing-plan activation or upgrade is included.
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
