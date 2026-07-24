// Тонкая типизированная обёртка над firebaseEnvCore.mjs (BASE-002).
//
// Сама логика — в src/lib/firebaseEnvCore.mjs, обычном JavaScript-файле без
// TypeScript-синтаксиса. Причина: этот же модуль напрямую импортируют
// Node-скрипты в scripts/ (build:staging preflight), которые обязаны
// работать на Node 20 (текущий CI) без экспериментального TS-loader'а
// Node 22.6+. Здесь модуль только переэкспортируется с типами (см.
// соседний firebaseEnvCore.d.mts) — единственный источник правды для
// рантайма приложения и preflight-скрипта остаётся один.
export {
  resolveFirebaseEnv,
  STAGING_PROJECT_ID,
  EMULATOR_PROJECT_ID,
} from './firebaseEnvCore.mjs'
export type {
  FirebaseWebConfig,
  ResolvedFirebaseEnv,
  EnvSource,
} from './firebaseEnvCore.mjs'
