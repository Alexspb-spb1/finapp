# FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING — closing the functionsSha256 gap

## Итоговый статус
READY_FOR_REVIEW (fix pass responding to CHANGES_REQUIRED)

## Branch / commit
- branch: `remediation/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING`
- previous (CHANGES_REQUIRED) commit: `763642dac46e036909e8fe47194de4cb8cca65be`
- base SHA: `bd59524a2802f1c7ad937d1165fe842ce0df9048` (`remediation/SEC-006-GATE-GA-DEPLOYMENT-CHECK-13FN`, itself based on `execution/sec-006-gate-ga-r9-fix5` @ `e1310e5314f4e6355a0fbd43eab378224044e1f6`)
- result SHA: see commit created by this report's accompanying push

This is a single fix pass responding to all five CHANGES_REQUIRED items
from the independent audit of `763642da`. Each item below is addressed in
its own section with what changed, what is now proven, and what remains
an explicit, stated limitation rather than a silently-dropped concern.

---

## Item 1 — the owner playbook was unrunnable; fixed

**What was wrong:** the previous playbook told the owner to run
`gateGaBuildApprovalDraft.mjs` "from the fix5 checkout," but that file
only exists on this branch. It also required `--approval-sha256` as an
input to the SAME command that would produce the file whose hash that is
— a value that cannot be known before the command runs.

**Fix:**
1. **Two separate, clearly-scoped checkouts**, spelled out explicitly in
   the corrected playbook (below): one at *this* branch's final commit
   (where `gateGaDeploymentCheck13.mjs`, `gateGaBuildApprovalDraft.mjs`
   and `gateGaSecureExecutor.mjs` actually live), and one at the reviewed
   G-A executor commit `e1310e5314f4e6355a0fbd43eab378224044e1f6` (where
   `mailboxDiscovery.mjs`, `authVerificationShapeDiscovery.mjs` and the
   actual `--execute` run happen) — the same unmodified file, just bound
   to the exact commit that was independently reviewed for that role.
2. **The circular `--approval-sha256` dependency is gone.**
   `buildApprovalDraft()` no longer takes a full `--execute`-shaped
   argument list. It now takes its own 9-field `draftArgs`
   (`DRAFT_ARGUMENTS`, exported) that deliberately excludes `--approval`
   and `--approval-sha256` — confirmed
   `approvalCommandSha256()` (the real, imported, unmodified function)
   never reads either field, so nothing was lost. `--approval-sha256` is
   now only ever supplied to the *separate*, later `--execute` command,
   after this tool has printed it.
3. **Locally verified, not just argued:** a new self-test
   (`gateGaApprovalEvidenceBindingSelfTest.mjs`, "CLI integration") spawns
   `gateGaBuildApprovalDraft.mjs` as a real child process against real
   files on disk, reads the real file it writes, builds the exact
   `--execute` argument array an owner would type (now including the
   freshly-computed `--approval-sha256`), and feeds it through the REAL,
   unmodified `parseExecutorCliArgs()` and `validateExecutionApproval()`
   — asserting genuine acceptance. A companion negative test proves a
   forged `--functions-receipt` file is refused by the real CLI process
   with no approval file written. **This is the literal command sequence
   an owner would type, verified end to end, not a unit-level stand-in.**

---

## Item 2 — receipt validation was insufficient; strengthened

**What was wrong, confirmed exactly as reported:** the positive self-test
in `763642da` fed `validateFunctionsShaBinding()` a receipt containing
`functions: [{name:'x'},{name:'y'}]` — two arbitrary entries — and it
passed. The function never checked the checker's own `sourceHead`, never
checked the baseline-receipt-hash binding (only the baseline sourceHead
binding), and never checked that the 13 required function names were
present, unique, or correctly split across families.

**Fix — `validateFunctionsShaBinding()` now additionally requires:**
- `expectedCheckerSourceHead` (new required parameter, hex40) — the
  receipt's own `sourceHead` must match exactly. A receipt from any other
  checker commit is refused.
- `receipt.baselineDriftCheckedAgainstReceiptSha256` must equal the
  pinned `EXPECTED_BASELINE_RECEIPT_SHA256` (previously only the
  sourceHead half of this binding was checked).
- `receipt.functions` must contain **exactly** the union of
  `BASELINE_CALLABLES` (8) and `MEMBER_MANAGEMENT_CALLABLES` (5) — no
  fewer, no more, no duplicates — with each entry's `family` field
  matching which set its name belongs to, and each `family: 'baseline'`
  entry's `driftCheckedAgainstSourceHead` also bound to the pinned value.

New negative tests directly reproduce and close the exact bug found:
"a receipt with only 2 arbitrary function entries is now rejected", plus
missing-one, duplicated, substituted/foreign-name, wrong-family,
wrong-checker-commit, wrong-baseline-hash-binding, and
wrong-baseline-sourceHead-binding cases — all rejected.

**On "don't call an unsigned file cryptographic proof of its origin"** —
correct, and the module header/docstrings were rewritten to say exactly
that: a SHA-256 match proves the supplied bytes are the exact bytes the
hash names (**integrity**), not that those bytes were genuinely produced
by a live run of the real checker rather than hand-assembled by someone
who knows the schema (**provenance/authenticity**, which would need a
real signing mechanism and is explicitly out of scope). What this module
now does is make a syntactically-valid-but-wrong receipt — incomplete,
duplicated, substituted, misbound, stale, or from the wrong
task/status/project/commit — impossible to pass off as real, which is
what was actually missing; it does not and cannot prove who ran the
command that produced the bytes. That remains a **procedural** trust
boundary: the owner must be the one who actually ran the real checker and
handed over its real output file. Stated plainly in the report and in
code comments, not glossed over.

---

## Item 3 — builder was rubber-stamping APPROVED/PASS; fixed

**What was wrong, confirmed exactly as reported:** `mailboxReceiptBytes`
and `authMetadataReceiptBytes` were hashed with zero content validation —
any bytes worked, as the local smoke test with synthetic strings showed.
`reviewStatus`/`ciStatus`/the overall `APPROVED` decision were emitted
unconditionally, with no separation between "the technical evidence
checks out" and "a human actually decided to approve this."

**Fix:**
- **New `validateMailboxReceipt()`** and **`validateAuthMetadataReceipt()`**,
  checking the REAL schema each real discovery script writes to disk
  (`mailboxDiscoveryCore.mjs`'s `discoverMailbox()` output;
  `authVerificationShapeDiscoveryCore.mjs`'s `sanitizeDiscovery()`
  output) — exact `task`/`status`/`project`/`sourceHead`, the expected
  boolean flags, `cloudMutations === 0`/`emailsSent === 0` for the
  mailbox receipt, and freshness for both. New tests prove a synthetic/
  fabricated byte string for either is rejected, alongside per-field
  negative cases (wrong task/status/project/sourceHead/flags).
  `buildApprovalDraft()` now calls both before computing their hashes —
  proven by two new mutation entries (M8, M9) showing that skipping
  either call would let forged evidence through.
- **`reviewStatus`, `ciStatus`, `ownerConfirmsApproval` are now required,
  explicit, never-defaulted inputs.** `buildApprovalDraft()` refuses
  unless `ownerConfirmsApproval === true` (exactly the boolean `true` —
  a string `'true'` or `false` are both refused) and
  `reviewStatus === 'PASS' && ciStatus === 'PASS'` are passed in
  literally by the caller. This tool has no access to any CI system or
  code-review record and never infers these on the owner's behalf; only
  `functionsStatus: 'PASS'` is derived from evidence, because that is the
  one claim this module can actually verify from bytes on disk. The CLI
  wrapper (`gateGaBuildApprovalDraft.mjs`) surfaces all three as
  dedicated, required `--review-status`/`--ci-status`/
  `--owner-confirms-approval` flags.

---

## Item 4 — "gap closed" was premature; a real hard gate now exists, with its own stated limitation

**Correct as raised:** `validateExecutionApproval()` in the reviewed,
published fix5 executor is unmodified and still accepts a hand-crafted
64-hex `functionsSha256` with no cross-check. That claim in the previous
report was premature.

**What was added this round — `gateGaSecureExecutorCore.mjs` +
`gateGaSecureExecutor.mjs`:** a new, additive wrapper CLI that mirrors
`liveAcceptanceExecutor.mjs` line-for-line (same
`executeApprovedLiveRuntime`, same `routeExecutorCli`, same
`buildStagingAdapters`/`buildEmulatorFirebaseHandles`) with exactly one
change: `loadRuntime()`'s returned runtime is wrapped by
`wrapRuntimeWithFunctionsEvidenceGate()`, which re-verifies the
approval's `functionsSha256` against a real `--functions-receipt` file
(via the now-strengthened `validateFunctionsShaBinding()`) **before**
`runtime.run()` — and therefore before any staging network or credential
access, which only happens inside that call — is ever reached.

**Proven, not asserted — full production wiring, not just a unit test:**
`gateGaSecureExecutorSelfTest.mjs`'s "FULL WIRING" test drives the exact
real objects (`createGateGaOrchestratedRuntime` + the real
`createGateGaStagingAdapters`, the same wiring `liveAcceptanceExecutor.mjs`
itself uses for a staging-profile run) with a forged `functionsSha256`,
and asserts **zero** `getGlobalDefaultAccount`/`requireAuth`/
`getAccessToken`/`fetch` calls of any kind, and that neither `--out` nor
`--journal` is ever written. A companion positive test proves a
genuinely-matching hash passes the gate and reaches the real orchestrator
(whatever it does next is its own business — the only thing asserted is
that this gate's own rejection is never what stops it).

**The explicit, stated limitation this section exists to give, per the
review's own instruction:** this hard gate lives in
`gateGaSecureExecutor.mjs`, a **new, parallel entrypoint** — it is not,
and cannot be without editing the published fix5 file, wired into
`liveAcceptanceExecutor.mjs` itself. **Anyone who runs
`liveAcceptanceExecutor.mjs --execute` directly (bypassing this wrapper)
is still only protected by `validateExecutionApproval()`'s format-only
check.** Closing that completely would require editing
`liveAcceptanceExecutorCliCore.mjs` on a new branch and re-reviewing that
specific change — deliberately not done here, per "don't rewrite
published branches" and per proportionate scope for one fix pass. The
recommendation, stated plainly for the playbook and for whoever reviews
this next: **use `gateGaSecureExecutor.mjs`, not
`liveAcceptanceExecutor.mjs` directly, for the real run** — this is a
procedural requirement this report states outright, not a defect
presented as fixed.

**Regression — with one genuine environmental gap, disclosed, not
worked around:**
- Typecheck, lint, and every emulator-independent suite touching this
  round's code paths: green (see table below).
- `test:invitation-gate-ga-crash-windows`, `resume-kill`, and the
  standalone emulator E2E — **NOT AVAILABLE this round.** The local
  Firebase emulator suite requires Java 21+; this environment currently
  has only JDK 17 (`Temurin-17.0.19+10`) and a JRE 1.8 installed, and
  `firebase emulators:start` now refuses to run on it
  (`Error: firebase-tools no longer supports Java version before 21`).
  This is a pre-existing environment gap, unrelated to any change in this
  branch, and installing a new JDK was not done (a system-level change
  outside this fix's scope, not requested). The most directly relevant
  regression for what actually changed — the staging-profile wiring
  `gateGaSecureExecutor.mjs` gates — **was** run and is green (the FULL
  WIRING tests above use real adapter code with network/fetch spies, not
  the emulator suite, so they are unaffected by this gap). Crash-window/
  resume-kill/E2E specifically exercise the **emulator**-profile path
  (`buildEmulatorFirebaseHandles`), which this round's changes do not
  touch. This gap is stated here, not silently skipped.

---

## Item 5 — invocation log corrected

Fixed in `docs/remediation/evidence/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING/invocation-log.md`:
- Correctly labels **two** of the five diagnostic steps (not one) as
  involving real network reads (step 2: one GET; step 3: five GETs).
- Removes the "dirty-tree/junction-timing" causal claim for Attempt 1's
  original failure. The corrected log states plainly: **the root cause
  was not established**, several candidate explanations were ruled out,
  and no further live diagnostic was attempted, so the question is left
  genuinely open rather than resolved by inference.

---

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| `npm run typecheck` | PASS | |
| `npm run lint` | PASS | 1 pre-existing unrelated warning |
| `node --test scripts/invitationRehearsal/gateGaApprovalEvidenceBindingSelfTest.mjs` | PASS 30/30 | includes the real CLI-level integration test (item 1) |
| `node scripts/invitationRehearsal/gateGaApprovalEvidenceBindingMutationChecks.mjs` | PASS 12/12 DETECTED | |
| `node --test scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs` | PASS 5/5 | includes the full-production-wiring zero-network proof (item 4) |
| `node --test scripts/invitationRehearsal/deploymentCheckSelfTest.mjs` (unchanged) | PASS 19/19 | exact-eight check unaffected |
| `npm run test:invitation-gate-ga-orchestrator` | PASS 37/37 | unaffected, unchanged |
| `npm run test:invitation-gate-ga-staging-cli` | PASS 9/9 | unaffected, unchanged |
| `npm run test:invitation-gate-ga-deployment-check-13fn` / `-mutations` | **local artifact only** | same pre-existing Windows CRLF-checkout artifact already diagnosed in the 13fn-checker round's own report (`git status`/`git show HEAD:...` confirm the committed fixture blob is correct and unmodified); not a regression, not touched by this round |
| `node scripts/invitationRehearsal/gateGaSecureExecutor.mjs --help` | OK | no network/credentials touched |
| `test:invitation-gate-ga-crash-windows` / `resume-kill` / standalone E2E | **NOT AVAILABLE** | local emulator suite requires Java 21+; only JDK 17 present in this environment (see item 4) |
| `git status --short` / `git diff --stat` on fix5 and the 13fn-checker branch's pre-existing files | empty | provably untouched |

## Фактический вывод существенных тестов

```text
DETECTED M1 the core functions-hash-equality check removed {"exitCode":1,"fail":2}
DETECTED M2 checker sourceHead binding check removed (would accept a receipt from any checker commit) {"exitCode":1,"fail":2}
DETECTED M3 baseline-receipt-hash binding check removed {"exitCode":1,"fail":2}
DETECTED M4 per-entry baseline name/uniqueness/drift-binding check removed {"exitCode":1,"fail":3}
DETECTED M5 exact-13-unique-names-across-both-families check removed (the exact gap the audit found) {"exitCode":1,"fail":2}
DETECTED M6 shared receipt-freshness check removed (affects all three receipt types) {"exitCode":1,"fail":3}
DETECTED M7 buildApprovalDraft no longer calls validateFunctionsShaBinding before emitting a draft {"exitCode":1,"fail":2}
DETECTED M8 buildApprovalDraft no longer validates the mailbox receipt (would accept forged mailbox bytes) {"exitCode":1,"fail":2}
DETECTED M9 buildApprovalDraft no longer validates the auth-metadata receipt (would accept forged auth bytes) {"exitCode":1,"fail":2}
DETECTED M10 explicit ownerConfirmsApproval requirement removed {"exitCode":1,"fail":2}
DETECTED M11 explicit reviewStatus/ciStatus requirement removed {"exitCode":1,"fail":2}
DETECTED M12 APPROVAL_TTL_MS silently drifted from the reviewed executor's real constant {"exitCode":1,"fail":4}

SUMMARY total=12 detected=12 undetected=0
```

---

## Corrected owner playbook (not requested to be run now — prepared for after this branch is reviewed)

**Checkout A** — this branch's final reviewed commit (hosts
`gateGaDeploymentCheck13.mjs`, `gateGaBuildApprovalDraft.mjs`):

```bash
node scripts/invitationRehearsal/gateGaDeploymentCheck13.mjs \
  --project finapp-staging --expected-head <checkout-A-HEAD> \
  --baseline-receipt "<path-to>/stage8-deployment-postflight-ab1bd67.json" \
  --out <functions-receipt.json>
```
Stop condition: must print `DEPLOYMENT_METADATA_VERIFIED_13FN`, exit 0.

**Checkout B** — clean checkout of `execution/sec-006-gate-ga-r9-fix5` @
`e1310e5314f4e6355a0fbd43eab378224044e1f6` (hosts `mailboxDiscovery.mjs`,
`authVerificationShapeDiscovery.mjs`, `gateGaSecureExecutor.mjs` is copied
here or referenced by absolute path from checkout A — either works, since
`gateGaSecureExecutor.mjs` only needs to be *run* from a checkout whose
HEAD equals the `--expected-head` given to `--execute`, i.e. checkout B):

```bash
node scripts/invitationRehearsal/mailboxDiscovery.mjs \
  --project finapp-staging --expected-head e1310e5314f4e6355a0fbd43eab378224044e1f6 \
  --mailbox-file <file containing only lesenenok8787@gmail.com> --out <mailbox-receipt.json>
```
Stop condition: must print `MAILBOX_DISCOVERY_COMPLETE`. **Still blocked
in this environment — this is the one step only the owner can run; not
requested yet, per this round's instruction to make the commands and
gate work first.**

```bash
node scripts/invitationRehearsal/authVerificationShapeDiscovery.mjs \
  --project finapp-staging --expected-head e1310e5314f4e6355a0fbd43eab378224044e1f6 \
  --out <auth-metadata-receipt.json>
```
Stop condition: must print `AUTH_VERIFICATION_TEMPLATE_SHAPE_DISCOVERED`.

`stagingFingerprint` (static, already verified):
`2a26dafc4fedd7f6f584f6f0e60369a7cb3097f0188ce45f90a14e9d84b9c854`.

**Immediately**, from checkout A (or wherever `gateGaBuildApprovalDraft.mjs`
lives):
```bash
node scripts/invitationRehearsal/gateGaBuildApprovalDraft.mjs \
  --mailbox-receipt <mailbox-receipt.json> --functions-receipt <functions-receipt.json> \
  --auth-metadata-receipt <auth-metadata-receipt.json> \
  --staging-fingerprint 2a26dafc4fedd7f6f584f6f0e60369a7cb3097f0188ce45f90a14e9d84b9c854 \
  --expected-checker-source-head <checkout-A-HEAD> \
  --review-status PASS --ci-status PASS --owner-confirms-approval true \
  --out <approval.json> \
  -- --profile staging --project finapp-staging --expected-head e1310e5314f4e6355a0fbd43eab378224044e1f6 \
  --journal <journal.jsonl> --out <executor-out.json> \
  --recipient lesenenok8787@gmail.com --recipient-confirmed-sha256 20cf29054a5a4cf524a93e821a90d245f9b4f601669f57ca663c7a7ffc7a9e54 \
  --resume false --legacy-cleanup-approved false
```
Prints `approvalSha256`. Stop condition: `APPROVAL_DRAFT_BLOCKED` → stop,
do not retry with different evidence chosen to force a pass.

**Immediately after, from checkout B**, using **`gateGaSecureExecutor.mjs`,
not `liveAcceptanceExecutor.mjs`** (see item 4's limitation):
```bash
node scripts/invitationRehearsal/gateGaSecureExecutor.mjs --execute \
  --functions-receipt <functions-receipt.json> --expected-checker-source-head <checkout-A-HEAD> \
  --profile staging --project finapp-staging --expected-head e1310e5314f4e6355a0fbd43eab378224044e1f6 \
  --approval <approval.json> --approval-sha256 <printed-value> \
  --journal <journal.jsonl> --out <executor-out.json> \
  --recipient lesenenok8787@gmail.com --recipient-confirmed-sha256 20cf29054a5a4cf524a93e821a90d245f9b4f601669f57ca663c7a7ffc7a9e54 \
  --resume false --legacy-cleanup-approved false
```
Stop condition: if the approval has expired (>1h since it was built),
rebuild from fresh evidence rather than reusing it.
`legacy-cleanup-approved false` — no old/legacy matching record is ever
deleted; only resources this run itself creates are eligible for its own
cleanup.

Result-saving order: save the executor's own `--out` and `--journal` —
already-sanitized, authoritative — as the run's evidence.

**No mailbox lookup is being requested right now.** Per this round's
instruction, the commands and the gate were made correct and verified
first; the mailbox-lookup request is deferred to a future message, after
this branch's own review.

## Security review
- No `--execute`, account creation, email, deploy, PR #28 merge, or
  production action was performed or auto-triggered this round.
- The only live network calls this round were the ones already reported
  in `evidence/invocation-log.md` (from the prior round); none were
  repeated for this fix pass.
- No secrets, tokens, service-account data, or real recipient PII beyond
  the already-known, already-authorized recipient email/hash appear in
  this report or the code.

## Данные и миграция
Нет.

## Rollback
Delete the new/modified files listed in the diff summary below, or do not
merge the branch. Nothing external was touched.

## Известные ограничения (see item 4 for full detail)
- The hard gate exists only in the new `gateGaSecureExecutor.mjs`
  entrypoint, not inside the published `liveAcceptanceExecutor.mjs`/
  `validateExecutionApproval()` itself.
- Crash-window/resume-kill/standalone-E2E regression is NOT AVAILABLE in
  this environment (Java 21+ required; see item 4).
- M1/SEC-007 functions still have no drift baseline (unchanged from the
  13fn-checker round).

## Diff summary

```text
 docs/remediation/evidence/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING/deployment-check-13fn-out.json | unchanged
 docs/remediation/evidence/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING/invocation-log.md               | corrected (item 5)
 docs/remediation/reports/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING.md                                | rewritten (this file)
 package.json                                                                                         | +3 npm scripts
 scripts/invitationRehearsal/gateGaApprovalEvidenceBindingCore.mjs                                    | strengthened (items 2, 3)
 scripts/invitationRehearsal/gateGaApprovalEvidenceBindingMutationChecks.mjs                           | expanded (8→12 mutations)
 scripts/invitationRehearsal/gateGaApprovalEvidenceBindingSelfTest.mjs                                 | rewritten (16→30 tests)
 scripts/invitationRehearsal/gateGaBuildApprovalDraft.mjs                                              | rewritten (item 1, item 3)
 scripts/invitationRehearsal/gateGaSecureExecutor.mjs                                                  | new (item 4)
 scripts/invitationRehearsal/gateGaSecureExecutorCore.mjs                                              | new (item 4)
 scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs                                          | new (item 4)
```

## Следующий разрешенный пункт

Independent review of this fix pass. After that: either (a) the owner
runs the mailbox lookup and the full playbook above, or (b) a further,
separately scoped round to wire the functions-evidence gate as a hard
requirement inside the published executor itself (item 4's stated
limitation) — neither is started here, and the mailbox lookup is not
being requested in this message per the review's explicit instruction.
