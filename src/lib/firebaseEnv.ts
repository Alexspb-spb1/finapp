// Валидация и разрешение Firebase-окружения (BASE-002).
//
// Вынесено из firebase.ts в чистую функцию без побочных эффектов и без
// прямого чтения import.meta.env, чтобы её можно было проверить независимо
// (см. scripts/verify-staging-env.mjs и ручные негативные проверки в
// docs/remediation/reports/BASE-002.md), не запуская реальный Vite-рантайм.
//
// Намеренно НЕ логирует и не возвращает значения в текстах ошибок — только
// названия отсутствующих/некорректных переменных.

// ВАЖНО: production project ID намеренно НЕ хранится здесь как строковый
// литерал. Этот модуль импортируется из src/lib/firebase.ts и попадает в
// клиентский бандл — любая строка-константа отсюда физически присутствует
// в dist/*.js и находится обычным grep'ом. Специфическая проверка "это
// именно production ID" с отдельным текстом ошибки живёт только в
// scripts/verify-staging-env.mjs (Node-скрипт, никогда не бандлится и не
// попадает в dist/). Здесь достаточно strict allowlist ниже: он отклоняет
// production ID так же надёжно (он просто не равен STAGING_PROJECT_ID),
// не называя его по значению.
export const STAGING_PROJECT_ID  = 'finapp-staging'
export const EMULATOR_PROJECT_ID = 'demo-finapp'

const DEFAULT_AUTH_EMULATOR_HOST      = '127.0.0.1:9099'
const DEFAULT_FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'

const REQUIRED_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const

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

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Разбирает и проверяет Firebase-окружение из произвольного источника
 * ключ→значение (import.meta.env в рантайме, либо синтетический объект
 * в проверочном скрипте/негативном тесте).
 *
 * Бросает Error с понятным сообщением (без значений) при:
 * - отсутствии любой обязательной VITE_FIREBASE_* переменной;
 * - несовместимой комбинации VITE_APP_ENV / VITE_USE_FIREBASE_EMULATORS / projectId.
 */
export function resolveFirebaseEnv(source: EnvSource): ResolvedFirebaseEnv {
  const missing = REQUIRED_KEYS.filter(key => !str(source[key]))
  if (missing.length > 0) {
    throw new Error(
      `Firebase config: отсутствуют обязательные переменные окружения: ${missing.join(', ')}`
    )
  }

  const config: FirebaseWebConfig = {
    apiKey:            str(source.VITE_FIREBASE_API_KEY)!,
    authDomain:        str(source.VITE_FIREBASE_AUTH_DOMAIN)!,
    projectId:         str(source.VITE_FIREBASE_PROJECT_ID)!,
    storageBucket:     str(source.VITE_FIREBASE_STORAGE_BUCKET)!,
    messagingSenderId: str(source.VITE_FIREBASE_MESSAGING_SENDER_ID)!,
    appId:             str(source.VITE_FIREBASE_APP_ID)!,
  }

  const appEnv = str(source.VITE_APP_ENV)
  // Точное сравнение со строкой 'true' — по требованию задачи, чтобы
  // случайное VITE_USE_FIREBASE_EMULATORS=1/yes/TRUE не включало эмуляторы молча.
  const useEmulators = str(source.VITE_USE_FIREBASE_EMULATORS) === 'true'

  if (useEmulators) {
    if (config.projectId !== EMULATOR_PROJECT_ID) {
      throw new Error(
        `Firebase config: при VITE_USE_FIREBASE_EMULATORS=true допускается только projectId="${EMULATOR_PROJECT_ID}" — обнаружен другой projectId`
      )
    }
  } else {
    // Defensive/симметрично: "demo-finapp" вне режима эмуляторов не должен
    // случайно указывать на реальный Firebase-проект с таким именем.
    if (config.projectId === EMULATOR_PROJECT_ID) {
      throw new Error(
        `Firebase config: projectId="${EMULATOR_PROJECT_ID}" зарезервирован только для режима VITE_USE_FIREBASE_EMULATORS=true`
      )
    }
    if (appEnv === 'staging' && config.projectId !== STAGING_PROJECT_ID) {
      // Строгий allowlist: отклоняет production ID и любой другой не-staging
      // projectId одинаково надёжно, не называя запрещённые значения по имени
      // (см. комментарий у STAGING_PROJECT_ID выше — почему).
      throw new Error(
        `Firebase config: staging-окружение (VITE_APP_ENV=staging) допускает только projectId="${STAGING_PROJECT_ID}" — обнаружен другой projectId`
      )
    }
  }

  return {
    config,
    appEnv,
    useEmulators,
    authEmulatorHost:      str(source.VITE_FIREBASE_AUTH_EMULATOR_HOST)      ?? DEFAULT_AUTH_EMULATOR_HOST,
    ...splitFirestoreEmulatorHost(str(source.VITE_FIREBASE_FIRESTORE_EMULATOR_HOST) ?? DEFAULT_FIRESTORE_EMULATOR_HOST),
  }
}

function splitFirestoreEmulatorHost(hostPort: string): { firestoreEmulatorHost: string; firestoreEmulatorPort: number } {
  const [host, portStr] = hostPort.split(':')
  const port = Number(portStr)
  if (!host || !Number.isFinite(port)) {
    throw new Error('Firebase config: VITE_FIREBASE_FIRESTORE_EMULATOR_HOST должен быть в формате host:port')
  }
  return { firestoreEmulatorHost: host, firestoreEmulatorPort: port }
}
