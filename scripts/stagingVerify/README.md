# Staging Rules verification harness (`BASE-004-PREPROD-STAGING-01`)

Runs the 12 required security-scenario groups (22 discrete checks) against
the **actually deployed** Firestore Rules on `finapp-staging`, using the
real Firebase Client SDK — not the emulator. Uses only synthetic fixtures
(`example.invalid` emails, run-scoped ID prefix) and deletes everything it
creates in a `finally` block, with an independent post-cleanup re-query to
confirm zero residue.

## Fail-closed guarantees

1. **Project guard** (`checkProjectGuard`) runs before any credential
   acquisition, before the Admin REST client is constructed, and before a
   single fixture is written. It requires `VITE_FIREBASE_PROJECT_ID` and
   the resolved project id to be **exactly** `finapp-staging` — not just
   "not production". Any other project id (production or otherwise),
   any conflict between the two sources, or `FIRESTORE_EMULATOR_HOST` /
   `FIREBASE_AUTH_EMULATOR_HOST` being set, blocks the run before it can
   touch anything.
2. **Rules hash check** runs before the first fixture is created. It
   always does a fresh read-only fetch of the active staging ruleset (never
   reuses a saved/previous hash), canonicalizes both the local
   `firestore.rules` and the fetched active source the same way, and
   compares SHA-256. Any fetch/parse/hash failure, or a mismatch, blocks
   the run — no fixtures, no scenarios, no deploy.
3. **Cross-platform canonical hashing**: `CRLF -> LF`, then any remaining
   lone `CR -> LF`, UTF-8 text — so the same Rules source hashes identically
   on a Windows checkout (CRLF), a Linux checkout (LF), and the
   Firebase-hosted active ruleset source, without touching meaningful
   whitespace/indentation.

## Prerequisites

1. An authenticated `firebase login` CLI session with access to the target
   staging project (reused for fixture setup/cleanup only — never for the
   actual security assertions, which go through the unprivileged Client
   SDK).
2. A local `.env.staging.local` at the repo root with the real
   `VITE_FIREBASE_*` values for the staging project and
   `STAGING_FIREBASE_CONFIG_FINGERPRINT` (see
   `scripts/verify-staging-env.mjs` / `scripts/lib/firebaseConfigFingerprint.mjs`).
   Git-ignored (`.env.*.local`) — never commit it.
3. Already-installed dependencies only (`firebase`, `firebase-tools`) — no
   new packages required.

## Self-test (no network, no credentials, no fixtures)

```bash
node scripts/stagingVerify/run.mjs --self-test
```

Exercises the pure functions only: canonical-hash stability across
LF/CRLF/CR, the project guard (staging passes; production, an arbitrary
other project, and emulator-host env vars are all blocked), and the Rules
hash check logic (fetch error and hash mismatch are both blocking; a match
is not). Exits `0` only if every check passes.

## Real staging run (one command)

```bash
node scripts/stagingVerify/run.mjs
```

Optional: set `STAGING_PROJECT_ID` to override the project id read from
`.env.staging.local` — the project guard still requires it to resolve to
exactly `finapp-staging`.

## Output

- Console: project guard result, rules hash check result, one `PASS`/`FAIL`
  line per scenario, self-test summary, final summary line.
- File: `docs/remediation/evidence/BASE-004-PREPROD-STAGING-scenarios-result.json`
  — overwritten on every run (including blocked runs, which write a minimal
  honest record of why). Contains only non-sensitive data: project id,
  timestamps, the git SHA of the checkout being verified, the
  normalization algorithm description, local/active canonical Rules
  SHA-256, `rulesHashMatch`, project-guard/self-test results, the synthetic
  fixture prefix, fixture create/delete counts, zero-residue confirmation,
  and each scenario's id/name/expected/actual/pass-fail. It never contains
  API keys, tokens, fingerprints, passwords, or real email/user data.

## Exit codes

- `0` — project guard passed, rules hash matched, all scenarios passed,
  zero-residue cleanup was confirmed, and self-test passed.
- `1` — at least one scenario failed, residue was left behind, or self-test failed.
- `2` — the harness could not run at all: project guard blocked
  (`BASE_004_PREPROD_CORRECTION_02_BLOCKED_PROJECT_GUARD`), rules hash
  check blocked (`BASE_004_PREPROD_CORRECTION_02_BLOCKED_RULES_HASH`),
  missing config, or a fatal error.

## What this harness never does

- Never deploys Firestore Rules (`firebase deploy` is not called anywhere
  in this script).
- Never touches the production project — the project guard makes this
  fail-closed rather than a simple blocklist check.
- Never prints or persists API keys, tokens, fingerprints, passwords, or
  real user data.
