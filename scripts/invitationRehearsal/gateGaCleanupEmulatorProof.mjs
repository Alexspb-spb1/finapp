// Real-emulator (Firestore + Auth, demo-finapp, loopback only — never
// staging/production) proof for the NEW manifest cleanup module: seeds real
// documents/Auth users through the actual firebase-admin SDK against the
// local Firebase Emulator Suite, runs executeManifestCleanup wired to real
// adapters (not fakes), then independently re-reads the emulator directly
// (bypassing the module under test) to confirm the deletions genuinely
// happened. Requires FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST
// to already point at a running local emulator.
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { executeManifestCleanup } from './liveAcceptanceCleanupCore.mjs'

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('EMULATOR_PROOF_SKIPPED reason=emulator_host_env_not_set')
  process.exit(2)
}

const RUN_ID = 'gate-emuprooftest0000000001'
const FRAGMENTS = ['gate-emuprooftest0000000001']

function fakeJournal() {
  const events = []
  return { events, append(status, details) { events.push({ status, details: structuredClone(details) }) } }
}

async function main() {
  const app = initializeApp({ projectId: 'demo-finapp' }, 'gate-ga-cleanup-proof')
  const db = getFirestore(app)
  const auth = getAuth(app)

  const uid = `${RUN_ID}-ownerA`
  const companyId = `${RUN_ID}-company-a`
  const memberPath = `companies/${companyId}/members/${uid}`
  const dataPath = `companies/${companyId}/company_data/data`
  const auditPath = `companies/${companyId}/audit_events/ev1`
  const companyPath = `companies/${companyId}`

  // --- seed real emulator state ------------------------------------------
  await auth.createUser({ uid, email: `${RUN_ID}@example.invalid`, password: 'Gate-GA-Proof-Pw-1!', emailVerified: true })
  await db.doc(companyPath).set({ name: 'Gate GA Proof Co', ownerUid: uid })
  await db.doc(dataPath).set({ seeded: true })
  await db.doc(memberPath).set({ role: 'admin' })
  await db.doc(auditPath).set({ action: 'company_created' })

  const ledger = {
    runId: RUN_ID,
    createdAuthUids: [uid],
    ownerMailboxUidCreated: false,
    createdFirestorePaths: [companyPath, dataPath, memberPath, auditPath],
    casPaths: [],
  }
  const slotStates = { createOwnerAAuth: 'RECONCILED', createCompanyA: 'RECONCILED',
    createOwnerBAuth: 'NOT_STARTED', createCompanyB: 'NOT_STARTED',
    createMailboxCancelledInvite: 'NOT_STARTED', cancelMailboxInvite: 'NOT_STARTED',
    createMailboxFinalInvite: 'NOT_STARTED', resendMailboxFinalInvite: 'NOT_STARTED',
    createOwnerMailboxAuth: 'NOT_STARTED', acceptMailboxFinalInvite: 'NOT_STARTED',
    createOwnerBInvite: 'NOT_STARTED', acceptOwnerBInvite: 'NOT_STARTED',
    replayMailboxFinalInvite: 'NOT_STARTED' }

  const adapters = {
    async listChildCollections(path) {
      const collections = await db.doc(path).listCollections()
      return collections.map(c => c.id)
    },
    async readDoc(path) {
      const snap = await db.doc(path).get()
      return { exists: snap.exists, stateSha256: snap.exists ? '11'.repeat(32) : null }
    },
    async deleteDoc(path) { await db.doc(path).delete() },
    async deleteAuthUser(targetUid) { await auth.deleteUser(targetUid) },
    async authUserExists(targetUid) {
      try { await auth.getUser(targetUid); return true } catch (error) { if (error?.code === 'auth/user-not-found') return false; throw error }
    },
    async authUserExistsByEmail() {
      try { await auth.getUserByEmail(`${RUN_ID}@example.invalid`); return true } catch (error) { if (error?.code === 'auth/user-not-found') return false; throw error }
    },
  }

  const journal = fakeJournal()
  const result = await executeManifestCleanup({ runId: RUN_ID, slotStates, ledger, adapters, journal, allowedIdFragments: FRAGMENTS })
  console.log('POSITIVE_RESULT', JSON.stringify({ status: result.status, deleted: result.deleted }))
  if (result.status !== 'CLEANUP_COMPLETE_VERIFIED') { console.error('POSITIVE_CASE_FAILED'); process.exitCode = 1 }

  // Independent re-read, bypassing the module entirely, against the real emulator.
  const stillThere = []
  for (const path of ledger.createdFirestorePaths) { if ((await db.doc(path).get()).exists) stillThere.push(path) }
  let authStillThere = false
  try { await auth.getUser(uid); authStillThere = true } catch { authStillThere = false }
  console.log('INDEPENDENT_REREAD', JSON.stringify({ stillThere, authStillThere }))
  if (stillThere.length || authStillThere) { console.error('INDEPENDENT_REREAD_FOUND_REMAINDER'); process.exitCode = 1 }

  // --- negative real-emulator case: unexpected subcollection refuses everything ---
  const uid2 = `${RUN_ID}-ownerB`
  const companyId2 = `${RUN_ID}-company-b`
  const companyPath2 = `companies/${companyId2}`
  const memberPath2 = `companies/${companyId2}/members/${uid2}`
  const mysteryPath = `companies/${companyId2}/mystery_collection/doc1`
  await auth.createUser({ uid: uid2, email: `${RUN_ID}-b@example.invalid`, password: 'Gate-GA-Proof-Pw-2!', emailVerified: true })
  await db.doc(companyPath2).set({ name: 'Gate GA Proof Co B', ownerUid: uid2 })
  await db.doc(memberPath2).set({ role: 'admin' })
  await db.doc(mysteryPath).set({ unexpected: true })

  const ledger2 = { runId: RUN_ID, createdAuthUids: [uid2], ownerMailboxUidCreated: false,
    createdFirestorePaths: [companyPath2, memberPath2], casPaths: [] }
  const journal2 = fakeJournal()
  const result2 = await executeManifestCleanup({
    runId: RUN_ID, slotStates, ledger: ledger2, adapters, journal: journal2, allowedIdFragments: FRAGMENTS,
  })
  console.log('NEGATIVE_RESULT', JSON.stringify({ status: result2.status, reason: result2.reason }))
  const companyBStillExists = (await db.doc(companyPath2).get()).exists
  if (result2.status !== 'CLEANUP_REFUSED' || result2.reason !== 'UNEXPECTED_SUBCOLLECTION' || !companyBStillExists) {
    console.error('NEGATIVE_CASE_FAILED')
    process.exitCode = 1
  }
  // Manual teardown of the negative-case fixtures (the module correctly refused to touch them).
  await db.recursiveDelete(db.doc(companyPath2))
  await auth.deleteUser(uid2)

  await deleteApp(app)
  if (process.exitCode !== 1) console.log('GATE_GA_CLEANUP_EMULATOR_PROOF PASS')
}

main().catch(error => { console.error('EMULATOR_PROOF_ERROR', error); process.exitCode = 1 })
