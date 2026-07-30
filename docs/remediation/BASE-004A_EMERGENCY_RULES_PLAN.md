# BASE-004A — Emergency Firestore Rules remediation plan

```text
TASK_ID: BASE-004A-FIX-02
PHASE: EMERGENCY RULES REMEDIATION — LOCAL PREPARATION ONLY
STATUS: BASE_004A_FIX2_READY_FOR_REVIEW (см. §6 и §6a)
DEPLOY: НЕ ВЫПОЛНЯЛСЯ
```

**Требуется НОВЫЙ независимый аудит** — предыдущий раунд ревью завершился
`BASE_004A_REVIEW_FAILED`; изменения этого раунда (см. §6a) не были
проверены независимо и не могут считаться окончательными до отдельного
`REVIEW_RESULT: PASS`.

## 1. Подтверждённая причина уязвимости

Источник: `docs/remediation/SECURITY_BASELINE.md` (BASE-004, независимо
подтверждённая классификация **C**, дата проверки 2026-07-29).

Фактически развёрнутые production Firestore Rules разрешали self-`update`
(и self-`create`) документа `users/{uid}` **без какого-либо ограничения
полей**. Правило для «своей» ветки (`request.auth.uid == userId`) не
отличало безопасное изменение профиля (имя, аватар) от изменения полей,
определяющих права доступа (`role`, `companyId`, `companies[]`).

Итоговая цепочка эксплуатации (полностью статически подтверждена в
BASE-004, раздел 9):

1. Авторизованный пользователь выполняет `update` своего же `users/{uid}`.
2. Одним запросом одновременно меняет `companyId` (или добавляет элемент в
   `companies[]`) на ID **любой чужой компании** и `role` на `'admin'`.
3. `isMember()`/`isAdminOf()` в остальных правилах вычисляются **только** по
   этому документу — они не видят разницы между «настоящим» и
   только что подделанным membership.
4. Результат — полный read/write доступ (включая `company_data`, то есть
   финансовые данные) к **любой** компании, чей `companyId` известен
   атакующему.

Дополнительно (HIGH, BASE-004 раздел 12): `company_data/{companyId}`
`create` не проверял membership вообще — создание документа для
несуществующего `companyId` было возможно любому авторизованному
пользователю.

## 2. Исправленная модель

Реализована в `firestore.rules` (deny-by-default, единственный wildcard в
конце файла — явный `allow read, write: if false`).

### Модель авторизации — оценка

Задание требует явно оценить, можно ли безопасно использовать `users/{uid}`
как источник membership, если сам документ частично изменяется
пользователем. Порядок предпочтения по заданию:

1. Серверные custom claims / отдельная server-controlled `members`
   подколлекция — **не реализовано**. В проекте нет Cloud Functions и нет
   custom claims — это не симулируется и не выдаётся за существующую
   защиту.
2. Документы, которые клиент не может создавать/изменять — **не
   реализовано** по той же причине (нет серверного пути записи).
3. Пользовательские профильные поля, доверенные ТОЛЬКО если клиент физически
   не может их изменить — **это и есть выбранный emergency-подход**.

Поскольку пп. 1–2 требуют отдельной миграции (Cloud Functions), которая
явно запрещена рамками `BASE-004A` («не выполняй её скрытно»), реализовано
минимально безопасное экстренное ограничение по п.3: `role`, `companyId`,
`companies[]`, `id`, `email` в `users/{uid}` **нельзя изменить клиенту
вообще** — ни на своём документе (кроме create без этих полей), ни тем
более на чужом. Это делает поле `companyId`/`role` уже существующих
документов доверенным для остальных правил (`isMemberOf`, `isAdminOf`),
поскольку начиная с этого коммита ни один клиентский запрос не может его
изменить.

### users/{userId}

| Операция | Правило |
|---|---|
| `get` | свой документ, либо коллега ОСНОВНОЙ компании (`resource.data.companyId == callerProfile().companyId`) — этот путь `BASE-004A-FIX-02` не менял, т.к. сообщённый дефект и реальный app-flow (страница «Пользователи», `switchCompany()`) используют `list`/query, а не адресный `get` чужого документа |
| `list` | только query, где КАЖДЫЙ потенциальный документ результата принадлежит компании из `isMemberOf(resource.data.companyId)` — основной ИЛИ дополнительной (`companies[]`); неограниченный и межкорпоративный query запрещён (BASE-004A-FIX-02: **исправлено** — до этого раунда ошибочно проверялась только основная компания, из-за чего запрос сотрудников ДОПОЛНИТЕЛЬНОЙ компании отклонялся, см. §6a) |
| `create` | только свой `uid`; `id == uid`; поля `role/companyId/companies/email/owner*/admin*/createdAt` должны ОТСУТСТВОВАТЬ |
| `update` (свой) | allowlist через `diff().affectedKeys().hasOnly([...])` — разрешены только `name`, `avatar` |
| `update` (чужой) | `false` — управление участниками другой персоной через клиентские Rules не реализовано (см. §4, архитектурный долг) |
| `delete` | `false` для всех — закрывает обход через delete + recreate |

### companies/{companyId}

| Операция | Правило |
|---|---|
| `get` | только подтверждённый участник (`isMemberOf`) либо `ownerId == себе` |
| `list` | запрещён; приложение получает известные компании адресными `get` |
| `create` | любой авторизованный, но `ownerId` обязан равняться вызывающему — не расширяет доступ к чужим данным (новая компания изначально ничья) |
| `update` | только `admin` этой же компании; allowlist полей (`name/legalType/inn/currency`); `ownerId`/`id` неизменны |
| `delete` | `false` |

### company_data/{companyId}

| Операция | Правило |
|---|---|
| `get` | только подтверждённый участник (`isMemberOf`) — закрывает межкорпоративный доступ |
| `list` | запрещён; приложение читает один известный документ компании адресным `get` |
| `create` | только участник с ролью `accountant`/`admin` (viewer не пишет) — закрывает HIGH-риск (create без проверки membership) |
| `update` | `accountant`/`admin`; поле `closingDate` — только `admin` (через `diff().affectedKeys()`) |
| `delete` | `false` для всех ролей |

Отсутствие `users/{uid}` у вызывающего в любой из веток приводит к отказу
(`callerHasProfile()` требует `exists()`, иначе fail-closed) — соответствует
требованию CLAUDE.md §6.2.

## 3. Список закрытых сценариев

- **CRITICAL** (BASE-004 §12): self-update `role`/`companyId`/`companies[]`
  — закрыто (allowlist на self-update, полное исключение auth-полей на
  self-create).
- **HIGH**: `company_data` create без проверки membership — закрыто (create
  требует `roleForCompanyIn(companyId, ['accountant','admin'])`, что само по
  себе требует `isMemberOf`).
- Delete + recreate обход `users/{uid}` — закрыто (`delete` запрещён
  полностью; `create` тоже не пропускает auth-поля).
- Admin одной компании управляет пользователями/компанией/данными другой —
  закрыто на всех трёх коллекциях (`isAdminOf(companyId)` всегда привязан к
  конкретному `companyId` из пути, а не к произвольно заявленному).
- Массовое чтение `users`, `companies`, `company_data` — закрыто настоящими
  query-тестами; Rules не полагаются на ошибочное предположение, что
  Firestore отфильтрует результаты после `allow list`.
- Роль основной компании не переносится на дополнительные memberships:
  каждая роль определяется по точной паре `{companyId, role}`. Конфликтующие
  роли обрабатываются fail-closed.
- `closingDate` — самоназначение через подделанную роль `admin` больше не
  проходит, поскольку сама роль больше не может быть подделана.
- **BASE-004A-FIX-02**: пользователь с валидным membership в дополнительной
  компании больше НЕ получает permission-denied при чтении списка её
  сотрудников (реальный `where('companyId', '==', selectedCompanyId)` из
  входа с ранее выбранной компанией, `switchCompany()` и загрузки списка
  сотрудников выбранной компании) — при этом межкорпоративное чтение
  (компания, в которой вызывающий НЕ состоит вообще) остаётся заблокировано
  на уровне «каждый потенциальный документ результата», а не как
  постфактум-фильтр (см. §6a).

## 4. Оставшиеся архитектурные риски (НЕ устранены в этом патче)

1. **Нет серверного (Cloud Functions/custom claims) пути для управления
   membership.** Это не симулируется как существующая защита — это
   зафиксированный архитектурный долг, соответствует `SEC-001`/`SEC-011` в
   `REMEDIATION_PLAN.md`. Рекомендация: callable Cloud Function с Admin SDK
   для регистрации нового владельца компании, приглашения сотрудника, смены
   роли, удаления сотрудника — с проверкой на сервере, а не в Rules.
2. `company_data` остаётся моно-документом без гранулярной проверки полей
   (кроме `closingDate`) — `accountant` технически может изменить любые
   другие агрегатные поля одним вызовом (MEDIUM, унаследовано из
   BASE-004 §12, не новая проблема).
3. Нет статуса `disabled` для пользователя — единственный способ отключить
   доступ сотруднику — удаление документа (в новых Rules строго запрещено
   для клиента) или ручное изменение через Firebase Console/Admin SDK (LOW,
   унаследовано из BASE-004 §12).
4. Самостоятельная регистрация нового пользователя, создающего новую
   компанию, теперь физически не может пройти через клиентские Rules (см.
   breaking changes, §5) — это преднамеренное следствие emergency-модели, а
   не забытый кейс.

## 5. Возможные breaking changes

Эти клиентские операции писали `role`/`companyId`/`companies` в
`users/{uid}` напрямую и теперь будут отклонены новыми Rules:

| Операция в коде | Файл | Эффект под новыми Rules |
|---|---|---|
| Регистрация нового аккаунта + новой компании | `src/store/authStore.ts` → `register()` | `setDoc(users/{uid}, {role:'admin', companyId, ...})` — **отклонено** (auth-поля на create) |
| Auto-recovery отсутствующего `users/{uid}` | `src/store/authStore.ts` → `onAuthStateChanged` | Тот же паттерн — **отклонено**; приложение переходит в уже предусмотренный localStorage-fallback (сам код это уже обрабатывает как soft-failure) |
| Приглашение сотрудника | `src/store/authStore.ts` → `inviteUser()` | `setDoc(users/{newUid}, {role, companyId, ...})` от лица админа-приглашающего — **отклонено** (чужой документ, `update`/`create` не self) |
| Смена роли участника | `src/store/authStore.ts` → `updateUser()` (`role` в `updates`) | `updateDoc` чужого `users/{uid}` — **отклонено** |
| Удаление сотрудника | `src/store/authStore.ts` → `removeUser()` | `deleteDoc(users/{uid})` — **отклонено** (delete запрещён для всех) |
| Создание доп. компании (multi-company) | `src/store/authStore.ts` → `createCompany()` | `updateDoc(users/{uid}, {companies: [...]})` — **отклонено** (self-update, поле не в allowlist) |

Явно НЕ затронуто (продолжает работать): чтение своих/коллег данных,
редактирование `name`/`avatar`, операции с `company_data` в рамках уже
существующего членства (транзакции, счета, категории и т.д. — см. позитивные
тесты §6), создание НОВОЙ компании (`companies/{companyId}` create, без
привязки `users/{uid}` — сама компания создаётся, но стать её `admin`
через `users/{uid}` пользователь после этого патча уже не может клиентски).

**Приложение не тестировалось непосредственно в браузере в рамках
`BASE-004A`** (задача — подготовка Rules и тестов, не UI-регрессия). Список
выше основан на статическом чтении `src/store/authStore.ts` и должен быть
подтверждён владельцем/QA перед любым production-действием.

## 6. Результаты Emulator Suite

**Выполнено успешно** — блокер снят установкой portable JDK 21 (только для
этой сессии, вне системы; подробности — раздел ниже).

### Portable JDK 21 — источник и проверка

- Официальный источник: **Eclipse Adoptium (Temurin)**, метаданные получены
  через официальный API `api.adoptium.net`, сам архив — с официального
  GitHub-релиза `adoptium/temurin21-binaries`.
- Версия: `21.0.12+8` (LTS), архитектура `x64`, файл
  `OpenJDK21U-jdk_x64_windows_hotspot_21.0.12_8.zip`.
- Опубликованный SHA-256 (зафиксирован ДО скачивания, из ответа
  `api.adoptium.net` и независимо из `<файл>.sha256.txt` того же релиза —
  оба совпали друг с другом):
  `9ba963ee2371874a74185d18bc7bb2ab9407df7683300855ed7606e0662321d0`
- Фактический SHA-256 после скачивания — **совпал побитово** с
  опубликованным.
- Размещение: временный каталог сессии (scratchpad), **вне репозитория**;
  архив и распакованный JDK не добавлены и не могли быть добавлены в git
  (вне рабочего дерева проекта).
- `JAVA_HOME`/`PATH` установлены **только в переменных окружения текущего
  процесса** перед запуском `npm run test:rules`; глобальный `JAVA_HOME`,
  системный `PATH` и уже установленная Java 17 не менялись. Права
  администратора не запрашивались и не требовались (обычная распаковка
  zip).

### Фактические версии на момент прогона

```text
$ java -version   (в изменённом только для этого процесса PATH)
openjdk version "21.0.12" 2026-07-21 LTS
OpenJDK Runtime Environment Temurin-21.0.12+8 (build 21.0.12+8-LTS)

$ npx firebase --version
15.24.0

$ node --version
v24.16.0

$ npm ls @firebase/rules-unit-testing vitest
@firebase/rules-unit-testing@5.0.1
vitest@4.1.10
```

### Команда запуска

```bash
npm run test:rules
# = firebase emulators:exec --project demo-finapp --only firestore \
#     "vitest run tests/rules"
```

### Найденные и исправленные в процессе прогона и независимого ревью проблемы

Четыре реальные ошибки обнаружены компиляцией, Emulator Suite и независимым
security-review. Security-модель не ослаблялась:

1. **Синтаксис Rules**: `memberships.filter(m => m.companyId == companyId)`
   не компилировался — Firestore Rules (CEL-подмножество) не поддерживает
   произвольные лямбды/`.filter()`/`.map()` со стрелочными функциями.
   Первоначально исправлено на bounded-перебор по индексам. После ревью
   заменено на проверку точных пар `{companyId, role}`: это поддерживает
   десять memberships без превышения лимита Rules в 1000 выражений.
2. **Логическая ошибка в `users/{userId}` create**: поле `id` одновременно
   требовалось (`request.resource.data.id == userId`) и было в списке
   запрещённых `authSensitiveFields` — из-за этого ЛЮБОЙ `create`,
   включая полностью легитимный (без auth-полей), отклонялся. Исправлено
   удалением `id` из списка запрещённых полей: `id` не auth-опасен сам по
   себе, поскольку жёстко зафиксирован равным `uid` вызывающего отдельной
   явной проверкой — подделать чужой `id` по-прежнему невозможно.
3. **CRITICAL list/query leak**: `allow list: if callerHasProfile()` разрешал
   любому пользователю с профилем перечислить чужие `users`, `companies` и
   `company_data`. Firestore Rules не являются фильтрами. Исправлено:
   `users` требует query, ограниченный `caller.companyId`, а list для
   `companies` и `company_data` запрещён.
4. **HIGH role bleed**: старая реализация проверяла наличие дополнительной
   компании, но брала `role` из основной. Исправлено вычислением роли по
   точной паре `{companyId, role}` отдельно для каждой компании. Неизвестные,
   отсутствующие и конфликтующие роли не дают доступ.

После исправлений весь набор перезапущен полностью (не частично) и все
55 тестов подтверждены зелёными (этот раунд — см. §6a — довёл число до 77).

### Итоговый результат (раунд после независимого ревью, до FIX-02)

```text
 Test Files  1 passed (1)
      Tests  55 passed (55)
   Duration  5.43s
```

**passed: 55, failed: 0, skipped: 0.** Ни один security-тест не был ослаблен
или пропущен ради зелёного результата.

55 discrete `it()`-проверок покрывают все 21 обязательных сценария из
задания (некоторые сценарии разбиты на несколько `it()` для ясности вывода)
плюс позитивные app-flow, настоящие `getDocs(query(...))`, per-company role
и malformed-membership сценарии. Использованы только синтетические
`uid`/`companyId`/email (`uid_admin_a`, `companyA_synthetic`,
`admin.a@example.test` и т.п.) — реальные production-идентификаторы нигде
не используются.

`npm run lint`, `npm run build`, `tsc -b` (приложение), отдельный typecheck
теста — все зелёные (см. §8 отчёта задачи).

## 6a. BASE-004A-FIX-02 — исправление чтения сотрудников доп. компании

Предыдущий независимый аудит завершился `BASE_004A_REVIEW_FAILED` и выявил
новый подтверждённый дефект (независимо от четырёх проблем §6): пользователь
с валидным membership в ДОПОЛНИТЕЛЬНОЙ компании (не основной) не мог
выполнить query сотрудников этой компании — реальный app-flow
(`where('companyId', '==', selectedCompanyId)`, используется при входе с
ранее выбранной доп. компанией, в `switchCompany()`, при загрузке списка
сотрудников выбранной компании) получал `permission-denied`.

### Первопричина

`allow list` для `users/{userId}` сравнивал `resource.data.companyId`
**только** с `callerProfile().companyId` (основной компанией) — тот же
самый паттерн, что уже был устранён для `get`/`company_data`/`companies` в
предыдущем раунде, но был пропущен для `list` коллекции `users`.

### Baseline-воспроизведение (до исправления, commit `bfa23b6`)

Регрессионный тест добавлен в `tests/rules/firestore.rules.test.ts` (блок
`BASE-004A-FIX-02`, тест `BASELINE (defect reproduction)`) ДО правки
`firestore.rules` и прогнан против неисправленных Rules:

```text
$ npm run test:rules   (commit bfa23b6, firestore.rules ЕЩЁ НЕ изменён)

 Tests  77 total | 7 failed | 70 passed

FAIL BASELINE (defect reproduction): additional member of B can query
     B's employees — must now ALLOW
FAIL 3. additional admin role can query the additional company employees
FAIL 4. additional accountant role can query the additional company employees
FAIL 5. additional viewer role can query the additional company employees
FAIL 6. a valid membership at the tenth position can still query that company
FAIL 7. query matches the real switchCompany() app flow
FAIL 20. admin of A / viewer of B does not get admin-level access in B
         via query-adjacent write

FirebaseError: evaluation error at L168:22 for 'list' @ L168, false for
'list' @ L264, false for 'list' @ L168, false for 'list' @ L264
```

Ровно 7 новых тестов, завязанных на чтение дополнительной компании, падают
с `permission-denied`; все 70 остальных (включая полный набор из 55
существующих) уже проходят — подтверждает, что дефект локализован именно в
`list` для `users` и не является более широкой регрессией.

### Точное исправление

`firestore.rules`, блок `match /users/{userId}` — заменено сравнение с
единственной (основной) компанией на ту же роль-функцию `isMemberOf`,
которая уже безопасно используется для `companies`/`company_data`:

```diff
- allow list: if callerHasProfile() &&
-   resource.data.companyId == callerProfile().companyId;
+ allow list: if isMemberOf(resource.data.companyId);
```

`isMemberOf` вызывает уже существующую `existingProfileRoleIn`, которая:
- проверяет и основную (`profile.companyId`), и дополнительные
  (`profile.companies[]`) компании по точной паре `{companyId, role}`;
- никогда не переносит роль основной компании на дополнительную;
- ограничена ≤10 memberships (fail-closed при превышении);
- fail-closed при `null`, отсутствующем `companyId`, неизвестной роли и
  `companies[]` неправильного типа.

**Уточнение про дубли membership** (независимый аудит указал на неточную
формулировку выше — исправлено): `hasViewer`/`hasAccountant`/`hasAdmin` в
`existingProfileRoleIn` — это булевы «есть ли хотя бы один элемент,
РАВНЫЙ точно `{companyId, role}}`», а не счётчик вхождений. Из этого прямо
следует:
- **Идентичные повторяющиеся записи для одной и той же компании с одной и
  той же ролью — ДОПУСКАЮТСЯ и НЕ являются проблемой.** Повтор `{companyId:
  B, role: 'viewer'}` дважды/трижды в `companies[]` даёт ровно тот же
  результат, что и один такой элемент: `hasViewer = true`,
  `hasAccountant = hasAdmin = false`, доступ — как у `viewer` компании B.
  Дополнительных прав повтор не даёт (подтверждено тестом «duplicate
  identical viewer memberships do not elevate privileges» —
  `assertSucceeds(getDoc(company_data/B))` для viewer-доступа,
  `assertFails` на попытку `admin`-операции с той же membership).
- **Конфликтующие записи для одной и той же компании с РАЗНЫМИ ролями —
  отклоняются (fail-closed).** Если для одного `companyId` одновременно
  присутствуют, например, `{companyId: B, role: 'viewer'}` и
  `{companyId: B, role: 'admin'}`, то оба `hasViewer` и `hasAdmin`
  становятся `true` одновременно → `additionalRoleIsUnambiguous = false`
  → весь доступ к компании B отклоняется целиком (ни viewer-, ни
  admin-права не выдаются) — подтверждено тестом «conflicting roles for
  the same additional company deny all access».
- Это же правило распространяется на конфликт между основной ролью
  (`profile.role`) и ролью в `companies[]` для той же компании
  (`profile.companyId == companyId` случай) — подтверждено тестом «an
  additional role conflicting with the primary role denies access».

Поскольку `list` в Firestore Rules вычисляется НЕ как постфактум-фильтр, а
как условие, которое должно быть доказуемо истинным для КАЖДОГО
потенциального документа результата (`resource.data` при `list` — это
данные рассматриваемого документа-кандидата), замена автоматически
сохраняет все существующие запреты: документ чужой (совсем не входящей в
`isMemberOf`) компании по-прежнему проваливает проверку → весь query
целиком отклоняется — неограниченный, межкорпоративный, `in`-query со
смешанными компаниями, `limit()`/`orderBy()` без `companyId`-ограничения —
все по-прежнему `DENY` (подтверждено новыми тестами 8–12, 19, 21).

Никакие другие правила (`create`/`update`/`delete` для `users`,
`companies`, `company_data`) не менялись.

### Новые тесты (добавлены, не заменяют существующие)

22 новых `it()` в блоке `BASE-004A-FIX-02` (`tests/rules/firestore.rules.test.ts`):
1 baseline-воспроизведение + 6 позитивных (основная компания, доп.
admin/accountant/viewer, десятая membership-позиция, реальный
`switchCompany()`-паттерн) + 15 негативных (чужая компания, смешанный
`in`-query, неограниченный `list`/`limit`/`orderBy`, адресный `get` чужой
компании, неизвестная роль, membership без `companyId`, `null`-элемент в
списке, `companies[]` неверного типа, >10 memberships, отсутствие
admin-прав в доп. компании, доступ к третьей несвязанной компании C,
попытки изменить auth-sensitive поля и `ownerId` компании).

### Итоговый результат (этот раунд, после исправления)

```text
 Test Files  1 passed (1)
      Tests  77 passed (77)
   Duration  8.60s
```

**passed: 77, failed: 0, skipped: 0** (прогнано дважды подряд для
стабильности — оба раза 77/77). Все 55 ранее существовавших тестов не
изменены и по-прежнему проходят — регрессии нет.

## 7. Точные команды безопасной локальной проверки

Выполнить после установки Java 21+ (например, Temurin/Adoptium JDK 21,
скачанного владельцем самостоятельно и проверенного по официальной
контрольной сумме):

```bash
npm install
npm run test:rules
```

`test:rules` оборачивает Firestore Emulator (`firebase emulators:exec
--only firestore`) вокруг `vitest run tests/rules` — эмулятор поднимается,
тесты выполняются против локального `firestore.rules`, эмулятор
останавливается. Никакого сетевого обращения к production не происходит
(`--project demo-finapp` — демонстрационный, не связан с реальным Firebase
проектом).

Дополнительно уже выполнено и задокументировано в отчёте задачи (см.
`docs/remediation/reports/BASE-004A.md`): `npm run lint`, `tsc -b`,
`npm run build`, `git diff --check`, `git status --short`, secret/PII/
financial/Firebase-identifier/absolute-path сканы.

## 8. Оценка влияния на работающие функции приложения

- **Не затронуто:** чтение существующих данных, все read-only страницы,
  редактирование транзакций/счетов/категорий/бюджетов/платёжного календаря
  в рамках уже существующего членства, редактирование имени/аватара
  профиля, создание новой компании как отдельного документа.
- **Затронуто (breaking, см. §5):** регистрация нового пользователя/новой
  компании, приглашение сотрудника, смена роли участника, удаление
  сотрудника, добавление доп. компании существующему пользователю
  (multi-company). Все — потому что раньше писали auth-поля `users/{uid}`
  напрямую с клиента; теперь для этого нужен серверный путь, которого пока
  нет (архитектурный долг, §4).

## 9. Production deployment checklist (НЕ выполнено — только план)

Выполнять только после независимого ревью и явного:

```text
PRODUCTION_ACTION_APPROVED: BASE-004A
BACKUP_REFERENCE: <актуальная проверенная резервная копия, см. BASE-003>
ROLLBACK_REFERENCE: <ссылка/идентификатор текущего активного ruleset из BASE-004>
```

1. Подтвердить, что активный production ruleset всё ещё совпадает с тем,
   что зафиксирован в `SECURITY_BASELINE.md` (повторный read-only запрос
   через Rules Management API — ruleset мог измениться с 2026-07-29).
2. Установить Java 21+ и реально прогнать все 77 тестов через
   `npm run test:rules` — все должны быть **PASS**, ни один не может
   остаться непроверенным для production deploy.
3. Провести ручную проверку в Firebase Console → Firestore → Rules →
   Playground для CRITICAL-сценария (self-update companyId/role) И для
   BASE-004A-FIX-02 (query сотрудников дополнительной компании) на копии
   правил.
4. Получить **новый независимый аудит** этого раунда (`BASE-004A-FIX-02`) —
   предыдущий закончился `BASE_004A_REVIEW_FAILED`; изменения `firestore.rules`
   и `tests/rules/firestore.rules.test.ts` этого раунда ещё не проверены
   независимо.
5. Согласовать с владельцем продукта breaking changes из §5 — предупредить
   пользователей/поддержку, что приглашение/удаление сотрудников и
   регистрация новых компаний временно не работают до реализации Cloud
   Functions (или явно принять этот риск на время).
6. Выбрать корректный target project (`production`, НЕ `staging`) —
   `firebase deploy --only firestore:rules --project production`.
7. Сохранить `rulesetName`/дату текущего активного (заменяемого) ruleset
   ДО deploy — это и есть rollback-точка (см. §10).
8. Выполнить deploy.
9. Сразу выполнить пост-деплой проверки (§11).

## 10. Rollback-план

Если после deploy обнаружены проблемы (легитимные операции ошибочно
блокируются шире, чем в §5, либо иной unexpected deny):

1. Через Firebase Rules Management API (или Console → Rules → History)
   выпустить как активный **предыдущий** `rulesetName`, сохранённый в
   шаге 9.6 выше — это откатывает Rules без потери данных (Rules не
   затрагивают сами документы).
2. Данные не требуют восстановления из backup — этот патч не пишет и не
   удаляет ни один документ, только меняет разрешения доступа.
3. Зафиксировать в отчёте задачи причину отката и вернуть `BASE-004A` в
   `CHANGES REQUIRED`.

## 11. Post-deploy проверки

- Firebase Console → Firestore → Rules → Playground: повторно прогнать
  CRITICAL-сценарий из BASE-004 §9 (self-update `companyId`+`role`) на
  **реальном** активном ruleset — ожидаемый результат: `deny`.
- Один заранее согласованный с владельцем реальный аккаунт каждой роли
  (`admin`/`accountant`/`viewer`) должен подтвердить: чтение своей компании
  работает, `viewer` не может писать, `admin` может закрыть период.
- Мониторинг ошибок Firestore permission-denied в течение первого часа
  после deploy — рост ошибок сверх ожидаемого (по §5) означает, что
  breaking changes задели больше, чем предполагалось, и нужен rollback.

## 12. Явное подтверждение

**Deploy не выполнялся.** Ни `firebase deploy`, ни изменения через Firebase
Console, ни изменения Firebase Auth/IAM/пользователей, ни production/
staging-данные в рамках `BASE-004A` не затрагивались. Все действия этой
задачи — локальная подготовка файлов и локальные (read-only относительно
внешних систем) проверки.

Любое из действий §9 (production deploy) требует ОТДЕЛЬНОГО явного
**`PRODUCTION_ACTION_APPROVED: BASE-004A`** с `BACKUP_REFERENCE` и
`ROLLBACK_REFERENCE`, переданного владельцем — этот документ такого
разрешения не содержит и не заменяет его.
