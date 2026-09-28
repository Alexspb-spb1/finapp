# FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING — closing the functionsSha256 gap

## Итоговый статус
READY_FOR_REVIEW for items 1–4a/4b (code fixes, all proven by new/updated
tests). Item 4c (crash-window/resume-kill/E2E regression) is explicitly
**NOT VERIFIED** in this environment — see that section for exactly why
and what was tried. Not claimed as a passing regression run.

## Branch / commit
- branch: `remediation/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING`
- 1st CHANGES_REQUIRED commit: `763642dac46e036909e8fe47194de4cb8cca65be`
- 2nd CHANGES_REQUIRED commit (fixed 5 items, itself found 4 more): `d1f15bdae01afccd5dc5ba15a697d1a07945b6a7`
- base SHA: `execution/sec-006-gate-ga-r9-fix5` @ `e1310e5314f4e6355a0fbd43eab378224044e1f6` — **unchanged this round and every round**; every original fix5 file remains byte-identical (`git diff` empty, re-verified below)
- result SHA: this round's commit — see the final report message for the exact hash

**Important structural change this round:** the entire toolkit built across
this and the two prior rounds — `gateGaDeploymentCheck13.mjs` (functions
checker), `gateGaBuildApprovalDraft.mjs` (approval builder),
`gateGaSecureExecutor.mjs` (gated executor), plus
`mailboxDiscovery.mjs`/`authVerificationShapeDiscovery.mjs` (inherited
unchanged from fix5) — now all live together in **one single commit**:
this branch's own tip. There is no longer a "checker checkout" and a
separate "executor checkout" — **this commit is both**, and its own
commit hash is the one `--expected-head` value used throughout the whole
playbook. This directly resolves items 1 and 2 below simultaneously; see
those sections for why.

---

## Item 1 — receipts from different checkouts would be wrongly rejected by a single shared expected-HEAD parameter; fixed

**Confirmed exactly as raised:** `buildApprovalDraft()` took one
`expectedCheckerSourceHead` and used it to validate all three receipts'
`sourceHead` fields. In the real (then two-checkout) playbook, the
functions receipt's real `sourceHead` would be the checker checkout's
commit while the mailbox/auth receipts' real `sourceHead` would be the
executor checkout's commit — genuinely different values — so real
receipts would have been wrongly rejected. The previous test fixtures
used one `CHECKER_HEAD` constant for all three, which hid this.

**Fix — two independent, never-defaulted parameters:**
`buildApprovalDraft()` now takes `expectedFunctionsCheckerSourceHead`
(passed to `validateFunctionsShaBinding`) and `expectedDiscoverySourceHead`
(passed to both `validateMailboxReceipt` and `validateAuthMetadataReceipt`)
as two separate required inputs — never collapsed into one internally.
Every fixture in the rewritten self-test now uses genuinely different
values for `HEAD` (mailbox/auth/executor) vs `CHECKER_HEAD` (functions),
reproducing the real playbook's mismatch exactly, including new tests
proving a receipt with the *other* type's correct-but-wrong-for-this-check
`sourceHead` is rejected in both directions. A new mutation (M14) proves
the two parameters cannot be silently collapsed back into one without a
test catching it.

**This round's structural change (see above) makes the split largely
moot in practice** — since the whole toolkit now lives in one commit, the
real playbook passes the *same* value for both parameters — but the code
itself still treats them as independent, so a future round that
re-splits the toolkit across checkouts again is still protected. Both the
per-day 13FN checker workflow and the split are Ok.

---

## Item 2 — `gateGaSecureExecutor.mjs` was not actually runnable as documented; fixed by consolidation, not by copying

**Confirmed exactly as raised:** the previous playbook told the owner to
run `gateGaSecureExecutor.mjs` "from checkout B" (`e1310e53`), but that
file only existed on this branch (call it checkout A). Copying it into B
would dirty B's tree (breaking the executor's own clean-HEAD check) and
would still need its new imports (`gateGaSecureExecutorCore.mjs`,
`gateGaApprovalEvidenceBindingCore.mjs`, `gateGaDeploymentCheck13Core.mjs`)
copied too. Running it from A by absolute path would resolve `root` (and
therefore the git HEAD it checks) from the FILE's own location — A — not
B. And `liveAcceptanceExecutor.mjs` remaining reachable meant the new
gate could always be bypassed.

**Fix:** rather than trying to reconcile two checkouts, this round
**stops maintaining two checkouts at all.** Every file needed for the
whole playbook — the functions checker, the approval builder, the gated
executor, and (inherited unchanged from fix5) the mailbox/auth discovery
scripts — now lives together in this one branch. `gateGaSecureExecutor.mjs`
resolves its own `root` from its own file location, which is now
genuinely this checkout, and `--expected-head` genuinely equals this
checkout's real HEAD when both are this commit's hash. **One executable
command, no file copying, no cross-checkout path confusion:**

```bash
node scripts/invitationRehearsal/gateGaSecureExecutor.mjs --execute \
  --functions-receipt <functions-receipt.json> --expected-checker-source-head <THIS-COMMIT-HASH> \
  --profile staging --project finapp-staging --expected-head <THIS-COMMIT-HASH> \
  --approval <approval.json> --approval-sha256 <printed-value> \
  --journal <journal.jsonl> --out <executor-out.json> \
  --recipient lesenenok8787@gmail.com --recipient-confirmed-sha256 20cf29054a5a4cf524a93e821a90d245f9b4f601669f57ca663c7a7ffc7a9e54 \
  --resume false --legacy-cleanup-approved false
```

**`liveAcceptanceExecutor.mjs` remaining reachable and bypassing the gate
is still true and still stated as a limitation** (see item 4) — that file
is inherited unchanged from fix5 by design (not modified, not deleted,
not renamed); the one-command fix above is that the *correct*, documented
entrypoint is now genuinely runnable exactly as written, with no
workaround needed to make it so.

---

## Item 3 — function-name check only inspected the trailing path segment; fixed

**Confirmed exactly as raised:** `fn.name.split('/').pop()` would accept
`projects/other-project/locations/us-central1/functions/acceptInvite` as
`'acceptInvite'` — the embedded project in the function's own resource
path was never cross-checked against the receipt's top-level `project`
field.

**Fix:** `validateFunctionsShaBinding()` now requires the FULL resource
path to match exactly:
`projects/${expectedProject}/locations/us-central1/functions/${shortName}`
— mirroring the same exact-path shape `deploymentCheckCore.mjs`'s own
`checkFunction()` already requires. New tests: a foreign-project name and
a wrong-region name (right project, right trailing segment, wrong
`locations/...` segment) are both rejected.

**Restated, not regressed:** a SHA-256 match still proves only that the
supplied bytes are the exact bytes named by the hash (integrity), never
that those bytes were genuinely produced by a live checker run rather
than hand-assembled (provenance/authenticity) — the module header and
this report say so explicitly, unchanged from the prior round.

---

## Item 4 — tests didn't prove the claimed real-CLI run; a real Date() flake; crash-window regression

**4a — "FULL WIRING" called `wrapRuntimeWithFunctionsEvidenceGate()`
directly, bypassing argument parsing, the clean-HEAD check, and the file
itself.** Fixed: kept the existing in-process FULL WIRING tests (they
remain the most rigorous, safest way to get an exact, numeric
zero-network-call proof — see the safety note below) but added **three
new tests that spawn the real `gateGaSecureExecutor.mjs` file as an
actual child process**:
- `--help` real-runs and documents the two new required flags.
- `--execute` without them refuses before touching git or any file.
- `--execute`, run for real against **this actual checkout's real,
  dynamically-captured git HEAD**, with a syntactically-valid-but-forged
  approval (`functionsSha256: 'f'.repeat(64)`, exactly the shape the
  reviewed executor's own format check would accept), refuses fast
  (asserted under 10s) with neither `--out` nor `--journal` ever written.

**Why `--profile emulator`, not `--profile staging`, for the real-process
test:** a literal OS subprocess test cannot safely inject a network/
auth-call spy across the process boundary the way the in-process test
can. This machine has a real, logged-in `firebase-tools` CLI session
(confirmed earlier this round: `lesenenok8787@gmail.com`) — if this
round's gate code had a real regression and a literal subprocess test
used `--profile staging`, an escaped run could have attempted a genuine
call against real `finapp-staging` using that real session, which is
exactly what today's "no new staging contact" instruction forbids risking
even as a failure mode of a test. `--profile emulator` with no emulator
host env set means the worst case of a gate bug is an immediate,
harmless local connection refusal to a nonexistent emulator — never real
staging. The exact, numeric "zero network/fetch/auth calls" proof stays
at the in-process level, under a controlled spy, which is the safe place
for it.

**4b — the exact Date() flake described was real.** `realFunctionsReceiptBytes()`
calls `new Date().toISOString()` internally; the old FULL WIRING tests
called it twice (once building the gate's receipt, again independently
for the "matching" hash), so a millisecond rollover between the two calls
would produce different bytes and a spurious mismatch. Fixed: both tests
now call the fixture builder exactly once per test and reuse that same
buffer everywhere. The CLI integration tests in
`gateGaApprovalEvidenceBindingSelfTest.mjs` had a related, separately
found issue — their fixtures used hardcoded 2026-09-26 timestamps, now
stale relative to real wall-clock time (today is 2026-09-28) against the
real CLI subprocess's un-injectable `Date.now()` — fixed the same way:
one fresh timestamp computed once per test, reused across all three
receipts' fixture bytes.

**4c — crash-window/resume-kill/E2E regression: genuine progress, but
still UNVERIFIED — not claimed ready to run.** This environment's system
Java (Temurin 17) was incompatible with `firebase-tools`' emulator
requirement (21+), as reported last round. This round, a compatible
runtime already installed on this machine (Android Studio's bundled JBR,
`21.0.10`) was pointed to via a `JAVA_HOME` override — no new software
installed — and the emulator suite (Auth, Firestore, Functions host)
started under it. That got further than last round: the functions
package had never been built in this clone at all (`functions/lib` was
missing, causing an immediate load failure); this round it was built
fresh from this clone's own reviewed `functions/src` (byte-identical to
fix5, confirmed via `git diff`), using `functions/node_modules` linked
from the main dev worktree (identical `package-lock.json`, confirmed
byte-for-byte).

**That build then surfaced a second, separate, deeper blocker:**
restarting the emulator suite to pick up the built functions produced
`Failed to load function definition from source: ... Cannot determine
backend specification. Timeout after 10000`, alongside a printed warning
that this host's global Node (`v24.16.0`) does not match what
`functions/package.json` declares (`engines.node: "22"`). No alternate
Node 22 runtime is installed on this machine (checked: no `nvm`, no
second `node.exe` under `Program Files\nodejs`), and installing one is a
real, separate system change this report does not make unilaterally
without being asked — unlike the JDK case, there was no already-installed
compatible runtime to point at instead.

**Consequence, stated plainly, not glossed over:** crash-window,
resume-kill, and the standalone E2E check remain **NOT VERIFIED** in this
environment this round. The Java-version blocker reported last round is
resolved; a different, Node-version-related blocker in the Functions
emulator's own backend-specification introspection was found in its
place and is not resolved. This is a real limitation of the current
local environment, not of the code changed this round — the emulator-
independent tests that exercise this round's actual changes (35/35 +
14/14 evidence-binding; 8/8 secure-executor, including 3 real-subprocess
tests) are unaffected and green regardless.

---

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| `npm run typecheck` | PASS | |
| `npm run lint` | PASS | 1 pre-existing unrelated warning |
| `node --test scripts/invitationRehearsal/gateGaApprovalEvidenceBindingSelfTest.mjs` | PASS 35/35 | includes split-HEAD, full-path, and real-CLI-integration tests |
| `node scripts/invitationRehearsal/gateGaApprovalEvidenceBindingMutationChecks.mjs` | PASS 14/14 DETECTED | |
| `node --test scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs` | PASS 8/8 | includes 3 new real-subprocess tests against the real file |
| `node --test scripts/invitationRehearsal/deploymentCheckSelfTest.mjs` (unchanged) | PASS 19/19 | |
| `test:invitation-gate-ga-crash-windows` | **NOT AVAILABLE** | Java blocker resolved (JDK 21 via Android Studio JBR, no install needed) but a separate, deeper Node 22-vs-24 blocker found in the Functions emulator's backend-spec introspection — see item 4c |
| `test:invitation-gate-ga-resume-kill` | **NOT AVAILABLE** | same root cause as above |
| standalone emulator E2E | **NOT AVAILABLE** | same root cause as above |
| `git status --short` / `git diff` vs fix5 on all original files | empty | provably untouched, this round and every round |

## Фактический вывод существенных тестов

```text
DETECTED M1 the core functions-hash-equality check removed {"exitCode":1,"fail":2}
DETECTED M2 checker sourceHead binding check removed (would accept a receipt from any checker commit) {"exitCode":1,"fail":3}
DETECTED M3 baseline-receipt-hash binding check removed {"exitCode":1,"fail":2}
DETECTED M4 per-entry baseline name/uniqueness/drift-binding check removed {"exitCode":1,"fail":3}
DETECTED M5 exact-13-unique-names-across-both-families check removed (the exact gap the audit found) {"exitCode":1,"fail":2}
DETECTED M6 shared receipt-freshness check removed (affects all three receipt types) {"exitCode":1,"fail":3}
DETECTED M7 buildApprovalDraft no longer calls validateFunctionsShaBinding before emitting a draft {"exitCode":1,"fail":2}
DETECTED M8 buildApprovalDraft no longer validates the mailbox receipt (would accept forged mailbox bytes) {"exitCode":1,"fail":2}
DETECTED M9 buildApprovalDraft no longer validates the auth-metadata receipt (would accept forged auth bytes) {"exitCode":1,"fail":2}
DETECTED M13 full exact function resource-path check removed (only the trailing name segment would be checked) {"exitCode":1,"fail":3}
DETECTED M14 functions-checker and discovery source-head params collapsed into one (the exact gap the audit found) {"exitCode":1,"fail":3}
DETECTED M10 explicit ownerConfirmsApproval requirement removed {"exitCode":1,"fail":2}
DETECTED M11 explicit reviewStatus/ciStatus requirement removed {"exitCode":1,"fail":2}
DETECTED M12 APPROVAL_TTL_MS silently drifted from the reviewed executor's real constant {"exitCode":1,"fail":4}

SUMMARY total=14 detected=14 undetected=0
```

Crash-window / resume-kill / E2E: **not run to completion this round** —
see item 4c for the exact new blocker found (Node 22-vs-24 mismatch in
the Functions emulator, discovered only after resolving last round's Java
blocker). Not claimed as PASS.

---

## Corrected owner playbook — one checkout, one HEAD, one final command

All steps below run from **this one checkout**, at **this one commit's
HEAD** (fill in after this branch's commit; call it `THIS_HEAD` below).

1. `mailboxDiscovery.mjs --project finapp-staging --expected-head THIS_HEAD --mailbox-file <file with only lesenenok8787@gmail.com> --out <mailbox-receipt.json>` — **still the one step only the owner can run** (sandbox-blocked here); not requested yet, per this round's instruction.
2. `authVerificationShapeDiscovery.mjs --project finapp-staging --expected-head THIS_HEAD --out <auth-metadata-receipt.json>`
3. `gateGaDeploymentCheck13.mjs --project finapp-staging --expected-head THIS_HEAD --baseline-receipt <stage8-deployment-postflight-ab1bd67.json> --out <functions-receipt.json>`
4. `gateGaBuildApprovalDraft.mjs --mailbox-receipt <2> --functions-receipt <3> --auth-metadata-receipt <2> --staging-fingerprint 2a26dafc4fedd7f6f584f6f0e60369a7cb3097f0188ce45f90a14e9d84b9c854 --expected-functions-checker-source-head THIS_HEAD --expected-discovery-source-head THIS_HEAD --review-status PASS --ci-status PASS --owner-confirms-approval true --out <approval.json> -- --profile staging --project finapp-staging --expected-head THIS_HEAD --journal <journal.jsonl> --out <executor-out.json> --recipient lesenenok8787@gmail.com --recipient-confirmed-sha256 20cf29054a5a4cf524a93e821a90d245f9b4f601669f57ca663c7a7ffc7a9e54 --resume false --legacy-cleanup-approved false`
5. **Immediately**, the one executable `--execute` command from item 2's section above.

Stop conditions unchanged from prior rounds: any `_BLOCKED`/non-zero exit
at any step → stop, do not retry with different evidence. Expired
approval (>1h) → rebuild from fresh evidence, never reuse. No old/legacy
matching record is ever deleted (`legacyCleanupApproved: false`).

**No mailbox lookup is being requested right now.**

## Security review
- No `--execute`, account creation, email, deploy, PR #28 merge, or
  production action performed or auto-triggered.
- No new live network call to `finapp-staging` was made this round.
- The real-subprocess tests added this round use `--profile emulator`
  specifically to guarantee they can never reach real staging even under
  a gate regression (see item 4a).
- No secrets/tokens in this report or code.

## Известные ограничения
- `liveAcceptanceExecutor.mjs` remains present, unmodified, and reachable
  — it still bypasses this round's gate if used directly instead of
  `gateGaSecureExecutor.mjs`. Procedural, not code-level, discipline.
- M1/SEC-007 functions still have no drift baseline (unchanged).

## Diff summary
```text
 docs/remediation/reports/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING.md | rewritten (this file)
 scripts/invitationRehearsal/gateGaApprovalEvidenceBindingCore.mjs      | split HEAD params (item 1), full-path check (item 3)
 scripts/invitationRehearsal/gateGaApprovalEvidenceBindingMutationChecks.mjs | +2 mutations (M13, M14)
 scripts/invitationRehearsal/gateGaApprovalEvidenceBindingSelfTest.mjs  | split-HEAD fixtures, full-path tests, freshness fix
 scripts/invitationRehearsal/gateGaBuildApprovalDraft.mjs               | two separate --expected-*-source-head flags
 scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs           | 3 new real-subprocess tests, Date() flake fixed
```

## Следующий разрешенный пункт
Independent review of this 2nd fix pass. No mailbox lookup requested.
`--execute` not authorized by this report.
