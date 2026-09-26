// BASE-002 (независимое ревью, замечание №1): SHA-256 fingerprint полной
// конфигурации Firebase Web SDK.
//
// Node-only модуль (использует node:crypto) — намеренно НЕ импортируется из
// src/lib/**, чтобы никогда не попасть в клиентский бандл. Проверка projectId
// в src/lib/firebaseEnvCore.mjs недостаточна сама по себе: Firebase apiKey
// используется Authentication API и идентифицирует проект независимо от
// projectId — конфигурация с verified staging projectId, но apiKey от
// другого (в том числе production) проекта, прошла бы только projectId-
// проверку. Эта проверка требует совпадения ВСЕХ шести полей конфигурации
// (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId)
// с утверждённым staging-набором — через сравнение SHA-256 hex-дайджеста
// нормализованной строки, а не только одного поля.
//
// Сам ожидаемый fingerprint — не секрет в смысле "нельзя раскрыть" (SHA-256
// необратим), но должен поступать только из локальной переменной окружения
// или GitHub Secret и НЕ иметь префикса VITE_, чтобы гарантированно никогда
// не быть определённым в src/lib/firebaseEnv.ts или на нём основанном коде,
// и не попасть в клиентский бандл через Vite import.meta.env (Vite экспонирует
// клиенту только VITE_*-переменные).

import { createHash } from 'node:crypto'

/** Имя переменной окружения с ожидаемым fingerprint. Намеренно без префикса
 *  VITE_ (см. комментарий выше) — читается только этим Node-скриптом,
 *  никогда — кодом, который бандлит Vite. */
export const FINGERPRINT_ENV_VAR = 'STAGING_FIREBASE_CONFIG_FINGERPRINT'

const FIELDS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId']

/**
 * Строит детерминированную нормализованную строку `key=value` (фиксированный
 * порядок полей, разделитель `\n`) и возвращает её SHA-256 hex-дайджест.
 * @param {{apiKey:string, authDomain:string, projectId:string, storageBucket:string, messagingSenderId:string, appId:string}} config
 * @returns {string} 64-символьный hex SHA-256
 */
export function computeFirebaseConfigFingerprint(config) {
  const normalized = FIELDS.map(key => `${key}=${String(config[key] ?? '').trim()}`).join('\n')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * Сравнивает вычисленный и ожидаемый fingerprint. Регистронезависимо и с
 * обрезкой пробелов (владелец может скопировать значение с пробелом/переносом
 * строки из GitHub Secrets UI) — но без ослабления самой проверки: сравнение
 * по-прежнему точное посимвольное совпадение hex-строки.
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
export function fingerprintsMatch(actual, expected) {
  return actual.trim().toLowerCase() === expected.trim().toLowerCase()
}
