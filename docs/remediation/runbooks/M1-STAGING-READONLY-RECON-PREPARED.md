# M1 — ограниченная read-only сверка finapp-staging: подготовленный пакет (PREPARED_NOT_AUTHORIZED)

Задача: `M1-STAGING-READONLY-RECON-PREP-03`. Документ **ничего не выполняет и не даёт допуска**. Пакет читает состояние staging **позже**, только по отдельному одноразовому решению владельца
на эти байты. Он **не входит в S1b**: S1b-исполнение (readiness POST, callable, мутации, cleanup, deploy, merge) — другое решение, другой пакет (`m1-s1b-staging-v2`), и это решение его не включает.
Результат сверки — наблюдения «на момент чтения»; пакет не объявляет заранее ни «absent», ни «compatible», ни «accepted» — приёмку даёт только независимый аудитор.

**Версии кандидата.** Действующий кандидат — **v2** (`D:\projects\finapp\.runtime\m1-recon-readonly-staging-v2`, исправления Review V1 CR1–CR3, хэши в §9). Первый кандидат `D:\projects\finapp\.runtime\m1-recon-readonly-staging`
(`CODE-SHA256SUMS.txt` `6fdb5009…1622`) — **SUPERSEDED**: он оставлен нетронутым как доказательство, его запускать и под него выдавать допуск **нельзя** (execute v1 не сверял фактические байты файлов с манифестом:
изменённый helper при прежнем манифесте и допуске выполнялся). Оба кандидата делят один одноразовый namespace `m1-stg-readonly-recon-03`, поэтому чтение может состояться не более одного раза, каким бы пакетом оно ни было начато.

## 1. Датированный baseline (аудит 2026-10-07; не текущие чтения)

`finapp-staging`; Rules SHA-256 `c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd` (round 3, updateTime 2026-10-07T08:06:12Z); 13 функций ACTIVE (`expected-state-r3.json`);
`https://stage.aktivmetr.ru/` — 15 файлов совпали с `714d0f91` (проверка аудитора); synthetic Auth-субъект старого UNKNOWN create — `ABSENT_NOW` на 2026-10-07T17:23:01Z (одно чтение аудитора).
Это ориентир для сравнения с pins, не свежие факты: всё перечисленное будущая сверка читает заново.

## 2. Что читаем и зачем (минимальный набор по локальным контрактам существующих инструментов)

| № | Ветка | Запрос | Обоснование (локальный контракт) | Лимиты |
|---|---|---|---|---|
| 1–2 | Cloud Functions | `GET cloudfunctions.googleapis.com/v1/projects/finapp-staging/locations/-/functions` (`fields=functions(name),nextPageToken,unreachable&pageSize=100`) и `/v2/…` (field mask без env, secrets, service accounts, URI; `filter=environment="GEN_2"`) | `deploymentCheckCore` / `m1-functions-check`: точное состояние = ровно 13 функций GEN_2, 1st-gen нет; state, runtime, caps, revision, build, fingerprint источника | по 1 запросу; ≤256 КиБ и ≤1 МиБ; пагинация запрещена (`nextPageToken` ⇒ STOP) |
| 3–4 | Rules | `GET firebaserules.googleapis.com/v1/projects/finapp-staging/releases/cloud.firestore`, затем `GET …/rulesets/<id из релиза>` | `stagingResourcesCore.readRules` (`verify-current-rules`): канонический hash live Rules | по 1; ≤64 КиБ и ≤512 КиБ; id по шаблону `[A-Za-z0-9-]{1,64}` |
| 5–21 | Frontend | 17 × `GET https://stage.aktivmetr.ru/`, `/finapp/` и `/finapp/<path>` для 15 файлов принятого манифеста (`.vite/manifest.json` не запрашивается) | принятый `dist-staging-manifest.txt`; байты и sha256 каждого файла; marker `VITE_FIREBASE_PROJECT_ID` в Firebase chunk | по 1 на путь; размер = закреплённому размеру файла; **без credentials**, без браузера и SDK |
| 22 | Auth (опционально) | **ровно один** `POST identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts:lookup`, тело `{"email":["<субъект>"]}` | контракт `lookupAuth` принятого transport; субъект выводится из private journal consumed run `r3-ab9fb2fe` (см. §5) | 1; ≤64 КиБ; без list/search |

Не входят (и почему): GET project/billing/database metadata (номер проекта закреплён в expected builds), индексы, любые чтения данных Firestore, readiness POST и callable (это S1b), обмен/обновление токена,
скачивание архивов кода и экспорт исходников Functions, любые IAM-операции, мутации. Общий бюджет: **22 запроса**, ≤8 МиБ суммарно, таймаут 10 с на запрос, **жёсткий** дедлайн 120 с на всё чтение, без retry, `redirect=error`.
Дедлайн ограничивает не только старт запроса: сигнал запроса = меньшее из 10 с и остатка бюджета (заголовки и потоковое тело), дедлайн проверяется после заголовков, после каждого чтения тела (включая признак конца), при записи INTENT и в конце чтения;
запрос, завершившийся позже дедлайна, — STOP `deadline` (тело отменяется, дальнейших запросов нет), а не успех. Завершение ровно в момент дедлайна допустимо, на миллисекунду позже — STOP.
Источник истины allowlist — `request-allowlist.json` + `frontend-allowlist.json` (оба закреплены в permit); движок сверяет **каждый** запрос с таблицей до отправки (метод, host, путь, точный набор query, форма тела).

## 3. Credential bootstrap (будущий разрешаемый шаг `credentialConfigRead`) и его ограничение

Штатный механизм — сохранённый вход Firebase CLI (`<XDG_CONFIG_HOME или ~/.config>/configstore/firebase-tools.json`). Пакет **только читает** из него `tokens.access_token` и `tokens.expires_at` (в памяти; не печатает, не пишет, не копирует) и
требует, чтобы токен был годен **ещё ≥25 минут** (запуск занимает ≤2 минут). Токен уходит только на три `*.googleapis.com` host'а вместе с `x-goog-user-project: finapp-staging`; на `stage.aktivmetr.ru` — никогда.

**Ограничение (limitation, не обход):** штатный путь самого firebase-tools (`lib/auth.js: refreshTokens → updateAccount → configstore.set("tokens", …)`) при обновлении токена **записывает** его в конфиг владельца,
при ответе 400/401 токен-эндпоинта подставляет **refresh token как access token**, а `apiv2` при любом 401 делает ещё один refresh. Это запись в credential-файл владельца и недоказанные дополнительные вызовы, поэтому пакет этот путь **не использует**:
эндпоинта токена нет в allowlist, 401/403 любого запроса — STOP (`http-401`/`http-403`), refresh/retry нет, число обращений к token endpoint = 0 по построению (и фиксируется как 0 в результате).
Следствие: если кэшированный токен слишком стар, пакет останавливается (`credential-too-old`). Обновить вход штатным Firebase CLI **до** запуска — действие владельца вне пакета (оно меняет его собственный конфиг и вызывает Google; пакет этого не делает и не просит).
Если владелец захочет разрешить штатный refresh с записью конфига, это **отдельное** решение и другой пакет; здесь оно не реализовано и не разрешено. Чтение файла раскрывает пакету и refresh token (в памяти, не используется) — это свойство формата файла.

## 4. Режимы, команды, коды выхода

Офлайн (разрешены сейчас; изолированное окружение: пустые profile/config, default-deny, loopback-only fence, 0 сетевых событий, owner credential не читается):

```bash
node recon-offline.mjs selftest
node recon-offline.mjs plan
node recon-offline.mjs permit-draft
```

Будущее одноразовое чтение (**не выполнять без допуска**; не запускать под fence — `NODE_OPTIONS` запрещён):

```bash
node recon.mjs execute --permit <abs permit.json>
```

**Порядок `execute`:** (1) побайтовая сверка пакета с манифестом `CODE-SHA256SUMS.txt` (`recon-integrity.mjs`: sha256 каждого перечисленного файла — код, helpers, pins, fence, тесты; отсутствующие и **неперечисленные** файлы в каталоге пакета;
относительные импорты, не перечисленные в манифесте; сторонние зависимости вне `node:`; обязательные файлы в манифесте) — раньше всего, **до** проверки допуска, claim, чтения кэшированного входа и любого запроса; (2) структурные проверки pins (независимо от манифеста);
(3) допуск (привязка к байтам, target, namespace, окно, операции, подтверждения); (4) одноразовый claim namespace; (5) bootstrap и запросы. Изменённый, отсутствующий или лишний файл ⇒ `INIT_REFUSED` (код 3, `reason=integrity: …` — только путь файла),
ничего не заявлено, credentials не читались. Если после изменения пересчитать манифест, старый допуск недействителен (привязан к хэшу прежнего манифеста). Та же проверка выполняется в `selftest`, `plan` и `permit-draft` (их привязки имеют смысл только для неизменённых байтов).

Evidence: `D:\projects\finapp\.runtime\m1-stg-readonly-recon-03\` (`recon-claim.json`, `recon-ledger.jsonl`, `recon-state.json`, `recon-result.json`). Коды выхода: **0** — все сравнения равны pins; **4** — чтение завершено, наблюдены различия
(не STOP: результат записан как наблюдение); **2** — STOP (закрытый код, ничего больше не запрашивается, evidence сохранено); **3** — INIT_REFUSED (ничего не выполнялось, credentials не читались, namespace не занят).
Закрытые коды STOP: `allowlist-denied`, `budget-exhausted`, `deadline`, `timeout`, `network-unknown`, `redirect`, `oversize`, `http-401/403/404/429/5xx/other`, `malformed-json`, `unexpected-shape`, `pin-mismatch`, `credential-*`, `subject-*`, `unexpected`.
Неизвестный сетевой исход и любой ответ неожиданной формы — STOP без повторов и fallback; различие well-formed ответа с pin — наблюдение, не STOP.

## 5. Auth exact lookup (класс `authExactLookup`, отдельно разрешаемый)

Нужен только чтобы дать текущую точку по старому UNKNOWN create. Субъект — **синтетический** адрес `m1-<runId>-admin@example.invalid`, выводимый в памяти из private journal consumed run (`m1-staging-run-714d0f91-v5/journal.jsonl`):
journal сверяется по sha256 с pin (`consumed-subject-pin.json`), в нём ровно один `PREFLIGHT_OK` (runId `7cbe0a6e`) и один `AUTH_CREATE_MAY_BE_SENT` ключа `admin`, а sha256 выведенного адреса равен pin; иначе STOP до любого запроса.
Адрес, UID и пароль не печатаются, не сохраняются и в Git не входят (fixture не копируется и не читается — только журнал без секретов). Результат: `ABSENT_NOW` / `PRESENT_NOW` на момент чтения — **не** доказательство,
что старый запрос не ушёл или был обработан. Нет list/search, чужих аккаунтов, Firestore-инвентаря.

## 6. Предусловия перед запуском

1. Независимый PASS аудитора на этот пакет (хэши §9). 2. Решение владельца (§8) → файл permit (`permit-draft` печатает черновик с хэшами; черновик — не допуск). 3. Свежий вход Firebase CLI владельца (годен ≥25 мин) — действие владельца.
4. Node v24.x, свободный namespace `m1-stg-readonly-recon-03` (иначе INIT_REFUSED; повторное чтение запрещено — нужен новый пакет/namespace и новый допуск). 5. В окружении нет `NODE_OPTIONS`, `FIREBASE_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, прокси, `*EMULATOR*`, `M1_STUB_*`.
6. Сеть (VPN вкл/выкл) фиксируется владельцем информационно — это не условие безопасности.

## 7. Evidence и санитизация

В evidence попадают только: закрытые коды, счётчики, sha256 и размеры ответов, публичные идентификаторы (имена функций, ревизии, build-id, имя ruleset, времена релиза), классификация Auth. Тела ответов, текст Rules, токены, адреса и UID **не** сохраняются.
После чтения весь каталог evidence сканируется (токены `ya29.`/`1//`, Bearer, API-ключи, пароли fixture, адрес синтетического субъекта, точное значение использованного токена); находка ⇒ `recon-scan-hit.json` (только имена файлов) и код 2.
Durable ledger: `INTENT` (fsync) записывается **до** отправки каждого запроса, `RESULT` — после; запросы токен-эндпоинта учитываются отдельно (0), не скрываются в счётчиках ресурсных чтений.

## 8. Решение владельца на эту сверку (шаблон — заполняется владельцем; документ ничего не разрешает; S1b в него НЕ входит)

```text
Пакет:          m1-recon-readonly-staging-v2 (НЕ v1), CODE-SHA256SUMS.txt sha256 = <из §9>
Target:         finapp-staging; host https://stage.aktivmetr.ru/; head 714d0f91c60a582ee87dc7da82d6249b3106329f; Rules R3 c4fe4c09…19fd (только как pin для сравнения)
Namespace:      m1-stg-readonly-recon-03 (одноразовый)
Привязки:       request-allowlist.json / frontend-allowlist.json / consumed-subject-pin.json / expected-state-r3.json / dist-staging-manifest.txt — sha256 из §9
Разрешаю чтения (только нужные):
  [ ] credentialConfigRead   [ ] functionsMetadataRead (2 GET)   [ ] rulesReleaseRead (2 GET)   [ ] frontendPublicRead (17 GET)   [ ] authExactLookup (1 POST, отдельное решение)
  (credentialConfigRead включается ровно тогда, когда включена хотя бы одна Google-ветка)
Подтверждаю:    [ ] токен не обновляется и конфиг не пишется, при 401/403 — STOP   [ ] без retry, неизвестный исход = STOP   [ ] ABSENT_NOW не доказывает non-dispatch   [ ] результаты — наблюдения, не приёмка
Срок:           с ____ до ____ UTC (не более 2 часов)
Не разрешено:   S1b, readiness POST, callable, мутации Auth/Firestore, cleanup, export, deploy, merge, production, любые другие чтения
```

## 9. Хэши immutable-кандидата v2 (`D:\projects\finapp\.runtime\m1-recon-readonly-staging-v2`)

| Файл | SHA-256 |
|---|---|
| `CODE-SHA256SUMS.txt` | `05eaa3e644924322cf4cddc40bc870a7fdebe3d1c184bd013d0f4c1d9a47038b` |
| `recon.mjs` | `4bf2fb00c4144ed887f8ede2f4d6d808daeb7520372eba4e3e001e80123b8e0d` |
| `recon-core.mjs` | `28dc926dea6357f91e1cc827569b2293df4e783d77493a24f382832f4a863507` |
| `recon-integrity.mjs` | `d1170198b56765695fe617bcc718c59fe364460b32a52f6188d73af5a6128cee` |
| `request-allowlist.json` | `e6db7fd42d3593ee4d4a59ceb369b5cbc41f2da9e4b8e9284c46455811244d10` |
| `frontend-allowlist.json` | `18eb80c1ac441ae6e1d27afc84e18b788a9e333b91754162d8f4dcbd843e6a43` |
| `consumed-subject-pin.json` | `3c513f36a1062934f08ad87abd7d64d014ff458131f0c16cca6064ca26f931fa` |
| `expected-state-r3.json` | `83f259870bfc121bf6dbff6f56eb5f1a54dce93e0b3839c01f1987870a561de7` |
| `dist-staging-manifest.txt` | `a24e3706004ad3214d6c7e7dfdc58f9240d468f7bd093749ae71398579911410` |

Данные-pins (`request-allowlist.json`, `frontend-allowlist.json`, `consumed-subject-pin.json`, `expected-state-r3.json`, `dist-staging-manifest.txt`) побайтно те же, что у v1; изменился код (манифест v1 `6fdb5009…1622` — SUPERSEDED, пакет v1 не менялся).

## 10. Остаточные ограничения

- Живое поведение провайдера и реальный `fetch` против Google/stage-host не проверялись (тесты — recorder fetch и loopback-проверка семантики `fetch`); формы ответов взяты из локальных контрактов существующих инструментов.
- Fence — Node-уровня; запуск `execute` идёт **без** fence (ему нужен выход в сеть) — защита там: allowlist до отправки, бюджеты, permit, claim.
- Чтение конфига Firebase CLI раскрывает процессу refresh token (в памяти); корректность требует свежего входа владельца (§3).
- Результат — наблюдения на момент чтения; сам по себе он не заменяет решение по S1b.
- Сверка байтов происходит внутри уже запущенного процесса: модули загружены Node до проверки, а проверка читает файлы с диска. Локальный злоумышленник с правом записи в каталог пакета, меняющий файл между загрузкой модуля и проверкой (десятки миллисекунд)
  и возвращающий его обратно, не обнаруживается; защита от этого — права на каталог пакета (запись только владельцу) и запуск из каталога, который не меняется после выдачи допуска.
- Проверка проверяет байты файлов пакета, а не `node.exe` и не встроенные модули Node: версия Node (v24.x) — предусловие владельца, не часть манифеста.
- Мутационная проверка (52 мутанта + 2 canary) доказывает, что **эти** тесты ловят ослабление **этих** гейтов; она не доказывает отсутствие других дефектов и не заменяет независимый аудит.
