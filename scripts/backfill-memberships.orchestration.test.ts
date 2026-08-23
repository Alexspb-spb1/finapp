import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

// Independent audit fixes, 5th round — the follow-up review's "additional"
// finding: a wrong --expected-plan-sha256 producing zero credential/
// Firestore I/O for a production apply must be proven EXECUTABLY, not by
// reading source text (a textual indexOf() check, which was this file's
// entire content before this round, was correctly rejected as
// insufficient).
//
// The real executable proof now lives in
// scripts/lib/productionSafety.test.ts's "runProductionApplyPreflight"
// describe block: `runProductionApplyPreflight()` is the exact function
// `scripts/backfill-memberships.ts`'s main() calls for a production apply,
// and that test injects a COUNTING FAKE for `acquireFirestore` (main()'s
// real `initFirestore`) and observes it is called zero times for a wrong
// plan hash, exactly once (after verification) for a correct one — real
// behavior of the real function, not JS control-flow semantics in the
// abstract.
//
// What remains here is narrower and honestly scoped: main() itself is a
// top-level, non-exported function that reads process.argv and has no
// dependency-injection seam of its own (adding one purely to unit-test
// main() would be a much larger change than this finding calls for) — so
// this file only guards the WIRING fact that main() actually delegates to
// the tested function for a production apply, rather than reimplementing
// the preflight inline (which is what the 5th round's own first pass did,
// and which is exactly the shape of bug this guard exists to catch: a
// future edit that inlines the checks again, or calls
// verifyRollbackPlanFileIntegrity() directly without going through
// runProductionApplyPreflight(), would silently stop being covered by the
// executable proof above without this test noticing).
const ENTRYPOINT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'backfill-memberships.ts')

describe('production apply preflight wiring — main() delegates to the tested runProductionApplyPreflight()', () => {
  it('main() calls runProductionApplyPreflight() for a production apply, not a reimplementation of its checks', () => {
    const source = readFileSync(ENTRYPOINT_PATH, 'utf8')
    expect(source).toContain('runProductionApplyPreflight(')
  })

  it('verifyRollbackPlanFileIntegrity() is only ever invoked THROUGH runProductionApplyPreflight() — never called directly in main()', () => {
    const source = readFileSync(ENTRYPOINT_PATH, 'utf8')
    // The only textual occurrence of the function name outside the import
    // line must be passing it AS a dependency (`verifyPlanFile:
    // verifyRollbackPlanFileIntegrity`) — never `= verifyRollbackPlanFileIntegrity(`
    // (a direct call, which would bypass the tested preflight function and
    // reintroduce exactly the shape of gap this round's review found).
    expect(source).not.toMatch(/=\s*verifyRollbackPlanFileIntegrity\(/)
    expect(source).toContain('verifyPlanFile: verifyRollbackPlanFileIntegrity')
  })

  it('main() imports runProductionApplyPreflight from productionSafety.ts, the same module productionSafety.test.ts tests', () => {
    const source = readFileSync(ENTRYPOINT_PATH, 'utf8')
    const importBlockMatch = source.match(/import \{[^}]*\} from '\.\/lib\/productionSafety\.ts'/)
    expect(importBlockMatch).not.toBeNull()
    expect(importBlockMatch![0]).toContain('runProductionApplyPreflight')
  })

  it('non-preflight paths (non-production, or non-apply) still call initFirestore() directly — no double credential acquisition', () => {
    const source = readFileSync(ENTRYPOINT_PATH, 'utf8')
    expect(source).toContain('db = initFirestore(expectedProjectId)')
    // Exactly one direct initFirestore() call site outside the preflight
    // path (the `else` branch) — the preflight path acquires it through
    // deps.acquireFirestore instead, never a second direct call.
    const directInitFirestoreCalls = source.match(/db = initFirestore\(expectedProjectId\)/g) ?? []
    expect(directInitFirestoreCalls).toHaveLength(1)
  })
})
