import { initializeApp } from 'firebase/app'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { initializeFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { resolveFirebaseEnv } from './firebaseEnv'

// Бросает понятную ошибку (без значений переменных) при отсутствующей
// обязательной конфигурации или недопустимой комбинации
// VITE_APP_ENV / VITE_USE_FIREBASE_EMULATORS / VITE_FIREBASE_PROJECT_ID.
// См. src/lib/firebaseEnv.ts.
const resolved = resolveFirebaseEnv(import.meta.env)

const app = initializeApp(resolved.config)
export const auth = getAuth(app)
// ignoreUndefinedProperties: операции содержат необязательные поля (relatedDate,
// toAmount, exchangeRate) со значением undefined. Без этого флага setDoc отклоняет
// запись целиком, и синхронизация с облаком молча падает (БАГ №7 — целостность).
export const db   = initializeFirestore(app, { ignoreUndefinedProperties: true })

// Подключение к Emulator Suite — только при VITE_USE_FIREBASE_EMULATORS=true,
// и только один раз. Флаг живёт на globalThis (а не в модульной переменной),
// потому что Vite HMR может заново выполнить тело этого модуля при его
// изменении в dev-режиме, а connectAuthEmulator/connectFirestoreEmulator
// нельзя безопасно вызывать повторно на уже использованных auth/db.
declare global {
  var __FINAPP_EMULATORS_CONNECTED__: boolean | undefined
}

if (resolved.useEmulators && !globalThis.__FINAPP_EMULATORS_CONNECTED__) {
  globalThis.__FINAPP_EMULATORS_CONNECTED__ = true
  connectAuthEmulator(auth, `http://${resolved.authEmulatorHost}`, { disableWarnings: true })
  connectFirestoreEmulator(db, resolved.firestoreEmulatorHost, resolved.firestoreEmulatorPort)
}
