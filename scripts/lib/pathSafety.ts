// Shared "must be an absolute path OUTSIDE this repository" guard — SEC-005.
//
// Used for --report-path, --decisions-file, and --from-report (rollback's
// source report) alike (independent audit fix #5) — a decisions or source
// report file living inside the repo checkout is refused just as surely as
// an output report path would be, and ALL of these checks run before any
// credential acquisition or Firestore I/O (called from main() before
// initFirestore()).
//
// Handles: relative-looking absolute paths with `..`/`.` segments (resolved
// via path.resolve), a symlinked ancestor directory pointing back inside the
// repo (resolved via fs.realpathSync on the nearest EXISTING ancestor, since
// the target file itself may not exist yet), and Windows/macOS
// case-insensitive filesystems (case-folded comparison on those platforms
// only — Linux stays case-sensitive).
import process from 'node:process'
import { isAbsolute, resolve as resolvePath, dirname, basename } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'

export class UnsafePathError extends Error {}

/** Resolves as much of `p` as actually exists on disk via realpath (defeats
 * a symlinked ancestor), then re-appends any trailing path segments that
 * don't exist yet (e.g. the report file itself, about to be created). */
function resolveRealish(p: string): string {
  let current = resolvePath(p)
  const suffix: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break // reached filesystem root without finding an existing ancestor
    suffix.unshift(basename(current))
    current = parent
  }
  const real = existsSync(current) ? realpathSync(current) : current
  return suffix.length > 0 ? resolvePath(real, ...suffix) : real
}

function normalizeForComparison(p: string): string {
  const withForwardSlashes = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin'
  return caseInsensitiveFs ? withForwardSlashes.toLowerCase() : withForwardSlashes
}

/** Throws UnsafePathError if `inputPath` is not absolute, or resolves
 * (after symlink resolution) to a location inside `repoRoot`. `label` is
 * only used in the (safe, no-path-content) error message. */
export function assertPathOutsideRepo(label: string, inputPath: string, repoRoot: string): void {
  if (!isAbsolute(inputPath)) {
    throw new UnsafePathError(`${label} must be an absolute path.`)
  }
  const resolvedTarget = resolveRealish(inputPath)
  const resolvedRepo = existsSync(repoRoot) ? realpathSync(repoRoot) : resolvePath(repoRoot)

  const normalizedTarget = normalizeForComparison(resolvedTarget)
  const normalizedRepo = normalizeForComparison(resolvedRepo)

  if (normalizedTarget === normalizedRepo || normalizedTarget.startsWith(`${normalizedRepo}/`)) {
    throw new UnsafePathError(`${label} must be OUTSIDE the repository checkout.`)
  }
}
