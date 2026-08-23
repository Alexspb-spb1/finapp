// Audit-fix round, item 1 — regression proof that
// scripts/ops/maintenanceModeTransaction.ts is safe to import in isolation:
// no CLI execution, no argv parsing, no process.exitCode mutation, as a
// side effect of merely importing the module. This is exactly the
// property scripts/ops/set-maintenance-mode.ts does NOT have (it
// unconditionally parses process.argv and calls main() at import time),
// which is why the emulator tests for transactionalEnable/
// transactionalDisable were moved to import from
// ./maintenanceModeTransaction.ts instead.
//
// Proving this requires a genuinely separate process: within THIS vitest
// worker, process.argv/process.exitCode belong to the test runner itself,
// so importing the module in-process would not reproduce (or disprove)
// the bug an independent reviewer actually observed when importing
// set-maintenance-mode.ts. Each case below spawns a fresh `node` process,
// with argv that would be nonsensical for the CLI (or empty), and asserts
// the import alone produces a clean, silent exit — status 0, no
// "Argument error" text, no stderr at all.
import { describe, test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SCRIPTS_OPS_DIR = path.dirname(fileURLToPath(import.meta.url))
const TRANSACTION_MODULE_URL = new URL('./maintenanceModeTransaction.ts', import.meta.url).href

function runNodeImport(extraArgv: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(TRANSACTION_MODULE_URL)}).then(() => { console.log('IMPORT_OK'); }).catch(err => { console.error('IMPORT_FAILED:', err); process.exitCode = 1; });`,
        '--',
        ...extraArgv,
      ],
      { cwd: SCRIPTS_OPS_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { status: e.status, stdout: e.stdout, stderr: e.stderr }
  }
}

describe('maintenanceModeTransaction.ts — import safety', () => {
  test('importing the module alone exits 0 with no argument-error output, even with CLI-nonsensical argv', () => {
    const result = runNodeImport(['--environment', 'production', '--enable'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('IMPORT_OK')
    expect(result.stderr).not.toContain('Argument error')
    expect(result.stderr).toBe('')
  })

  test('importing the module alone exits 0 with no argument-error output, with empty argv', () => {
    const result = runNodeImport([])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('IMPORT_OK')
    expect(result.stderr).not.toContain('Argument error')
    expect(result.stderr).toBe('')
  })
})
