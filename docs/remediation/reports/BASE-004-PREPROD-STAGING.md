# BASE-004-PREPROD-STAGING-01 — Staging deployment and verification of BASE-004A Firestore Rules

## Итоговый статус
READY_FOR_INDEPENDENT_REVIEW (`BASE_004_PREPROD_STAGING_READY_FOR_INDEPENDENT_REVIEW`)

## Исправление независимого аудита — раунд 2 (`CORRECTION-02`)

Это второй корректирующий раунд. Первый (`CORRECTION-01`) устранил четыре
замечания к самой первой версии; независимый аудит второй версии нашёл
дополнительные структурные проблемы в самом verification harness'е, а не
в отчёте. Ниже — все замечания обоих раундов и как каждое устранено.

### Раунд 1 (`CORRECTION-01`) — исправлено ранее

1. **`build:staging` падал, но задача была объявлена готовой** — исправлено:
   получена реальная staging Web SDK-конфигурация (владелец явно одобрил
   read-only bootstrap), создан `.env.staging.local`, `build:staging`
   теперь реально проходит.
2. **Staging-write без буквального разрешения** — исправлено: разрешение
   получено явно и буквально перед началом соответствующего раунда.
3. **Доказательства 22 сценариев отсутствовали в репозитории** —
   исправлено: воспроизводимый harness сохранён в
   `scripts/stagingVerify/run.mjs` + `README.md`, обезличенный JSON
   закоммичен.
4. **`result SHA` не заполнен, отсутствующие команды не помечены
   `NOT AVAILABLE`** — исправлено в отчёте того раунда.

### Раунд 2 (`CORRECTION-02`) — исправлено в этом коммите

Независимый аудит нашёл, что сам harness (не отчёт) был структурно
недостаточен:

5. **Project guard не был по-настоящему fail-closed** — раньше harness
   проверял только `PROJECT_ID !== 'finapp-prod-10a83'` (blocklist), а не
   `PROJECT_ID === 'finapp-staging'` (allowlist) — произвольный третий
   Firebase-проект прошёл бы проверку. **Исправлено**: `checkProjectGuard()`
   в `scripts/stagingVerify/run.mjs` теперь требует **строгого** равенства
   `finapp-staging` и для `VITE_FIREBASE_PROJECT_ID`, и для разрешённого
   `projectId`, отклоняет их рассогласование, отдельно и явно отклоняет
   производственный ID, и блокирует прогон при наличии
   `FIRESTORE_EMULATOR_HOST`/`FIREBASE_AUTH_EMULATOR_HOST` (неоднозначность
   реальной цели записи). Guard выполняется **до** `requireAuth()`, до
   конструирования Admin REST-клиента и до первой фикстуры — ни одна
   учётная запись/документ не создаются, если guard не пройден.
6. **Sha хешей Rules не был кроссплатформенным** — раньше сравнивались
   сырые байты файла и байты, полученные от Firebase API, без нормализации
   перевода строк, что могло дать ложное расхождение между Windows-чекаутом
   (CRLF) и Linux-чекаутом (LF) при абсолютно идентичном содержании правил.
   **Исправлено**: `canonicalizeRulesText()` выполняет `CRLF → LF`, затем
   одиночный `CR → LF`, кодировка — UTF-8; `canonicalSha256()` считает
   SHA-256 hex от канонизированной строки. Функция применяется одинаково
   к локальному `firestore.rules` и к исходнику активного staging ruleset
   перед сравнением. Значащие пробелы/отступы не трогаются.
7. **Rules-проверка не была строго блокирующей до создания фикстур** —
   раньше несовпадение/ошибка чтения активного ruleset логировались как
   `WARN`, но не останавливали прогон. **Исправлено**: `evaluateRulesHashCheck()`
   вызывается сразу после получения credentials и **до** первой фикстуры;
   любая ошибка чтения/парсинга активного ruleset или несовпадение
   canonical SHA-256 теперь завершают процесс с ненулевым exit code
   (`BASE_004_PREPROD_CORRECTION_02_BLOCKED_RULES_HASH`), не создавая ни
   одной фикстуры, не запуская ни один из 22 сценариев, не выполняя deploy.
   Проверка всегда делает свежий read-only запрос — никогда не использует
   сохранённый хеш из прошлого прогона.
8. **Не было автономного self-test** — добавлен
   `node scripts/stagingVerify/run.mjs --self-test`: 9 чистых проверок без
   сети и credentials (LF/CRLF/CR-эквивалентность хеша ×2, project guard на
   `finapp-staging`/`finapp-prod-10a83`/произвольном стороннем
   проекте/emulator-переменных ×4, rules hash check на ошибке
   чтения/несовпадении/совпадении ×3) — все 9/9 PASS (см. «Результаты
   self-test» ниже).

## Двухкоммитная процедура (без само-ссылки на ещё не созданный коммит)

- **Коммит A** (harness fix, только `scripts/stagingVerify/run.mjs` +
  `scripts/stagingVerify/README.md`):
  **`TESTED_RESULT_SHA = 3d29589914200ef958bc392ec0ec53ff7514d163`**
  Именно на этом коммите выполнен self-test, полный staging-прогон и весь
  набор локальных проверок (раздел «Проверки» ниже).
- **Коммит B** (этот коммит — только отчёт и JSON-доказательство,
  фиксирующие результаты, полученные на коммите A).

## Branch / PR
- branch: `remediation/BASE-004-preprod-staging`
- Draft PR: [#5](https://github.com/Alexspb-spb1/finapp/pull/5)
- исходный SHA `origin/main`: `e1e958a8cb5eb5e750b3024a05d915fcc3d0c7a4`
- head PR **до** этого раунда (`CORRECTION-02`): `8ef66864ed75421b4f810f1a264a1b645d603103`
- **`TESTED_RESULT_SHA`** (коммит A, проверенный полным набором проверок): `3d29589914200ef958bc392ec0ec53ff7514d163`
- **`FINAL_PR_HEAD_SHA`** (коммит B, этот отчёт) — см. финальный ответ в чате
  сразу после `git commit`/`git push` этого раунда.

## Что изменено в этом раунде
- `scripts/stagingVerify/run.mjs` — добавлены `checkProjectGuard()`
  (строгий fail-closed project guard), `canonicalizeRulesText()` /
  `canonicalSha256()` (кроссплатформенная нормализация), `evaluateRulesHashCheck()`
  (обязательная блокирующая проверка перед фикстурами), режим `--self-test`.
- `scripts/stagingVerify/README.md` — задокументированы fail-closed
  гарантии, self-test, новые exit-коды/статусы блокировки.
- `docs/remediation/evidence/BASE-004-PREPROD-STAGING-scenarios-result.json`
  — перегенерирован полным прогоном на коммите A: содержит `projectId`,
  `sourceGitSha`, описание алгоритма нормализации, полный
  локальный/активный canonical SHA-256, `rulesHashMatch: true`, результат
  project guard, результат self-test (9/9), все 22 сценария, счётчики
  фикстур, подтверждение нулевого остатка.
- Этот отчёт (коммит B).

**Не изменялось**: приложение/`src/**`, `firestore.rules`,
Firebase-конфигурация, `.env*` (кроме использования уже существующего
`.env.staging.local`, не добавленного в git), `package.json`,
lock-файл, зависимости, GitHub workflow, чекбоксы `REMEDIATION_PLAN.md`.

## Затронутые файлы
```text
Коммит A:
 M scripts/stagingVerify/run.mjs
 M scripts/stagingVerify/README.md

Коммит B:
 M docs/remediation/evidence/BASE-004-PREPROD-STAGING-scenarios-result.json
 M docs/remediation/reports/BASE-004-PREPROD-STAGING.md
```
Diff между коммитами A и B содержит только эти два файла — проверено
`git diff <TESTED_RESULT_SHA> HEAD --stat` перед коммитом B.

## Fail-closed project guard — подтверждение поведения
`checkProjectGuard({ viteProjectId, resolvedProjectId, firestoreEmulatorHost, authEmulatorHost })`:
- Требует **точное** равенство `finapp-staging` для обоих источников
  project id (не просто «не production»).
- Отклоняет рассогласование между `VITE_FIREBASE_PROJECT_ID` и разрешённым
  `STAGING_PROJECT_ID`/`.env.staging.local`.
- Отдельно и явно отклоняет `finapp-prod-10a83`.
- Отклоняет произвольный третий (не staging, не production) project id.
- Отклоняет реальный прогон при наличии
  `FIRESTORE_EMULATOR_HOST`/`FIREBASE_AUTH_EMULATOR_HOST`.
- Выполняется **до** `requireAuth()`/Admin REST-клиента/первой фикстуры —
  при провале ни один credential не запрашивается, ни одна фикстура не
  создаётся, процесс завершается с exit code 2 и сообщением
  `BASE_004_PREPROD_CORRECTION_02_BLOCKED_PROJECT_GUARD`.

Фактический результат реального прогона на `TESTED_RESULT_SHA`:
```text
project guard: PASS (projectId=finapp-staging)
```

## Канонизация Rules SHA-256 — алгоритм и подтверждение
```text
Алгоритм: CRLF -> LF, затем одиночный CR -> LF, кодировка UTF-8,
          SHA-256 hex от канонизированной строки.
```
Значащие пробелы/отступы не удаляются — трогаются только символы перевода
строки. Применяется одинаково к локальному `firestore.rules` (на этом
Windows-чекауте физически хранится с CRLF — подтверждено побайтовым
осмотром) и к исходнику, полученному read-only от Firebase Rules
Management API для активного staging ruleset.

| Параметр | Значение |
|---|---|
| Локальный canonical SHA-256 | `b0f6c045e908bc632a4b24381c3c1164ccca95834761b2dc68d460bce6524c8f` |
| Активный staging ruleset | `projects/finapp-staging/rulesets/01da0ec2-a6b0-4b17-b533-81195a573359` |
| Активный canonical SHA-256 | `b0f6c045e908bc632a4b24381c3c1164ccca95834761b2dc68d460bce6524c8f` |
| `rulesHashMatch` | **true** |

(Значение canonical-хеша отличается от сырого побайтового SHA-256 файла,
`1213b185aeb68c124abfd4d7c5921412d2a71aa3413a7b939e9d3648d72a1657`,
использованного в прошлых раундах — это ожидаемо: канонизация меняет
байты нормализацией перевода строк, но не меняет факта совпадения
локального и активного источника, что и есть предмет проверки.)

Проверка **не использовала** сохранённый хеш из прошлого раунда — выполнен
свежий read-only запрос активного ruleset непосредственно перед запуском
22 сценариев, и она стоит строго до первой фикстуры (см. код
`evaluateRulesHashCheck` в `scripts/stagingVerify/run.mjs`).

**Rules deploy в этом раунде не выполнялся** — не требовался (хеши уже
совпадали) и явно запрещён этим раундом (`STAGING_RULES_DEPLOY_APPROVED: false`).

## Результаты self-test (`node scripts/stagingVerify/run.mjs --self-test`)
```text
PASS — LF vs CRLF canonical SHA-256 match
PASS — LF vs lone-CR canonical SHA-256 match
PASS — project guard: finapp-staging passes
PASS — project guard: finapp-prod-10a83 blocked
PASS — project guard: arbitrary other project id blocked
PASS — project guard: emulator host vars block a real run
PASS — rules hash check: fetch error is blocking
PASS — rules hash check: mismatch is blocking
PASS — rules hash check: match is OK

SELF-TEST: 9 checks, 9 passed, 0 failed
```
Выполнен без сети и credentials (чистые функции на синтетических входах).

## Проверки (все — на `TESTED_RESULT_SHA = 3d29589914200ef958bc392ec0ec53ff7514d163`)
| Команда | Exit code | Результат | Примечание |
|---|---|---|---|
| `npm ci` (изолированный `--cache`, свежий `node_modules`) | 0 | PASS | 929 пакетов |
| `npm run test:staging-preflight` | 0 | PASS | 5/5 |
| `npx tsc --noEmit -p tests/rules/tsconfig.json` | 0 | PASS | |
| `npm run test:rules` (Firestore Emulator, portable Java 21) | 0 | **PASS — 77/77, 0 failed, 0 skipped** | |
| `npm run test:unit` | 0 | PASS | 9/9 |
| `npm run lint` | 0 | PASS | Ровно то же неизменившееся предупреждение `Balance.tsx:119:6` |
| `npx tsc -b --pretty false` | 0 | PASS | |
| `npm run build:staging` | 0 | **PASS** | `dist/` не содержит `finapp-prod-10a83`, содержит `finapp-staging` |
| `git diff --check` | 0 | PASS | |
| `node scripts/stagingVerify/run.mjs --self-test` | 0 | **PASS — 9/9** | |
| `node scripts/stagingVerify/run.mjs` (реальный staging-прогон) | 0 | **PASS — 22/22, 0 failed, 0 skipped** | project guard PASS, rules hash match PASS, cleanup 0 остатка |
| `npm run typecheck` | — | **NOT AVAILABLE** | Скрипт отсутствует в `package.json` |
| `npm run test:run` | — | **NOT AVAILABLE** | Скрипт отсутствует в `package.json` |
| `npm run test:e2e` | — | **NOT AVAILABLE** | Скрипт отсутствует в `package.json` |

Дополнительно: секретов/токенов/`AIza…`-литералов/реальных email в
`scripts/stagingVerify/run.mjs`, `README.md`, обоих JSON/MD-файлах
доказательства — не найдено; `.env.staging.local` не добавлен в git;
`package.json`/`package-lock.json`/зависимости не менялись.

## Java / Node / Firebase CLI
Node `v24.16.0`, npm `11.13.0`, portable Temurin Java `21.0.12` (для Rules
Emulator; системная Java осталась нетронутой), Firebase CLI `15.24.0`.

## Результаты 22 staging-сценариев (реальный Firebase Client SDK)
Полный обезличенный JSON:
[`docs/remediation/evidence/BASE-004-PREPROD-STAGING-scenarios-result.json`](../evidence/BASE-004-PREPROD-STAGING-scenarios-result.json).

| # | Сценарий | Ожидание | Результат |
|---|---|---|---|
| 1 | Неавторизованный доступ к `company_data/A` | DENY | PASS |
| 2 | Пользователь без `users/{uid}` → `company_data/A` | DENY | PASS |
| 3a–c | self-update `role`/`companyId`/`companies[]` | DENY | PASS (все три) |
| 4a–b | Межкорпоративное чтение/запись `company_data/A` | DENY | PASS (оба) |
| 5a | viewer читает свою `company_data/A` | ALLOW | PASS |
| 5b | viewer пишет в `company_data/A` | DENY | PASS |
| 6a | accountant — обычная разрешённая запись | ALLOW | PASS |
| 6b | accountant меняет `closingDate` | DENY | PASS |
| 7 | admin меняет `closingDate` | ALLOW | PASS |
| 8 | Query сотрудников своей компании (A) | ALLOW | PASS |
| 9 | Query сотрудников доп. компании (B) при валидном membership | ALLOW | PASS |
| 10a–b | «Домашний» admin (viewer @ B) не получает admin-права в B | DENY (оба) | PASS |
| 10c | Контроль: настоящий admin @ B действительно может писать в B | ALLOW | PASS |
| 11a–c | Неограниченные/смешанные межкорпоративные queries | DENY (все три) | PASS |
| 12a–b | Spoofing `ownerId` (create/update) | DENY (оба) | PASS |

**TOTAL: 22, PASS: 22, FAIL: 0, SKIPPED: 0.**

### Cleanup
```json
{
  "fixturesCreated": { "companies": 3, "companyData": 2, "userDocs": 6, "authUsers": 7 },
  "fixturesDeleted": { "companies": 3, "companyData": 2, "userDocs": 6, "authUsers": 7 },
  "cleanupErrors": [],
  "zeroResidueConfirmed": true
}
```
Cleanup выполнен в блоке `finally` (гарантированно, независимо от
результата сценариев). Нулевой остаток подтверждён отдельным независимым
`runQuery`/`accounts:lookup` запросом после удаления, не доверием коду
удаления.

## Security review
- Rules на staging **не менялись и не деплоились** в этом раунде.
- Project guard теперь fail-closed по строгому allowlist, а не blocklist —
  устраняет ровно тот класс риска, который отметил аудит (гипотетический
  третий проект прошёл бы старую проверку).
- Rules hash check теперь безусловно блокирующий и всегда свежий — не
  может быть обойдён устаревшим сохранённым хешем.
- Все 22 проверки — реальный Client SDK, без admin-обхода; admin-доступ
  (уже авторизованная сессия `firebase-tools`) — только для
  setup/cleanup синтетических фикстур.
- Ни один секрет/токен/конфигурация/fingerprint не выводились.
- Production не затрагивался никакими write-действиями в этом раунде.

## Данные и миграция
Нет. Единственная внешняя запись — временные синтетические тестовые
сущности на `finapp-staging`, полностью удалённые с подтверждённым нулевым
остатком.

## Rollback
Без изменений — Rules на staging не менялись в этом раунде, deploy не
выполнялся, откатывать нечего. Процедура на случай будущего deploy
не изменилась относительно предыдущих раундов: сохранённая точка отката
(deny-all заглушка, `sha256=ecf30f9...84eb` от сырых байт) остаётся
валидной вне репозитория.

## Известные ограничения
1. `gcloud` CLI неработоспособен в этой среде — весь доступ через уже
   авторизованную сессию `firebase-tools`.
2. Второй Web App в `finapp-staging` (не самый старый) по-прежнему не
   используется этим harness, не тронут — вне scope.
3. Известные breaking changes из `BASE-004A` (регистрация, приглашение,
   смена роли, создание доп. компании через self-update) — не менялись, в
   силе до Cloud Functions.

## Подтверждение отсутствия production/деплой-действий
- `firebase deploy` — не вызывался ни разу ни в одном раунде (ни staging,
  ни production).
- Production Rules/данные/Auth/IAM — не изменялись.
- Hosting/Functions/indexes — не деплоились нигде.
- Приложение, `firestore.rules`, Firebase-конфигурация, `.env*` в git,
  `package.json`, lock-файл, зависимости, GitHub workflow — не менялись.
- `main`, исходная remediation-ветка — не изменялись и не сливались.
- `REMEDIATION_PLAN.md` — `BASE-004`/`BASE-005` остаются `[ ]`.
- Draft PR #5 остаётся Draft — merge не выполнялся.

## Diff summary
```text
Коммит A (3d29589914200ef958bc392ec0ec53ff7514d163):
 scripts/stagingVerify/run.mjs    | 291 insertions, 66 deletions
 scripts/stagingVerify/README.md  | обновлён (fail-closed гарантии, self-test)

Коммит B (этот):
 docs/remediation/evidence/BASE-004-PREPROD-STAGING-scenarios-result.json | перегенерирован
 docs/remediation/reports/BASE-004-PREPROD-STAGING.md                     | этот отчёт
```

## Следующий разрешённый пункт
Не определяется и не анализируется. Следующий шаг — независимый аудит
именно этого исправленного раунда, НЕ `BASE-005` и НЕ production
deployment.
