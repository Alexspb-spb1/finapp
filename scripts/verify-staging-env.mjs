#!/usr/bin/env node
// BASE-002: preflight-guard для `npm run build:staging`.
//
// Читает .env / .env.staging / .env.staging.local (в порядке возрастания
// приоритета — так же, как это делает Vite для `--mode staging`), затем
// process.env поверх файлов (чтобы можно было изолированно проверять
// негативные сценарии через `VAR=value npm run build:staging`, не трогая
// сами файлы).
//
// Переиспользует resolveFirebaseEnv из src/lib/firebaseEnv.ts — тот же
// код, что реально работает в приложении, а не отдельно продублированная
// копия правил.
//
// Никогда не печатает значения переменных — только их имена и причины отказа.
// При любой ошибке завершается ненулевым кодом ДО запуска tsc/vite build.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {}
  const raw = readFileSync(filePath, 'utf-8')
  const result = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

// Приоритет как у Vite для --mode staging: .env < .env.staging < .env.staging.local
const merged = {
  ...parseEnvFile(path.join(repoRoot, '.env')),
  ...parseEnvFile(path.join(repoRoot, '.env.staging')),
  ...parseEnvFile(path.join(repoRoot, '.env.staging.local')),
}

// process.env поверх файлов — только для явно переданных VITE_*/… значений,
// чтобы можно было точечно переопределить одну переменную при негативном тесте
// (`VITE_FIREBASE_PROJECT_ID=finapp-prod-10a83 npm run build:staging`),
// не трогая сами .env-файлы.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('VITE_') && value !== undefined) {
    merged[key] = value
  }
}

function fail(reason) {
  console.error('✖ build:staging preflight FAILED')
  console.error(`  ${reason}`)
  console.error('  (значения переменных в этом сообщении не выводятся — см. .env.staging.local вручную)')
  process.exit(1)
}

if (merged.VITE_APP_ENV !== 'staging') {
  fail(`VITE_APP_ENV должен быть точно "staging" (проверьте .env.staging.local); текущий VITE_APP_ENV ${merged.VITE_APP_ENV === undefined ? 'не задан' : 'задан, но не равен "staging"'}`)
}

if (merged.VITE_FIREBASE_PROJECT_ID === 'finapp-prod-10a83') {
  fail('VITE_FIREBASE_PROJECT_ID равен production project ID (finapp-prod-10a83) — staging build не может использовать production Firebase project')
}

if (merged.VITE_FIREBASE_PROJECT_ID !== 'finapp-staging') {
  fail(`VITE_FIREBASE_PROJECT_ID должен быть точно "finapp-staging"; ${merged.VITE_FIREBASE_PROJECT_ID === undefined ? 'переменная не задана' : 'задано другое значение'}`)
}

try {
  // Единый источник правды с рантаймом приложения (src/lib/firebase.ts).
  const { resolveFirebaseEnv } = await import(path.join(repoRoot, 'src/lib/firebaseEnv.ts'))
  resolveFirebaseEnv(merged)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}

console.log('✓ build:staging preflight OK — VITE_APP_ENV=staging, projectId=finapp-staging, все обязательные переменные заданы')
