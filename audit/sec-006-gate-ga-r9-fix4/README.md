# FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9 (audit follow-up) — audit branch

Read-only audit dump for independent review. Additive only — does not
modify `main`, PR #28, tags, or any other existing branch.

## Contents

- `FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9-followup.zip` — the immutable package.
- `SHA256SUMS.txt` — SHA-256 of every file in the package.
- `unpacked/` — the zip's contents extracted:
  - `APPROVAL-R9-followup.md` — binding, scope of the two fixes, and a full,
    transparent account of a real test flake found and resolved during
    this round (not an active staging request).
  - `package.json`, `scripts/invitationRehearsal/**` — the full source.
  - `evidence/` — real command output: the final 8-scenario literal-CLI
    crash-window run against the published commit, both new self-test
    suites (contract-gate, out-atomicity), all four mutation suites,
    typecheck/lint/E2E/resume-kill, and the stress-test confirmations from
    diagnosing the flake.

## Real code, real commit

`execution/sec-006-gate-ga-r9-fix4` @ `8f90899b99ed655b5422b77ffe2aeeec5cdeee05`
— the `--expected-head` value bound in `APPROVAL-R9-followup.md`. See
`unpacked/evidence/` for full test output.

## What this round fixes (independent audit of R9: CHANGES REQUIRED)

1. **Adapter-contract gate now genuinely precedes the first network
   call.** The staging adapter factory's guarded firebase-tools session
   (a real `requireAuth`/`getAccessToken` refresh) is now lazy and
   memoized — constructed only when a `rest`-backed method is actually
   invoked, never at construction time. A new test drives the exact
   production wiring (`createGateGaOrchestratedRuntime.run()` with the
   real `createGateGaStagingAdapters` factory) with a recovery method
   removed, and asserts zero session/auth/network calls of any kind.
2. **`--out` is now genuinely crash-atomic**, not just exclusive-create:
   temp file in the same directory, full write + fsync + reread-verify,
   then atomic rename. A real kill/fault test (a genuinely separate
   child process, frozen exactly before the rename, SIGKILLed) proves
   the final path is never partial. A mutation reverting to the old
   direct-write shape is detected.

Both fixes are proven by dedicated mutation suites in addition to the
new self-tests, and the full pre-existing regression (typecheck, lint,
all prior gate-ga suites, both mutation suites, standalone E2E, real
two-process resume-kill, and all 8 real crash-window scenarios) was
re-run against this exact commit with no timeout changes.

## Integrity

Every file's SHA-256 is listed in `SHA256SUMS.txt`. Scanned for private
keys, API keys, tokens, real passwords, and real email addresses before
publication — none found; only synthetic `@example.invalid`/test fixture
values.
