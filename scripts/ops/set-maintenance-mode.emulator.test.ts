// Real Firestore Emulator proof for scripts/ops/set-maintenance-mode.ts —
// SEC-005 final round, item 8. Spawns the ACTUAL CLI as a child process,
// same pattern as scripts/backfill-memberships.emulator.test.ts.
//
// Run only via `npm run test:migration` (`firebase emulators:exec --project
// demo-finapp --only firestore "vitest run scripts --no-file-parallelism"`).
// `--no-file-parallelism` is required: this file's beforeEach wipes the
// ENTIRE `demo-finapp` Firestore project, and so does
// backfill-memberships.emulator.test.ts's — both target the SAME shared
// emulator project, so running the two files in parallel worker threads
// (vitest's default) lets one file's wipe race the other's seed/assert
// sequence, causing spurious failures with no code defect at all (observed
// and root-caused while adding this file — see package.json's
// `test:migration` script).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'demo-finapp'
const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

let db: Firestore

beforeAll(() => {
  const app = getApps().length > 0 ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID })
  db = getFirestore(app)
})

beforeEach(async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' })
})

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('node', ['scripts/ops/set-maintenance-mode.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
  })
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/** Same rationale as backfill-memberships.emulator.test.ts's
 * runCliWithEnv() — `firebase emulators:exec` sets FIRESTORE_EMULATOR_HOST/
 * GCLOUD_PROJECT on this process, which would make assertEnvironmentGuard()
 * refuse a --environment production invocation for an unrelated reason
 * before ever reaching the cycle-authorization gate this test targets. */
function runCliWithEnv(args: string[], env: NodeJS.ProcessEnv): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('node', ['scripts/ops/set-maintenance-mode.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  })
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

async function getMaintenanceDoc(): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection('system').doc('maintenance').get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

describe('set-maintenance-mode.ts --enable', () => {
  it('writes enabled:true with a real Timestamp enabledAt and the given reason/taskId/operator', async () => {
    const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'SEC-005 backfill', '--task-id', 'SEC-005', '--operator', 'alice'])
    expect(result.code).toBe(0)
    const doc = await getMaintenanceDoc()
    expect(doc?.enabled).toBe(true)
    expect(doc?.enabledBy).toBe('alice')
    expect(doc?.reason).toBe('SEC-005 backfill')
    expect(doc?.taskId).toBe('SEC-005')
    expect(doc?.enabledAt).toBeDefined()
  })

  it('overwrites (not merges) stale fields from a previous, since-disabled enable cycle', async () => {
    // Production execution gate round: --enable no longer overwrites an
    // ALREADY-enabled record in place (see the dedicated
    // "refuses to overwrite an already-enabled record" describe block
    // below) — a fresh window must go through --disable first, same as
    // production would require.
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'old reason', '--task-id', 'SEC-999', '--operator', 'bob'])
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--disable', '--task-id', 'SEC-999', '--operator', 'bob'])
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'new reason', '--task-id', 'SEC-005', '--operator', 'alice'])
    const doc = await getMaintenanceDoc()
    expect(doc?.reason).toBe('new reason')
    expect(doc?.taskId).toBe('SEC-005')
    expect(doc?.enabledBy).toBe('alice')
    // The disabledAt/disabledBy pair from the previous window must not
    // survive the fresh --enable (full overwrite, not merge).
    expect(doc?.disabledAt).toBeUndefined()
    expect(doc?.disabledBy).toBeUndefined()
  })
})

describe('set-maintenance-mode.ts --disable', () => {
  it('flips enabled to false while preserving the historical enable fields (merge)', async () => {
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'SEC-005 backfill', '--task-id', 'SEC-005', '--operator', 'alice'])
    const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--disable', '--task-id', 'SEC-005', '--operator', 'alice'])
    expect(result.code).toBe(0)
    const doc = await getMaintenanceDoc()
    expect(doc?.enabled).toBe(false)
    // Historical fields survive the merge — audit trail preserved.
    expect(doc?.reason).toBe('SEC-005 backfill')
    expect(doc?.taskId).toBe('SEC-005')
    expect(doc?.enabledBy).toBe('alice')
    expect(doc?.disabledAt).toBeDefined()
    expect(doc?.disabledBy).toBe('alice')
  })

  // ── Production execution gate round: --task-id is now required for
  // --disable too (previously --enable-only), and cross-task/idempotent
  // behavior is enforced transactionally — see
  // maintenanceModeTransaction.emulator.test.ts for the exhaustive,
  // direct-function-level proof of every branch. These CLI-spawn tests
  // only confirm the wiring (arg parsing -> gate -> transaction) end to
  // end. ────────────────────────────────────────────────────────────────
  it('--disable without --task-id is rejected by argument parsing (exit 2), before any Firestore I/O', async () => {
    const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--disable', '--operator', 'alice'])
    expect(result.code).toBe(2)
    expect(await getMaintenanceDoc()).toBeUndefined()
  })

  it('refuses (exit 1) to disable a record belonging to a different task, leaving it untouched', async () => {
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'unrelated task window', '--task-id', 'SEC-999', '--operator', 'bob'])
    const before = await getMaintenanceDoc()

    const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--disable', '--task-id', 'SEC-005', '--operator', 'mallory'])

    expect(result.code).toBe(1)
    expect(await getMaintenanceDoc()).toEqual(before)
  })

  it('disabling an already-disabled SEC-005 record is an idempotent no-op (exit 0)', async () => {
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'SEC-005 backfill', '--task-id', 'SEC-005', '--operator', 'alice'])
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--disable', '--task-id', 'SEC-005', '--operator', 'alice'])
    const before = await getMaintenanceDoc()

    const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--disable', '--task-id', 'SEC-005', '--operator', 'alice'])

    expect(result.code).toBe(0)
    expect(await getMaintenanceDoc()).toEqual(before) // no spurious re-write
  })
})

describe('set-maintenance-mode.ts --enable — refuses to overwrite an already-enabled record', () => {
  it('exit 1, document left completely untouched (enabledAt unchanged)', async () => {
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'original window', '--task-id', 'SEC-005', '--operator', 'alice'])
    const before = await getMaintenanceDoc()

    const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'accidental second enable', '--task-id', 'SEC-005', '--operator', 'mallory'])

    expect(result.code).toBe(1)
    expect(await getMaintenanceDoc()).toEqual(before)
  })
})

// ── Production execution gate round: `maintenance-enable`/`maintenance-disable`
// are now authorized for production under PRODUCTION_ACTION_APPROVED:
// SEC-005 (see scripts/lib/firebaseAdmin.ts's PRODUCTION_ALLOWED_ACTIONS
// and its own unit tests) — the OLD "production refused unconditionally"
// claim this test used to make is no longer true, and deliberately is NOT
// replaced with a real-CLI-invocation test against `--environment
// production`: with the cycle gate now open for these actions, such a
// call would proceed past assertCycleExecutionAllowed() toward
// initFirestore()/real Firestore I/O against the real `finapp-prod-10a83`
// project — exactly what an automated test suite must never risk. The
// gate's new ALLOW behavior is proven exhaustively, with zero I/O of any
// kind, at the unit level instead
// (scripts/lib/firebaseAdmin.test.ts, `assertCycleExecutionAllowed`).
//
// What IS still safe to prove here via the real CLI binary against
// `--environment production`: `--task-id` validation happens entirely
// inside argument parsing (maintenanceModeCli.ts), with no Firestore
// dependency and no credential acquisition — refusing a non-SEC-005
// task-id for production is provably zero-I/O regardless of the cycle
// gate's own state.
describe('set-maintenance-mode.ts — production requires --task-id exactly "SEC-005" (checked in argument parsing, zero I/O)', () => {
  it('rejects a non-SEC-005 --task-id for --environment production (exit 2), before any credential acquisition or Firestore I/O', () => {
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
    delete cleanEnv.FIRESTORE_EMULATOR_HOST
    delete cleanEnv.GCLOUD_PROJECT
    delete cleanEnv.GOOGLE_CLOUD_PROJECT

    const result = runCliWithEnv([
      '--environment', 'production', '--project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83',
      '--enable', '--reason', 'attempted', '--task-id', 'SEC-999', '--operator', 'alice',
    ], cleanEnv)

    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/SEC-005/)
  })
})
