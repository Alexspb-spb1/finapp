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

/** Every action ANY part of the SEC-005 tooling can ever attempt against
 * Firestore for a given `Environment` — the migration CLI's five
 * `ReportMode`s, plus the two maintenance-mode transitions
 * (`scripts/ops/set-maintenance-mode.ts`, which has no `ReportMode`
 * concept of its own). Independent audit fixes, production execution
 * gate round, item 1: `assertCycleExecutionAllowed()`'s `action`
 * parameter is now REQUIRED and fully typed — there is no `undefined`
 * shortcut a caller can pass (accidentally or otherwise) to mean
 * "refused"; every call site must name exactly which action it is
 * attempting, and the type checker enforces that a valid
 * `CycleExecutionAction` is always supplied. */
export type CycleExecutionAction =
  | 'dry-run'
  | 'apply'
  | 'verify'
  | 'rollback-from-report'
  | 'rollback-from-plan'
  | 'maintenance-enable'
  | 'maintenance-disable'

/** The complete, closed set of actions this function ever recognizes at
 * all — used to fail-closed on a value that somehow bypassed the type
 * checker (a mistyped literal cast, JSON-derived input, etc.). Kept as
 * its own list (rather than deriving it from `PRODUCTION_ALLOWED_ACTIONS`
 * below) so the two are independently visible and a future addition to
 * one is never silently assumed to apply to the other. */
const KNOWN_ACTIONS: ReadonlySet<CycleExecutionAction> = new Set<CycleExecutionAction>([
  'dry-run', 'apply', 'verify', 'rollback-from-report', 'rollback-from-plan', 'maintenance-enable', 'maintenance-disable',
])

/** Actions `environment === 'production'` is currently authorized for —
 * the exact scope of the `PRODUCTION_ACTION_APPROVED: SEC-005` grant that
 * opened this gate: enable maintenance, create+verify backup (backup
 * itself is outside this tool — see BASE-003 — so not a CycleExecutionAction
 * here), a create-only `apply` against a verified resolved plan, `verify`,
 * disable maintenance after verify passes, and `rollback-from-report`/
 * `rollback-from-plan` as the emergency undo path for exactly what this
 * apply created. `dry-run` remains allowed (unchanged from the prior,
 * narrower `PRODUCTION_PREFLIGHT_APPROVED: SEC-005` grant it superseded).
 * This gate is only ONE of several independent protections `apply` must
 * still pass — see `scripts/lib/productionSafety.ts` (maintenance
 * verified live, backup freshness, two-phase rollback-plan verification,
 * create-only writes) and `scripts/lib/sourceRevision.ts` (clean tracked
 * worktree) — none of which this gate substitutes for or weakens. */
const PRODUCTION_ALLOWED_ACTIONS: ReadonlySet<CycleExecutionAction> = new Set<CycleExecutionAction>([
  'dry-run', 'apply', 'verify', 'rollback-from-report', 'rollback-from-plan', 'maintenance-enable', 'maintenance-disable',
])

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
 * proceed past this gate for ANY known action.
 *
 * `production` was granted `PRODUCTION_ACTION_APPROVED: SEC-005` — a
 * controlled production cycle (maintenance enable → verified backup →
 * create-only apply against a verified resolved plan → verify →
 * maintenance disable → rollback-from-report/rollback-from-plan as the
 * emergency path), superseding the earlier, narrower
 * `PRODUCTION_PREFLIGHT_APPROVED: SEC-005` (read-only dry-run only).
 * `environment === 'production'` is allowed to proceed for exactly the
 * actions in `PRODUCTION_ALLOWED_ACTIONS` above — any action not in that
 * set (or not a recognized `CycleExecutionAction` at all) is refused,
 * fail-closed, with no environment-variable, string, or optional-flag
 * override of any kind. This gate does not itself verify maintenance
 * state, backup freshness, plan integrity, or worktree cleanliness — see
 * `scripts/lib/productionSafety.ts`/`scripts/lib/sourceRevision.ts` for
 * those; this function only answers "has ANY grant authorized this
 * (environment, action) pair at all".
 */
export function assertCycleExecutionAllowed(environment: Environment, action: CycleExecutionAction): void {
  if (!KNOWN_ACTIONS.has(action)) {
    throw new CycleExecutionError(`unknown action ${JSON.stringify(action)} — refusing (fail-closed; no action is authorized by default).`)
  }
  if (environment === 'production' && !PRODUCTION_ALLOWED_ACTIONS.has(action)) {
    throw new CycleExecutionError(`production ${action} requires a separate, explicit PRODUCTION_ACTION_APPROVED grant from the repository owner naming this action, which has not been given this cycle.`)
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
