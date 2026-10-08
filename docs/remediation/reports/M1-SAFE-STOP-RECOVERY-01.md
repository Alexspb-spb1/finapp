# M1-SAFE-STOP-RECOVERY-01 — SAFE_STOP staging-run: причина остановки, regression, recovery-путь, совместимость

## Итоговый статус
READY_FOR_REVIEW (RESULT: READY_FOR_AUDIT) после **Corrections V1** (ответ на REVIEW V1 = CHANGES_REQUIRED, замечания CR1–CR4 — раздел ниже). Блок полностью локальный: новых live-запусков, provider-вызовов, cleanup, merge и deploy не было.
Статус не закрывает SEC-007/010/011 и не означает готовность релиза к production. Результат CI на точном финальном HEAD указан в сообщении передачи и в комментарии Draft PR, а не здесь: правка отчёта меняла бы проверяемый HEAD (CI на pull_request для base не `main` автоматически не запускается — запуск вручную через `workflow_dispatch` на ветке, без секретов и deploy-шагов).

## Branch / commit
- worktree: `D:/projects/finapp/m1-safe-stop-recovery-01`; ветка `remediation/M1-SAFE-STOP-RECOVERY-01-runner-recovery`
- base (exact PR #28 HEAD): `714d0f91c60a582ee87dc7da82d6249b3106329f`; `D:/projects/finapp/pr28-fix` на момент сверки на том же HEAD, `git status --short` пуст (0 строк), не изменялся
- коммиты первого прохода: `096be8c` (исходники runner, patch, evidence), `ed2738d` (compatibility/rollout proposal), `11a4675` (дополнение к нему), затем отчёт и checkpoint (HEAD первого прохода `48b9b54269a7731da08e89fdb03f8fa4f6bdcd9b`); коммиты Corrections V1 — отдельные scoped-коммиты поверх него (список — в сообщении-передаче и `git log 48b9b54..HEAD`); финальный HEAD = коммит, содержащий этот файл; его SHA и URL Draft PR — в сообщении-передаче и в описании PR (SHA коммита не может быть записан внутри самого коммита)
- Draft PR: base = `remediation/SEC-007-member-management-functions` (HEAD PR #28, чтобы diff содержал только этот блок)
- cwd при работе: worktree выше; Node v24.16.0, npm 11.13.0

## Проверенное исходное состояние

Прочитаны: `AUDIT_TASK_01.md`, `.runtime/AUDIT_CURRENT_STATE_20261007.md`, `CLAUDE.md`, `docs/remediation/reports/FINAPP-1.0-M1.md`,
`docs/remediation/reports/PROD-LOGIN-20261007.md` (ветка hotfix, только чтение, полностью), исходники последнего run `m1-r3-staging` (`m1-smoke.mjs`, `m1-transport.mjs`, `m1-core.mjs`,
`m1-orchestrator.ps1`, `m1-run-inspect.mjs`) и durable evidence `m1-staging-run-714d0f91-v5` / `m1-stg-r3v5-714d0f91`. Приватные значения (UID, email, токены, пароли) в отчёт не включены.

### Реальная последовательность run `r3-ab9fb2fe` (по журналам, UTC)

| Время | Операция | Intent записан до отправки | Могла уйти mutation | Ответ провайдера | Локальная запись | Терминальное состояние |
|---|---|---|---|---|---|---|
| 08:03:40–08:03:42 | `preflight` (чтение maintenance, lookup fixture-email) | — | нет (requests=2, creates/deletes 0) | HTTP-ответы получены | fixture написан | MODE_PASS |
| 08:06:38.737 | `seed` MODE_START | — | — | — | — | — |
| 08:06:39.234 | `FIXTURE_WRITTEN` (steps.seed=`MAY_BE_SENT`) → `AUTH_CREATE_MAY_BE_SENT key=admin` | **да** (fsync до fetch) | **неизвестно** | **нет**: fetch завершился отказом без HTTP-статуса | uid в fixture не записан (`null`) | — |
| 08:06:49.941 | `MODE_STOP kind=transport reason=transport: network failure POST accounts`, requests=1, authCreates=0 | — | см. выше | — | — | **STOP exit 2** (10,707 с после intent) |
| 08:06:57–58 | `cleanup`: gate G2+G3, чтения (requests=3), `CLEANUP_REFUSED`, recovery manifest | — | **нет** удалений (`deletesMayHaveBeenSent=false`, authDeletes=0) | чтения успешны, аккаунтов/документов не найдено | recovery manifest записан | **STOP exit 3** `cleanup-refused` |
| оркестратор | run-inspect: `confirmed-non-rules-failure`; step6 STOP; cleanup-ветка `CLEANUP_REFUSED`; шаг 8 не выполнялся | — | — | — | — | `SAFE_STOP step6` |

Для **seed** единственной возможной mutation была создание Auth-пользователя `admin` (company/commit-интентов нет); для **cleanup** — mutations не отправлялись.
`authCreates=0` — счётчик подтверждённых ответов, а не доказательство, что запрос не отправлен. Состояние «аккаунта нет» установлено лишь **на моменты чтения**
(cleanup-lookup 08:06:58, inventory 08:08:47, аудиторский lookup 17:23:01Z); это не доказательство, что запрос никогда не был обработан.

### Точная причина STOP и что по артефактам НЕ установлено

- Причина остановки seed: единственный fetch (`POST …/projects/finapp-staging/accounts`) завершился отказом без HTTP-ответа; runner записал фиксированный reason
  `transport: network failure POST accounts` (Stop kind `transport`). Исходник: `m1-transport.mjs:51` (`counters.requests++`), `:54` (`await fetch(…)`), `:55–57` (`catch {` → `stop('transport', …)`).
- Причина отказа сети (DNS / connect / reset / timeout), и ушёл ли запрос, **не установлены**: старый runner не сохранял класс ошибки (`catch {}` без аргумента), артефакты его не содержат.
  Интервал 10,707 с короче собственного abort-таймаута runner (30 с) — это совместимо с отказом до собственного abort, но **не доказывает** ни connect timeout, ни отсутствие отправки
  (замечание аудитора принято). Исход того запроса остаётся неизвестным; старые consumed evidence не менялись и не переклассифицировались.
- Причина отказа cleanup (по коду): `m1-smoke.mjs:362` — `G2 STOP in seed of kind transport` (kind `transport` не входит в `CLEANUP_SAFE_STOP_KINDS`, `m1-core.mjs:51`) и `:369` —
  `G3 auth user admin may exist without recorded uid`. Оба условия сработали **штатно**; это поведение по замыслу fail-closed, а не сбой.
- Диагностический дефект (подтверждён воспроизведением, ниже): при любом сбое fetch runner теряет класс ошибки, поэтому и evidence, и cleanup-gate не могут отличить
  сбой фазы установления соединения (когда ни один байт запроса не отправлен) от сбоя после отправки.

## Что изменено

Новый пакет-кандидат `D:/projects/finapp/.runtime/m1-r4-staging` (копия consumed R3 + изменения; **PREPARED_NOT_AUTHORIZED, допуска на запуск не даёт**), его исходники закоммичены побайтно
в `docs/remediation/evidence/M1-SAFE-STOP-RECOVERY-01/runner-r4-source/` (`CODE-SHA256SUMS.txt`, `.gitattributes * -text`), патч относительно R3 — `r3-to-r4.patch`
(применяется к R3 командой `patch -p1 --binary` и даёт файлы R4 побайтно — проверено, exit 0), хэши — `base-r3-sha256.txt` и `candidate-r4-sha256.txt`. Consumed `m1-r3-staging`,
`m1-stg-r3v5-714d0f91`, `m1-staging-run-714d0f91-v5` не редактировались.

1. `m1-transport.mjs`: чистая функция `classifyFetchError(error)` возвращает замкнутые коды `reasonCode` и `dispatch`. `dispatch = not-dispatched` **только** при доказуемом сбое фазы соединения:
   `UND_ERR_CONNECT_TIMEOUT`; `ECONNREFUSED`/`ENETUNREACH`/`EHOSTUNREACH`/`ENETDOWN`/`ETIMEDOUT` при `syscall=connect`; `ENOTFOUND`/`EAI_AGAIN`/`EAI_FAIL` при `syscall=getaddrinfo`;
   ошибки проверки TLS-сертификата; `AggregateError` — только если **каждая** попытка провалилась в connect. Всё остальное (`ECONNRESET`, `UND_ERR_SOCKET`, таймауты ответа, собственный abort `TimeoutError`,
   ошибка неизвестной формы, `ETIMEDOUT` вне connect) остаётся `unknown` (fail closed). Текст reason прежний (`network failure POST accounts`); добавлены `reasonCode`, `dispatch`, `elapsedMs`
   (числа/закрытые коды: URL, host, текст и stack исходной ошибки не сохраняются). Повторов нет (один `fetch`, тест-контракт). Таймаут запроса 30 с; тест может сократить его (100–30000 мс).
2. `m1-core.mjs`: `Stop` несёт `reasonCode/dispatch/elapsedMs`; новый kind `transport-not-dispatched` и закрытый набор `PRE_DISPATCH_REASON_CODES`; kind входит в `CLEANUP_SAFE_STOP_KINDS`.
3. `m1-smoke.mjs` (seed): после `AUTH_CREATE_MAY_BE_SENT` (intent-before-dispatch сохранён) при **доказанном** отсутствии отправки журналируется `AUTH_CREATE_NOT_DISPATCHED` (аналогично `CREATE_COMPANY_NOT_DISPATCHED`);
   `MODE_STOP` и result-файл содержат `reasonCode/dispatch/elapsedMs`. Cleanup-gate: **G2** — kind `transport-not-dispatched` безопасен только при `dispatch=not-dispatched` и коде из набора;
   **G3** — создание без записанного идентификатора считается разрешённым только событием-доказательством для того же ключа, идущим **непосредственно** после intent, с кодом из набора.
   **G4** (live lookup точного синтетического субъекта и сверка с manifest) не менялся и остаётся backstop: найденный аккаунт без uid в manifest отказывает cleanup.
4. `m1-orchestrator.ps1` и тесты: только новые имена evidence/run (`m1-stg-r4-714d0f91`, `m1-staging-run-714d0f91-v6`) и отдельные рабочие каталоги (`m1-r4-rehearsal`, `m1-r4-mutants*`, `m1-r4-direct-`),
   чтобы кандидат не пересекался с consumed. Логика orchestrator не менялась.

**Это уточнение политики cleanup-gate, а не только исправление опечатки:** после доказанного сбоя фазы соединения cleanup может завершиться с нулём удалений и пройти verify-clean (до исправления —
всегда `CLEANUP_REFUSED`). Решение принять эту политику (либо ограничиться диагностикой без разблокировки cleanup) — за аудитором.

**Что исправление НЕ делает:** не устраняет первопричину сетевого сбоя (она не установлена; по аудиту на машине активен VPN — это факт окружения, не доказанная причина); не доказывает, что старый
запрос не был отправлен; не добавляет retry; не переклассифицирует старый run. Ошибка получения operator-токена до fetch (`await operatorHeaders()`) по-прежнему даёт `unexpected` и отказ cleanup (вне scope).

## Почему изменения входят в текущий пункт
Задание: установить причину остановки по артефактам, воспроизвести offline, исправить подтверждённый дефект runner/adapter/sanitizer, подготовить проверяемую версию и обновить описание совместимости.

## Затронутые файлы
- `docs/remediation/evidence/M1-SAFE-STOP-RECOVERY-01/` — `runner-r4-source/` (151 файл), `r3-to-r4.patch`, `base-r3-sha256.txt`, `candidate-r4-sha256.txt`, `before-after/*`, `verification-run-summary.txt` (историческая, помечена), `.gitattributes`;
  Corrections V1: `tooling/` (results-tools, finalize-results, verify-driver, make-snapshot.sh, tooling-tests, run-all-r4.legacy.sh), `offline-fence/` (loopback-only.cjs, recorder-stub.cjs, fence-selftest.cjs, isolated-env.mjs, emulator-session.mjs, network-sample.mjs, run-fenced-integration.mjs, offline-fence-tests.mjs),
  `rollout/` (rollout-steps.json, tabletop-check.mjs, tabletop-tests.mjs), `corrections-v1/` (санитизированные результаты)
- `docs/remediation/runbooks/M1-COMPATIBILITY-ROLLOUT-20261007.md` — матрица совместимости и rollout/rollback proposal
- `docs/remediation/reports/M1-SAFE-STOP-RECOVERY-01.md` — этот отчёт; `docs/remediation/EXECUTION_STATE.md` — запись checkpoint
- Код приложения (`src/`, `functions/`, `firestore.rules`) **не менялся**.
- Вне репозитория (не в diff PR): `.runtime/m1-r4-staging` (копия снимка), результаты прогонов.

## Критерии приемки
- [x] причина STOP восстановлена по durable evidence и исходникам; неустановленное отделено от установленного
- [x] воспроизведено offline: старый runner (R3) — `cleanup` отказывает с **тем же** текстом, что в реальном run (`G2 STOP in seed of kind transport; G3 auth user admin may exist without recorded uid`)
- [x] regression до/после; исправление минимальное, fail-closed на неизвестном исходе, no-retry, intent-before-dispatch, journal/fsync сохранены
- [x] исправленные helpers/source/regression входят в Git diff (побайтный снимок + patch + SHA), не только `.runtime`
- [x] компатибильность и rollout/rollback proposal для staging и production, с allowlists, проверками и откатом
- [x] regression «запрет users list не ломает вход» включён в проверки релиза (G1) и выполнен локально (`test:rules` 153/153)
- [ ] CI на точном финальном HEAD — фиксируется вне файла (см. выше): сообщение передачи и комментарий PR
- [ ] первопричина сетевого сбоя — не установлена и не устранена (не входит в блок)

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| `git status --short` / `git rev-parse HEAD` (pr28-fix) | PASS | 0 строк; `714d0f91c60a582ee87dc7da82d6249b3106329f` |
| `node tests/transport-classification-tests.mjs` (R4) | **PASS 27/27**, exit 0 | до исправления (тот же файл против R3): **FAIL, 4/27** (`before-after/before-transport-classification.OLD-R3.txt`); 4 прошедших — инварианты, которые обязаны сохраняться (фиксированный reason, нет утечки, no-retry) |
| `node tests/seed-stop-recovery-emulator.mjs` (R4, эмуляторы Auth+Firestore) | **PASS 13/13**, exit 0 | до исправления против R3: **FAIL, 2/8**; сценарий s1 — cleanup exit 3 с реальной причиной G2/G3 (`before-seed-stop-recovery.OLD-R3.txt`) |
| `node tests/mutation-checks-recovery.mjs` | **PASS 17/17** | обнаружены все мутации классификатора и ворот G2/G3/G4 (ECONNRESET как pre-dispatch, syscall не требуется, abort как pre-dispatch, Aggregate any/all, всё pre-dispatch, утечка текста, второй fetch, нет elapsed, не-смежное/неверное доказательство, plain transport безопасен, G2 proof, G4 backstop, мёртвый recovery) |
| `tests/ps51-parse-check.ps1` | PASS (4 файла) | PowerShell 5.1.19041 |
| `node tests/node-helper-tests.mjs` | PASS 202/202 | |
| `node tests/export-poll-tests.mjs` | PASS 47/47 | |
| `ps51-orchestrator-tests.ps1 -Set helpers / stub / emulator` | PASS 44/44; 763/763; 52/52 | emulator-набор — на живых эмуляторах (auth+firestore+functions, demo-проект). Этот полный прогон шёл **без** изоляции credentials и без сетевого аудита (Functions-эмулятор залогировал ADC-предупреждение): zero egress для него не доказывается и ретроспективно не заявляется — см. CR2 |
| `node emulator-cleanup-gate-tests.mjs` | PASS 20/20 | существующие ворота G0–G5 не ослаблены |
| `node tests/direct-emulator-smoke.mjs` | PASS (chain exit 0) | readiness→preflight→seed→ui→api→ui-r3→cleanup→verify-clean на эмуляторе |
| `node tests/mutation-checks.mjs` / `-extra` / `-export` | PASS 28/28; 1/1; 20/20 | прежние наборы мутаций на кандидате |
| `node ui-route-policy-tests.mjs`; `local-acl-webconfig-tests.mjs` | PASS 82/82; 10/10 | |
| `patch -p1 --binary < r3-to-r4.patch` на копии R3, затем `diff -rq` с R4 | PASS (0 расхождений кроме `CODE-SHA256SUMS.txt`) | |
| `sha256sum -c CODE-SHA256SUMS.txt` в закоммиченном снимке | PASS (все OK) | 149 файлов |
| `npm run lint` | PASS, 0 errors, 1 warning | warning существовал в base |
| `npm run typecheck` | PASS | |
| `npm run test:unit` (`vitest run src`) | PASS 357/357 (25 файлов) | |
| `npm run test:rules` (Rules emulator, hash-pinned Rules PR #28) | PASS 153/153 (2 файла) | в том числе `users` list: `assertFails`; интеграция authStore↔Rules |
| `npm run build` | PASS | |
| `npm run test:run` | NOT AVAILABLE | скрипта нет в `package.json` (есть `test:unit`); `npm run test:e2e` — **NOT AVAILABLE**, скрипта нет |
| `git diff --check` (рабочее дерево) | PASS, exit 0 | **первый проход проверял только рабочее дерево, а не диапазон** — REVIEW V1 (CR3) воспроизвёл `git diff --check 714d0f91..48b9b54` = exit 2; исправление и проверка диапазона — в разделе Corrections V1 (CR3) |
| `git diff --check 714d0f91c60a582ee87dc7da82d6249b3106329f..HEAD` | см. Corrections V1 (CR3) | проверяется на всём диапазоне BASE..HEAD, не на рабочем дереве |

Полные команды и exit codes исходного прогона кандидата — `verification-run-summary.txt` (**историческая запись**, помечена как superseded: она содержит одновременно `secretPatternHits=1` и `RUN_ALL_R4_DONE`; драйвер `run-all-r4.legacy.sh` не отслеживал exit codes — см. CR1). Прогоны, перечисленные выше как PASS, не отзываются; общий вердикт того прогона — не PASS. `npm ci` не запускался: `node_modules` — junction на `node_modules` идентичного checkout PR #28 (тот же HEAD, `package-lock.json`), без сетевой установки.

### Фактический вывод существенных тестов (сокращённо)
```text
OLD R3  s1 RECOVERY: cleanup=3 failures=[2,"cleanup: refused without deletes: G2 STOP in seed of kind transport; G3 auth user admin may exist without recorded uid"]
R4      s1 seed  : exit 2, kind transport-not-dispatched, reasonCode connect-timeout, journal: AUTH_CREATE_MAY_BE_SENT -> AUTH_CREATE_NOT_DISPATCHED -> MODE_STOP
R4      s1 RECOVERY: cleanup exit 0 (0 documents, 0 auth users deleted), verify-clean exit 0
R4      s2 (account created, answer lost: ECONNRESET after delivery): kind transport, dispatch unknown, NO proof event; cleanup exit 3; account still present
R4      s3 (LYING classification, account exists): cleanup exit 3 by G4; account still present
R4      s5..s9 (proof missing / wrong code / plain-transport kind / dispatch!=not-dispatched / proof not adjacent): cleanup exit 3 (G3/G2)
real Node fetch (loopback): closed port -> connection-refused, not-dispatched; server read the request then reset -> dispatch unknown (server saw 1 request); hang -> abort-timeout, unknown
```

## Corrections V1 (REVIEW V1 = CHANGES_REQUIRED, CR1–CR4)

Только локальные изменения в той же ветке и Draft PR; live Firebase/VDS/provider-вызовов, staging replay, cleanup/export, production, deploy и merge не было. Все новые файлы — в
`docs/remediation/evidence/M1-SAFE-STOP-RECOVERY-01/` (`tooling/`, `offline-fence/`, `rollout/`, `corrections-v1/`). Исходный runner (кроме коллектора результатов) не менялся.

### CR1 — целостность evidence и итоговый exit code
- **Источник находки.** Ключ `password` (значение — плейсхолдер `<omitted>`, 3 вхождения) в `fixtureSnapshot` recovery-manifest сценария `rules-failure-round2-rollback-fails`; runner сам пишет плейсхолдер в приватный manifest
  (`m1-smoke.mjs:466`, не менялся), прежний коллектор копировал файл как есть, а сканер (правильно) ловил ключ. Реальный секрет не обнаружен; значения не печатались, сырой fixture не загружался.
- **Исправление в коде сбора** (`runner-r4-source/tests/collect-results.mjs`, часть снимка пакета), а не правка одного файла: `--base` обязателен (жёсткого пути больше нет), `--out` только внутри `<pkg>/results`; каждый `.json/.jsonl` парсится, ключи с именами
  credentials (`password`, `secret`, `apiKey`, `id/access/refresh_token`, `authorization`, …) **удаляются структурно** вместе со значением; непарсируемый `.json` прерывает сбор (fail closed); непарсируемая строка `.jsonl`
  (журналы `smoke-api-corrupt*` портятся намеренно) сохраняется дословно, только если не содержит секретных паттернов, иначе заменяется маркером. Исходные rehearsal-файлы не меняются; файлы без credentials копируются байт-в-байт.
  Regex/allowlist сканера **не ослаблялись** (тест фиксирует исходный набор и совпадение паттерна коллектора с паттернами сканера).
- **Версионируемые инструменты** (вместо неотслеживаемых скриптов из `.runtime`): `tooling/results-tools.mjs` (scan/redact/sums/verify, привязка к одному каталогу `m1-r[4-9]-*`, отказ для consumed `m1-r3-staging`, отчёт только file+kind),
  `tooling/finalize-results.mjs` (collect → redact → scan → hash → verify → code-sums; первый сбой даёт ненулевой код и маркер `RESULTS_FINALIZE_FAILED`, успех — только `RESULTS_FINALIZED`),
  `tooling/verify-driver.mjs` (все шаги, exit code решает; ожидаемая PASS-строка и полнота `x/y` обязательны; `VERIFY_ALL_PASS` только при полном успехе), `tooling/make-snapshot.sh` (воспроизводимая сборка снимка/patch/хэшей с проверкой apply+byte compare).
  `redact-results.mjs` (жёстко привязан к `m1-r3-staging/results` и поэтому ничего не редактировал для R4) заменён; `run-all-r4.sh` сохранён как `tooling/run-all-r4.legacy.sh` с пометкой «не использовать». Старые consumed results не редактировались (тест хэшей).
- **Побочная находка.** В двух JSON-результатах первого прогона R4 были пути с именем пользователя Windows (старый redact его не трогал); новый инструмент редактирует имя в целевых results и **проверяет** отсутствие (`userNameHits`).
- **Исторический вывод первого прогона** (`verification-run-summary.txt`) оставлен без изменений, но помечен как superseded: он содержит `secretPatternHits=1` вместе с `RUN_ALL_R4_DONE`; общий вердикт того прогона — не PASS.
- **Тесты** `tooling/tooling-tests.mjs` — 26/26 (синтетические данные): структура с password-ключами не попадает в публикуемую копию; контроль «без санитайзера» ловится сканом; fixture не копируется; источник не меняется; abort на непарсируемом `.json`; маркер/withhold строк `.jsonl`;
  отказ при неверном/consumed target, старый каталог не меняется; sums/verify; `finalize` и CLI — hit даёт exit 2 и отсутствие success-маркера; драйвер: PASS-текст при ненулевом exit — FAIL, неполный `x/y` — FAIL, один упавший шаг среди прошедших — `VERIFY_ALL_FAILED` и ненулевой exit процесса.
- **Актуальный scan** (`corrections-v1/results-finalize.txt`): `collected cases=113 files=2727 sanitizedFiles=1 droppedCredentialKeys=password:3`, `secretPatternHits=0 userNameHits=0`, `results files=2754`, `M1_SUMS_VERIFIED files=149`, `RESULTS_FINALIZED`, exit 0.

### CR2 — доказуемый offline-прогон (ограниченный)
- **Что признано.** Исходный полный прогон не имел изоляции credentials и сетевого аудита; ADC-предупреждение Functions-эмулятора остаётся фактом. Zero egress для него **не заявляется** (и ретроспективно не доказывается).
- **Новый контроль** (`offline-fence/`): `isolated-env.mjs` — default-deny allowlist переменных окружения; `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `HOME`, `XDG_*`, `CLOUDSDK_CONFIG`, `TEMP` указывают на пустые каталоги под рабочим корнем; `GOOGLE_*`, `FIREBASE_TOKEN`, `GH*`, `AWS_*`, прокси,
  чужой `NODE_OPTIONS` отбрасываются; проект `demo-finapp`. `loopback-only.cjs` — preload для каждого Node-процесса (`NODE_OPTIONS`): блокирует всё, кроме loopback, в `net.Socket.connect` (net/tls/http/https/undici), `dns.lookup`, `dns.resolve*`/`reverse` (+promises), `fetch`, `dgram`;
  без `M1_FENCE_LOG` дочерний процесс не стартует (fail closed). Не менялись системные настройки, Execution Policy, firewall, файлы credentials владельца.
- **Контроль проверяется тестом** (`offline-fence/offline-fence-tests.mjs` — 17/17): окружение (ни одна credential-переменная не выживает; `firebase-tools` в изолированной среде не находит default account и аккаунтов — 0); self-test fence в режиме recorder (31 проверка: внешние попытки по всем API блокируются и не доходят до сетевого слоя,
  дочерний Node-процесс наследует fence, лог без URL/query) и live-loopback (4); **8 негативных контролей** — мутанты fence (каждый guard удалён по очереди) обнаруживаются self-test'ом, при этом ни один не может отправить трафик (recorder-заглушка).
- **Существенный сценарий повторён однократно** (`offline-fence/run-fenced-integration.mjs`): эмуляторы Auth+Firestore (`demo-finapp`, Rules SHA-256 `c4fe4c09…19fd`) в изолированной среде, регрессия `seed-stop-recovery-emulator.mjs` — **PASS 13/13, exit 0** (119 с). Санитизированный результат — `corrections-v1/network-result.json`:
  fence — 157 событий в 23 Node-процессах: 156 loopback/local, **1 заблокировано** (старт Firebase CLI → `firebase-public.firebaseio.com`; запрос теста/runner'а не к провайдеру), разрешённых внешних — 0; JVM (наблюдение, не enforcement) — 38 выборок TCP, 186 установленных loopback-соединений, **0 внешних**;
  `credentialEnvNamesPresent: []`; остановлено только дерево собственного процесса (2 процесса), порты освобождены. Provider-запросов и мутаций нет (в тесте нет вызовов к проектам; fence блокирует любые).
- **Использован независимый результат аудитора** (addendum 2026-10-08: HEAD `48b9b54`, PASS 13/13, fence Node-API, 157 loopback/6 blocked, Java не fenced, Functions не запускался): его покрытие совпадает с описанным здесь, поэтому количество прохождений unchanged-регрессии не повторялось в других сочетаниях; восполнен существенный недоказанный участок — версионируемый и проверяемый тестом контроль.
- **Что НЕ заявляется:** JVM эмуляторов не fenced (только выборочное наблюдение TCP; UDP и промежутки между выборками не покрыты); Functions-эмулятор в этом повторе не запускался; не-Node процессы и native add-ons вне fence; результат не распространяется на другие прогоны.

### CR3 — проверка diff на всём диапазоне
- Воспроизведено: `git diff --check 714d0f91..48b9b54` → exit 2 (12 строк контекста в `r3-to-r4.patch` — одиночный пробел как маркер контекстной строки unified patch — и trailing space в строке 74 runbook). Первый проход проверял только рабочее дерево и ошибочно заявил PASS.
- Исправлено: пробел в runbook удалён; в `evidence/…/.gitattributes` добавлено **единственное** узкое правило `r3-to-r4.patch -whitespace` (с комментарием); все остальные файлы диапазона и CI проверяются. Байты patch не менялись правилом: `patch -p1 --binary` на копии R3 + регенерация code sums даёт R4 побайтно
  (`PATCH_APPLY_BYTE_COMPARE_OK modified=11 new=7`), снимок совпадает с пакетом (`SNAPSHOT_BYTE_COMPARE_OK files=149`) — `tooling/make-snapshot.sh`.
- Проверка диапазона: `git diff --check 714d0f91c60a582ee87dc7da82d6249b3106329f..HEAD` — результат и exit code приложены в сообщении-передаче для точного финального HEAD (`corrections-v1/checks.txt` — вывод `tooling/run-correction-checks.sh` на HEAD с этим отчётом, до коммита самого файла `checks.txt`; на точном финальном HEAD проверка повторена).

### CR4 — выполнимый rollout proposal
- Staging-host `https://stage.aktivmetr.ru/` указан с датой последней проверки аудитора (2026-10-07: 15 файлов совпали с `714d0f91`); новых live-запросов нет; утверждение «адрес не указан» удалено. VDS/Firebase-состояние оформлено как **датированный baseline** (не живое состояние), перечитывается в P0.
- P6 разделён: **P6a** (до merge) — ожидаемый BASE `main` = `6d713fe7…`, ожидаемый HEAD PR, обязательные checks этого HEAD, merge с защитой ожидаемого HEAD, **отдельный допуск на merge**; **P6b** (после merge) — сверка tree `origin/main` с проверенным HEAD, workflow Pages, клиент C2. Равенство tree теперь постусловие.
- Offline table-top: `rollout/rollout-steps.json` (шаги, предусловия, допуски, rollback) + `rollout/tabletop-check.mjs` (воспроизведение порядка и предусловий, сверка с таблицей runbook) → `ROLLOUT_TABLETOP PASS steps=8 violations=0`; `rollout/tabletop-tests.mjs` — 19/19 (перестановка P3/P4, tree-равенство как предусловие P6a, отсутствие BASE/checks/допуска merge, общий допуск, шаг меняет Rules или возвращает legacy-клиент, rollback P4 не возвращает C1 hotfix, нет stage-host/даты, устаревшая фраза в runbook).
- VDS hotfix C1 остаётся совместимым rollback (`rollback.sh`); legacy-клиент и Rules не возвращаются без отдельного допуска; новый live-run не запускался.

## Security review
- Fail-closed сохранён: pre-dispatch признаётся только по замкнутому списку кодов с проверкой `syscall`; неизвестная форма ошибки, reset, таймауты, собственный abort — `unknown`, cleanup отказывает.
- Две независимые защиты от ошибочной классификации: G3 требует журнал-доказательство, смежное с intent и с кодом из набора; G4 при cleanup повторно ищет точный синтетический субъект и отказывает при найденном аккаунте вне manifest (сценарий s3).
- Журнал и result не содержат URL, host, e-mail, токенов, текста исходной ошибки; тест санитайзера включает «ядовитое» сообщение.
- Allowlist транспорта, ACL приватного run-каталога, no-retry, intent-before-dispatch, fsync/journal не менялись; Rules/Functions/код приложения не менялись; права Firestore не расширялись.
- Тестовые fault-injection preload'ы работают только с эмулятором (`--require` одного процесса) и в пакет исполнения не подключаются.
- Остаточный риск: целостность журнала (его правит процесс одного пользователя) — вне scope; рабочая станция имеет ADC (предупреждение Functions-эмулятора). Первый проход не имел сетевого аудита и утверждение «эмуляторные тесты сетевых вызовов к проектам не делают» не доказывал; Corrections V1 (CR2) добавляет изолированный и fenced повтор существенной регрессии с ограниченным, явно описанным покрытием.

## Данные и миграция
Нет. Эмуляторные данные синтетические (`demo-finapp`), очищались между сценариями. Production/staging данные не читались и не менялись.

## Ручная проверка
Не выполнялась (live-действия запрещены).

## Rollback
Изменения — только документы/снимок исходников в Git; откат — revert коммитов ветки или закрытие Draft PR. Consumed R3 и evidence не менялись; `m1-r4-staging` — локальная копия, её можно удалить.

## Известные ограничения
- Первопричина сетевого сбоя неизвестна и не устранена; исход старого запроса неизвестен.
- Классификатор проверен на реальных формах fetch-ошибок loopback (refused, reset, abort) и на **синтетических** формах undici/Node для connect-timeout, DNS, AggregateError, TLS; реальный connect-timeout до Google не воспроизводился.
- Повторный запуск штатного orchestrator на staging невозможен как есть: шаг 1 требует live Rules round 2, а на staging уже round 3 (`state-rules-target` → STOP); шаги 4–5 экспортируют и деплоят Rules. Нужен smoke-only вариант либо допуск на откат staging Rules (см. runbook §3).
- Production-пакет v6 не готов: `m1p-pins.mjs` справедливо отказывает, пока Rules round 3 live; нужен новый пакет без Rules-окна (runbook §4).
- Staging-host на VDS — `https://stage.aktivmetr.ru/` (известен владельцу; последняя проверка аудитора 2026-10-07: публичный HTTPS отдавал 15 файлов, совпавших с артефактом `714d0f91`). В этом блоке адрес не запрашивался; в первом проходе он был ошибочно записан как «не указан» (исправлено, CR4).
- Корректировки Corrections V1 не устраняют ограничения offline-контроля: JVM эмуляторов не fenced (только наблюдение), Functions-эмулятор в fenced-повторе не запускался, не-Node процессы вне fence (см. CR2).

## Дополнительные находки вне scope
1. Hotfix-ветка `fix/production-login-roster-20261007` не опубликована в GitHub (push отказывал); решение — публикация либо замещение полным клиентом (вне блока).
2. `test:run`, `test:e2e` отсутствуют в `package.json` (CLAUDE.md перечисляет их как обязательные) — зафиксировано как NOT AVAILABLE.
3. `m1-transport.mjs`: сбой получения operator-токена (`await operatorHeaders()`) происходит вне `try` и даёт `unexpected`, а не классифицированный `transport`.
4. GitHub Pages клиент `main` (C0) в production ломается при canonical Rules (users list запрещён) — пока `main` не обновлён, Pages-вход не работает.

## Diff summary
```text
(см. `git diff --stat 714d0f91..HEAD` в описании PR)
```

## Следующий разрешенный пункт
- По решению аудитора после независимой проверки. Не начинать.
