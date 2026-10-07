# M1-SAFE-STOP-RECOVERY-01 — SAFE_STOP staging-run: причина остановки, regression, recovery-путь, совместимость

## Итоговый статус
READY_FOR_REVIEW (RESULT: READY_FOR_AUDIT). Блок полностью локальный: новых live-запусков, provider-вызовов, cleanup, merge и deploy не было.
Статус не закрывает SEC-007/010/011 и не означает готовность релиза к production. Результат CI на точном финальном HEAD указан в сообщении передачи и в комментарии Draft PR, а не здесь: правка отчёта меняла бы проверяемый HEAD (CI на pull_request для base не `main` автоматически не запускается — запуск вручную через `workflow_dispatch` на ветке, без секретов и deploy-шагов).

## Branch / commit
- worktree: `D:/projects/finapp/m1-safe-stop-recovery-01`; ветка `remediation/M1-SAFE-STOP-RECOVERY-01-runner-recovery`
- base (exact PR #28 HEAD): `714d0f91c60a582ee87dc7da82d6249b3106329f`; `D:/projects/finapp/pr28-fix` на момент сверки на том же HEAD, `git status --short` пуст (0 строк), не изменялся
- коммиты: `096be8c` (исходники runner, patch, evidence), `ed2738d` (compatibility/rollout proposal), `11a4675` (дополнение к нему), затем коммит отчёта и checkpoint; финальный HEAD = коммит, содержащий этот файл; его SHA и URL Draft PR — в сообщении-передаче и в описании PR (SHA коммита не может быть записан внутри самого коммита)
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
- `docs/remediation/evidence/M1-SAFE-STOP-RECOVERY-01/` — `runner-r4-source/` (151 файл), `r3-to-r4.patch`, `base-r3-sha256.txt`, `candidate-r4-sha256.txt`, `before-after/*`, `verification-run-summary.txt`
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
| `ps51-orchestrator-tests.ps1 -Set helpers / stub / emulator` | PASS 44/44; 763/763; 52/52 | emulator-набор — на живых эмуляторах (auth+firestore+functions, demo-проект) |
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
| `git diff --check` | PASS | |

Полные команды и exit codes прогона кандидата — `verification-run-summary.txt` (`run-all-r4.sh`). `npm ci` не запускался: `node_modules` — junction на `node_modules` идентичного checkout PR #28 (тот же HEAD, `package-lock.json`), без сетевой установки.

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

## Security review
- Fail-closed сохранён: pre-dispatch признаётся только по замкнутому списку кодов с проверкой `syscall`; неизвестная форма ошибки, reset, таймауты, собственный abort — `unknown`, cleanup отказывает.
- Две независимые защиты от ошибочной классификации: G3 требует журнал-доказательство, смежное с intent и с кодом из набора; G4 при cleanup повторно ищет точный синтетический субъект и отказывает при найденном аккаунте вне manifest (сценарий s3).
- Журнал и result не содержат URL, host, e-mail, токенов, текста исходной ошибки; тест санитайзера включает «ядовитое» сообщение.
- Allowlist транспорта, ACL приватного run-каталога, no-retry, intent-before-dispatch, fsync/journal не менялись; Rules/Functions/код приложения не менялись; права Firestore не расширялись.
- Тестовые fault-injection preload'ы работают только с эмулятором (`--require` одного процесса) и в пакет исполнения не подключаются.
- Остаточный риск: целостность журнала (его правит процесс одного пользователя) — вне scope; рабочая станция имеет ADC (предупреждение Functions-эмулятора), эмуляторные тесты сетевых вызовов к проектам не делают, но это не проверено сетевым аудитом в этом блоке.

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
- Адрес staging-host на VDS в исходных данных не указан (адрес не придуман).

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
