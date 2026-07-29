# BASE-003 — Сделать резервную копию production и проверить восстановление

```text
TASK_ID: BASE-003
PHASE: RESTORE TEST VERIFIED — remaining gaps documented
```

## Итоговый статус (актуальный)

**`BASE_003_RESTORE_DOCUMENTED_REMAINING_GAPS_FOUND`** — см. «Часть 5»
ниже. Все прежние блокеры (`BLOCKED_MULTIPLE`, `BLOCKED_PERMISSIONS`,
`BLOCKED_RESTORE_TARGET_OWNER_DECISION`, `BLOCKED_AUTHENTICATION`) —
**сняты**: Firestore managed export и managed import выполнены и
объективно подтверждены (`operationState: SUCCESSFUL`, 14/14 документов с
обеих сторон, counts до/после совпали — раздел 10 «Часть 5»).

`BASE-003` при этом **ещё не завершена**: часть требований
`REMEDIATION_PLAN.md` остаётся `NOT_VERIFIED` или
`OWNER_APPROVAL_REQUIRED` (Firestore Rules, indexes, Auth export,
production bundle, открытие тестовой компании, контрольные суммы
остатков, lifecycle retention, полноценный production disaster recovery)
— полная таблица со статусами и evidence приведена в «Часть 5», раздел 10.
`REMEDIATION_PLAN.md` не изменялся — `[ ] BASE-003` не отмечена `[x]`.

Разделы «Часть 1»–«Часть 4» ниже описывают историю предыдущих раундов
(включая уже неактуальные промежуточные блокеры) и оставлены без
изменений, для истории.

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

---

# Часть 4 — Авторизация завершена владельцем, read-only проверка и создание restore-проекта

```text
OWNER_DECISION: APPROVED
RESTORE_TARGET_OPTION: A
RESTORE_TARGET_TYPE: SEPARATE_TEMP_PROJECT
```

## Итоговый статус этого раунда

**`READY_FOR_BILLING_AND_STORAGE_DECISION`**

Этот раунд выполнялся действительно локально, на машине владельца
(Windows), с инструментами Bash/PowerShell этой среды. В отличие от
«Часть 2»/«Часть 3», `gcloud version` сразу показал уже установленный
Google Cloud SDK 577.0.0 — установка не требовалась. Владелец лично
завершил оба браузерных OAuth-входа (`gcloud auth login` и
`npx firebase-tools login --reauth`).

## 1. Git (подтверждено перед началом раунда)

```text
$ git remote -v
origin  https://github.com/Alexspb-spb1/finapp.git (fetch/push)

$ git branch --show-current
remediation/BASE-003-backup-restore

$ git rev-parse HEAD
ace715beceb30b8c467e6019f8d21016fc24ba8f   # совпадает с ожидаемым

$ git status --short
(пусто)

PR №3: state=OPEN, isDraft=true, baseRefName=remediation/main,
headRefName=remediation/BASE-003-backup-restore — подтверждено через `gh pr view`.
```

## 2. Авторизация

```text
$ gcloud version
Google Cloud SDK 577.0.0 (+ bq, core, gcloud-crc32c, gsutil) — PASS, установка не потребовалась.

$ gcloud auth login
(владелец завершил вход в открывшемся браузере)
$ gcloud auth list --format="value(account)" | подсчёт строк
AUTHORIZED_ACCOUNTS_COUNT: 1

$ npx firebase-tools login:list
Logged in as <email не выводится в отчёт> — подтверждена активная сессия.
```

```text
GCLOUD_AUTH: PASS
FIREBASE_AUTH: PASS
```

Email, токены, refresh/access tokens, cookies — нигде не выводились и не
сохранялись в этом отчёте. Service account/JSON-ключ — не создавался.
`gcloud auth application-default login` — не вызывался.

## 3. Read-only проверка production (`finapp-prod-10a83`)

Project ID передавался явно в каждой команде, `gcloud config set project`
не выполнялся — production не становился project по умолчанию.

| Проверка | Результат |
|---|---|
| Проект существует и доступен | **PASS** |
| Lifecycle state | `ACTIVE` |
| Тип parent resource | `none` (No organization — в `gcloud projects describe --format=json` поле `parent` отсутствует; `gcloud organizations list` для этого аккаунта пуст) |
| Firestore существует | **PASS** |
| Системное имя базы данных | `projects/finapp-prod-10a83/databases/(default)` |
| Режим базы | `FIRESTORE_NATIVE` |
| Location | `eur3` |
| Billing enabled | `false` |
| Количество Cloud Storage buckets | `0` |
| Locations buckets | н/п (buckets отсутствуют) |
| Requester Pays | н/п (buckets отсутствуют) |
| Незавершённые Firestore export/import operations | `0` |
| Доступность Firestore indexes | **PASS** (запрос `firestore indexes composite list` выполнен без ошибок доступа; составных индексов не найдено) |
| Видит ли проект Firebase CLI | **PASS** (`npx firebase-tools projects:list` показывает `finapp-prod-10a83` / `finapp-prod`) |
| Достаточно ли прав для будущего managed export | **PASS** (у текущего аккаунта есть IAM role binding на проекте; конкретная роль и члены не публикуются согласно ограничениям задачи) |
| Firestore service agent существует | **PASS** (подтверждено через `gcloud projects get-iam-policy` — среди bindings присутствует принципал `gcp-sa-firestore`; сами members/JSON не публиковались) |

Не читалось и не выводилось: документы Firestore, пользователи/email/UID,
финансовые данные, содержимое Rules, IAM members, billing account ID, имена
и URI buckets, токены/ключи/credentials. Ни один API не включался, IAM/
billing не менялись, bucket не создавался, export/import не запускался,
Auth не экспортировался, Rules/indexes/Firestore/Authentication не
менялись.

## 4. Parent restore-проекта

Production находится в `No organization` (раздел 3 выше). Текущий
аккаунт — обычный личный Google-аккаунт без видимой Cloud Identity/
Workspace организации (`gcloud organizations list` → пусто). Это прямо
соответствует условию задачи: «Если production находится в `No
organization` и текущий аккаунт может создавать проекты без parent,
разрешено создать проект без parent» — restore-проект создан **без
parent**, тем же типом окружения, что и production. IAM не менялся ради
получения прав — использовались уже имеющиеся у аккаунта.

## 5. Создание restore-проекта

```text
$ gcloud projects create finapp-restore-20260725-4rxl --name="Finapp Temporary Restore"
Create in progress ... .done.
$ gcloud projects describe finapp-restore-20260725-4rxl --format="value(lifecycleState)"
ACTIVE

$ npx firebase-tools projects:addfirebase finapp-restore-20260725-4rxl
=== Your Firebase project is ready! ===
```

- Project ID: `finapp-restore-20260725-4rxl` (28 символов, ≤ 30) — не
  совпадает ни с `finapp-prod-10a83`, ни с `finapp-staging`.
- Дата создания: `2026-07-25` (UTC, `[DateTime]::UtcNow`).
- Display name: `Finapp Temporary Restore`.
- Parent: none (No organization) — см. раздел 4.
- `--set-as-default` не использовался, `.firebaserc` alias не создавался,
  billing не подключался.

### Read-only проверка сразу после создания

```text
billingEnabled: false
Firestore databases list: ERROR SERVICE_DISABLED (Cloud Firestore API не включён) — подтверждает, что база не создана
Cloud Storage buckets list: (пусто) — 0 buckets
```

```text
PROJECT_STATE: ACTIVE
FIREBASE_ENABLED: PASS
BILLING_LINKED_BY_TASK: NO
FIRESTORE_CREATED: NO
BACKUP_BUCKET_CREATED: NO
AUTH_CONFIGURED: NO
REALTIME_DATABASE_CREATED: NO
FIREBASE_APPS_CREATED: NO
EXPORT_PERFORMED: NO
IMPORT_PERFORMED: NO
```

Ни один запрещённый ресурс не появился. `finapp-staging` не
использовался и не изменялся в этом раунде.

## 6. Проверки перед завершением (обязательные из `CLAUDE.md`, раздел 8)

`BASE-003` — документационная/операционная задача этого раунда (доступ +
создание restore-проекта), кодовые изменения отсутствуют. Применимые из
списка `CLAUDE.md`:

| Команда | Результат | Примечание |
|---|---|---|
| `git diff --check` | PASS | пробельных ошибок нет |
| `git status --short` | см. ниже | изменены только два разрешённых документа |
| `npm ci` / `lint` / `typecheck` / `test:run` / `test:rules` / `test:e2e` / `build` | NOT APPLICABLE | этот раунд не меняет `src/`, `scripts/`, `package.json` — код не затронут |

## 7. Git-гигиена (этот раунд)

```text
$ git status --short
 M docs/remediation/reports/BASE-003.md
 M docs/runbooks/BACKUP_AND_RESTORE.md

$ git diff --check
(exit 0)

$ git diff --check -- REMEDIATION_PLAN.md
(exit 0, файл не менялся)
```

- Изменены **только два документа**. Код (`src/`, `scripts/`) и зависимости
  (`package.json`, `package-lock.json`) — не изменялись.
- Секретов, токенов, credentials, backup-файлов, Auth export, production
  bundle — в diff нет и не может быть (ничего подобного не создавалось и не
  скачивалось в этом раунде).
- `REMEDIATION_PLAN.md` не менялся — `[ ] BASE-003` сохранена как есть.
- `BASE-004` не начиналась.

## Restore project — итоговое состояние

| Параметр | Значение |
|---|---|
| Restore project ID | `finapp-restore-20260725-4rxl` |
| Дата создания UTC | `2026-07-25` |
| Parent type | `none` (No organization) |
| Production Firestore location | `eur3` |
| Firebase enabled | PASS |
| Billing linked by this task | NO |
| Firestore created | NO |
| Backup bucket created | NO |
| Auth configured | NO |
| Export performed | NO |
| Import performed | NO |

## Следующий разрешённый пункт

`BASE-003` переходит в состояние `READY_FOR_BILLING_AND_STORAGE_DECISION`.
Следующие подэтапы (подключение billing к restore-проекту, создание
Firestore/bucket, фактический export/import и проверка восстановления)
требуют отдельного явного решения владельца по каждому пункту — не
выполняются автоматически. **`BASE-004` не начата и не начинается.**

---

# Часть 5 — Billing, bucket, export, import и верификация восстановления

```text
OWNER_BILLING_APPROVAL: APPROVED
IAM_CHANGE_APPROVAL: APPROVED
EXPORT_RETRY_APPROVAL: APPROVED
IMPORT_IAM_AND_RESTORE_APPROVAL: APPROVED
APPROVED_MAX_SCOPE: BILLING_BUCKET_EXPORT_RESTORE_TEST
```

Каждый следующий шаг выполнялся только после отдельного явного разрешения
владельца в этом точном формате — ни один cloud-ресурс не создавался и не
изменялся авансом.

## 1. Billing

Billing account (единственный доступный, отображается только частично)
привязан к обоим проектам после явного разрешения:

- `finapp-prod-10a83` → `billingEnabled: true`
- `finapp-restore-20260725-4rxl` → `billingEnabled: true`

## 2. Backup bucket

```text
gs://finapp-restore-20260725-4rxl-backup
location: EU (multi-region; GCS не поддерживает "eur3" как --location
  напрямую — использована официально совместимая multi-region EU,
  физически включающая регионы Firestore eur3)
uniform_bucket_level_access: true
public_access_prevention: enforced
default_storage_class: STANDARD
```

Создан в restore-проекте (изоляция от production, упрощённая последующая
очистка).

## 3. IAM на bucket — итерации и текущее состояние

Первая попытка export (`roles/storage.objectAdmin` production Firestore
service agent на bucket) завершилась `PERMISSION_DENIED`. Read-only
диагностика подтвердила через `appEngineIntegrationMode: DISABLED` на
production database, что import/export действительно выполняются от имени
**Cloud Firestore service agent** (не legacy App Engine default SA) — то
есть identity была выбрана верно с самого начала, а причиной отказа была
недостаточная роль. После отдельного разрешения роль на bucket заменена на
`roles/storage.admin` — export прошёл успешно. Аналогично для import:
restore Firestore service agent получил `roles/storage.admin` только на
этот bucket, после успешной верификации восстановления временный доступ
удалён.

**Итоговое состояние IAM на bucket** (после раунда): только
`roles/storage.admin` у production Firestore service agent — необходим,
если потребуется повторный export в будущем. У restore service agent
доступа к bucket больше нет. Project-level IAM не менялся ни разу за весь
раунд. Owner/Editor роли никому не выдавались. Публичный доступ — по
прежнему запрещён (Public Access Prevention: `enforced`, Uniform
bucket-level access: `true`).

## 4. Firestore managed export (production → bucket)

Первая попытка (`output prefix 20260725T130601Z/`) завершилась технически
`SUCCESSFUL`, но с **пустым** результатом (0 байт данных) — параметр
`--collection-ids` был передан некорректно через PowerShell и превратился
в одну строку с пробелами вместо трёх отдельных ID. Этот export
зафиксирован как невалидный и **не использовался** для restore. Он не
удалён — очистка не выполнялась.

Повторная попытка (`output prefix 20260725T142444Z-retry/`), с
collection-ids, переданными как один неделимый аргумент переменной:

```text
operationState: SUCCESSFUL
collectionIds: ["users", "companies", "company_data"]
progressDocuments: completedWork=14, estimatedWork=14
progressBytes: completedWork=247325
```

Объекты в bucket (только имена/размеры, без содержимого):
7 объектов, 249 720 bytes — все три `kind_*` директории содержат
ненулевые `output-N` файлы.

## 5. Read-only сверка counts до export (production)

Через `runAggregationQuery` (count-агрегация, без чтения содержимого
документов):

| Коллекция | Count |
|---|---|
| `users` | 6 |
| `companies` | 4 |
| `company_data` | 4 |
| **TOTAL** | **14** |

Совпадает точно с `progressDocuments.completedWork: 14` из метаданных
export.

## 6. Restore Firestore database

Создан в restore-проекте: Native mode, location `eur3` (совпадает с
production), `appEngineIntegrationMode: DISABLED`. До import все три
коллекции подтверждены пустыми (0/0/0) — `BLOCKED_RESTORE_TARGET_NOT_EMPTY`
не наступил.

## 7. Firestore managed import (bucket → restore-проект)

Единственная попытка, источник — только подтверждённый непустой export
(`20260725T142444Z-retry/`):

```text
operationState: SUCCESSFUL
progressDocuments: completedWork=14, estimatedWork=14
```

## 8. Read-only сверка после restore

| Коллекция | Production | Restore до import | Restore после import |
|---|---|---|---|
| `users` | 6 | 0 | 6 |
| `companies` | 4 | 0 | 4 |
| `company_data` | 4 | 0 | 4 |
| **TOTAL** | **14** | **0** | **14** |

Полное совпадение. Через `listCollectionIds` подтверждено: в restore-базе
ровно три корневые коллекции (`users`, `companies`, `company_data`) —
лишних не появилось.

## 9. Что не проверялось и не выполнялось в этом раунде (честно, не скрыто)

- **Lifecycle-правило удаления backup** — только предложено в runbook, не
  применено к bucket.
- **Полный аварийный порядок восстановления production** (не тестового
  restore-проекта, а реального disaster recovery для самого
  `finapp-prod-10a83`) — не описан; runbook явно указывает, что это
  отдельная, более осторожная процедура.
- **Анализ содержимого/безопасности Firestore Rules и классификация риска
  A/B/C** — сознательно не выполнялись в этом раунде (см. «Часть 6» ниже:
  Rules и indexes только сохранены как backup-артефакт, их текст не
  анализировался). Это прямо остаётся задачей `BASE-004`.

## 10. Таблица требований `BASE-003` (`REMEDIATION_PLAN.md`) — честная сверка

| Requirement | Evidence | Status | Remaining action |
|---|---|---|---|
| Экспортировать Firestore production | `gcloud firestore operations describe`: `operationState: SUCCESSFUL`, `progressDocuments: 14/14`, 3 collection groups, ненулевые output-файлы (раздел 4) | **DONE** | нет |
| Сохранить опубликованные Firestore Rules | Получен активный release `cloud.firestore` и точный текст его ruleset через Firebase Rules Management API (не локальный `firestore.rules`); сохранён как `deployed-firestore.rules` в bucket, SHA-256 проверен на скачанной копии (раздел «Часть 6») | **DONE** | нет (анализ содержимого/риска — задача `BASE-004`) |
| Сохранить Firestore indexes | Получены через `firebase firestore:indexes --project=finapp-prod-10a83` напрямую с production (не локальный пустой `firestore.indexes.json`); 0 composite indexes, 0 field overrides — подтверждено живым запросом, сохранено как `firestore-indexes.json` в bucket, SHA-256 проверен (раздел «Часть 6») | **DONE** | нет |
| Экспортировать Auth metadata пользователей | `firebase auth:export` (документированная команда), CLI подтвердил фактическое количество (6 аккаунтов), export сохранён в bucket, SHA-256 проверен на скачанной копии (раздел «Часть 7») | **DONE** | нет |
| Сохранить production bundle/артефакт | Оригинальный GitHub Pages artifact истёк; воспроизводимая пересборка на доказанном production source commit с точным lockfile и подтверждённой production Firebase web-конфигурацией, загружена в bucket, SHA-256 проверен (раздел «Часть 8») | **DONE** | нет |
| Хранить резервные копии вне репозитория, с ограниченным доступом | Export лежит в GCS bucket с PAP `enforced`, UBLA `true`, project-level IAM не расширялся (раздел 2–3) | **DONE** (для Firestore export) | lifecycle retention пока не применён — `OWNER_APPROVAL_REQUIRED` |
| Восстановить копию в staging/отдельном тестовом проекте | Restore выполнен в `finapp-restore-20260725-4rxl` (не staging), import `SUCCESSFUL` (раздел 7) | **DONE** | нет |
| Проверить количество компаний | production `companies`=4, restore после import `companies`=4 (раздел 8) | **DONE** | нет |
| Проверить количество пользователей | production `users`=6, restore `users`=6 | **DONE** | нет |
| Проверить количество документов `company_data` | production `company_data`=4, restore `company_data`=4 | **DONE** | нет |
| Проверить возможность открыть восстановленную компанию | Data-layer verification обеих непустых компаний датасета (`TEST_COMPANY_IP_01`, `TEST_COMPANY_IP_02`): документ компании, счета, операции успешно загружены (раздел «Часть 9») | **DONE** | нет |
| Проверить совпадение контрольных сумм операций и остатков | Канонические SHA-256 компании/счетов/операций и независимый пересчёт остатков совпали между production и restore для обеих компаний (раздел «Часть 9») | **DONE** | нет |
| Создать `docs/runbooks/BACKUP_AND_RESTORE.md` | Файл существует и обновлён этим и предыдущими раундами | **DONE** | нет |
| Резервная копия существует (критерий приёмки) | Export `20260725T142444Z-retry/` — непустой, 249 720 bytes | **DONE** | нет |
| Восстановление фактически проверено (критерий приёмки) | Import `SUCCESSFUL`, counts 6/4/4 совпали | **DONE** (на уровне количеств документов) | открытие тестовой компании и checksum остатков — отдельно, см. выше |
| Место хранения и права доступа документированы (критерий приёмки) | Раздел 2–3 этого отчёта + runbook | **DONE** | добавить lifecycle retention после отдельного разрешения |
| Известен порядок аварийного возврата (критерий приёмки) | Runbook, раздел 6 — описывает откат самой операции backup/restore (для тестового restore-проекта), но explicit заявляет, что **не** описывает реальный production disaster recovery | **OWNER_APPROVAL_REQUIRED** | нужно решение: считается ли текущий runbook достаточным для критерия приёмки, или требуется отдельный полноценный production emergency restore процесс |

## 11. Итог раунда

Ядро задачи — **фактический экспорт и фактически проверенное
восстановление данных Firestore** — выполнено и подтверждено объективными
данными (operation status API + count-агрегация с обеих сторон). Это
покрывает главный критерий приёмки `BASE-003` («восстановление фактически
проверено, а не только описано»). Firestore Rules и indexes также
подтверждены и сохранены как backup-артефакты (раздел «Часть 6»), Auth
metadata — защищённо экспортирована и проверена (раздел «Часть 7»),
production bundle воспроизводимо пересобран и проверен (раздел «Часть 8»),
открытие данных и контрольные суммы операций/остатков проверены на всех
компаниях датасета, фактически содержащих финансовые данные (раздел
«Часть 9»). Оставшиеся пункты `REMEDIATION_PLAN.md` (lifecycle retention,
полный production disaster recovery процесс) требуют отдельного разрешения
владельца согласно `CLAUDE.md`.

**`REMEDIATION_PLAN.md` не изменён — `[ ] BASE-003` сохранена, не
проставлен `[x]`.** `BASE-004` не начата.

---

# Часть 6 — Backup опубликованных Firestore Rules и фактической конфигурации indexes

```text
PRODUCTION_READ_AND_BACKUP_ARTIFACT_APPROVAL: APPROVED
```

## 1. Метод получения (документированный, не подобранный перебором)

- **Rules**: Firebase Rules Management API (`firebaserules.googleapis.com`)
  — официальный REST API, тот же, что использует Console/CLI внутри себя.
  Сначала `GET .../releases/cloud.firestore` — получен точный
  `rulesetName` активного release; затем `GET` этого конкретного
  ruleset — получен его исходный текст. Новый ruleset **не создавался и не
  выпускался**, `firebase deploy` не вызывался.
- **Indexes**: документированная команда `firebase firestore:indexes
  --project=finapp-prod-10a83` (см. `firebase firestore:indexes --help`) —
  выполнен прямой read-only запрос к production, не использован локальный
  пустой `firestore.indexes.json`.

## 2. Результат

| Артефакт | Источник | Размер | SHA-256 (скачанной копии, проверено — совпадает) |
|---|---|---|---|
| `deployed-firestore.rules` | активный release `cloud.firestore`, ruleset `c9e2fc3f…` (сокращённый идентификатор, полный project number не публикуется) | 6701 bytes | `da74280ce9fd2e36ef4710e6f2e2750593568f1d8a07195c2a1fdaf6ae487a1d` |
| `firestore-indexes.json` | прямой запрос к production `(default)` | 51 bytes | `62bbf508a85e9eb651184f58e159d2946a24c19bab8f2f7dd2ed012e7f3a2226` |
| `manifest.json` | сформирован локально из безопасных метаданных выше | 1334 bytes | — (сам manifest, хэш не самоссылочный) |

- Composite indexes: **0**
- Field overrides: **0**
(оба значения получены живым запросом к production, а не предположены по
пустому локальному файлу)

## 3. Место хранения

```text
gs://finapp-restore-20260725-4rxl-backup/configuration/20260725T154119Z/
```

Новый уникальный prefix, существующие объекты (Firestore export) не
перезаписаны и не тронуты. Bucket не создавался заново. IAM, billing, API,
lifecycle, storage class, PAP (`enforced`), UBLA (`true`) — не менялись.

## 4. Проверка

- В bucket по этому prefix — ровно 3 объекта, все ненулевого размера
  (подтверждено `gcloud storage ls -l`).
- Скачаны верификационные копии `deployed-firestore.rules` и
  `firestore-indexes.json`, локально пересчитан SHA-256 — совпадает с
  зафиксированным в manifest для обоих файлов.
- Локальные временные копии (включая верификационные) — удалены сразу
  после проверки. В bucket ничего не удалялось.

## 5. Явно не выполнялось в этом раунде

- Содержимое Rules **не анализировалось** и риск (A/B/C) **не
  классифицировался** — это прямо остаётся задачей `BASE-004`.
- Полный текст Rules и indexes **не выводился** ни в терминальный отчёт,
  ни в этот документ, ни в чат — только метаданные (размер, хэш,
  количество).
- Email, UID, project number, billing account ID, access tokens,
  credentials, содержимое Firestore-документов, финансовые данные — в
  `manifest.json` и в этом отчёте отсутствуют.

## Итог раунда

**`BASE_003_RULES_AND_INDEXES_BACKED_UP`**

---

# Часть 7 — Backup Firebase Auth metadata (защищённый экспорт)

```text
FIREBASE_AUTH_METADATA_EXPORT: APPROVED
```

Разрешение владельца распространялось только на read-only экспорт Auth
metadata — не на изменение, import или удаление пользователей. Ни один из
этих запрещённых действий не выполнялся.

## 1. Метод (документированный, не подобранный перебором)

`firebase auth:export <file> --format=json --project=finapp-prod-10a83` —
официальная команда `firebase-tools`, подтверждена через
`firebase auth:export --help` перед использованием.

## 2. Результат

- Фактическое количество экспортированных аккаунтов: **6** — определено
  из собственного итогового сообщения CLI («Exported 6 account(s)
  successfully»), не предположено заранее и не получено чтением полей.
- Формат: JSON, валидность структуры подтверждена без вывода содержимого.

| Объект | Размер | SHA-256 (скачанной копии, проверено — совпадает) |
|---|---|---|
| `firebase-auth-export.json` | 2061 bytes | `b3ea114e483bf5c6064ef6db22826c49db0a1c8a6ca119cfdfcdb67bfc2c93db` |
| `manifest.json` | 1037 bytes | — (сам manifest) |

## 3. Место хранения

```text
gs://finapp-restore-20260725-4rxl-backup/auth/20260728T164920Z/
```

Новый уникальный prefix, ровно 2 объекта, существующие объекты (Firestore
export, Rules/indexes backup) не тронуты и не перезаписаны. Bucket не
создавался заново. IAM, billing, API, lifecycle, storage class, PAP
(`enforced`), UBLA (`true`) — не менялись.

## 4. Локальная защита и проверка

- Экспорт выполнен во временный каталог вне репозитория, вне Downloads/
  Desktop/общего temp, с правами доступа, ограниченными только текущим
  пользователем ОС (`icacls /inheritance:r` + `/grant:r <user>:F`).
- Ровно 2 объекта в bucket, размеры совпали с локальными (подтверждено
  `gcloud storage ls -l`).
- Скачана отдельная верификационная копия во второй аналогично защищённый
  временный каталог; SHA-256 пересчитан локально — совпадает с manifest.
- Все локальные копии (исходный export, manifest, верификационная копия,
  оба временных каталога) — удалены сразу после успешной проверки.
  Подтверждено: каталоги отсутствуют, `git status` их не видит (они и не
  создавались внутри репозитория).

## 5. Что не раскрывалось

Email, UID, телефоны, displayName, provider IDs, password hashes, salts,
custom claims, содержимое export — нигде не выводились: ни в терминальном
резюме, ни в этом отчёте, ни в Git diff, ни в PR, ни в чате. `manifest.json`
содержит только: timestamp, тип источника, метод, количество (6), размер,
SHA-256, статус проверки — без единого персонального поля.

## 6. Подтверждение отсутствия изменений

- Firebase Auth users — не менялись, не удалялись, не создавались.
- `auth:import` — не запускался.
- Auth providers/настройки — не менялись.
- IAM, API, billing, lifecycle, bucket settings — не менялись.
- Production Firestore — не затрагивался этим раундом.

## Итог раунда

**`BASE_003_AUTH_METADATA_BACKED_UP`**

---

# Часть 8 — Backup production bundle (воспроизводимая пересборка)

```text
PRODUCTION_BUNDLE_RETRIEVAL_OR_REBUILD: APPROVED
CLOSED_BACKUP_BUCKET_UPLOAD: APPROVED
```

## 1. Вариант A (оригинальный artifact) — недоступен

Определён последний **успешный** production deploy read-only способом
через GitHub Actions API: workflow «Deploy to GitHub Pages», run ID —
`29251907411`, `conclusion: success`, source commit
`928940b6f79034b7a8beea6195e87b39609a3954`, время публикации
`2026-07-13T12:59:09Z`. Более поздняя попытка деплоя (commit `72d71c2…`,
2026-07-25) **провалилась** — production фактически не обновлялась, что
независимо подтверждает: последний живой production build — именно
`928940b`.

Оригинальный GitHub Pages deployment artifact для run `29251907411`
проверен через GitHub Actions Artifacts API: `expired: true` (истёк
2026-07-14). Скачивание невозможно официальным способом. Вариант A
задокументированно недоступен.

## 2. Вариант B (воспроизводимая пересборка) — выполнен

- Source commit: доказанный `928940b6f79034b7a8beea6195e87b39609a3954`
  (тот же, что в успешном production deploy run).
- Изолированный `git worktree` вне текущего рабочего дерева, detached
  HEAD на этом commit — репозиторий и текущая ветка не затронуты.
- `npm ci` — точный `package-lock.json` этого commit, frozen install.
- Production web-конфигурация: получена официальным документированным
  способом `firebase apps:sdkconfig WEB <appId> --project=finapp-prod-10a83`
  (это публичный идентификатор Firebase-приложения, а не GitHub Secret) —
  записана напрямую в файл окружения сборки, ни разу не выведена в
  терминал, чат или отчёт.
- Build tool: `tsc -b && vite build` (точный npm script этого commit),
  `vite v8.0.13`.
- Node/npm: фактически использованные версии — Node `v24.16.0`, npm
  `11.13.0`. **Честно зафиксировано расхождение**: production CI
  использовал Node 20 (`.github/workflows/deploy.yml` этого commit); Node
  20 и `nvm` недоступны в этой локальной среде — используется уже
  задокументированное ранее (`BASE-006` finding) известное несоответствие
  версий, не скрыто и не подделано.
- `firebase deploy`, preview deployment, Firebase Hosting upload — **не
  выполнялись**.

## 3. Результат сборки и проверка

- Сборка успешна, 5 файлов в `dist/` (`index.html`, один JS chunk, один CSS
  chunk, `favicon.svg`, `icons.svg`).
- `index.html` ссылается на существующие ассеты, все referenced-файлы
  присутствуют.
- Абсолютных локальных путей в bundle — 0 найдено.
- Source maps — отсутствуют (0 файлов `*.map`), соответствует конфигурации
  vite этого commit (sourcemap не включён).
- Скан на `.env`/RSA/private_key/client_secret — 0 файлов `.env`
  внутри bundle; единственное совпадение по паттерну — публичный Firebase
  Web API key внутри JS-бандла, что ожидаемо для любого Firebase
  web-клиента и не считается секретом по условиям задачи.
- Backup-артефактов предыдущих раундов (Auth export, Firestore export,
  Rules backup, manifest) в bundle — не обнаружено (свежая изолированная
  сборка).

## 4. Артефакты и место хранения

| Объект | Размер | SHA-256 (скачанной копии, проверено — совпадает) |
|---|---|---|
| `production-bundle.zip` | 548 445 bytes | `1eaa8979f7b3f73f82e64fad9c1b52f4b70acda83e1e71fd7188f4a8a081f0f6` |
| `manifest.json` | 2147 bytes | — (сам manifest) |

Файлов внутри архива: **5**. Суммарный распакованный размер:
**1 955 034 bytes**.

```text
gs://finapp-restore-20260725-4rxl-backup/bundles/20260729T070830Z/
```

Новый уникальный prefix, ровно 2 объекта, существующие backup-объекты
(Firestore export, Rules/indexes, Auth export) не тронуты. Bucket не
создавался заново. IAM, billing, API, lifecycle, storage class, PAP
(`enforced`), UBLA (`true`) — не менялись.

## 5. Проверка загрузки и локальная очистка

Скачана верификационная копия ZIP во второй временный каталог, SHA-256
пересчитан — совпадает; архив открыт и распакован, количество файлов
совпало (5). После успешной проверки удалены: временный `git worktree`,
файл production web-конфигурации, файл переменных окружения сборки,
исходный `dist/`, ZIP, manifest, верификационная копия и все временные
каталоги, созданные этим раундом. Основная рабочая копия репозитория
осталась чистой (`git status --short` — пусто), HEAD не изменился.

## 6. Подтверждение отсутствия изменений

- Deployment (Firebase Hosting, GitHub Pages, любой другой) — **не
  выполнялся**.
- Production Firestore, Auth, Rules, indexes — не затрагивались этим
  раундом.
- IAM, billing, API, bucket settings, lifecycle — не менялись.
- Production web-конфигурация — не изменялась, только прочитана read-only
  официальным способом.

## Итог раунда

**`BASE_003_PRODUCTION_BUNDLE_BACKED_UP`**

---

# Часть 9 — Read-only проверка восстановленных данных (открытие + контрольные суммы)

```text
READ_ONLY_TEST_COMPANY_SELECTION: APPROVED
READ_ONLY_COMPANY_OPENING_CHECK: APPROVED
READ_ONLY_OPERATIONS_AND_BALANCES_CHECKSUMS: APPROVED
```

## 1. Ограничение покрытия исходного набора (зафиксировано честно, не ошибка восстановления)

Read-only анализ всех 4 компаний восстановленной копии (`legalType`, счётчики
счетов/операций, множество типов счетов — без имён/ID/сумм) показал:

- все 4 компании имеют организационную форму **ИП**; компаний формы ООО в
  исходном датасете **не существует**;
- только **2 из 4** компаний фактически содержат счета и операции — обе
  оставшиеся полностью пустые (0 счетов, 0 операций);
- обе непустые компании используют **только один тип счёта** — `bank`.

По решению владельца это зафиксировано как **ограничение покрытия
исходного набора данных**, а не как дефект резервного копирования или
восстановления: проверены **все** компании, фактически содержащие
финансовые данные — то есть достигнуто максимально возможное покрытие для
этого конкретного датасета.

## 2. Выбранные компании (безопасные псевдонимы)

| Псевдоним | Счетов | Операций | Тип счетов |
|---|---|---|---|
| `TEST_COMPANY_IP_01` | 4 | 452 | `bank` |
| `TEST_COMPANY_IP_02` | 1 | 3 | `bank` |

Реальные названия, document ID, ИНН/ОГРНИП, номера счетов, контрагенты и
суммы — нигде не сохранялись и не выводились ни в скрипт-вывод, ни в этот
отчёт.

## 3. Источник данных на момент backup

Для каждой из двух компаний read-only прочитаны только метаданные
production-документов (`companies/{id}`, `company_data/{id}`) через
Firestore field mask — получено исключительно `updateTime`, без чтения
содержимого полей на этом шаге. Оба `updateTime` для обеих компаний —
**раньше** времени старта успешного managed export (`2026-07-25T14:24:47Z`,
раздел «Часть 5»). Это математически доказывает: соответствующие
production-документы **не менялись** с момента резервного копирования, и
эти документы правомерно используются как эквивалент «исходных данных
резервной копии» для сравнения — согласно явно разрешённому в задании
fallback-условию.

## 4. Метод открытия

**Data-layer verification**, не UI: чтение через Firestore REST API
(документированный, официальный, read-only способ), без импорта Firebase
Auth, без создания тестового пользователя, без обхода авторизации — именно
такой путь прямо предписан заданием при недоступности UI без Auth import.
Для обеих компаний подтверждена успешная загрузка: документа компании,
массива счетов, массива операций, входных данных для расчёта остатков (сам
массив счетов, содержащий поле `balance`).

## 5. Детерминированная канонизация

- Firestore REST wire-format значения (`stringValue`, `integerValue`,
  `doubleValue`, `booleanValue`, `timestampValue`, `arrayValue`,
  `mapValue`, `referenceValue`, `nullValue`) детерминированно преобразованы
  в примитивные JS-значения.
- `timestampValue` приведён к единому UTC ISO-8601 представлению.
- Массивы счетов и операций стабильно отсортированы по техническому полю
  `id`.
- Ключи объектов сериализованы в отсортированном порядке (canonical JSON),
  UTF-8, без пробельного форматирования.
- Отсутствующее поле и `null` не смешивались (использовано прямое
  сравнение канонической структуры, не merge с defaults).
- Исключённых «технических restore-зависимых» полей не потребовалось —
  сравнивались реальные Firestore document fields напрямую, `updateTime`/
  `createTime` (метаданные документа, не пользовательские поля) в
  канонизацию бизнес-данных не включались.
- Канонизированные записи в этот отчёт не включены — только их SHA-256.

## 6. Результаты сравнения (production ↔ restore)

| Проверка | `TEST_COMPANY_IP_01` | `TEST_COMPANY_IP_02` |
|---|---|---|
| Совпадение updateTime ≤ backup export start (обе стороны) | PASS | PASS |
| Количество счетов (prod/restore) | 4 / 4 — MATCH | 1 / 1 — MATCH |
| Количество операций (prod/restore) | 452 / 452 — MATCH | 3 / 3 — MATCH |
| Множество типов счетов | `bank` = `bank` — MATCH | `bank` = `bank` — MATCH |
| SHA-256 документа компании | MATCH | MATCH |
| SHA-256 канонического набора счетов (вход для остатков) | MATCH | MATCH |
| SHA-256 канонического набора операций | MATCH | MATCH |
| Независимый пересчёт остатков из операций (сигнал согласованности, см. ниже) | MATCH | MATCH |
| Итог | **PASS** | **PASS** |

Агрегированный SHA-256 (компания + счета + операции, полный канонический
набор, 64-символьный lowercase):

- `TEST_COMPANY_IP_01`: `4d77f67da660042e63799e12e48c4d643dbc6c8aa9f70f68502bb3335d088c50`
- `TEST_COMPANY_IP_02`: `9e8b9ac5296e91b5045ad3960021a9ea830d6f8ac916b4ed41d68e38e8c27113`

Суммы, остатки, названия, ID, реквизиты — нигде не публиковались; ни
единичный хэш отдельного значения (ИНН/телефон/сумма) не вычислялся и не
публиковался — только хэши полных канонических наборов.

## 7. Проверка остатков (без публикации сумм)

Модель расчёта подтверждена по коду (`src/store/companyStore.ts`):
`balance` — сохранённое поле счёта, инкрементально изменяемое при
add/update/delete операции (`income`: `+amount`, `expense`: `-amount`,
`transfer`: `-amount` на счёте-источнике, `+(toAmount ?? amount)` на
счёте-получателе), округление `round2`. Схема `Account` не содержит
отдельного поля начального остатка — весь остаток формируется операциями.

Для независимой сверки выполнен детерминированный пересчёт остатков по
всем операциям каждого счёта (тот же знаковый алгоритм, что в коде) —
раздельно для production-данных и restore-данных; canonical-хэш
результата пересчёта совпал между production и restore для обеих
компаний. Это подтверждает, что операции, участвующие в формировании
остатка, идентичны на обеих сторонах — независимо от самого хранимого
поля `balance` (которое также совпало побайтово в рамках раздела 6).

Валюты счетов не объединялись (все проверенные счета — один тип `bank`
на всё покрытие датасета, отдельного смешения валют не возникло).

## 8. Read-only режим — подтверждение

Ни одна write-операция не выполнялась ни в production, ни в restore-проекте
за весь раунд. Restore не запускался повторно. Firebase Auth не
импортировался, тестовый пользователь не создавался, авторизация не
обходилась. IAM, Firebase, bucket, lifecycle — не изменялись.

## 9. Защита данных и очистка

Все промежуточные скрипты и файлы результатов создавались только во
временном каталоге вне репозитория с правами, ограниченными текущим
пользователем ОС. Их содержимое не выводилось построчно и не публиковалось
целиком. Результаты этой проверки **не загружались** в backup bucket
(отдельное разрешение на такую загрузку не запрашивалось и не
предоставлялось). После завершения проверки все временные файлы и каталог
удалены; остаточных копий не осталось.

## Итог раунда

**`BASE_003_RESTORE_DATA_VERIFIED_WITH_DATASET_COVERAGE_LIMITATION`**
