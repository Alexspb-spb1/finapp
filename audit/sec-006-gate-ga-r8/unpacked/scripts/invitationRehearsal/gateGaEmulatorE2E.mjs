// Driver for a real end-to-end gate-G-A run against the local Functions +
// Firestore + Auth emulators. Never touches staging/production. Prints one
// JSON summary line per run for the R3 evidence bundle.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { runGateGaOrchestrator, makeJournal } from './gateGaOrchestratorCore.mjs'
import { createGateGaEmulatorAdapters } from './gateGaEmulatorAdapters.mjs'
import { LEGACY_KNOWN } from './stage8LegacyResidualCore.mjs'

export async function seedLegacyFixture(db, auth, { match = true } = {}) {
  const ownerAUid = LEGACY_KNOWN.ownerAUid
  // Idempotent re-seed: this fixed uid may be leftover from a prior local
  // iteration of this same suite against the same emulator instance.
  try { await auth.deleteUser(ownerAUid) } catch {}
  const staleCompanies = await db.collection('companies').where('ownerUid', '==', ownerAUid).get()
  for (const doc of staleCompanies.docs) { await db.recursiveDelete(doc.ref); await db.doc(`company_data/${doc.id}`).delete().catch(() => {}) }
  await db.doc(`user_bootstrap/${ownerAUid}`).delete().catch(() => {})
  await auth.createUser({ uid: ownerAUid, email: 'legacy-owner-a@example.invalid', password: 'Legacy-Owner-Pw-1!', emailVerified: true })
  await db.doc(`user_bootstrap/${ownerAUid}`).set({ ownerUid: ownerAUid })
  const companyRef = db.collection('companies').doc()
  await companyRef.set({
    name: match ? LEGACY_KNOWN.companyName : 'Not The Legacy Company',
    ownerUid: ownerAUid, ownerName: LEGACY_KNOWN.ownerName, legalType: LEGACY_KNOWN.legalType,
    idempotencyKeySha256: sha256(LEGACY_KNOWN.idempotencyKey),
  })
  await companyRef.collection('members').doc(ownerAUid).set({ uid: ownerAUid, role: 'admin' })
  await companyRef.collection('audit_events').doc().set({ action: 'company_created' })
  if (match) await db.doc(`company_data/${companyRef.id}`).set({ accounts: [] })
  if (!match) await companyRef.collection('mystery_collection').doc().set({ unexpected: true })
  return { ownerAUid, companyId: companyRef.id }
}

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('E2E_SKIPPED reason=emulator_host_env_not_set')
  process.exit(2)
}

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const sha256 = v => createHash('sha256').update(v).digest('hex')

async function seamHashes() {
  const files = [
    'liveAcceptanceRunIdCore.mjs', 'liveAcceptanceCleanupCore.mjs', 'stage8LegacyResidualCore.mjs',
    'gateGaRecipientCore.mjs', 'gateGaOrchestratorCore.mjs',
    // R6/R7: these are just as security-critical as the modules above (the
    // durable email-password checkpoint, the durable run manifest that
    // resume relies on, and the private-directory ACL lockdown guarding
    // both of them) — tampering with any of them must be caught the same way.
    'gateGaEmailVerificationCore.mjs', 'gateGaRunManifestCore.mjs', 'gateGaPrivateDirAclCore.mjs',
    // R8: the crash-safe event journal and the invitation-lock-id
    // computation are new seams the resume/reconciliation flow depends on
    // just as directly — tampering with either must be caught too.
    'gateGaDurableJournalCore.mjs', 'gateGaInvitationLockCore.mjs',
  ]
  const expected = {}
  for (const f of files) expected[f] = sha256(fs.readFileSync(path.join(HERE, f)))
  return expected
}

export async function runOnce({
  faults = {}, ownerConfirmed = true, existingRecipientSeed = false,
  seedLegacy = null, legacyCleanupApproved = false, appTag = null,
  // R6: overridable for the real two-process resume proof
  // (gateGaResumeKillTest.mjs) — a second, genuinely separate process must
  // be able to point at the SAME claimedDir/recipient/runTag as the first.
  claimedDir: providedClaimedDir = null, recipient: providedRecipient = null,
  runTag: providedRunTag = null, resume = false, onOwnerActionRequired = () => {}, onInternalCheckpoint = () => {},
  // R7: overridable so a crash-window test's process-1 (runOnce) and
  // process-2 (the literal CLI) agree on the exact same sourceHead, and so
  // process-1 can durably journal to the SAME file the resumed literal CLI
  // invocation will continue (the "existing state/journal pair" resume
  // itself requires) — both default to the historical fixed values so every
  // other existing caller of runOnce() is unaffected.
  sourceHead: providedSourceHead = null, journal: providedJournal = null,
} = {}) {
  const runTag = providedRunTag ?? `gaE2E${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const app = initializeApp({ projectId: 'demo-finapp' }, appTag ?? `gate-ga-e2e-${runTag}`)
  const db = getFirestore(app)
  const auth = getAuth(app)
  const recipient = providedRecipient ?? `gate-ga-e2e-${runTag}@example.invalid`

  if (existingRecipientSeed) await auth.createUser({ email: recipient, password: 'Preexisting-Pw-1!' })
  let legacyFixture = null
  if (seedLegacy) legacyFixture = await seedLegacyFixture(db, auth, { match: seedLegacy === 'match' })

  const adapters = createGateGaEmulatorAdapters({
    functionsBaseUrl: 'http://127.0.0.1:5001/demo-finapp/us-central1',
    authEmulatorHost: '127.0.0.1:9099', db, auth, runTag,
  })
  const claimedDir = providedClaimedDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-e2e-claims-'))
  const expected = await seamHashes()
  const readFile = async name => fs.readFileSync(path.join(HERE, name))

  let result
  try {
    result = await runGateGaOrchestrator({
      profile: 'emulator', project: 'demo-finapp', seamExpectedHashes: expected, readFile,
      recipient, ownerConfirmedRecipientSha256: ownerConfirmed ? sha256(recipient.trim().toLowerCase()) : 'wrong-hash-0000000000000000000000000000000000000000000000000000000000',
      adapters, faults, claimedDir, sourceHead: providedSourceHead ?? 'c84f7837bdbc0a27fea698080c779d273e8e15bb',
      journal: providedJournal ?? (faults.corruptedJournal ? corruptableJournal() : makeJournal()),
      resume, legacyCleanupApproved, onOwnerActionRequired, onInternalCheckpoint,
    })
  } finally {
    if (!providedClaimedDir) fs.rmSync(claimedDir, { recursive: true, force: true })
  }

  // Independent re-read, bypassing the module under test, for both targets.
  const independentRemainder = []
  if (result.cleanup?.deleted) {
    for (const p of result.cleanup.deleted.firestorePaths ?? []) if ((await db.doc(p).get()).exists) independentRemainder.push({ scope: 'current', kind: 'firestore', path: p })
    for (const uid of result.cleanup.deleted.authUids ?? []) { try { await auth.getUser(uid); independentRemainder.push({ scope: 'current', kind: 'auth', uid }) } catch {} }
  }
  if (legacyFixture) {
    if (result.legacyCleanup?.status === 'CLEANUP_COMPLETE_VERIFIED') {
      const companyDoc = await db.doc(`companies/${legacyFixture.companyId}`).get()
      if (companyDoc.exists) independentRemainder.push({ scope: 'legacy', kind: 'firestore', path: companyDoc.ref.path })
      try { await auth.getUser(legacyFixture.ownerAUid); independentRemainder.push({ scope: 'legacy', kind: 'auth' }) } catch {}
    } else {
      // Legacy fixture must have been left completely untouched when not cleaned.
      const companyDoc = await db.doc(`companies/${legacyFixture.companyId}`).get()
      if (!companyDoc.exists) independentRemainder.push({ scope: 'legacy-preserved-check', kind: 'unexpectedly-deleted' })
    }
  }
  await deleteApp(app)
  return { runTag, result, independentRemainder, legacyFixture }
}

function corruptableJournal() {
  const j = makeJournal()
  const originalAppend = j.append.bind(j)
  j.append = (status, details) => originalAppend(status, { ...details, corruptedMarker: true })
  return j
}

if (process.argv[2] === '--run') {
  runOnce().then(({ runTag, result, independentRemainder }) => {
    console.log('E2E_RESULT', JSON.stringify({
      runTag, status: result.status, flowStatus: result.flowOutcome.status,
      cleanupStatus: result.cleanup.status, legacyCleanupStatus: result.legacyCleanup.status,
      emailsSent: result.emailsSent, independentRemainderCount: independentRemainder.length,
    }))
    if (result.status !== 'PASS' || independentRemainder.length > 0) { console.error('E2E_POSITIVE_CASE_FAILED', JSON.stringify({ result, independentRemainder })); process.exitCode = 1 }
    else console.log('GATE_GA_E2E PASS')
  }).catch(error => { console.error('E2E_ERROR', error); process.exitCode = 1 })
}
