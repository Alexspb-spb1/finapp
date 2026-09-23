import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  claimRunManifest, readRunManifest, updateRunManifest, runManifestPathFor, RUN_MANIFEST_VERSION,
} from './gateGaRunManifestCore.mjs'

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-run-manifest-'))
  try { return fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const RECIPIENT_SHA = 'a'.repeat(64)

test('readRunManifest returns null when nothing has been claimed yet', () => {
  withTempDir(dir => {
    assert.equal(readRunManifest({ claimedDir: dir }), null)
  })
})

test('claimRunManifest writes a CLAIMED manifest before any external write, with an empty ledger', () => {
  withTempDir(dir => {
    const claimed = claimRunManifest({ claimedDir: dir, runId: 'run-1', project: 'demo-finapp', profile: 'emulator', recipientSha256: RECIPIENT_SHA, sourceHead: 'a'.repeat(40) })
    assert.equal(claimed.phase, 'CLAIMED')
    assert.equal(claimed.admin, null)
    assert.equal(claimed.invite, null)
    assert.deepEqual(claimed.ledger.createdAuthUids, [])
    const read = readRunManifest({ claimedDir: dir })
    assert.equal(read.runId, 'run-1')
    assert.equal(read.version, RUN_MANIFEST_VERSION)
  })
})

test('claimRunManifest refuses to overwrite an existing manifest (never silently claims twice)', () => {
  withTempDir(dir => {
    claimRunManifest({ claimedDir: dir, runId: 'run-1', project: 'demo-finapp', profile: 'emulator', recipientSha256: RECIPIENT_SHA, sourceHead: 'a'.repeat(40) })
    assert.throws(() => claimRunManifest({ claimedDir: dir, runId: 'run-2', project: 'demo-finapp', profile: 'emulator', recipientSha256: RECIPIENT_SHA, sourceHead: 'a'.repeat(40) }))
  })
})

test('updateRunManifest advances phase and persists admin/invite/ledger, CAS-guarded by fromPhase', () => {
  withTempDir(dir => {
    claimRunManifest({ claimedDir: dir, runId: 'run-1', project: 'demo-finapp', profile: 'emulator', recipientSha256: RECIPIENT_SHA, sourceHead: 'a'.repeat(40) })
    const afterAdmin = updateRunManifest({
      claimedDir: dir, fromPhase: 'CLAIMED',
      patch: { phase: 'ADMIN_CREATED', admin: { adminUid: 'admin-1', companyId: 'co-1' }, ledger: { runId: 'run-1', createdAuthUids: ['admin-1'], createdFirestorePaths: ['companies/co-1'], casPaths: [], ownerMailboxUidCreated: false } },
    })
    assert.equal(afterAdmin.phase, 'ADMIN_CREATED')
    assert.equal(afterAdmin.admin.adminUid, 'admin-1')
    assert.deepEqual(afterAdmin.ledger.createdAuthUids, ['admin-1'])

    const afterInvite = updateRunManifest({
      claimedDir: dir, fromPhase: 'ADMIN_CREATED',
      patch: { phase: 'INVITED', invite: { inviteId: 'inv-1' }, ledger: { ...afterAdmin.ledger, createdFirestorePaths: [...afterAdmin.ledger.createdFirestorePaths, 'invitations/inv-1'] } },
    })
    assert.equal(afterInvite.phase, 'INVITED')
    assert.equal(afterInvite.invite.inviteId, 'inv-1')
    assert.deepEqual(afterInvite.ledger.createdFirestorePaths, ['companies/co-1', 'invitations/inv-1'])
  })
})

test('updateRunManifest refuses when fromPhase does not match the manifest currently on disk (CAS)', () => {
  withTempDir(dir => {
    claimRunManifest({ claimedDir: dir, runId: 'run-1', project: 'demo-finapp', profile: 'emulator', recipientSha256: RECIPIENT_SHA, sourceHead: 'a'.repeat(40) })
    assert.throws(() => updateRunManifest({
      claimedDir: dir, fromPhase: 'ADMIN_CREATED',
      patch: { phase: 'INVITED', invite: { inviteId: 'inv-1' } },
    }))
  })
})

test('updateRunManifest refuses when no manifest exists yet', () => {
  withTempDir(dir => {
    assert.throws(() => updateRunManifest({ claimedDir: dir, fromPhase: 'CLAIMED', patch: { phase: 'ADMIN_CREATED' } }))
  })
})

test('readRunManifest treats a corrupted manifest as a hard failure, never as absent', () => {
  withTempDir(dir => {
    fs.writeFileSync(runManifestPathFor({ claimedDir: dir }), 'not json', { mode: 0o600 })
    assert.throws(() => readRunManifest({ claimedDir: dir }))
  })
})

test('readRunManifest refuses an ADMIN_CREATED/INVITED manifest missing the fields that phase requires', () => {
  withTempDir(dir => {
    const p = runManifestPathFor({ claimedDir: dir })
    fs.writeFileSync(p, JSON.stringify({
      version: RUN_MANIFEST_VERSION, runId: 'run-1', project: 'demo-finapp', profile: 'emulator', recipientSha256: RECIPIENT_SHA, sourceHead: 'a'.repeat(40),
      phase: 'INVITED', admin: { adminUid: 'admin-1', companyId: 'co-1' }, invite: null,
      ledger: { runId: 'run-1', createdAuthUids: [], createdFirestorePaths: [], casPaths: [], ownerMailboxUidCreated: false },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }), { mode: 0o600 })
    assert.throws(() => readRunManifest({ claimedDir: dir }))
  })
})

test('the manifest file never contains a plaintext recipient email — only its hash', () => {
  withTempDir(dir => {
    claimRunManifest({ claimedDir: dir, runId: 'run-1', project: 'demo-finapp', profile: 'emulator', recipientSha256: RECIPIENT_SHA, sourceHead: 'a'.repeat(40) })
    const raw = fs.readFileSync(runManifestPathFor({ claimedDir: dir }), 'utf8')
    assert.equal(raw.includes('@'), false)
  })
})
