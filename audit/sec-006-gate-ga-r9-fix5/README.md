# FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9 (audit follow-up, 2nd pass) — audit branch

Read-only audit dump for independent review. Additive only — does not
modify `main`, PR #28, tags, or any other existing branch.

## Contents

- `FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9-followup2.zip` — the immutable package.
- `SHA256SUMS.txt` — SHA-256 of every file in the package.
- `unpacked/` — the zip's contents extracted:
  - `APPROVAL-R9-followup2.md` — binding, scope of this round's single
    narrow fix (the `withFetchSpy` async bug) plus its new mutation
    check, and the before/after verification proving the bug was real.
  - `package.json`, `scripts/invitationRehearsal/**`, `scripts/lib/**` —
    the full source.
  - `evidence/` — real command output: 5 consecutive contract-gate
    self-test runs, the new eager-fetch mutation check, typecheck, lint,
    the full non-emulator regression batch, the emulator-dependent
    resume-kill and staging-cli suites, the full real 8-scenario
    literal-CLI crash-window run, the standalone emulator E2E run, and
    the secret scan.

## Real code, real commit

`execution/sec-006-gate-ga-r9-fix5` @ `e1310e5314f4e6355a0fbd43eab378224044e1f6`
— the `--expected-head` value bound in `APPROVAL-R9-followup2.md`. See
`unpacked/evidence/` for full test output.

## What this round fixes (independent audit of fix4: CHANGES REQUIRED — один узкий дефект только в доказательном тесте)

1. **`withFetchSpy` in `gateGaStagingRuntimeContractGateSelfTest.mjs` is
   now `async`**, and `globalThis.fetch` restoration happens only after
   the passed async callback fully completes — fixed exactly per the
   reviewer's supplied replacement code. The prior version returned the
   callback's pending promise without awaiting it, so the real `fetch`
   was restored before the ~9-10s orchestrator run it was supposed to
   guard ever executed, silently letting a real network call slip past
   the spy during that window.
2. **New deterministic mutation check**
   (`gateGaStagingRuntimeContractGateMutationChecks.mjs`): inserts an
   eager `fetch` call into `createGateGaStagingAdapters` before the
   contract gate ever runs; the fixed full-runtime test detects it
   (`DETECTED 1/1`) without touching the real network.
3. Concretely verified the bug was real: temporarily reintroduced the
   old buggy spy plus the eager-fetch mutation into the real files,
   confirmed the test wrongly PASSED, then restored both files and
   confirmed the fixed spy correctly detects the same mutation.

No production/seam code changed this round — `CODE-SHA256SUMS.txt`'s own
SHA-256 (`cfe631dcdf4eec37b67678df5d79f9b075d8f3c810a6a258a6eee75f06f62f10`)
is identical to `execution/sec-006-gate-ga-r9-fix4`'s binding, confirming
the 19 tracked production seam files are byte-for-byte unchanged; only
the proof/test files above were touched, matching the reviewer's own
scoping.

## Regression

Contract-gate self-test run 5 consecutive times (5/5 clean, zero
session/auth/network/fetch calls each run); new mutation check
`DETECTED 1/1`; full existing regression — typecheck, lint, all
`test:invitation-gate-ga-*` suites (module mutations 12/12, orchestrator
mutations 23/23, staging-adapters 9/9 + mutations 9/9, out-atomicity 2/2
+ mutations 1/1), standalone E2E, real two-process resume-kill, and the
full real 8-scenario literal-CLI crash-window suite
(`total=8 pass=8 fail=0`) — all PASS, against this exact commit, with no
timeout changes anywhere. `main`, PR #28, staging, and production were
not touched.

## Integrity

Every file's SHA-256 is listed in `SHA256SUMS.txt`. Scanned for private
keys, API keys, tokens, real passwords, and real email addresses before
publication — none found; only synthetic `@example.invalid`/test fixture
values (see `unpacked/evidence/10-secret-scan.txt`).
