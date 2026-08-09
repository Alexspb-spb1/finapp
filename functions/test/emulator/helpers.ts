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
