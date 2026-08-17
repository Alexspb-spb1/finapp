// CLI argument parsing for scripts/ops/set-maintenance-mode.ts — SEC-005
// production preflight, final round, item 8. Pure (no I/O) — mirrors
// scripts/lib/cli.ts's pattern: a testable parser kept separate from the
// executable entry point.
import type { Environment } from '../lib/firebaseAdmin.ts'

export class MaintenanceModeCliArgError extends Error {}

export type MaintenanceModeAction = 'enable' | 'disable'

export interface MaintenanceModeCliOptions {
  environment: Environment
  project: string | undefined
  confirmProject: string | undefined
  action: MaintenanceModeAction
  reason: string | undefined
  taskId: string | undefined
  /** Operator identifier — recorded as enabledBy (on --enable) or
   * disabledBy (on --disable), so both transitions are attributable. */
  operator: string | undefined
}

const KNOWN_ENVIRONMENTS: readonly Environment[] = ['emulator', 'staging', 'production']

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new MaintenanceModeCliArgError(`${flag} requires a value.`)
  }
  return value
}

/** Parses argv (WITHOUT `node script.ts` prefix). Never defaults
 * --environment or --project, same as scripts/lib/cli.ts. */
export function parseMaintenanceModeCliArgs(args: readonly string[]): MaintenanceModeCliOptions {
  const opts: MaintenanceModeCliOptions = {
    environment: undefined as unknown as Environment,
    project: undefined,
    confirmProject: undefined,
    action: undefined as unknown as MaintenanceModeAction,
    reason: undefined,
    taskId: undefined,
    operator: undefined,
  }

  let environmentSet = false
  const mutableArgs = [...args]

  for (let i = 0; i < mutableArgs.length; i++) {
    const arg = mutableArgs[i]!
    switch (arg) {
      case '--environment': {
        const value = readFlagValue(mutableArgs, i, arg); i++
        if (!KNOWN_ENVIRONMENTS.includes(value as Environment)) throw new MaintenanceModeCliArgError(`Unknown --environment: ${value}`)
        opts.environment = value as Environment
        environmentSet = true
        break
      }
      case '--project': { opts.project = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--confirm-project': { opts.confirmProject = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--enable': {
        if (opts.action !== undefined) throw new MaintenanceModeCliArgError('--enable and --disable are mutually exclusive.')
        opts.action = 'enable'
        break
      }
      case '--disable': {
        if (opts.action !== undefined) throw new MaintenanceModeCliArgError('--enable and --disable are mutually exclusive.')
        opts.action = 'disable'
        break
      }
      case '--reason': { opts.reason = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--task-id': { opts.taskId = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--operator': { opts.operator = readFlagValue(mutableArgs, i, arg); i++; break }
      default:
        throw new MaintenanceModeCliArgError(`Unknown argument: ${arg}`)
    }
  }

  if (!environmentSet) throw new MaintenanceModeCliArgError('--environment is required (emulator|staging|production) — there is no default.')
  if (!opts.project) throw new MaintenanceModeCliArgError('--project is required — there is no default.')
  if (opts.action === undefined) throw new MaintenanceModeCliArgError('Exactly one of --enable or --disable is required.')
  if (!opts.operator) throw new MaintenanceModeCliArgError('--operator <identifier> is required for both --enable and --disable — every transition must be attributable.')
  if (opts.action === 'enable') {
    if (!opts.reason) throw new MaintenanceModeCliArgError('--enable requires --reason <why maintenance mode is being enabled>.')
    if (!opts.taskId) throw new MaintenanceModeCliArgError('--enable requires --task-id <e.g. SEC-005>.')
  }

  return opts
}
