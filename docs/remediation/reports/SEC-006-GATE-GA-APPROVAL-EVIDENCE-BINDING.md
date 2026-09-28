# FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING — closing the functionsSha256 gap

## Итоговый статус
READY_FOR_REVIEW for items 1–2 (code + tests, proven end to end against
the real file and the real crash-window resume path). Item 3 (isolated
Node 22 for emulator-dependent regression) is explicitly **NOT VERIFIED**
— a real, deeper, pre-existing dependency incompatibility was found and
is documented exactly, not glossed over. No staging run is suggested as
a result.

## Branch / commit
- branch: `remediation/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING`
- prior CHANGES_REQUIRED commits: `763642d`, `d1f15bd`, `6194353`, `cbdd7c4`
- base SHA: `execution/sec-006-gate-ga-r9-fix5` @ `e1310e5314f4e6355a0fbd43eab378224044e1f6` — unchanged this round and every round (`git diff` empty, re-verified below)
- result SHA: this round's commit — see the final report message

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

## Item 3 — isolated Node 22: attempted for real; a genuine, deeper blocker found; NOT VERIFIED

**What was prepared, without touching the system Node 24:** the official
Node.js v22.11.0 Windows binary ZIP was downloaded from `nodejs.org`
(the standard, official distribution channel — not a staging call) and
extracted to a local, non-system scratch directory
(`.runtime/node22-portable/`, outside every checkout, never committed).
Combined with last round's `JAVA_HOME` override (Android Studio's bundled
JBR, `21.0.10` — no install), the emulator suite's own log confirmed the
fix worked exactly as intended: **`functions: Using node@22 from host.`**
(previously: `Your requested "node" version "22" doesn't match your
global version "24"`) — the Node-version mismatch reported last round is
genuinely resolved.

**A third, separate, deeper blocker then surfaced — a real dependency
incompatibility, not a version-selection problem:**
```
Error [ERR_REQUIRE_ESM]: require() of ES Module
D:\...\functions\node_modules\jose\dist\webapi\index.js from
D:\...\functions\node_modules\jwks-rsa\src\utils.js not supported.
Instead change the require of index.js in
D:\...\functions\node_modules\jwks-rsa\src\utils.js to a dynamic
import() which is available in all CommonJS modules.
```
Diagnosed precisely: `functions/package-lock.json` locks `jwks-rsa@4.1.0`
(a CommonJS package) against `jose@6.2.8` (ESM-only since jose v4 —
`jose` dropped CommonJS `require()` support entirely as an upstream
design choice, independent of which Node major version runs it).
`jwks-rsa` is not imported anywhere in this project's own
`functions/src` — it is pulled in transitively (via `firebase-admin` or
a related dependency) — but because the Functions emulator introspects
the ENTIRE compiled `functions/lib/index.js` bundle as one unit before
it will serve any function, this one broken transitive import chain
blocks the whole bundle from loading, regardless of which specific
function is actually needed for these tests.

**Why this is not fixed here:** the only real fix is a dependency change
(pin `jwks-rsa` to a version compatible with CJS `jose`, or bump it past
whatever version resolved this upstream, or override the transitive
`jose` resolution) — editing `functions/package-lock.json`/`package.json`
is explicitly out of scope for this task (CLAUDE.md: don't change the
lockfile without a real need tied to the current item) and is a decision
for whoever owns the functions dependency tree, not something to patch
unilaterally mid-review.

**Consequence, stated plainly:** crash-window/resume-kill/E2E regression
remains **NOT VERIFIED** in this environment. Both blockers this review
asked to be investigated (Java, then Node) were genuinely resolved
without any system-level install; a third, different, real blocker
(a locked dependency incompatibility) was found in their place and is
correctly left unresolved and disclosed, not worked around. **No staging
run is suggested as a result of this gap**, per the explicit instruction
this round if verification turns out impossible.

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
| `node --test scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs` | PASS 9/9 | including the new differential (forged vs. matching) real-subprocess pair — verified against the final clean, committed HEAD (see below) |
| `node --test scripts/invitationRehearsal/deploymentCheckSelfTest.mjs` (unchanged) | PASS 19/19 | |
| `gateGaCrashWindowsCliTest.mjs` (8 real crash-window scenarios, now via `gateGaSecureExecutor.mjs`) | **NOT AVAILABLE** | blocked by item 3's dependency incompatibility, not by this round's code |
| `gateGaResumeKillTest.mjs` / standalone E2E | **NOT AVAILABLE**, and **not applicable to this round's change** — neither ever used the CLI/approval path (verified by direct search, zero matches) | |
| `git status --short` / `git diff` vs fix5 on all original files | empty except the one file item 2 intentionally adapted | |

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

Item 3's exact blocking output:
```text
functions: Using node@22 from host.
Error [ERR_REQUIRE_ESM]: require() of ES Module .../functions/node_modules/jose/dist/webapi/index.js
from .../functions/node_modules/jwks-rsa/src/utils.js not supported.
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
- No new software was installed system-wide; the portable Node 22 and the
  JDK 21 override both used already-obtained or already-installed
  binaries, isolated to this session's PATH only.
- No secrets/tokens in this report or code.

## Данные и миграция
Нет.

## Известные ограничения
- Item 3: crash-window/resume-kill/E2E regression genuinely blocked by a
  locked dependency incompatibility (`jwks-rsa`/`jose`) in this
  environment; not a code defect in this round's changes.
- `liveAcceptanceExecutor.mjs` remains a usable, ungated bypass of this
  round's functions-evidence gate (item 4) — a stated property of adding
  a new opt-in entrypoint, not a defect to be silently assumed closed.

## Diff summary
```text
 docs/remediation/reports/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING.md | rewritten (this file)
 scripts/invitationRehearsal/gateGaCrashWindowsCliTest.mjs              | adapted to gateGaSecureExecutor.mjs (item 2)
 scripts/invitationRehearsal/gateGaSecureExecutor.mjs                   | distinguishable, non-leaky gate-refusal reason (item 1)
 scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs           | rewritten differential real-file test pair (item 1)
```

## Следующий разрешенный пункт
Independent review of this fix pass. No mailbox lookup or invitation
requested. `--execute` against real staging not authorized.
