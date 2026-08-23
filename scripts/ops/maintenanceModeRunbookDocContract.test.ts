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
