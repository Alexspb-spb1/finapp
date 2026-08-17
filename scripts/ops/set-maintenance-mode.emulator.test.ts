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

  it('overwrites (not merges) stale fields from a previous enable cycle', async () => {
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'old reason', '--task-id', 'SEC-999', '--operator', 'bob'])
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'new reason', '--task-id', 'SEC-005', '--operator', 'alice'])
    const doc = await getMaintenanceDoc()
    expect(doc?.reason).toBe('new reason')
    expect(doc?.taskId).toBe('SEC-005')
    expect(doc?.enabledBy).toBe('alice')
  })
})

describe('set-maintenance-mode.ts --disable', () => {
  it('flips enabled to false while preserving the historical enable fields (merge)', async () => {
    runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--enable', '--reason', 'SEC-005 backfill', '--task-id', 'SEC-005', '--operator', 'alice'])
    const result = runCli(['--environment', 'emulator', '--project', PROJECT_ID, '--disable', '--operator', 'alice'])
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
})

describe('set-maintenance-mode.ts — production refused unconditionally', () => {
  it('refuses --environment production (exit 4) even with all flags given, with zero Firestore writes', async () => {
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
    delete cleanEnv.FIRESTORE_EMULATOR_HOST
    delete cleanEnv.GCLOUD_PROJECT
    delete cleanEnv.GOOGLE_CLOUD_PROJECT

    const result = runCliWithEnv([
      '--environment', 'production', '--project', 'finapp-prod-10a83', '--confirm-project', 'finapp-prod-10a83',
      '--enable', '--reason', 'SEC-005 backfill', '--task-id', 'SEC-005', '--operator', 'alice',
    ], cleanEnv)

    expect(result.code).toBe(4)
    // The emulator-backed `demo-finapp` project (this test's own db handle)
    // must show no trace of this call — proving the refusal happened
    // before initFirestore()/any real I/O, not merely against a
    // production project this test cannot itself observe.
    const doc = await getMaintenanceDoc()
    expect(doc).toBeUndefined()
  })
})
