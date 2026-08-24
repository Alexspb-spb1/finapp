// Audit-fix round, item 4 — doc-contract regression test: extracts every
// CONCRETE `node scripts/ops/set-maintenance-mode.ts` invocation from
// docs/migrations/MEMBERSHIP_BACKFILL.md (i.e. one with no `<placeholder>`
// tokens other than the documented `<your-identifier>` operator
// convention) and confirms the REAL parseMaintenanceModeCliArgs() accepts
// it. This is exactly the kind of check that would have caught this
// round's audit findings before an independent reviewer had to — the
// runbook and the CLI parser drifted apart (missing `--task-id` on
// `--disable` examples) with nothing in the automated suite comparing them
// against each other.
//
// Deliberately reads the doc file as plain text and reuses the SAME
// parser the CLI actually calls — this is not a hand-maintained duplicate
// of the CLI's argument rules; if `maintenanceModeCli.ts` changes its
// requirements, this test fails against the CURRENT doc content without
// needing its own rules updated.
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseMaintenanceModeCliArgs } from './maintenanceModeCli.ts'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUNBOOK_PATH = path.join(REPO_ROOT, 'docs', 'migrations', 'MEMBERSHIP_BACKFILL.md')

const OPERATOR_PLACEHOLDER = '<your-identifier>'
const OPERATOR_SUBSTITUTE = 'doc-contract-test-operator'

interface ExtractedInvocation {
  /** 1-based line number where the invocation starts, for a legible failure message. */
  line: number
  tokens: string[]
}

/** Tokenizes a single logical command (line continuations already joined),
 * respecting double-quoted segments (e.g. `--reason "SEC-005 ..."`) as one
 * token. */
function tokenize(command: string): string[] {
  const matches = command.match(/"[^"]*"|\S+/g) ?? []
  return matches.map(tok => (tok.startsWith('"') && tok.endsWith('"') ? tok.slice(1, -1) : tok))
}

/** Extracts every `node scripts/ops/set-maintenance-mode.ts ...` invocation
 * from fenced ```bash blocks in the runbook — deliberately scoped to
 * ONLY the inside of ```bash ... ``` fences, never prose. Without this
 * scoping, a plain-English sentence that mentions the script name inside
 * an inline code span (e.g. this very test's own doc comment, describing
 * itself) would be misread as a command to validate — exactly the false
 * positive this function's own regression test caught during development
 * (see the "production execution gate audit-fix round" changelog entry).
 * A multi-line invocation (backslash line continuations) is joined into
 * one logical command. Only invocations with NO remaining `<...>`
 * placeholder token (after substituting the documented
 * `<your-identifier>` operator convention) are returned — a block still
 * containing OTHER placeholders (e.g. the generic
 * `<emulator|staging|production>` reference block) is a template, not a
 * concrete example, and is intentionally excluded. */
function extractConcreteInvocations(markdown: string): ExtractedInvocation[] {
  const lines = markdown.split('\n')
  const invocations: ExtractedInvocation[] = []
  let inBashFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (/^```bash\s*$/.test(line.trim())) { inBashFence = true; continue }
    if (inBashFence && /^```\s*$/.test(line.trim())) { inBashFence = false; continue }
    if (!inBashFence) continue

    if (!line.includes('node scripts/ops/set-maintenance-mode.ts')) continue

    const startLine = i + 1
    const commandLines: string[] = [line]
    while (commandLines[commandLines.length - 1]!.trimEnd().endsWith('\\')) {
      i++
      commandLines.push(lines[i]!)
    }

    const joined = commandLines
      .map(l => l.trimEnd().replace(/\\$/, ''))
      .join(' ')
      .replace('node scripts/ops/set-maintenance-mode.ts', '')
      .trim()

    const substituted = joined.split(OPERATOR_PLACEHOLDER).join(OPERATOR_SUBSTITUTE)

    if (substituted.includes('<') || substituted.includes('>')) continue // still a template — skip

    invocations.push({ line: startLine, tokens: tokenize(substituted) })
  }

  return invocations
}

describe('MEMBERSHIP_BACKFILL.md — set-maintenance-mode.ts examples match the real CLI parser', () => {
  const markdown = readFileSync(RUNBOOK_PATH, 'utf-8')
  const invocations = extractConcreteInvocations(markdown)

  test('at least one concrete example was found (the extractor itself is not silently matching nothing)', () => {
    expect(invocations.length).toBeGreaterThan(0)
  })

  test.each(invocations.map(inv => [inv.line, inv.tokens] as const))(
    'runbook line %i is accepted by parseMaintenanceModeCliArgs()',
    (_line, tokens) => {
      expect(() => parseMaintenanceModeCliArgs(tokens)).not.toThrow()
    },
  )

  test('every concrete --environment production example requires --task-id exactly "SEC-005" (the doc never drifts to an unauthorized task-id)', () => {
    const productionInvocations = invocations.filter(inv => inv.tokens.includes('production'))
    expect(productionInvocations.length).toBeGreaterThan(0)
    for (const inv of productionInvocations) {
      const opts = parseMaintenanceModeCliArgs(inv.tokens)
      expect(opts.environment).toBe('production')
      expect(opts.taskId).toBe('SEC-005')
    }
  })
})

/** Extracts the body of a `### <headingText>` markdown section — every
 * line from that heading (exclusive) up to (but not including) the next
 * `##`/`###` heading, or end of file. Returns `undefined` if the heading
 * itself is never found, so a caller can assert "section exists" as its
 * own check rather than silently asserting properties of an empty
 * string. */
function extractSection(markdown: string, headingText: string): string | undefined {
  const lines = markdown.split('\n')
  const headingIndex = lines.findIndex(l => l.trim() === headingText)
  if (headingIndex === -1) return undefined

  const bodyLines: string[] = []
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i]!)) break
    bodyLines.push(lines[i]!)
  }
  return bodyLines.join('\n')
}

// Independent audit — production execution gate re-review, Step 2 finding:
// the runbook used to say "proceed to Step 3 regardless of whether this
// step reports changed: true ..." — unsafe, because changed: true means
// Step 2 found and disabled an ALREADY-ENABLED SEC-005 maintenance
// record, which can only mean a previous production cycle left it
// enabled (stopped after enable/apply but before verify/disable). This
// regression test locks in the corrected semantic contract of Step 2's
// prose — not the exact wording, so future copy-edits don't spuriously
// break it, but the essential safety markers a human operator depends on.
describe('MEMBERSHIP_BACKFILL.md — Step 2 requires STOP-and-investigate on changed: true', () => {
  const markdown = readFileSync(RUNBOOK_PATH, 'utf-8')
  const step2 = extractSection(
    markdown,
    '### Step 2 — confirm `system/maintenance` is in a known, disabled state (read-only precheck)',
  )

  test('the Step 2 section is found and non-empty (this test cannot be silently checking an empty string)', () => {
    expect(step2).toBeDefined()
    expect(step2!.trim().length).toBeGreaterThan(0)
  })

  test('a non-zero exit code is explicitly required to STOP before Step 3', () => {
    const idx = step2!.indexOf('Non-zero exit code')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(step2!.slice(idx, idx + 40)).toMatch(/STOP/)
  })

  test('changed: true is explicitly required to STOP, not merely noted', () => {
    const idx = step2!.indexOf('`changed: true`')
    expect(idx).toBeGreaterThanOrEqual(0)
    // The STOP instruction must appear tied to this specific outcome, not
    // just somewhere else in the section — checked by proximity to the
    // "changed: true" mention rather than requiring exact wording.
    expect(step2!.slice(idx, idx + 40)).toMatch(/STOP/)
  })

  test('the old "proceed to Step 3 regardless" instruction (or an equivalent "regardless" escape hatch) is gone', () => {
    expect(step2).not.toMatch(/regardless/i)
  })

  test('a safe, no-investigation-needed transition to Step 3 is tied specifically to changed: false', () => {
    // lastIndexOf, not indexOf: `changed: false` is also mentioned
    // earlier in this section (describing the plain --disable-on-a-
    // -missing-document no-op) — the safety-relevant mention is the
    // final one, in the STOP/proceed decision list.
    const idx = step2!.lastIndexOf('`changed: false`')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(step2!.slice(idx, idx + 60)).toMatch(/Step 3/)
  })

  test('an unexplained prior cycle must be investigated before a new one starts (the operator is told what to check, not just told to stop)', () => {
    expect(step2).toMatch(/SEC-005\.md/)
    expect(step2).toMatch(/apply/i)
    expect(step2).toMatch(/verify/i)
  })
})
