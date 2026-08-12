// CLI argument parsing for scripts/backfill-memberships.ts — SEC-005.
// Pure (no I/O) — takes an argv-like string array, returns validated
// options or throws CliArgError with a safe message.
import type { Environment } from './firebaseAdmin.ts'
import type { ReportMode } from './report.ts'

const KNOWN_MODES: readonly ReportMode[] = ['dry-run', 'apply', 'verify', 'rollback-from-report']
const KNOWN_ENVIRONMENTS: readonly Environment[] = ['emulator', 'staging', 'production']

export class CliArgError extends Error {}

export interface CliOptions {
  mode: ReportMode
  environment: Environment
  project: string | undefined
  confirmProject: string | undefined
  decisionsFile: string | undefined
  reportPath: string | undefined
  fromReport: string | undefined
  backupReference: string | undefined
  rollbackReference: string | undefined
  ackMaintenance: boolean
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
    backupReference: undefined,
    rollbackReference: undefined,
    ackMaintenance: false,
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
      case '--backup-reference': { opts.backupReference = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--rollback-reference': { opts.rollbackReference = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--ack-maintenance-readonly': { opts.ackMaintenance = true; break }
      default:
        throw new CliArgError(`Unknown argument: ${arg}`)
    }
  }

  if (!environmentSet) throw new CliArgError('--environment is required (emulator|staging|production) — there is no default.')
  if (!opts.reportPath) throw new CliArgError('--report-path is required (absolute path outside the repository).')
  if (opts.mode === 'rollback-from-report' && !opts.fromReport) {
    throw new CliArgError('--mode rollback-from-report requires --from-report <path to the apply report>.')
  }

  return opts
}
