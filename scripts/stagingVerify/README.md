# Staging Rules verification harness (`BASE-004-PREPROD-STAGING-01`)

Runs the 12 required security-scenario groups (22 discrete checks) against
the **actually deployed** Firestore Rules on `finapp-staging`, using the
real Firebase Client SDK — not the emulator. Uses only synthetic fixtures
(`example.invalid` emails, run-scoped ID prefix) and deletes everything it
creates in a `finally` block, with an independent post-cleanup re-query to
confirm zero residue.

## Prerequisites

1. An authenticated `firebase login` CLI session with access to the target
   staging project (this harness reuses that session for fixture
   setup/cleanup only — it never uses it for the actual security
   assertions, which go through the unprivileged Client SDK).
2. A local `.env.staging.local` at the repo root with the real
   `VITE_FIREBASE_*` values for the staging project and
   `STAGING_FIREBASE_CONFIG_FINGERPRINT` (see
   `scripts/verify-staging-env.mjs` / `scripts/lib/firebaseConfigFingerprint.mjs`).
   This file is git-ignored (`.env.*.local`) and must never be committed.
3. Already-installed dependencies only (`firebase`, `firebase-tools`) — no
   new packages required.

## Run (one command)

```bash
node scripts/stagingVerify/run.mjs
```

Optional: set `STAGING_PROJECT_ID` to override the project id read from
`.env.staging.local` — the script refuses to run if this does not match
`.env.staging.local`'s `VITE_FIREBASE_PROJECT_ID`, and refuses outright if
it resolves to the production project id.

## Output

- Console: one `PASS`/`FAIL` line per scenario, plus a final summary line.
- File: `docs/remediation/evidence/BASE-004-PREPROD-STAGING-scenarios-result.json`
  — overwritten on every run. Contains only non-sensitive data: project id,
  timestamps, the git SHA of the checkout being verified, local vs. active
  staging Rules SHA-256, the synthetic fixture prefix, fixture
  create/delete counts, zero-residue confirmation, and each scenario's
  id/name/expected/actual/pass-fail. It never contains API keys, tokens,
  fingerprints, passwords, or real email/user data.

## Exit codes

- `0` — all scenarios passed and zero-residue cleanup was confirmed.
- `1` — at least one scenario failed, or residue was left behind after cleanup.
- `2` — the harness could not run at all (missing config, wrong project, fatal error).
