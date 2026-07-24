# Runbook — резервное копирование и восстановление production Firebase

```text
TASK_ID: BASE-003
PHASE: ACCESS SETUP AND RESTORE PROJECT CREATION
STATUS: DOCUMENTATION ONLY — ничего из описанного ниже ещё не выполнялось
```

## Решение владельца (зафиксировано)

```text
OWNER_DECISION: APPROVED
RESTORE_TARGET_OPTION: A
RESTORE_TARGET_TYPE: SEPARATE_TEMP_PROJECT
```

Владелец одобрил Вариант A из раздела 5 этого runbook (отдельный
изолированный temp restore-проект) и подтвердил, что `finapp-staging`
использовать/изменять для восстановления **нельзя**. Прежний блокер
`BLOCKED_RESTORE_TARGET_OWNER_DECISION` снят этим решением. Сам restore-
проект, однако, **ещё не создан** — попытка создания дважды заблокирована
на этапе интерактивной авторизации (`BLOCKED_AUTHENTICATION`, подробности —
`docs/remediation/reports/BASE-003.md`, «Часть 2» и «Часть 3»). Второй
раунд задания утверждал, что работа выполняется «локально на компьютере
владельца» — объективные признаки той же сессии (тот же git-прокси на
`127.0.0.1`, отсутствующий `DISPLAY`, идентичное поведение `gcloud auth
login`) этого не подтвердили: это по-прежнему та же изолированная
удалённая сессия. Раздел 5 ниже (два варианта с рисками) оставлен как
есть — Вариант B по-прежнему описан только как формально допустимый
запасной путь, не рекомендованный и не выбранный.

Этот документ по-прежнему описывает **порядок**, который должен
использоваться, когда `BASE-003` перейдёт к фактическому исполнению —
после закрытия оставшегося блокера (`BLOCKED_AUTHENTICATION`) и раздела 4
(`OWNER_ACTION_REQUIRED` по правам доступа к production, всё ещё
актуально). Сам факт существования этого runbook **не означает**, что
экспорт/восстановление/создание каких-либо cloud-ресурсов уже выполнялись.

## 0. Область действия

- **Затрагивает:** Firebase Authentication и Cloud Firestore проекта
  `finapp-prod-10a83`.
- **Не затрагивает:** клиентский статический бандл (GitHub Pages) — для
  него отдельная rollback-процедура уже описана в
  `docs/remediation/BASELINE.md`, раздел 8 (client-only, не восстанавливает
  Firebase-данные).
- **Firebase Hosting не используется** этим проектом (см.
  `docs/remediation/reports/BASE-003.md`, раздел 2.5-2.6) — поэтому этот
  runbook не описывает Hosting release backup/rollback.

## 1. Что именно бэкапится

| Что | Источник | Формат |
|---|---|---|
| Firestore данные (`users`, `companies`, `company_data`) | `finapp-prod-10a83`, Firestore Native mode | Managed export (LevelDB-формат) в Cloud Storage |
| Firebase Authentication metadata | `finapp-prod-10a83`, Auth | JSON (`firebase auth:export`) |
| Опубликованные Firestore Rules | `finapp-prod-10a83` | текстовый файл правил |
| Опубликованные Firestore indexes | `finapp-prod-10a83` | `firestore.indexes.json` |
| Production клиентский bundle | GitHub Actions run, соответствующий known-good commit | `dist/` (архив) |

## 2. Предварительные условия (перед первым реальным запуском)

Все пункты — `OWNER_ACTION_REQUIRED`, см.
`docs/remediation/reports/BASE-003.md`, раздел 4/5, до выполнения:

1. Аутентифицированный доступ к `finapp-prod-10a83` (read-only на
   preflight-этапе, export-права — только непосредственно перед реальным
   export, с отдельным разрешением).
2. Подтверждённый (или созданный владельцем) Cloud Storage bucket для
   хранения экспорта, с известным регионом и правами доступа.
3. Подтверждённый billing-статус проекта (Firestore managed export/import
   требует Blaze plan).
4. Выбранная цель восстановления (см.
   `docs/remediation/reports/BASE-003.md`, раздел 5, Вариант A или B) —
   **до** первого реального import.
5. Явное разрешение владельца в формате, требуемом `CLAUDE.md` (раздел 5):

   ```text
   PRODUCTION_ACTION_APPROVED: BASE-003
   BACKUP_REFERENCE: <идентификатор проверенной резервной копии>
   ROLLBACK_REFERENCE: <описание/ссылка на проверенный rollback>
   ```

   для **любого** шага, который читает production Firestore/Auth за
   пределами метаданных (сам export — это чтение всех данных), и отдельное
   разрешение конкретно для import в выбранную цель.

## 3. Порядок будущего экспорта

**Ничего из этого раздела не выполнялось в рамках `BASE-003 PRE-FLIGHT`.**

### 3.1 Firestore managed export

```bash
gcloud firestore export gs://<backup-bucket>/<timestamp>/ \
  --project=finapp-prod-10a83 \
  --collection-ids=users,companies,company_data
```

- `--collection-ids` ограничивает export ровно тремя коллекциями,
  фактически используемыми приложением (см.
  `docs/remediation/reports/BASE-003.md`, раздел 2.1) — не «весь проект
  вслепую».
- Операция асинхронная — получить `operation name`, дождаться
  `done: true`, зафиксировать итоговый статус в manifest (см. раздел 6
  отчёта preflight).
- **Не читать содержимое** экспортированных файлов в рамках самой
  операции резервного копирования — только зафиксировать метаданные
  (счётчики документов из ответа операции, не из чтения файлов).

### 3.2 Firebase Authentication export

```bash
firebase auth:export production-auth-export.json --project=finapp-prod-10a83
```

- Результат содержит password hashes/salts/hash parameters —
  **обязательно** хранить вне Git, в зашифрованном/закрытом хранилище с
  ограниченным доступом.
- Сразу после экспорта вычислить `sha256sum production-auth-export.json` —
  значение идёт в manifest, сам файл — в защищённое хранилище, **не в чат,
  не в отчёт, не в коммит**.
- Немедленно удалить локальную копию файла из рабочей директории после
  загрузки в защищённое хранилище (не должна «залежаться» на диске сессии).

### 3.3 Rules / indexes / bundle

```bash
# Rules и indexes — прочитать опубликованные (не локальный emulator-baseline!)
firebase firestore:rules:get --project=finapp-prod-10a83 > production.rules
# indexes — через Console или Admin API эквивалент

# SHA-256 каждого файла — в manifest
sha256sum production.rules production.indexes.json

# Production bundle — пересобрать на известном known-good commit
git checkout <known-good-commit>
npm ci && npm run build
sha256sum -r dist  # или эквивалент, дерево файлов
```

### 3.4 Manifest

Заполнить схему из `docs/remediation/reports/BASE-003.md`, раздел 6.1,
реальными (но не чувствительными) значениями. Сохранить manifest в то же
защищённое хранилище, что и сами файлы бэкапа — **не в Git**.

## 4. Порядок будущего восстановления

1. Выбранная цель (раздел 2, пункт 4) должна существовать и быть готова
   принять Firestore Native mode данные.
2. Import:
   ```bash
   gcloud firestore import gs://<backup-bucket>/<timestamp>/ \
     --project=<restore-project-id>
   ```
3. Import Auth (если восстановление Auth тоже требуется для проверки):
   ```bash
   firebase auth:import production-auth-export.json --project=<restore-project-id> \
     --hash-algo=<алгоритм из экспорта>
   ```
4. Развернуть на restore-проекте **ту же версию** Rules, что была
   зафиксирована в manifest (не более открытую).

## 5. Порядок проверки восстановления

Раздельно по типам данных, все — без чтения/логирования содержимого сверх
необходимого для сравнения (см. дизайн checksums в
`docs/remediation/reports/BASE-003.md`, раздел 6.3):

1. **Компании:** количество документов `companies` в restore-проекте ==
   количество в manifest (Firestore count-агрегация, не полное чтение).
2. **Пользователи:** аналогично для `users`.
3. **`company_data`:** количество документов `company_data` в restore-
   проекте == количество в manifest; дополнительно — открыть **одну**
   заранее согласованную с владельцем тестовую компанию (не случайную) и
   подтвердить, что документ вообще открывается и валиден по схеме
   (`CompanyData`, `src/store/companyStore.ts:21-33`) — не более.
4. **Операции и остатки:** SHA-256 канонической сериализации проекции
   `{companyId, accountId, currency, balance}` (и/или агрегатов операций)
   на source и на restore — сравнить **только хэши**. Совпадение хэшей =
   финансовые данные идентичны после восстановления. Несовпадение — не
   пытаться «нащупать» разницу вручную через посимвольное сравнение сырых
   сумм в логах; локализовать через дальнейшие **под-хэши** по более узким
   срезам (например, по одной компании за раз), не раскрывая абсолютные
   значения без необходимости.
5. Зафиксировать `restore.verifiedAtUtc` и `restore.verificationResult` в
   manifest.

## 6. Rollback (для самой операции backup/restore, не для production)

- Managed export **не изменяет** исходные production-данные — это
  безопасная read-операция, откатывать нечего.
- Managed import **в отдельный restore-проект** (Вариант A) — если
  восстановление окажется неуспешным, самый простой откат — удалить/
  очистить сам restore-проект и повторить попытку; production не
  затрагивается вообще.
- Если когда-либо (отдельной задачей, не `BASE-003`) потребуется реальный
  production restore (например, после инцидента) — это принципиально
  другая, гораздо более осторожная процедура, требующая maintenance-режима,
  проверенного `PRODUCTION_ACTION_APPROVED`, и не описывается этим
  документом (эта задача — только verification restore в изолированную
  цель, не production disaster recovery).

## 7. Хранение и удаление резервных копий

- Backup-артефакты (Firestore export, Auth export, manifest) — **никогда**
  не в Git этого или любого другого публичного репозитория.
- Хранить в Cloud Storage bucket с ограниченным доступом (не публичный),
  с явно определённым сроком хранения (retention) — конкретное число дней
  утверждает владелец, фиксируется в manifest (`storage.retentionDays`).
- Доступ к bucket — минимально необходимому кругу лиц/service accounts,
  зафиксирован в manifest (`storage.accessRoles`).
- По истечении retention — удаление через штатные lifecycle-правила
  bucket (предпочтительно) или ручное удаление с записью факта удаления
  (кто, когда, какой backup) — не молча.
- Локальные временные копии (если экспорт/анализ временно выполнялся на
  чьей-то машине или в сессии агента) — удалять сразу после загрузки в
  защищённое хранилище, не оставлять на диске дольше необходимого.

## 8. Явный запрет

**Backup-артефакты, экспорт Auth, production bundle и manifest с реальными
значениями не хранятся и не должны храниться в Git ни при каких
обстоятельствах.** Если это правило когда-либо нарушится (случайный
коммит), необходимо: немедленно удалить из истории (`git filter-repo`
и т.п.), считать все затронутые credentials скомпрометированными и
инициировать их ротацию (Auth password hashes перевыпустить нельзя —
потребуется force password reset для всех пользователей; API keys/service
account keys — отозвать и перевыпустить).
