import { describe, it, expect } from 'vitest'
import { parseCliArgs, CliArgError } from './cli.ts'

const baseArgs = ['--environment', 'emulator', '--project', 'demo-finapp', '--report-path', '/tmp/report.json']

describe('parseCliArgs — mode default', () => {
  it('defaults to dry-run when no mode is given (task requirement)', () => {
    const opts = parseCliArgs(baseArgs)
    expect(opts.mode).toBe('dry-run')
  })

  it('--apply switches mode to apply', () => {
    const opts = parseCliArgs([...baseArgs, '--apply'])
    expect(opts.mode).toBe('apply')
  })

  it('--mode verify is accepted', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'verify'])
    expect(opts.mode).toBe('verify')
  })
})

describe('parseCliArgs — required flags', () => {
  it('throws when --environment is missing — no default environment', () => {
    expect(() => parseCliArgs(['--project', 'demo-finapp', '--report-path', '/tmp/r.json'])).toThrow(CliArgError)
  })

  it('throws when --report-path is missing', () => {
    expect(() => parseCliArgs(['--environment', 'emulator', '--project', 'demo-finapp'])).toThrow(CliArgError)
  })

  it('throws on an unknown --environment value', () => {
    expect(() => parseCliArgs(['--environment', 'bogus', '--project', 'x', '--report-path', '/tmp/r.json'])).toThrow(CliArgError)
  })

  it('rollback-from-report requires --from-report', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-report'])).toThrow(CliArgError)
  })

  it('throws on an unknown argument', () => {
    expect(() => parseCliArgs([...baseArgs, '--force'])).toThrow(CliArgError)
  })
})

describe('parseCliArgs — passthrough flags', () => {
  it('captures decisions-file, confirm-project, backup/rollback references', () => {
    const opts = parseCliArgs([
      '--environment', 'production', '--project', 'finapp-prod-10a83', '--report-path', '/tmp/r.json',
      '--confirm-project', 'finapp-prod-10a83', '--decisions-file', '/tmp/d.json',
      '--backup-reference', 'backup-123', '--rollback-reference', 'rollback-doc-url', '--ack-maintenance-readonly',
    ])
    expect(opts.environment).toBe('production')
    expect(opts.confirmProject).toBe('finapp-prod-10a83')
    expect(opts.decisionsFile).toBe('/tmp/d.json')
    expect(opts.backupReference).toBe('backup-123')
    expect(opts.rollbackReference).toBe('rollback-doc-url')
    expect(opts.ackMaintenance).toBe(true)
  })
})
