# BASE-004A — Emergency Firestore Rules remediation (local preparation only)

## Итоговый статус
READY_FOR_REVIEW

Rules, полный набор тестов (39 `it()`-проверок, покрывающих все 21
обязательный сценарий + 4 позитивных app-flow сценария) и документация
подготовлены. Firestore Emulator Suite реально запущен (после установки
portable JDK 21 строго для этой сессии) — **39/39 PASS, 0 failed, 0
skipped**. Все остальные проверки — зелёные.

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
  create/update/read, tenant-изоляция `companies`). В процессе прогона
  эмулятора исправлены 2 реальные ошибки в самих Rules (не в тестах,
  security-модель не ослаблена) — см. «Известные ограничения /
  исправления» ниже и раздел 6 плана.
- `tests/rules/firestore.rules.test.ts` — эмуляторные тесты Firestore
  Rules, 39 проверок (21 обязательный сценарий + 4 позитивных app-flow),
  только синтетические данные.
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
- [x] Emulator Suite реально запущен, 39/39 тестов PASS, 0 failed, 0 skipped
- [x] Подготовлен production deployment checklist и rollback-план (без выполнения)
- [x] Production deploy НЕ выполнялся

## Проверки
| Команда | Результат | Примечание |
|---|---|---|
| `npm ci` / `npm install` | PASS | `@firebase/rules-unit-testing@^4.0.1` конфликтовал по peer dep с `firebase@^12`; обновлено до `^5.0.1` (peer `firebase@^12.0.0`) — конфликт снят без `--force`/`--legacy-peer-deps` |
| `npm run lint` | PASS | 0 ошибок, 0 предупреждений |
| `npx tsc -b` (приложение) | PASS | Тесты (`tests/`) не входят в `tsconfig.app.json`/`tsconfig.node.json` — не влияют на build |
| `npx tsc --noEmit -p tests/rules/tsconfig.json` | PASS | Тестовый файл Rules типизирован корректно отдельным строгим tsconfig |
| `npm run build` | PASS | Без изменений в `src/**`; существовавшее до задачи предупреждение о размере чанка (>500kB) — не связано с этой задачей |
| `npm run test:rules` (Firestore Emulator, Java 21) | **PASS — 39/39, 0 failed, 0 skipped** | См. полный вывод ниже |
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
v24.16.0

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
      Tests  39 passed (39)
   Duration  7.73s

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

Третий прогон: 39 passed, 0 failed, 0 skipped — финальный результат.
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
3. `companies[]` membership проверяется bounded-перебором до 10 элементов
   (Firestore Rules не поддерживает произвольные циклы/лямбды) —
   практический предел, не ожидается проблемой для текущего UI, но
   зафиксирован явно в коде и здесь.

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
 tests/rules/firestore.rules.test.ts | новый файл (39 проверок)
 tests/rules/tsconfig.json           | новый файл
 docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md | новый файл
 docs/remediation/reports/BASE-004A.md               | новый файл (этот отчёт)
```

## Следующий разрешённый пункт
Не определяется и не анализируется в рамках этой задачи. Следующий шаг —
независимое ревью текущего `BASE-004A`, НЕ следующий `TASK_ID` из
`REMEDIATION_PLAN.md`.
