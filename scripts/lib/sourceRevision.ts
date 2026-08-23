// Verified "what code actually produced this run" — SEC-005, independent
// audit fixes, 4th round, item 3.5.
//
// `git rev-parse HEAD` alone (the previous implementation, still used for
// non-production environments — see backfill-memberships.ts's
// readSourceGitSha()) proves only which COMMIT is checked out; it says
// NOTHING about whether the actual files on disk still match that commit.
// A locally modified (staged, unstaged, or untracked-and-not-gitignored)
// tracked file means the code that really ran is NOT fully described by
// the reported `sourceGitSha` — for a production dry-run/apply, that gap
// is unacceptable: an operator (or a reviewer of `--rollback-reference`)
// must be able to trust that `sourceGitSha` is a complete, honest
// description of the code that produced the plan.
//
// Dependency-injected (`SourceRevisionDeps`) so the safety-critical order
// (git status check BEFORE rev-parse, both BEFORE any credential
// acquisition or Firestore I/O) is directly unit-testable with fake
// git-command results — never by actually mutating this repo's real git
// checkout inside a test.
import { execSync } from 'node:child_process'

export class SourceRevisionError extends Error {}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i

export interface SourceRevisionDeps {
  /** Returns the raw stdout of `git status --porcelain` (no `--ignored` —
   * gitignored paths are deliberately excluded from "relevant" untracked
   * changes; anything not gitignored that shows up here, tracked-modified
   * OR genuinely untracked, is relevant). Must THROW (never return a
   * sentinel string) on any failure to run git itself. */
  runGitStatus: () => string
  /** Returns the raw stdout of `git rev-parse HEAD`. Must THROW (never
   * return a sentinel string) on any failure. */
  runGitRevParse: () => string
}

export interface VerifiedSourceRevision {
  sourceGitSha: string
}

/**
 * Fail-closed verification of the source revision — independent audit
 * fixes, 4th round, item 3.5. Throws `SourceRevisionError` (never returns a
 * degraded/placeholder value like `'unknown'`) on ANY of:
 *   - `runGitStatus()`/`runGitRevParse()` itself throwing (git not found,
 *     not a git repository, permission error, etc.) — a git error must
 *     never be silently treated as "clean" or turned into an acceptable
 *     production reference.
 *   - `git status --porcelain` reporting ANY staged, unstaged, or
 *     untracked-and-not-gitignored change — the worktree does not exactly
 *     match `HEAD`.
 *   - `git rev-parse HEAD` not returning a syntactically valid 40-character
 *     hex commit SHA.
 *
 * Order matters and is exactly what this function enforces: status is
 * checked BEFORE rev-parse (a dirty tree is refused before we even bother
 * asking which commit it's dirty relative to), and the CALLER must invoke
 * this function before acquiring Firestore credentials or performing any
 * Firestore I/O for a production dry-run/apply (see
 * backfill-memberships.ts's main()).
 */
export function assertCleanTrackedSourceRevision(deps: SourceRevisionDeps): VerifiedSourceRevision {
  let statusOutput: string
  try {
    statusOutput = deps.runGitStatus()
  } catch (err) {
    throw new SourceRevisionError(`could not determine git worktree status: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  if (statusOutput.trim().length > 0) {
    throw new SourceRevisionError('git worktree has staged, unstaged, or untracked (non-gitignored) changes — refusing to trust the source revision for a production run.')
  }

  let revParseOutput: string
  try {
    revParseOutput = deps.runGitRevParse()
  } catch (err) {
    throw new SourceRevisionError(`could not determine the git HEAD commit: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  const sha = revParseOutput.trim()
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new SourceRevisionError(`git rev-parse HEAD did not return a valid 40-character commit SHA: ${JSON.stringify(sha)}`)
  }

  return { sourceGitSha: sha.toLowerCase() }
}

/** Real, process-executing dependencies for `assertCleanTrackedSourceRevision()`
 * — used by backfill-memberships.ts; never used directly by a unit test. */
export function realSourceRevisionDeps(repoRoot: string): SourceRevisionDeps {
  return {
    runGitStatus: () => execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf8' }),
    runGitRevParse: () => execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }),
  }
}
