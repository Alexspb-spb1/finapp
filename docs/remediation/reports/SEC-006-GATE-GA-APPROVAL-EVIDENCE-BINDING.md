# FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING — closing the functionsSha256 gap

## Итоговый статус
READY_FOR_REVIEW for the test and Windows verification follow-up. The
secure-executor proof and all eight literal-CLI crash windows passed on a
Windows GitHub Actions runner. The earlier Linux and Windows failures below
remain recorded as diagnostic history; the current result is in the final
Windows addendum. No live staging invocation occurred.

## Branch / commit
- branch: `remediation/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING-winverify` (follow-up on `cdc00449892bb464d18dd5545b5250070be922b1`)
- prior CHANGES_REQUIRED commits: `763642d`, `d1f15bd`, `6194353`, `cbdd7c4`
- base SHA: `execution/sec-006-gate-ga-r9-fix5` @ `e1310e5314f4e6355a0fbd43eab378224044e1f6` — unchanged this round and every round (`git diff` empty, re-verified below)
- verified execution SHA: `d59c9c2de81044115ec871d547827c6a584859d8` (Windows Actions run `36459593483`); this documentation update follows it

This round responds to the audit of `cbdd7c496245750b419df4616442e8aa1ca6a85a`.

---

## Item 1 — the "forged functionsSha256" test proved nothing about the gate; fixed

**Confirmed exactly as raised.** The previous test wrote
`{"functionsSha256": "ffff..."}` as the "approval" — a bare object.
`validateExecutionApproval()`'s own `exactKeys` check rejects any object
missing its ~17 required fields, so that approval was refused **before**
`loadRuntime()`/the functions gate was ever reached. The observed "fast
refusal, no output files" was real, but proved only that the pre-existing,
unmodified schema check works — nothing about this round's gate.

**Fix — a genuinely isolated, differential proof:**
- `buildDemoApprovalPair()` builds a FULL approval via the real
  `buildApprovalDraft()`, for `--profile emulator --project demo-finapp`
  at this checkout's real, dynamically-captured HEAD, using a real,
  schema-matching functions receipt whose `project` field is `demo-finapp`
  (matching the profile under test — the previous round's receipt used
  `finapp-staging`, which would have failed the gate's own project check
  regardless of the hash).
- That valid draft is **independently fed into the real, unmodified
  `validateExecutionApproval()`** as a self-check inside the test itself,
  proving it is genuinely valid *before* anything is tampered with.
- Only then is a second copy built with **exactly one field changed** —
  `functionsSha256` replaced with `'f'.repeat(64)` — so the forged and
  matching runs differ in nothing else. `journalPath`/`outPath` are
  decided once and reused identically in both the draft's
  `commandSha256` binding and the real `--journal`/`--out` arguments
  (a real bug found and fixed while building this: using different
  placeholder vs. real paths breaks `commandSha256`, causing
  `validateExecutionApproval` to reject for an unrelated reason and
  silently reproducing the exact same "proves nothing" flaw one level
  deeper).
- `gateGaSecureExecutor.mjs` now catches its own gate's specific error
  (`approval_evidence_binding_blocked`) and prints a distinguishable
  (but still non-leaky — only the category, never internal validation
  detail) reason: `reason=functions_evidence_gate_refused`. Every other
  failure mode (approval shape, clean-HEAD, missing adapters, receipt
  file problems) still falls through to the same generic
  `reason=local_gate` message `liveAcceptanceExecutor.mjs` itself uses —
  unchanged behavior for everything this round didn't touch.
- **Negative test:** the tampered approval, run for real against
  `gateGaSecureExecutor.mjs`, is refused specifically with
  `functions_evidence_gate_refused`, fast, with neither `--out` nor
  `--journal` ever written.
- **Positive companion test (new, as requested):** the SAME setup with
  the untampered, matching approval is **not** refused by the functions
  gate (asserted by the ABSENCE of that specific reason string) — it goes
  on to fail later, on the real orchestrator's own, unrelated,
  already-safe ground (no `FIRESTORE_EMULATOR_HOST`/
  `FIREBASE_AUTH_EMULATOR_HOST` set for this subprocess) — proving the
  gate specifically let the valid case through rather than being
  vacuously strict.

---

## Item 2 — crash-window still drove the historical entrypoint; adapted

**Confirmed for `gateGaCrashWindowsCliTest.mjs`** — its resume step (the
one genuine literal-CLI subprocess this whole test suite spawns) targeted
`liveAcceptanceExecutor.mjs`, so its 8/8 would never have exercised this
round's gate at all.

**Checked, not assumed, for the other two files the review named:**
`gateGaResumeKillTest.mjs` and `gateGaEmulatorE2E.mjs` were searched
directly (`grep -n "liveAcceptanceExecutor|approvalCommandSha256|--execute"`)
— **zero matches in either file.** Both drive `runOnce()` from
`gateGaEmulatorE2E.mjs` directly, in-process, never through the CLI/
approval mechanism at all, for either their "process 1" or "process 2"
step. Neither file was ever coupled to `liveAcceptanceExecutor.mjs` in
the first place, so neither needed adaptation — confirmed by inspection,
not asserted from memory. `git diff --stat` on both remains empty this
round.

**Fix, scoped to the one file that actually needed it:**
`gateGaCrashWindowsCliTest.mjs`'s `generateApprovalPair()` now builds a
real, complete, `demo-finapp`-consistent functions receipt (same shape a
real `gateGaDeploymentCheck13.mjs` run would produce, using the same
`BASELINE_CALLABLES`/`MEMBER_MANAGEMENT_CALLABLES`/pinned baseline
constants gateGaDeploymentCheck13Core.mjs exports), writes it to a private
file, and binds `functionsSha256` to that file's real hash instead of the
old fabricated fixture string (`sha256('functions-fixture-r7')`). The
resume step's `cliArgs` now target `gateGaSecureExecutor.mjs` with
`--functions-receipt`/`--expected-checker-source-head` added — **no
timeout, deadline, or poll-interval value was changed anywhere in this
file** (30s signal deadline, 15ms poll, 3s kill-confirmation window all
untouched).

---

## Item 3 — correction of the Node diagnosis and Linux verification limit

The previous attempt used Node **22.11.0**. The checked-in
`functions/package-lock.json` pins `jwks-rsa@4.1.0`, whose own `engines.node`
is `^20.19.0 || ^22.12.0 || >=23.0.0`; 22.11.0 is outside that range.
Node 22.12.0 enabled `require(ESM)` by default. Its release note explicitly
states that this removes `ERR_REQUIRE_ESM` for synchronous ESM imports:
https://nodejs.org/en/blog/release/v22.12.0 . The previous statement that
`jwks-rsa`/`jose` necessarily requires a lockfile change, independent of
Node version, was incorrect. Recheck with Node >=22.12 in the Node 22
line before proposing a dependency change.

This Linux follow-up verified official Node 22.12.0 and 22.16.0 archives
against their published SHA-256 sums, but their binaries segfaulted even
on a trivial `node -e` here. That is an execution-host limit; it does not
reproduce the Windows dependency error or prove the package issue is
fixed. A separately downloaded Temurin Java 21 JRE was SHA-256 verified.
With that JRE and host Node 24, Firebase emulators started and loaded the
Functions definitions from this checkout. The eight-scenario test then
failed at `ensurePrivateDirectoryAcl()` with
`gate_ga_private_dir_acl_blocked:unsupported_platform` before any
checkpoint. The Windows ACL safety check was preserved; no timeout or
lockfile was changed. Full 8/8 verification still requires the original
Windows environment with Node >=22.12 and Java 21.

The real-file secure-executor test has now been made independent of the
parent process's `FIRESTORE_EMULATOR_HOST` and
`FIREBASE_AUTH_EMULATOR_HOST`. It passed 9/9 both normally and with both
host variables deliberately set to bogus loopback endpoints in the parent.
Its child process cannot reach the emulator on the positive path.

---

## Item 4 — report language: "no live staging call" vs. "a local subprocess did call --execute --profile emulator"

**Corrected distinction, stated explicitly:** no `--execute` was ever run
against real `finapp-staging` this round or any prior round — that
remains true. But this round's own tests **did** call
`gateGaSecureExecutor.mjs --execute --profile emulator ...` for real, as
real child processes, multiple times (item 1's positive/negative pair,
plus the earlier `--help`/missing-flags tests) — that is not "no
`--execute` at all," and this report does not claim it is. The distinction
that matters is `--profile emulator` (which, even under a gate
regression, can only reach a nonexistent local emulator host) vs.
`--profile staging` against the real project — never the latter, this
round or any prior one.

**`liveAcceptanceExecutor.mjs` bypass — restated as an open limitation of
the chosen entrypoint, not a closed path:** anyone who runs
`liveAcceptanceExecutor.mjs --execute` directly, instead of
`gateGaSecureExecutor.mjs`, is still protected only by
`validateExecutionApproval()`'s format-only check — exactly as before.
This is not "globally closed except for one file"; it is that **this
round's fix lives entirely in a new, parallel, opt-in entrypoint**, and
the security property it provides holds only for callers who use that
entrypoint. Item 2's adaptation of `gateGaCrashWindowsCliTest.mjs` is one
concrete instance of choosing to use the gated entrypoint where it
matters; it does not remove the old entrypoint or prevent its direct use
elsewhere.

---

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| `npm run typecheck` | PASS | |
| `npm run lint` | PASS | 1 pre-existing unrelated warning |
| `node --test scripts/invitationRehearsal/gateGaApprovalEvidenceBindingSelfTest.mjs` | PASS 35/35 | unaffected by this round's changes |
| `node scripts/invitationRehearsal/gateGaApprovalEvidenceBindingMutationChecks.mjs` | PASS 14/14 DETECTED | |
| `node --test scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs` | PASS 9/9 twice | on the clean local commit, once with bogus parent emulator hosts |
| `node --test scripts/invitationRehearsal/deploymentCheckSelfTest.mjs` (unchanged) | PASS 19/19 | |
| `gateGaCrashWindowsCliTest.mjs` (8 scenarios via secure CLI) | **FAIL 0/8 on Linux** | every scenario stops before its checkpoint on `gate_ga_private_dir_acl_blocked:unsupported_platform`; must run on Windows |
| `npm run test:unit` / `functions npm run test:unit` | PASS 248/248 / 354/354 | |
| `npm run test:rules` (Firestore emulator, Java 21) | PASS 126/126 | |
| root/functions build and typecheck/lint | PASS | one existing root lint warning, one build chunk-size warning |
| `gateGaResumeKillTest.mjs` / standalone E2E | **NOT VERIFIED here** | neither uses the CLI/approval path; Windows ACL check also applies |

## Фактический вывод существенных тестов

```text
✔ REAL FILE: ... forged functionsSha256 ... is refused specifically by the functions gate — fast, with no output files
✔ REAL FILE: ... genuinely matching functionsSha256 ... is NOT refused by the functions gate
```
(full 9/9 `gateGaSecureExecutorSelfTest.mjs` output verified against this
round's final, clean, committed HEAD — see the commit's own CI/local run)

```text
DETECTED M10 explicit ownerConfirmsApproval requirement removed {"exitCode":1,"fail":2}
DETECTED M11 explicit reviewStatus/ciStatus requirement removed {"exitCode":1,"fail":2}
DETECTED M12 APPROVAL_TTL_MS silently drifted from the reviewed executor's real constant {"exitCode":1,"fail":4}

SUMMARY total=14 detected=14 undetected=0
```

Previous Windows attempt, now correctly attributed to Node 22.11.0:
```text
functions: Using node@22 from host.
Error [ERR_REQUIRE_ESM]: require() of ES Module .../functions/node_modules/jose/dist/webapi/index.js
from .../functions/node_modules/jwks-rsa/src/utils.js not supported.
```

Linux follow-up's actual crash-window output:
```text
functions: Loaded functions definitions from source: authzProbe, createCompany, inviteMember, ...
Error: gate_ga_private_dir_acl_blocked:unsupported_platform
SUMMARY total=8 pass=0 fail=8
```

---

## Executable playbook (unchanged in shape from the prior round; not run — no mailbox lookup or invitation requested)

Same one-checkout, one-HEAD sequence as before (mailbox discovery → auth
metadata discovery → `gateGaDeploymentCheck13.mjs` → `gateGaBuildApprovalDraft.mjs`
→ `gateGaSecureExecutor.mjs --execute`), now additionally proven end to
end by item 1's real differential test. **No mailbox lookup or
invitation is being requested in this message.**

## Security review
- No `--execute` against real `finapp-staging` this round or any round.
- This round's own real subprocess calls to `--execute --profile emulator`
  are disclosed explicitly (item 4), not conflated with a staging call.
- No software was installed system-wide; portable Node 22 and Java 21
  archives were downloaded into local scratch and SHA-256 verified.
- No secrets/tokens in this report or code.

## Данные и миграция
Нет.

## Известные ограничения
- Item 3: crash-window/resume-kill/E2E regression remains unverified on
  the target Windows environment. This Linux runner cannot pass the
  intentional Windows ACL check. The previous dependency diagnosis was
  invalid because Node 22.11.0 was below `jwks-rsa`'s minimum engine.
- `liveAcceptanceExecutor.mjs` remains a usable, ungated bypass of this
  round's functions-evidence gate (item 4) — a stated property of adding
  a new opt-in entrypoint, not a defect to be silently assumed closed.

## Diff summary
```text
 Follow-up relative to cdc00449:
 docs/remediation/reports/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING.md | correct Node diagnosis and verification status
 scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs           | remove inherited emulator hosts in subprocess
```

## Windows verification addendum — 2026-09-28

The Linux result and the earlier `NOT VERIFIED` entries above describe the
previous follow-up and are superseded for the eight-scenario crash-window
suite by [Windows Actions run 36459593483](https://github.com/Alexspb-spb1/finapp/actions/runs/36459593483)
against `d59c9c2de81044115ec871d547827c6a584859d8`.

The first hosted Windows run could not load `Get-Acl` in its nested Windows
PowerShell process; the workflow now uses Windows PowerShell and verifies
that nested ACL call first. The next run reached the literal resume CLI but
stopped at its local gate. Independent fixture checks proved private paths,
approval, HEAD and the 13-function receipt valid. A byte-level preflight
then found **19 SHA mismatches**: Git's Windows checkout had converted the
reviewed LF source bytes to CRLF. The runtime's package-integrity refusal
was correct. The workflow now sets `core.autocrlf=false` **before checkout**
and verifies all manifest entries before starting emulators. No security
gate, timeout, lockfile or production code was changed to obtain a pass.

On the final execution SHA, the package-byte check, 9/9 secure-executor
self-tests, Functions build, nested ACL preflight and the emulator suite
all succeeded. The eight literal secure-CLI resume scenarios reported
`SUMMARY total=8 pass=8 fail=0` and `GATE_GA_CRASH_WINDOWS PASS`.
Every scenario reported `cleanupStatus=CLEANUP_COMPLETE_VERIFIED` and
`remainder=0`; the three email windows counted at most one journaled send.

The additional preflight in `gateGaCrashWindowsCliTest.mjs` now identifies
fixture errors by gate before the separate CLI process starts, without
changing that CLI's generic public error. The standalone resume-kill/E2E
suites were not rerun in this Windows job; they do not enter via the secure
CLI and were unchanged. The current package needs independent review before
the existing owner playbook is considered for a real staging run. PR #28
and `main` were not changed; no staging or production call was made.
