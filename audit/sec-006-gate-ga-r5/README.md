# FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R5 — audit branch

Read-only audit dump for independent review. This branch is additive only —
it does not modify `main`, PR #28, tags, or any other existing branch.

## Contents

- `FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R5.zip` — the immutable R5 package as delivered.
- `APPROVAL-R5.md` — the approval document (owner action, wait time, exact launch command, timeout/resume behavior, no-resend guarantee, next `EXTERNAL_ACTION_APPROVED` block).
- `SHA256SUMS.txt` — SHA-256 of the zip, the approval document, and every unpacked file below.
- `unpacked/` — the zip's contents extracted, for direct diff/browse without downloading.

## Scope

Scope was strictly limited to owner-in-the-loop email verification (fixing the
confirmed R4 blocker: staging `completeVerification` always threw). No
staging/production execution, no real email, and no other changes were made
as part of this package. See `APPROVAL-R5.md` for what real execution
requires.

## Integrity

Every file's SHA-256 is listed in `SHA256SUMS.txt`. The zip itself was
scanned before publication for private keys, API keys, tokens, passwords and
real email addresses — none were found; all matched patterns are self-test
fixtures using synthetic placeholder values.
