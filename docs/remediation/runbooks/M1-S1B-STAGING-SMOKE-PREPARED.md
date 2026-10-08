# M1 S1b — smoke-only пакет для staging на уже действующих Rules R3 (PREPARED_NOT_AUTHORIZED)

Задача: `M1-STAGING-R3-SMOKE-PREP-02`. Документ **ничего не выполняет и не даёт допуска**. Выбор варианта S1b — выбор локальной архитектуры пакета, а не допуск на запуск staging.
Любое будущее внешнее действие требует: (1) нового разрешённого read-only чтения состояния, (2) независимого ревью этого пакета аудитором, (3) отдельного решения владельца на **эти** байты,
target, namespace и перечисленные ниже операции.

## 1. Датированный baseline (аудит 2026-10-07; не текущие чтения)

| Факт | Значение на 2026-10-07 |
|---|---|
| Проект | `finapp-staging` |
| Rules | SHA-256 `c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd` (round 3) — выкачены прошлым run `r3-ab9fb2fe` |
| Cloud Functions | 13 функций ACTIVE (5 M1 + `createCompany` + `authzProbe` + 6 invitation) |
| Frontend | `https://stage.aktivmetr.ru/` — 15 файлов совпали с артефактом `714d0f91` (проверка аудитора) |
| Прошлый run | `r3-ab9fb2fe` остановился на `seed`: `transport: network failure POST accounts`; исход того запроса неизвестен; первопричина сетевого сбоя **не установлена** |

Исправление классификации transport/recovery (M1-SAFE-STOP-RECOVERY-01) **не устранило** сетевую причину и не доказывает, что то обращение не обрабатывалось. До любого live-исполнения нужна новая
разрешённая сверка состояния; значения таблицы нельзя использовать как «текущие».

## 2. Что в пакете и чего в нём нет

Пакет `m1-s1b-staging-v2` (локальный namespace, immutable; заменяет `m1-s1b-staging` после Corrections V1 — прежний кандидат сохранён без изменений и **не** должен использоваться; исходники и patch к принятому R4 — `docs/remediation/evidence/M1-STAGING-R3-SMOKE-PREP-02/`):

| Есть | Нет (удалено из принятого R4-пакета) |
|---|---|
| `m1-s1b.mjs` (plan / selftest / rehearse / execute / permit-draft), `m1-s1b-flow.mjs`, `m1-s1b-pins.mjs`, `m1-s1b-permit.mjs`, `operation-budget.json` | PowerShell-оркестратор и его guard «Rules = round 2» (не отключался: просто не входит в пакет) |
| smoke-инструменты принятой реализации: `m1-smoke.mjs`, UI-smoke, readiness, state-check, run-inspect, ci-check, functions-check (байт-в-байт как в R4) | Firestore export, `firebase deploy` обёртка, подготовка и выкатка отката Rules, deploy/rollback ветки |
| `m1-core.mjs` (+ id прошлого run в consumed), `m1-transport.mjs` (credential bootstrap, бюджет) — единственные изменённые файлы | Production-пакет v6 (не менялся и не запускается), любые production-цели |
| fence (`offline-fence/`), 85 негативных контролей и 29 мутаций | Retry, replay, автоматическое восстановление после неизвестного исхода |

## 3. Последовательность и таблица будущих операций

Порядок: readiness → preflight (R3) → seed → ui → api → ui-r3 → cleanup → verify-clean. Каждый smoke-режим выполняется **один раз**; провалившийся режим завершает последовательность.

| Шаг | Что делает | Живые операции (все — только после допуска) | Класс допуска (`permit.operations`) | Бюджет |
|---|---|---|---|---|
| 0 | локальные gates: HEAD/чистота репозитория приложения, хэши пакета, манифест staging-сборки, marker web config, Functions не менялись, закреплённый файл Rules, версия Node | **1 чтение GitHub**: `gh run view 36830077757` (CI ревьюенного HEAD) | `githubCiRead` | 1 вызов |
| 1 | read-only точное состояние: 13 Functions по pins; live Rules **равны R3** (round 2 / неизвестные Rules / расхождение байтов → STOP до любой мутации) | Cloud Functions API (list, GET, ≤10 страниц), Rules API (чтение релиза и ruleset) операторскими credentials | `stagingStateReads` | read-only; свои лимиты инструментов |
| 2 | readiness пяти M1 callable (ответ из слоя приложения) | неаутентифицированные POST: ≤5 за раунд, ≤61 раунда (300 с / 5 с), типично 5 | `readinessProbes` | лимиты инструмента: ≤305 |
| 3 | smoke preflight: maintenance off, fixture e-mail отсутствуют; приватный каталог с ACL | 2 операторских запроса (Firestore GET + `accounts:lookup`) | `stagingStateReads` | ≤5 |
| 4a | seed | **3 Auth create** (`accounts`), 3 sign-in, 2 `createCompany`, 1 commit, readback | `authCreate`, `firestoreAndCallables` | ≤19 запросов, ≤3 create, ≤1 commit |
| 4b | ui | реальный Chromium к локально отдаваемому dist; ≤5 операторских чтений; браузерные запросы под allowlist route policy | `firestoreAndCallables` | ≤12 операторских |
| 4c | api | callable M1 (роль/отключение/восстановление/удаление/roster), Rules-пробы R1–R7 клиентскими токенами | `firestoreAndCallables` | ≤109, 0 commits |
| 4d | ui-r3 | браузерный сценарий lost-company/no-access; операторских запросов нет | `firestoreAndCallables` | 0 |
| 5 | cleanup (G1–G5, **точный lookup G4**) и verify-clean; inventory — **только** после проверенного остатка (assertion `verify-clean.*` в журнале этого вызова), один раз | Firestore GET/list/runQuery, `accounts:lookup`; удаление ≤25 документов (1 commit) и ≤3 Auth users | `cleanup` **и** `cleanupExactLookup` (только вместе) | cleanup ≤82 (≤3 delete, ≤1 commit); verify-clean ≤29; inventory ≤29 |
| 6 | финальные read-only: те же Functions и Rules R3 | как шаг 1 | `stagingStateReads` | read-only |

`cleanupAfterProvenNonDispatch` (по умолчанию выключен) — отдельное явное разрешение на cleanup после **доказанного** pre-dispatch сбоя; без него любой STOP после seed требует ручного решения.
Бюджет задан в `operation-budget.json`: cap = ceil(наблюдённое на эмуляторе × 1.25) + 2; транспорт останавливает запрос **до отправки** при превышении (`kind budget`). Жёсткие потолки: 3 Auth users создать, 3 удалить.

## 4. Клиентский smoke отдельно от admin-чтений

Операторские (admin/IAM) чтения Firestore и Auth — preflight, state checks, cleanup lookups — **обходят Rules** и ничего не доказывают о доступе клиента: доступность документа через admin-путь не является доказательством
клиентского доступа. Клиентский доступ проверяют только: `ui` (реальный браузер, вход синтетического пользователя, смена роли через UI), `api` (callable и Rules-пробы с ID-токенами пользователей — отказ/разрешение определяет Rules)
и `ui-r3` (вход при потерянной компании, экран «Нет доступа к компании»). Флаги `clientAccess.uiPass/apiPass/uiR3Pass` в результате выставляются **только** этими режимами; `adminReadsAreClientAccess` всегда `false`.
Проверка frontend на `https://stage.aktivmetr.ru/` (публичный HTTPS) в пакет не входит: staging-сборка проверяется по манифесту `dist-staging-manifest.txt`; публичный адрес — отдельное read-only чтение, если владелец его пожелает.

## 5. Предусловия перед любым live-исполнением (по порядку)

1. Независимый PASS аудитора на этот пакет (hash `CODE-SHA256SUMS.txt` из блока 9).
2. Новая **разрешённая** read-only сверка: Functions (13), Rules (= R3), отсутствие остатков синтетики; её время и ссылка заносятся в permit (`reconciliation`, не старше 24 ч на момент решения).
3. Решение владельца (блок 8) → файл permit; `node m1-s1b-offline.mjs permit-draft` печатает черновик с хэшами этого пакета (черновик **не** является допуском).
4. Окружение: Node v24.16.x, чистая рабочая копия `m1-release-714d0f91` на `714d0f91`, `firebase login` владельца (operator credentials берутся из CLI), `gh` на PATH, Playwright и Chromium, staging-сборка `m1-dist-staging-714d0f91`
   (манифест сверяется), explicit web config (`.env.staging.local`); в окружении нет `NODE_OPTIONS`, `*EMULATOR*`, `FIREBASE_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, `M1_STUB_*`.
5. Namespace свободен: `m1-stg-s1b-714d0f91` и `m1-staging-run-714d0f91-s1b` не существуют (иначе INIT_REFUSED; повторный запуск запрещён).
6. Сетевая среда зафиксирована владельцем (VPN включён/выключен). Это **не** условие безопасности и не гарантия: причина прошлого сбоя не установлена.

## 6. Точные команды

Офлайн (разрешены сейчас; изолированное окружение + loopback-only fence, без credentials, без сети):

```bash
node m1-s1b-offline.mjs selftest
node m1-s1b-offline.mjs plan
node m1-s1b-offline.mjs permit-draft
```

Будущее staging-исполнение (**не выполнять без допуска**; единственный запуск, без повторов):

```bash
node m1-s1b.mjs execute --permit <abs permit.json> --web-config <abs .env.staging.local>
```

Код выхода: 0 — PASS, 2 — SAFE_STOP, 3 — INIT_REFUSED (ничего не выполнялось). Evidence: `D:\projects\finapp\.runtime\m1-stg-s1b-714d0f91\` (`s1b-journal.jsonl`, `s1b-state.json`, `s1b-result.json`), run-каталог — `m1-staging-run-714d0f91-s1b`.

## 7. SAFE_STOP: что происходит и что нет

| Событие | Автоматически | Не делается |
|---|---|---|
| любой отказ шагов 0–3 (pins, Rules ≠ R3, Functions, readiness, preflight) | STOP до мутации | seed, cleanup |
| неизвестный сетевой исход (`transport`, dispatch `unknown`), `unexpected`, `integrity`, `credentials`, `budget`, повреждённый журнал | STOP | **cleanup, inventory, retry, replay** — нужна отдельная классификация и решение |
| `assertion` / `ui-flow` | cleanup через gates G1–G5 с **привязанным** Rules-evidence (тот же файл, что в шаге 1, побайтно), если разрешено `cleanup`+`cleanupExactLookup`; затем STOP | второй запуск режима |
| провал Rules-пробы (`R1…R9`) | STOP | cleanup (отката Rules в S1b нет; решение за владельцем) |
| доказанный pre-dispatch сбой | cleanup только при `cleanupAfterProvenNonDispatch=true` | иначе ручное решение |
| **любой ненулевой cleanup / verify-clean** | исход читается из MODE_STOP **этого вызова** (события после baseline, привязка к коду выхода); при не проверенном/неоднозначном исходе — STOP `CLEANUP_UNSAFE_STOP` / `VERIFY_CLEAN_UNSAFE_STOP`, нужна ручная классификация | **inventory, verify-clean, любые чтения провайдера, retry, replay** — при неизвестном сетевом исходе (в т.ч. cleanup exit 4), credentials / budget / integrity / unexpected / guard, отсутствующем, устаревшем, повреждённом или неоднозначном журнале, несовпадении кода выхода |
| проверенный отказ gates cleanup (exit 3, без удалений, recovery manifest) | STOP `CLEANUP_REFUSED` | inventory, verify-clean |
| проверенный остаток (assertion `verify-clean.documents-absent` / `auth-absent` после удалений) | **один** read-only `inventory` (класс `cleanupExactLookup`), затем STOP | повтор cleanup / verify-clean |
| повторный или параллельный запуск того же evidence namespace | атомарный exclusive mkdir + claim marker `s1b-claim.json` до первого journal/tool; проигравший — INIT_REFUSED, 0 инструментов | запись в чужие evidence, повторное использование каталога (частично занятый namespace считается consumed) |
| ошибка получения operator credentials | STOP, фиксированный reason `operator credential bootstrap failed` + код из закрытого набора | текст/стек ошибки, токены |

## 8. Решение владельца (шаблон — заполняется владельцем; этот документ ничего не разрешает)

```text
Пакет:          m1-s1b-staging-v2, CODE-SHA256SUMS.txt sha256 = <из блока 9>
Target:         finapp-staging (production исключён); head 714d0f91c60a582ee87dc7da82d6249b3106329f; Rules R3 c4fe4c09…19fd
Namespace:      m1-stg-s1b-714d0f91 / m1-staging-run-714d0f91-s1b
Сверка состояния (новая, разрешённая): время UTC ____ ; ссылка ____ (не старше 24 ч)
Разрешаю классы операций (отметить только нужные):
  [ ] githubCiRead  [ ] stagingStateReads  [ ] readinessProbes  [ ] authCreate  [ ] firestoreAndCallables
  [ ] cleanup + cleanupExactLookup (только вместе)   [ ] cleanupAfterProvenNonDispatch
Бюджет:         operation-budget.json sha256 = <из блока 9>
Срок действия:  с ____ до ____ UTC (не более 24 ч)
Сеть:           VPN вкл / выкл (информационно)
При SAFE_STOP:  никаких автоматических повторов; новый допуск на каждое следующее внешнее действие
```

## 9. Хэши immutable-кандидата

| Файл | SHA-256 |
|---|---|
| `CODE-SHA256SUMS.txt` (кандидат `m1-s1b-staging-v2`) | `3ad94b6ba32d4a3905b898263c543ea211c29666e5e7ab8bd2d844324dd63b81` |
| `CODE-SHA256SUMS.txt` прежнего кандидата `m1-s1b-staging` (заменён, не использовать) | `700ba158ba017ea6783ab1e7919d6812a692e513d596d6135b6d8b45fc40ef8a` |
| `operation-budget.json` | `256692200a35e5ee8505ff8afd93f485f81a84752d5fc4ed2d7bd0f563135ebb` |
| `expected-state-r3.json` | `83f259870bfc121bf6dbff6f56eb5f1a54dce93e0b3839c01f1987870a561de7` |
| `dist-staging-manifest.txt` | `a24e3706004ad3214d6c7e7dfdc58f9240d468f7bd093749ae71398579911410` |

## 10. Остаточные ограничения

- Live-поведение не проверялось: tools против live staging (stagingResources, functions-check, readiness, gh, Firebase CLI credentials) в этом блоке не запускались; их вызовы в rehearsal заменены no-network заглушками.
- Первопричина прошлого сетевого сбоя не установлена; новый запуск может остановиться так же — тогда действует таблица раздела 7.
- Fence охватывает Node; JVM эмуляторов только наблюдался, Chromium (UI) вне fence (его страницы под route policy); подробности — отчёт.
