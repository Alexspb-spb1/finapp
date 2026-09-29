# FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING — closing the functionsSha256 gap

## Итоговый статус
READY_FOR_REVIEW for items 1–2 (code + tests, proven end to end against
the real file). Item 3's Node-version/require(esm) blocker is now
genuinely **RESOLVED** (see Item 5) — but resolving it exposed a
**separate, real, pre-existing, out-of-scope defect** in the already-
reviewed `gateGaStagingRuntime.mjs` (inherited unchanged from
`execution/sec-006-gate-ga-r9-fix5`, confirmed byte-identical): its
package-integrity check compares LF-pinned expected hashes
(`CODE-SHA256SUMS.txt`) against CRLF on-disk file bytes on this Windows
checkout (`core.autocrlf=true`), so it fails for every listed file,
unconditionally, on the first real `run()` this checkout has ever
executed. This blocks the crash-window regression (and, by the same
mechanism, would block ANY real `--execute` on this machine — fresh or
resume) and is explicitly **not fixed in this branch**: the affected file
is outside this task's scope and the fix requires an owner decision (see
Item 5). No staging run is suggested as a result.

## Branch / commit
- branch: `remediation/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING`
- prior CHANGES_REQUIRED commits: `763642d`, `d1f15bd`, `6194353`, `cbdd7c4`, `cdc0044`
- base SHA: `execution/sec-006-gate-ga-r9-fix5` @ `e1310e5314f4e6355a0fbd43eab378224044e1f6` — unchanged this round and every round (`git diff` empty, re-verified below)
- result SHA: `d24d05c528ba0f3879011f8ac62c7ab555beb1b2`

This round responds to the audit of `cbdd7c496245750b419df4616442e8aa1ca6a85a` (items 1–4, closed in `cdc0044`) and a follow-up instruction to obtain an isolated Node ≥22.12.0, strip emulator-host env vars from the positive subprocess test, and run the secure-CLI tests plus all 8 crash-window scenarios on the clean final commit (see Item 5).

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

## Item 5 — this round: isolated Node 22.23.3, env-stripping fix, and a newly-diagnosed (but out-of-scope) package-integrity/CRLF blocker

**Instruction this round:** obtain an isolated Node ≥22.12.0 (22.x
branch), explicitly strip `FIRESTORE_EMULATOR_HOST`/
`FIREBASE_AUTH_EMULATOR_HOST` from the positive subprocess test's own
environment instead of inheriting the ambient shell, then on the clean
final commit run the secure-CLI self-tests and all 8 crash-window
scenarios with unchanged timeouts; if a new failure appears, diagnose it
with its exact output rather than re-reporting NOT VERIFIED blind.

**1. Isolated Node upgraded to v22.23.3 (well above the 22.12.0 floor).**
Downloaded the official `nodejs.org` Windows ZIP to
`.runtime/node22-portable/` (outside every checkout, never committed, no
system-wide change). Confirmed via the emulator's own log:
`functions: Using node@22 from host.`

**2. `require(esm)` genuinely fixes the previously-reported jose/jwks-rsa
blocker.** Under the prior Node 22.11.0, loading the compiled functions
bundle threw a synchronous `ERR_REQUIRE_ESM`. Under 22.23.3, a direct,
isolated load of the exact same bundle —
```
node.exe -e "require('./functions/lib/index.js'); console.log('LOADED_OK')"
```
— completed instantly with `LOADED_OK`, and a direct run of the real
HTTP-discovery entrypoint (`firebase-functions/lib/bin/firebase-functions.js`,
bypassing firebase-tools' wrapper) produced the full, correct 9-function
manifest in under a second. This is now genuinely resolved, not
worked around.

**3. One transient, non-reproducing failure during diagnosis.** The
first live emulator start after the Node upgrade hit
`Cannot determine backend specification. Timeout after 10000` — a
different, generic symptom from the old ESM error. Per this round's
explicit instruction, this was investigated rather than re-reported
blind: a direct synchronous `require()` of the bundle succeeded
instantly (above), ruling out a load-time throw; a second, otherwise
identical emulator start (`--debug`) succeeded in under 1 second
(`Got response from /__/functions.yaml`, all 9 functions loaded). This
was a one-time cold-start delay on the freshly-extracted portable
binary, not a reproducible defect — it did not recur on retry and is not
the same failure as item 3's original ESM error.

**4. Secure-CLI self-tests: PASS 9/9 on the final clean, committed HEAD
(`d24d05c528ba0f3879011f8ac62c7ab555beb1b2`), with a live emulator
(`firebase emulators:exec --only auth,firestore,functions,extensions
"node --test scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs"`).**
Includes the env-stripping fix itself: `runRealExecute()` in
`gateGaSecureExecutorSelfTest.mjs` now explicitly `delete`s
`FIRESTORE_EMULATOR_HOST`/`FIREBASE_AUTH_EMULATOR_HOST` from the
subprocess environment rather than inheriting whatever the ambient shell
happens to have set, so the "gate passes, then fails on missing
emulator-host env" assertion holds deterministically.

**5. All 8 crash-window scenarios: FAIL 0/8 — a real, new, precisely
diagnosed, but out-of-scope defect, not a code regression in this
branch.** Run via `firebase emulators:exec --only
auth,firestore,functions,extensions "node
scripts/invitationRehearsal/gateGaCrashWindowsCliTest.mjs"` against the
same clean HEAD. Every scenario's literal-CLI resume step failed at the
generic `reason=local_gate` catch. Diagnosis (a temporary, local-only
debug commit printing `error.stack` was used to see the real cause, then
discarded via `git reset --hard` back to `d24d05c...` — confirmed clean,
never pushed):
```
Error: gate_ga_staging_runtime_blocked:package_integrity:
[{"file":"liveAcceptanceExecutorCore.mjs","reason":"HASH_MISMATCH",
  "expectedHash":"6f2a7f63...","actual":"d1ab4246..."}, ... all 19 listed files]
```
Root cause, confirmed exactly:
```
$ git config --get core.autocrlf
true
$ git show d24d05c...:scripts/invitationRehearsal/liveAcceptanceExecutorCore.mjs | sha256sum
6f2a7f63...   (matches "expectedHash")
$ sha256sum scripts/invitationRehearsal/liveAcceptanceExecutorCore.mjs
d1ab4246...   (matches "actual")
```
`verifyPackageIntegrity()` in `gateGaStagingRuntime.mjs` compares each
file's on-disk hash against a **pinned, checked-in**
`CODE-SHA256SUMS.txt` ("never fetched, never regenerated at run time").
That file's hashes are LF-based (computed elsewhere, e.g. Linux/macOS/CI
or a non-autocrlf checkout). This Windows checkout has
`core.autocrlf=true`, so every tracked `.mjs` file is materialized with
CRLF line endings on disk — hence **every one of the 19 listed files**
mismatches uniformly, exactly matching what was observed.

Both `gateGaStagingRuntime.mjs` and `CODE-SHA256SUMS.txt` are confirmed
**byte-identical to the `execution/sec-006-gate-ga-r9-fix5` base**
(`git diff e1310e53...d24d05c... -- scripts/invitationRehearsal/CODE-SHA256SUMS.txt scripts/invitationRehearsal/gateGaStagingRuntime.mjs` is empty) —
this is inherited from the already-reviewed base package, not introduced
by any of this branch's four review-cycle fixes. `verifyPackageIntegrity()`
runs unconditionally at the top of `run()`, for both fresh and resume
invocations alike, so this would block the **first real `--execute` of
any kind** on this specific Windows checkout, not only the resume path —
it is simply that the crash-window suite is the first test in this whole
engagement to drive a real literal-CLI `run()` far enough (past the
emulator-host-env check) to reach it.

**Why this is not fixed here:** `gateGaStagingRuntime.mjs` and
`CODE-SHA256SUMS.txt` are outside this task's declared scope (this
branch's mandate has been, across all four review cycles, to add the
functions-evidence gate alongside the reviewed executor files without
modifying them). The correct fix — regenerating
`CODE-SHA256SUMS.txt` against this checkout's actual bytes, normalizing
line endings before hashing, or setting `core.autocrlf=false`/pinning
`.gitattributes` for this directory — changes the integrity-verification
contract of the already-reviewed base package and is an owner decision,
not something to patch unilaterally mid-review on a narrowly-scoped
evidence-binding branch.

**Consequence, stated plainly:** the crash-window/resume regression
remains unverified in this environment — now for a different, precisely
identified reason than item 3's original blocker (which is itself
resolved). No staging run is suggested as a result.

---

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| `npm run typecheck` | PASS | |
| `npm run lint` | PASS | 1 pre-existing unrelated warning |
| `node --test scripts/invitationRehearsal/gateGaApprovalEvidenceBindingSelfTest.mjs` | PASS 35/35 | unaffected by this round's changes |
| `node scripts/invitationRehearsal/gateGaApprovalEvidenceBindingMutationChecks.mjs` | PASS 14/14 DETECTED | |
| `node --test scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs` | PASS 9/9 | run this round against isolated Node 22.23.3 + a live `firebase emulators:exec`, on the final clean, committed HEAD `d24d05c...` |
| `node --test scripts/invitationRehearsal/deploymentCheckSelfTest.mjs` (unchanged) | PASS 19/19 | |
| `gateGaCrashWindowsCliTest.mjs` (8 real crash-window scenarios, via `gateGaSecureExecutor.mjs`) | **FAIL 0/8** | genuinely run this round (item 3's Node blocker resolved); fails on a real, precisely-diagnosed, out-of-scope `package_integrity`/CRLF defect inherited from fix5 — see Item 5 |
| `gateGaResumeKillTest.mjs` / standalone E2E | **NOT AVAILABLE**, and **not applicable to this round's change** — neither ever used the CLI/approval path (verified by direct search, zero matches) | |
| `git status --short` / `git diff` vs fix5 on all original files | empty except the files item 1/2 intentionally adapted; `CODE-SHA256SUMS.txt`/`gateGaStagingRuntime.mjs` confirmed byte-identical to fix5 | |

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

Item 3's original blocking output (this round: resolved, see Item 5):
```text
functions: Using node@22 from host.
Error [ERR_REQUIRE_ESM]: require() of ES Module .../functions/node_modules/jose/dist/webapi/index.js
from .../functions/node_modules/jwks-rsa/src/utils.js not supported.
```

Item 5's new blocking output (crash-window, all 8/8, unresolved — out of scope):
```text
LIVE_ACCEPTANCE_EXECUTOR_STOPPED reason=local_gate; expected exact --execute arguments,
clean reviewed HEAD, unexpired exact-hash private approval, a real bound --functions-receipt,
and new private journal/output paths. Credentials and network were not loaded; no mutation,
email, browser action or cleanup was attempted.

(real cause, captured via a temporary local-only debug commit, discarded afterward:)
Error: gate_ga_staging_runtime_blocked:package_integrity:
[{"file":"liveAcceptanceExecutorCore.mjs","reason":"HASH_MISMATCH",
  "expectedHash":"6f2a7f63da27af567ad936690749d504955a522d8d734e0845231f8e428c5685",
  "actual":"d1ab424694bde37ca52479a48dbdeee1a16b42ff8d5e3e877b902553966fc6c5"}, ...]

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
- No new software was installed system-wide; the portable Node 22 and the
  JDK 21 override both used already-obtained or already-installed
  binaries, isolated to this session's PATH only.
- No secrets/tokens in this report or code.

## Данные и миграция
Нет.

## Известные ограничения
- Item 3's original Node-version/`jose`/`jwks-rsa` blocker is resolved
  this round (isolated Node 22.23.3) — no longer a limitation.
- Item 5 (new this round): crash-window/resume regression is blocked by
  a real, precisely-diagnosed `package_integrity`/CRLF defect in the
  already-reviewed, unmodified `gateGaStagingRuntime.mjs` +
  `CODE-SHA256SUMS.txt` (inherited unchanged from fix5) — this Windows
  checkout's `core.autocrlf=true` makes every on-disk `.mjs` file's hash
  differ from the LF-pinned expected sums. This would block the first
  real `--execute` of any kind (fresh or resume) on this machine, not
  only crash-window resume. Out of scope to fix on this branch; requires
  an owner decision on how `CODE-SHA256SUMS.txt`/line-ending handling
  should work across checkouts.
- `liveAcceptanceExecutor.mjs` remains a usable, ungated bypass of this
  round's functions-evidence gate (item 4) — a stated property of adding
  a new opt-in entrypoint, not a defect to be silently assumed closed.

## Diff summary
```text
 docs/remediation/reports/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING.md | rewritten (this file)
 scripts/invitationRehearsal/gateGaCrashWindowsCliTest.mjs              | adapted to gateGaSecureExecutor.mjs (item 2)
 scripts/invitationRehearsal/gateGaSecureExecutor.mjs                   | distinguishable, non-leaky gate-refusal reason (item 1)
 scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs           | rewritten differential real-file test pair (item 1);
                                                                          this round: explicit emulator-host env stripping in
                                                                          the positive real-file test (item 5)
```
No other tracked file changed this round; `gateGaStagingRuntime.mjs` and
`CODE-SHA256SUMS.txt` confirmed byte-identical to fix5 (Item 5).

## Следующий разрешенный пункт
Independent review of this fix pass. No mailbox lookup or invitation
requested. `--execute` against real staging not authorized.
