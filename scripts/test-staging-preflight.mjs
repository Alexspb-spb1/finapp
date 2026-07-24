#!/usr/bin/env node
// BASE-002 (независимое ревью, требование "добавь воспроизводимые проверки").
//
// Воспроизводимый набор сценариев для scripts/lib/stagingPreflight.mjs.
// Вызывает чистую функцию runStagingPreflight() напрямую с синтетическими
// (не реальными) конфигурациями — не читает .env-файлы, не требует сети,
// не использует реальные секреты. Каждый сценарий сравнивает фактический
// результат (ok/blocked/reason) с ожидаемым и печатает PASS/FAIL по каждому
// пункту. Скрипт завершается ненулевым кодом, если хотя бы один сценарий
// не совпал с ожиданием.
//
// Запуск: node scripts/test-staging-preflight.mjs
// (добавлено как npm script "test:staging-preflight" — см. package.json)

import { runStagingPreflight, FINGERPRINT_ENV_VAR } from './lib/stagingPreflight.mjs'
import { computeFirebaseConfigFingerprint } from './lib/firebaseConfigFingerprint.mjs'

// Синтетическая "утверждённая" staging-конфигурация — вымышленные значения,
// используются только внутри этого self-test процесса, никогда не пишутся
// в файлы и не являются реальным Firebase-проектом.
const VALID_STAGING_CONFIG = {
  VITE_APP_ENV: 'staging',
  VITE_FIREBASE_API_KEY: 'test-fixture-api-key-AAAAAAAAAAAAAAAAAAAAAAAAAA',
  VITE_FIREBASE_AUTH_DOMAIN: 'finapp-staging.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'finapp-staging',
  VITE_FIREBASE_STORAGE_BUCKET: 'finapp-staging.appspot.com',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '111111111111',
  VITE_FIREBASE_APP_ID: '1:111111111111:web:testfixture0000000000',
}

const VALID_FINGERPRINT = computeFirebaseConfigFingerprint({
  apiKey: VALID_STAGING_CONFIG.VITE_FIREBASE_API_KEY,
  authDomain: VALID_STAGING_CONFIG.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: VALID_STAGING_CONFIG.VITE_FIREBASE_PROJECT_ID,
  storageBucket: VALID_STAGING_CONFIG.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: VALID_STAGING_CONFIG.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: VALID_STAGING_CONFIG.VITE_FIREBASE_APP_ID,
})

const scenarios = [
  {
    name: 'Валидная синтетическая конфигурация + совпадающий fingerprint',
    source: { ...VALID_STAGING_CONFIG, [FINGERPRINT_ENV_VAR]: VALID_FINGERPRINT },
    expectOk: true,
  },
  {
    name: 'staging projectId, но несовпадающий API key (fingerprint не совпадёт)',
    source: {
      ...VALID_STAGING_CONFIG,
      VITE_FIREBASE_API_KEY: 'different-api-key-from-another-project-BBBBBBBBBB',
      [FINGERPRINT_ENV_VAR]: VALID_FINGERPRINT,
    },
    expectOk: false,
    expectBlocked: false,
    expectReasonIncludes: 'fingerprint',
  },
  {
    name: 'Отсутствующий ожидаемый fingerprint (переменная не задана)',
    source: { ...VALID_STAGING_CONFIG },
    expectOk: false,
    expectBlocked: true,
    expectReasonIncludes: FINGERPRINT_ENV_VAR,
  },
  {
    name: 'production projectId вместо staging',
    source: {
      ...VALID_STAGING_CONFIG,
      VITE_FIREBASE_PROJECT_ID: 'finapp-prod-10a83',
      [FINGERPRINT_ENV_VAR]: VALID_FINGERPRINT,
    },
    expectOk: false,
    expectBlocked: false,
    expectReasonIncludes: 'projectId',
  },
  {
    name: 'Отсутствующее обязательное поле (VITE_FIREBASE_APP_ID)',
    source: (() => {
      const { VITE_FIREBASE_APP_ID, ...rest } = VALID_STAGING_CONFIG
      return { ...rest, [FINGERPRINT_ENV_VAR]: VALID_FINGERPRINT }
    })(),
    expectOk: false,
    expectBlocked: false,
    expectReasonIncludes: 'VITE_FIREBASE_APP_ID',
  },
]

let allPass = true

for (const sc of scenarios) {
  const result = runStagingPreflight(sc.source)
  const okMatches = result.ok === sc.expectOk
  const blockedMatches =
    sc.expectBlocked === undefined ? true : Boolean(result.blocked) === sc.expectBlocked
  const reasonMatches =
    sc.expectReasonIncludes === undefined
      ? true
      : !result.ok && result.reason.includes(sc.expectReasonIncludes)

  const pass = okMatches && blockedMatches && reasonMatches
  allPass = allPass && pass

  console.log(`${pass ? '✓ PASS' : '✗ FAIL'} — ${sc.name}`)
  if (!pass) {
    console.log(`    ожидалось: ok=${sc.expectOk}, blocked=${sc.expectBlocked}, reason содержит "${sc.expectReasonIncludes ?? '(не проверяется)'}"`)
    console.log(`    получено:  ok=${result.ok}, blocked=${Boolean(result.blocked)}, reason="${result.ok ? '(успех)' : result.reason}"`)
  }
}

console.log('')
if (allPass) {
  console.log(`✓ Все ${scenarios.length} сценариев staging-preflight прошли как ожидалось.`)
  process.exit(0)
} else {
  console.error('✖ Один или несколько сценариев staging-preflight не совпали с ожиданием.')
  process.exit(1)
}
