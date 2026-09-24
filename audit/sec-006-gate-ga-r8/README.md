# FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8 — audit branch

Read-only audit dump for independent review. This branch is additive only —
it does not modify `main`, PR #28, tags, or any other existing branch.

## Contents

- `FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8.zip` — the immutable R8 package as delivered.
- `SHA256SUMS.txt` — SHA-256 of every file in the package (including the zip's own unpacked copy below).
- `unpacked/` — the zip's contents extracted, for direct diff/browse without downloading:
  - `APPROVAL-R8.md` — the approval document (binding, scope, prepared fresh/resume approval pair, all 8 crash-window outcomes, legacy-cleanup gating, future `EXTERNAL_ACTION_APPROVED` template — not an active request this round).
  - `package.json`, `scripts/invitationRehearsal/**` — the full R8 source.
  - `scripts/invitationRehearsal/CODE-SHA256SUMS.txt` — the seam-integrity hash list the orchestrator itself verifies at runtime (18 files, up from R7's 16 — adds `gateGaDurableJournalCore.mjs` and `gateGaInvitationLockCore.mjs`).
  - `evidence/` — real command output: 3 full 8-scenario crash-window runs against the published commit (deterministic, all PASS), both mutation suites, typecheck/lint/E2E/resume-kill, and the diagnostic run that found the one real defect fixed during this round (see below).

## Real code, real commit

This round's code is committed for real on `execution/sec-006-gate-ga-r8`
at commit `9225846fb92567439dbecd1612c4186140a4ef65` — that is the
`--expected-head` value bound throughout `APPROVAL-R8.md`. All local
regression, both mutation suites (22/22 on the orchestrator seam, up from
17/17 in R7), a real emulator integration suite, a standalone real E2E run,
a real two-process SIGKILL-after-EMAIL_SENT resume proof, and eight real
crash-window proofs (four carried over from R7, four new — each resumed
through the literal CLI, not `runOnce()`) were all run against that exact
commit — see `unpacked/evidence/`.

## Scope: what R8 actually fixes

An independent reviewer found that R7 treated any external effect
(admin Auth created, company created, invitation created, recipient Auth
registered) that completed but was killed BEFORE the corresponding local
durable write as "never happened." R8 closes this for real, in all four
places it can occur, by narrow, exact, read-only reconciliation keyed only
by identifiers the run already deterministically owns — never a blind
retry, never a broad scan:

- **Admin + company**: `reconcileAdminAndCompany()` derives a deterministic
  `adminUid` from the run's own durable `runId` (a real fix made mid-round
  — see "real defect found and fixed" below), checks whether that Auth
  account exists, and if so reads the fixed `user_bootstrap/{adminUid}`
  bootstrap-idempotency receipt Firebase's own `createCompany` transaction
  already writes. An admin with no receipt is a provably orphaned account
  (the company transaction never committed) — cleaned up. An admin WITH a
  receipt is fully real — reconciled (a fresh Auth custom token replaces
  the never-persisted original password) and the run continues forward.
- **Invitation**: `reconcileInvitation()` point-reads the deterministic
  `invitationLocks/{lockId}` document (the same id `functions/src`'s own
  `computeInvitationLockId(companyId, emailNormalized)` computes — mirrored
  byte-for-byte in `gateGaInvitationLockCore.mjs`). The raw invitation
  token is never persisted anywhere (SEC-006 design), so a found invitation
  can never be resumed into accept — it is reconciled into the ledger and
  cleaned up instead.
- **Recipient Auth uid**: when a `MAY_BE_SENT` checkpoint has no recorded
  `recipientUid`, `findAuthUidByEmail()` resolves it by the single
  owner-confirmed recipient email, durably records it (closing the gap for
  good), then treats it exactly as an already-known uid — cleaned up.

Also in this round:

- **ACL**: the private checkpoint/manifest/journal directory is now created
  with its Windows security descriptor applied by the SAME
  `[System.IO.Directory]::CreateDirectory(path, security)` call that
  creates it — no more `New-Item`-then-`Set-Acl` window where the
  directory briefly exists with default permissions. The verifier now also
  checks `FullControl` rights and the exact inheritance/propagation flags
  (a rule missing `ContainerInherit`+`ObjectInherit` would silently stop
  protecting files created inside it), and requires exactly the three
  intended principals — no more, no fewer.
- **Journal**: replaced the single growing JSONL file (R7) — where a kill
  exactly mid-write could leave a truncated final line that blocked an
  otherwise fully recoverable resume — with a directory of one immutable,
  atomically-written file per event (`gateGaDurableJournalCore.mjs`). A
  stray `.tmp-*` file from an interrupted write never matches the final
  naming pattern and is simply ignored on replay.
- **Eight** real, two-process, literal-CLI crash-window proofs (R7's four
  plus four new), each independently re-verified for zero remainder,
  confirmed deterministic across three consecutive full runs.

## Real defect found and fixed during this round

The first full run of the four new crash-window scenarios (kept as
`evidence/crash-windows-diagnostic-run-found-runid-bug.txt`) caught a real
bug: `reconcileAdminAndCompany()`'s deterministic `adminUid` was originally
derived from `runTag` — a per-CLI-invocation, ephemeral resource-naming
tag regenerated fresh on every process (including a resume). Process 2
(the literal CLI resume) therefore looked for a DIFFERENT adminUid than
process 1 had created, and the `ADMIN_AND_COMPANY_CREATED_PRE_MANIFEST`
scenario failed (reconciliation reported "not found" even though the
admin+company were real). Fixed by deriving `adminUid`/`adminEmail` from
the orchestrator's own durable `runId` instead (shared and stable across
both processes by construction), passed explicitly into
`createAdminAndCompany({ runId, ... })` and
`reconcileAdminAndCompany({ runId })`. `gateGaResumeKillTest.mjs`'s own
admin-uid detection (`uid.endsWith('-admin')`) was updated to match the
new `gaadm-<hash>` naming. All three subsequent full runs (in
`evidence/`) confirm the fix: 8/8 PASS, deterministic.

## Integrity

Every file's SHA-256 is listed in `SHA256SUMS.txt`. The zip was scanned
before publication for private keys, API keys, tokens, passwords (including
the CSPRNG recipient/admin passwords, which must never leave the private
checkpoint file or the ephemeral in-memory admin sign-in) and real email
addresses — none were found; all matched patterns are self-test fixtures
using synthetic `@example.invalid` placeholder values.
