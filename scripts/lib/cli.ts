// CLI argument parsing for scripts/backfill-memberships.ts — SEC-005.
// Pure (no I/O) — takes an argv-like string array, returns validated
// options or throws CliArgError with a safe message.
import type { Environment } from './firebaseAdmin.ts'
import type { ReportMode } from './report.ts'

const KNOWN_MODES: readonly ReportMode[] = ['dry-run', 'apply', 'verify', 'rollback-from-report', 'rollback-from-plan']
const KNOWN_ENVIRONMENTS: readonly Environment[] = ['emulator', 'staging', 'production']
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i

export class CliArgError extends Error {}

export interface CliOptions {
  mode: ReportMode
  environment: Environment
  project: string | undefined
  confirmProject: string | undefined
  decisionsFile: string | undefined
  reportPath: string | undefined
  fromReport: string | undefined
  /** `--mode rollback-from-plan` only — a verified dry-run report to
   * reconstruct emergency rollback candidates from (final-round fix #7). */
  fromPlan: string | undefined
  backupReference: string | undefined
  rollbackReference: string | undefined
  ackMaintenance: boolean
  /** `--mode rollback-from-report` only (final-round fix #6) — the SHA-256
   * the operator recorded when `apply` printed "Apply report SHA-256";
   * verified against `--from-report`'s actual bytes BEFORE any Firestore
   * read/delete — a tampered or swapped report is refused outright. */
  expectedReportSha256: string | undefined
  /** `--mode rollback-from-plan` only — explicit acknowledgement that this
   * is a last-resort, weaker-evidence recovery path (no real apply report
   * exists), never a default/automatic choice. */
  ackEmergencyReconstruction: boolean
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new CliArgError(`${flag} requires a value.`)
  }
  return value
}

/** Parses argv (WITHOUT `node script.ts` prefix). Never defaults
 * --environment or --project — both must be explicit (task spec §6.3). */
export function parseCliArgs(args: readonly string[]): CliOptions {
  const opts: CliOptions = {
    mode: 'dry-run',
    environment: undefined as unknown as Environment,
    project: undefined,
    confirmProject: undefined,
    decisionsFile: undefined,
    reportPath: undefined,
    fromReport: undefined,
    fromPlan: undefined,
    backupReference: undefined,
    rollbackReference: undefined,
    ackMaintenance: false,
    expectedReportSha256: undefined,
    ackEmergencyReconstruction: false,
  }

  let environmentSet = false
  const mutableArgs = [...args]

  for (let i = 0; i < mutableArgs.length; i++) {
    const arg = mutableArgs[i]!
    switch (arg) {
      case '--mode': {
        const value = readFlagValue(mutableArgs, i, arg); i++
        if (!KNOWN_MODES.includes(value as ReportMode)) throw new CliArgError(`Unknown --mode: ${value}`)
        opts.mode = value as ReportMode
        break
      }
      case '--apply': {
        opts.mode = 'apply'
        break
      }
      case '--environment': {
        const value = readFlagValue(mutableArgs, i, arg); i++
        if (!KNOWN_ENVIRONMENTS.includes(value as Environment)) throw new CliArgError(`Unknown --environment: ${value}`)
        opts.environment = value as Environment
        environmentSet = true
        break
      }
      case '--project': { opts.project = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--confirm-project': { opts.confirmProject = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--decisions-file': { opts.decisionsFile = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--report-path': { opts.reportPath = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--from-report': { opts.fromReport = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--from-plan': { opts.fromPlan = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--backup-reference': { opts.backupReference = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--rollback-reference': { opts.rollbackReference = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--ack-maintenance-readonly': { opts.ackMaintenance = true; break }
      case '--expected-report-sha256': { opts.expectedReportSha256 = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--ack-emergency-reconstruction': { opts.ackEmergencyReconstruction = true; break }
      default:
        throw new CliArgError(`Unknown argument: ${arg}`)
    }
  }

  if (!environmentSet) throw new CliArgError('--environment is required (emulator|staging|production) — there is no default.')
  if (!opts.reportPath) throw new CliArgError('--report-path is required (absolute path outside the repository).')
  if (opts.mode === 'rollback-from-report') {
    if (!opts.fromReport) {
      throw new CliArgError('--mode rollback-from-report requires --from-report <path to the apply report>.')
    }
    if (!opts.expectedReportSha256) {
      throw new CliArgError('--mode rollback-from-report requires --expected-report-sha256 <the SHA-256 printed by apply as "Apply report SHA-256"> — verified against --from-report\'s actual bytes before any deletion, so a tampered or swapped report is refused outright.')
    }
  }
  if (opts.expectedReportSha256 !== undefined && !SHA256_HEX_PATTERN.test(opts.expectedReportSha256)) {
    throw new CliArgError('--expected-report-sha256 must be a 64-character hex SHA-256 digest.')
  }
  if (opts.mode === 'rollback-from-plan') {
    if (!opts.fromPlan) {
      throw new CliArgError('--mode rollback-from-plan requires --from-plan <path to a verified dry-run report>.')
    }
    if (!opts.ackEmergencyReconstruction) {
      throw new CliArgError('--mode rollback-from-plan requires --ack-emergency-reconstruction — this is a last-resort, weaker-evidence recovery path for when the actual apply report has been lost; it must never be a default choice.')
    }
  }

  return opts
}
