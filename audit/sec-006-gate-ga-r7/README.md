# FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R7 — audit branch

Read-only audit dump for independent review. This branch is additive only —
it does not modify `main`, PR #28, tags, or any other existing branch.

## Contents

- `FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R7.zip` — the immutable R7 package as delivered.
- `APPROVAL-R7.md` — the approval document (execution commit binding, owner action, wait time, exact launch command, fresh+resume approval pairing, legacy-cleanup gating, next `EXTERNAL_ACTION_APPROVED` block).
- `SHA256SUMS.txt` — SHA-256 of the zip, the approval document, and every unpacked file below.
- `unpacked/` — the zip's contents extracted, for direct diff/browse without downloading.

## Real code, real commit

This round's code is also committed for real on `execution/sec-006-gate-ga-r7`
at commit `2f81b1dc7a7cb5316395dbf1c40b502a9296f716` — that is the
`--expected-head` value bound throughout `APPROVAL-R7.md`. All local
regression, both mutation suites (17/17 on the orchestrator seam), a real
emulator integration suite, a standalone real E2E run, a real two-process
SIGKILL-after-EMAIL_SENT resume proof, four real crash-window proofs (each
resumed through the literal CLI, not `runOnce()`), and a literal CLI
invocation were all run against that exact commit — see `unpacked/evidence/`.

## Scope

Fixes real gaps found after R6: `.gitignore` restored (a prior clone
accidentally clobbered it), a Windows ACL guard locking the private
checkpoint/manifest directory down to exactly the current user + SYSTEM +
Administrators before any secret is ever written, crash-atomic (temp+rename)
checkpoint updates, `recipientUid` durably recorded before the send attempt
so that exact crash window is recoverable, resume now also validates
`sourceHead` and fully replays the existing journal (continuing its
sequence numbers), fresh/resume approvals prepared together in advance, and
four real crash-window proofs through the literal CLI.

## Integrity

Every file's SHA-256 is listed in `SHA256SUMS.txt`. The zip was scanned
before publication for private keys, API keys, tokens, passwords (including
the CSPRNG recipient password, which must never leave the private
checkpoint file) and real email addresses — none were found; all matched
patterns are self-test fixtures using synthetic placeholder values.
