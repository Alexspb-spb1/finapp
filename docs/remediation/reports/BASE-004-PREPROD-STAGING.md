# BASE-004-PREPROD-STAGING-01 — Staging deployment and verification of BASE-004A Firestore Rules

## Итоговый статус
READY_FOR_INDEPENDENT_REVIEW (`BASE_004_PREPROD_STAGING_READY_FOR_INDEPENDENT_REVIEW`)

## Branch / commit
- branch: `remediation/BASE-004-preprod-staging`
- base SHA: `e1e958a8cb5eb5e750b3024a05d915fcc3d0c7a4` (= `origin/main`, подтверждено preflight)
- result SHA: см. финальный ответ в чате после коммита

## Проверенное исходное состояние
- Preflight: рабочее дерево было чистым, `origin/main` совпал с ожидаемым SHA
  побитово, целевая ветка не существовала ни локально, ни на origin —
  создана строго от `origin/main`.
- Прочитаны целиком: `REMEDIATION_PLAN.md` (BASE-004 подтверждена открытой
  `[ ]`), `firestore.rules`, `tests/rules/firestore.rules.test.ts`,
  `docs/remediation/SECURITY_BASELINE.md`,
  `docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md`,
  `docs/remediation/reports/BASE-004A.md`,
  `docs/runbooks/BACKUP_AND_RESTORE.md`, `.firebaserc`, `firebase.json`,
  `package.json`, `src/store/authStore.ts`, `src/store/companyStore.ts`.
- Подтверждено самостоятельно (не на веру из отчётов): `staging` =
  `finapp-staging`, `production` = `finapp-prod-10a83`; текущий
  `firestore.rules` — это версия после `BASE-004A-FIX-02`, ранее прошедшая
  77 emulator-тестов (перепроверено заново в этом раунде, см. ниже);
  регистрация нового аккаунта/компании, приглашение сотрудника, смена роли,
  создание доп. компании остаются известными breaking changes до
  реализации Cloud Functions (не изменено в этой задаче).
- **Read-only сверка production**: активный ruleset `finapp-prod-10a83`
  получен через официальный Firebase Rules Management API, сравнён
  структурно с `SECURITY_BASELINE.md` — совпадает **дословно** (те же
  функции `isSignedIn/myUser/isMember/roleIn/canWrite/isAdminOf`, та же
  незащищённая self-update ветка `users/{userId}`). **Production не
  изменился с момента классификации `C`** — не пропатчен, не изменён кем-то
  третьим. Production не изменялся и не деплоился в рамках этой задачи.

## Что изменено
- Единственное внешнее изменение состояния: **Firestore Rules проекта
  `finapp-staging`** заменены с deny-all-заглушки (163 байта) на текущую
  версию `firestore.rules` из этой ветки (после `BASE-004A-FIX-02`).
- В репозитории изменён/добавлен только этот отчёт:
  `docs/remediation/reports/BASE-004-PREPROD-STAGING.md`.
- Временные Node-скрипты для admin-доступа к fixtures
  (`scripts/_stg_fixtures_setup.cjs`, `scripts/_stg_run_scenarios.mjs`,
  `scripts/_stg_fixtures_cleanup.cjs`) созданы, использованы и **удалены**
  до коммита — не отслеживались git, в diff не входят.

## Почему изменения входят в текущий пункт
Единственная цель `BASE-004-PREPROD-STAGING-01` — развернуть уже
подготовленные (BASE-004A) Rules в staging и подтвердить их фактическое
поведение реальными запросами. Никакой код приложения, `main`, исходная
remediation-ветка или production не затронуты.

## Затронутые файлы
```text
A  docs/remediation/reports/BASE-004-PREPROD-STAGING.md
```
`git diff --stat -- src/` — пусто. `REMEDIATION_PLAN.md` не менялся,
чекбоксы `BASE-004`/`BASE-005` не трогались.

## Критерии приемки
- [x] Independent-style перепроверка Rules и тестов, а не доверие старым отчётам
- [x] Rules развёрнуты **только** в `finapp-staging`, production не тронут
- [x] Точка отката (staging, до deploy) сохранена и проверена
- [x] Read-only сверка production ruleset выполнена, изменений не выявлено
- [x] SHA-256 локального и развёрнутого staging Rules совпадают побитово
- [x] Реальные сценарии проверены через настоящий Firebase Client SDK против staging (22/22 PASS)
- [x] Все синтетические Auth-аккаунты и Firestore-документы удалены, отсутствие остатка подтверждено независимо
- [x] Отчёт создан, `REMEDIATION_PLAN.md` не изменён
- [ ] `npm run build:staging` — не пройден: отсутствует локальный `.env.staging`/`.env.staging.local` с настоящим staging Firebase Web config (owner-secret, недоступен в этой сессии и не должен создаваться агентом). Не является дефектом кода — см. «Проверки» и «Известные ограничения». Не блокирует цель задачи, так как Hosting/client-bundle deploy в этой задаче не выполняется и не входит в её разрешённый scope.

## Проверки
| Команда | Exit code | Результат | Примечание |
|---|---|---|---|
| `npm ci` (без переиспользования `node_modules`) | 0 | PASS | `rm -rf node_modules && npm ci` — 929 пакетов |
| `npm run test:staging-preflight` | 0 | PASS | 5/5 синтетических сценариев (валидная/невалидная конфигурация, fingerprint mismatch, production projectId вместо staging, отсутствующее обязательное поле) |
| `npx tsc --noEmit -p tests/rules/tsconfig.json` | 0 | PASS | |
| `npm run test:rules` (Firestore Emulator, portable Java 21) | 0 | **PASS — 77/77, 0 failed, 0 skipped** | См. вывод ниже |
| `npm run test:unit` | 0 | PASS | 9/9 — тесты `bankStatementImport.test.ts` (догрузка выписок с дедупликацией) не регрессировали |
| `npm run lint` | 0 | PASS | Ровно 1 ранее известное предупреждение `Balance.tsx:119:6` (`react-hooks/exhaustive-deps`, `isFinancialKind`) — подтверждено идентичным, 0 ошибок |
| `npx tsc -b --pretty false` | 0 | PASS | |
| `npm run build:staging` | 1 | **FAIL — по причине окружения, не кода** | `node scripts/verify-staging-env.mjs`: «VITE_APP_ENV должен быть точно "staging"; текущий VITE_APP_ENV не задан» — нет локального `.env.staging(.local)`. Значения переменных скрипт не печатает (собственный контракт скрипта) |
| `git diff --check` | 0 | PASS | |

Дополнительно (не в списке протокола, но необходимо для мандата
«не доверяй отчётам»):
- `.skip(`/`.only(`/`.todo(` в тестах — не найдено
- `@ts-ignore`/`@ts-expect-error` — не найдено
- конфликтные маркеры (`git grep`) — не найдено
- `package.json`/`package-lock.json` — не изменены (`git diff origin/main -- package.json package-lock.json` пусто)
- отслеживаемые `.env*` — только `.env.example`
- secret-паттерны (`AIza...` литерал) в `src/`/`scripts/` — не найдено

## Фактический вывод существенных тестов
```text
$ npm run test:rules
 Test Files  1 passed (1)
      Tests  77 passed (77)

$ npm run test:unit
 Test Files  1 passed (1)
      Tests  9 passed (9)

$ npm run test:staging-preflight
✓ PASS — Валидная синтетическая конфигурация + совпадающий fingerprint
✓ PASS — staging projectId, но несовпадающий API key (fingerprint не совпадёт)
✓ PASS — Отсутствующий ожидаемый fingerprint (переменная не задана)
✓ PASS — production projectId вместо staging
✓ PASS — Отсутствующее обязательное поле (VITE_FIREBASE_APP_ID)
✓ Все 5 сценариев staging-preflight прошли как ожидалось.

$ npm run lint
D:\...\src\pages\Balance.tsx
  119:6  warning  React Hook useMemo has a missing dependency: 'isFinancialKind' ...
✖ 1 problem (0 errors, 1 warning)
```

## Локальный SHA-256 Rules
```text
firestore.rules: 1213b185aeb68c124abfd4d7c5921412d2a71aa3413a7b939e9d3648d72a1657
```

## Точка отката staging (до deploy)
| Параметр | Значение |
|---|---|
| Метод получения | Firebase Rules Management API (`firebaserules.googleapis.com`), через уже авторизованную сессию `firebase-tools` (без ввода/печати токена) |
| Активный ruleset ДО deploy | `projects/finapp-staging/rulesets/a4f74201-8545-4d07-b6c1-a874dada855d` |
| Содержимое ДО deploy | deny-all заглушка, `rules_version='2'; ... match /{document=**} { allow read, write: if false; }` |
| SHA-256 ДО deploy | `ecf30f940747dcc3c5ba4993093e9a11ac9fc5df7e14b2a1512d2446923d84eb` (163 байта) |
| Исходник сохранён | во временном закрытом файле вне репозитория (сессионный scratchpad, не в git) |
| Технический rollback | подтверждён возможным: тот же авторизованный канал (`gcp/rules.js`: `createRuleset`/`updateOrCreateRelease`) может опубликовать сохранённый исходник как новый активный release без дополнительных предусловий |

## Read-only сверка production
| Параметр | Значение |
|---|---|
| Проект | `finapp-prod-10a83` (только чтение, ничего не изменялось) |
| Активный ruleset | `projects/finapp-prod-10a83/rulesets/c9e2fc3f-4c8a-45cf-b1ae-f15fb5119409` |
| SHA-256 | `189b095ebbeeb9bab9af11529a86a4fae06d78b8f6edad37b986df2d52134271` (4941 байт) |
| Совпадает с классификацией `SECURITY_BASELINE.md` (**C**)? | **Да** — структурно идентичен (те же функции, та же незащищённая self-update ветка `users/{userId}`); production не менялся с момента исходного аудита |
| Production действия | Только `GET` через Rules Management API. `firebase deploy` к `finapp-prod-10a83` не вызывался ни разу |

## Staging deployment
```text
TARGET_PROJECT=finapp-staging
TARGET_RESOURCE=firestore:rules
PRODUCTION_TARGETED=false

$ firebase deploy --only firestore:rules --project finapp-staging --non-interactive
+  cloud.firestore: rules file firestore.rules compiled successfully
+  firestore: released rules firestore.rules to cloud.firestore
+ Deploy complete!
```
Подтверждено отдельно: `firestore:indexes` на staging остались пустыми
(`{"indexes": [], "fieldOverrides": []}`) — служебная строка "reading
indexes from firestore.indexes.json" в логе деплоя не привела к
фактической публикации индексов (индексы вообще не деплоились, что и
требовалось).

### Ruleset после deploy
| Параметр | Значение |
|---|---|
| Активный ruleset ПОСЛЕ deploy | `projects/finapp-staging/rulesets/01da0ec2-a6b0-4b17-b533-81195a573359` |
| SHA-256 ПОСЛЕ deploy | `1213b185aeb68c124abfd4d7c5921412d2a71aa3413a7b939e9d3648d72a1657` |
| Совпадает с локальным `firestore.rules`? | **Да, побитово** |

## Реальная проверка staging (Firebase Client SDK, синтетические фикстуры)

### Созданные синтетические фикстуры (без секретов)
Все email на домене `example.invalid` (RFC 2606, никогда не резолвится),
все ID с уникальным префиксом `stg004<runId>`, никаких реальных
пользователей/компаний не использовалось.

| Компания | Роль |
|---|---|
| `stg004…coA` | основная тестовая компания |
| `stg004…coB` | дополнительная/«чужая» тестовая компания |
| `stg004…coC` | изолированная третья компания (для проверки отсутствия доступа) |

| Синтетический пользователь | role @ home | companies[] |
|---|---|---|
| ADMIN_A | admin @ A | — |
| ACCOUNTANT_A | accountant @ A | — |
| VIEWER_A | viewer @ A | — |
| ADMIN_B | admin @ B (home, для cross-tenant негативных тестов) | — |
| MULTI_ADMIN_B | viewer @ A | admin @ B (доп. компания) |
| LIMITED_AT_B | admin @ A | viewer @ B (доп. компания — контроль «роль не переносится») |
| NO_PROFILE | Auth-аккаунт без документа `users/{uid}` | — |

Создание — через Firestore/Identity Toolkit Admin REST API (авторизованная
сессия `firebase-tools`, `cloud-platform` scope) — административный обход
Rules **только для setup**, сами Rules не менялись и не ослаблялись.
Верификация — исключительно через настоящий Firebase Client SDK
(`firebase/app`, `firebase/auth`, `firebase/firestore`, уже используемые
приложением), полностью подчинённый развёрнутым Rules.

### Результаты (22/22 PASS, 0 FAIL)
| # | Сценарий | Ожидание | Результат |
|---|---|---|---|
| 1 | Неавторизованный доступ к `company_data/A` | DENY | ✅ PASS |
| 2 | Пользователь без `users/{uid}` → `company_data/A` | DENY | ✅ PASS |
| 3a–c | self-update `role`/`companyId`/`companies[]` | DENY | ✅ PASS (все три) |
| 4a–b | Межкорпоративное чтение/запись `company_data/A` (от `ADMIN_B`) | DENY | ✅ PASS (оба) |
| 5a | viewer читает свою `company_data/A` | ALLOW | ✅ PASS |
| 5b | viewer пишет в `company_data/A` | DENY | ✅ PASS |
| 6a | accountant — обычная разрешённая запись | ALLOW | ✅ PASS |
| 6b | accountant меняет `closingDate` | DENY | ✅ PASS |
| 7 | admin меняет `closingDate` | ALLOW | ✅ PASS |
| 8 | Query сотрудников своей компании (A) | ALLOW (5 документов) | ✅ PASS |
| 9 | Query сотрудников доп. компании (B) при валидном membership | ALLOW (1 документ) | ✅ PASS |
| 10a–b | «Домашний» admin (viewer @ B) не получает admin-права в B | DENY (оба) | ✅ PASS |
| 10c | Контроль: настоящий admin @ B действительно может писать в B | ALLOW | ✅ PASS |
| 11a | Неограниченный `collection(users)` | DENY | ✅ PASS |
| 11b | Неограниченный query только с `limit()` | DENY | ✅ PASS |
| 11c | Смешанный `in`-query [A, C] | DENY | ✅ PASS |
| 12a | Spoofing `ownerId` при создании новой компании | DENY | ✅ PASS |
| 12b | Spoofing `ownerId` при update `companies/A` | DENY | ✅ PASS |

Полный сырой JSON-результат сохранён локально вне репозитория
(`stg-scenario-results.json`), доступен для независимого ревью по запросу.

### Cleanup
```json
{
  "status": "CLEANUP_COMPLETE",
  "companiesDeleted": 3,
  "companyDataDeleted": 3,
  "userDocsDeleted": 7,
  "authUsersDeleted": 7,
  "errors": [],
  "residue": {
    "companies": [], "company_data": [], "users": [],
    "auth:ADMIN_A": 0, "auth:ACCOUNTANT_A": 0, "auth:VIEWER_A": 0,
    "auth:ADMIN_B": 0, "auth:MULTI_ADMIN_B": 0, "auth:LIMITED_AT_B": 0,
    "auth:NO_PROFILE": 0
  }
}
```
Независимая повторная проверка (отдельный `runQuery`/`accounts:lookup`
запрос после удаления, не просто доверие коду удаления) подтвердила
**нулевой остаток** — ни один документ с префиксом `stg004<runId>` не
найден ни в одной из трёх коллекций, ни один из 7 Auth-аккаунтов не
резолвится через `accounts:lookup`.

## Security review
- Rules на staging **не ослаблялись** ни на каком этапе — все 22
  верификационных запроса выполнены обычным Client SDK без admin-обхода.
  Admin-доступ использовался исключительно для setup/cleanup синтетических
  фикстур (стандартная практика, аналог `withSecurityRulesDisabled()` в
  emulator-тестах, но на реальном staging через легитимный IAM-канал).
- Ни один секрет, токен или Firebase-конфигурация (web API key и т.п.) не
  выводились в терминал ни на каком шаге — сверено вручную по каждому
  вызову.
- Production (`finapp-prod-10a83`) затронут только одним read-only GET
  запросом Rules Management API — ни `firebase deploy`, ни любые записи не
  выполнялись.

## Данные и миграция
Нет. Единственная запись за пределы репозитория — публикация нового
Firestore ruleset на `finapp-staging` (не данные, разрешения доступа) и
временные синтетические тестовые сущности, полностью удалённые с
подтверждённым нулевым остатком. Production данные не читались, не
изменялись, не удалялись.

## Ручная проверка
Не требуется дополнительно — все 12 категорий сценариев проверены реальным
Client SDK против реального staging-окружения (не эмулятор, не мок).

## Rollback (staging)
Если потребуется откатить: опубликовать сохранённый исходник deny-all
заглушки (`sha256=ecf30f9...84eb`, сохранён вне репозитория) как новый
активный release через тот же авторизованный канал (`firebase deploy
--only firestore:rules --project finapp-staging` с временно восстановленным
локальным `firestore.rules` = сохранённой заглушке, либо напрямую через
Rules Management API `createRuleset`+`updateOrCreateRelease`). Данные
`finapp-staging` не затрагиваются откатом Rules — откат меняет только
разрешения доступа.

## Известные ограничения
1. `npm run build:staging` не пройден в этой сессии — отсутствует
   `.env.staging`/`.env.staging.local` с реальным staging Firebase Web
   config, который является owner-secret и не должен создаваться/угадываться
   агентом (нарушило бы `CLAUDE.md §6.8` и собственный fingerprint-guard
   скрипта). Это ограничение окружения, не дефект кода — тот же самый
   код успешно прошёл `tsc -b`/`build` (обычный, non-staging режим) и все
   Rules/unit-тесты. Hosting/client-bundle deploy в этой задаче не
   выполнялся и не входит в её разрешённый scope, поэтому это не мешает
   основной цели (Rules deploy + verification на staging).
2. `gcloud` CLI неработоспособен в этой среде (падает с ошибкой Python-
   рантайма) — read-only доступ к Rules Management API и вся
   Admin/Client-SDK работа выполнены через уже авторизованную сессию
   `firebase-tools` напрямую, без gcloud.
3. Известные breaking changes из `BASE-004A` (регистрация нового
   аккаунта/компании, приглашение сотрудника, смена роли участника другим
   пользователем, создание доп. компании через self-update) — не менялись
   и не проверялись в этой задаче; остаются в силе до реализации Cloud
   Functions (см. `BASE-004A_EMERGENCY_RULES_PLAN.md`, раздел 5).

## Дополнительные находки вне scope
Нет новых, помимо уже зафиксированных в отчётах `BASE-004A`.

## Подтверждение отсутствия production write-действий
- `firebase deploy` к `finapp-prod-10a83` — не вызывался ни разу.
- Production Firestore Rules, данные, Auth, IAM — не изменялись; выполнен
  ровно один read-only GET запрос к Rules Management API.
- Hosting, Functions, indexes deploy — не выполнялись нигде (ни staging,
  ни production).
- Зависимости не обновлялись, `npm audit` не запускался и не исправлялся.
- `main`, исходная remediation-ветка (`remediation/BASE-004A-rules-emergency-fix`)
  — не изменялись и не сливались.
- `REMEDIATION_PLAN.md` — чекбоксы `BASE-004`/`BASE-005` не менялись, оба
  остаются `[ ]`.

## Diff summary
```text
docs/remediation/reports/BASE-004-PREPROD-STAGING.md | новый файл (этот отчёт)
```

## Следующий разрешённый пункт
Не определяется и не анализируется в рамках этой задачи. Следующий шаг —
отдельный независимый аудит именно этого раунда
(`BASE-004-PREPROD-STAGING-01`), НЕ `BASE-005` и НЕ production deployment.
