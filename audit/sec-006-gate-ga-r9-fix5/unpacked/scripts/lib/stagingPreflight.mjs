// BASE-002 (независимое ревью, замечания №1 и №2): чистая, без побочных
// эффектов, реализация staging preflight-проверки — используется и реальным
// CLI-скриптом (scripts/verify-staging-env.mjs), и воспроизводимым
// self-test набором (scripts/test-staging-preflight.mjs), чтобы не
// дублировать правила между «настоящей» проверкой и тестами на неё.
//
// Обычный JavaScript (не TypeScript) — обязано работать на Node 20 (текущий
// CI, .github/workflows/deploy.yml) без `--experimental-strip-types`
// (доступен только с Node 22.6+).
//
// Ничего не читает из файловой системы и не завершает процесс — принимает
// произвольный объект-источник переменных окружения и возвращает результат
// как значение. Реальное чтение .env-файлов и process.exit — только в
// scripts/verify-staging-env.mjs.

import { resolveFirebaseEnv } from '../../src/lib/firebaseEnvCore.mjs'
import { computeFirebaseConfigFingerprint, fingerprintsMatch, FINGERPRINT_ENV_VAR } from './firebaseConfigFingerprint.mjs'

export { FINGERPRINT_ENV_VAR }

/**
 * @typedef {{ ok: true, resolved: import('../../src/lib/firebaseEnvCore.d.mts').ResolvedFirebaseEnv, fingerprint: string }
 *         | { ok: false, reason: string, blocked?: boolean }} StagingPreflightResult
 */

/**
 * Полная staging preflight-проверка: структура конфигурации (через
 * resolveFirebaseEnv) + SHA-256 fingerprint всех шести полей Firebase Web
 * SDK config против утверждённого staging-набора.
 *
 * Это НЕ проверка эмулятор-режима — только путь `VITE_APP_ENV=staging`
 * (тот самый путь, для которого независимое ревью указало на недостаточность
 * only-projectId проверки).
 *
 * @param {Record<string, string | undefined>} source — объект переменных
 *   окружения (файлы .env/.env.staging/.env.staging.local, смёрженные с
 *   process.env — см. scripts/verify-staging-env.mjs), либо синтетический
 *   объект в тестах.
 * @returns {StagingPreflightResult}
 */
export function runStagingPreflight(source) {
  if (source.VITE_APP_ENV !== 'staging') {
    return {
      ok: false,
      reason: `VITE_APP_ENV должен быть точно "staging"; текущий VITE_APP_ENV ${
        source.VITE_APP_ENV === undefined ? 'не задан' : 'задан, но не равен "staging"'
      }`,
    }
  }

  let resolved
  try {
    resolved = resolveFirebaseEnv(source)
  } catch (err) {
    // Покрывает: отсутствующее обязательное поле, production/любой чужой
    // projectId, demo-finapp вне режима эмуляторов — вся логика в
    // resolveFirebaseEnv (единый источник правды с рантаймом приложения).
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }

  const expectedFingerprint = source[FINGERPRINT_ENV_VAR]
  if (!expectedFingerprint || !String(expectedFingerprint).trim()) {
    return {
      ok: false,
      blocked: true,
      reason:
        `Переменная окружения ${FINGERPRINT_ENV_VAR} не задана — ожидаемый staging-fingerprint ` +
        'не предоставлен. Реальная staging-сборка BLOCKED: projectId сам по себе не гарантирует, ' +
        'что apiKey/authDomain/storageBucket/messagingSenderId/appId принадлежат утверждённому ' +
        'staging-проекту (apiKey используется Firebase Authentication API независимо от projectId). ' +
        `Владелец должен предоставить ${FINGERPRINT_ENV_VAR} через .env.staging.local (локально, ` +
        'вне Git) или GitHub Secret (для CI) — см. docs/remediation/reports/BASE-002.md.',
    }
  }

  const actualFingerprint = computeFirebaseConfigFingerprint(resolved.config)
  if (!fingerprintsMatch(actualFingerprint, String(expectedFingerprint))) {
    return {
      ok: false,
      reason:
        'SHA-256 fingerprint конфигурации Firebase Web SDK (apiKey/authDomain/projectId/' +
        'storageBucket/messagingSenderId/appId) не совпадает с ожидаемым staging-fingerprint. ' +
        'Одно или несколько полей не соответствуют утверждённой staging-конфигурации — например, ' +
        'apiKey может принадлежать другому проекту, включая production, даже если projectId указан ' +
        'верно. Fingerprint-значения в это сообщение не выводятся.',
    }
  }

  return { ok: true, resolved, fingerprint: actualFingerprint }
}
