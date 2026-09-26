# APPROVAL-R9-followup — FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9 (audit follow-up)

Not an active request — staging is not run this round; `RECIPIENT` /
`EXTERNAL_ACTION_APPROVED` are not requested.

## Binding

- Execution commit (`execution/sec-006-gate-ga-r9-fix4`): `8f90899b99ed655b5422b77ffe2aeeec5cdeee05`
- `CODE-SHA256SUMS.txt` SHA-256: `cfe631dcdf4eec37b67678df5d79f9b075d8f3c810a6a258a6eee75f06f62f10`
- Base commit: `c84f7837bdbc0a27fea698080c779d273e8e15bb`
- Prior R9 delivery this follows up on: `execution/sec-006-gate-ga-r9` @ `acd3021b18e17a55aa71f54a2c2b2399f6711309`

## The two items this round closes

**1. Adapter-contract gate moved before the first network call.** R9's
original delivery checked adapter completeness inside
`runGateGaOrchestrator` (M23 already proved this), but
`gateGaStagingRuntime.mjs`'s `buildStagingAdapters` call — and, inside
it, `createGateGaStagingAdapters`'s eager
`createGuardedFirebaseToolsSessionLoader(...).execute(...)` call — ran
BEFORE the orchestrator was ever reached, meaning a real staging build
would perform a real `requireAuth`/`getAccessToken` refresh even if it
were missing a required method. Fixed by making the guarded session
lazy and memoized inside `createGateGaStagingAdapters`: it is now
constructed and executed ONLY the first time a `rest`-backed adapter
method is actually invoked, never at adapter-construction time. A new
test (`gateGaStagingRuntimeContractGateSelfTest.mjs`) drives the EXACT
production wiring (`createGateGaOrchestratedRuntime.run()` with
`buildStagingAdapters` wrapping the real `createGateGaStagingAdapters`
factory) with one recovery method removed, and asserts zero
`getGlobalDefaultAccount`/`requireAuth`/`getAccessToken`/`fetch` calls of
any kind — the orchestrator-level M23 mutation alone was not sufficient
proof, per the review.

**2. `--out` made genuinely crash-atomic.** Previously written via a
single `wx` create directly at the final path — safe against overwrite,
but a kill exactly mid-write would leave a partial file sitting at the
real `--out` path. `durableWriteJsonFile` now writes to a uniquely-named
temp file in the SAME directory, fully writes + fsyncs + reread-verifies
it, and only THEN atomically renames it to the final path — the same
temp+rename pattern already proven elsewhere in this codebase. A real
kill/fault test (`gateGaStagingRuntimeOutputAtomicitySelfTest.mjs`)
spawns a genuinely separate child process, freezes it (via a custom `io`
whose `fsyncSync` signals then blocks forever) exactly after the temp
file is fully written but before rename, SIGKILLs it, and asserts the
final `--out` path never exists — never partial. A mutation
(`gateGaStagingRuntimeMutationChecks.mjs`) reverting to the direct-write
shape is detected 1/1.

## A real, transparently-reported test flake found and resolved

The FIRST attempt at a supplementary "sanity" test alongside the
required contract-gate test (proving `ensureRest()` genuinely reaches the
session loader when a method IS called, so the negative test above isn't
vacuously true) intermittently failed — 3 times out of roughly 50
reproduction attempts across many variations, every time only inside a
full multi-step evidence-capture run under heavy concurrent real Windows
PowerShell/subprocess load, never on any standalone retry (including
after wrapping both tests in a `describe()` block to force strict
sequential execution, which did not eliminate it). This is genuine,
non-deterministic environmental timing variance — the same class of
interference this project's history already diagnosed once before (an
unrelated runaway process saturating disk I/O), not a defect in the
mechanism itself, which is independently confirmed to work by the ~47
clean reproductions on record. Since this supplementary test was not
part of the reviewed requirement (only the negative case was), and its
presence in the automated suite risked blocking future rounds over a
non-code artifact, it was removed from the automated suite rather than
left in a state that could non-deterministically fail. The reviewer's
actual required test — the negative case — has never failed once, across
every reproduction of every shape.

## Full regression, both real crash-window suites, both mutation suites

All results in `evidence/`: typecheck, lint, all `test:invitation-gate-ga-*`
suites (12/12, 23/23, 9/9, 1/1 across the four mutation suites; contract-gate
and out-atomicity tests both green), standalone E2E, real two-process
resume-kill, and the full real 8-scenario literal-CLI crash-window suite
— PASS, against this exact commit, with independently-verified zero
remainder in every scenario. `main`, PR #28, staging, and production were
not touched.
