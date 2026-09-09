# Execution checkpoint

Updated: 2026-09-08. Status: IN_PROGRESS — SEC-006 Stage 8 staging backend
deployed and metadata-verified. The approved API activation, billing link,
index creation and scoped Functions/Rules deployment have completed. Do not
repeat them. Real invitation behavior and Firebase email remain unverified.

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
- Next: prepare a bounded live staging acceptance package with exact synthetic
  fixture counts, manifest/cleanup procedure and at most one Firebase
  verification email to the privately supplied mailbox. Do not execute Auth,
  Firestore fixture, callable, email or cleanup actions until that separate
  concrete package is approved. Do not run the emulator-only browser helper
  against staging or replay Stage7 publication. PR27 stays Draft because merge
  triggers Pages and the live acceptance gate is still open.
- SEC006 remains OPEN. Phase1 is copy-link with Firebase verification;
  actual mailbox/link and live release criteria remain. General legacy
  Auth/state weaknesses belong to SEC008/009/STATE001 and members Rules SEC011.
  Do not advance through an unmet gate or claim production readiness.

Resume: inspect actual diff, GitHub and this checkpoint. Local emulators are
temporary; verify processes/ports before reuse. Do not replay external actions.

## 2026-09-08 billing checkpoint

- Owner-approved package 265d552 began with fresh clean HEAD/PR/CI and local
  artifact PASS. Initial deployment preflight stopped before writes because
  `finapp-staging` billing was disabled. Read-only reconciliation confirmed
  Functions 0/indexes 0 and unchanged Rules/field override/Auth metadata.
- Separately approved billing discovery found exactly one open account. Owner
  then approved linking it; one link command succeeded and fresh Google CLI
  metadata verified `billingEnabled=true` with the exact selected account.
  Private receipt: D:/projects/finapp/.runtime/stage8-billing-link-01D5C5.json.
- No index/Functions/Rules/Auth/data/email mutation followed. The protected
  Firebase-session preflight still returned 403 only for its billing GET. A
  bounded comparison proved the same session succeeds when that GET omits
  `x-goog-user-project`; all other metadata requests retain the header. Review
  found firebase-tools can inject the header from GOOGLE_CLOUD_QUOTA_PROJECT;
  the Billing request must also set its exact `ignoreQuotaProject` option.
- At this checkpoint the next task was review/CI of the narrow preflight
  transport fix, then resumption of package `265d552` from a fresh exact-HEAD
  artifact/preflight sequence. The later deployment checkpoint below supersedes
  this historical next-action note.

## 2026-09-08 staging deployment checkpoint

- Exact deployment code: `ab1bd670ad04debd081af542e367c5dfc95e55ab`.
  PR27 was Draft/Open on that exact HEAD; CI run34219671340 had both `ci` and
  `functions` SUCCESS. Independent `/root/billing_header_review` returned PASS.
- The approved package completed against `finapp-staging` only. The Rules
  baseline was backed up and read back before writes. The invitation composite
  index create returned a durable operation but timed out locally; read-only
  reconciliation found the one expected index `CREATING`, then `READY`. No
  second create request was sent. The pre-existing field override count/hash
  remained `1` / `af2e9e80c150cc9a6b2f4c5f5bae330dacb214d7a104188fa5ef4fcfad3c6aee`.
- Exactly eight Gen2 Functions are ACTIVE in `us-central1`: `createCompany`,
  `inviteMember`, `listInvitations`, `cancelInvite`, `resendInvite`,
  `previewInvite`, `acceptInvite`, `getCompanyAccess`. Each is Node22,
  256MiB, CPU1, concurrency1, minInstances0, maxInstances1, timeout60s.
  `authzProbe` was not deployed. One Functions deploy command was issued.
- The Functions CLI exited nonzero only after all eight successful creates
  because non-interactive mode would not configure an Artifact Registry cleanup
  policy. No retry and no cleanup policy change occurred. Strict postflight
  independently verified all eight resources and caps.
- One Rules-only deploy succeeded. Active Rules now reference ruleset
  `e27fcfcc-ee6d-4ac3-9d8e-b1303f44134b`; canonical hash equals reviewed local
  `15bbc0050dd1ed2259c921818794b4f234c4457ad3e66ee2d0fa1da6d148f89d`.
  The prior ruleset/source backup remains private for a separately approved
  restore if ever required.
- Final inventory receipt:
  `D:/projects/finapp/.runtime/stage8-deployment-final-ab1bd67.json`, SHA256
  `f7b93c7787a0e2f709f57d547eee7abb382322c48d4e576566f9fdd1b0b2267d`.
  Strict Functions postflight receipt SHA256
  `db0c2508ff2595a6be62ebd91ea784bcdda7fbd09f62353ddf406c9e3c3592a5`.
- Auth users, callable scenarios, Firestore fixture data, real email, financial
  data, maintenance, migration, cleanup, production, merge and Pages actions
  were not performed. Metadata deployment success does not close SEC006.

## 2026-09-08 mailbox discovery and live-package checkpoint

- Owner-approved read-only mailbox discovery ran once on exact reviewed HEAD
  `5e476df19c5ad3e90184a6191430d94c23fea99a`. Result:
  `accountExists=false`, `profileExists=false`, cloud mutations0, emails0.
  Private receipt:
  `D:/projects/finapp/.runtime/stage8-mailbox-discovery-5e476df.json`, SHA256
  `b9be2d78de4711406361be6bb4be55b90e9ada3d78275a55dc130719da96ffe6`.
  The mailbox value remains only in the private runtime file. Repeat the exact
  lookup immediately before a future authorized first write; do not treat this
  saved result as fresh indefinitely.
- Live-acceptance runbook fixes the complete minimum scope: two synthetic
  verified owners and companies, ownerB viewer access in companyA, owner
  mailbox accountant acceptance, cancel plus real 60-second resend rotation,
  wrong/unverified/replay/isolation/switch/two-tab/reload/offline checks.
  Maximum retained state: Auth3 and 27 unique Firestore documents, including
  memberships4 and audits9; callable POSTs<=40; real verification emails<=1.
- New core/preparation helper uses pinned receipt bytes, exact private paths,
  `wx` plus fsync, sanitized manifests, append-only state validation, one-shot
  request authorization and an exact cleanup-target planner. The core accounts
  for all16 mutation-capable dispatches, including expected no-write denials and
  idempotent replay; recovery rejects truncation/in-flight/terminal journals,
  and the email permit cannot be replayed after restart. Its current CLI is
  deliberately preparation-only: live transport, browser automation, Auth/data
  writes, email and cleanup are disabled. Local self-tests17 PASS and the test
  is mandatory in CI. This is not READY_FOR_RELEASE_APPROVAL yet.
- Next: implement and emulator-test the statically allowlisted Firebase/Admin/
  Playwright adapters and complete six-scenario schedule, then commit/push
  PR27, obtain exact HEAD CI and independent PASS, and create the private
  section-8 approval artifact. Do not request or perform live staging
  mutations/email before that.
- A local-only browser-security layer now classifies sanitized emulator endpoint
  shapes and binds live-shaped requests to the six-field staging fingerprint,
  exact journal slot/body hash and callable budgets before dispatch. It blocks
  Firestore writes, unknown endpoints and the legacy rates request, and gives
  the verification request a single durable permit. Browser-core self-tests7
  PASS and are required in CI. The optional endpoint recorder persists no URL
  values, headers, bodies, credentials or capabilities. A full emulator/browser
  capture passed with 19 sanitized shapes and live requests0. Private receipt:
  `D:/projects/finapp/.runtime/stage8-endpoint-shapes-local-v2-20260908.json`,
  file SHA256
  `7d361ad44d108386c92ae5a54257812b952ec2007049f547bceb0ec5c8c51cbb`.
  A separate live executor core now requires eight fresh preflight adapters,
  all 16 mutation slots, an exact 14-step read-only scenario schedule, durable
  callable counters and verified-session proof, dual-clock 60-second cooldown,
  observation/update-time/audit/replay validation and cleanup-plan-only output.
  Executor plus CLI self-tests9 PASS. The `--execute` CLI validates exact
  approval bytes/hash, clean HEAD and new external private paths, then stops
  before credentials or network because five concrete real adapter groups are
  still listed as missing. The live execution gate therefore remains open.

## 2026-09-08 live executor implementation checkpoint

- The five concrete adapter groups are now implemented: guarded Firebase CLI
  session and eight fresh read-only preflights, synthetic verified Auth owners,
  callable dispatch and token lifecycle, semantic incremental/final Firestore
  reconciliation, fixed loopback build serving and visible non-persistent
  Playwright orchestration. The only remaining static marker is the current
  staging Auth verification-template response shape.
- The independent interim review returned CHANGES REQUIRED on six specific
  points. The implementation now requires a successful exact-UID
  `emailVerified=true` lookup and successful forced refresh, bounds every
  Playwright wait, fixes origin to `http://127.0.0.1:5177`, validates each
  successful write semantically, checks full no-write invitation/lock/member/
  profile/audit snapshots, and queries one row beyond each expected final audit
  count so extra events cannot be hidden.
- Concrete runtime safeguards include immutable in-memory dist attestation,
  exact system Chrome executable binding, dispatch-attempt accounting before
  awaiting responses, short-write rejection, the fixed private mailbox path,
  actual loopback receipt binding and real clipboard clearing. No secret value
  is emitted by the runtime or tests.
- Required local checks on the final working tree passed: root unit 248/248,
  Rules emulator 126/126, migration emulator 570/570, Functions unit 354/354,
  Functions emulator 224/224, aggregate live executor 61/61, adapters 12/12,
  runtime 9/9, Playwright 19/19, loopback 7/7, lint with the one pre-existing
  `Balance.tsx` warning, typecheck, both builds and `git diff --check`.
- The owner-authorized narrow read-only Auth shape discovery passed on clean
  checkpoint HEAD `31c8aed4987c8fdde203744845dd6cdb4d4696de`.
  Private receipt `D:/projects/finapp/.runtime/stage8-auth-shape-31c8aed.json`
  has file SHA256
  `60ddb5305ea431f255abb259f7ad6a5c413f7e7e7abd8c966644085102eee1cc`;
  sanitized metadata SHA256 is
  `18f79f56b79525cf78aba6aa9c73cb310a92fd19ee3f1fa25d665e8ef6ddaa50`.
  The first strict read safely stopped because Firebase omitted a
  protobuf-default false field. A sanitized read-only presence probe confirmed
  the omission; the validator and test now accept only omitted/boolean
  `customized`, and a clean retry passed. The final static adapter marker is
  removed. Live fixture writes, the verification email, cleanup, production,
  merge and Pages remain unexecuted and unauthorized under this checkpoint.

## 2026-09-08 final Stage 8 review remediation checkpoint

- Independent review of clean HEAD
  `337016d29e3f53dced939c03141f7369ba295856` returned `CHANGES REQUIRED` for
  three issues: unconditional scenario PASS rows without real UI evidence,
  fail-open clipboard handling without a real admin copy-link check, and no
  durable private recovery/cleanup manifest with exact recovery material.
- The current local tree fixes all three. The first mailbox invite is driven
  through the actual owner-A admin UI after a full exact Firestore query proves
  Company A has zero invitations. The initial empty list may then be supplied
  locally, but the post-create `listInvitations` request is real, journal-gated
  and semantically reconciled. The displayed link and clipboard are checked;
  clipboard clearing and empty readback are mandatory.
- Eleven typed Playwright observations now cover owner-A admin UI, owner-B
  admin/viewer company switching, direct `/users` denial, offline/online
  recovery, restored admin context, two-tab logout, mailbox accountant UI and
  mailbox reload. Six scenario PASS rows are derived from backend evidence and
  the required UI rows. The already verified mailbox page is borrowed without
  credential access and retained until those checks finish.
- Private `--out` now includes a validated recovery manifest for `SUCCESS` and
  ordinary `RECOVERY_REQUIRED` safe stops: all 16 fixture states, all 14
  read-only states, email state, exact UIDs/document/audit paths, generated
  create-company idempotency inputs, create/update timestamps, CAS
  preconditions and deferred cleanup targets. Public output retains only safe
  UI rows and hashes.
- Current full local matrix PASS: root unit 248/248; Rules 126/126; migration
  570/570; Functions unit 354/354; Functions emulator 224/224; aggregate live
  executor 70/70; adapters 13/13; runtime 11/11; Playwright 24/24; loopback
  7/7; staging preflight 5/5; auth-template discovery 5/5. Root/Functions lint,
  typecheck and builds PASS; root lint retains only the pre-existing
  `Balance.tsx` warning; `git diff --check` PASS. The first Rules attempt found
  system Java 17 and stopped before tests; the explicit portable-JRE-21 rerun
  passed.
- Worktree is intentionally dirty pending this documentation update and commit.
  Next gates: clean commit, independent re-review, push, exact PR-head equality,
  exact-head `ci` and `functions` success, then a concrete private section-8
  live execution package. Live staging fixture writes, the verification email,
  cleanup, production, PR27 merge and Pages remain unperformed and are not
  authorized by this checkpoint.

## 2026-09-08 second Stage 8 review remediation checkpoint

- Independent review of clean HEAD
  `bb5d1ea9350a8f0e0507af6537102b91a356a5ca` returned `CHANGES REQUIRED` for
  four blockers: held admin response-shape incompatibility, replacement admin
  readbacks whose stateful prepare closures had not run, recovery state that
  could be lost before final output, and unexpected browser routes that did not
  always invalidate successful evidence.
- The current tree gives the real owner-A admin invitation and following list
  request their own complete operation lifecycle and semantic Firestore
  reconciliation. The held callable summarizer now accepts their exact safe
  shapes. Mailbox, admin and post-fixture Playwright drivers maintain a fatal
  route latch, so a denied, unexpected or classifier-error auxiliary request
  prevents a successful result.
- A new private `<out>.recovery.jsonl` stream is append-only, hash-chained,
  opened with `wx`, and fully written, fsynced and reread after every event. It
  receives executor state before each possible dispatch, provider snapshots
  after capture/reconciliation, generated create-company idempotency inputs,
  planned synthetic UIDs, `FINAL_MANIFEST` before teardown/output, and
  `RECOVERY_REQUIRED` after interruption, HEAD drift or output failure. The
  final `--out` path is attempted only once.
- CLI validation proves that deterministic recovery path is new, outside the
  checkout, has an existing real parent and is distinct from approval, journal
  and output before runtime loading.
- Current full local matrix PASS: root unit 248/248; Rules 126/126; migration
  570/570; Functions unit 354/354; Functions emulator 224/224; aggregate live
  executor 77/77; core 9/9; adapters 14/14; CLI 5/5; operations 2/2; runtime
  11/11; Playwright 26/26; loopback 7/7; staging preflight 5/5; Auth template
  discovery 5/5. Root/Functions lint, typecheck and builds PASS; root lint has
  only the unchanged `Balance.tsx` warning; `git diff --check` PASS.
- No live staging credential read, Auth/Firestore fixture, callable scenario,
  verification email, cleanup, production, merge or Pages action occurred.
  Next gates remain clean commit, independent PASS, push, exact PR-head
  equality and exact-head `ci`/`functions` SUCCESS before preparing the private
  section-8 execution package.
- Exact-head CI run `34269739048` then found one Linux-only self-test fixture
  error: `fakeSessionHarness` supplied a hard-coded Windows path to the guarded
  loader, so 11 adapter cases stopped at the absolute-path guard. The
  `functions` job passed. The fixture now uses cross-platform
  `path.resolve('.')`, and the aggregate executor passes 77/77 locally again.
  This requires a new clean HEAD, independent review and fresh exact-head CI;
  the failed run is not accepted as a release gate.
- Exact-head run `34270362756` proved the first fix but found four more source
  locations with Windows-only journal/output paths in the composition test.
  `functions` passed;
  root `ci` had 76/77 aggregate executor tests pass and stopped on that one
  composition case. All composition paths now derive from the native
  filesystem root. A scan finds no remaining drive-letter literals in the
  invitation self-tests, and aggregate executor remains 77/77 locally. This
  second run is also failed evidence and does not satisfy the gate.
- Independently reviewed HEAD `628bc8945dd5184cf495958e0157c4455e700af0`
  then passed exact-head run `34271204957` (`ci` and `functions`). While deriving
  the private execution pins, a local zero-network check found that the new
  runtime and loopback guards hashed the six staging fields as JSON, while the
  existing BASE-002 guard and retained `.env.staging.local` use the canonical
  `key=value` newline serialization. The mismatch would have stopped before
  credentials or network, but it also made the approved live path impossible.
  The current tree reuses `computeFirebaseConfigFingerprint()` in both guards
  and adds regression assertions that the canonical digest differs from the
  obsolete JSON digest. Runtime 11/11, loopback 7/7, aggregate executor 77/77,
  staging preflight 5/5 and `git diff --check` pass. The local prerequisite
  validator accepts the retained config/mailbox by hashes only, and
  `build:staging` passes with the existing canonical fingerprint (the first
  sandbox attempt hit the known Vite native-binding/spawn restriction; the
  unrestricted local rerun passed). A new review, clean HEAD and exact-head CI
  are required before generating the private package.
- The first private execution package review returned `CHANGES REQUIRED` before
  live use: its command commitment still named the prior output paths; it
  promised a one-hour approval while the executor accepted any duration up to
  24 hours; and freshness/approval/postflight steps were prose rather than
  exact executable commands. The current CLI now requires `expiresAt` to be
  exactly one hour after `approvedAt`, with a regression test rejecting a
  correctly rehashed two-hour approval. A new reviewed HEAD/CI is required;
  then recreate the private package and its fixed local approval helper. The
  rejected package is not authorization and must never be executed.
- Independent review of the exact one-hour change found one remaining boundary:
  `now === expiresAt` was accepted. The current tree changes the expiry check
  to `expiresAt <= now` and adds that exact-instant rejection case. Review and
  CI must be repeated; no live action followed the finding.

## 2026-09-09 Stage 8 approved-package safe stop

- The owner authorized independently reviewed private package SHA-256
  `ac7af67e10dc68be857416699591cb605d709ea86c9ca178fb556f76ad008ac6`
  for exact reviewed HEAD `e545c0a564d3760300cb27c09a2f15867ae1077e`.
  Package/helper integrity, Draft PR 27, exact-head CI run `34275106652`, local
  pins and absent output paths passed immediately before approval creation.
- The package's single executor invocation stopped at its local gate before a
  journal or recovery stream existed. No Firebase credentials, provider
  preflight, browser, Auth/Firestore mutation, callable scenario, email or
  cleanup ran. The private approval is retained as consumed failed evidence;
  the package and its paths must not be reused.
- Read-only diagnosis reproduced the cause: Node 24.16.0 on this Windows host
  returns `spawnSync npm.cmd EINVAL`. The standalone staging build and loopback
  tests pass, but the runtime's direct child-process invocation of the Windows
  command shim could never start.
- Clean remediation code commit
  `1d49c55295c672505c9812fdfca0897dcea329ba` replaces that Windows
  invocation with the current `node.exe` plus its canonical, contained regular
  `node_modules/npm/bin/npm-cli.js`; non-Windows keeps the existing `npm`
  invocation. The resolver rejects executable and final CLI symlinks;
  regression tests cover the Windows command, ancestor-junction escape, final
  CLI symlink, relative/missing/non-file executables and the non-Windows
  command.
- Scoped runtime tests pass 13/13, aggregate executor tests pass 79/79, scoped
  and root ESLint pass without errors, typecheck passes, and the exact direct
  `node.exe npm-cli.js run build:staging` path passes with npm 11.13.0;
  `git diff --check` also passes.
- The first clean remediation commit
  `4f11374dcb9e0f2174da265bbe66064333f8eb14` received independent
  `CHANGES REQUIRED`: checking only the final regular `npm-cli.js` allowed an
  ancestor `node_modules` junction to escape the adjacent Node directory. The
  follow-up commit `1d49c55295c672505c9812fdfca0897dcea329ba`
  canonicalizes both the current Node executable and
  npm CLI, rejects executable/final symlinks and any real-path or containment
  drift, and adds ancestor-junction, relative, missing and non-file regression
  cases. Independent review of `1d49c552…` confirmed the code/security delta
  and requested only this stale-checkpoint correction. The next gates are a
  fresh independent PASS on the resulting documentation-only HEAD, push and
  exact-head CI. Only then may a new private package with new
  approval/journal/output paths be prepared and separately authorized.

## 2026-09-09 Stage 8 second approved-package safe stop

- The owner authorized independently reviewed private package SHA-256
  `482e428187e26c38036f0ef75ae31c70b0ffe2b9326b5e0652318eb837658391`
  for exact reviewed HEAD `ec50cbf2145c8ae1f719670cf19accac71e979d3`.
  Package/helper integrity, Draft PR 27, exact-head CI run `34318025082`, local
  pins and absent new output paths passed immediately before approval creation.
- The single executor invocation stopped inside the local loopback gate before
  provider loading or journal/recovery creation. No Firebase credential,
  provider preflight, browser, Auth/Firestore mutation, callable scenario,
  verification email or cleanup ran. The approval and `ec50cbf` namespace are
  retained as consumed failed evidence and must not be reused.
- Read-only diagnosis isolated the failure to Vite's byte-identical copy of
  `public/favicon.svg` and `public/icons.svg`: Vite preserves those source
  modification times, while the loopback inventory incorrectly required every
  output file to have a timestamp after build start. The build itself exited
  zero and port 5177 remained free.
- The current gate accepts an older output timestamp only when the file has the
  same relative path and exact working-tree bytes as a regular, non-symlink
  blob in the exact reviewed commit's `public` tree. It derives the complete
  path/blob set with replacement objects disabled for `git ls-tree` and
  `git cat-file`, permits only deterministic
  CRLF/LF checkout conversion for SVG text, and hashes the verified working
  bytes that Vite copies. Ignored or untracked local files cannot become trusted
  inputs. An altered copied file, an untrusted extra stale
  file, a symlink, a stale generated file or post-readiness inventory drift
  remains fail-closed.
- Aggregate executor tests pass 83/83, including new trusted-copy, altered-copy,
  untrusted-extra, ignored-public and Git replacement-object cases. Scoped ESLint, typecheck, `build:staging` and
  `git diff --check` pass. A local actual-build/immutable-server/HTTP-probe
  harness now passes on `http://127.0.0.1:5177` without provider or credential
  access. A clean commit, independent PASS, push and exact-head CI are required
  before another fresh private package can be prepared and separately
  authorized.
