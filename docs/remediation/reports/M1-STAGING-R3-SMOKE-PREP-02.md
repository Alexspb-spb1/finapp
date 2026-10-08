# M1-STAGING-R3-SMOKE-PREP-02 — smoke-only пакет S1b для staging на уже действующих Rules R3

## Итоговый статус
READY_FOR_REVIEW (RESULT: READY_FOR_AUDIT). Блок полностью локальный. **Live Firebase/VDS/provider-вызовов, staging replay, cleanup/export, production, deploy и merge не было.** Пакет — **PREPARED_NOT_AUTHORIZED**:
не допуск на запуск и не STAGE_PASS. Выбор S1b — выбор локальной архитектуры пакета. CI на точном финальном HEAD указан в сообщении передачи и комментарии Draft PR (правка отчёта меняла бы HEAD).

## Corrections V1 (TASK02 REVIEW V1 = CHANGES_REQUIRED, CR1–CR2)
Первоначальный отчёт ниже (утренняя передача, HEAD `a4071da8fee42825a1239b2af6d99d9987daef02`) сохранён как есть; числа и хэши в нём относятся к **прежнему** кандидату `m1-s1b-staging` (code sums `700ba158…`), который заменён и не должен использоваться.
Исправления — в той же ветке и Draft PR #36, новый immutable-кандидат **`D:\projects\finapp\.runtime\m1-s1b-staging-v2`** (code sums `3ad94b6ba32d4a3905b898263c543ea211c29666e5e7ab8bd2d844324dd63b81`, 53 файла, 52 в sums; создан генератором один раз, не запускался). Прежний кандидат проверен: байты не менялись.
Live Firebase/VDS/provider/inventory/reconciliation, staging replay, cleanup/export, production, deploy и merge не выполнялись.

**CR1 — inventory/provider reads после неизвестного или небезопасного STOP cleanup/verify-clean.** Причина: после cleanup код выхода, кроме 0 и 3, и любой ненулевой verify-clean запускали `inventory` без чтения MODE_STOP своего вызова (cleanup exit 4 = «любая ошибка после начала удалений», в т.ч. неизвестный сетевой исход; exit 2 — credentials/budget/integrity/unexpected).
- Теперь **каждый** ненулевой cleanup/verify-clean классифицируется по **своему** MODE_STOP: берутся только события журнала, добавленные после baseline перед вызовом, ровно один MODE_START и один MODE_STOP режима, код выхода журнала равен коду процесса. Отсутствующий, устаревший, повреждённый, неоднозначный журнал или несовпадение кода → `verified:false`.
- Известных классов два: **проверенный отказ gates** (exit 3, `cleanup-refused`, без удалений) → STOP `CLEANUP_REFUSED`; **проверенный остаток** (assertion `verify-clean.documents-absent` / `auth-absent`, удаления завершены) → **один** read-only `inventory` (класс `cleanupExactLookup`, уже требуемый для cleanup), затем STOP `CLEANUP_REMAINDER_VERIFIED` / `VERIFY_CLEAN_REMAINDER`.
- Всё остальное (неизвестный сетевой исход, credentials, budget, integrity, unexpected, guard, любой иной assertion, недоверенный журнал) → `CLEANUP_UNSAFE_STOP` / `VERIFY_CLEAN_UNSAFE_STOP`, `manualClassificationRequired`; **никаких** inventory, verify-clean, чтений провайдера, retry и replay. Runbook §3 и §7 обновлены.
- Небезопасный прежний контроль («partial (4) / stopped (2) → inventory») заменён; добавлены end-to-end тесты: неизвестная мутация cleanup, credentials/budget/integrity/unexpected/guard/manifest (exit 2 и 4), неизвестный исход verify-clean, пропавший/устаревший/повреждённый/двусмысленный журнал и baseline, несовпадение кода выхода, проверенный отказ и проверенный остаток, source-contract «каждый вызов inventory за `verifiedRemainder`».
- Реальные инструменты на своих эмуляторах: сценарий `cleanup-unknown-real` (неизвестный исход Auth delete после удаления документов, cleanup exit 4) → SAFE_STOP шага 5, последний вызов `cleanup`, `inventory`/`verify-clean`/финальные чтения не запускались, 3 синтетических аккаунта остались для ручного решения.

**CR2 — атомарный one-use claim evidence namespace.** Причина: проверка существования и `mkdirSync(evDir, {recursive:true})` были разделены; конкурент между ними оставлял namespace «своим», а flow дописывал в его journal и перезаписывал state.
- Теперь родитель создаётся отдельно, а сам каталог занимается **non-recursive exclusive** `mkdir` (EEXIST → `INIT_REFUSED`, 0 инструментов, существующие evidence не тронуты) и эксклюзивным (`wx`) marker `s1b-claim.json` — до первой записи journal/state и до любого tool/credential/provider вызова. Частично занятый namespace считается consumed (не удаляется, не освобождается).
- Тесты (без sleep, без провайдеров): конкурент ровно в точке claim (побайтная сохранность его journal/state, 0 вызовов); claim — mkdir без `recursive`; существующий пустой/частичный каталог consumed; отказ claim по иной причине и по занятому marker; **два реальных процесса** гонятся за одним namespace — ровно один PASS и один INIT_REFUSED, каждый инструмент выполнен один раз.

**Проверки Corrections V1** (только изменённые пути; неизменённые матрицы 72/21/22/8 не дублировались как доказательство):

| Проверка | Результат |
|---|---|
| `s1b-negative-controls.mjs` (кандидат v2, копия `m1-s1b-verify3`) | PASS 85/85 |
| `s1b-mutation-checks.mjs` | PASS detected 29/29 (+8 мутантов CR1/CR2: возврат к inventory по коду выхода, неверифицированный остаток/отказ, нет baseline, нет привязки кода выхода, recursive claim, перезапись marker) |
| Replay `counterexamples.mjs` аудитора на исправленном source (injected executor, 0 tool-процессов, 0 сети) | cleanup-unknown-partial, cleanup-credential-before-delete, verify-clean-unknown: нет inventory, последний вызов `cleanup`/`verify-clean`; namespace-race: `INIT_REFUSED`, 0 вызовов, прежний journal сохранён — `rehearsal-results-corrections-v1/auditor-counterexamples-replay.json` |
| Rehearsal на своих Auth/Firestore/Functions эмуляторах (fence + изоляция) | REHEARSAL_PASS: 7/7 сценариев (+`cleanup-unknown-real`), suites 27/13/20 PASS; fence 9315 событий, 6 заблокировано (Firebase CLI), разрешённых внешних 0; JVM 0 внешних TCP |
| генератор, `make-s1b-diff.sh`, `git diff --check 8dd6e86..HEAD`, fence-тесты 22, tooling-тесты, предыдущий кандидат | `rehearsal-results-corrections-v1/checks.txt` (все exit 0) |

Ограничения Corrections V1: поведение против live staging по-прежнему не проверялось; ветка проверенного remainder подтверждена только фейковым исполнителем (реальный remainder на эмуляторе не воспроизводился); остальные ограничения (JVM/Chromium вне fence, заглушки live-инструментов, неустановленная первопричина сетевого сбоя) — как ниже.

## Branch / commit
- worktree: `D:/projects/finapp/m1-staging-r3-smoke-prep-02`; ветка `remediation/M1-STAGING-R3-SMOKE-PREP-02-s1b`
- base (exact принятый HEAD PR #35, PASS_LOCAL_BLOCK): `8dd6e86038a1aec435d64d9afb2e2448c4711c04`; Draft PR #35 / PR #28 (`714d0f91c60a582ee87dc7da82d6249b3106329f`, OPEN) / `main` (`6d713fe77164b5d7f096a85509d73b43bd9dad13`) не менялись
- Draft PR: base = ветка PR #35 (`remediation/M1-SAFE-STOP-RECOVERY-01-runner-recovery`), diff содержит только этот блок; список коммитов — `git log 8dd6e86..HEAD`; финальный HEAD и URL — в сообщении-передаче
- cwd/окружение: worktree выше, Node v24.16.0, npm 11.13.0, Windows; перед началом `git status --short` пуст

## Проверенное исходное состояние
Прочитаны: `AUDIT_REVIEW_M1_SAFE_STOP_RECOVERY_01_V2.md`, `AUDIT_TASK_02.md`, `CLAUDE.md`, принятые отчёт/runbook M1-SAFE-STOP-RECOVERY-01, исходники принятого R4-пакета (оркестратор, smoke, transport, core, readiness, state-check, stubs).
Установлено по коду (не по live): штатный PowerShell-оркестратор требует live Rules round 2 (`state-rules-target` → STOP; шаги 4–5 — export и deploy Rules) — его guard **не отключался**, S1b не использует оркестратор; принятые smoke-инструменты (seed/ui/api/ui-r3/cleanup/verify-clean) от Rules-деплоя не зависят.
Live-факты (`finapp-staging`, 13 Functions, Rules `c4fe4c09…19fd`, `https://stage.aktivmetr.ru/`, frontend `714d0f91`) — **датированный baseline аудита 2026-10-07**, в этом блоке не перечитывались.

## Что изменено
Новый пакет `m1-s1b-staging` (исходники — `docs/remediation/evidence/M1-STAGING-R3-SMOKE-PREP-02/package-s1b-source/`, 52 файла, 51 в `CODE-SHA256SUMS.txt`):
1. **Entry point и flow** (`m1-s1b.mjs`, `m1-s1b-flow.mjs`): readiness → preflight → seed → ui → api → ui-r3 → cleanup → verify-clean (+ локальные gates шага 0, read-only состояние шага 1, финальные чтения шага 6). Режимы `plan`, `selftest`, `permit-draft`, `rehearse` — офлайн (требуют fence и чистое окружение без credentials, не импортируют live-адаптеры); `execute` — staging, отказ (exit 3) без валидного permit. **Нет** export, deploy, отката Rules, сборки Functions.
2. **Pins/preflight** (`m1-s1b-pins.mjs`): project `finapp-staging`, head, Rules R3 (live Rules = R2/неизвестные/дрейф байтов → STOP до мутации, причина `rules-r2-live`/`rules-not-r3`), 13 Functions по `expected-state-r3.json`, манифест staging-сборки, marker web config, production-маркеры во входных значениях, namespace (`m1-stg-s1b-714d0f91` / `m1-staging-run-714d0f91-s1b`; consumed и reserved имена, существующий namespace, run id прошлого run `7cbe0a6e` добавлен в consumed).
3. **Допуск** (`m1-s1b-permit.mjs`): permit привязан к байтам пакета (code sums), бюджету, expected-state, манифесту сборки, namespace, head, project, Rules-pin; обязательные классы операций; cleanup и точный lookup G4 — только вместе; срок ≤24 ч; сверка состояния не старше 24 ч на момент решения; шаблон — не допуск.
4. **Бюджет** (`operation-budget.json`): per-mode cap на операторские запросы, Auth create/delete и операторские commit; **transport останавливает запрос до отправки** при превышении (`kind budget`); для staging бюджет обязателен. Калибровка: cap = ceil(наблюдённое × 1.25) + 2 по успешному прогону на эмуляторах.
5. **Credential bootstrap** (`m1-transport.mjs`, входит в новый flow): отказ получения operator credentials до dispatch → фиксированный reason `operator credential bootstrap failed`, код из закрытого набора, kind `credentials` (не cleanup-safe); без raw error/токена и без запросов.
6. **Сохранено из принятой реализации (байт-в-байт, 34 файла IDENTICAL)**: no-retry, intent-before-dispatch/fsync, conservative UNKNOWN, consumed/one-use, linked evidence, cleanup gates G1–G5 (G4 — live lookup), классификация transport. Изменены только `m1-core.mjs` (consumed run id) и `m1-transport.mjs` (п. 4–5).
7. **Политика после STOP** (`cleanupDecision`): неизвестный сетевой исход, `unexpected`, `integrity`, `credentials`, `budget`, повреждённый журнал → **без cleanup, inventory, retry и replay**; `assertion`/`ui-flow` → cleanup через gates с привязанным Rules-evidence (тот же файл, побайтно); провал Rules-пробы → без cleanup (отката в S1b нет); доказанный pre-dispatch сбой → cleanup только при отдельном разрешении.
8. **Fence и изоляция** (`offline-fence/`, копии принятых файлов с **одной** документированной правкой): `dns.lookup` разрешён для IP-литералов (его делает `net.Server.listen` при поиске порта Functions-эмулятора; резолвер не используется), имена и `connect()` наружу по-прежнему блокируются.
9. **Tooling**: `build-s1b-package.mjs` (детерминированный генератор в новый namespace), `make-s1b-diff.sh` (`r4-to-s1b.patch` + таблица), harness эмуляторного rehearsal, collect, тесты fence/tooling, `run-s1b-checks.sh`. Runbook — `docs/remediation/runbooks/M1-S1B-STAGING-SMOKE-PREPARED.md`.

## Почему изменения входят в текущий пункт
Задание TASK 02: отдельный reviewable smoke-only кандидат (вариант S1b) под действующие Rules R3 с pins/preflight, negative controls, rehearsal на собственных эмуляторах, immutable-кандидатом, таблицей операций/допусков и блоком решения владельца.

## Затронутые файлы
- `docs/remediation/evidence/M1-STAGING-R3-SMOKE-PREP-02/` — `package-s1b-source/` (52 файла), `r4-to-s1b.patch`, `s1b-vs-r4-files.txt` (34 IDENTICAL / 2 MODIFIED / 14 NEW / 113 REMOVED), `tooling/`, `rehearsal-results/` (санитизированные), `.gitattributes` (узкое правило `r4-to-s1b.patch -text -whitespace`)
- `docs/remediation/runbooks/M1-S1B-STAGING-SMOKE-PREPARED.md`, этот отчёт, `docs/remediation/EXECUTION_STATE.md`
- Код приложения (`src/`, `functions/`, `firestore.rules`), принятая ветка PR #35, PR #28, `main`, consumed R3/R4-пакеты и evidence, production v6 — **не менялись**. Вне Git: `D:\projects\finapp\.runtime\m1-s1b-staging` (immutable кандидат) и рабочие копии `m1-s1b-dev*`, `m1-s1b-verify*` (не часть кандидата).

## Immutable-кандидат
- namespace: `D:\projects\finapp\.runtime\m1-s1b-staging` (создан генератором ровно один раз; **не запускался**, `results/` нет). Проверка: `diff -rq` с `package-s1b-source` — идентичен; `sha256sum -c CODE-SHA256SUMS.txt` — OK.
- Тесты и rehearsal выполнялись на **копии с теми же байтами** (`m1-s1b-verify2`, code sums совпали), чтобы не менять кандидата результатами тестов.

| Файл | SHA-256 |
|---|---|
| `CODE-SHA256SUMS.txt` | `700ba158ba017ea6783ab1e7919d6812a692e513d596d6135b6d8b45fc40ef8a` |
| `operation-budget.json` | `256692200a35e5ee8505ff8afd93f485f81a84752d5fc4ed2d7bd0f563135ebb` |
| `expected-state-r3.json` | `83f259870bfc121bf6dbff6f56eb5f1a54dce93e0b3839c01f1987870a561de7` |
| `dist-staging-manifest.txt` | `a24e3706004ad3214d6c7e7dfdc58f9240d468f7bd093749ae71398579911410` |

Остальные хэши (`r4-to-s1b.patch`, исходники flow/pins/permit/transport/core, fence) — `rehearsal-results/checks.txt` («fresh hashes»).

## Критерии приемки
- [x] отдельная ветка от exact принятого HEAD, отдельный Draft PR с base = ветка PR #35; принятые ветки/PR/main/consumed не менялись
- [x] отдельный entry point/generator последовательности readiness → preflight R3 → seed → ui → api → ui-r3 → cleanup → verify-clean; нет export/deploy/Rules rollback/Functions deploy веток (hygiene-тест + отсутствие файлов)
- [x] в prepare/dry-run/self-test режимах live-адаптеры и owner credentials недоступны (офлайн-guard, изолированное окружение, fence; 0 сетевых событий в `plan`/`selftest`/`permit-draft`)
- [x] pins/preflight: staging project, exact R3, Functions/API/frontend, marker config; production/неизвестные Rules/несовпадающие байты/reused namespace → STOP до мутации; клиентский smoke описан отдельно (runbook §4)
- [x] сохранены no-retry, intent-before-dispatch/fsync, UNKNOWN, consumed/one-use, linked evidence, cleanup gates; G4 — отдельный допуск (`cleanupExactLookup`); сетевой UNKNOWN запрещает retry/replay/cleanup
- [x] безопасный фиксированный reason code при ошибке operator credentials до dispatch
- [x] negative controls (72) и мутации (21/21), успешный R3 flow на своих Auth/Firestore/Functions эмуляторах с synthetic данными в изолированной конфигурации, Node fence и его selftest
- [x] immutable candidate PREPARED_NOT_AUTHORIZED, SHA256 manifest, команды, operation budget, preconditions, блок решения владельца
- [ ] CI на точном финальном HEAD — в сообщении передачи и комментарии PR
- [ ] live-проверка пакета — **не выполнялась** (запрещена блоком); STAGE_PASS отсутствует

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| `git diff --check 8dd6e86..HEAD` | см. `rehearsal-results/checks.txt` (exit 0) | весь диапазон; исключение whitespace только для двух unified patch |
| `build-s1b-package.mjs` → `diff -rq` с исходниками | PASS | детерминированный генератор; код sums совпали |
| `make-s1b-diff.sh` | `S1B_PATCH_APPLY_BYTE_COMPARE_OK identical=34 modified=2 new=14 removed=113` | R4-снимок + patch + пересчёт sums == S1b побайтно |
| `tests/s1b-negative-controls.mjs` (пакет) | **PASS 72/72** | production target, R2/unknown Rules, stale pins/HEAD/Node/frontend, reused/consumed namespace, нет/неверный permit, credential bootstrap, неизвестный исход, испорченный журнал, cleanup без linked evidence, бюджет, offline guard, hygiene |
| `tests/s1b-mutation-checks.mjs` (пакет) | **PASS detected=21/21** | каждый gate ослаблен в копии с подменёнными корнями — контролы падают |
| `tooling/s1b-fence-tests.mjs` | **PASS 22/22** | fence на копии пакета: окружение, selftest 34+4, 11 мутантов fence, `firebase-tools` без аккаунта, delta-тесты |
| `tooling/s1b-tooling-tests.mjs` | PASS (см. checks.txt) | генератор, идентичность модулей, отсутствие deploy/export файлов, scan evidence |
| `run-s1b-rehearsal.mjs` (эмуляторы Auth+Firestore+Functions, `demo-finapp`) | **REHEARSAL_PASS**: сценарии 6/6, suites 3/3 | см. ниже |
| `tests/transport-classification-tests.mjs` / `seed-stop-recovery-emulator.mjs` / `emulator-cleanup-gate-tests.mjs` на пакете | PASS 27/27; 13/13; 20/20 | принятые наборы для изменённых модулей, под fence |
| `npm run lint/typecheck/test:unit/test:rules/build` | не запускались | код приложения не менялся; CI покрывает |

Не повторялись (неизменённые байты): node-helper 202, orchestrator PowerShell, export-poll, мутации оркестратора — они относятся к удалённым частям или идентичным модулям, принятым ранее.

## Фактический вывод существенных тестов
```text
scenario success          PASS (96 s): readiness -> preflight -> seed -> ui -> api -> ui-r3 -> cleanup -> verify-clean -> final reads; Auth users left 0; requests within budget
scenario rules-r2         PASS: STOP step1 reason rules-r2-live; readiness/smoke not reached; 0 Auth users
scenario rules-unknown    PASS: STOP step1 (rules-not-r3)
scenario functions-drift  PASS: STOP step1
scenario unknown-outcome  PASS: injected "delivered, answer lost" -> STOP step4, manual-classification-required, NO cleanup/inventory, seed ran once, the synthetic account REMAINS (1)
scenario budget-real-tool PASS: real smoke tool with a 1-request budget stops with kind budget before the second request
observed (emulator) requests: preflight 2, seed 13 (3 creates, 1 commit), api 85, cleanup 64 (3 deletes, 1 commit), verify-clean 21
```

## Сеть, fence, изоляция — что доказано и что нет
- Изоляция: default-deny окружение, `APPDATA`/`LOCALAPPDATA`/`USERPROFILE`/`HOME`/`XDG_*`/`CLOUDSDK_CONFIG`/`TEMP` → пустые каталоги, `GOOGLE_*`, токены, прокси отброшены (`credentialEnvNamesPresent: []`), `firebase-tools` в изолированной среде не находит аккаунт. Системные настройки, Execution Policy, firewall, owner credential files не менялись.
- Fence (Node: `net.connect`/tls/http/undici, `dns.lookup`/`resolve*`, `fetch`, `dgram`): selftest recorder 34 + live-loopback 4 — PASS; rehearsal: 2583 событий, 2577 loopback/local, **6 заблокировано, разрешённых внешних 0**. Заблокированные попытки принадлежат процессам `firebase.js`/`npm-cli.js` (Firebase CLI): MOTD (`firebase-public.firebaseio.com`), проверка ADC (`169.254.169.254`, `metadata.google.internal`), `npm info` (`registry.npmjs.org`). Это объясняет ADC-предупреждение прежнего полного прогона (Functions-эмулятор проверяет Application Default Credentials); задним числом zero egress для того прогона не заявляется.
- Охват Functions emulator: процессы `functionsEmulatorRuntime` присутствуют в логе fence — worker'ы Functions унаследовали fence (наблюдено).
- JVM (Auth/Firestore emulator) не fenced: TCP-наблюдение, 6 выборок, **0 внешних установленных соединений** (не enforcement; UDP и промежутки не покрыты). Chromium (UI-режимы) — вне Node-fence: его страничные запросы проходят allowlist route policy (`externalBlocked 0` в результатах ui/ui-r3), внутренний трафик браузера не наблюдался. Не-Node процессы и native add-ons вне fence.
- Найдено попутно: принятый `emulator-session.mjs` (M1-SAFE-STOP-RECOVERY-01) не останавливает сирот при аварийно завершившемся CLI; в S1b-сессии это исправлено (стоп потомков по ParentProcessId); принятый файл не менялся. Один такой сирота (JVM) моего же прогона был найден и остановлен по pid и родителю.

## Таблица будущих операций и допусков
Полная таблица (шаг → инструмент → живые операции → класс permit → бюджет) — runbook §3; блок решения владельца — §8. Кратко: 1 чтение GitHub; read-only чтения Functions/Rules (начало и конец); readiness ≤305 неаутентифицированных POST; preflight ≤5; seed ≤19 запросов (3 Auth create, 1 commit); ui ≤12 операторских; api ≤109; ui-r3 0; cleanup ≤82 (≤3 delete, ≤1 commit) + verify-clean ≤29 + inventory ≤29 — только при `cleanup`+`cleanupExactLookup`.

## Security review
- Fail-closed: любой неизвестный/непроверенный исход ведёт в SAFE_STOP без автоматических действий; permit без привязки к байтам, с неверным namespace/временем/классами отклоняется; cleanup без привязанного evidence не запускается.
- Staging-режим исключает `NODE_OPTIONS`, emulator-переменные, токены, stub-переменные; production-маркеры в web config, окружении и путях → INIT_REFUSED; real staging namespace тестами не создаётся (контроль в тестах).
- В журналах/результатах нет URL, host, e-mail, токенов и текста исходных ошибок; scan evidence (прежние неизменённые паттерны) и user-name scan — 0 находок.
- Остаточный риск: целостность локальных журналов/файлов при компрометации учётной записи пользователя — вне scope; operator credentials берутся из Firebase CLI владельца только в staging-режиме после permit.

## Данные и миграция
Нет. Эмуляторные данные синтетические (`demo-finapp`); staging/production не читались и не менялись. Rollback: revert коммитов ветки / закрытие Draft PR; immutable-кандидат в `.runtime` можно удалить (не запускался).

## Ручная проверка
Не выполнялась (live запрещён).

## Известные ограничения
- **Live-поведение не проверено**: live-инструменты (`stagingResources`, `functions-check`, readiness, `gh`, Firebase CLI credentials) в rehearsal заменены no-network заглушками; контракты аргументов совпадают с оркестратором, но реальный вывод `stagingResources` при несовпадении Rules неизвестен (классификатор причины — best effort; сам STOP не зависит от неё).
- Первопричина прошлого сетевого сбоя не установлена и **не устранена** — пакет лишь не усугубляет неизвестный исход (нет retry/replay/авто-cleanup).
- Cap'ы бюджета откалиброваны по эмулятору; на staging они могут оказаться малы — это приведёт к STOP (fail-closed), а не к расширению.
- Операторские запросы UI-режимов оценены по коду (≤5 при cap 12); число браузерных запросов не ограничено бюджетом (route policy).
- Требуется независимый review; PASS даст только аудитор.

## Дополнительные находки вне scope
1. Принятый `offline-fence/emulator-session.mjs` не чистит сирот при аварии CLI (исправлено только в S1b-сессии).
2. `firebase-tools` при старте эмуляторов пытается обращаться к `firebase-public.firebaseio.com`, `registry.npmjs.org` и metadata-серверу; в изолированной среде это блокируется (предупреждения, не ошибки).
3. `test:run` / `test:e2e` по-прежнему отсутствуют в `package.json`.

## Diff summary
```text
(см. `git diff --stat 8dd6e86..HEAD` в описании PR)
```

## Следующий разрешенный пункт
- Решение аудитора после независимой проверки. Не начинать.
