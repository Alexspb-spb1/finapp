# BASE-004A — Emergency Firestore Rules remediation (local preparation only)

## Итоговый статус (актуальный)
**`BASE_004A_FIX2_READY_FOR_REVIEW`** — см. «Часть 2» (текущий раунд,
`TASK_ID: BASE-004A-FIX-02`) ниже. «Часть 1» оставлена без изменений, для
истории предыдущего раунда (`BASE_004A_REVIEW_FAILED`).

**Требуется НОВЫЙ независимый аудит.** Предыдущее ревью завершилось
`BASE_004A_REVIEW_FAILED`. Изменения текущего раунда (Часть 2) не были
проверены независимо и не могут считаться окончательным исправлением до
отдельного `REVIEW_RESULT: PASS`.

`REMEDIATION_PLAN.md` не менялся — `BASE-004` остаётся `[ ]`.

---

# Часть 2 — BASE-004A-FIX-02 (текущий раунд)

```text
TASK_ID: BASE-004A-FIX-02
```

## Итоговый статус
READY_FOR_REVIEW (`BASE_004A_FIX2_READY_FOR_REVIEW`)

## Branch / commit
- branch: `remediation/BASE-004A-rules-emergency-fix`
- base SHA (ожидаемый HEAD удалённой ветки перед этим раундом): `bfa23b6cb41f2fc212ad53ead1f7d3caadcb0246`
- result SHA: см. финальный ответ в чате после коммита и push

## Проверенное исходное состояние
- Preflight подтвердил: рабочее дерево было чистым, ветка —
  `remediation/BASE-004A-rules-emergency-fix`, локальный HEAD после
  `git fetch` + fast-forward совпал с `origin` и равен ожидаемому
  `bfa23b6cb41f2fc212ad53ead1f7d3caadcb0246`.
- Прочитан код (read-only, без изменений): `firestore.rules`,
  `tests/rules/firestore.rules.test.ts`, `src/store/authStore.ts`
  (`onAuthStateChanged`, `switchCompany()`), `src/types/auth.ts`
  (`companyId`/`role`/`companies[]`), `BASE-004A_EMERGENCY_RULES_PLAN.md`,
  предыдущий отчёт — самостоятельно перепроверено, не принято на веру.
- Дефект подтверждён как реально существующий (не гипотетический): в
  `firestore.rules` на момент `bfa23b6` `allow list` для `users/{userId}`
  сравнивал `resource.data.companyId` только с
  `callerProfile().companyId` (основной компанией вызывающего) —
  `companies[]` (дополнительные компании) не участвовали в проверке
  `list` вообще, хотя уже участвовали в `get`/`companies`/`company_data`.
- **Baseline-воспроизведение выполнено ДО правки Rules** (см. «Фактический
  вывод» ниже): регрессионный тест добавлен в тестовый файл первым, прогнан
  против ещё неисправленных Rules — 7 тестов, завязанных на чтение
  дополнительной компании, воспроизводимо падают с `permission-denied`; все
  остальные 70 (включая полный набор из 55 ранее существовавших) уже
  проходят на том же коммите — подтверждает точную локализацию дефекта.

## Что изменено
- `firestore.rules` — единственное изменение: `allow list` для
  `users/{userId}` заменён с сравнения по ЕДИНСТВЕННОЙ (основной) компании
  на `isMemberOf(resource.data.companyId)` — ту же роль-функцию, что уже
  безопасно используется для `companies`/`company_data` (проверяет
  основную И дополнительные компании по точной паре `{companyId, role}`,
  ограничена ≤10 memberships, fail-closed при некорректных данных). Никакие
  другие правила (`get`/`create`/`update`/`delete` для `users`, любые
  правила `companies`/`company_data`) не менялись.
- `tests/rules/firestore.rules.test.ts` — добавлен блок
  `BASE-004A-FIX-02` (22 новых `it()`, включая 1 baseline-тест защиты
  от регрессии) + добавлена фикстура `COMPANY_C`/`ADMIN_C` для проверки
  «доступ к дополнительной компании ≠ доступ к третьей, несвязанной». Ни
  один из 55 существующих тестов не изменён и не удалён.
- `docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md` — исправлено
  прежнее неверное утверждение (`list` для `users` работает только через
  основную компанию — это и было дефектом, не описанием финального
  поведения); добавлен раздел §6a с первопричиной, baseline и точным
  diff-исправлением; обновлены счётчики тестов (55→77) и чеклист (добавлен
  пункт про новый независимый аудит).
- `docs/remediation/reports/BASE-004A.md` — этот отчёт (текущая «Часть 2»
  дополняет, не заменяет «Часть 1»).

Не менялись: `package.json`, `package-lock.json` (новые зависимости не
потребовались), любой файл `src/**`, Firebase-конфигурация, индексы,
Cloud Functions, любая другая ветка.

## Почему изменения входят в текущий пункт
Единственная строка изменения в `firestore.rules` — прямое и минимальное
следствие подтверждённого дефекта `BASE-004A-FIX-02`: без нее реальный
app-flow (вход с ранее выбранной доп. компанией, `switchCompany()`,
загрузка списка сотрудников выбранной компании) получает
`permission-denied`. Новые тесты — прямое требование задания (позитивные и
негативные сценарии для доп. компании). Документация обновлена, т.к. само
задание явно требует исправить прежнее неверное утверждение.

## Затронутые файлы
```text
 M firestore.rules
 M tests/rules/firestore.rules.test.ts
 M docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md
 M docs/remediation/reports/BASE-004A.md
```
Подтверждено: `git diff --stat -- src/` — пусто, изменений `src/**` нет.
`package.json`/`package-lock.json` не изменялись — новые зависимости не
требовались для этого исправления.

## Критерии приемки
- [x] Дефект воспроизведён регрессионным тестом ДО правки Rules (baseline)
- [x] Query сотрудников дополнительной компании разрешён при валидном membership
- [x] Роль для дополнительной компании определяется отдельно, не наследуется от основной
- [x] `companies[]` — bounded ≤10, fail-closed при null/неизвестной роли/неверном типе/отсутствующем `companyId`
- [x] Межкорпоративное чтение (компания вне `isMemberOf`) остаётся запрещено — доказано через `resource.data` для каждого потенциального документа, а не постфактум-фильтром
- [x] Ни один из 55 существующих тестов не изменён/не ослаблен
- [x] `src/**` не затронут
- [x] Emulator Suite реально запущен — 77/77 PASS, 0 failed, 0 skipped (дважды подряд, для стабильности)
- [x] Production deploy НЕ выполнялся

## Проверки
| Команда | Результат | Примечание |
|---|---|---|
| `npm ci` | PASS | 929 packages, без изменений `package-lock.json` (новые зависимости не требовались) |
| `npm run test:rules` (Firestore Emulator, Java 21) | **PASS — 77/77, 0 failed, 0 skipped** | Прогнано дважды подряд для стабильности — оба раза 77/77. См. baseline (7 failed на старых Rules) и финальный вывод ниже |
| `npm run lint` | PASS | 0 ошибок, 0 предупреждений |
| `npx tsc -b` (приложение) | PASS | `src/**` не менялся |
| `npx tsc --noEmit -p tests/rules/tsconfig.json` | PASS | Новый тестовый блок типизирован корректно |
| `npm run build` | PASS | Без изменений в `src/**`; существовавшее предупреждение о размере чанка (>500kB) не связано с этой задачей |
| `git diff --check` | PASS | Без предупреждений о конфликтных маркерах/пробелах |
| синтаксис Rules | PASS | Подтверждён успешной загрузкой в Firestore Emulator (`initializeTestEnvironment`) на каждом из трёх прогонов |
| secret scan | PASS | Паттерны API-ключей/паролей/private key — не найдены в изменённых файлах |
| PII scan | PASS | Реальные email/телефоны — не найдены |
| financial-data scan | PASS | Номера карт/ИНН — не найдены |
| Firebase identifier scan | PASS | Найден только уже существовавший синтетический `demo-finapp-rules-test` |
| absolute-path scan | PASS | Абсолютных локальных путей в изменённых файлах нет |
| `git diff --stat -- src` | PASS | Пусто — `src/**` не затронут |
| `git status --short` | PASS | Ровно 4 ожидаемых изменённых файла |

## Фактический вывод существенных тестов
```text
$ node --version
v24.16.0
$ java -version   (переменные окружения только текущего процесса, portable Temurin 21 из предыдущего раунда)
openjdk version "21.0.12" 2026-07-21 LTS
$ npx firebase --version
15.24.0
$ npm ls @firebase/rules-unit-testing vitest
@firebase/rules-unit-testing@5.0.1
vitest@4.1.10

── BASELINE (до правки firestore.rules, commit bfa23b6) ──────────────────
$ npm run test:rules
 Test Files  1 failed (1)
      Tests  7 failed | 70 passed (77)

FAIL BASELINE (defect reproduction): additional member of B can query
     B's employees — must now ALLOW
FAIL 3. additional admin role can query the additional company employees
FAIL 4. additional accountant role can query the additional company employees
FAIL 5. additional viewer role can query the additional company employees
FAIL 6. a valid membership at the tenth position can still query that company
FAIL 7. query matches the real switchCompany() app flow
FAIL 20. admin of A / viewer of B does not get admin-level access in B
         via query-adjacent write

FirebaseError: evaluation error at L168:22 for 'list' @ L168, false for
'list' @ L264, false for 'list' @ L168, false for 'list' @ L264

── После исправления (allow list: if isMemberOf(resource.data.companyId)) ──
$ npm run test:rules
 Test Files  1 passed (1)
      Tests  77 passed (77)
   Duration  8.60s

── Повторный прогон для стабильности ──────────────────────────────────────
$ npm run test:rules
 Test Files  1 passed (1)
      Tests  77 passed (77)
   Duration  9.12s

$ npm run lint
(без вывода — 0 ошибок)
$ npx tsc -b
(без вывода — 0 ошибок)
$ npm run build
✓ built in 1.46s
$ npx tsc --noEmit -p tests/rules/tsconfig.json
(без вывода — 0 ошибок)
```

## Security review
- Исправление — сужение одной проверки до общей роль-функции
  `isMemberOf`, уже используемой (и уже проверенной 55 тестами) для
  `companies`/`company_data` — не введена новая логика, новый класс
  условий или новое доверие к клиентским данным.
- `list` по-прежнему НЕ является постфактум-фильтром: `isMemberOf(resource.data.companyId)`
  вычисляется для КАЖДОГО потенциального документа результата — документ
  компании вне `isMemberOf` проваливает условие → весь query отклоняется
  целиком. Проверено тестами 8 (чужая компания), 9 (`in`-query со смесью
  разрешённой и чужой компании), 10 (`collection()` без `where`), 11
  (`limit()` без `where`), 12 (`orderBy()` без `where`), 21 (третья,
  несвязанная компания C).
- Роль для дополнительной компании по-прежнему определяется отдельно,
  никогда не наследуется от основной — тест 20 и переиспользованные тесты
  из `existingProfileRoleIn`.
- `companies[]` fail-closed сохранён без изменений: неизвестная роль
  (тест 14), отсутствующий `companyId` (тест 15), `null`-элемент (тест 16),
  неверный тип поля целиком (тест 17), >10 memberships (тест 19).
- Попытки изменить auth-sensitive поля (`role`/`companyId`/`companies`/`id`/`email`)
  и `companies.ownerId` при активной дополнительной membership — по-прежнему
  запрещены (тесты 22, 23) — правки `create`/`update` не затрагивались.
- Ни один тест не был ослаблен, удалён или переписан ради прохождения —
  единственные правки в тестовом файле — новые `it()`.

## Данные и миграция
Нет. Изменение — однострочная правка условия `allow list`; ни один
документ (реальный или тестовый в постоянном хранилище) не создаётся, не
удаляется и не мигрирует. Тесты пишут исключительно в изолированный
Firestore Emulator (`demo-finapp`), очищаемый перед каждым тестом.

## Ручная проверка
Не выполнялась — UI/браузер не запускался, изменения не в `src/**` и не
наблюдаемы в превью (Rules проверяются Emulator Suite).

## Rollback
Локальный: `git diff firestore.rules tests/rules/firestore.rules.test.ts docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md docs/remediation/reports/BASE-004A.md`
показывает точный diff этого раунда; `git checkout bfa23b6 -- firestore.rules tests/rules/firestore.rules.test.ts docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md docs/remediation/reports/BASE-004A.md`
вернёт к состоянию до этого раунда. Production rollback — не применимо
(deploy не выполнялся).

## Известные ограничения
1. Ruleset production повторно не запрашивался в этой сессии (см. «Часть 1»,
   ограничение №1 — не изменилось).
2. Прямой `get` отдельного документа коллеги дополнительной компании (в
   отличие от `list`/query) НЕ был расширен этим раундом — сообщённый
   дефект и реальный app-flow используют `list`/query, а не адресный `get`
   чужого `users/{uid}`. Если такой прямой `get` понадобится приложению в
   будущем, потребуется отдельная, отдельно проверенная правка.
3. Требуется новый независимый аудит именно этого раунда (см. выше).

## Дополнительные находки вне scope
Нет новых, помимо уже зафиксированных в «Части 1».

## Diff summary
```text
 firestore.rules                                     |  15 +++++++++--
 tests/rules/firestore.rules.test.ts                  | 279 +++++++++++++++++++++++++++
 docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md   |  ~130 ++++++++++++-----
 docs/remediation/reports/BASE-004A.md                | переписан (текущая Часть 2 + история в Части 1)
```

## Следующий разрешённый пункт
Не определяется и не анализируется в рамках этого раунда. Следующий шаг —
НОВЫЙ независимый аудит именно `BASE-004A-FIX-02`, НЕ следующий `TASK_ID`
из `REMEDIATION_PLAN.md`. `BASE-004` в `REMEDIATION_PLAN.md` остаётся `[ ]`.

---

# Часть 1 — предыдущий раунд (без изменений, для истории)

## Итоговый статус
READY_FOR_REVIEW_AFTER_CHANGES_REQUIRED

После независимого ревью закрыты два дополнительных дефекта: массовое
межкорпоративное чтение через `allow list` и перенос роли основной компании
на дополнительные memberships. Полный набор расширен до 55
`it()`-проверок. Firestore Emulator Suite реально запущен с portable
Temurin JDK 21 только для текущего процесса — **55/55 PASS, 0 failed,
0 skipped**.

## Branch / commit
- branch: `remediation/BASE-004A-rules-emergency-fix`
- base SHA: `4cae36d602d52ac7397cab8e887f466d9103617b` (= HEAD `remediation/BASE-004-rules-baseline`, подтверждено preflight)
- result SHA: см. финальный ответ в чате после коммита

## Проверенное исходное состояние
- Перепроверен вывод независимого аудита `BASE-004`
  (`docs/remediation/SECURITY_BASELINE.md`, классификация **C**, дата
  2026-07-29) — статический анализ фактически развёрнутых production Rules,
  сравнение с локальной deny-all заглушкой, полная матрица субъект→операция.
- Production ruleset повторно НЕ запрашивался в этой сессии (нет
  авторизованного `firebase` CLI к вашему проекту) — использован уже
  независимо подтверждённый тот же день baseline (см. «Известные
  ограничения»).
- CRITICAL-цепочка эксплуатации из BASE-004 (self-update `companyId`+`role`)
  воспроизведена как security-тест (`21. BASE-004 CRITICAL escalation chain
  is fully blocked`) и подтверждена заблокированной на реальном Firestore
  Emulator, а не только статическим анализом.

## Что изменено
- `firestore.rules` — заменена deny-all emulator-заглушка на содержательные
  deny-by-default Rules, закрывающие CRITICAL/HIGH из BASE-004 (allowlist
  self-editable полей `users/{uid}` через `diff().affectedKeys()`, полный
  запрет клиентского изменения `role`/`companyId`/`companies`/`email`,
  запрет `delete` для `users`, membership-gated `company_data`
  create/update/read, tenant-изоляция `companies`). После независимого
  ревью `allow list` закрыт/ограничен реальным query constraint, а роль
  вычисляется отдельно для каждой компании по точной паре
  `{companyId, role}`. Конфликтующие/неизвестные/повреждённые memberships
  обрабатываются fail-closed.
- `tests/rules/firestore.rules.test.ts` — эмуляторные тесты Firestore
  Rules, 55 проверок: исходная матрица, позитивные app-flow, реальные
  `getDocs(query(...))`, per-company roles и malformed memberships; только
  синтетические данные.
- `tests/rules/tsconfig.json` — изолированный tsconfig для typecheck тестов
  (не участвует в `npm run build`).
- `package.json` / `package-lock.json` — добавлены devDependencies
  `@firebase/rules-unit-testing@^5.0.1`, `vitest@^4.1.10`; добавлен скрипт
  `test:rules` (оборачивает `firebase emulators:exec --only firestore`
  вокруг `vitest run tests/rules`).
- `docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md` — полный план по
  требованиям задания (модель авторизации, breaking changes, deployment
  checklist, rollback, post-deploy проверки, фактические результаты
  Emulator Suite).
- `docs/remediation/reports/BASE-004A.md` — этот отчёт.

`REMEDIATION_PLAN.md` НЕ изменён. `BASE-004` в нём остаётся `[ ]` (это и не
относится к текущему `TASK_ID`).

## Почему изменения входят в текущий пункт
Все изменения — прямое следствие обязательных требований `BASE-004A`:
исправленные Rules (п.1–4 цели задачи), эмуляторные тесты (п.5), план
production deploy/rollback (п.6). Не затронут ни один файл приложения
(`src/**`) — изменения ограничены Rules, тестами Rules и документацией,
согласно CLAUDE.md §4. Portable JDK 21 использовался только для запуска
эмулятора в этой сессии и не входит в diff (вне репозитория, не
коммитится).

## Затронутые файлы
```text
 M firestore.rules
 M package.json
 M package-lock.json
?? tests/rules/firestore.rules.test.ts
?? tests/rules/tsconfig.json
?? docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md
?? docs/remediation/reports/BASE-004A.md
```
Подтверждено: изменений в `src/**` нет (`git diff --stat -- src/` — пусто).

## Критерии приемки
- [x] Подготовлены локально исправленные Firestore Rules
- [x] Закрыто самостоятельное изменение пользователем полей авторизации (`role`/`companyId`/`companies`)
- [x] Закрыт межкорпоративный доступ (`isMemberOf` привязан к пути запроса, не к заявленным полям)
- [x] Ограничено создание/изменение `company_data` (membership + role-gated + allowlist для `closingDate`)
- [x] Написаны автоматические тесты Firestore Rules (21 обязательный сценарий + позитивные)
- [x] Emulator Suite реально запущен, 55/55 тестов PASS, 0 failed, 0 skipped
- [x] Подготовлен production deployment checklist и rollback-план (без выполнения)
- [x] Production deploy НЕ выполнялся

## Проверки
| Команда | Результат | Примечание |
|---|---|---|
| `npm ci` | PASS | Чистая установка 924 packages; без `--force`/`--legacy-peer-deps` |
| `npm run lint` | PASS | 0 ошибок, 0 предупреждений |
| `npx tsc -b` (приложение) | PASS | Тесты (`tests/`) не входят в `tsconfig.app.json`/`tsconfig.node.json` — не влияют на build |
| `npx tsc --noEmit -p tests/rules/tsconfig.json` | PASS | Тестовый файл Rules типизирован корректно отдельным строгим tsconfig |
| `npm run typecheck` | NOT AVAILABLE | Скрипт отсутствует; эквивалентный `npx tsc -b` выполнен отдельно |
| `npm run test:run` | NOT AVAILABLE | Скрипт отсутствует в `package.json` |
| `npm run build` | PASS | Без изменений в `src/**`; существовавшее до задачи предупреждение о размере чанка (>500kB) — не связано с этой задачей |
| `npm run test:rules` (Firestore Emulator, Java 21) | **PASS — 55/55, 0 failed, 0 skipped** | См. полный вывод ниже |
| синтаксис Rules | PASS | Подтверждён самим фактом успешной загрузки правил эмулятором (`initializeTestEnvironment`) |
| `git diff --check` | PASS | Только предупреждение `LF will be replaced by CRLF` (некритично, авто-конвертация Git) |
| `git status --short` | PASS | Ровно ожидаемый список файлов |
| secret scan | PASS | Паттерны API-ключей/паролей/private key — не найдены |
| PII / financial scan | PASS | Реальные email/телефоны/номера карт/ИНН — не найдены |
| Firebase identifier scan | PASS | Найден только синтетический `demo-finapp-rules-test` — не production-идентификатор |
| absolute local path scan | PASS | Абсолютных путей в изменённых файлах нет |
| `npm run test:e2e` | NOT AVAILABLE | Скрипт не существует в проекте (вне рамок текущего пункта) |

## Фактический вывод существенных тестов
```text
$ java -version   (переменные окружения только текущего процесса)
openjdk version "21.0.12" 2026-07-21 LTS
OpenJDK Runtime Environment Temurin-21.0.12+8 (build 21.0.12+8-LTS)

$ npx firebase --version
15.24.0

$ node --version
v24.14.0

$ npm ls @firebase/rules-unit-testing vitest
@firebase/rules-unit-testing@5.0.1
vitest@4.1.10

$ npm run test:rules
> firebase emulators:exec --project demo-finapp --only firestore "vitest run tests/rules"
i  emulators: Starting emulators: firestore
i  emulators: Detected demo project ID "demo-finapp" ...
+  firestore: Firestore Emulator was started in standard edition.
i  Running script: vitest run tests/rules

 RUN  v4.1.10 finapp

 Test Files  1 passed (1)
      Tests  55 passed (55)
   Duration  5.43s

+ Script exited successfully (code 0)
i  emulators: Shutting down emulators.

$ npx tsc --noEmit -p tests/rules/tsconfig.json
(без вывода — 0 ошибок)

$ npm run lint
(без вывода — 0 ошибок)

$ npm run build
✓ built in 1.59s
```

Промежуточный (уже исправленный) вывод первого прогона — для полноты
доказательной базы, что тесты реально исполнялись, а не были подогнаны:

```text
Первый прогон: ошибка компиляции Rules
  L65:35 Unexpected '='.  →  причина: .filter(m => ...) не поддерживается
  Firestore Rules (CEL-подмножество не имеет лямбд/filter/map).

Второй прогон (после фикса filter → bounded index): 38 passed, 1 failed
  FAIL: "9. self-create with privileged fields is blocked >
         can create own profile without auth-sensitive fields"
  Причина: `id` требовался в create-правиле И одновременно был в списке
  запрещённых authSensitiveFields → любой create отклонялся, даже без
  auth-полей. Исправлено удалением `id` из запрещённого списка (id и так
  жёстко привязан к uid отдельной проверкой, подделать невозможно).

Третий исторический прогон: 39 passed, 0 failed, 0 skipped.

Независимый review затем воспроизвёл два незакрытых дефекта: реальные
collection query для всех трёх коллекций и перенос `admin` основной
компании на дополнительную membership. Расширенный baseline на старых
Rules: 42 passed / 13 failed. После corrective patch: 55 passed,
0 failed, 0 skipped.
```

## Security review
- Deny-by-default: последний match-блок `{document=**}` — явный
  `allow read, write: if false` для всех необозначенных путей.
- Fail-closed при отсутствии `users/{uid}`: `callerHasProfile()` требует
  `exists()`; все производные функции (`isMemberOf`, `isAdminOf`) от него
  зависят — отсутствующий/удалённый профиль не может повысить права
  (CLAUDE.md §6.2). Подтверждено тестом «2. authenticated but no
  users/{uid} profile».
- UI-проверки роли (`authStore.canWrite()`/`isAdmin()`) не учитывались как
  защита — все ограничения продублированы на уровне Rules и подтверждены
  эмулятором, а не только чтением кода.
- Privileged-поля (`role`/`companyId`/`companies`) проверяются исключительно
  через `diff().affectedKeys()` на **до сих пор существующем** документе —
  не через заявленные клиентом значения. Подтверждено тестами 6–10, 21.
- `allow list` больше не разрешён просто по факту наличия профиля:
  `users` query должен быть ограничен основной компанией вызывающего,
  `companies` и `company_data` list запрещены. Это подтверждено настоящими
  `getDocs(query(...))`, а не одиночными `getDoc`.
- Для дополнительных компаний роль берётся из точной пары
  `{companyId, role}`, а не из основной `user.role`. Конфликтующие роли,
  неизвестная/отсутствующая роль, `null` и список длиннее 10 элементов
  fail-closed; валидная десятая membership проверена позитивным тестом.
- Оба исправления, найденные эмулятором (см. выше), сделаны исключительно
  в сторону строгости/корректности Rules — ни в одном месте security-модель
  не ослаблена ради зелёного теста; тестовые ожидания не менялись.
- Не придуманы несуществующие Cloud Functions/custom claims как уже
  работающая защита — отсутствие серверного пути членства явно
  задокументировано как архитектурный долг
  (`BASE-004A_EMERGENCY_RULES_PLAN.md`, раздел 4).

## Данные и миграция
Нет. Эта задача не пишет, не удаляет и не мигрирует ни одного production
документа — только меняет Rules (разрешения доступа) и локально
подготавливает тесты, которые пишут исключительно в **эмулятор**
(`demo-finapp`, изолированный, очищается перед каждым тестом
`clearFirestore()`). Dry-run/idempotency/checksums/rollback — неприменимо к
самим данным; rollback-план для Rules — раздел 10
`BASE-004A_EMERGENCY_RULES_PLAN.md`.

## Ручная проверка
UI/браузер не запускался — задача ограничена Rules/тестами/документацией,
изменения не затрагивают `src/**` и не наблюдаемы в превью-браузере (Rules
проверяются Firestore Emulator, что и было сделано).

## Rollback
Локальный: `git checkout -- firestore.rules package.json package-lock.json`
и удаление `tests/rules/`, `docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md`
вернут рабочее дерево к состоянию `remediation/BASE-004-rules-baseline`.
Production rollback — не применимо (deploy не выполнялся); план для
БУДУЩЕГО production deploy — раздел 10 `BASE-004A_EMERGENCY_RULES_PLAN.md`.

## Известные ограничения
1. Ruleset production **не запрашивался повторно** через Rules Management
   API в этой сессии (нет настроенного авторизованного `firebase` CLI к
   вашему проекту) — использован уже независимо подтверждённый тот же день
   baseline из `SECURITY_BASELINE.md`. Если владелец подозревает, что
   ruleset мог измениться между проверкой BASE-004 и этим коммитом,
   требуется отдельная read-only проверка перед любым production-действием
   (см. чеклист, раздел 9.1 плана).
2. Полный список breaking changes (план, раздел 5) построен статическим
   чтением `src/store/authStore.ts`, не подтверждён живым прогоном
   приложения в браузере.
3. `companies[]` ограничен 10 элементами. Проверка использует точные
   `{companyId, role}`, без индексного перебора; список длиннее лимита
   обрабатывается fail-closed.

## Дополнительные находки вне scope
- `src/store/authStore.ts` содержит несколько мест, где Firestore-запись
  выполняется без реального ожидания критического успеха (например,
  `register()` создаёт Firebase Auth аккаунт, затем best-effort пишет
  Firestore-документы — при частичном сбое приложение полагается на
  localStorage-fallback). Это не новая уязвимость этой задачи, но теперь,
  после `BASE-004A`, эти же пути дополнительно будут стабильно получать
  `permission-denied` при попытке self-set `role`/`companyId` — стоит
  рассмотреть отдельным пунктом плана (не исправлено здесь, согласно
  CLAUDE.md §4 — «соседние проблемы запиши, но не исправляй в текущем PR»).

## Diff summary
```text
 firestore.rules   | заменена deny-all заглушка на содержательные Rules (~180 строк)
 package.json      | +2 devDependencies, +1 npm script
 package-lock.json | автоматическое обновление lockfile
 tests/rules/firestore.rules.test.ts | новый файл (55 проверок)
 tests/rules/tsconfig.json           | новый файл
 docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md | новый файл
 docs/remediation/reports/BASE-004A.md               | новый файл (этот отчёт)
```

## Следующий разрешённый пункт
Не определяется и не анализируется в рамках этой задачи. Следующий шаг —
независимое ревью текущего `BASE-004A`, НЕ следующий `TASK_ID` из
`REMEDIATION_PLAN.md`.
