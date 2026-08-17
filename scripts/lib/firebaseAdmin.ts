// Environment/project guards + Admin SDK init for the SEC-005 membership
// backfill tool — scripts/backfill-memberships.ts.
//
// Hard rule (task spec §6): a project-ID conflict between CLI flag, env var,
// and (for non-emulator environments) the credential's own project must be
// rejected BEFORE any credential is acquired or any Firestore document is
// read. `firebase-admin` is a root devDependency (not imported through
// functions/node_modules) — see package.json.
import { initializeApp, getApps, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

export type Environment = 'emulator' | 'staging' | 'production'

export const EXPECTED_PROJECT_ID: Record<Environment, string> = {
  emulator: 'demo-finapp',
  staging: 'finapp-staging',
  production: 'finapp-prod-10a83',
}

export class EnvironmentGuardError extends Error {}

export interface EnvironmentGuardInput {
  environment: Environment
  /** --project flag value. */
  cliProjectId: string | undefined
  /** GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT env var, if set. */
  envProjectId: string | undefined
  /** process.env.FIRESTORE_EMULATOR_HOST, if set. */
  firestoreEmulatorHost: string | undefined
  /** --confirm-project flag value (staging/production only). */
  confirmProjectId: string | undefined
}

/**
 * Pure guard — validates environment/project consistency WITHOUT touching
 * credentials or Firestore. Throws EnvironmentGuardError with a safe
 * (no-secret) message on any violation. Exported separately from
 * initFirestore() so it is unit-testable without the Admin SDK.
 */
export function assertEnvironmentGuard(input: EnvironmentGuardInput): string {
  const { environment, cliProjectId, envProjectId, firestoreEmulatorHost, confirmProjectId } = input

  if (!cliProjectId) {
    throw new EnvironmentGuardError('--project is required (no default — production is never implied).')
  }

  const expected = EXPECTED_PROJECT_ID[environment]
  if (cliProjectId !== expected) {
    throw new EnvironmentGuardError(`--project must be "${expected}" for --environment ${environment}, got a different value.`)
  }

  if (envProjectId !== undefined && envProjectId !== cliProjectId) {
    throw new EnvironmentGuardError('Project ID conflict between --project and GCLOUD_PROJECT/GOOGLE_CLOUD_PROJECT — refusing before credential acquisition.')
  }

  if (environment === 'emulator') {
    if (!firestoreEmulatorHost) {
      throw new EnvironmentGuardError('--environment emulator requires FIRESTORE_EMULATOR_HOST to be set.')
    }
  } else {
    if (confirmProjectId !== expected) {
      throw new EnvironmentGuardError(`--environment ${environment} requires --confirm-project ${expected} (exact match) as an explicit human confirmation.`)
    }
    if (firestoreEmulatorHost) {
      throw new EnvironmentGuardError(`FIRESTORE_EMULATOR_HOST is set but --environment is ${environment} — refusing an ambiguous configuration.`)
    }
  }

  return expected
}

export class CycleExecutionError extends Error {}

/** The only modes `assertCycleExecutionAllowed()` ever lets through for
 * `environment === 'production'` — see below. Kept as a narrow local
 * union (not the full `ReportMode`) so this file does not need to import
 * `report.ts` just for a type. */
export type CycleExecutionMode = 'dry-run' | 'apply' | 'verify' | 'rollback-from-report' | 'rollback-from-plan'

/**
 * Cycle-scoped execution authorization — deliberately SEPARATE from
 * assertEnvironmentGuard() above, which only checks project-ID
 * consistency and is identical regardless of which external environment a
 * given remediation cycle happens to be authorized for. A single cycle may
 * be granted `EXTERNAL_ACTION_APPROVED: <TASK-ID>` / `ENVIRONMENT:
 * staging` without that implying anything about production — production
 * requires its own, separate grant (CLAUDE.md §5).
 *
 * SEC-005 has been granted `EXTERNAL_ACTION_APPROVED: SEC-005` /
 * `ENVIRONMENT: staging` — `emulator` and `staging` are both allowed to
 * proceed past this gate for ANY mode.
 *
 * `production` was granted `PRODUCTION_PREFLIGHT_APPROVED: SEC-005` —
 * explicitly scoped to "deploy maintenance protection, create+verify
 * backup, read-only dry-run"; apply/backfill remains explicitly forbidden
 * ("Backfill/apply пока запрещён"). This function reflects EXACTLY that
 * scope: `environment === 'production'` is allowed to proceed ONLY when
 * `mode === 'dry-run'` (never writes — no `DocumentReference.create()`
 * anywhere in the dry-run path). `apply`, `verify` (requires a decisions
 * file tied to a completed apply — meaningless without one), `rollback-
 * from-report`, and `rollback-from-plan` all remain UNCONDITIONALLY
 * refused for production — this check does not accept or consult any
 * other flag (backup-reference, rollback-reference, ack-maintenance-
 * readonly, or otherwise) for those modes; no broader
 * `PRODUCTION_ACTION_APPROVED` grant (with verified `BACKUP_REFERENCE`/
 * `ROLLBACK_REFERENCE`, per CLAUDE.md §5) has been given this cycle for
 * an actual backfill, and none can make this function return without
 * throwing for any production mode other than `dry-run`.
 *
 * `mode` is OPTIONAL: callers with no `ReportMode` concept of their own —
 * e.g. `scripts/ops/set-maintenance-mode.ts`, whose only "modes" are
 * enable/disable, neither of which is authorized for production this
 * cycle — simply omit it, which always refuses `production` (`undefined
 * !== 'dry-run'`), the same as passing an explicitly-unauthorized mode.
 */
export function assertCycleExecutionAllowed(environment: Environment, mode?: CycleExecutionMode): void {
  if (environment === 'production' && mode !== 'dry-run') {
    throw new CycleExecutionError(`production${mode ? ` ${mode}` : ''} requires a separate, explicit PRODUCTION_ACTION_APPROVED grant (with verified BACKUP_REFERENCE/ROLLBACK_REFERENCE) from the repository owner, which has not been given this cycle — only PRODUCTION_PREFLIGHT_APPROVED: SEC-005 (read-only dry-run) has been granted.`)
  }
}

let cachedApp: App | undefined

/** Initializes (once per process) and returns the Admin SDK Firestore
 * client. Never reads a service-account file itself — Application Default
 * Credentials / GOOGLE_APPLICATION_CREDENTIALS resolution is entirely
 * delegated to the Admin SDK, and nothing here logs or inspects credential
 * content. Must only be called AFTER assertEnvironmentGuard() succeeds. */
export function initFirestore(projectId: string): Firestore {
  if (!cachedApp) {
    // No `credential` field: the Admin SDK resolves Application Default
    // Credentials itself (GOOGLE_APPLICATION_CREDENTIALS env var, metadata
    // server, or gcloud CLI credentials) — this script never reads or
    // parses a service-account file itself. For the emulator, the Admin
    // SDK automatically detects FIRESTORE_EMULATOR_HOST and skips real
    // credential auth entirely.
    cachedApp = getApps().length > 0 ? getApps()[0]! : initializeApp({ projectId })
  }
  return getFirestore(cachedApp)
}
