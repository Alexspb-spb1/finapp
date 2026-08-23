import { describe, it, expect, vi } from 'vitest'
import { assertCleanTrackedSourceRevision, SourceRevisionError, type SourceRevisionDeps } from './sourceRevision.ts'

// Independent audit fixes, 5th round, item 6: regression tests for
// sourceRevision.ts — previously had zero dedicated unit tests despite
// being a fail-closed, production-apply-gating check. All deps here are
// fakes (SourceRevisionDeps is injected specifically so no test ever needs
// to touch this repo's real git checkout).

const VALID_SHA = 'a'.repeat(40)
const VALID_SHA_UPPER = VALID_SHA.toUpperCase()

function deps(overrides: Partial<SourceRevisionDeps> = {}): SourceRevisionDeps {
  return {
    runGitStatus: () => '',
    runGitRevParse: () => `${VALID_SHA}\n`,
    ...overrides,
  }
}

describe('assertCleanTrackedSourceRevision — happy path', () => {
  it('returns the lowercased sourceGitSha for a clean tree and valid SHA', () => {
    const result = assertCleanTrackedSourceRevision(deps())
    expect(result.sourceGitSha).toBe(VALID_SHA)
  })

  it('lowercases an uppercase git rev-parse output', () => {
    const result = assertCleanTrackedSourceRevision(deps({ runGitRevParse: () => `${VALID_SHA_UPPER}\n` }))
    expect(result.sourceGitSha).toBe(VALID_SHA)
  })

  it('tolerates trailing whitespace/newlines from both git commands', () => {
    const result = assertCleanTrackedSourceRevision(deps({ runGitStatus: () => '  \n', runGitRevParse: () => `  ${VALID_SHA}  \n` }))
    expect(result.sourceGitSha).toBe(VALID_SHA)
  })
})

describe('assertCleanTrackedSourceRevision — dirty tree (fail-closed)', () => {
  it('rejects a staged change', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({ runGitStatus: () => 'M  scripts/lib/cli.ts\n' }))).toThrow(SourceRevisionError)
  })

  it('rejects an unstaged change', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({ runGitStatus: () => ' M scripts/lib/cli.ts\n' }))).toThrow(SourceRevisionError)
  })

  it('rejects an untracked (non-gitignored) file', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({ runGitStatus: () => '?? scripts/lib/newfile.ts\n' }))).toThrow(SourceRevisionError)
  })

  it('never calls runGitRevParse when the tree is dirty (status is checked first)', () => {
    const runGitRevParse = vi.fn(() => `${VALID_SHA}\n`)
    expect(() => assertCleanTrackedSourceRevision(deps({ runGitStatus: () => 'M  x\n', runGitRevParse }))).toThrow(SourceRevisionError)
    expect(runGitRevParse).not.toHaveBeenCalled()
  })
})

describe('assertCleanTrackedSourceRevision — git command failures (fail-closed)', () => {
  it('rejects when runGitStatus throws (git not found / not a repo / permission error)', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({
      runGitStatus: () => { throw new Error('git: command not found') },
    }))).toThrow(SourceRevisionError)
  })

  it('never calls runGitRevParse when runGitStatus throws', () => {
    const runGitRevParse = vi.fn(() => `${VALID_SHA}\n`)
    expect(() => assertCleanTrackedSourceRevision(deps({
      runGitStatus: () => { throw new Error('git: command not found') },
      runGitRevParse,
    }))).toThrow(SourceRevisionError)
    expect(runGitRevParse).not.toHaveBeenCalled()
  })

  it('rejects when runGitRevParse throws even though the tree is clean', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({
      runGitRevParse: () => { throw new Error('fatal: not a git repository') },
    }))).toThrow(SourceRevisionError)
  })

  it('includes the underlying error message for a status failure', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({
      runGitStatus: () => { throw new Error('permission denied') },
    }))).toThrow(/permission denied/)
  })

  it('includes the underlying error message for a rev-parse failure', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({
      runGitRevParse: () => { throw new Error('detached HEAD corruption') },
    }))).toThrow(/detached HEAD corruption/)
  })
})

describe('assertCleanTrackedSourceRevision — malformed SHA (fail-closed)', () => {
  it('rejects an empty rev-parse result', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({ runGitRevParse: () => '\n' }))).toThrow(SourceRevisionError)
  })

  it('rejects a too-short SHA', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({ runGitRevParse: () => 'abc123\n' }))).toThrow(SourceRevisionError)
  })

  it('rejects a too-long SHA', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({ runGitRevParse: () => `${VALID_SHA}ff\n` }))).toThrow(SourceRevisionError)
  })

  it('rejects non-hex characters', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({ runGitRevParse: () => `${'g'.repeat(40)}\n` }))).toThrow(SourceRevisionError)
  })

  it('rejects a human-readable error string masquerading as output (e.g. "fatal: ...")', () => {
    expect(() => assertCleanTrackedSourceRevision(deps({ runGitRevParse: () => 'fatal: ambiguous argument \'HEAD\'\n' }))).toThrow(SourceRevisionError)
  })
})
