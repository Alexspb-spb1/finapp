# FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R6 — approval document

## 0. Binding

- **Execution commit (`--expected-head`)**: `f2d4f8059c064ce5526ad7b0d3e4daff4a4ce8bd`
  Branch `execution/sec-006-gate-ga-r6`, based on the same source head every
  gate-G-A round has used (`c84f7837bdbc0a27fea698080c779d273e8e15bb`).
  `git status` on this commit is clean; it was independently rebuilt in a
  fresh clone (junctioned `node_modules`, no reuse of the working checkout)
  and the full local regression, both mutation suites, and a real emulator
  integration suite + standalone E2E + two-process kill/resume test + a
  literal CLI invocation all ran **against this exact commit**, not the
  working tree.
- **Package source of truth**: `scripts/invitationRehearsal/CODE-SHA256SUMS.txt`
  (15 files, sha256sum format) — verified by `verifyPackageIntegrity()`
  before any adapter or network call, every run.
- **ZIP SHA-256 / size**: see the final report (computed after this document
  was placed inside the package, so it cannot self-reference its own hash).

## 1. Scope of this round (what changed since R5)

R5 shipped owner-in-the-loop email verification. Live testing against real
emulators and a fresh security pass surfaced further real gaps, all fixed
here:

1. **`recipientPreflight`** used the client API-key `accounts:lookup`
   endpoint, which does not support arbitrary-email lookup — it would have
   failed against real staging. Fixed to the admin OAuth
   `projects/{PROJECT}/accounts:lookup`. A source-level negative test
   forbids the old call from ever reappearing.
2. **Secrets**: both the admin and recipient passwords are now CSPRNG
   (`node:crypto.randomBytes`), not `Math.random()` or a value deterministically
   derived from the recipient's email. The recipient's password is generated
   once and persisted **only** in the private, durable, git-ignored email
   checkpoint file (mode `0o600`, outside the repository) — never in the
   journal, the result JSON, logs, or any published ZIP. A source-level
   secret-scan test asserts no `journal.append` call ever references it.
3. **True run-level resume**: a durable run manifest
   (`gateGaRunManifestCore.mjs`) is claimed before the first external write
   and updated at each confirmed phase boundary (admin+company created,
   invitation created). `--resume true` continues the SAME run (same runId,
   same admin/company/invitation identifiers, same ledger) instead of
   creating a second, orphaned set of resources. Proven for real: a genuine
   second OS process, started fresh with `--resume true`, after the FIRST
   process was `SIGKILL`ed the instant its email was durably marked sent.
4. **CLI `--resume`**: an explicit `true`/`false` flag, bound into the
   approval's `commandSha256`. `--resume true` requires the journal from the
   prior invocation to already exist at that exact path (the "consistent
   existing state/journal pair"); `--resume false` requires it to NOT exist.
   Corrupted or incomplete local state (missing/corrupt run manifest, a
   run-id claim that doesn't match the manifest, a manifest for a different
   recipient/project/profile) is refused with **zero new adapter calls of
   any kind** — not even a read.
5. **Verification**: the normalized recipient email is now actually passed
   as `expectedEmail` to the polling loop — previously computed nowhere,
   so a `emailVerified:true` report for the right uid but a **different**
   email would have been silently accepted. Now refused as `EMAIL_MISMATCH`.
6. **Legacy residue**: a separate, explicit `legacyCleanupApproved`
   boolean, bound into the approval JSON's `limits` (replacing the old
   fixed-`true` `legacyCleanupRequiresSeparateConfirmation` documentation
   flag) and into the CLI's `--legacy-cleanup-approved` flag — both must
   agree exactly. A mismatched inventory is never eligible for cleanup
   regardless. An **eligible-but-unapproved** residual now gets its own
   status, `PENDING_APPROVAL`, and is explicitly excluded from "legacy
   clean" in the final decision — it can no longer be silently counted as
   clean, and a full `PASS` is impossible until it is either resolved as
   ineligible or actually cleaned with approval.
7. **Identifiers**: `GATE_GA_TASK` is now
   `'FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R6 live orchestrated execution'`.
   No approval shaped for R4/R5/the historical CLEANUP_PLAN_ONLY task can
   drive an execute() call through this file — exact string match, by
   construction.

## 2. Owner action / wait time / timeout — unchanged from R5

The single owner action (opening the one real verification email and
clicking the link), the 10-minute default deadline, and the 5-second poll
interval are unchanged. See §3 for the updated exact command (new flags).

## 3. Exact staging launch command

```bash
node scripts/invitationRehearsal/liveAcceptanceExecutor.mjs --execute \
  --profile staging --project finapp-staging \
  --expected-head f2d4f8059c064ce5526ad7b0d3e4daff4a4ce8bd \
  --approval <existing-absolute-private-JSON> \
  --approval-sha256 <exact-SHA256-of-that-file> \
  --journal <absolute-private-JSONL-path> \
  --out <new-absolute-private-JSON-path> \
  --recipient <owner-confirmed-recipient-email> \
  --recipient-confirmed-sha256 <sha256-of-lowercased-trimmed-recipient> \
  --resume false --legacy-cleanup-approved false
```

## 4. Resume after a real interruption

If the process (or machine) is killed or restarted after the email was
sent but before the run finished, re-run the **exact same command** with
two changes:
- `--resume true`
- `--journal` pointed at the **same file** as the interrupted run (it must
  already exist — this is what lets the CLI find and validate the same
  run manifest and email checkpoint)
- `--out` must be a **new** path (never reused)

This resumes the SAME run — same admin, same company, same invitation, and
(if the email was already sent) no second email — and continues straight
into polling for the owner's verification. If admin/company creation, or
invitation creation, was never confirmed complete before the interruption,
the resumed run refuses to guess and `SAFE_STOP`s with zero new writes
(cleaning up only what was actually confirmed created).

## 5. No-resend guarantee — unchanged from R5

At most one verification email is ever sent for a given recipient, enforced
by an exclusive durable file claim taken before the send call.

## 6. Legacy residual cleanup — now separately gated

`--legacy-cleanup-approved true` (and a matching `limits.legacyCleanupApproved: true`
in the approval JSON) is required before any legacy-residual deletion is
even attempted. Without it, an eligible residual is left untouched and the
run cannot reach a full `PASS` — it is reported as `PENDING_APPROVAL`, a
distinct, disclosed state, never silently treated as clean.

## 7. Exact future `EXTERNAL_ACTION_APPROVED` block

```text
EXTERNAL_ACTION_APPROVED: FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R6
ENVIRONMENT: staging
RECIPIENT: <owner-confirmed real mailbox address you will personally check>
LEGACY_CLEANUP_APPROVED: <true|false — your explicit decision>
```

On receiving that block: confirm the current staging HEAD and CI/review
status for real, generate the private approval JSON bound to
`f2d4f8059c064ce5526ad7b0d3e4daff4a4ce8bd` (or a later reviewed commit on
this same branch) and to `sha256(RECIPIENT.trim().toLowerCase())`, with
`limits.legacyCleanupApproved` matching your stated decision exactly, run
the command in §3, stay reachable for the one verification email, and
report back the single resulting `PASS` or `SAFE_STOP`.
