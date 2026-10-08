# M1-STAGING-READONLY-RECON-PREP-03 — ограниченный read-only пакет сверки finapp-staging

## Итоговый статус
READY_FOR_REVIEW (RESULT: READY_FOR_AUDIT). Блок полностью локальный. **Live Firebase/VDS/provider-вызовов, inventory/reconciliation, staging replay, readiness probes, Auth/Firestore мутаций, cleanup, export, production, deploy и merge не было.**
Пакет — **PREPARED_NOT_AUTHORIZED**: не допуск на чтение и не часть S1b. Он читает staging позже, только по отдельному одноразовому решению владельца на эти байты. CI на точном финальном HEAD — в сообщении передачи и комментарии Draft PR.

## Corrections V1 (TASK03 REVIEW V1 = CHANGES_REQUIRED на `42b0e125968e223837788aac59b0f1df337ebda8`; CR1–CR3 исправлены одним блоком в той же ветке и Draft PR #37)
Действующий кандидат теперь **v2** (`D:\projects\finapp\.runtime\m1-recon-readonly-staging-v2`, `CODE-SHA256SUMS.txt` `05eaa3e644924322cf4cddc40bc870a7fdebe3d1c184bd013d0f4c1d9a47038b`, 25 файлов, 24 в манифесте). Кандидат v1
(`…\m1-recon-readonly-staging`, `6fdb5009455c6c4377754d95495fb36c91775d8677dd1f977edb0eb5763c1622`) **SUPERSEDED** и не менялся; v1-evidence (`test-results/`, `recon-files.txt`) оставлено как есть, evidence v2 — `corrections-v1/`.
Прежние числа 99/99 и 33/33 относились к v1 и **не** являются подтверждением защиты v2 (аудитор показал, что они были недостаточны).

| CR | Дефект v1 (подтверждён контрпримером аудитора) | Исправление v2 | Регрессия (детерминированная, без sleep и live) |
|---|---|---|---|
| CR1 | `execute` проверял только хэш **самого** манифеста: изменённый `recon-bootstrap.mjs` при прежнем манифесте и допуске выполнялся (17 injected запросов, exit 0) | новый `recon-integrity.mjs`: sha256 каждого перечисленного файла, отсутствующие и **неперечисленные** файлы, неперечисленные относительные импорты, сторонние зависимости, обязательные файлы; вызывается **первым** в `runRecon` (до допуска, claim, credentials, fetch), а также в `selftest`/`plan`/`permit-draft` | positive control (неизменённая копия проходит, 17 запросов, exit 0); 17 изменённых файлов (код, helpers, entry `recon.mjs`, `recon-offline.mjs`, fence, pins, манифест билда, тесты) и 9 структурных случаев (удалён/лишний файл, лишний файл в fence, `results/`, манифест пуст/испорчен/отсутствует/без обязательного файла/с дублем) → `INIT_REFUSED integrity`, 0 запросов, namespace не создан; старый допуск недействителен после пересчёта манифеста; структурные pins проверяются независимо; реальный CLI `recon.mjs execute` под fence (изменённый helper → exit 3, 0 событий fence; неизменённая копия доходит до первого запроса, который останавливает fence) |
| CR2 | harness считал DETECTED любой `status != 0`; no-op relocation со старыми sums давал 97/99, diagnostic 32/33, survivor эквивалентен | у каждой копии согласованные корни (соседний каталог) и **пересчитанный после правки** манифест; два зелёных baseline (relocation, безвредная правка) обязательны; DETECTED только если упал **релевантный** контроль (`expect` на каждый мутант), crash/syntax/timeout — ERROR; canary: syntax-error → ERROR, чужой контроль → IRRELEVANT_FAILURE | baselines 148/148; 52 мутанта, у каждого указан и подтверждён релевантный упавший контроль; survivor «consumed/reserved namespaces accepted» (эквивалентный для staging-профиля из-за закреплённого имени) заменён контролем, который достигает гейта в rehearsal-профиле (`namespace gate itself`); 19 новых мутантов CR1/CR3 |
| CR3 | дедлайн 120 с проверялся только перед отправкой: старт 119500 мс, завершение 128500 мс → `RESULT ok` | сигнал запроса = min(10 с, остаток бюджета); проверка после заголовков, после каждого чтения тела (включая признак конца), при записи INTENT и в конце чтения; `deadline` вместо `timeout` при abort внутри бюджета; позднее завершение — STOP `deadline`, тело отменяется, дальнейших запросов нет | точный контрпример аудитора (119500 → 128500 = STOP, `elapsedMs` 9000); граница DL-1 / DL / DL+1 для старта и для завершения; поздний 503/302; тело пересекает дедлайн между чанками и на признаке конца; бюджет закончился во время INTENT (не отправляется); сигнал 10000/500/10000 мс; abort → `deadline`/`timeout`; run-level (последний frontend-запрос, bootstrap, ровно в дедлайн); один loopback-контроль на реальном сигнале (заголовки и тело, бюджет 400 мс) |

Ограничения, найденные при исправлении: см. «Известные ограничения» (сверка байтов выполняется внутри уже запущенного процесса — TOCTOU между загрузкой модулей и проверкой; проверяются байты файлов пакета, не `node.exe`).

## Branch / commit
- worktree: `D:/projects/finapp/m1-staging-readonly-recon-prep-03`; ветка `remediation/M1-STAGING-READONLY-RECON-PREP-03`
- base (exact принятый HEAD PR #36, PASS_LOCAL_BLOCK): `629c8318676b3879205ad2b1906cd9beff6d5f68`; PR #36 / #35 / #28 / `main` / S1b v1 и v2 / consumed run и evidence / утренний отчёт — не менялись
- Draft PR: base = ветка PR #36 (`remediation/M1-STAGING-R3-SMOKE-PREP-02-s1b`); финальный HEAD и URL — в сообщении-передаче
- окружение: Node v24.16.0, npm 11.13.0; перед началом `git status --short` пуст

## Проверенное исходное состояние
Прочитаны `AUDIT_REVIEW_M1_STAGING_R3_SMOKE_PREP_02_V2.md`, `AUDIT_TASK_03.md`, `AUDIT_CURRENT_STATE_20261007.md`, принятые S1b-пакет и отчёты. Реальные локальные контракты (без live):
`deploymentCheckCore`/`m1-functions-check` (Functions v1/v2 list, field mask, caps), `stagingResourcesCore` (Rules release + ruleset, канонический hash), `m1-transport.lookupAuth`, принятый `dist-staging-manifest.txt` и аудиторский скрипт публичной сверки frontend (`/finapp/<path>`, root).
Статически (по `node_modules/firebase-tools/lib`, версия 15.24.0) установлено свойство штатного credential-механизма: refresh токена **записывает** его в конфиг владельца, при 400/401 токен-эндпоинта используется refresh token как access token, любой 401 API вызывает ещё один refresh — см. «Ограничения bootstrap».

## Что изменено (новый самостоятельный пакет, не fork S1b)
`docs/remediation/evidence/M1-STAGING-READONLY-RECON-PREP-03/package-recon-source/` (23 файла, 22 в sums; 13 новых, 9 побайтно повторяют принятый S1b: state-lib, expected-state, build manifest, весь fence с pins):
1. **Движок** (`recon-core.mjs`): allowlist из 22 запросов, сверка **до отправки** (метод, host, путь/шаблон, точный набор query, форма тела); без retry, `redirect=error`, без пагинации; бюджеты per-entry (1) и общий (22), ≤8 МиБ, таймаут 10 с, дедлайн 120 с, лимит размера на ответ (закреплённый размер для frontend); закрытые коды STOP; durable ledger (эксклюзивный файл, `INTENT` с fsync **до** запроса, `RESULT` после), checkpoint `recon-state.json` (атомарно), санитизированный `recon-result.json`, финальный скан evidence.
2. **Ветки**: frontend (17 публичных GET без credentials, байты/sha256/marker проекта), Functions (v1 и v2 list metadata, сравнение с 13 pins), Rules (release + ruleset → canonical/raw hash, размер), Auth (ровно один exact lookup синтетического субъекта).
3. **Bootstrap** (`recon-bootstrap.mjs`): только чтение `access_token`/`expires_at` из конфига Firebase CLI, требует ≥25 минут запаса, без записи/refresh/печати.
4. **Permit** (`recon-permit.mjs`): привязка к code sums, request allowlist, frontend allowlist, consumed-subject pin, expected-state, манифесту; target/namespace/head/Rules pin; ≤2 ч; четыре подтверждения; независимые классы операций; credentialConfigRead включается ровно тогда, когда включена Google-ветка; шаблон — не permit.
5. **Атомарный one-use claim** namespace (`m1-stg-readonly-recon-03`): non-recursive `mkdir` + exclusive marker до bootstrap, ledger и любого запроса; проигравший — INIT_REFUSED, 0 вызовов, чужие evidence не тронуты.
6. **Pins из локальных файлов** (`tooling/make-pins.mjs`): `frontend-allowlist.json` из staging-сборки (сверено с манифестом), `consumed-subject-pin.json` из существующего private journal consumed run `r3-ab9fb2fe` — **только хэши** (журнал sha256, runId `7cbe0a6e`, sha256 синтетического субъекта); адрес не печатается и не хранится, fixture не читается и не копируется.
7. **Офлайн-режимы** (`recon.mjs`, `recon-offline.mjs`): plan/selftest/permit-draft под изоляцией credentials и принятым loopback-fence; без fence/в окружении с credentials отказывают; бездействуют по сети (0 событий).

## Почему изменения входят в текущий пункт
TASK 03: самостоятельный reviewable пакет будущей bounded read-only сверки с exact bytes, командами, allowlist/бюджетами, офлайн-режимами, одноразовым permit и блоком решения владельца — без выполнения чтений.

## Затронутые файлы
`docs/remediation/evidence/M1-STAGING-READONLY-RECON-PREP-03/` (`package-recon-source/` — теперь v2, `tooling/`, `recon-files.txt` и `test-results/` — v1, не менялись, `corrections-v1/` — evidence v2), `docs/remediation/runbooks/M1-STAGING-READONLY-RECON-PREPARED.md`, этот отчёт, `docs/remediation/EXECUTION_STATE.md`.
Corrections V1 меняют только пакет сверки (`recon-core.mjs`, `recon.mjs`, новый `recon-integrity.mjs`, тесты, `tests/relocate.mjs`) и его tooling; принятые пакеты/ветки/evidence (Task01/Task02, S1b v1/v2, consumed run, утренний отчёт) не менялись.
Код приложения, принятые ветки/PR, S1b-кандидаты, consumed пакеты/evidence, private run-каталоги — не менялись (private journal прочитан один раз для хэшей).

## Immutable-кандидат
**v2 (действующий):** `D:\projects\finapp\.runtime\m1-recon-readonly-staging-v2` (создан генератором один раз, не запускался, равен `package-recon-source`; 25 файлов, 24 в манифесте); проверка и тесты — на копии с теми же байтами `m1-recon-verify2`.
**v1 (SUPERSEDED, не менялся):** `D:\projects\finapp\.runtime\m1-recon-readonly-staging`, `CODE-SHA256SUMS.txt` `6fdb5009455c6c4377754d95495fb36c91775d8677dd1f977edb0eb5763c1622` (23 файла, 22 в манифесте); выпускать допуск на v1 нельзя. Оба делят один одноразовый namespace `m1-stg-readonly-recon-03`.

| Файл v2 | SHA-256 |
|---|---|
| `CODE-SHA256SUMS.txt` | `05eaa3e644924322cf4cddc40bc870a7fdebe3d1c184bd013d0f4c1d9a47038b` |
| `recon.mjs` / `recon-core.mjs` / `recon-integrity.mjs` | `4bf2fb00c414…e0d` / `28dc926dea63…507` / `d1170198b567…cee` |
| `request-allowlist.json` | `e6db7fd42d3593ee4d4a59ceb369b5cbc41f2da9e4b8e9284c46455811244d10` |
| `frontend-allowlist.json` | `18eb80c1ac441ae6e1d27afc84e18b788a9e333b91754162d8f4dcbd843e6a43` |
| `consumed-subject-pin.json` | `3c513f36a1062934f08ad87abd7d64d014ff458131f0c16cca6064ca26f931fa` |
| `expected-state-r3.json` / `dist-staging-manifest.txt` | `83f259870bfc…de7` / `a24e37060042…410` (повторяют S1b) |

Данные-pins побайтно те же, что у v1. Остальные хэши — `corrections-v1/test-results/checks.txt` («fresh hashes»), построчная таблица v2 — `corrections-v1/recon-files-v2.txt` (v1: `recon-files.txt`).

## Таблица будущих операций и допусков
Полная таблица (запрос → обоснование → лимиты) — runbook §2; блок решения владельца — §8. Кратко:

| Класс permit | Запросы | Бюджет |
|---|---|---|
| `credentialConfigRead` | чтение кэшированного входа CLI, 0 записей, 0 обращений к token endpoint | ≥25 мин запаса токена |
| `functionsMetadataRead` | 2 × GET (v1, v2 list) | ≤256 КиБ / ≤1 МиБ |
| `rulesReleaseRead` | 2 × GET (release, ruleset) | ≤64 КиБ / ≤512 КиБ |
| `frontendPublicRead` | 17 × GET `stage.aktivmetr.ru` | размер = закреплённому |
| `authExactLookup` | 1 × POST `accounts:lookup` одного синтетического субъекта | ≤64 КиБ |
Итого ≤22 запроса, ≤8 МиБ, дедлайн 120 с. **Не входят:** S1b, readiness POST, callable, мутации, cleanup, export, deploy, merge, token refresh, Firestore data reads.

## Критерии приемки
- [x] отдельная ветка/worktree от exact принятого HEAD, Draft PR с base = ветка PR #36; принятые ветки/PR/кандидаты/evidence не менялись
- [x] bounded plan только finapp-staging: Functions (13 pins, без archive/code export/IAM), Rules (R3 hash), frontend (фиксированные пути принятого манифеста + marker, без браузера/SDK/login), один Auth exact lookup — отдельным классом, субъект из pinned private journal, без list/search/Firestore inventory
- [x] все prepare/plan/selftest/test-режимы credential-isolated и default-deny; owner CLI profile и live-адаптеры недоступны; credential bootstrap описан отдельно, ограничение штатного механизма названо и не обойдено
- [x] future execute — byte/target/namespace/time/operation-bound one-use permit, атомарный claim до credential/provider вызовов, неполный шаблон не permit
- [x] per-request allowlist (метод/host/путь/query/тело), бюджеты (запросы, страницы, байты, таймаут, дедлайн), no retry, redirect=error, закрытые коды; исчерпание/неизвестный вывод/неверные pins → STOP; ledger intent/result, checkpoint, scanner, итоговый exit; token-запросы учтены отдельно
- [x] детерминированные тесты и мутации, 0 provider calls — v2: **148 контролей**, **52 мутанта** (каждый с релевантным упавшим контролем) + 2 canary harness, 2 зелёных baseline; v1-числа 99/33 не используются как подтверждение
- [x] Review V1: CR1 (байты пакета сверяются с манифестом до claim/credentials/fetch), CR2 (harness: согласованные sums, no-op baseline, релевантные контроли, ошибка harness ≠ detection, survivor заменён), CR3 (жёсткий общий дедлайн)
- [x] immutable candidate PREPARED_NOT_AUTHORIZED, versioned source/generator/manifest, санитизированное test evidence, точные команды, отдельный блок решения владельца (S1b не входит), датированный baseline не выдан за свежие факты
- [ ] CI на точном финальном HEAD — в сообщении передачи и комментарии PR
- [ ] живая проверка пакета — не выполнялась (запрещена блоком)

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| `git diff --check 629c831..HEAD` | см. `corrections-v1/test-results/checks.txt` (exit 0) | весь диапазон |
| генератор `build-recon-package.mjs` → `diff -rq` | PASS | кандидат v2 и копия побайтно равны исходникам; sums совпали |
| `tests/recon-negative-controls.mjs` (копия кандидата v2) | **PASS 148/148** | прежние 99 (allowlist, клиент, полное чтение, различия, STOP-коды, subject, bootstrap, INIT, permit, claim/race, scanner, offline guard, hygiene) + 49 новых: жёсткий дедлайн (CR3), побайтная целостность (CR1), контроль гейта consumed-имён |
| `tests/recon-mutation-checks.mjs` | **PASS detected=52/52**, baselines 148/148, 2 canary OK | копия на мутанта с согласованным манифестом; DETECTED только при релевантном упавшем контроле |
| `tooling/recon-tooling-tests.mjs` | PASS 10/10 | генератор, идентичность повторно использованных файлов, отсутствие live-кода, pins vs локальные доказательства, scan evidence, v1 не менялся, состав v2, runbook |
| `recon-offline.mjs selftest / plan / permit-draft` | exit 0, `fenceEvents=0 blocked=0` | изолированное окружение, credentials родителя не наследуются; selftest теперь = полная сверка байтов (24 файла) |
| эмуляторы / UI / S1b-матрицы | не запускались | неизменённая S1b-матрица не повторялась; пакет эмуляторов не использует |

## Фактический вывод существенных тестов
```text
success (synthetic world): READ_COMPLETE_ALL_MATCH_PINS exit 0; 22 requests = 17 frontend GET (no Authorization header) + 4 Google GET + 1 POST (exact subject body); intents 22; token endpoint calls 0; config writes 0
differences (wrong Rules / drifted revision / caps / missing & extra function / tampered frontend byte / prod marker): exit 4, recorded as observations
stop (401/403/404/429/5xx, network, timeout, redirect, oversize, malformed JSON, pagination, bad shapes): exit 2, closed code, no retry, nothing further requested
claim race (two real processes): exactly one reading; loser: 0 fetch, 0 bootstrap
```

## Security review
- Fail-closed: любой неизвестный/неожиданный исход — STOP без fallback; permit без привязки к байтам/времени/классам отклоняется; шаблон — не permit.
- Токен: только из чтения конфига, в памяти, только на `*.googleapis.com` allowlist-хосты; на stage-host — никогда; не пишется в evidence (скан по паттернам и по точному значению).
- Allowlist исключает запись/экспорт/IAM/архивы/callable/токен-эндпоинт; единственный POST — exact lookup с телом строго `{"email":[<синтетический субъект>]}`; адрес владельца или несинтетический отклоняется до отправки.
- Остаточный риск: целостность локальных evidence при компрометации учётной записи ОС; чтение конфига Firebase CLI раскрывает процессу refresh token (не используется).

## Данные и миграция
Нет. Staging/production не читались и не менялись. Rollback: revert коммитов ветки / закрытие Draft PR; кандидат в `.runtime` можно удалить (не запускался).

## Ручная проверка
Не выполнялась (live запрещён).

## Известные ограничения
- **Ограничения bootstrap/сети:** (1) штатный refresh firebase-tools пишет в конфиг владельца и имеет недоказанные дополнительные вызовы — пакет его не использует, поэтому требует свежего входа владельца (≥25 мин запаса) и иначе останавливается; (2) `execute` идёт без fence (ему нужен выход в сеть) — защита allowlist/бюджетами/permit; fence покрывает только офлайн-режимы и только Node-API; (3) VPN/маршрутизация не контролируются — зафиксируются владельцем информационно; (4) реальные ответы Google не наблюдались: формы взяты из локальных контрактов; семантика `fetch` (redirect=error, timeout, отмена потока) проверена на loopback.
- **Сверка байтов (v2):** выполняется внутри уже запущенного процесса — модули загружены до проверки, проверка читает диск; подмена файла между загрузкой и проверкой с возвратом назад не обнаруживается (защита — права на каталог пакета). Проверяются байты файлов пакета, не `node.exe` и не встроенные модули Node (версия Node — предусловие владельца).
- **Мутационная проверка (v2)** доказывает, что тесты ловят ослабление перечисленных гейтов; 52 мутанта — не исчерпывающий набор. Один loopback-контроль дедлайна использует реальные таймеры (≈0,4 с на случай), остальные дедлайн-контроли детерминированы.
- Результат сверки — наблюдения «на момент чтения»; `ABSENT_NOW` не доказывает non-dispatch; пакет не объявляет заранее ни absent, ни compatible, ни accepted.
- Auth lookup зависит от существования private journal consumed run на машине исполнения; при расхождении хэша — STOP до запроса.
- Требуется независимый review; PASS даст только аудитор.

## Дополнительные находки вне scope
1. Heredoc-скрипты в Bash-инструменте искажают обратные косые черты и кавычки (инструментальный артефакт; обходится записью файлов).
2. **Важно для будущего S1b-решения:** credential bootstrap принятого S1b-кандидата (`m1-transport.mjs`, `bootstrapOperatorCredentials`) и его live-инструменты (`m1-functions-check`, `stagingResources`) идут через `firebase-tools` (`requireAuth` / `apiv2.getAccessToken`), то есть при просроченном кэшированном токене могут обновить его с записью в конфиг владельца и сделать дополнительные вызовы token endpoint. Это не исправлялось (вне scope, принятые пакеты не меняются); owner decision по S1b должно учесть это отдельно (например, требовать свежего входа заранее, как в этом пакете).

## Diff summary
```text
(см. `git diff --stat 629c831..HEAD` в описании PR)
```

## Следующий разрешенный пункт
- Решение аудитора после независимой проверки. Не начинать.
