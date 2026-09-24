# APPROVAL-R8 — FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8

This document is prepared as part of the R8 package for independent review.
It is **not** an active request — per the current round's explicit
instruction, staging is not run and `RECIPIENT` / `EXTERNAL_ACTION_APPROVED`
are not requested at this stage. It documents exactly what a future
staging execution would look like, bound to this round's reviewed code.

## 1. Binding

- Execution commit (`execution/sec-006-gate-ga-r8`): `9225846fb92567439dbecd1612c4186140a4ef65`
- `CODE-SHA256SUMS.txt` SHA-256: `6781d7d759dc2f8fd42602afaf819825bca45b1fd37d705a2317d1bcc67e5be7`
- Base commit (unchanged `main` ancestor): `c84f7837bdbc0a27fea698080c779d273e8e15bb`
- Task label bound into every approval command hash: `FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8 live orchestrated execution` (`GATE_GA_TASK` in `liveAcceptanceExecutorCliCore.mjs`)

## 2. Scope of this round

R8 closes the real windows an independent reviewer found after R7: an
external effect (admin Auth created, company created, invitation created,
recipient Auth registered) can complete for real and then the process can
be killed before the corresponding LOCAL durable write ever records it.
R7 treated every one of these as "never happened" on resume; R8 instead
performs a narrow, exact, read-only reconciliation keyed only by
identifiers this exact run already deterministically owns, and either
safely continues (admin+company both found) or safely cleans up
(orphaned admin; invitation found but its raw token — never persisted —
is unrecoverable; recipient Auth found but its uid was never durably
recorded).

Also in this round:
- The private-directory ACL is now created atomically
  ([System.IO.Directory]::CreateDirectory(path, security) in one Win32
  call) instead of New-Item-then-Set-Acl, closing the window where the
  directory briefly existed with default permissions. The verifier now
  also checks FullControl rights and the exact inheritance/propagation
  flags, and requires exactly the three intended principals — no more, no
  fewer.
- The journal is now a crash-safe directory of one immutable,
  atomically-written file per event, replacing the single growing file a
  kill could truncate mid-write.
- Four new real, two-process, literal-CLI crash-window proofs (in addition
  to R7's four), covering exactly the windows above.

## 3. Owner action / wait time

None, for this round — no email is sent to a real inbox and no owner
click is required outside the automated emulator test harness (which
simulates it deterministically via the Auth Emulator's REST API).

## 4. Exact fresh launch command (staging profile, for future reference)

```text
node scripts/invitationRehearsal/liveAcceptanceExecutor.mjs --execute \
  --profile staging --project finapp-staging \
  --expected-head 9225846fb92567439dbecd1612c4186140a4ef65 \
  --approval <path-to-reviewed-approval.json> --approval-sha256 <sha256-of-that-file> \
  --journal <new-private-file-path> --out <new-private-file-path> \
  --recipient <owner-provided-email> --recipient-confirmed-sha256 <sha256-of-lowercased-trimmed-email> \
  --resume false --legacy-cleanup-approved false
```

## 5. Prepared resume-approval pair (item 5, unchanged pattern from R7)

`gateGaCrashWindowsCliTest.mjs`'s `generateApprovalPair()` builds BOTH a
`--resume false` (fresh) and `--resume true` (resume) approval from the
SAME reviewed decision (sourceHead, recipient, legacyCleanupApproved) in
one call, before any external action — the resume approval's `--out` path
is pre-decided at that same moment, never improvised after a crash. Only
the resume approval is exercised by the four new crash-window tests
(process 1 always runs fresh via `runOnce()`, never through the CLI —
only the process-2/resume step is required to be the literal CLI, per the
original R7 requirement), but both are generated to prove the pairing
mechanism itself stays intact under R8's changes.

## 6. What happens at each interruption point (all 8, real, proven)

| # | Checkpoint | External effect at kill | Resume outcome |
|---|---|---|---|
| 1 | `ADMIN_CREATED` | admin+company confirmed (manifest written) | SAFE_STOP after invite-indeterminate check, cleanup removes admin+company |
| 2 | `RECIPIENT_REGISTERED` | recipient uid durably recorded | SAFE_STOP (email indeterminate), cleanup removes admin+company+invite+recipient |
| 3 | `EMAIL_SENT_PENDING_CHECKPOINT` | email WAS dispatched, SENT checkpoint not yet written | SAFE_STOP, cleanup removes admin+company+invite+recipient (email correctly never re-sent) |
| 4 | `EMAIL_SENT_CHECKPOINTED` | SENT checkpoint durable | PASS — full resume through verification/accept |
| 5 | `ADMIN_AUTH_CREATED_PRE_COMPANY` | admin Auth real, company never created | SAFE_STOP, orphaned admin reconciled and cleaned up |
| 6 | `ADMIN_AND_COMPANY_CREATED_PRE_MANIFEST` | admin+company real, manifest never recorded it | **PASS** — reconciled and the run continues all the way forward |
| 7 | `INVITE_CREATED_PRE_MANIFEST` | invitation real, manifest never recorded it | SAFE_STOP — found via the deterministic lock, reconciled into the ledger and cleaned up (raw token never persisted, so accept can never be resumed) |
| 8 | `RECIPIENT_REGISTERED_PRE_UID_CHECKPOINT` | recipient Auth real, checkpoint never recorded its uid | SAFE_STOP — recovered by exact email lookup, durably recorded, then cleaned up |

Every scenario: at most one real email ever sent, exactly one runId, zero
independently-verified remainder. Confirmed real and deterministic across
three consecutive runs of all 8 scenarios against this exact commit.

## 7. Legacy-cleanup gating

Unchanged from R6/R7: `legacyCleanupApproved` is the only thing that may
ever authorize legacy-residual deletion, bound to the reviewed approval
document, never a test-only flag.

## 8. Future EXTERNAL_ACTION_APPROVED block (template, not active)

```text
EXTERNAL_ACTION_APPROVED: FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8
ENVIRONMENT: staging
RECIPIENT: <owner-provided-email>
```
