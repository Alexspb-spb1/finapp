# FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R5 — approval document

Scope of this hotfix: **owner-in-the-loop email verification only** — the
confirmed R4 blocker (`completeVerification` always threw, so no staging run
could ever reach `PASS`) is fixed. Nothing else changed: the flow, the
cleanup logic, the recipient/run-id/legacy-residual guards, and the CLI
approval schema (`GATE_GA_TASK`, limits) are exactly the R4 shapes, unchanged.

## 1. What the owner must do (single manual action)

Once the run below is launched, it will:
1. Create the admin + company (real staging Firestore/Auth writes).
2. Register the recipient's Auth account.
3. Send **exactly one** real verification email to the recipient's mailbox,
   durably checkpointed *before* the send call — the send can never be
   silently repeated, even across a crash or a manual restart of this same
   command.
4. Wait, polling Firebase Auth's `emailVerified` flag every 5 seconds, for
   up to 10 minutes.

**The owner's one required action: open that one email and click the real
verification link, within the 10-minute window.** Nothing else — no
approving a second time, no re-running anything. The moment the link is
clicked, the next poll (within 5 seconds) detects it and the run
automatically continues to acceptance, idempotency replay, cleanup, and a
final `PASS`.

## 2. Wait time / polling parameters

- Deadline: **10 minutes** (`verificationDeadlineMs = 600000`).
- Poll interval: **5 seconds** (`verificationIntervalMs = 5000`).
- These are the orchestrator's compiled-in defaults
  (`gateGaOrchestratorCore.mjs`); the CLI does not expose flags to change
  them, so the owner does not need to pass anything extra.

## 3. Exact staging launch command

```bash
node scripts/invitationRehearsal/liveAcceptanceExecutor.mjs --execute \
  --profile staging --project finapp-staging \
  --expected-head <reviewed-40-char-SHA> \
  --approval <existing-absolute-private-JSON> \
  --approval-sha256 <exact-SHA256-of-that-file> \
  --journal <new-absolute-private-JSONL-path> \
  --out <new-absolute-private-JSON-path> \
  --recipient <owner-confirmed-recipient-email> \
  --recipient-confirmed-sha256 <sha256-of-lowercased-trimmed-recipient>
```

`--approval`, `--journal`, `--out` must all be **absolute paths outside the
repository** (never inside `finapp-staging`'s working tree) —
`validatePrivateExecutorPaths` refuses the run otherwise, before any network
call. `--journal` and `--out` must not already exist; `--approval` must
already exist and be a real, non-symlinked file.

## 4. Timeout / restart behavior

- **If the owner never clicks within 10 minutes**: the run ends
  `SAFE_STOP`, with the reason `verification_not_completed:TIMEOUT` in the
  journal. Cleanup of everything this run created (admin, company,
  invitation, the recipient's Auth account) still runs and is
  independently verified (`CLEANUP_COMPLETE_VERIFIED`) before the process
  exits — nothing is left behind just because the owner was too slow.
- **If the process (or machine) is restarted after the email was sent but
  before verification completed**: re-running the *exact same* command
  (same recipient, same private `--journal`/`--out` paths pointed at the
  same directory as before) resumes from the durable on-disk checkpoint —
  it does **not** register the recipient again and does **not** send a
  second email. It re-establishes the recipient's session, resumes polling
  immediately, and reaches a real `PASS` once the (still pending, or
  already-clicked) verification is detected. This exact resume path is
  proven for real against the Firestore/Auth emulators in
  `evidence/cli-e2e-out.json`'s companion scenarios and in
  `gateGaOrchestratorSelfTest.mjs`'s dedicated resume tests (deterministic,
  using the same on-disk checkpoint file format, not mocked).
- **If the send outcome is indeterminate** (the process died between
  claiming the durable "may-be-sent" checkpoint and confirming the send
  succeeded): the run refuses to guess and refuses to resend — it stops
  `SAFE_STOP` with `EMAIL_SEND_INDETERMINATE` in the journal, and cleans up
  whatever it had already created. A human must inspect
  `email-checkpoint-<recipientSha256>.json` in the private claim directory
  before deciding whether to manually resend.
- **A late click after cleanup already deleted the recipient's Auth
  account cannot resurrect it** — empirically confirmed against the real
  Auth emulator (`INVALID_OOB_CODE` on submitting the old code after
  deletion; see the R5 final report's evidence section).

## 5. No-resend guarantee

At most **one** verification email is ever sent for a given recipient,
across the entire lifetime of the on-disk checkpoint file
(`email-checkpoint-<sha256(recipient)>.json` in the run's private claim
directory) — enforced by an exclusive (`wx`) durable file claim taken
*before* the send call, not by an in-memory counter. This holds across:
process crashes, manual restarts of the same command, and repeated full
runs for the same recipient (a second full run resumes from the durable
`VERIFIED` checkpoint and reaches `PASS` without registering or sending
again).

## 6. Exact future `EXTERNAL_ACTION_APPROVED` block

When the owner is ready to authorize the real staging run:

```text
EXTERNAL_ACTION_APPROVED: FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R5
ENVIRONMENT: staging
RECIPIENT: <owner-confirmed real mailbox address you will personally check>
```

On receiving that block, the exact next steps are:
1. Confirm the current staging HEAD and CI/review status for real (not
   from memory), and generate the private approval JSON
   (`task: 'FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R4 live orchestrated
   execution'` — the task name is intentionally unchanged from R4, since
   the approval *schema* did not change in this hotfix) bound to that head
   and to `sha256(RECIPIENT.trim().toLowerCase())`.
2. Run the exact command in §3.
3. Stay reachable to open the one verification email within the 10-minute
   window in §1–2.
4. Report back the single resulting `PASS` or `SAFE_STOP` — no
   intermediate status messages.
