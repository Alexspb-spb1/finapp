# Execution checkpoint

Updated: 2026-09-06. Status: IN_PROGRESS — SEC-006 Stage 7.

- Scope: stabilization stages 0–8; stage9 excluded. Owner authorized engineering,
  separate agents/review and protected merges. External actions require a
  concrete approved package under handoff section8. SEC-005 is complete: never
  repeat its production backfill, imports or maintenance operations.
- Worktree: D:/projects/finapp/finapp-sec006-stage7.
- Branch: remediation/SEC-006-stage-7-acceptance.
- Base/main: 82934d2acfaaab79c6092cdbd67cd95e4189d645.
- Stage6: PR25 merged with expected HEAD protection on
  6ed66efca3520ac55007078cc5c11f92d3c7d28a after independent PASS.
  Merge tree equals reviewed tree eed358216feeeb1ee84788d04bba1e361dc71a23.
  Main CI success: https://github.com/Alexspb-spb1/finapp/actions/runs/34025262542.
  Pages success: https://github.com/Alexspb-spb1/finapp/actions/runs/34025377206.
  Static artifact ID9986884092 and live HTML/JS/CSS SHA256 match; fresh public
  login rendered without page errors, Auth/data actions=0. This verifies static
  publication only, not live invitations or production multi-user readiness.
- Owner's latest `да` authorized the Stage6 Pages package; it has been executed.
  It does not authorize Stage7 Functions/Pages or real verification emails.
- Preserved artifacts: D:/projects/finapp/.runtime/pages-ff0ed16/artifact.tar
  (SHA256 47d1cbb24098b35850a4b600c1b4f86125179f0ae57dab284d2c69225f079486)
  and D:/projects/finapp/.runtime/pages-82934d2/. Rollback window remains open.
- Stage7 implementation: import-free fragment bootstrap; actual Pages 404 entry;
  isolated invite Auth/preview/verification/acceptance; fresh canonical server
  access check; fail-closed bridge readback before financial module import.
  New getCompanyAccess callable is needed because current Rules deny member
  reads and authzProbe is admin-only. Existing invitation callables/Rules intact.
- Local checks: 248 frontend tests; 344 Functions unit; 224 Functions emulator;
  Rules126/migration570/preflight5; lint/typecheck/build and Rules TypeScript PASS.
  Full browser acceptance passed, including forced-document logout/re-login.
  Independent review found the re-login defect before commit; fixed and verified.
  Final exact-commit independent PASS and PR CI are pending.
- Next: complete emulator/browser scenarios, independent exact-commit review,
  PR checks and Stage7 release preparation. Do not merge until separately
  authorized publication package is ready and approved (merge triggers Pages).
- SEC006 remains OPEN. Stage8 complete rehearsal, actual email and live release
  checks remain. SEC008/009/STATE001 general legacy Auth/state weaknesses are
  not closed by this narrowly isolated invitation-entry path.

Resume: inspect actual diff, GitHub and current checkpoint. Do not replay past
external operations. Local emulators/Vite are temporary; verify ports before use.
