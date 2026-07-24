// Валидация и разрешение Firebase-окружения (BASE-002).
//
// Обычный JavaScript-модуль (не TypeScript) — намеренно. Этот файл
// импортируется и клиентским кодом (через src/lib/firebaseEnv.ts, который
// добавляет только типы — см. соседний firebaseEnvCore.d.mts), и Node-скриптами
// в scripts/ (scripts/lib/stagingPreflight.mjs), которые обязаны запускаться
// на Node 20 (текущий CI, см. .github/workflows/deploy.yml) без
// `--experimental-strip-types` (доступен только с Node 22.6+). Единый JS-файл
// без TS-синтаксиса исключает рассинхронизацию правил между рантаймом
// приложения и preflight-проверкой сборки.
//
// Намеренно НЕ логирует и не возвращает значения в текстах ошибок — только
// названия отсутствующих/некорректных переменных.

// ВАЖНО: production project ID намеренно НЕ хранится здесь как строковый
// литерал. Этот модуль в итоге попадает в клиентский бандл (через
// src/lib/firebaseEnv.ts → src/lib/firebase.ts) — любая строка-константа
// отсюда физически присутствует в dist/*.js и находится обычным grep'ом.
// Специфическая проверка "это именно production ID" с явным упоминанием
// его по имени живёт только в scripts/lib/stagingPreflight.mjs (Node-only,
// никогда не бандлится и не попадает в dist/). Здесь достаточно strict
// allowlist ниже: он отклоняет production ID так же надёжно (тот просто не
// равен STAGING_PROJECT_ID), не называя его по значению.
export const STAGING_PROJECT_ID = 'finapp-staging'
export const EMULATOR_PROJECT_ID = 'demo-finapp'

const DEFAULT_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
const DEFAULT_FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'

export const REQUIRED_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
]

/** Порядок полей конфигурации, используемый везде, где нужен детерминированный
 *  нормализованный вид (сейчас — только для SHA-256 fingerprint в
 *  scripts/lib/firebaseConfigFingerprint.mjs). Здесь, а не там, чтобы порядок
 *  полей был определён ровно один раз. */
export const FINGERPRINT_FIELDS = [
  'apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId',
]

function str(v) {
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
 *
 * ВНИМАНИЕ: успешное разрешение здесь НЕ означает подтверждённую изоляцию
 * Firebase Authentication — эта функция проверяет только projectId. apiKey
 * (используемый Authentication API) может принадлежать любому проекту,
 * включая production, и пройдёт эту проверку. Полную проверку целостности
 * всей конфигурации (apiKey/authDomain/storageBucket/messagingSenderId/appId
 * вместе) выполняет отдельно scripts/lib/stagingPreflight.mjs через
 * SHA-256 fingerprint — см. docs/remediation/reports/BASE-002.md, раздел
 * "Auth vs Firestore изоляция".
 */
export function resolveFirebaseEnv(source) {
  const missing = REQUIRED_KEYS.filter(key => !str(source[key]))
  if (missing.length > 0) {
    throw new Error(
      `Firebase config: отсутствуют обязательные переменные окружения: ${missing.join(', ')}`
    )
  }

  const config = {
    apiKey: str(source.VITE_FIREBASE_API_KEY),
    authDomain: str(source.VITE_FIREBASE_AUTH_DOMAIN),
    projectId: str(source.VITE_FIREBASE_PROJECT_ID),
    storageBucket: str(source.VITE_FIREBASE_STORAGE_BUCKET),
    messagingSenderId: str(source.VITE_FIREBASE_MESSAGING_SENDER_ID),
    appId: str(source.VITE_FIREBASE_APP_ID),
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
    authEmulatorHost: str(source.VITE_FIREBASE_AUTH_EMULATOR_HOST) ?? DEFAULT_AUTH_EMULATOR_HOST,
    ...splitFirestoreEmulatorHost(str(source.VITE_FIREBASE_FIRESTORE_EMULATOR_HOST) ?? DEFAULT_FIRESTORE_EMULATOR_HOST),
  }
}

function splitFirestoreEmulatorHost(hostPort) {
  const [host, portStr] = hostPort.split(':')
  const port = Number(portStr)
  if (!host || !Number.isFinite(port)) {
    throw new Error('Firebase config: VITE_FIREBASE_FIRESTORE_EMULATOR_HOST должен быть в формате host:port')
  }
  return { firestoreEmulatorHost: host, firestoreEmulatorPort: port }
}
