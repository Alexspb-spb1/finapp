import { describe, it, expect } from 'vitest'
import { parseMaintenanceModeCliArgs, MaintenanceModeCliArgError } from './maintenanceModeCli.ts'

const baseEnable = ['--environment', 'emulator', '--project', 'demo-finapp', '--enable', '--reason', 'SEC-005 backfill', '--task-id', 'SEC-005', '--operator', 'alice']
const baseDisable = ['--environment', 'emulator', '--project', 'demo-finapp', '--disable', '--task-id', 'SEC-005', '--operator', 'alice']

describe('parseMaintenanceModeCliArgs — required flags', () => {
  it('throws when --environment is missing', () => {
    expect(() => parseMaintenanceModeCliArgs(['--project', 'demo-finapp', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice'])).toThrow(MaintenanceModeCliArgError)
  })

  it('throws when --project is missing', () => {
    expect(() => parseMaintenanceModeCliArgs(['--environment', 'emulator', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice'])).toThrow(MaintenanceModeCliArgError)
  })

  it('throws when neither --enable nor --disable is given', () => {
    expect(() => parseMaintenanceModeCliArgs(['--environment', 'emulator', '--project', 'demo-finapp', '--operator', 'alice'])).toThrow(MaintenanceModeCliArgError)
  })

  it('throws when both --enable and --disable are given', () => {
    expect(() => parseMaintenanceModeCliArgs([...baseEnable, '--disable'])).toThrow(MaintenanceModeCliArgError)
  })

  it('throws when --operator is missing for --enable', () => {
    expect(() => parseMaintenanceModeCliArgs(['--environment', 'emulator', '--project', 'demo-finapp', '--enable', '--reason', 'x', '--task-id', 'SEC-005'])).toThrow(MaintenanceModeCliArgError)
  })

  it('throws when --operator is missing for --disable', () => {
    expect(() => parseMaintenanceModeCliArgs(['--environment', 'emulator', '--project', 'demo-finapp', '--disable'])).toThrow(MaintenanceModeCliArgError)
  })

  it('--enable requires --reason', () => {
    expect(() => parseMaintenanceModeCliArgs(['--environment', 'emulator', '--project', 'demo-finapp', '--enable', '--task-id', 'SEC-005', '--operator', 'alice'])).toThrow(MaintenanceModeCliArgError)
  })

  it('--enable requires --task-id', () => {
    expect(() => parseMaintenanceModeCliArgs(['--environment', 'emulator', '--project', 'demo-finapp', '--enable', '--reason', 'x', '--operator', 'alice'])).toThrow(MaintenanceModeCliArgError)
  })

  it('--disable does NOT require --reason', () => {
    const opts = parseMaintenanceModeCliArgs(baseDisable)
    expect(opts.action).toBe('disable')
  })

  // ── Production execution gate round: --task-id is now required for
  // --disable too — the script must know WHICH task's maintenance record
  // it is targeting, so it can refuse to disable a different task's
  // window. ────────────────────────────────────────────────────────────
  it('--disable requires --task-id', () => {
    expect(() => parseMaintenanceModeCliArgs(['--environment', 'emulator', '--project', 'demo-finapp', '--disable', '--operator', 'alice'])).toThrow(MaintenanceModeCliArgError)
  })

  it('--environment production requires --task-id to be exactly "SEC-005"', () => {
    expect(() => parseMaintenanceModeCliArgs([
      '--environment', 'production', '--project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83',
      '--enable', '--reason', 'x', '--task-id', 'SEC-999', '--operator', 'alice',
    ])).toThrow(/SEC-005/)
  })

  it('--environment emulator/staging allow a --task-id other than "SEC-005" (the production-only restriction does not apply)', () => {
    const opts = parseMaintenanceModeCliArgs(['--environment', 'emulator', '--project', 'demo-finapp', '--enable', '--reason', 'x', '--task-id', 'SEC-999', '--operator', 'alice'])
    expect(opts.taskId).toBe('SEC-999')
  })

  it('throws on an unknown argument', () => {
    expect(() => parseMaintenanceModeCliArgs([...baseEnable, '--force'])).toThrow(MaintenanceModeCliArgError)
  })

  it('throws on an unknown --environment value', () => {
    expect(() => parseMaintenanceModeCliArgs(['--environment', 'bogus', '--project', 'x', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice'])).toThrow(MaintenanceModeCliArgError)
  })
})

describe('parseMaintenanceModeCliArgs — accepted shapes', () => {
  it('parses a full --enable invocation', () => {
    const opts = parseMaintenanceModeCliArgs(baseEnable)
    expect(opts).toEqual({
      environment: 'emulator', project: 'demo-finapp', confirmProject: undefined,
      action: 'enable', reason: 'SEC-005 backfill', taskId: 'SEC-005', operator: 'alice',
    })
  })

  it('parses a full --disable invocation', () => {
    const opts = parseMaintenanceModeCliArgs(baseDisable)
    expect(opts).toEqual({
      environment: 'emulator', project: 'demo-finapp', confirmProject: undefined,
      action: 'disable', reason: undefined, taskId: 'SEC-005', operator: 'alice',
    })
  })

  it('captures --confirm-project for staging/production', () => {
    const opts = parseMaintenanceModeCliArgs([
      '--environment', 'production', '--project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83',
      '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice',
    ])
    expect(opts.confirmProject).toBe('finapp-prod-10a83')
  })
})

// Audit-fix round, item 3 — no flag may be repeated, even with an
// identical value ("no last-value-wins"), mirroring
// scripts/lib/cli.ts's markSeenOnce() behavior.
describe('parseMaintenanceModeCliArgs — no repeated flags (no last-value-wins)', () => {
  const REPEATABLE_VALUE_FLAG_CASES: Array<{ flag: string; args: string[] }> = [
    { flag: '--environment', args: ['--environment', 'emulator', '--environment', 'emulator', '--project', 'demo-finapp', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice'] },
    { flag: '--project', args: ['--environment', 'emulator', '--project', 'demo-finapp', '--project', 'demo-finapp', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice'] },
    { flag: '--confirm-project', args: ['--environment', 'production', '--project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice'] },
    { flag: '--reason', args: ['--environment', 'emulator', '--project', 'demo-finapp', '--enable', '--reason', 'x', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice'] },
    { flag: '--task-id', args: ['--environment', 'emulator', '--project', 'demo-finapp', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--task-id', 'SEC-005', '--operator', 'alice'] },
    { flag: '--operator', args: ['--environment', 'emulator', '--project', 'demo-finapp', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice', '--operator', 'alice'] },
  ]

  it.each(REPEATABLE_VALUE_FLAG_CASES)('rejects a repeated $flag, even with an identical value', ({ flag, args }) => {
    expect(() => parseMaintenanceModeCliArgs(args)).toThrow(MaintenanceModeCliArgError)
    expect(() => parseMaintenanceModeCliArgs(args)).toThrow(new RegExp(`${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')} was specified more than once`))
  })

  it('rejects a repeated --enable', () => {
    expect(() => parseMaintenanceModeCliArgs(['--environment', 'emulator', '--project', 'demo-finapp', '--enable', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice']))
      .toThrow(/--enable was specified more than once/)
  })

  it('rejects a repeated --disable', () => {
    expect(() => parseMaintenanceModeCliArgs(['--environment', 'emulator', '--project', 'demo-finapp', '--disable', '--disable', '--task-id', 'SEC-005', '--operator', 'alice']))
      .toThrow(/--disable was specified more than once/)
  })

  it('CLI-level: a repeated --operator is refused by argument parsing alone, before any credential acquisition or Firestore I/O', () => {
    // parseMaintenanceModeCliArgs() is a pure function — it never touches
    // credentials or Firestore. Throwing here, rather than returning
    // successfully with the last --operator value silently applied, proves
    // the refusal happens strictly before set-maintenance-mode.ts would go
    // on to call assertEnvironmentGuard()/initFirestore().
    const args = ['--environment', 'production', '--project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--operator', 'alice', '--operator', 'mallory']
    expect(() => parseMaintenanceModeCliArgs(args)).toThrow(MaintenanceModeCliArgError)
    expect(() => parseMaintenanceModeCliArgs(args)).toThrow(/--operator was specified more than once/)
  })

  it('CLI-level: a repeated --task-id is refused by argument parsing alone, before any credential acquisition or Firestore I/O', () => {
    const args = ['--environment', 'production', '--project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83', '--enable', '--reason', 'x', '--task-id', 'SEC-005', '--task-id', 'SEC-005', '--operator', 'alice']
    expect(() => parseMaintenanceModeCliArgs(args)).toThrow(MaintenanceModeCliArgError)
    expect(() => parseMaintenanceModeCliArgs(args)).toThrow(/--task-id was specified more than once/)
  })
})
