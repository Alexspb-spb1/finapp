#!/usr/bin/env node
// BASE-002: preflight-guard для `npm run build:staging`.
//
// Читает .env / .env.staging / .env.staging.local (в порядке возрастания
// приоритета — так же, как это делает Vite для `--mode staging`), затем
// process.env поверх (VITE_*-переменные и FINGERPRINT_ENV_VAR — чтобы можно
// было изолированно проверять негативные сценарии и передавать GitHub
// Secret в CI, не трогая сами файлы).
//
// Вся содержательная логика — в scripts/lib/stagingPreflight.mjs (чистая
// функция, переиспользуется также в scripts/test-staging-preflight.mjs).
// Этот файл — только чтение файлов/process.env, вызов проверки и
// process.exit. Обычный JavaScript (не TypeScript) без каких-либо
// экспериментальных Node-флагов — совместим с Node 20 (текущий CI) и выше.
//
// Никогда не печатает значения переменных или fingerprint — только имена
// переменных и причины отказа.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runStagingPreflight, FINGERPRINT_ENV_VAR } from './lib/stagingPreflight.mjs'

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

// process.env поверх файлов — только для явно переданных VITE_*-значений
// (точечное переопределение при негативном тесте, не трогая файлы) и для
// FINGERPRINT_ENV_VAR отдельно (основной канал для GitHub Secret в CI —
// секрет staging-fingerprint не должен обязательно жить в файле).
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('VITE_') && value !== undefined) {
    merged[key] = value
  }
}
if (process.env[FINGERPRINT_ENV_VAR] !== undefined) {
  merged[FINGERPRINT_ENV_VAR] = process.env[FINGERPRINT_ENV_VAR]
}

const result = runStagingPreflight(merged)

if (!result.ok) {
  console.error(`✖ build:staging preflight FAILED${result.blocked ? ' — BLOCKED' : ''}`)
  console.error(`  ${result.reason}`)
  console.error('  (значения переменных и fingerprint в этом сообщении не выводятся)')
  process.exit(1)
}

console.log(
  '✓ build:staging preflight OK — VITE_APP_ENV=staging, projectId=finapp-staging, ' +
  'все обязательные переменные заданы, SHA-256 fingerprint конфигурации совпадает с ожидаемым staging-набором'
)
