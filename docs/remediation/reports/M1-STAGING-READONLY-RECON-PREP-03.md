# M1-STAGING-READONLY-RECON-PREP-03 — ограниченный read-only пакет сверки finapp-staging

## Итоговый статус
READY_FOR_REVIEW (RESULT: READY_FOR_AUDIT). Блок полностью локальный. **Live Firebase/VDS/provider-вызовов, inventory/reconciliation, staging replay, readiness probes, Auth/Firestore мутаций, cleanup, export, production, deploy и merge не было.**
Пакет — **PREPARED_NOT_AUTHORIZED**: не допуск на чтение и не часть S1b. Он читает staging позже, только по отдельному одноразовому решению владельца на эти байты. CI на точном финальном HEAD — в сообщении передачи и комментарии Draft PR.

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
`docs/remediation/evidence/M1-STAGING-READONLY-RECON-PREP-03/` (`package-recon-source/`, `tooling/`, `recon-files.txt`, `test-results/`), `docs/remediation/runbooks/M1-STAGING-READONLY-RECON-PREPARED.md`, этот отчёт, `docs/remediation/EXECUTION_STATE.md`.
Код приложения, принятые ветки/PR, S1b-кандидаты, consumed пакеты/evidence, private run-каталоги — не менялись (private journal прочитан один раз для хэшей).

## Immutable-кандидат
`D:\projects\finapp\.runtime\m1-recon-readonly-staging` (создан генератором один раз, не запускался, равен `package-recon-source`); проверка и тесты — на копии с теми же байтами `m1-recon-verify1`.

| Файл | SHA-256 |
|---|---|
| `CODE-SHA256SUMS.txt` | `6fdb5009455c6c4377754d95495fb36c91775d8677dd1f977edb0eb5763c1622` |
| `request-allowlist.json` | `e6db7fd42d3593ee4d4a59ceb369b5cbc41f2da9e4b8e9284c46455811244d10` |
| `frontend-allowlist.json` | `18eb80c1ac441ae6e1d27afc84e18b788a9e333b91754162d8f4dcbd843e6a43` |
| `consumed-subject-pin.json` | `3c513f36a1062934f08ad87abd7d64d014ff458131f0c16cca6064ca26f931fa` |
| `expected-state-r3.json` / `dist-staging-manifest.txt` | `83f259870bfc…de7` / `a24e37060042…410` (повторяют S1b) |

Остальные хэши — `test-results/checks.txt` («fresh hashes»), построчная таблица — `recon-files.txt`.

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
- [x] детерминированные тесты и мутации (99 контролей / 33 мутации), 0 provider calls
- [x] immutable candidate PREPARED_NOT_AUTHORIZED, versioned source/generator/manifest, санитизированное test evidence, точные команды, отдельный блок решения владельца (S1b не входит), датированный baseline не выдан за свежие факты
- [ ] CI на точном финальном HEAD — в сообщении передачи и комментарии PR
- [ ] живая проверка пакета — не выполнялась (запрещена блоком)

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| `git diff --check 629c831..HEAD` | см. `test-results/checks.txt` (exit 0) | весь диапазон |
| генератор `build-recon-package.mjs` → `diff -rq` | PASS | кандидат и копия побайтно равны исходникам; sums совпали |
| `tests/recon-negative-controls.mjs` (копия кандидата) | **PASS 99/99** | allowlist (методы/host/путь/query/тело/схема/порт/userinfo), клиент (intent до dispatch, бюджеты, no retry, redirect, oversize, deadline, scope токена), полное чтение, различия, STOP-коды, subject, bootstrap, INIT, permit, claim/race, scanner, offline guard, hygiene |
| `tests/recon-mutation-checks.mjs` | **PASS detected=33/33** | каждый gate ослаблен в копии с подменёнными корнями — контроли падают |
| `tooling/recon-tooling-tests.mjs` | PASS 8/8 | генератор, идентичность повторно использованных файлов, отсутствие live-кода, pins vs локальные доказательства, scan evidence, runbook |
| `recon-offline.mjs selftest / plan / permit-draft` | exit 0, `fenceEvents=0 blocked=0` | изолированное окружение, credentials родителя не наследуются |
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
