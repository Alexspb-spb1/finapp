# FINAPP-1.0-SEC-006-GATE-G-A-DEPLOYMENT-CHECK-13FN — staging 13-function deployment check

## Итоговый статус
READY_FOR_REVIEW

## Branch / commit
- branch: `remediation/SEC-006-GATE-GA-DEPLOYMENT-CHECK-13FN`
- base SHA: `e1310e5314f4e6355a0fbd43eab378224044e1f6` (`execution/sec-006-gate-ga-r9-fix5`)
- result SHA: see commit created by this report's accompanying push

## Проверенное исходное состояние

- Real, read-only inventory of `finapp-staging` (gathered in the preceding SAFE_STOP round)
  found 13 deployed `ACTIVE` Gen2 functions, not the 8
  `deploymentCheckCore.mjs`'s postflight mode was built to attest: the 8
  SEC-006 invitation functions plus 5 SEC-007/M1 member-management functions
  (`removeMember`, `changeMemberRole`, `disableMember`, `listCompanyMembers`,
  `restoreMember`), confirmed by the owner as expected under the previously
  agreed plan — not an incident.
- `deploymentCheckCore.mjs`'s exact-eight postflight check correctly refuses
  to attest this 13-function state (`v2.length !== CALLABLES.length` blocks).
  This is by design and was **not** modified.
- Located a real prior baseline receipt for the 8 SEC-006 functions:
  `.runtime/stage8-deployment-postflight-ab1bd67.json`. Its provenance was
  independently verified, not merely assumed from its existence:
  - `sourceHead` (`ab1bd670ad04debd081af542e367c5dfc95e55ab`) is a real,
    reachable commit: `git cat-file -t` returns `commit`, and
    `git merge-base --is-ancestor ab1bd670... HEAD` exits 0 (an ancestor of
    `main` on `remediation/SEC-006-stage-8-rehearsal`).
  - The file's own SHA-256 (`db0c2508ff2595a6be62ebd91ea784bcdda7fbd09f62353ddf406c9e3c3592a5`)
    matches exactly the value recorded in `docs/remediation/reports/SEC-006.md`'s
    "Approved staging backend deployment completed — 2026-09-08" entry,
    written at the time of that real deployment — independent, pre-existing
    corroboration, not a hash computed and trusted after the fact.
- Confirmed from local code (no live network needed) that the 5 M1
  functions share the exact same declared resource shape as the 8 baseline
  functions: `functions/src/index.ts` on
  `origin/remediation/SEC-007-member-management-functions` @ `8526a79` calls
  `setGlobalOptions({ region: 'us-central1', memory: '256MiB', cpu: 1,
  concurrency: 1, minInstances: 0, maxInstances: 1, timeoutSeconds: 60 })`
  once at module scope, applying identically to every `onCall(...)` in the
  file — both families. `functions/package.json`'s `engines.node` is `22`
  for both. No M1-specific resource limits exist to diverge from.

## Что изменено

- Added `scripts/invitationRehearsal/gateGaDeploymentCheck13Core.mjs`: a
  new, additive, separately-identifiable check
  (`status: 'DEPLOYMENT_METADATA_VERIFIED_13FN'`, distinct from the
  original `'DEPLOYMENT_METADATA_VERIFIED'`) for the real 13-function
  staging state. Reuses `deploymentCheckCore.mjs`'s `CALLABLES`, `REGION`,
  `URLS`, `FIELDS`, `deploymentTransport`, `metadataRequestOptions`,
  `requestSpec`, `checkFunction` unmodified. Validates:
  1. Baseline-receipt provenance (`validateBaselineReceiptProvenance`) —
     pinned SHA-256 of the receipt's raw bytes, pinned `sourceHead`, and a
     caller-supplied `commitIsReachable` boolean (a real `git merge-base
     --is-ancestor` result, computed by the CLI wrapper, never fabricated)
     — all before a single field of the receipt is trusted.
  2. The 8 baseline functions with the existing `checkFunction()` shape
     check, plus a field-by-field diff (`revision`/`build`/
     `sourceReferenceSha256`/`sourceProvenanceSha256`) against the
     provenance-validated receipt — any drift blocks.
  3. The 5 M1 functions with a new, parallel `checkMemberManagementFunction`
     (same resource-limit shape as `checkFunction`, parameterized by
     `MEMBER_MANAGEMENT_CALLABLES` instead of the baseline `CALLABLES`, so
     the two name sets can never be silently merged).
  4. Exactly the union of both name sets (13) present — no missing, no
     duplicate, no unexpected function.
- Added `scripts/invitationRehearsal/gateGaDeploymentCheck13SelfTest.mjs`
  (22 tests: positive end-to-end pass; missing-baseline; missing-M1; 14th
  unexpected function; 13-total-with-foreign-name; 14-total-with-duplicate;
  13-total-with-internal-duplicate; baseline revision drift; baseline
  source drift; M1 wrong resource shape; M1 wrong runtime; M1 wrong state;
  tampered receipt bytes; unreachable commit; wrong pinned `sourceHead`;
  receipt-level duplicate; receipt-level 9-entries-with-duplicate;
  receipt-level missing-one; the **real, checked-in** baseline fixture's
  provenance genuinely matching its pinned production values; the real
  fixture refused when reported unreachable; `checkMemberManagementFunction`
  name-set isolation; git/env guard coverage).
- Added `scripts/invitationRehearsal/gateGaDeploymentCheck13MutationChecks.mjs`
  (9 mutations, all `DETECTED`, each proven independently necessary — see
  below for the iterative process that removed two genuinely redundant
  per-item checks so every remaining line is provably load-bearing).
- Added `scripts/invitationRehearsal/gateGaDeploymentCheck13.mjs`: the real
  CLI wrapper (mirrors `deploymentCheck.mjs`'s structure, adds
  `--baseline-receipt`, computes `commitIsReachable` via a real local `git
  merge-base --is-ancestor` before any network/credential access). **Not
  invoked against live staging this round** — only its `--help` and
  `--self-test` paths (neither touches network/credentials) were run, per
  the explicitly scoped instruction that fresh staging metadata may only be
  checked through this path after independent review.
- Added `scripts/invitationRehearsal/testFixtures/stage8-deployment-postflight-ab1bd67.json`:
  a byte-for-byte checked-in copy of the real baseline receipt (verified
  identical SHA-256 after copy), so the self-test can prove the pinned
  production provenance constants genuinely correspond to real, previously
  reviewed evidence — not just internally self-consistent test fixtures.
- Added two npm scripts:
  `test:invitation-gate-ga-deployment-check-13fn`,
  `test:invitation-gate-ga-deployment-check-13fn-mutations`.
- Added `docs/remediation/reports/SEC-006-GATE-GA-DEPLOYMENT-CHECK-13FN.md`
  (this report).

### A design correction made during this round

The first draft of the new module had two per-item checks
(`seen.has(shortName)` in the main function-list loop,
`byName.has(shortName)` in the receipt-provenance loop) intended to reject
duplicate function names. The first full mutation run showed both were
**provably redundant**: each loop already has a post-loop uniqueness count
check (`seen.size !== ALL_CALLABLES.length`, `byName.size !==
BASELINE_CALLABLES.length`) that independently catches every duplicate
scenario the per-item checks were meant to catch, given the surrounding
length/name-validity checks. Verified this concretely (not just by
argument): manually built each mutant in isolation and reran the specific
test — both times the test still correctly rejected via the other check.
Removed both per-item checks as dead weight, added two new test scenarios
that isolate exactly what the post-loop checks (and the sibling
length-based checks) each independently prove, and re-ran the full
mutation suite: **9/9 detected, zero redundant/unprovable lines remaining.**

## Почему изменения входят в текущий пункт

Scoped exactly to what was asked: open a new, narrow TASK_ID for the
staging 13-function verification; preserve the exact-eight check
untouched; add a separately identifiable 13-function check; validate the 8
baseline functions against the provenance-validated receipt and the 5
named M1 functions against their real, code-derived resource limits;
reject missing/duplicate/additional functions; add positive, negative and
mutation tests. No live network call was made against staging this round.

## Затронутые файлы

- `scripts/invitationRehearsal/gateGaDeploymentCheck13Core.mjs` (new)
- `scripts/invitationRehearsal/gateGaDeploymentCheck13SelfTest.mjs` (new)
- `scripts/invitationRehearsal/gateGaDeploymentCheck13MutationChecks.mjs` (new)
- `scripts/invitationRehearsal/gateGaDeploymentCheck13.mjs` (new, unexecuted against live network)
- `scripts/invitationRehearsal/testFixtures/stage8-deployment-postflight-ab1bd67.json` (new, checked-in copy of real evidence)
- `package.json` (2 new npm scripts, additive only)
- `docs/remediation/reports/SEC-006-GATE-GA-DEPLOYMENT-CHECK-13FN.md` (new)
- `deploymentCheckCore.mjs`, `deploymentCheckSelfTest.mjs`: **unmodified** — `git diff --stat` against both is empty.

## Критерии приемки

- [x] New TASK_ID opened, separate from fix5; fix5 commit/package unchanged.
- [x] Exact-eight Stage 8 check and its self-test preserved untouched (verified via empty `git diff`).
- [x] Separately identifiable 13-function check added (distinct status string, distinct module).
- [x] Baseline receipt's provenance/integrity validated before trust (pinned SHA-256 + pinned, independently-git-verified `sourceHead`) — existence alone is not treated as proof.
- [x] The 8 baseline functions compared against the receipt's revision/build/source fingerprints.
- [x] The 5 named M1 functions validated against their real (code-derived) resource limits.
- [x] Missing, duplicate or additional functions rejected.
- [x] Positive, negative and mutation tests added; all mutations independently proven necessary (9/9 detected).
- [x] Submitted for independent review (this report + pushed branch).
- [ ] Live staging verification via the new check — deliberately NOT done this round; requires independent review first, per scope.

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| `npm run typecheck` | PASS | |
| `npm run lint` | PASS | 1 pre-existing unrelated warning (`src/pages/Balance.tsx`) |
| `node --test scripts/invitationRehearsal/gateGaDeploymentCheck13SelfTest.mjs` | PASS 22/22 | |
| `node scripts/invitationRehearsal/gateGaDeploymentCheck13MutationChecks.mjs` | PASS 9/9 DETECTED | |
| `node --test scripts/invitationRehearsal/deploymentCheckSelfTest.mjs` (existing, untouched) | PASS 19/19 | proves the exact-eight check is unaffected |
| `node scripts/invitationRehearsal/gateGaDeploymentCheck13.mjs --self-test` | PASS 22/22 | no network/credentials touched |
| `node scripts/invitationRehearsal/gateGaDeploymentCheck13.mjs --help` | OK | no network/credentials touched |
| `git status --short` on `deploymentCheckCore.mjs`/`deploymentCheckSelfTest.mjs` | empty | exact-eight check provably untouched |
| Broader existing suite (mutations/orchestrator/staging-adapters/private-dir-acl/durable-journal/run-manifest/recipient/negatives/email-verification) | PASS | see note below on 2 unrelated pre-existing failures |

### Note on 2 unrelated failures observed during the broader regression sweep

`test:invitation-gate-ga-mutations` and `test:invitation-gate-ga-orchestrator-mutations`
crashed in this clone with `mutation anchor not found` against
`liveAcceptanceRunIdCore.mjs` — a file this task never touched. Diagnosed as
a **local checkout artifact, not a real regression**: this clone's working
tree has `core.autocrlf=true`-converted CRLF line endings for that specific
file (`file` reports "with CRLF line terminators"), while the actual
committed git blob (`git show HEAD:...`) has pure LF — `git status --short`
on the file is empty, confirming git itself sees no content change. The
sibling `gate-ga-r9f5-execution-clone` (built by direct file copy rather
than a plain `git checkout`) does not exhibit this, and passes the same
suite cleanly (12/12). Not fixed here: the file is unrelated to this task's
scope, and the "fix" would just be re-running mutation checks from a
clone whose checkout didn't apply CRLF conversion — an environment
detail, not a code defect.

## Фактический вывод существенных тестов

```text
DETECTED M1 exact-13-function-count check removed {"exitCode":1,"fail":1}
DETECTED M2 baseline revision/build/source drift diff against the receipt removed {"exitCode":1,"fail":2}
DETECTED M3 baseline receipt SHA-256 provenance pin check removed {"exitCode":1,"fail":1}
DETECTED M4 receipt sourceHead git-reachability check removed {"exitCode":1,"fail":2}
DETECTED M5 post-loop unique-name-count check removed (misses a same-count internal duplicate) {"exitCode":1,"fail":1}
DETECTED M9 receipt post-loop unique-name-count check removed (misses a same-count internal duplicate) {"exitCode":1,"fail":1}
DETECTED M6 checkMemberManagementFunction allowlist swapped to the baseline set {"exitCode":1,"fail":2}
DETECTED M7 receipt exact-eight function-count structural check removed {"exitCode":1,"fail":1}
DETECTED M8 member-management resource-limit shape validation removed {"exitCode":1,"fail":1}

SUMMARY total=9 detected=9 undetected=0
```

## Security review

- No live network call was made against `finapp-staging` in this round;
  all self-tests and mutation checks run against local, DI-injected
  fixtures or the checked-in real-evidence fixture file.
- The CLI wrapper (`gateGaDeploymentCheck13.mjs`) computes
  `commitIsReachable` via a real local `git merge-base --is-ancestor`
  before any credential/network access, and is guarded by the same
  `guard()`/environment checks (`inventoryCore.mjs`) used throughout this
  codebase (rejects emulator hosts, debug flags, foreign projects, dirty
  worktrees, mismatched HEAD) before ever reaching `authorize()`.
- No secrets, tokens, real GCS bucket/object paths, or service-account
  data appear in the new module, tests, or fixture — the checked-in
  fixture is the same class of information already public in
  `docs/remediation/reports/SEC-006.md`'s prose (function names,
  revisions, build IDs, source hashes — no credentials).
- Fail-closed by construction throughout: any malformed/ambiguous input
  blocks rather than defaulting to a pass.

## Данные и миграция

Нет. No data was created, modified, or deleted; no migration; no cleanup.

## Ручная проверка

Not applicable — this is a metadata-check module with no UI surface. Its
own DI-based self-test and mutation suite constitute the verification.

## Rollback

Delete the 4 new files, the 2 new npm script lines, the new
`testFixtures/` directory, and this report; or simply do not merge the
branch. Nothing external was touched, so no rollback action beyond git is
needed.

## Известные ограничения

- The 5 M1 functions have no prior-baseline drift check yet (by design —
  no receipt existed for them before this round); only their shape is
  validated. A future round could capture a first M1 baseline receipt
  once this gate is reviewed and run for real.
- The new CLI wrapper has not been exercised against real `finapp-staging`
  data yet — only unit/DI-tested. Its first real invocation is explicitly
  deferred to after independent review, per this round's scope.

## Дополнительные находки вне scope

- The 2 pre-existing CRLF-checkout artifacts noted above (unrelated file,
  unrelated to this task, not a real content change per git itself).

## Diff summary

```text
 docs/remediation/reports/SEC-006-GATE-GA-DEPLOYMENT-CHECK-13FN.md | new file
 package.json                                                      |   2 ++
 scripts/invitationRehearsal/gateGaDeploymentCheck13.mjs            | new file
 scripts/invitationRehearsal/gateGaDeploymentCheck13Core.mjs        | new file
 scripts/invitationRehearsal/gateGaDeploymentCheck13MutationChecks.mjs | new file
 scripts/invitationRehearsal/gateGaDeploymentCheck13SelfTest.mjs    | new file
 scripts/invitationRehearsal/testFixtures/stage8-deployment-postflight-ab1bd67.json | new file
```

## Следующий разрешенный пункт

Independent review of this TASK_ID's delivery. Do not start R10 or any
further gate-G-A round, and do not run the new CLI wrapper against live
staging, until that review returns PASS.
