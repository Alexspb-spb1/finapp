// Shared helpers for emulator integration tests — SEC-003.
//
// Run only via `npm run test:emulator` (`firebase emulators:exec --project
// demo-finapp --only auth,firestore,functions "vitest run test/emulator"`).
// `emulators:exec` sets GCLOUD_PROJECT/FIRESTORE_EMULATOR_HOST/
// FIREBASE_AUTH_EMULATOR_HOST for this process AND for the spawned
// Functions Emulator process automatically — no real Firebase project,
// credentials, or service-account JSON are used or required.
import { initializeApp as initializeClientApp, type FirebaseApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, signInWithCustomToken, signOut, type Auth } from 'firebase/auth'
import { getFunctions, connectFunctionsEmulator, httpsCallable, type Functions } from 'firebase/functions'
import { Timestamp } from 'firebase-admin/firestore'
import { adminAuth, db } from '../../src/lib/admin'
import { computeInvitationLockId } from '../../src/schemas/invitation'

const PROJECT_ID = 'demo-finapp'
const AUTH_EMULATOR_ORIGIN = 'http://127.0.0.1:9099'
const FUNCTIONS_EMULATOR_HOST = '127.0.0.1'
const FUNCTIONS_EMULATOR_PORT = 5001

let clientApp: FirebaseApp | undefined
let clientAuth: Auth | undefined
let clientFunctions: Functions | undefined

function getClientApp(): FirebaseApp {
  if (!clientApp) {
    // apiKey is never validated by the Auth Emulator — any non-empty
    // synthetic string works. No real Firebase project config is used.
    clientApp = initializeClientApp({ projectId: PROJECT_ID, apiKey: 'emulator-only-synthetic-key' })
  }
  return clientApp
}

function getClientAuth(): Auth {
  if (!clientAuth) {
    clientAuth = getAuth(getClientApp())
    connectAuthEmulator(clientAuth, AUTH_EMULATOR_ORIGIN, { disableWarnings: true })
  }
  return clientAuth
}

function getClientFunctions(): Functions {
  if (!clientFunctions) {
    clientFunctions = getFunctions(getClientApp())
    connectFunctionsEmulator(clientFunctions, FUNCTIONS_EMULATOR_HOST, FUNCTIONS_EMULATOR_PORT)
  }
  return clientFunctions
}

let userCounter = 0
function syntheticEmail(label: string): string {
  userCounter += 1
  return `sec003-${label}-${Date.now()}-${userCounter}@example.test`
}

/**
 * Creates a synthetic Auth Emulator user, signs in as them on the shared
 * client auth instance, and returns their uid. Because sign-in state is a
 * SHARED singleton, call this (or signInAsExistingUser/signOutClient)
 * immediately before the callAuthzProbe() call it's meant to authenticate —
 * creating multiple users up front and calling the probe later will use
 * whichever user most recently signed in, not the one you expect.
 */
export async function createTestUser(emailVerified: boolean, label = 'user'): Promise<{ uid: string }> {
  const email = syntheticEmail(label)
  const userRecord = await adminAuth.createUser({ email, emailVerified, password: 'not-used-synthetic-pw-1' })
  const customToken = await adminAuth.createCustomToken(userRecord.uid)
  await signInWithCustomToken(getClientAuth(), customToken)
  return { uid: userRecord.uid }
}

export async function signOutClient(): Promise<void> {
  await signOut(getClientAuth())
}

/** Re-signs-in as an already-created uid on the shared client auth singleton — needed whenever a test needs to switch back to an earlier user (e.g. alternating between two admins of two different companies). Same shared-singleton caveat as createTestUser: call immediately before the callable call meant to use it. */
export async function signInAsExistingUser(uid: string): Promise<void> {
  const customToken = await adminAuth.createCustomToken(uid)
  await signInWithCustomToken(getClientAuth(), customToken)
}

export async function seedCompany(companyId: string, ownerId = 'uid_owner_synthetic'): Promise<void> {
  await db.collection('companies').doc(companyId).set({
    id: companyId,
    name: 'SEC-003 Test Co',
    legalType: 'ooo',
    currency: 'RUB',
    createdAt: new Date().toISOString(),
    ownerId,
  })
}

export interface SeedMembershipInput {
  companyId: string
  uid: string
  role: 'viewer' | 'accountant' | 'admin'
  status: 'invited' | 'active' | 'disabled'
  /** Writes the document under a DIFFERENT id than `uid`, to simulate a document-id/membership.uid mismatch. */
  docIdOverride?: string
}

export async function seedMembership(input: SeedMembershipInput): Promise<void> {
  const now = Timestamp.now()
  const docId = input.docIdOverride ?? input.uid
  await db.collection('companies').doc(input.companyId).collection('members').doc(docId).set({
    uid: input.uid,
    role: input.role,
    status: input.status,
    createdAt: now,
    updatedAt: now,
  })
}

/** Writes an arbitrary (possibly schema-invalid) raw document — for corrupted-document/unknown-role scenarios. */
export async function seedRawMembershipDoc(
  companyId: string,
  docId: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await db.collection('companies').doc(companyId).collection('members').doc(docId).set(raw)
}

/** Calls the deployed `authzProbe` callable through the real Functions Emulator, using whichever user is currently signed in on the client auth instance (or none, for unauthenticated-call tests). */
export async function callAuthzProbe(companyId: string): Promise<unknown> {
  const callable = httpsCallable(getClientFunctions(), 'authzProbe')
  const result = await callable({ companyId })
  return result.data
}

export async function callAuthzProbeRaw(payload: unknown): Promise<unknown> {
  const callable = httpsCallable(getClientFunctions(), 'authzProbe')
  const result = await callable(payload)
  return result.data
}

/** Calls the real `createCompany` callable through the Functions Emulator, using whichever user is currently signed in on the client auth instance. */
export async function callCreateCompany(payload: unknown): Promise<unknown> {
  const callable = httpsCallable(getClientFunctions(), 'createCompany')
  const result = await callable(payload)
  return result.data
}

/** Reads companies/{companyId}/members/{uid} directly via the Admin SDK, for assertions in createCompany tests. */
export async function getMembershipDoc(companyId: string, uid: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection('companies').doc(companyId).collection('members').doc(uid).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

/** Reads companies/{companyId} directly via the Admin SDK. */
export async function getCompanyDoc(companyId: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection('companies').doc(companyId).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

/** Reads company_data/{companyId} directly via the Admin SDK. */
export async function getCompanyDataDoc(companyId: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection('company_data').doc(companyId).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

/** Reads users/{uid} directly via the Admin SDK. */
export async function getUserDoc(uid: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection('users').doc(uid).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

/** Counts companies owned by a given uid — used to assert "exactly one company" across retries/concurrency. */
export async function countCompaniesOwnedBy(uid: string): Promise<number> {
  const snap = await db.collection('companies').where('ownerId', '==', uid).get()
  return snap.size
}

/** Writes an arbitrary raw users/{uid} document directly via the Admin SDK — for the "existing legacy profile without a bootstrap receipt" scenario. */
export async function seedRawUserDoc(uid: string, raw: Record<string, unknown>): Promise<void> {
  await db.collection('users').doc(uid).set(raw)
}

/** Reads the SEC-004 bootstrap receipt (user_bootstrap/{uid}) directly via the Admin SDK. */
export async function getBootstrapReceipt(uid: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection('user_bootstrap').doc(uid).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

/** Counts companies/{companyId}/audit_events documents — used to assert exactly-once audit writes across retries. */
export async function countAuditEvents(companyId: string): Promise<number> {
  const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
  return snap.size
}

/** Reads all companies/{companyId}/audit_events documents directly via the Admin SDK — used to assert the exact field set/content of an audit event (e.g. no email/role/token/tokenHash ever reaches it). */
export async function getAuditEvents(companyId: string): Promise<Record<string, unknown>[]> {
  const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
  return snap.docs.map(doc => doc.data() as Record<string, unknown>)
}

/** Sets (or clears) system/maintenance directly via the Admin SDK — SEC-005
 * production preflight. Firestore Rules never apply to this write since it
 * goes through the Admin SDK, matching how an operator following the
 * SEC-005 runbook would actually set it. */
export async function setMaintenanceMode(enabled: boolean, extra: Record<string, unknown> = {}): Promise<void> {
  await db.collection('system').doc('maintenance').set({ enabled, taskId: 'SEC-005', ...extra })
}

/** Removes system/maintenance entirely — restores the default (pre-runbook) state. */
export async function clearMaintenanceMode(): Promise<void> {
  await db.collection('system').doc('maintenance').delete()
}

// ── SEC-006 Stage 2 (inviteMember) ───────────────────────────────────────

/** Calls the real `inviteMember` callable through the Functions Emulator, using whichever user is currently signed in on the client auth instance. */
export async function callInviteMember(payload: unknown): Promise<unknown> {
  const callable = httpsCallable(getClientFunctions(), 'inviteMember')
  const result = await callable(payload)
  return result.data
}

/** Reads invitations/{inviteId} directly via the Admin SDK. */
export async function getInvitationDoc(inviteId: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection('invitations').doc(inviteId).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

/** Writes an arbitrary (possibly schema-invalid) raw invitations/{inviteId} document — for corrupted/pre-existing-state scenarios. */
export async function seedInvitationDoc(inviteId: string, raw: Record<string, unknown>): Promise<void> {
  await db.collection('invitations').doc(inviteId).set(raw)
}

/** Reads invitationLocks/{lockId} directly via the Admin SDK, deriving lockId the same way the callable does. */
export async function getInvitationLockDoc(companyId: string, emailNormalized: string): Promise<Record<string, unknown> | undefined> {
  const lockId = computeInvitationLockId(companyId, emailNormalized)
  const snap = await db.collection('invitationLocks').doc(lockId).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

/** Writes an arbitrary (possibly schema-invalid) raw invitationLocks/{lockId} document directly, deriving lockId the same way the callable does. */
export async function seedInvitationLockDoc(
  companyId: string,
  emailNormalized: string,
  raw: Record<string, unknown>,
): Promise<void> {
  const lockId = computeInvitationLockId(companyId, emailNormalized)
  await db.collection('invitationLocks').doc(lockId).set(raw)
}

/** Counts invitations/{inviteId} documents for a given (companyId, emailNormalized) pair — used to assert "exactly one invitation" across concurrency/retries, and to catch orphans. */
export async function countInvitationsFor(companyId: string, emailNormalized: string): Promise<number> {
  const snap = await db.collection('invitations')
    .where('companyId', '==', companyId)
    .where('emailNormalized', '==', emailNormalized)
    .get()
  return snap.size
}

/** Counts invitationLocks documents in total — used to assert no orphan/duplicate locks were created. */
export async function countAllInvitationLocks(): Promise<number> {
  const snap = await db.collection('invitationLocks').get()
  return snap.size
}

/** True if a Firebase Auth user already exists for this email — used to assert inviteMember never creates one. */
export async function authUserExistsWithEmail(email: string): Promise<boolean> {
  try {
    await adminAuth.getUserByEmail(email)
    return true
  } catch {
    return false
  }
}

// ── SEC-006 Stage 2b (listInvitations) ───────────────────────────────────

/** Calls the real `listInvitations` callable through the Functions Emulator, using whichever user is currently signed in on the client auth instance. */
export async function callListInvitations(payload: unknown): Promise<unknown> {
  const callable = httpsCallable(getClientFunctions(), 'listInvitations')
  const result = await callable(payload)
  return result.data
}

/** All invitations/{inviteId} documents for a given companyId, directly via the Admin SDK, sorted by document id for a stable diff — used for "before vs. after" no-write-side-effects assertions around listInvitations. */
export async function getInvitationsSnapshotForCompany(companyId: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const snap = await db.collection('invitations').where('companyId', '==', companyId).get()
  return snap.docs
    .map(doc => ({ id: doc.id, data: doc.data() as Record<string, unknown> }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** All companies/{companyId}/members documents, directly via the Admin SDK, sorted by document id — same "before vs. after" purpose as getInvitationsSnapshotForCompany. */
export async function getMembershipsSnapshot(companyId: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const snap = await db.collection('companies').doc(companyId).collection('members').get()
  return snap.docs
    .map(doc => ({ id: doc.id, data: doc.data() as Record<string, unknown> }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
