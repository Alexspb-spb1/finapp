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

/**
 * Cycle-scoped execution authorization — deliberately SEPARATE from
 * assertEnvironmentGuard() above, which only checks project-ID
 * consistency and is identical regardless of which external environment a
 * given remediation cycle happens to be authorized for. A single cycle may
 * be granted `EXTERNAL_ACTION_APPROVED: <TASK-ID>` / `ENVIRONMENT:
 * staging` without that implying anything about production — production
 * requires its own, separate `PRODUCTION_ACTION_APPROVED` grant with a
 * verified `BACKUP_REFERENCE`/`ROLLBACK_REFERENCE` (CLAUDE.md §5).
 *
 * SEC-005 has been granted `EXTERNAL_ACTION_APPROVED: SEC-005` /
 * `ENVIRONMENT: staging` — `emulator` and `staging` are both allowed to
 * proceed past this gate. `production` remains UNCONDITIONALLY refused —
 * this check does not accept or consult any flag (backup-reference,
 * rollback-reference, ack-maintenance-readonly, or otherwise); no
 * PRODUCTION_ACTION_APPROVED grant has been given this cycle, and none can
 * make this function return without throwing for `production`.
 */
export function assertCycleExecutionAllowed(environment: Environment): void {
  if (environment === 'production') {
    throw new CycleExecutionError('production backfill requires a separate, explicit PRODUCTION_ACTION_APPROVED grant (with verified BACKUP_REFERENCE/ROLLBACK_REFERENCE) from the repository owner, which has not been given this cycle.')
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
