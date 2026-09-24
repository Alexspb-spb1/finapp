# FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9 — audit branch

Read-only audit dump for independent review. This branch is additive only —
it does not modify `main`, PR #28, tags, or any other existing branch.

## Contents

- `FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9.zip` — the immutable R9 package as delivered.
- `SHA256SUMS.txt` — SHA-256 of every file in the package.
- `unpacked/` — the zip's contents extracted, for direct diff/browse without downloading:
  - `APPROVAL-R9.md` — binding, scope, and full crash-window results (not an active staging request).
  - `package.json`, `scripts/invitationRehearsal/**` — the full R9 source.
  - `scripts/invitationRehearsal/CODE-SHA256SUMS.txt` — the seam-integrity hash list the orchestrator verifies at runtime (19 files, up from R8's 18 — adds `gateGaAdminIdentityCore.mjs`).
  - `evidence/` — real command output: the crash-window run that found an unrelated I/O-contention false failure and the two clean 8/8 confirmations that followed, both mutation suites (staging-adapters, orchestrator, module), typecheck/lint/staging-adapters-core-self-test/E2E/resume-kill.

## Real code, real commit

This round's code is committed for real on `execution/sec-006-gate-ga-r9`
at commit `acd3021b18e17a55aa71f54a2c2b2399f6711309` — that is the
`--expected-head` value bound throughout `APPROVAL-R9.md`. All local
regression, three mutation suites (12/12 module, 23/23 orchestrator — up
from 22 — and the NEW 9/9 staging-adapters suite), a real emulator
integration suite, a standalone real E2E run, a real two-process
SIGKILL-after-EMAIL_SENT resume proof, and eight real crash-window
proofs were all run against this exact commit — see `unpacked/evidence/`.

## Scope: what R9 actually fixes

An independent audit of R8 found its real blocker: R8's recovery logic
(closing crash windows between an external effect completing and the local
durable write recording it) was implemented ONLY in `gateGaEmulatorAdapters.mjs`
— the emulator twin. The REAL staging adapter, `gateGaStagingAdapters.mjs`
(the one that would actually run against real staging), still used R7's
ephemeral per-process `runTag` for admin identity, had no
`reconcileAdminAndCompany`/`reconcileInvitation`/`findAuthUidByEmail` at
all, and `inviteRecipient` hardcoded `lockPath: null` — meaning neither a
fresh invitation's lock document nor its cleanup were ever real for
staging, and the emulator crash-tests proved nothing about the staging
code path.

R9 closes this for real, in `gateGaStagingAdapters.mjs` itself:

- **Deterministic admin identity by `runId`** (never `runTag`), via a
  single function shared with the emulator adapter
  (`gateGaAdminIdentityCore.mjs`). Since Identity Toolkit's
  `accounts:signUp` can never be given a caller-chosen uid, staging
  derives a deterministic EMAIL and recovers the real, server-assigned uid
  by exact lookup — reconciliation resets the admin's password via the
  same Admin-level `accounts:update` endpoint already used for
  `emailVerified`, never needing the original.
- **`reconcileAdminAndCompany`**, **`reconcileInvitation`** (point-read of
  the deterministic `invitationLocks/{lockId}` — the same id
  `functions/src`'s own `computeInvitationLockId` computes), and
  **`findAuthUidByEmail`** — all real, all against the guarded OAuth REST
  client, none against the public API-key surface.
- **`inviteRecipient`** now returns a real, non-null `lockPath` — normal
  cleanup now actually removes the lock document too.
- A real bug this round's OWN testing found and fixed:
  `firestoreValueToPlain` never recursed into nested Firestore `mapValue`
  fields — `user_bootstrap/{uid}`'s `result.companyId` is exactly such a
  field, so `reconcileAdminAndCompany` would have silently read
  `undefined` against real staging Firestore.

Also in this round:

- **Adapter-contract gate**: the orchestrator now verifies, before ANY
  external call, that the supplied adapter implements every required
  method (all three recovery methods included). A missing method is a
  fail-closed `SAFE_STOP` with zero writes, never a crash mid-flow after
  resources may already exist.
- **Output ACL hardened**: `--out`'s parent directory (not necessarily
  `claimedDir`) is locked down before the write; the write itself is
  atomic (exclusive create + fsync + reread-verify), `verifyPrivateFileAcl`
  runs immediately after.
- **`gateGaStagingAdaptersCoreSelfTest.mjs`**: REST/identity/callable
  clients fully dependency-injected — this suite exercises the REAL
  staging-adapter branches against controlled fakes modeling real Identity
  Toolkit/Firestore REST responses, including genuinely separate
  "process 1 / process 2" adapter instances sharing only a backing state
  store (the strongest available proof of cross-process reconciliation
  without touching real staging). A dedicated mutation suite
  (`gateGaStagingAdaptersMutationChecks.mjs`) proves this: 9/9 detected,
  including admin identity reverting to `runTag`, each recovery method
  removed, the lock-path bug reverting, the `mapValue` bug reverting, and
  a fabricated recoverable token.

## A note on this round's own process

The first full 8-scenario crash-window run against the final commit showed
one false failure (`EMAIL_SENT_PENDING_CHECKPOINT` timed out waiting for a
signal). Root cause, confirmed and fixed before publishing: an unrelated
diagnostic command run earlier in this same session (`find /c "node.exe"`,
a Windows-syntax command misinterpreted by the Unix shell as a full
recursive scan from `/c`) was still running and saturating disk I/O at
exactly that moment — not a code defect. The runaway process was killed,
the isolated scenario then passed 3/3 with no timeout changes, and the
full 8-scenario suite passed cleanly two more times, including once
against the exact published commit. See `unpacked/evidence/` for all
three runs.

## Integrity

Every file's SHA-256 is listed in `SHA256SUMS.txt`. The zip was scanned
before publication for private keys, API keys, tokens, passwords, and real
email addresses — none were found; the one password-shaped match is a
self-test fixture using a synthetic `@example.invalid` placeholder.
