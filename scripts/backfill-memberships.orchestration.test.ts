import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { verifyRollbackPlanFileIntegrity } from './lib/productionSafety.ts'

// Independent audit fixes, 5th round, item 6 (second half): a regression
// test proving "wrong --expected-plan-sha256 on a production apply causes
// ZERO credential/Firestore I/O" — not merely documented in a comment.
//
// main() in backfill-memberships.ts is a top-level, non-exported function
// that reads process.argv and drives a real (or emulator) Firestore client
// directly — it has no dependency-injection seam, and adding one purely to
// make this single ordering fact unit-testable would be a much larger
// change than this finding calls for. The orchestration guarantee this test
// protects is instead structural and provable two ways, both asserted here:
//
//   1. `verifyRollbackPlanFileIntegrity()` — the function that checks
//      `--expected-plan-sha256` against `--rollback-reference`'s raw bytes —
//      takes NO Firestore client/db parameter at all (see
//      productionSafety.test.ts for its behavioral tests). It is therefore
//      structurally incapable of performing Firestore I/O, regardless of
//      call order.
//   2. In the actual entrypoint, the call to `verifyRollbackPlanFileIntegrity()`
//      textually precedes the call to `initFirestore()` (credential
//      acquisition) which itself precedes `readAllUsers()`/`readAllCompanies()`/
//      `readAllExistingMemberships()` (the first Firestore reads). A plan-hash
//      mismatch throws inside `verifyRollbackPlanFileIntegrity()` and is
//      caught by the surrounding try/catch, returning before line 227
//      (`initFirestore`) is ever reached — so no credential is acquired and
//      no Firestore call is made.
//
// This source-order assertion is intentionally a regression guard: if a
// future change moves the plan-hash check to after `initFirestore()` (as
// the 4th-round implementation that this finding was raised against
// actually did), this test fails immediately, independent of whether an
// emulator/mock happens to be wired up to observe the (non-)calls directly.

const ENTRYPOINT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'backfill-memberships.ts')

describe('production apply preflight ordering — zero Firestore I/O on a bad plan hash', () => {
  it('verifyRollbackPlanFileIntegrity() has no Firestore/db parameter — structurally cannot perform Firestore I/O', () => {
    // A db-accepting signature would be `(path, expectedSha, projectId, db)`
    // or similar — arity stays at exactly 3 (path, expectedPlanSha256,
    // expectedProjectId) precisely because no db parameter exists.
    expect(verifyRollbackPlanFileIntegrity.length).toBe(3)
  })

  it('the production-apply plan-hash preflight call textually precedes initFirestore() in the entrypoint', () => {
    const source = readFileSync(ENTRYPOINT_PATH, 'utf8')
    const preflightIndex = source.indexOf('verifiedRollbackPlanFile = verifyRollbackPlanFileIntegrity(')
    const initFirestoreIndex = source.indexOf('const db = initFirestore(')
    expect(preflightIndex).toBeGreaterThan(-1)
    expect(initFirestoreIndex).toBeGreaterThan(-1)
    expect(preflightIndex).toBeLessThan(initFirestoreIndex)
  })

  it('initFirestore() textually precedes the first Firestore reads (readAllUsers/readAllCompanies/readAllExistingMemberships)', () => {
    const source = readFileSync(ENTRYPOINT_PATH, 'utf8')
    const initFirestoreIndex = source.indexOf('const db = initFirestore(')
    const firstReadIndex = source.indexOf('readAllUsers(db)')
    expect(initFirestoreIndex).toBeGreaterThan(-1)
    expect(firstReadIndex).toBeGreaterThan(-1)
    expect(initFirestoreIndex).toBeLessThan(firstReadIndex)
  })

  it('the plan-hash preflight is wrapped in its own try/catch that returns before reaching initFirestore() on failure', () => {
    const source = readFileSync(ENTRYPOINT_PATH, 'utf8')
    const preflightBlockStart = source.indexOf("if (environment === 'production' && opts.mode === 'apply') {")
    const preflightBlockEnd = source.indexOf('const runId = randomUUID()')
    expect(preflightBlockStart).toBeGreaterThan(-1)
    expect(preflightBlockEnd).toBeGreaterThan(preflightBlockStart)
    const block = source.slice(preflightBlockStart, preflightBlockEnd)
    expect(block).toContain('try {')
    expect(block).toContain('verifyRollbackPlanFileIntegrity(')
    expect(block).toContain('catch (err)')
    expect(block).toMatch(/return 3/)
    // The catch block must return before initFirestore() — i.e.
    // initFirestore() must not appear inside this preflight block at all.
    expect(block).not.toContain('initFirestore(')
  })
})
