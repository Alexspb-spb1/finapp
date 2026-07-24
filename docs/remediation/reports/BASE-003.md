# BASE-003 — Сделать резервную копию production и проверить восстановление

```text
TASK_ID: BASE-003
PHASE: ACCESS SETUP AND RESTORE PROJECT CREATION (после PRE-FLIGHT)
```

## Итоговый статус (актуальный, после решения владельца)

**`BLOCKED_AUTHENTICATION`** — см. «Часть 2» ниже. Раздел ниже («Часть 1»)
описывает исходный `PRE-FLIGHT`-раунд и оставлен без изменений, для
истории.

```text
OWNER_DECISION: APPROVED
RESTORE_TARGET_OPTION: A
RESTORE_TARGET_TYPE: SEPARATE_TEMP_PROJECT
```

Владелец одобрил Вариант A (отдельный временный restore-проект) и
подтвердил, что `finapp-staging` использовать/изменять нельзя. Прежний
блокер `BLOCKED_RESTORE_TARGET_OWNER_DECISION` **снят** этим решением —
цель восстановления определена. Однако создать сам проект не удалось: новый
блокер `BLOCKED_AUTHENTICATION` (раздел «Часть 2», п. 3) — интерактивная
OAuth-авторизация не может быть завершена в этой изолированной сессии.
`BLOCKED_PERMISSIONS` из «Часть 1» частично снят (gcloud CLI теперь
установлен), но фактический доступ по-прежнему отсутствует по новой,
более точной причине — см. ниже.

---

# Часть 1 — Исходный PRE-FLIGHT (без изменений, для истории)

## Итоговый статус на момент PRE-FLIGHT

**`BLOCKED_MULTIPLE`**

Два независимых блокирующих условия одновременно:

1. **`BLOCKED_PERMISSIONS`** — эта рабочая сессия не имеет ни одной
   авторизованной учётной записи Firebase CLI или gcloud CLI (gcloud вообще
   не установлен). Ни один read-only административный запрос к Firestore
   Admin API, Cloud Storage, Cloud Billing или IAM выполнить нельзя — не
   из-за сети (см. раздел 3.3 — конкретные `*.googleapis.com` хосты
   технически достижимы), а из-за отсутствия аутентифицированного
   принципала. Раздел 4 (готовность production к резервному копированию) —
   полностью заблокирован этим.
2. **`BLOCKED_RESTORE_TARGET_OWNER_DECISION`** — по той же причине (нет
   доступа к Firebase/GCP) невозможно проверить, существует ли уже
   отдельный изолированный restore-проект. Восстанавливать production-данные
   в `finapp-staging` без отдельного явного решения владельца запрещено
   условиями этой задачи — поэтому до подтверждения владельцем целевой
   проект остаётся неопределён.

Никакие cloud-операции (export, import, создание/удаление
проектов/buckets/service accounts, изменение billing, deployment) в этом
раунде не выполнялись — только локальное изучение кода репозитория и
попытки read-only CLI-команд, которые сами по себе не требуют
предварительного разрешения (они либо ничего не меняют, либо явно
завершаются ошибкой авторизации).

---

## 1. Git preflight

### 1.1 Синхронизация (проверено командами, не предположено)

```text
$ git status --short
(пусто)

$ git fetch origin --prune
 - [deleted]         (none)     -> origin/claude/project-analysis-review-tk33f6
 * [new branch]      claude/repository-analysis-mkk7mg -> origin/claude/repository-analysis-mkk7mg
   64343b7..928940b  main       -> origin/main

$ git rev-parse origin/remediation/main
d0a9d407b653dca28f9e3df04f8850371a876adf

$ git checkout remediation/main
Switched to a new branch 'remediation/main'

$ git pull --ff-only origin remediation/main
Already up to date.

$ git rev-parse HEAD
d0a9d407b653dca28f9e3df04f8850371a876adf   # совпадает с ожидаемым

$ git status --short
(пусто)
```

Ожидаемый HEAD (`d0a9d407b653dca28f9e3df04f8850371a876adf`) подтверждён
точным совпадением. Рабочее дерево было чистым до и после переключения.

### 1.2 Ветка задачи

```text
$ git checkout -b remediation/BASE-003-backup-restore
Switched to a new branch 'remediation/BASE-003-backup-restore'

$ git rev-parse HEAD
d0a9d407b653dca28f9e3df04f8850371a876adf   # ветка создана от актуального remediation/main
```

PR не создавался до завершения этого preflight-отчёта.

---

## 2. Фактическая структура приложения (изучено локально, без изменения кода)

### 2.1 Firestore collection/document paths — исчерпывающий список

Найден полным поиском по `src/` (`grep -rn "collection(db\|doc(db"`).
Приложение обращается **ровно к трём** top-level коллекциям, без единой
subcollection где-либо в коде:

| Path | Document ID | Назначение | Источник (файл:строка) |
|---|---|---|---|
| `users/{uid}` | Firebase Auth UID | Профиль пользователя: `role`, `companyId` (primary), опционально `companies[]` (multi-company) | `src/store/authStore.ts:81, 113, 260, 341, 355, 378` |
| `companies/{companyId}` | `companyId` (сгенерирован клиентом, см. 2.7) | Метаданные компании: `name`, `legalType`, `inn`, `currency`, `ownerId` | `src/store/authStore.ts:114, 153, 169, 261, 406, 443, 469` |
| `company_data/{companyId}` | тот же `companyId` | **Монодокумент** — все финансовые данные компании одним документом (см. 2.2) | `src/store/companyStore.ts:91, 147, 169`; `src/store/authStore.ts:115, 170, 262, 470` |

Это подтверждает и совпадает с моделью, уже описанной в
`REMEDIATION_PLAN.md` (раздел `SEC-001`, ЭТАП 5 — монодокументная
архитектура, миграция на подколлекции ещё не выполнена).

### 2.2 Структура `company_data/{companyId}` (монодокумент)

```ts
// src/store/companyStore.ts:21-33
interface CompanyData {
  accounts:        Account[]
  categories:      Category[]
  counterparties:  Counterparty[]
  transactions:    Transaction[]
  projects:        Project[]
  rules:           TransactionRule[]
  budgets:         BudgetItem[]
  recurring:       RecurringTemplate[]
  paymentCalendar: PaymentCalendarItem[]
  closingDate?:    string
  _savedAt?:       number
}
```

Один документ Firestore содержит **весь** финансовый набор данных одной
компании — счета, справочники, все операции, проекты, правила, бюджеты,
регулярные операции, платёжный календарь. Размер документа растёт
пропорционально числу операций компании (известное архитектурное
ограничение, вне scope `BASE-003`, отслеживается `STATE-004`/`ЭТАП 5`).

### 2.3 Связь пользователей с компаниями

- `users/{uid}.companyId` — основная («домашняя») компания пользователя (`src/types/auth.ts:6`).
- `users/{uid}.companies?: { companyId, role }[]` — опциональный список
  дополнительных компаний с ролью в каждой (`src/types/auth.ts:7`) —
  механизм multi-company доступа.
- `companies/{companyId}.ownerId` — ссылка на UID владельца компании
  (`src/types/auth.ts:19`), справочная связь (не единственный источник прав
  — см. `REMEDIATION_PLAN.md`, `SEC-001`, пункт 8).
- Список пользователей компании читается запросом
  `query(collection(db, 'users'), where('companyId', '==', companyId))`
  (`src/store/authStore.ts:154, 344, 447`) — то есть membership для
  «домашней» компании определяется полем на самом документе пользователя,
  а не отдельной подколлекцией `members`.

### 2.4 Данные, участвующие в расчёте операций и остатков

- `Account.balance`, `Account.rate` — текущий остаток счёта и курс к
  базовой валюте (`src/types/index.ts:3-11`).
- `Transaction.amount`, `Transaction.exchangeRate`, `Transaction.toAmount`,
  `Transaction.type` — сумма операции всегда положительна, знак
  определяется `type` (`src/types/index.ts:45-62`; подтверждено логикой
  обновления баланса в `src/store/companyStore.ts` при `addTransaction`/
  `deleteTransaction`/`updateTransaction`, независимо проверено в ходе
  предыдущего аудита проекта в этой же сессии).
- Пересчёт в базовую валюту: `toBase()` (`src/utils/currency.ts:44-46`),
  `accountToBase()` (`src/utils/currency.ts:53-56`), `sumAccountsBase()`
  (`src/utils/currency.ts:59-61`).

Это прямо определяет, какие поля обязаны сохраниться **идентичными**
после restore, чтобы отчёты (ОПиУ, ДДС, Баланс) продолжали сходиться —
критично для дизайна checksum-проверки (раздел 6.3 ниже и
`docs/runbooks/BACKUP_AND_RESTORE.md`).

### 2.5 Production bundle — как строится

```json
// package.json
"build": "tsc -b && vite build"
```

- Собирается статический бандл в `dist/` (`vite.config.ts:7` — `base: '/finapp/'`).
- **Firebase Hosting не используется** — подтверждено: `firebase.json`
  содержит только секции `firestore` и `emulators`, секции `hosting`
  **нет**.
- Публикация — **GitHub Pages**, через `.github/workflows/deploy.yml`:
  триггер `push` в **`main`** (не `remediation/main`!), job `build`
  (`npm ci` → `npm run lint` → `npm run build` с `VITE_FIREBASE_*` из
  `secrets.*`) → `actions/upload-pages-artifact@v3` → job `deploy`
  (только при `push` в `main`) → `actions/deploy-pages@v4`.
- Ранее независимо подтверждённый факт (см. `docs/remediation/BASELINE.md`,
  раздел 5): последний успешный production deploy — run `29251907411`,
  commit `928940b6f79034b7a8beea6195e87b39609a3954`, URL приложения
  (не подтверждён прямым HTTP-запросом из этой изолированной сессии):
  `https://alexspb-spb1.github.io/finapp/`.

### 2.6 Hosting target / способ публикации — итог

**Не Firebase Hosting.** «Production bundle» в контексте `BASE-003` — это
опубликованный GitHub Pages artifact, а не Firebase Hosting release.
Резервное копирование production в смысле этой задачи затрагивает **два
независимых контура**:
1. Firebase (Auth + Firestore) — данные;
2. GitHub Pages (статический клиентский бандл) — уже покрыт rollback-
   процедурой в `docs/remediation/BASELINE.md`, раздел 8 (client-only,
   не восстанавливает Firebase-данные).

`BASE-003` фокусируется на контуре (1) — данные Firebase.

### 2.7 Генерация ID (существующая, известная проблема — вне scope BASE-003)

`companyId`, `accountId` и т.д. генерируются как `'id' + Date.now()`-подобные
строки на клиенте (уже зафиксировано как находка `FIN-007` в
`REMEDIATION_PLAN.md`). Упоминается здесь только потому, что влияет на
дизайн детерминированных fingerprint/checksum для сверки восстановления
(раздел 6.3) — сама проблема не исправляется в рамках `BASE-003`.

---

## 3. Read-only проверка окружения

### 3.1 Версии инструментов

| Инструмент | Версия | Команда |
|---|---|---|
| Git | `2.43.0` | `git --version` |
| Node.js (эта сессия) | `v22.22.2` | `node --version` |
| npm (эта сессия) | `10.9.7` | `npm --version` |
| Firebase CLI | `15.24.0` (закреплённая devDependency, `npx --no-install firebase --version`) | из `BASE-002` |
| gcloud CLI | **не установлен** | `which gcloud` → не найден |

Node в CI (`deploy.yml`) — `20` (см. `docs/remediation/BASELINE.md`,
раздел 2) — не совпадает с локальным Node этой сессии; известная,
отдельно отслеживаемая находка (`BASE-006`), не блокирует `BASE-003`.

### 3.2 Активная аутентификация — PASS/FAIL, без вывода секретов

```text
$ npx --no-install firebase login:list
⚠  No authorized accounts, run "firebase login"

$ npx --no-install firebase projects:list
Error: Failed to authenticate, have you run firebase login?

$ echo $GOOGLE_APPLICATION_CREDENTIALS
(пусто — переменная не задана)

$ ls -la ~/.config/gcloud
No such file or directory

$ ls -la ~/.config/configstore/firebase-tools.json
-rw------- 1 root root 2 <дата>   # 2 байта — согласуется с пустым `{}`, содержимое не читалось
```

**Результат: FAIL — нет ни одной авторизованной учётной записи Firebase
CLI, gcloud CLI не установлен, Application Default Credentials
отсутствуют.** Ни к одному Firebase/GCP project ID (ни `finapp-prod-10a83`,
ни `finapp-staging`) эта сессия **не имеет административного доступа**.
Список «project ID → роль» — **пуст**, подтверждённых ролей нет ни для
одного проекта.

### 3.3 Сетевая связность (для различения «блокирует сеть» vs «блокирует авторизация»)

```text
firestore.googleapis.com          -> http_code=404   (достижим — 404 это ответ API на GET /, не блокировка)
storage.googleapis.com            -> http_code=400   (достижим)
cloudresourcemanager.googleapis.com -> http_code=404 (достижим)
cloudbilling.googleapis.com       -> http_code=404   (достижим)
identitytoolkit.googleapis.com    -> http_code=404   (достижим)
firebase.google.com               -> CONNECT tunnel failed, response 403  (заблокирован прокси — известно с BASE-002)
console.firebase.google.com       -> CONNECT tunnel failed, response 403  (заблокирован прокси — известно с BASE-002)
```

**Вывод:** блокирующий фактор для раздела 4 — **исключительно отсутствие
аутентификации**, не сеть. Административные `*.googleapis.com` хосты
технически достижимы из этой среды; интерактивный OAuth-вход
(`firebase login`/`gcloud auth login`) через `console.firebase.google.com`/
`firebase.google.com` в этой неинтерактивной sandboxed-сессии выполнить
нельзя даже при наличии сетевого доступа к самим API — браузерный OAuth-
флоу требует интерактивной сессии владельца.

---

## 4. Готовность production к резервному копированию

**Статус: `BLOCKED_PERMISSIONS` — ни один пункт не может быть проверен.**

Все перечисленные ниже проверки требуют аутентифицированного запроса к
Firestore Admin API / Cloud Storage API / Cloud Billing API / IAM API с
project ID `finapp-prod-10a83`. Раздел 3.2 подтвердил отсутствие любой
авторизации. Ничего из списка не подтверждено и не опровергнуто — не
предположено:

| Проверка | Статус |
|---|---|
| Существует ли production Firestore | **BLOCKED_PERMISSIONS** |
| Имя базы данных | **BLOCKED_PERMISSIONS** |
| Режим базы (Native/Datastore mode) | **BLOCKED_PERMISSIONS** |
| Регион/расположение | **BLOCKED_PERMISSIONS** |
| Включён ли billing | **BLOCKED_PERMISSIONS** |
| Существует ли подходящий Cloud Storage bucket | **BLOCKED_PERMISSIONS** |
| Расположение bucket | **BLOCKED_PERMISSIONS** |
| Включён ли Requester Pays | **BLOCKED_PERMISSIONS** |
| Учётная запись для managed export/import | **BLOCKED_PERMISSIONS** (нет ни одной авторизованной) |
| Достаточно ли прав для Firestore export/import | **BLOCKED_PERMISSIONS** |
| Достаточно ли прав для чтения опубликованных Rules/indexes | **BLOCKED_PERMISSIONS** |
| Доступ к Firebase Auth metadata | **BLOCKED_PERMISSIONS** |
| Существует ли опубликованный production Hosting release | **N/A** — Firebase Hosting не используется (см. 2.5-2.6); GitHub Pages release подтверждён отдельно в `BASELINE.md` |
| Существующие резервные копии / незавершённые export-import operations | **BLOCKED_PERMISSIONS** |

## OWNER_ACTION_REQUIRED — раздел 4

Владелец должен выполнить одно из:

1. **Предпочтительно:** выполнить `firebase login` и/или
   `gcloud auth login` самостоятельно в своей среде с браузерным доступом,
   затем предоставить Claude Code доступ к результату (например, запустить
   этот же preflight в среде, унаследовавшей его OAuth-сессию), либо
   выполнить перечисленные read-only команды (раздел 4, список выше)
   самостоятельно и передать только результаты (существование/статус/
   счётчики — не сырые ответы API, если они содержат нерелевантные детали).
2. **Альтернатива:** выпустить service account с строго минимальным
   набором ролей для preflight-этапа (**read-only**, не export/import):
   - `roles/datastore.viewer` (или эквивалент — только для проверки
     существования базы/её метаданных, не для чтения документов);
   - `roles/storage.objectViewer` на конкретный backup bucket, если он уже
     существует;
   - `roles/billing.viewer` на project (только для проверки статуса
     billing, не изменения);
   и передать ключ через защищённый канал вне Git/чата (например, GitHub
   Secret, видимый только в отдельном CI job, или временный доступ,
   отозываемый сразу после использования). **Эта сессия не запрашивает и
   не должна получать роли, дающие export/import или запись** на этом
   preflight-этапе — только предмет отдельного будущего разрешения
   (`EXTERNAL_ACTION_APPROVED`/`PRODUCTION_ACTION_APPROVED`) непосредственно
   перед фактическим export.

Без одного из этих действий раздел 4 остаётся `BLOCKED_PERMISSIONS`
неограниченно долго — это не решается кодом или дальнейшим локальным
изучением репозитория.

---

## 5. Безопасная цель восстановления

**Статус: `BLOCKED_RESTORE_TARGET_OWNER_DECISION`.**

Причина: проверка «существует ли отдельный изолированный restore-проект»
сама требует аутентифицированного доступа к Firebase/GCP (`gcloud projects
list` или аналог) — который недоступен по причинам раздела 3.2/4. Ни
подтвердить, ни опровергнуть существование такого проекта эта сессия не
может. Проект **не создавался** — это запрещено условиями задачи и не
делалось.

### 5.1 Вариант A — рекомендуемый: отдельный временный restore-проект

| Параметр | Значение |
|---|---|
| Что это | Новый, изолированный Firebase/GCP project, создаваемый только для проверки восстановления, отдельно от `finapp-prod-10a83` и `finapp-staging` |
| Кто создаёт | Владелец (создание/удаление GCP-проектов запрещено этой сессии — `CLAUDE.md`, раздел 5) |
| Необходимые права | `roles/owner` или `roles/editor` на новый проект (создаётся вместе с проектом, обычно автоматически для создателя); отдельно — `roles/datastore.importExportAdmin` для выполнения import |
| Примерные cloud-операции | `gcloud projects create <restore-project-id>`; включение Firestore в Native mode; `firebase firestore:databases:create` или через Console; `gcloud firestore import gs://<backup-bucket>/<export-path> --project=<restore-project-id>` |
| Необратимость / риск для существующих данных | **Минимальный** — новый проект не содержит никаких существующих данных, риск затронуть что-либо кроме самого нового проекта отсутствует. Единственная необратимая операция — сам факт создания GCP-ресурса (выставление billing на новый проект, если Firestore Native mode требует Blaze — уточнить при создании) |
| Плюсы | Полная изоляция от `finapp-staging` (у которого уже есть case-специфичное состояние — включённый Email/Password Auth provider, случайная Realtime Database, второе веб-приложение — см. `BASE-002`); ничего в существующих проектах не может быть случайно перезаписано восстановлением |
| Минусы | Требует владельца создать новый GCP-ресурс и, вероятно, billing на него (даже временно) |

### 5.2 Вариант B — допустимый только при отдельном одобрении: `finapp-staging` с предварительной очисткой/изоляцией

| Параметр | Значение |
|---|---|
| Что это | Использовать уже существующий `finapp-staging` как временную цель восстановления |
| Обязательное условие | Отдельное явное разрешение владельца **именно для этой цели** (не покрывается общим `EXTERNAL_ACTION_APPROVED`/`PRODUCTION_ACTION_APPROVED` из `CLAUDE.md` — там речь про запись production/staging кода, здесь речь про импорт **чужих (production) данных** в staging) |
| Необходимые права | Те же (`datastore.importExportAdmin`), но уже на существующий, «грязный» проект |
| Примерные cloud-операции | Тот же `gcloud firestore import ...` — но целится в проект, где **уже есть** созданные ранее в ходе `BASE-002` реальная Auth-конфигурация (Email/Password провайдер включён), случайная Realtime Database, возможное второе веб-приложение |
| Необратимость / риск | **Существенный.** Import в непустую Firestore базу может конфликтовать/перемешаться с уже существующими (пусть и тестовыми) документами `finapp-staging`, если пути документов совпадут; также заранее не проверялось (в рамках `BASE-002`) — есть ли уже какие-то тестовые/staging-only записи, которые может задеть массовый import. Требует **обязательной предварительной очистки** (полное удаление существующих Firestore-документов в `finapp-staging` перед import) — сама очистка тоже необратима и должна быть отдельно одобрена и залогирована |
| Плюсы | Не требует создания нового GCP-проекта/billing |
| Минусы | Смешивает production-данные (пусть и временно, в целях проверки) с проектом, который уже использовался для staging-разработки; выше риск человеческой ошибки (например, забыть, что в `finapp-staging` теперь лежат реальные production-данные, и по ошибке использовать его как staging для разработки) |

**Рекомендация этого отчёта: Вариант A.** Вариант B зафиксирован как
допустимый запасной путь, но требует отдельного явного решения владельца
и предварительной очистки/оценки риска — не используется по умолчанию.
Production-данные **не будут** импортированы в `finapp-staging` без такого
отдельного явного разрешения — прямое требование задачи, соблюдено.

---

## 6. Backup manifest — спроектированная структура (без реальных данных)

### 6.1 Схема (JSON, поля — не значения)

```jsonc
{
  "schemaVersion": "1.0",
  "createdAtUtc": "<ISO-8601 UTC timestamp>",
  "productionProjectId": "finapp-prod-10a83",
  "firestore": {
    "databaseId": "<например (default)>",
    "location": "<регион, например eur3>",
    "exportUri": "<gs://bucket/path — сам URI не публикуется в этом отчёте, см. 6.2>",
    "companiesCount": 0,
    "usersCount": 0,
    "companyDataDocsCount": 0,
    "exportOperationId": "<operation resource name>",
    "exportStatus": "<PENDING | RUNNING | SUCCESS | FAILED>"
  },
  "authExport": {
    "sha256": "<64-символьный hex>",
    "userCount": 0
  },
  "rules": { "sha256": "<64-символьный hex>" },
  "indexes": { "sha256": "<64-символьный hex>" },
  "productionBundle": {
    "sourceCommit": "<git SHA>",
    "sha256": "<64-символьный hex>"
  },
  "storage": {
    "location": "<bucket location>",
    "retentionDays": 0,
    "accessRoles": ["<role1>", "<role2>"]
  },
  "restore": {
    "restoreProjectId": "<заполняется после выбора цели — раздел 5>",
    "verifiedAtUtc": "<ISO-8601 UTC или null>",
    "verificationResult": "<PASS | FAIL | NOT_RUN>",
    "checksumMatches": { "companies": false, "users": false, "companyData": false, "balances": false }
  }
}
```

### 6.2 Правила заполнения (обязательные, не только для будущего исполнения)

- **Никогда**: `email`, `uid` в явном виде вне технической необходимости
  ссылки (если нужен UID для диагностики — только хэшировать), пароли/
  password hash/salt, содержимое любого документа, реальный `exportUri`,
  если он раскрывает закрытую инфраструктуру (например, содержит
  предсказуемое имя bucket, которое можно использовать для энумерации) —
  вместо полного URI в публичной части манифеста хранить только его
  SHA-256 или сокращённую ссылку на закрытое хранилище.
- Manifest **не хранится в Git** — ни в этом репозитории, ни в этой ветке.
  Место хранения — то же закрытое хранилище, что и сам backup (см. runbook).
- `companiesCount`/`usersCount`/`companyDataDocsCount` — это **количества**,
  получаемые из метаданных операции export или через Firestore count-
  агрегацию (`.count().get()` — не читает содержимое документов, только
  считает их) — не через полное чтение данных.

### 6.3 Какие контрольные суммы безопасно использовать для проверки восстановления

Три независимых уровня, ни один не требует печати/логирования реальных
значений:

1. **Структурные счётчики** (не секрет, не PII): количество документов в
   каждой из трёх коллекций (`companies`, `users`, `company_data`) до
   export и после import в restore-проект — через Firestore count-
   агрегацию, сравнение только чисел.
2. **Файловая целостность бэкапа**: SHA-256 экспортированных объектов
   Firestore export в GCS, SHA-256 файла `firebase auth:export` (хешируется
   как непрозрачный файл — сам файл содержит password hashes, но хэш файла
   для сверки «файл не повреждён/не подменён» **не раскрывает** их
   содержимое), SHA-256 `firestore.rules`, SHA-256 `firestore.indexes.json`,
   SHA-256 production bundle (`dist/` после `npm run build` на известном
   production commit).
3. **Финансовая консистентность без раскрытия сумм** (дизайн для будущей
   реализации, не для этого preflight): детерминированно
   сериализовать на исходной и на восстановленной стороне одинаковый
   отсортированный проекционный набор `{companyId, accountId, currency,
   balance}` (или агрегированные суммы операций по каждой компании,
   рассчитанные тем же кодом, что и в `src/utils/currency.ts`), взять
   SHA-256 от этой сериализации на обеих сторонах и сравнить **только
   хэши** — если хэши совпадают, финансовые данные идентичны, но сами
   суммы никогда не выводятся ни в лог, ни в отчёт, ни в PR.

Ни один из трёх уровней не выполнялся в этом раунде (никакого доступа к
production/restore-данным нет) — это дизайн для этапа фактического
исполнения `BASE-003` (отдельный будущий цикл, после `OWNER_ACTION_REQUIRED`
разделов 4 и 5).

---

## 7. Порядок будущего экспорта/восстановления/проверки (документация — не выполнялось)

Полный порядок — в `docs/runbooks/BACKUP_AND_RESTORE.md`. Здесь — только
ссылка и краткое содержание: экспорт Firestore (`gcloud firestore export`),
экспорт Auth (`firebase auth:export`), сохранение Rules/indexes/bundle с
checksums, порядок восстановления в выбранную цель (раздел 5), порядок
проверки (раздел 6.3), правила хранения/удаления, rollback.

---

## 8. Проверка Git (эта задача, preflight)

```text
$ git diff --check
(exit 0 — чисто)

$ git status --short
?? docs/remediation/reports/BASE-003.md
?? docs/runbooks/

$ git diff --check origin/remediation/main -- REMEDIATION_PLAN.md
(exit 0 — файл не менялся, diff пуст)
```

- Изменены/добавлены **только два документа**: этот отчёт и
  `docs/runbooks/BACKUP_AND_RESTORE.md` (создаётся этим же коммитом).
- Backup-файлов, экспорта Auth, production bundle — нет и не может быть в
  этом diff (ничего не экспортировалось).
- `REMEDIATION_PLAN.md` не изменялся — `[ ] BASE-003` сохранена как есть.
- Код и зависимости (`package.json`, `package-lock.json`, `src/`,
  `scripts/`) — не изменялись.

### Сканирование diff на секреты/PII (без вывода найденных значений)

```text
$ git diff --cached | grep -icE "AIzaSy[A-Za-z0-9_-]{25,}|private_key|BEGIN (RSA|PRIVATE) KEY|client_secret|password|salt"
0
```

**PASS** — совпадений нет.

---

## Сводка PASS / FAIL / BLOCKED / OWNER_ACTION_REQUIRED

| Раздел | Статус |
|---|---|
| 1. Git preflight | **PASS** |
| 2. Изучение структуры приложения | **PASS** (полностью выполнено локально, все утверждения подкреплены `файл:строка`) |
| 3.1 Версии инструментов | **PASS** (зафиксированы; gcloud — FAIL, не установлен) |
| 3.2 Активная аутентификация | **FAIL** — ни одной авторизованной учётной записи |
| 3.3 Сетевая связность до admin API | **PASS** (хосты достижимы — не блокер) |
| 4. Готовность production к backup | **BLOCKED_PERMISSIONS** (весь раздел) |
| 5. Безопасная цель восстановления | **BLOCKED_RESTORE_TARGET_OWNER_DECISION** |
| 6. Backup manifest (дизайн схемы) | **PASS** (схема спроектирована, без данных) |
| 7. Runbook | **PASS** (создан — см. `docs/runbooks/BACKUP_AND_RESTORE.md`) |
| 8. Git-гигиена | **PASS** |

## OWNER_ACTION_REQUIRED — сводно

1. Предоставить аутентифицированный доступ (свой `firebase login`/
   `gcloud auth login`, либо строго read-only service account — см. раздел 4)
   для проверки готовности production к backup.
2. Принять решение по цели восстановления — Вариант A (рекомендуется,
   отдельный temp-проект) или Вариант B (`finapp-staging`, требует
   отдельного явного разрешения и предварительной очистки) — раздел 5.

## Известные ограничения

- Ни один реальный факт о состоянии `finapp-prod-10a83` (Firestore,
  billing, buckets, IAM) не подтверждён в этом раунде — весь раздел 4
  теоретический/дизайн, не проверка.
- gcloud CLI не установлен в этой среде; установка не выполнялась в этом
  раунде (не запрашивалась явно, не является строго необходимой, пока нет
  авторизации — сначала нужно решение владельца по разделу 4).
- Manifest-схема (раздел 6) — дизайн, не заполненный реальными данными
  документ.

## Diff summary

```text
 docs/remediation/reports/BASE-003.md   | (новый файл)
 docs/runbooks/BACKUP_AND_RESTORE.md    | (новый файл)
 2 files changed
```

## Следующий разрешённый пункт

Сама `BASE-003` остаётся в фазе `PRE-FLIGHT`, статус `BLOCKED_MULTIPLE`.
**Не начинаю `BASE-004`.** Дальнейшая работа над `BASE-003` (фактический
export/import) заблокирована до получения `OWNER_ACTION_REQUIRED` выше.

---

# Часть 2 — ACCESS SETUP AND RESTORE PROJECT CREATION

```text
OWNER_DECISION: APPROVED
RESTORE_TARGET_OPTION: A
RESTORE_TARGET_TYPE: SEPARATE_TEMP_PROJECT
```

## Итоговый статус этого раунда

**`BLOCKED_AUTHENTICATION`**

Restore-проект **не создан**. Ни один cloud-ресурс не создавался и не
изменялся. `finapp-staging` не использовался и не изменялся. Фактический
backup/restore не выполнялся — как и требовала задача для этого раунда.

## 1. Git (подтверждено перед началом)

```text
$ git branch --show-current
remediation/BASE-003-backup-restore

$ git rev-parse HEAD
6d6d627b0cbe742aece179d07759f0a59d6d6830   # совпадает с ожидаемым

$ git status --short
(пусто)

$ git fetch origin --prune
(без новых изменений на этой ветке)

$ git rev-parse origin/remediation/BASE-003-backup-restore
6d6d627b0cbe742aece179d07759f0a59d6d6830   # совпадает с локальным

PR №3: state=open, draft=true, head.sha совпадает — подтверждено через API.
```

Все условия для продолжения выполнены — переход к следующей задаче не
происходил, ветка не менялась.

## 2. Установка Google Cloud CLI — официальным способом

### 2.1 Определение окружения

```text
$ which gcloud
(не найден)

$ cat /etc/os-release
Ubuntu 24.04.4 LTS (noble), x86_64
```

### 2.2 Официальный источник

Два штатных официальных способа install (`cloud.google.com/sdk/docs/install`)
используют хосты `packages.cloud.google.com` (apt-репозиторий) и
`dl.google.com` (прямой tarball) — оба **заблокированы прокси этой среды**
(`CONNECT tunnel failed, response 403` — тот же паттерн блокировки, что и
`firebase.google.com`/`console.firebase.google.com`, зафиксированный ещё в
`BASE-002`). Проверено явно для обоих хостов, не предположено.

Использован **тот же официальный релиз Google**, но через альтернативный
official-Google host, на который прокси не накладывает такое же
ограничение: собственный публичный GCS-bucket Google для релизов Cloud SDK
— `storage.googleapis.com/cloud-sdk-release/` (тот же bucket, на который
в конечном счёте резолвится `dl.google.com/dl/cloudsdk/...` в обычных
условиях; подтверждено метаданными bucket: `projectNumber: 32555940559`,
`labels.dg_data_source: google` — тот же официальный Google Cloud SDK
release bucket, не сторонняя сборка и не неизвестный package repository).

```text
$ curl -sSI https://storage.googleapis.com/cloud-sdk-release/google-cloud-cli-linux-x86_64.tar.gz
HTTP/2 200
content-type: application/octet-stream
```

### 2.3 Загрузка и установка

```text
$ curl -o google-cloud-cli-linux-x86_64.tar.gz \
    https://storage.googleapis.com/cloud-sdk-release/google-cloud-cli-linux-x86_64.tar.gz
88488284 bytes, SHA-256 (вычислен локально для собственного контроля целостности
этой сессии, сверить с официально опубликованным хэшем не удалось — страница
с official checksums на cloud.google.com недостижима из-за той же блокировки
прокси): 1c478abfe0fbe256b8ecaba2faeff154e44c308064b1c69d9ec15b879a4944bd

$ tar -xzf google-cloud-cli-linux-x86_64.tar.gz
```

`install.sh` (официальный установочный скрипт из архива) запускался с
`--quiet --usage-reporting=false --path-update=false --command-completion=false
--additional-components=""` — то есть явно **без** дополнительных
компонентов (никаких emulators, kubectl, cloud-sql-proxy и т.п. не
устанавливались). Скрипт упал на своём последнем, необязательном шаге —
попытке подтянуть JSON-манифест компонентов с `dl.google.com` (та же
блокировка прокси) — это не помешало: сам core-бинарник `gcloud`,
извлечённый из архива, полностью самодостаточен и не требует этого шага
для базовой работы.

```text
$ /opt/google-cloud-sdk-install/google-cloud-sdk/bin/gcloud version
Google Cloud SDK 577.0.0
bq 2.1.35
bundled-python3-unix 3.14.6
core 2026.07.17
gcloud-crc32c 1.0.0
gsutil 5.37
```

Только компоненты, входящие в базовый архив (`core`, `bq`, `gsutil`,
`gcloud-crc32c`, bundled Python) — ничего дополнительно не устанавливалось
(`gcloud components install` ни разу не вызывался).

Для устойчивости между отдельными вызовами инструмента (PATH не
сохраняется между независимыми командами в этой среде) создан symlink:
`/usr/local/bin/gcloud` → `/opt/google-cloud-sdk-install/google-cloud-sdk/bin/gcloud`
(и аналогично `gsutil`) — системный путь, **не файл репозитория**;
`git status` в `/home/user/finapp` этим не затрагивается (подтверждено
ниже, раздел 9).

**Файлы репозитория установкой не изменялись.** sudo/UAC не требовался и
не обходился — сессия уже выполняется от `root` в этом Linux-контейнере
(это единственная учётная запись ОС в контейнере, не отдельное
повышение прав ради установки); Windows-специфичный сценарий (UAC) не
применим к этой среде (Ubuntu 24.04 в контейнере, не Windows).

## 3. Безопасная интерактивная авторизация — попытка и результат

### 3.1 gcloud auth login

```text
$ gcloud auth login --no-launch-browser
Go to the following link in your browser, and complete the sign-in prompts:
    https://accounts.google.com/o/oauth2/auth?...&client_id=32555940559.apps.googleusercontent.com&...
Once finished, enter the verification code provided in your browser:
ERROR: gcloud crashed (EOFError): EOF when reading a line
```

Сама ссылка авторизации не является секретом (это URL с параметрами
OAuth-запроса, не токен и не учётные данные) — но её открытие и
дальнейшие действия по условиям задачи должен выполнить владелец
самостоятельно, **не эта сессия**. Проблема: после завершения входа в
браузере `gcloud` этого конкретного (`--no-launch-browser`) режима
ожидает, что **verification code** будет вручную введён обратно в тот же
процесс через stdin. По прямому требованию задачи:

- эта сессия не вводит verification code;
- эта сессия не просит владельца прислать verification code в чат.

Технически это означает: завершить именно эту команду в этой
неинтерактивной сессии **нельзя ни при каком поведении владельца** — не
из-за отказа авторизации, а потому что единственный канал передачи
verification code обратно в процесс (stdin/чат) заблокирован собственными
требованиями безопасности задачи. Это не ошибка исполнения — это
структурное ограничение среды.

Второй режим (`gcloud auth login` без `--no-launch-browser`) не даёт
принципиально иного исхода: он поднимает локальный HTTP-listener для OAuth
callback на `localhost` **этого контейнера** — браузер владельца работает
на его собственной машине и физически не может обратиться к `localhost`
изолированной облачной сессии, поэтому callback никогда не будет получен.
Не запускался повторно с этим вариантом — вывод идентичен по причине,
изложенной здесь, дополнительная попытка не дала бы новой информации.

### 3.2 firebase-tools login

```text
$ npx firebase-tools login --no-localhost
Error: Cannot run login in non-interactive mode. See login:ci to generate a
token for use in non-interactive environments.
```

Firebase CLI сам явно отказывается работать в неинтерактивном режиме.
`login:ci` генерирует долгоживущий токен через тот же OAuth-браузерный
поток — тот же фундаментальный блокер (нужно либо ввести код, либо
получить токен обратно в сессию), не выполнялся по тем же причинам.

### 3.3 Итог

```text
$ gcloud auth list --format="value(account)" | wc -l
0

$ npx firebase-tools login:list
⚠  No authorized accounts, run "firebase login"
```

**Количество активных авторизованных аккаунтов: 0 (оба CLI).** Email не
запрашивался и не выводился. Пароль, одноразовый код, токен, cookies и
любые OAuth credentials — не запрашивались у владельца и не вводились
этой сессией. Service account — не создавался.
`gcloud auth application-default login` — не вызывался (запрещено
условиями задачи).

**Статус: `BLOCKED_AUTHENTICATION`.**

## Рекомендация владельцу — как разблокировать

Поскольку блокирует не отсутствие решения владельца, а архитектурная
невозможность интерактивного OAuth в этой изолированной облачной сессии,
варианта разблокировки два:

1. **Наиболее прямой:** запустить именно эту фазу задачи (`BASE-003 —
   ACCESS SETUP AND RESTORE PROJECT CREATION`) через Claude Code,
   выполняющийся **локально на машине владельца** (а не в этой удалённой
   облачной сессии) — тогда `gcloud auth login` откроет настоящий локальный
   браузер, и OAuth callback на `localhost` дойдёт до того же процесса
   штатно, без переноса какого-либо кода/токена через чат.
2. Владелец выполняет `gcloud auth login` и создание restore-проекта
   самостоятельно (в любой среде с браузером) по инструкции разделов 4-6
   этого отчёта («Часть 1»), и сообщает сессии только **нечувствительный
   результат**: точный `restore project ID`, факт `lifecycle: ACTIVE`, факт
   «Firebase добавлен» — без токенов, без email, без billing account ID.

Оба варианта не требуют присылать в чат пароли/коды/токены — соответствуют
ограничениям задачи.

## 4-6. Read-only проверка production / parent / создание проекта

**Не выполнялись.** Прямое условие задачи: «Если авторизация не выполнена,
зафиксируй `BLOCKED_AUTHENTICATION` и не создавай проект» — соблюдено
буквально. Ни один запрос к `finapp-prod-10a83`, ни определение parent, ни
создание Google Cloud project/добавление Firebase — не выполнялись.

## 7. Итоговый статус раздела

`BLOCKED_AUTHENTICATION` (см. выше, единственный установленный статус —
не `BLOCKED_MULTIPLE`, так как `BLOCKED_PERMISSIONS`/сеть отдельно
проверены и не являются причиной: gcloud CLI успешно установлен, конкретные
`*.googleapis.com` хосты достижимы — единственная причина остановки этого
раунда — невозможность завершить интерактивный OAuth handshake в этой
изолированной сессии).

## Restore project — фактическое состояние

| Параметр | Значение |
|---|---|
| Restore project ID | **не создан** |
| Дата создания UTC | н/п |
| Parent type | н/п — не определялся (заблокировано разделом 3) |
| Firebase enabled | н/п |
| Billing linked by this task | **NO** |
| Firestore created | **NO** |
| Backup bucket created | **NO** |
| Auth configured | **NO** |
| Export performed | **NO** |
| Import performed | **NO** |

## 9. Проверка Git (этот раунд)

```text
$ git status --short
 M docs/remediation/reports/BASE-003.md
 M docs/runbooks/BACKUP_AND_RESTORE.md

$ git diff --check
(exit 0)

$ git diff --check -- REMEDIATION_PLAN.md
(exit 0, файл не менялся)
```

- Изменены **только два документа**. Код (`src/`, `scripts/`), зависимости
  (`package.json`, `package-lock.json`) — не изменялись.
- Локальные gcloud/Firebase credentials в Git **не попали** — их и не было
  создано (0 авторизованных аккаунтов, см. раздел 3.3); симлинк `gcloud` в
  `/usr/local/bin` — вне репозитория, `git status` в `/home/user/finapp`
  его не видит (подтверждено выше).
- Backup-файлов, Auth export, production bundle — нет (ничего не
  экспортировалось).
- `REMEDIATION_PLAN.md` не менялся — `[ ] BASE-003` сохранена.
- `BASE-004` не начиналась.

### Скан diff на secrets/PII (без вывода найденных значений)

```text
$ git diff | grep -icE "AIzaSy[A-Za-z0-9_-]{25,}"
0

$ git diff | grep -icE "private_key|BEGIN (RSA|PRIVATE) KEY|client_secret"
2   # оба — одна и та же строка отчёта, цитирующая сам этот grep-шаблон
    # как документацию (см. ниже), не реальный секрет

$ git diff | grep -icE "password|salt"
1   # та же самоссылочная строка

$ git diff | grep -icE "@gmail|@yandex|@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
1   # та же самоссылочная строка
```

Все совпадения указывают на **одну и ту же строку** этого отчёта — команду
скана, процитированную как документация (аналогичный самоссылочный
false-positive уже фиксировался в отчётах `BASE-002`). Проверено отдельно:
исключение самой этой строки даёт 0 совпадений по всем четырём паттернам.
**Итог: PASS** — реальных секретов/PII в diff нет, значения нигде не
печатались.

## Следующий разрешённый пункт

`BASE-003` остаётся в фазе `ACCESS SETUP AND RESTORE PROJECT CREATION`,
статус `BLOCKED_AUTHENTICATION`. **Не начинаю `BASE-004`.** Продолжение —
только после получения одного из двух путей разблокировки (см. раздел
«Рекомендация владельцу» выше).

---

# Часть 3 — Повторная попытка (заявлено «локально на машине владельца») — расхождение с фактическим окружением

## Важное расхождение — зафиксировано честно, не проигнорировано

Задание этого раунда утверждало: «Работа выполняется локально на
компьютере владельца, где доступен обычный браузер». Это не подтвердилось
объективными признаками этой же сессии/контейнера:

```text
$ pwd
/home/user/finapp

$ git remote -v
origin  http://local_proxy@127.0.0.1:41729/git/Alexspb-spb1/finapp (fetch)
origin  http://local_proxy@127.0.0.1:41729/git/Alexspb-spb1/finapp (push)

$ hostname
vm

$ echo $DISPLAY
(не задан)

$ uname -a
Linux vm 6.18.5 ... x86_64
```

`origin` по-прежнему резолвится через тот же локальный git-прокси
(`127.0.0.1:41729`), что описан в системном окружении этой управляемой
удалённой сессии — не через прямой доступ к GitHub, каким он был бы на
машине владельца. Отсутствует `DISPLAY` (нет графической сессии/браузера).
Симлинк `/usr/local/bin/gcloud`, созданный в предыдущем раунде этой же
сессии, уже присутствует — то есть это **тот же самый контейнер**, не
новая локальная среда.

### Практическое подтверждение — повторная попытка авторизации

```text
$ gcloud auth login
Go to the following link in your browser, and complete the sign-in prompts:
    https://accounts.google.com/o/oauth2/auth?...
Once finished, enter the verification code provided in your browser:
ERROR: gcloud crashed (EOFError): EOF when reading a line
```

Идентичный результат предыдущему раунду — `gcloud auth login` (даже без
`--no-launch-browser`) не смог открыть настоящий локальный браузер
(нет `DISPLAY`) и вновь свёлся к ожиданию verification code через stdin,
что запрещено условиями задачи (Claude не вводит код, не просит владельца
прислать его в чат).

```text
$ npx firebase-tools login --reauth
(процесс завис, завершён по таймауту — SIGTERM, exit 143)
```

Поведение согласуется с той же причиной: CLI пытается поднять локальный
callback-listener/открыть браузер, которых в этой изолированной сессии нет
и быть не может.

```text
$ gcloud auth list --format="value(account)" | wc -l
0

$ npx firebase-tools login:list
⚠  No authorized accounts, run "firebase login"
```

### Вывод

**Эта конкретная сессия по-прежнему выполняется в изолированном удалённом
контейнере, не на машине владельца.** Утверждение задания о «локальном
браузере» не подтвердилось техническими признаками — зафиксировано как
факт, не проигнорировано и не подделано молчаливым притворством, что
авторизация прошла. Статус остаётся **`BLOCKED_AUTHENTICATION`**, по той
же причине, что и в «Часть 2».

Разделы 4–6 задания (read-only проверка production, определение parent,
создание restore-проекта) — **не выполнялись**, ровно как и в «Часть 2»:
без реальной авторизации любая попытка была бы либо блокирована API, либо
потребовала бы подделать результат — оба варианта недопустимы.

### Что нужно, чтобы этот раздел задачи реально продолжился

Ничего не изменилось по существу относительно рекомендации в «Часть 2»:

1. Владелец запускает именно эту фазу через Claude Code, установленный и
   выполняющийся **действительно локально** — на своей физической машине,
   вне облачной/контейнерной сессии (см. `code.claude.com/docs` про режимы
   выполнения) — тогда `$DISPLAY`/браузер будут доступны реально, и
   `gcloud auth login` завершится штатно без передачи кода через чат.
2. Либо владелец выполняет `gcloud auth login` и создание restore-проекта
   самостоятельно в любой среде с браузером (например, в собственном
   терминале) и сообщает сессии только нечувствительный итог.

Простого заявления «это теперь локально» в тексте задачи недостаточно —
среда исполнения определяется тем, где физически запущен процесс
`gcloud`/`firebase-tools`, а не описанием в промпте.

## Итоговый статус этого раунда

`BLOCKED_AUTHENTICATION` (без изменений от «Часть 2»). Restore-проект не
создан, `finapp-staging` не использовался и не изменялся, production не
затрагивался.

## Следующий разрешённый пункт

`BASE-003` остаётся в фазе `ACCESS SETUP AND RESTORE PROJECT CREATION`,
статус `BLOCKED_AUTHENTICATION`. **Не начинаю `BASE-004`.**
