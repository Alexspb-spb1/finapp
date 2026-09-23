# FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R7 — approval document

## 0. Binding

- **Execution commit (`--expected-head`)**: `2f81b1dc7a7cb5316395dbf1c40b502a9296f716`
  Branch `execution/sec-006-gate-ga-r7`, based on the same source head every
  gate-G-A round has used (`c84f7837bdbc0a27fea698080c779d273e8e15bb`).
  `git status` on this commit is clean; it was independently rebuilt in a
  fresh clone (junctioned `node_modules`, no reuse of the working checkout,
  `.gitignore` left byte-identical to the base commit). The full local
  regression, both mutation suites, a real emulator integration suite, a
  standalone real E2E run, the real two-process kill/resume proof, four real
  crash-window proofs (each resumed through the literal CLI), and a literal
  CLI invocation all ran **against this exact commit**.
- **Package source of truth**: `scripts/invitationRehearsal/CODE-SHA256SUMS.txt`
  — SHA-256 of that file itself: `d8177592949ded73ef720c53b0f7a018eff95e14e5f9585b75c4e9272cb33fbc`
  (16 files — R7 adds `gateGaPrivateDirAclCore.mjs` to the tracked,
  integrity-checked seam). Verified before any adapter or network call,
  every run.
- **ZIP SHA-256 / size**: see the final report (computed after this
  document was placed inside the package).

## 1. Scope of this round (what changed since R6)

1. **`.gitignore` fully restored** to the `c84f7837` baseline. No separate
   `node_modules` rule was ever needed — the bare `node_modules` pattern
   already there covers it.
2. **Private-directory Windows ACL**: before any checkpoint or manifest
   file is ever written — before any Auth user is created, before any email
   is sent — the run's private claim/checkpoint directory is locked down:
   inheritance disabled, exactly `{current user, SYSTEM, BUILTIN\Administrators}`
   granted, verified by SID (not localized account name). Every
   checkpoint/manifest file write is followed by a per-file ACL verification.
   An ACL failure at any point is a hard `SAFE_STOP` before any external
   action (`gateGaPrivateDirAclCore.mjs`).
3. **Checkpoints are now crash-atomic**: every UPDATE (not the first claim,
   which was already a safe exclusive create) uses a temp-file-then-rename
   swap, never `open(path, 'w')` in place. `recipientUid` is now durably
   recorded immediately after registration — **before** the verification
   email is even attempted — so a crash in that exact window is recoverable:
   resume sees the known uid and adds it to the cleanup ledger rather than
   leaving it outside the ledger. A `MAY_BE_SENT` checkpoint found on resume
   still never triggers a second send, but if it carries a known
   `recipientUid` that account is deleted as part of cleanup.
4. **Resume validates more, and continues sequence numbers**: the run
   manifest match now also checks `sourceHead` (previously only
   project/profile/recipient were checked). The existing journal file is
   fully read and validated line-by-line before the orchestrator runs; a
   malformed line refuses immediately, with zero new writes. A valid
   journal's events seed the resumed run's in-memory journal, so appended
   entries continue the `seq` numbering instead of restarting at 0.
5. **Fresh and resume approvals are prepared together, in advance**, from
   the same reviewed decision — the resume approval's `--out` path is
   pre-decided at preparation time, never improvised after a crash (see §3–4
   and the pairing helper in `gateGaCrashWindowsCliTest.mjs`).
6. **Four real crash-window proofs**, each with process 2 (the resume)
   launched as the literal CLI, not `runOnce()`: kill after admin+company
   created, kill after recipient registered, kill after the email was
   actually dispatched but before the SENT checkpoint was written (the
   genuinely indeterminate window this round closes), and kill after the
   SENT checkpoint (repeating R6's proof, but now through the literal CLI
   resume path). Each kill point is exact — the orchestrator `await`s the
   checkpoint hook, and the test's hook freezes the process there before
   signaling for the kill, rather than racing an in-process timing window.
7. **Identifiers**: `GATE_GA_TASK` is now
   `'FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R7 live orchestrated execution'`.
   The last remaining stray `PACKAGE-R4` comments (in
   `liveAcceptanceExecutor.mjs`, `liveAcceptanceExecutorAdapters.mjs`,
   `liveAcceptanceExecutorRuntime.mjs`) are corrected.

## 2. Owner action / wait time — unchanged from R5/R6

The single owner action (opening the one real verification email and
clicking the link), the 10-minute default deadline, and the 5-second poll
interval are unchanged.

## 3. Exact staging launch command (fresh)

```bash
node scripts/invitationRehearsal/liveAcceptanceExecutor.mjs --execute \
  --profile staging --project finapp-staging \
  --expected-head 2f81b1dc7a7cb5316395dbf1c40b502a9296f716 \
  --approval <fresh-approval-JSON> --approval-sha256 <its-SHA256> \
  --journal <new-absolute-private-JSONL-path> \
  --out <new-absolute-private-JSON-path> \
  --recipient <owner-confirmed-recipient-email> \
  --recipient-confirmed-sha256 <sha256-of-lowercased-trimmed-recipient> \
  --resume false --legacy-cleanup-approved false
```

## 4. Prepared in advance: the resume approval (item 5)

At the same time the fresh approval above is generated, a SECOND, resume
approval is generated from the identical reviewed decision — same
`sourceHead`, same recipient, same `legacyCleanupApproved` — differing only
in `--resume: true` and a pre-decided, distinct `--out` path:

```bash
node scripts/invitationRehearsal/liveAcceptanceExecutor.mjs --execute \
  --profile staging --project finapp-staging \
  --expected-head 2f81b1dc7a7cb5316395dbf1c40b502a9296f716 \
  --approval <resume-approval-JSON, prepared alongside the fresh one> \
  --approval-sha256 <its-SHA256> \
  --journal <the SAME --journal path as the fresh command above — it must already exist> \
  --out <a NEW, different, already-decided path> \
  --recipient <same recipient> --recipient-confirmed-sha256 <same hash> \
  --resume true --legacy-cleanup-approved false
```

If the fresh run completes cleanly, this resume approval is simply never
used. If the process (or machine) is killed or restarted at any point, this
exact, already-approved command is what re-runs it — no approval editing,
no improvisation, at any hour.

## 5. What happens at each interruption point (proven for real, §evidence)

- **Before admin/company creation was confirmed**: resume refuses (nothing
  external was confirmed created yet — nothing to clean up).
- **After admin+company, before invitation**: resume refuses to guess
  whether invitation creation completed; cleans up the admin/company that
  WAS confirmed.
- **After the recipient was registered, before the email was sent**: resume
  refuses to guess whether the send was attempted; cleans up the
  registered recipient account (never emails it).
- **After the email was actually sent, before the SENT checkpoint was
  durably written**: resume still refuses to guess and never resends —
  even though a real email did go out, the system correctly cannot
  distinguish this from "never attempted" purely from the checkpoint, so it
  SAFE_STOPs and cleans up everything, including the recipient account.
  (This is the one window where a real email was sent but the run still
  ends `SAFE_STOP` rather than `PASS` — disclosed here explicitly, not a
  defect: guessing "resend" or "don't resend" from ambiguous state is
  exactly what this design refuses to ever do.)
- **After the SENT checkpoint was durably written**: resume continues
  straight into polling for the owner's verification and reaches a real
  `PASS` once verified — no second email, same admin/company/invitation.

Each of these four windows is proven by a real `SIGKILL` of a real process
and a real resume through the literal CLI — see
`evidence/crash-windows-test-output.txt` in this package.

## 6. Legacy residual cleanup — unchanged from R6

`--legacy-cleanup-approved true` (matching `limits.legacyCleanupApproved: true`
in the approval) is required before any legacy-residual deletion is even
attempted.

## 7. Exact future `EXTERNAL_ACTION_APPROVED` block

```text
EXTERNAL_ACTION_APPROVED: FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R7
ENVIRONMENT: staging
RECIPIENT: <owner-confirmed real mailbox address you will personally check>
LEGACY_CLEANUP_APPROVED: <true|false — your explicit decision>
```

On receiving that block: confirm the current staging HEAD and CI/review
status for real, generate the fresh **and** resume approval JSON pair
bound to `2f81b1dc7a7cb5316395dbf1c40b502a9296f716` (or a later reviewed
commit on this same branch) and to `sha256(RECIPIENT.trim().toLowerCase())`,
with `limits.legacyCleanupApproved` matching your stated decision exactly,
run the fresh command in §3, stay reachable for the one verification email,
and report back the single resulting `PASS` or `SAFE_STOP` — using the
pre-prepared resume command from §4 only if an interruption actually
happens.
