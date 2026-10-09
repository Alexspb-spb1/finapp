# Завершение read-only сверки staging v4 — PREPARED_NOT_AUTHORIZED

Пакет создан после consumed v3 STOP, а не для автоматического повтора.
Точный manifest: `af4aef5c35cb58a2b03f074d39e34a2a10d34afcbc8e7d9abfaf51d8510e67b6`.
Кандидат: `D:/projects/finapp/.runtime/m1-recon-readonly-staging-v4`.
Task ID: `M1-STAGING-RECON-REMAINDER-PREP-04`.

Офлайн-команды (fenced, без owner profile):

```powershell
node 'D:\projects\finapp\.runtime\m1-recon-readonly-staging-v4\recon-offline.mjs' selftest
node 'D:\projects\finapp\.runtime\m1-recon-readonly-staging-v4\recon-offline.mjs' permit-draft
```

Будущий запуск, сейчас не разрешён:

```powershell
node 'D:\projects\finapp\.runtime\m1-recon-readonly-staging-v4\recon.mjs' execute --permit '<абсолютный путь отдельно утверждённого permit.json>'
```

Перед ним: независимый review и applicable exact-head CI, manifest/actual
bytes, чистота source, Node24.x, свободный `m1-stg-readonly-recon-04`,
отдельное решение/permit, cached Firebase CLI token >=25 минут.
Child environment без NODE_OPTIONS/proxy/EMULATOR/FIREBASE_TOKEN/stub.
Системные VPN/Windows настройки не меняются этим пакетом.

Предлагаемый permit: credentialConfigRead=true, functionsMetadataRead=true,
rulesReleaseRead=true, frontendPublicRead=false, authExactLookup=false.
Операции: 2 GET Functions v1/v2 metadata и 2 GET Rules release/ruleset,
только finapp-staging. Никаких Firestore documents, Auth accounts,
публичных frontend requests, refresh, IAM или code archive downloads.
По одному запросу на path, без pagination/redirect/retry/fallback.
Per-request <=10s, всё <=120s; общий byte cap8MiB сохранён. Permit <=2h.

STOP/401/403/unknown/expired token: записать результат и остановиться;
не продолжать чтения, не обновлять вход, не удалять/переиспользовать evidence.
Коды: 0 match выбранных pins, 4 differences, 2 STOP, 3 INIT_REFUSED.
Различия — наблюдения для аудитора, а не допуск на изменение окружения.

Evidence: recon-claim.json, recon-ledger.jsonl, recon-state.json,
recon-result.json под `.runtime/m1-stg-readonly-recon-04/`.
Проверить request IDs/allowlists/pin hashes, durable INTENT→RESULT,
remaining deadline, отсутствие refresh/config write и secret scan.
Для credential failure учитывать documented successful-bootstrap counter
semantics; configReads=0 не означает отсутствие фактического file read.

Owner decision template:

```text
Пакет: v4, manifest af4aef5c35cb58a2b03f074d39e34a2a10d34afcbc8e7d9abfaf51d8510e67b6
Target: finapp-staging, build/source714d0f91; Rules canonical c4fe4c09…19fd
Namespace: m1-stg-readonly-recon-04
Выбор: credentialConfigRead + functionsMetadataRead + rulesReleaseRead
Не выбраны: frontendPublicRead, authExactLookup
Approval reference: ____ ; начало UTC ____ ; конец UTC ____ (<=2h)
No refresh/config write; no retry; STOP on unknown; observations only.
```

S1b/production/merge/deploy/cleanup и иные операции требуют других решений.
