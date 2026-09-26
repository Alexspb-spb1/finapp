# APPROVAL-R9-followup2 — FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9 (audit follow-up, 2nd pass)

Not an active request — staging is not run this round; `RECIPIENT` /
`EXTERNAL_ACTION_APPROVED` are not requested.

## Binding

- Execution commit (`execution/sec-006-gate-ga-r9-fix5`): `e1310e5314f4e6355a0fbd43eab378224044e1f6`
- `CODE-SHA256SUMS.txt` SHA-256: `cfe631dcdf4eec37b67678df5d79f9b075d8f3c810a6a258a6eee75f06f62f10`
  (identical to `execution/sec-006-gate-ga-r9-fix4`'s binding — the 19
  tracked production seam files are byte-for-byte unchanged this round;
  only the proof/test files below were touched, matching the reviewer's
  own scoping: "один узкий дефект только в доказательном тесте. Код lazy
  session и atomic --out выглядит корректно.")
- Base commit: `c84f7837bdbc0a27fea698080c779d273e8e15bb`
- Prior delivery this follows up on: `execution/sec-006-gate-ga-r9-fix4` @ `8f90899b99ed655b5422b77ffe2aeeec5cdeee05`

## What this round fixes (independent audit of fix4: CHANGES REQUIRED)

**1. `withFetchSpy` in `gateGaStagingRuntimeContractGateSelfTest.mjs` was
not `async`.** `try { return fn(() => count) } finally { globalThis.fetch
= original }` returned the async callback's PENDING PROMISE without
awaiting it, so the `finally` block restored the real `globalThis.fetch`
immediately — before the callback's own body (which awaits the real
~9-10s orchestrator run) ever executed. Any `fetch` call made during that
window would have silently hit the real network instead of the spy,
defeating the "0 fetch calls" assertion's own enforcement mechanism (the
counter check itself was correct, but the counter could never have been
incremented by a call the spy should have caught after the swap). Fixed
exactly per the reviewer's supplied replacement:

```js
async function withFetchSpy(fn) {
  const original = globalThis.fetch
  let count = 0
  globalThis.fetch = async (...args) => {
    count++
    throw new Error(`fetch must never be called: ${args[0]}`)
  }
  try {
    return await fn(() => count)
  } finally {
    globalThis.fetch = original
  }
}
```

Concretely verified the bug was real and the fix matters: temporarily
reintroduced the old buggy spy together with the eager-fetch mutation
(below) into the real files, confirmed the test wrongly PASSED (proving
the old spy could not catch this class of regression), then restored
both real files and confirmed the fixed spy correctly detects the same
mutation.

**2. New deterministic mutation check
(`gateGaStagingRuntimeContractGateMutationChecks.mjs`).** Copies
`scripts/invitationRehearsal`, inserts one real `fetch(...)` call
directly inside `createGateGaStagingAdapters` immediately after `void
runTag` — i.e. before any adapter method is ever called, before the
orchestrator's contract gate even runs — and reruns
`gateGaStagingRuntimeContractGateSelfTest.mjs` unmodified against the
mutated copy. Requires the test to now fail. The mutation reaches only
the fixed spy (never the real network): `DETECTED 1/1`.

## Full regression, at least 5 repeated contract-gate runs, the new mutation, both real crash-window suites, both mutation suites

No timeouts were changed anywhere this round. All results in
`evidence/`:

- `gateGaStagingRuntimeContractGateSelfTest.mjs` run 5 consecutive times
  on the exact final commit — 5/5 clean passes, zero
  session/auth/network/fetch calls in every run.
- New mutation check — `DETECTED 1/1`.
- Full existing regression (typecheck, lint, all `test:invitation-gate-ga-*`
  suites including all four mutation suites, standalone E2E, real
  two-process resume-kill) — all green.
- Full real 8-scenario literal-CLI crash-window suite
  (`test:invitation-gate-ga-crash-windows`) against this exact commit —
  `SUMMARY total=8 pass=8 fail=0`, `GATE_GA_CRASH_WINDOWS PASS`.

`main`, PR #28, staging, and production were not touched.
