# v5 — четыре оставшихся чтения staging (PREPARED_NOT_AUTHORIZED)

Candidate: D:/projects/finapp/.runtime/m1-recon-readonly-staging-v5.
Task: M1-STAGING-RECON-REMAINDER-PREP-05.
Manifest SHA256:a2d87a381386fa7906f32504c5df336a6865b22461895298ce7edc07a3923ebf.
Namespace: .runtime/m1-stg-readonly-recon-05, свободный и одноразовый.
Consumed03/04 не удалять, не переименовывать и не использовать вновь.

1. Завершить local byte audit/проверки/exact-head CI и записать точный review.
2. После готовности пакета владелец обновляет вход установленным CLI в своём
   обычном PowerShell, под тем же Windows-профилем/configstore, который
   использует будущий bootstrap. Это действие владельца с config write и
   auth-network, отдельно от read-only permit. Агент сейчас его не выполняет.
3. Получить отдельное согласие на exact v5 bytes/target/operations/namespace.
   Зафиксировать approval reference и короткое окно, обычно1h, максимум2h.
   Permit JSON создавать Node; approvedAt/expiresAt — canonical ISO-Z.
   Проверить соответствие original owner record epoch times. Шаблон default-deny.
4. Перед ровно одним dispatch проверить Node24.x, clean exact HEAD,25/25
   source/Git/candidate bytes,manifest,helper hashes,valid permit/free namespace.
   Эта preflight-проверка не читает credentials и не обращается в сеть.
5. Выполнить только4GET Google metadata+одно cached config read в памяти:
   credentialConfigRead/functionsMetadataRead/rulesReleaseRead=true;
   frontendPublicRead/authExactLookup=false. Остаток cached token>=25min.
6. Проверить durable claim/ledger/state/result,exact scope/allowlist/deadline,
   secret scan. Каждый исход после claim расходует namespace, повторов нет.

Штатная CLI-команда владельца, **только после завершения шага1**:

```powershell
node 'D:\projects\finapp\m1-release-714d0f91\node_modules\firebase-tools\lib\bin\firebase.js' login --reauth
```

По исходному коду установленного CLI login --reauth вызывает loginGoogle
и recordCredentials; он сохраняет tokens/expiry. Это локальное чтение кода,
не подтверждение результата нового owner login. Токен не присылать и не печатать.

Цель толькоfinapp-staging,build/source714d0f91c60a582ee87dc7da82d6249b3106329f;
Rules canonicalc4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd.
Точные path/query/field masks/response caps в byte-bound request-allowlist.json.
2GET Cloud Functions v1/v2 metadata,2GET Rules release/ruleset. Не скачивать
архивы/код/IAM; не читать Firestore documents/другие аккаунты. Per-request10s,
global120s/8MiB. Нет pagination,redirect,retry,fallback,refresh/config write.
401/403/unknown/expired/deadline => STOP. execute идёт без fence; окружение
без NODE_OPTIONS/emulator/stub/FIREBASE_TOKEN/GOOGLE_APPLICATION_CREDENTIALS;
proxy variables удаляются только из child env, Windows/VPN не меняются.

Future command, **сейчас не разрешён**:

```powershell
node 'D:\projects\finapp\.runtime\m1-recon-readonly-staging-v5\recon.mjs' execute --permit '<отдельно утверждённый permit.json>'
```

Ограничения прежние: Date.now(),непрерываемый syscall,node.exe вне manifest,
integrity внутри процесса,failed-bootstrap configReads counter. При STOP
credential-too-old raw configReads0 не означает отсутствие cached-config read.
Ни одно наблюдение не даёт STAGE_PASS/Auth absence/full release acceptance.
S1b/readiness/mutations/cleanup/export/production/deploy/merge требуют других решений.
