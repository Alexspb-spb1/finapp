# FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R6 — audit branch

Read-only audit dump for independent review. This branch is additive only —
it does not modify `main`, PR #28, tags, or any other existing branch.

## Contents

- `FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R6.zip` — the immutable R6 package as delivered.
- `APPROVAL-R6.md` — the approval document (execution commit binding, owner action, wait time, exact launch command, resume behavior, legacy-cleanup gating, next `EXTERNAL_ACTION_APPROVED` block).
- `SHA256SUMS.txt` — SHA-256 of the zip, the approval document, and every unpacked file below.
- `unpacked/` — the zip's contents extracted, for direct diff/browse without downloading.

## Real code, real commit

This round's code is also committed for real on `execution/sec-006-gate-ga-r6`
at commit `f2d4f8059c064ce5526ad7b0d3e4daff4a4ce8bd` — that is the
`--expected-head` value bound throughout `APPROVAL-R6.md`. All local
regression, both mutation suites, the real emulator integration suite, a
standalone real emulator E2E run, a real two-process SIGKILL-after-EMAIL_SENT
resume proof, and a literal CLI invocation were run against that exact
commit, not just the working tree — see `unpacked/evidence/`.

## Scope

Fixes real gaps found after R5: the recipient-lookup endpoint (client
API-key call replaced with admin OAuth), CSPRNG secrets (previously
`Math.random()`/derived), true whole-flow resume (previously only the email
step resumed), `expectedEmail` actually enforced during verification, and
explicit `legacyCleanupApproved` gating (previously an eligible-but-unconfirmed
legacy residual could be silently counted as clean).

## Integrity

Every file's SHA-256 is listed in `SHA256SUMS.txt`. The zip was scanned
before publication for private keys, API keys, tokens, passwords (including
the new CSPRNG recipient password, which must never leave the private
checkpoint file) and real email addresses — none were found; all matched
patterns are self-test fixtures using synthetic placeholder values.
