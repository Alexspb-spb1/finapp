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

  // ── Final-round fix #6: rollback-from-report requires --expected-report-sha256 ──
  const HEX64 = 'a'.repeat(64)

  it('rollback-from-report requires --expected-report-sha256 even when --from-report is given', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-report', '--from-report', '/tmp/a.json'])).toThrow(CliArgError)
  })

  it('accepts rollback-from-report when both --from-report and --expected-report-sha256 are given', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'rollback-from-report', '--from-report', '/tmp/a.json', '--expected-report-sha256', HEX64])
    expect(opts.fromReport).toBe('/tmp/a.json')
    expect(opts.expectedReportSha256).toBe(HEX64)
  })

  it('rejects a malformed (non-hex, wrong-length) --expected-report-sha256', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-report', '--from-report', '/tmp/a.json', '--expected-report-sha256', 'not-a-hash'])).toThrow(CliArgError)
  })

  // ── Final-round fix #7: rollback-from-plan requires --from-plan + --ack-emergency-reconstruction ──
  it('rollback-from-plan requires --from-plan', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-plan', '--ack-emergency-reconstruction', '--expected-plan-sha256', HEX64])).toThrow(CliArgError)
  })

  it('rollback-from-plan requires --ack-emergency-reconstruction even with --from-plan given', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-plan', '--from-plan', '/tmp/dry-run.json', '--expected-plan-sha256', HEX64])).toThrow(CliArgError)
  })

  // ── Final-round fix #1 (second round): rollback-from-plan requires --expected-plan-sha256 ──
  it('rollback-from-plan requires --expected-plan-sha256 even with --from-plan and --ack-emergency-reconstruction given', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-plan', '--from-plan', '/tmp/dry-run.json', '--ack-emergency-reconstruction'])).toThrow(CliArgError)
  })

  it('rejects a malformed (non-hex, wrong-length) --expected-plan-sha256', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-plan', '--from-plan', '/tmp/dry-run.json', '--ack-emergency-reconstruction', '--expected-plan-sha256', 'not-a-hash'])).toThrow(CliArgError)
  })

  it('accepts rollback-from-plan when --from-plan, --ack-emergency-reconstruction, and --expected-plan-sha256 are all given', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'rollback-from-plan', '--from-plan', '/tmp/dry-run.json', '--ack-emergency-reconstruction', '--expected-plan-sha256', HEX64])
    expect(opts.fromPlan).toBe('/tmp/dry-run.json')
    expect(opts.ackEmergencyReconstruction).toBe(true)
    expect(opts.expectedPlanSha256).toBe(HEX64)
  })

  // ── Final-round fix #3 (third pass): case-insensitive hash normalization ──
  // PowerShell's `Get-FileHash -Algorithm SHA256` (which the docs point
  // operators at) prints UPPERCASE hex by default, while sha256Hex()
  // (Node crypto) always produces lowercase — both must be accepted and
  // compared as equal.
  const HEX64_UPPER = HEX64.toUpperCase()
  const HEX64_MIXED = HEX64.split('').map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('')

  it('normalizes an UPPERCASE --expected-report-sha256 (PowerShell Get-FileHash output) to lowercase', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'rollback-from-report', '--from-report', '/tmp/a.json', '--expected-report-sha256', HEX64_UPPER])
    expect(opts.expectedReportSha256).toBe(HEX64)
  })

  it('normalizes a MIXED-case --expected-report-sha256 to lowercase', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'rollback-from-report', '--from-report', '/tmp/a.json', '--expected-report-sha256', HEX64_MIXED])
    expect(opts.expectedReportSha256).toBe(HEX64_MIXED.toLowerCase())
  })

  it('accepts an UPPERCASE --expected-report-sha256 as valid format (rejects only non-hex content)', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-report', '--from-report', '/tmp/a.json', '--expected-report-sha256', HEX64_UPPER])).not.toThrow()
  })

  it('normalizes an UPPERCASE --expected-plan-sha256 (PowerShell Get-FileHash output) to lowercase', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'rollback-from-plan', '--from-plan', '/tmp/dry-run.json', '--ack-emergency-reconstruction', '--expected-plan-sha256', HEX64_UPPER])
    expect(opts.expectedPlanSha256).toBe(HEX64)
  })
})

describe('parseCliArgs — passthrough flags', () => {
  it('captures decisions-file, confirm-project, backup/rollback references (apply mode, where these flags belong)', () => {
    const opts = parseCliArgs([
      '--environment', 'production', '--project', 'finapp-prod-10a83', '--report-path', '/tmp/r.json',
      '--confirm-project', 'finapp-prod-10a83', '--decisions-file', '/tmp/d.json', '--apply',
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

// ── Independent audit fixes, 5th round, item 5: mode-specific allowlist ──
describe('parseCliArgs — mode-specific flag allowlist (not merely mode-specific requirements)', () => {
  const HEX64 = 'a'.repeat(64)

  it('rejects --mode dry-run combined with --from-report/--expected-report-sha256 (rollback-only flags)', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'dry-run', '--from-report', '/tmp/a.json', '--expected-report-sha256', HEX64])).toThrow(CliArgError)
  })

  it('rejects --mode dry-run combined with --backup-reference (apply-only flag)', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'dry-run', '--backup-reference', '/tmp/backup.json'])).toThrow(CliArgError)
  })

  it('rejects --mode verify combined with --ack-maintenance-readonly (write-mode-only flag)', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'verify', '--ack-maintenance-readonly'])).toThrow(CliArgError)
  })

  it('rejects --apply (apply mode) combined with --from-plan (rollback-from-plan-only flag)', () => {
    expect(() => parseCliArgs([...baseArgs, '--apply', '--from-plan', '/tmp/dry-run.json', '--ack-emergency-reconstruction', '--expected-plan-sha256', HEX64])).toThrow(CliArgError)
  })

  it('rejects --mode rollback-from-report combined with --ack-emergency-reconstruction (rollback-from-plan-only flag)', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-report', '--from-report', '/tmp/a.json', '--expected-report-sha256', HEX64, '--ack-emergency-reconstruction'])).toThrow(CliArgError)
  })

  it('rejects --mode rollback-from-plan combined with --backup-reference (apply-only flag)', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-plan', '--from-plan', '/tmp/dry-run.json', '--ack-emergency-reconstruction', '--expected-plan-sha256', HEX64, '--backup-reference', '/tmp/backup.json'])).toThrow(CliArgError)
  })

  it('accepts --mode apply with exactly its own allowed flags', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'apply', '--backup-reference', '/tmp/b.json', '--rollback-reference', '/tmp/r2.json', '--ack-maintenance-readonly', '--expected-plan-sha256', HEX64])
    expect(opts.mode).toBe('apply')
  })

  it('accepts --mode dry-run with its own allowed --decisions-file', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'dry-run', '--decisions-file', '/tmp/d.json'])
    expect(opts.mode).toBe('dry-run')
  })

  it('accepts --mode verify with only universal flags', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'verify'])
    expect(opts.mode).toBe('verify')
  })

  // ── Independent audit fixes, 5th round (review of the 5th round's own fix), item 2 ──
  // --decisions-file is read unconditionally by main() but is only ever
  // USED for dry-run/verify/apply's buildPlan() — rollback-from-report and
  // rollback-from-plan return from a dedicated rollback path before it is
  // touched again, so it was wrongly treated as a universal flag.
  it('rejects --mode rollback-from-report combined with --decisions-file (silently ignored, not a rollback-from-report flag)', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-report', '--from-report', '/tmp/a.json', '--expected-report-sha256', HEX64, '--decisions-file', '/tmp/d.json'])).toThrow(CliArgError)
  })

  it('rejects --mode rollback-from-plan combined with --decisions-file (silently ignored, not a rollback-from-plan flag)', () => {
    expect(() => parseCliArgs([...baseArgs, '--mode', 'rollback-from-plan', '--from-plan', '/tmp/dry-run.json', '--ack-emergency-reconstruction', '--expected-plan-sha256', HEX64, '--decisions-file', '/tmp/d.json'])).toThrow(CliArgError)
  })

  it('accepts --mode verify with --decisions-file (buildPlan() genuinely uses it for verify)', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'verify', '--decisions-file', '/tmp/d.json'])
    expect(opts.decisionsFile).toBe('/tmp/d.json')
  })

  it('accepts --mode apply with --decisions-file alongside apply-only flags', () => {
    const opts = parseCliArgs([...baseArgs, '--mode', 'apply', '--decisions-file', '/tmp/d.json', '--backup-reference', '/tmp/b.json', '--rollback-reference', '/tmp/r2.json', '--ack-maintenance-readonly', '--expected-plan-sha256', HEX64])
    expect(opts.decisionsFile).toBe('/tmp/d.json')
  })
})
