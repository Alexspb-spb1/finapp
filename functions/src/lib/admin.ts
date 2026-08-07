// Single Admin SDK initialization point — SEC-003.
//
// The Admin SDK must be initialized exactly once per process. `getApps()`
// guards against double-initialization (e.g. if this module is imported
// from both src/index.ts and a test file in the same process).
import { initializeApp, getApps, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { getAuth, type Auth } from 'firebase-admin/auth'

const app: App = getApps().length > 0 ? getApps()[0]! : initializeApp()

export const db: Firestore = getFirestore(app)
export const adminAuth: Auth = getAuth(app)
