# gateGaDeploymentCheck13.mjs live invocation log

Checker: `remediation/SEC-006-GATE-GA-DEPLOYMENT-CHECK-13FN` @ `bd59524a2802f1c7ad937d1165fe842ce0df9048`.
This is a factual log of every attempt made, in order. No live call was
repeated for diagnostic purposes beyond what is listed here, and none was
made after this log was closed out.

## Attempt 1 — the documented command, first try: BLOCKED

Fresh clone, checked out to `bd59524a2802f1c7ad937d1165fe842ce0df9048`,
worktree confirmed clean (`git status --porcelain --untracked-files=all`
empty) immediately before this call.

```
node scripts/invitationRehearsal/gateGaDeploymentCheck13.mjs \
  --project finapp-staging \
  --expected-head bd59524a2802f1c7ad937d1165fe842ce0df9048 \
  --baseline-receipt "D:/projects/finapp/.runtime/stage8-deployment-postflight-ab1bd67.json" \
  --out "<scratchpad>/deployment-check-13fn-out.json"
```

Output:
```
DEPLOYMENT_CHECK_13FN_BLOCKED: guard, baseline-receipt provenance, billing, endpoint metadata, access or output check failed. No automatic deployment/retry or billing upgrade. Provider details suppressed; existing evidence preserved.
```
Exit code: `2`. No `--out` file was written (confirmed by absence on disk).

## Diagnostic steps taken (read-only; no code edited)

Five steps, in order. **Two of them (steps 2 and 3) performed real
network reads** against `finapp-staging` (both read-only: project/billing/
database/functions metadata GETs). No live call of any kind was made
after step 5 / Attempt 2 below.

1. Re-verified locally, no network: `guard()` (project/head/status/env),
   `commitIsReachable` (`git merge-base --is-ancestor`), and
   `validateBaselineReceiptProvenance()` against the real receipt bytes —
   all passed in isolation.
2. **[network]** Re-verified authorize() plus a single `project` metadata
   GET, through the exact same `deploymentTransport`/session code the CLI
   uses — succeeded (HTTP 200). One real network round-trip.
3. **[network]** Ran a full manual reproduction of
   `run13FunctionDeploymentCheck` itself (same imported function, real
   `authorize`/`get` implementations, 5 real GETs: project/billing/
   database/functionsV1/functionsV2). A second, separate real network
   sequence. It succeeded and returned a genuine
   `DEPLOYMENT_METADATA_VERIFIED_13FN` result with all 13 functions and
   zero baseline drift — proving the check's own logic and the real
   staging state were fine at that moment; the failure in Attempt 1 was
   somewhere else in the CLI wrapper's own invocation path, not in the
   underlying check itself or in the network access it performs.
4. To pin the exact failure line in the CLI wrapper, created a **local,
   uncommitted, never-pushed** debug copy of `gateGaDeploymentCheck13.mjs`
   with one line changed (`catch {` → `catch (e) { console.error(...) }`)
   to surface the swallowed error, and ran it — no network call; it
   failed locally on `guard()` with `inventory_blocked`, because the act
   of creating that debug copy inside the checkout had made `git status`
   non-empty (an untracked file), which `guard()`'s own dirty-worktree
   check correctly refused. This explained the *mechanism* the CLI
   wrapper uses to fail closed in general, but did NOT explain why
   Attempt 1 — on a tree independently confirmed clean immediately
   beforehand, with no debug files yet created — hit that same failure
   mode.
5. Deleted both debug files, re-confirmed `git status --porcelain
   --untracked-files=all` was empty again. No network call in this step.

**The root cause of Attempt 1's failure was not established and is not
claimed here.** Steps 1–4 rule out several candidate explanations
(the check's own logic, the real network path, the CLI wrapper's
argument/path validation, and the receipt's provenance were all
independently verified correct when run clean) without identifying what
actually happened during Attempt 1 itself. No further live diagnostic was
attempted, per instruction, so the question was left genuinely open
rather than resolved by inference.

## Attempt 2 — the documented command, exact retry: PASS

Same clone, worktree re-confirmed clean immediately before this call
(debug files already removed).

```
node scripts/invitationRehearsal/gateGaDeploymentCheck13.mjs \
  --project finapp-staging \
  --expected-head bd59524a2802f1c7ad937d1165fe842ce0df9048 \
  --baseline-receipt "D:/projects/finapp/.runtime/stage8-deployment-postflight-ab1bd67.json" \
  --out "<scratchpad>/deployment-check-13fn-out.json"
```

Output:
```
DEPLOYMENT_METADATA_VERIFIED_13FN: private sanitized metadata saved; no deployment, callable invocation, data change or email performed.
```
Exit code: `0`.

## Result

- `--out` file: `evidence/deployment-check-13fn-out.json` in this package,
  SHA-256 `9eec9c54f2be782552c441dcfcfd1a8e7eab2d49f643e6c8fded8aa344519880`
  (re-verified identical at package-assembly time).
- Status: `DEPLOYMENT_METADATA_VERIFIED_13FN`. 8/8 baseline functions
  matched the receipt with zero drift. 5/5 SEC-007/M1 functions passed
  shape validation.
- Worktree left clean after the run; `git status --porcelain
  --untracked-files=all` empty. No further live call was made after
  Attempt 2.

**This was not a first-try clean pass — it took one blocked attempt, five
read-only diagnostic steps (three purely local, two involving real
network reads), and one exact retry that succeeded.** Reported here in
full, with an unresolved root cause left explicitly unresolved, rather
than presented as only a final PASS or backed by an unverified
explanation.
