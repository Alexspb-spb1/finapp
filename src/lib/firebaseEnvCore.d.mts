// Типы для firebaseEnvCore.mjs (сам файл — обычный JavaScript, см. комментарий
// в начале firebaseEnvCore.mjs почему). Соглашение TypeScript: .mjs модуль
// типизируется соседним .d.mts файлом с тем же базовым именем.

export declare const STAGING_PROJECT_ID: string
export declare const EMULATOR_PROJECT_ID: string
export declare const REQUIRED_KEYS: readonly [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
]
export declare const FINGERPRINT_FIELDS: readonly [
  'apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId',
]

export interface FirebaseWebConfig {
  apiKey: string
  authDomain: string
  projectId: string
  storageBucket: string
  messagingSenderId: string
  appId: string
}

export interface ResolvedFirebaseEnv {
  config: FirebaseWebConfig
  appEnv: string | undefined
  useEmulators: boolean
  authEmulatorHost: string
  firestoreEmulatorHost: string
  firestoreEmulatorPort: number
}

export type EnvSource = Record<string, string | boolean | undefined>

/**
 * Разрешает и проверяет Firebase-окружение. Проверяет только структуру
 * (обязательные поля присутствуют) и projectId — НЕ проверяет apiKey/
 * authDomain/... на принадлежность конкретному утверждённому staging-проекту.
 * Для этого используйте scripts/lib/stagingPreflight.mjs (fingerprint-проверка).
 */
export declare function resolveFirebaseEnv(source: EnvSource): ResolvedFirebaseEnv
