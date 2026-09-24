# APPROVAL-R9 — FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9

This document is prepared as part of the R9 package for independent
review. It is **not** an active request — staging is not run this round,
and `RECIPIENT` / `EXTERNAL_ACTION_APPROVED` are not requested.

## 1. Binding

- Execution commit (`execution/sec-006-gate-ga-r9`): `acd3021b18e17a55aa71f54a2c2b2399f6711309`
- `CODE-SHA256SUMS.txt` SHA-256: `6f1fa504d41f91970bc47825295af8f746e82d151dc7d6e420aa027c73556534`
- Base commit (unchanged `main` ancestor): `c84f7837bdbc0a27fea698080c779d273e8e15bb`
- Task label bound into every approval command hash: `FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9 live orchestrated execution` (`GATE_GA_TASK`)

## 2. Scope of this round

An independent audit of R8 found its blocker: the recovery/reconciliation
logic (closing the crash windows between an external effect completing and
the local durable write recording it) had only ever been implemented in
`gateGaEmulatorAdapters.mjs`. The REAL staging adapter,
`gateGaStagingAdapters.mjs` — the one that would actually run against real
staging — still used R7's ephemeral, per-process `runTag` for admin
identity, had no `reconcileAdminAndCompany`/`reconcileInvitation`/
`findAuthUidByEmail` at all, and `inviteRecipient` hardcoded `lockPath:
null`, meaning neither a fresh invitation's lock document nor its cleanup
were ever real for staging.

R9 closes this in `gateGaStagingAdapters.mjs` itself:

- **Admin identity**: derived from the run's own durable `runId` via a
  single shared function (`gateGaAdminIdentityCore.mjs`, used by BOTH
  adapters). Identity Toolkit's `accounts:signUp` can never be given a
  caller-chosen uid (the server always assigns it) — so unlike the
  emulator adapter, staging derives a deterministic EMAIL from `runId` and
  recovers the real, server-assigned uid by an exact `accounts:lookup` on
  that email. No password survives a crash (never persisted) and none is
  needed: reconciliation resets the admin's password via the same
  Admin-level `accounts:update` endpoint already used for `emailVerified`
  (OAuth-scoped, never the public API-key surface), then signs in fresh.
- **`reconcileAdminAndCompany({runId})`**: exact `accounts:lookup` by the
  derived email, then a point-read of the fixed
  `user_bootstrap/{adminUid}` bootstrap-idempotency receipt Firebase's own
  `createCompany` transaction already writes.
- **`reconcileInvitation({companyId, recipient})`**: point-read of the
  deterministic `invitationLocks/{lockId}` document — the same id
  `functions/src`'s own `computeInvitationLockId` computes
  (`gateGaInvitationLockCore.mjs`, shared with the emulator adapter, no
  duplicate implementation).
- **`findAuthUidByEmail(email)`**: exact `accounts:lookup` by email.
- **`inviteRecipient`**: now returns a real, non-null `lockPath` — normal
  (non-reconciled) cleanup now actually removes the lock document too, not
  just the invitation.
- A real bug this round's own testing found and fixed:
  `firestoreValueToPlain` never handled nested Firestore `mapValue` fields
  — `user_bootstrap/{uid}`'s `result.companyId` field is exactly such a
  nested map, so `reconcileAdminAndCompany` would have silently read
  `undefined` against real staging Firestore. Fixed to recurse.

Also in this round:

- **Adapter-contract gate**: the orchestrator now checks, before ANY
  external call, that the supplied adapter implements every required
  method (including the three recovery methods and both `legacyAdapters`
  sub-methods). A missing method is a fail-closed `SAFE_STOP` with zero
  writes of any kind, never a crash deep inside the flow after resources
  may already have been created.
- **Output ACL**: `--out`'s parent directory (not necessarily the same as
  `claimedDir`) is now locked down before the write, the write itself is
  atomic (exclusive create + fsync + reread-verify), and
  `verifyPrivateFileAcl` runs immediately after.
- `gateGaStagingAdaptersCoreSelfTest.mjs`: the REST/identity/callable
  clients are now fully dependency-injected
  (`createGateGaStagingAdaptersCore`), so this suite exercises the REAL
  staging-adapter branches — not just the emulator twin — against
  controlled fakes modeling real Identity Toolkit/Firestore REST
  responses, including genuinely separate "process 1 / process 2" adapter
  instances sharing only a backing state store. A dedicated mutation suite
  (`gateGaStagingAdaptersMutationChecks.mjs`, 9/9 detected) proves this
  self-test actually catches: admin identity reverting to `runTag`, each
  recovery method being removed, the lock-path bug reverting, the
  `mapValue` parsing bug reverting, and a fabricated recoverable token.

## 3. Owner action / wait time

None, for this round.

## 4. Exact fresh launch command (staging profile, for future reference)

```text
node scripts/invitationRehearsal/liveAcceptanceExecutor.mjs --execute \
  --profile staging --project finapp-staging \
  --expected-head acd3021b18e17a55aa71f54a2c2b2399f6711309 \
  --approval <path-to-reviewed-approval.json> --approval-sha256 <sha256-of-that-file> \
  --journal <new-private-file-path> --out <new-private-file-path> \
  --recipient <owner-provided-email> --recipient-confirmed-sha256 <sha256-of-lowercased-trimmed-email> \
  --resume false --legacy-cleanup-approved false
```

## 5. Crash-window results (all 8, real, proven — unchanged windows from R8, now proven the staging code path can no longer silently diverge from)

All 8 real, two-process, literal-CLI crash-window scenarios (against the
emulator profile, as staging itself is never executed) confirmed PASS —
deterministic across three consecutive full runs against this exact
commit, after one transient false failure was traced to an unrelated
diagnostic command of this session's own making (a runaway filesystem
scan competing for I/O — see `evidence/crash-windows-8of8-after-io-contention-cleared.txt`),
not a code regression: the isolated scenario alone then passed 3/3 with
no timeout changes, and the full suite passed 8/8 three more times after.

## 6. Legacy-cleanup gating

Unchanged: `legacyCleanupApproved` is the only thing that may ever
authorize legacy-residual deletion, bound to the reviewed approval
document.

## 7. Future EXTERNAL_ACTION_APPROVED block (template, not active)

```text
EXTERNAL_ACTION_APPROVED: FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9
ENVIRONMENT: staging
RECIPIENT: <owner-provided-email>
```
