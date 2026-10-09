# M1-STAGING-RECON-REMAINDER-PREP-04 — одноразовое завершение сверки staging

Статус: **PREPARED_NOT_AUTHORIZED**. Это локальная подготовка нового пакета;
его live-исполнение требует отдельного решения на точные байты и namespace.
Итоговые локальные результаты, independent audit и exact-head CI фиксируются
в `.runtime/AUDIT_CONTROL_20261007.md` и отдельном review, чтобы не менять HEAD
после проверок. Сам отчёт не объявляет заранее PASS или состояние провайдера.

## Причина и сохранённый результат

Принятый Task03/v3 (package-code HEAD `96927d0c58d1049e21ef26d0127442fbaa16805c`)
выполнен ровно один раз 2026-10-09T14:52:45Z–14:52:49Z по отдельному допуску.
17 публичных GET frontend совпали с pins. Затем STOP `credential-too-old`:
сохранённый токен Firebase CLI не удовлетворял остатку >=25 минут.
Functions/Rules/Auth-запросов было 0; токен не обновлялся.
`m1-stg-readonly-recon-03` consumed и не может быть переиспользован.
Оригинал, его копия и аудит в `.runtime` сохраняются неизменными.

Владелец сообщил «готово» после инструкции обновить вход CLI. Это сообщение
позволяет продолжить локальную подготовку; в этом блоке owner profile не
читается и актуальность токена не утверждается заранее.

## Что изменено

Новый исходный snapshot (25 файлов) в
`docs/remediation/evidence/M1-STAGING-RECON-REMAINDER-PREP-04/package-recon-source/`
воспроизводится `tooling/build-remainder.mjs` из точного Task03 snapshot.
От v3 меняются только `recon-pins.mjs` и manifest:

1. taskId — `M1-STAGING-RECON-REMAINDER-PREP-04`;
2. evidenceName — `m1-stg-readonly-recon-04`;
3. прежний namespace `m1-stg-readonly-recon-03` добавлен в consumedNames.

Движок, bootstrap, permit/allowlist, sanitizer, deadline, claim и все
принятые regression/mutation tests побайтно сохранены. Приложение,
Functions, Rules и workflows не изменены. Старые кандидаты/журналы не
переименовываются, не очищаются, не переклассифицируются.

Кандидат: `D:/projects/finapp/.runtime/m1-recon-readonly-staging-v4`.
CODE-SHA256SUMS.txt SHA256:
`af4aef5c35cb58a2b03f074d39e34a2a10d34afcbc8e7d9abfaf51d8510e67b6`.
Он не запущен. Для исполнения нужно отдельное решение владельца.

## Проверки и воспроизводимость

153 принятых negative controls, 60 weakening mutants с 2 baseline/2 canary,
offline selftest/plan/permit-draft и 8 targeted remainder controls запускаются
в собственной копии, с empty credential/config directories и loopback fence.
Новые controls проверяют 4 GET без frontend/Auth, старые bytes/namespace,
expired bootstrap с 0 HTTP, 403 без refresh/retry, явный credential permit
и default-deny template. Живые namespace не создаются этими тестами.

Durable evidence и audit scripts:
`D:/projects/finapp/.runtime/auditor-recon-remainder-20261009-01/`.
Generator должен дать 25 побайтно идентичных файлов source/candidate/generated;
изменённых относительно принятого v3 файлов должно быть ровно 2.

## Предлагаемое будущее чтение

Только `finapp-staging`, build/source pin `714d0f91c60a582ee87dc7da82d6249b3106329f`,
Rules canonical pin `c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd`.
Operations: credentialConfigRead + functionsMetadataRead + rulesReleaseRead;
frontendPublicRead=false, authExactLookup=false. Всего до 4 GET: Functions
v1/v2 metadata и Firestore Rules release/ruleset. Cached login читается один
раз в памяти, без refresh/config write; остаток токена >=25 минут.

One-use evidence: `D:/projects/finapp/.runtime/m1-stg-readonly-recon-04`.
После любого claim каталог consumed, в том числе при credential STOP.
Запуск требует permit, привязанного к новым manifest/pins/namespace,
операциям и короткому окну. Старый permit не годится.

## Ограничения и приёмка

Сохранены ограничения v3: Date.now(), непрерываемые локальные syscall,
проверка package bytes после загрузки Node modules, node.exe вне manifest,
непроверенное live-поведение Google. В failed-bootstrap результате
configReads=0 отражает только успешно вернувшийся bootstrap; это не
доказательство отсутствия фактического чтения cached config. Старый result
не исправляется задним числом; аудитор явно учитывает это ограничение.

Наблюдение frontend от 2026-10-09T14:52:49Z остаётся отдельным от будущих
Google reads. Сверка не даёт STAGE_PASS, Auth absence, client-access smoke,
production acceptance или Firebase/VPN independence. S1b, readiness,
callable/mutations, inventory/cleanup/export, deploy и merge не входят.

Следующий внешний шаг возможен после проверок/аудита/CI и отдельного решения
владельца на новый точный пакет. Повторов прежнего запуска нет.
