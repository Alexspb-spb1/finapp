# Task05 — подготовка v5 для оставшихся четырёх чтений staging

Статус: **PREPARED_NOT_AUTHORIZED**. Только локальная подготовка; live-решение
на новый пакет и namespace оформляется отдельно после итоговых проверок и CI.
Итоговый локальный вердикт и exact-head CI фиксируются в `.runtime` без
изменения проверенного HEAD. Этот отчёт не объявляет текущий live-state.

Принятый v4 (Task04 HEAD99407f21f81bf201e5ef9ff58398dadce00397bf) запущен
один раз2026-10-09T18:30:06Z и получил STOP credential-too-old до первого
Google запроса. Namespace04 consumed. V3 ранее проверил17публичных GET
frontend2026-10-09T14:52:49Z и тоже остановился перед Google metadata.
Оригиналы двух запусков, их аудиты и прежние кандидаты сохраняются.

Новый snapshot25файлов воспроизводится tooling/build-remainder.mjs из
точного принятого v4. В кандидате меняются ровно recon-pins.mjs и manifest:
taskId=Task05, evidenceName=m1-stg-readonly-recon-05, consumedNames добавляет04.
Движок/bootstrap/integrity/permit/allowlists/deadline/sanitizer/тесты неизменны;
приложение, Functions, Rules и workflows не меняются.

Candidate: D:/projects/finapp/.runtime/m1-recon-readonly-staging-v5.
CODE-SHA256SUMS.txt: a2d87a381386fa7906f32504c5df336a6865b22461895298ce7edc07a3923ebf.
One-use namespace: D:/projects/finapp/.runtime/m1-stg-readonly-recon-05.
Он не создан. APPROVED permit и live-запуск не создаются этой подготовкой.

Applicable local audit:153negative controls,60mutations с baseline/canary,
11remainder controls,offline selftest/plan/permit-draft и воспроизводимость.
Новые scoped controls отказывают старым v3/v4 byte bindings и consumed03/04,
проверяют4GET без frontend/Auth, явный credential permit,0HTTP при expired
bootstrap,403 без refresh/retry и canonical UTC-Z даты. Все тесты в своей
копии, с synthetic owner profile, loopback fence и durable output.
Итоговые evidence: .runtime/auditor-recon-remainder-20261009-02/.

Предлагаемые future operations: credentialConfigRead=true,
functionsMetadataRead=true,rulesReleaseRead=true;frontendPublicRead=false,
authExactLookup=false. Только finapp-staging:2Functions v1/v2 metadata GET
и2Rules release/ruleset GET. Release/source714d0f91c60a582ee87dc7da82d6249b3106329f;
Rules canonicalc4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd.
Это pins для сравнения, не текущие ответы Google.

Сначала завершить подготовку/аудит/CI. Затем владелец отдельно обновляет CLI
login штатным установленным firebase-tools под тем же Windows-профилем,
непосредственно перед решением о запуске. Ожидать пользователя во время
подготовки не требуется; owner credential сейчас не читается и не обновляется.
Будущий permit формируется только после явного решения на exact bytes;
UTC-строки создаются Node Date.toISOString(), без PowerShell date conversion.
Зафиксировать исходное сообщение и те же epoch instants окна<=2h.

Ограничения v3/v4 сохранены: Date.now(), непрерываемый начатый syscall,
node.exe вне manifest, integrity внутри процесса после загрузки modules.
При failed bootstrap raw configReads=0 считает только successful returns,
а credential-too-old достигается после одного фактического cached-config read.
Старые результаты не переписываются задним числом.

Никаких новых live/API/credential действий. S1b/readiness/Auth lookup/
Firestore mutation/inventory/cleanup/export/production/deploy/merge не входят.
Никакого STAGE_PASS/full release acceptance/Firebase или VPN independence.
Последний Google metadata/production baseline2026-10-07; frontend наблюдался
2026-10-09 в отдельном v3 запуске. Автоматизация остаётся PAUSED.
