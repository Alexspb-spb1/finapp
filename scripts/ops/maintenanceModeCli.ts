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

  // Audit-fix round, item 3 — mirrors scripts/lib/cli.ts's markSeenOnce():
  // EVERY flag, value-bearing or boolean, may appear at most once. There is
  // no "last argument wins" anywhere in this parser, even when the
  // repeated values are identical — a repeated flag is always an
  // ambiguous command and is refused outright.
  const seenFlags = new Set<string>()
  function markSeenOnce(flag: string): void {
    if (seenFlags.has(flag)) {
      throw new MaintenanceModeCliArgError(`${flag} was specified more than once — ambiguous, refusing (no "last argument wins").`)
    }
    seenFlags.add(flag)
  }

  for (let i = 0; i < mutableArgs.length; i++) {
    const arg = mutableArgs[i]!
    switch (arg) {
      case '--environment': {
        markSeenOnce(arg)
        const value = readFlagValue(mutableArgs, i, arg); i++
        if (!KNOWN_ENVIRONMENTS.includes(value as Environment)) throw new MaintenanceModeCliArgError(`Unknown --environment: ${value}`)
        opts.environment = value as Environment
        environmentSet = true
        break
      }
      case '--project': { markSeenOnce(arg); opts.project = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--confirm-project': { markSeenOnce(arg); opts.confirmProject = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--enable': {
        markSeenOnce(arg)
        if (opts.action !== undefined) throw new MaintenanceModeCliArgError('--enable and --disable are mutually exclusive.')
        opts.action = 'enable'
        break
      }
      case '--disable': {
        markSeenOnce(arg)
        if (opts.action !== undefined) throw new MaintenanceModeCliArgError('--enable and --disable are mutually exclusive.')
        opts.action = 'disable'
        break
      }
      case '--reason': { markSeenOnce(arg); opts.reason = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--task-id': { markSeenOnce(arg); opts.taskId = readFlagValue(mutableArgs, i, arg); i++; break }
      case '--operator': { markSeenOnce(arg); opts.operator = readFlagValue(mutableArgs, i, arg); i++; break }
      default:
        throw new MaintenanceModeCliArgError(`Unknown argument: ${arg}`)
    }
  }

  if (!environmentSet) throw new MaintenanceModeCliArgError('--environment is required (emulator|staging|production) — there is no default.')
  if (!opts.project) throw new MaintenanceModeCliArgError('--project is required — there is no default.')
  if (opts.action === undefined) throw new MaintenanceModeCliArgError('Exactly one of --enable or --disable is required.')
  if (!opts.operator) throw new MaintenanceModeCliArgError('--operator <identifier> is required for both --enable and --disable — every transition must be attributable.')
  // Production execution gate round: `--task-id` is now required for
  // `--disable` too (previously `--enable`-only) — disabling must name
  // WHICH task's maintenance record it is targeting, so the script can
  // refuse to disable a different task's window (see
  // set-maintenance-mode.ts's transactionalDisable()).
  if (!opts.taskId) throw new MaintenanceModeCliArgError(`--${opts.action} requires --task-id <e.g. SEC-005>.`)
  if (opts.action === 'enable') {
    if (!opts.reason) throw new MaintenanceModeCliArgError('--enable requires --reason <why maintenance mode is being enabled>.')
  }
  // Only SEC-005 currently holds a production maintenance-mode
  // authorization (PRODUCTION_ACTION_APPROVED: SEC-005) — refuse any
  // other --task-id for production outright, before any I/O, rather than
  // letting a typo or an unrelated task's operator accidentally touch the
  // one production maintenance record this tool is authorized to manage.
  if (opts.environment === 'production' && opts.taskId !== 'SEC-005') {
    throw new MaintenanceModeCliArgError(`--task-id must be exactly "SEC-005" for --environment production — the only task currently granted a production maintenance-mode authorization, got ${JSON.stringify(opts.taskId)}.`)
  }

  return opts
}
