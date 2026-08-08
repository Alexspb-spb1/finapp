# FINAPP — пошаговый план устранения рисков

**Проект:** `Alexspb-spb1/finapp`<br>
**Исходная ветка аудита:** `claude/repository-analysis-mkk7mg`<br>
**Основание:** независимый аудит React / TypeScript / Firebase<br>
**Статус документа:** обязательный порядок исполнения<br>
**Дата фиксации плана:** 2026-07-13

---

## 1. Как пользоваться этим документом

Этот файл следует положить в корень репозитория, например под именем:

```text
REMEDIATION_PLAN.md
```

Работа ведётся **строго сверху вниз**. Переход к следующему контрольному этапу запрещён, пока не выполнены критерии приёмки текущего этапа.

Статусы задач:

- `[ ]` — не начато;
- `[-]` — в работе;
- `[x]` — выполнено и принято ревьюером;
- `[!]` — заблокировано, причина записана рядом.

### Обязательный цикл для каждого пункта

1. Создать отдельную ветку по указанному ID задачи.
2. Зафиксировать текущее поведение тестом или воспроизводимым сценарием.
3. Внести только изменения, относящиеся к этой задаче.
4. Запустить обязательные проверки.
5. Приложить к PR: diff, вывод тестов, риски, миграционные последствия и способ отката.
6. Получить ревью.
7. Только после приёмки поставить `[x]` и перейти дальше.

### Запрещено

- объединять в одном PR исправление безопасности, миграцию данных и UX-рефакторинг;
- «чинить» права только скрытием кнопок;
- деплоить Firestore Rules без emulator-тестов;
- мигрировать production без резервной копии, dry-run и сверки;
- оставлять fallback, который при ошибке Firestore разрешает работу с повышенными правами;
- использовать `Date.now()` как гарантию уникальности, порядка записей или разрешения конфликтов;
- продолжать хранить полный финансовый набор данных в `localStorage` после этапа `STATE-004`;
- возвращать пользователю визуальный успех, если запись в Firestore не подтверждена;
- переписывать весь проект одним большим PR.

---

## 2. Общие критерии готовности каждого PR

Каждый PR обязан проходить:

```bash
npm ci
npm run lint
npm run typecheck
npm run test:run
npm run build
```

После появления соответствующих наборов тестов также обязательны:

```bash
npm run test:rules
npm run test:e2e
```

Для задач миграции дополнительно обязательны:

```text
- dry-run;
- отчёт о количестве прочитанных/созданных/пропущенных документов;
- сверка контрольных сумм;
- повторный запуск без создания дублей;
- документированный rollback.
```

Если один из обязательных шагов не проходит, задача не считается выполненной.

---

# ЭТАП 0. Фиксация исходного состояния и безопасный контур

## Цель этапа

До изменения логики получить воспроизводимую исходную точку, staging-окружение, резервную копию и фактические production Firestore Rules. Без этого дальнейшие изменения могут либо потерять данные, либо заблокировать пользователей.

---

## [x] BASE-001 — Зафиксировать исходный commit и заморозить функциональные изменения

**Ветка:** `remediation/BASE-001-baseline`

### Действия

1. Зафиксировать SHA commit, на котором начинается исправление.
2. Создать основную техническую ветку, например:

```text
remediation/main
```

3. До завершения этапов 0–4 не принимать новые продуктовые функции.
4. Добавить файл:

```text
docs/remediation/BASELINE.md
```

5. Записать в него:
   - commit SHA;
   - версию Node.js;
   - версию npm;
   - Firebase project ID для production;
   - текущий URL приложения;
   - дату последнего production deployment;
   - ответственного за доступ к Firebase Console;
   - известные аварийные контакты и способ вернуть предыдущую сборку.

### Критерий приёмки

- существует неизменяемая исходная точка;
- понятно, из какого commit выполняется аудит и исправление;
- новые feature-PR не смешиваются с remediation.

---

## [x] BASE-002 — Создать отдельное staging Firebase-окружение

**Ветка:** `remediation/BASE-002-staging`

### Действия

1. Создать отдельный Firebase/GCP project для staging.
2. В staging включить только необходимые сервисы:
   - Firebase Authentication;
   - Cloud Firestore;
   - Cloud Functions;
   - Emulator-compatible конфигурацию;
   - App Check позже, на этапе `SEC-013`.
3. Добавить в репозиторий:

```text
.firebaserc
firebase.json
.env.example
```

4. Разделить конфигурацию окружений:

```text
.env.development.local
.env.staging.local
.env.production.local
```

5. В Git хранить только `.env.example` без реальных значений.
6. Service account, ключи email-провайдера и другие настоящие секреты не помещать в клиентские `VITE_*` переменные и не коммитить.
7. Добавить явный визуальный индикатор staging-сборки, чтобы её нельзя было спутать с production.

### Критерий приёмки

- staging никогда не обращается к production Firestore/Auth;
- production и staging имеют разные project ID;
- локальная разработка может запускаться через Emulator Suite;
- секреты отсутствуют в Git.

---

## [x] BASE-003 — Сделать резервную копию production и проверить восстановление

> Independent review: PASS (commit `2bcd6171194ee96ead28d03dcef8a7823f93d18e`).
> Полная evidence — `docs/remediation/reports/BASE-003.md`. Незакрытыми
> остаются два отдельных управленческих решения владельца (не блокируют
> отметку `[x]` по критериям этой задачи, требуют отдельного разрешения
> перед выполнением): lifecycle retention для backup bucket; полноценный
> production disaster recovery process.

**Ветка:** документационная задача, отдельный кодовый PR не обязателен.

### Действия

1. Экспортировать Firestore production.
2. Сохранить опубликованные Firestore Rules.
3. Сохранить Firestore indexes.
4. Экспортировать Auth metadata пользователей безопасным способом.
5. Сохранить текущий production bundle/артефакт.
6. Хранить резервные копии вне публичного репозитория, с ограниченным доступом.
7. Восстановить копию в staging или отдельном тестовом проекте.
8. Проверить:
   - количество компаний;
   - количество пользователей;
   - количество документов `company_data`;
   - возможность открыть восстановленную компанию;
   - совпадение контрольных сумм операций и остатков.
9. Добавить:

```text
docs/runbooks/BACKUP_AND_RESTORE.md
```

### Критерий приёмки

- резервная копия существует;
- восстановление фактически проверено, а не только описано;
- место хранения и права доступа документированы;
- известен порядок аварийного возврата.

---

## [x] BASE-004 — Получить фактически развёрнутые Firestore Rules и классифицировать риск

**Принято и слито:** PR [#5](https://github.com/Alexspb-spb1/finapp/pull/5), merge SHA `1a642460b21e27cc1c0973cb4141ebffc81e4a0f`.

**Ветка:** `remediation/BASE-004-rules-baseline`

### Действия

1. Скопировать именно опубликованные production Rules из Firebase Console в закрытый рабочий документ.
2. Сравнить их с фактическими путями:

```text
users/{uid}
companies/{companyId}
company_data/{companyId}
```

3. Проверить минимум следующие сценарии:
   - неавторизованный пользователь;
   - любой авторизованный пользователь;
   - пользователь своей компании;
   - пользователь другой компании;
   - viewer;
   - accountant;
   - admin;
   - удалённый пользователь;
   - пользователь без документа `users/{uid}`.
4. Классифицировать состояние:

```text
A — deny-by-default и membership/role проверяются;
B — проверяется только auth или companyId частично;
C — чтение/запись открыты шире необходимого.
```

5. Создать:

```text
docs/remediation/SECURITY_BASELINE.md
```

### Аварийная развилка

Если обнаружено состояние `B` или `C`:

1. включить maintenance/read-only режим приложения;
2. проверить резервную копию;
3. подготовить временные deny-by-default Rules;
4. разрешить доступ только заранее проверенным owner/admin аккаунтам;
5. протестировать Rules в Emulator Suite;
6. только затем применить временное ограничение production.

Не пытаться сохранять доступность любой ценой, если альтернатива — открытая финансовая база.

### Критерий приёмки

- опубликованные Rules больше не являются неизвестной величиной;
- риск классифицирован;
- при слабых Rules включено временное ограничение доступа;
- есть документированный rollback Rules.

---

## [x] BASE-005 — Зафиксировать технический baseline

**PR:** #6 (merged), merge SHA `9800f88ab46bac36819bf82271d03f26cf8d5299`. Независимый review завершён с результатом PASS.

**Ветка:** `remediation/BASE-005-technical-baseline`

### Действия

1. Выполнить на чистой установке:

```bash
npm ci
npm run lint
npm run build
npm audit
```

2. Добавить отдельный script:

```json
"typecheck": "tsc -b --pretty false"
```

3. Зафиксировать:
   - размер initial JS;
   - список чанков;
   - ошибки/предупреждения сборки;
   - результат `npm audit`;
   - текущую версию `xlsx`;
   - количество TypeScript/ESLint ошибок;
   - Lighthouse baseline для login и dashboard.
4. Добавить bundle report без изменения chunking.
5. Сохранить результаты в:

```text
docs/remediation/TECHNICAL_BASELINE.md
```

### Критерий приёмки

- исходные показатели воспроизводимы;
- будущие улучшения можно сравнивать с baseline;
- ошибки не скрыты и не «обнулены» отключением правил.

---

## [x] BASE-006 — Создать отдельный CI workflow для проверок PR

**PR:** #7 (merged), merge SHA `9257c92914f919335e98cad64262776528eb3725`. Независимый review завершён с результатом PASS.

**Ветка:** `remediation/BASE-006-ci`

### Файлы

```text
.github/workflows/ci.yml
package.json
.nvmrc
```

### Действия

1. Зафиксировать одну поддерживаемую текущими зависимостями Node.js LTS-версию в `.nvmrc` и CI.
2. Запускать CI на каждом pull request, а не только на `main`.
3. Выполнять:

```text
npm ci
lint
typecheck
unit tests
Rules tests
build
```

4. Deployment workflow оставить отдельным от CI.
5. Production deployment разрешать только после успешного CI и review.
6. Запретить deployment из remediation feature-веток.

### Критерий приёмки

- любой PR автоматически проверяется;
- deployment не является единственным способом узнать, что проект собирается;
- один и тот же Node/npm используется локально и в CI.

---

## Контрольная точка GATE-0

Переход к этапу 1 разрешён только когда:

- [x] исходный commit зафиксирован;
- [x] staging изолирован от production;
- [x] резервная копия восстановлена и проверена;
- [x] опубликованные Rules сохранены и оценены;
- [x] есть baseline сборки и bundle;
- [x] CI работает на PR.

Все шесть пунктов выполнены — BASE-001–BASE-006 приняты (независимый review PASS по каждому).

---

# ЭТАП 1. Реальная серверная авторизация и управление пользователями

## Цель этапа

Полностью убрать ситуацию, в которой клиентский JavaScript определяет фактические права пользователя. После этапа любая попытка доступа должна проверяться Rules или доверенной Cloud Function.

---

## [x] SEC-001 — Утвердить каноническую модель членства и ролей

**PR:** #8 (merged), merge SHA `0e5bd842a841584b46dfe177500c405265230a73`. Независимый review завершён с результатом PASS.

**Ветка:** `remediation/SEC-001-authz-adr`

### Создать

```text
docs/adr/001-company-membership-and-roles.md
```

### Утверждаемая модель

```text
companies/{companyId}
companies/{companyId}/members/{uid}
users/{uid}
```

`users/{uid}` содержит только профиль пользователя и не является источником прав.

`companies/{companyId}/members/{uid}` содержит:

```ts
{
  uid: string
  role: 'viewer' | 'accountant' | 'admin'
  status: 'invited' | 'active' | 'disabled'
  createdAt: Timestamp
  updatedAt: Timestamp
  invitedBy?: string
}
```

### Обязательные решения

1. Нет membership — нет доступа.
2. Неизвестная роль — нет доступа.
3. `viewer` — только чтение.
4. `accountant` — операции и справочники, но не роли/компания/security.
5. `admin` — управление компанией и участниками.
6. Прямые клиентские записи в `members` запрещены.
7. Нельзя удалить или понизить последнего активного admin.
8. `ownerId` — справочная/юридическая связь, но не обход membership.
9. Удаление из одной компании не удаляет глобальный Auth account, если пользователь состоит в других компаниях.
10. Глобальное удаление/disable Auth выполняется отдельной серверной операцией.

### Критерий приёмки

- документ однозначно отвечает, кто что может читать и менять;
- нет fallback на домашнюю роль;
- модель учитывает multi-company пользователя.

---

## [x] SEC-002 — Добавить runtime-схемы для данных авторизации

**PR:** #9 (merged), merge SHA `432c23051353f6dff599cdbb13193ac80f18a311`. Независимый review завершён с результатом PASS (два корректирующих раунда, все замечания устранены).

**Ветка:** `remediation/SEC-002-auth-schemas`

### Файлы

```text
src/schemas/auth.ts
src/schemas/company.ts
src/types/auth.ts
```

### Действия

1. Добавить библиотеку runtime-validation, выбранную командой и зафиксированную в lockfile. Рекомендуемый вариант — Zod.
2. Описать схемы:
   - `RoleSchema`;
   - `MembershipStatusSchema`;
   - `MembershipSchema`;
   - `UserProfileSchema`;
   - `CompanySchema`;
   - request/response схемы callable functions.
3. Убрать слепые `as User`/`as Company` на внешних границах.
4. Некорректные документы не должны превращаться в администратора или молча получать defaults.
5. Ошибка схемы должна приводить к явному состоянию `data_error`.

### Тесты

- неизвестная роль;
- отсутствующий `companyId`;
- повреждённая membership;
- лишние привилегированные поля;
- старый формат документа.

### Критерий приёмки

- данные Firestore проверяются во время выполнения;
- повреждённый документ не повышает права;
- ошибки типизированы.

---

## [x] SEC-003 — Создать Cloud Functions backend для привилегированных операций

**PR:** #10 (merged), merge SHA `16e515cd8061f5ff6ee0217fac837788fde1fe23`. Независимый review завершён с результатом PASS (три раунда: два кодовых/процессных, один документационный — все замечания устранены).

**Ветка:** `remediation/SEC-003-functions-foundation`

### Создать

```text
functions/
  package.json
  tsconfig.json
  src/index.ts
  src/lib/authz.ts
  src/lib/errors.ts
  src/lib/idempotency.ts
  src/schemas/
```

### Действия

1. Инициализировать TypeScript Cloud Functions 2nd gen.
2. Подключить Firebase Admin SDK только в server package.
3. Реализовать helpers:

```text
requireAuth
requireVerifiedEmail
requireActiveMember
requireRole
assertNotLastAdmin
validateRequest
writeAuditEvent
```

4. Все callable functions должны:
   - отклонять неавторизованный запрос;
   - валидировать вход;
   - проверять membership сервером;
   - возвращать стабильные error codes;
   - не доверять переданным клиентом `uid`, `role` или `companyId` без проверки;
   - быть идемпотентными там, где повтор запроса возможен.
5. Подключить Functions Emulator.

### Тесты

- unauthenticated call;
- member другой компании;
- viewer вызывает admin command;
- подмена `uid`;
- повтор одного idempotency key.

### Критерий приёмки

- есть единая серверная точка проверки ролей;
- functions запускаются в emulator;
- privileged paths не зависят от `authStore.isAdmin()`.

---

## [ ] SEC-004 — Перенести создание компании на сервер

**Ветка:** `remediation/SEC-004-create-company-function`

### Backend

Создать callable:

```text
createCompany
```

Она должна атомарно или идемпотентно создать:

```text
companies/{companyId}
companies/{companyId}/members/{uid}
начальный набор справочников/настроек
```

### Client

Изменить:

```text
src/store/authStore.ts
src/pages/Register.tsx
```

### Действия

1. После создания Firebase Auth user вызвать `createCompany`.
2. Не создавать `companies`, `company_data` и роль `admin` напрямую с клиента.
3. Если функция не завершилась:
   - не возвращать `{ ok: true }`;
   - показать состояние `setup_incomplete`;
   - позволить безопасно повторить тот же idempotent request;
   - не создавать admin fallback локально.
4. Идентификатор компании создаётся сервером/Firestore, а не `Date.now()`.

### Тесты

- успешная регистрация;
- повтор запроса после сетевого сбоя;
- Auth user создан, company не создана;
- подмена owner uid;
- невалидный ИНН/название;
- два параллельных запроса.

### Критерий приёмки

- регистрация не оставляет пользователя в ложно успешном состоянии;
- компания и admin membership создаются сервером;
- повтор не создаёт вторую компанию.

---

## [ ] SEC-005 — Создать и выполнить backfill membership-документов

**Ветка:** `remediation/SEC-005-membership-backfill`

### Создать

```text
scripts/backfill-memberships.ts
scripts/lib/firebaseAdmin.ts
docs/migrations/MEMBERSHIP_BACKFILL.md
```

### Источники старых данных

```text
users/{uid}.companyId
users/{uid}.role
users/{uid}.companies[]
companies/{companyId}.ownerId
```

### Действия

1. Реализовать режим `--dry-run` по умолчанию.
2. Сформировать отчёт:
   - пользователь;
   - компания;
   - старая роль;
   - предполагаемая новая роль;
   - конфликт;
   - отсутствующая компания;
   - отсутствующий пользователь;
   - owner без admin membership.
3. Не разрешать конфликт ролей автоматически без записи решения в отчёте.
4. Использовать детерминированный путь `members/{uid}`.
5. Повторный запуск должен быть безопасным.
6. После staging-rehearsal выполнить production backfill под maintenance/read-only режимом.

### Проверки

- у каждой компании есть минимум один active admin;
- каждый действующий пользователь имеет ожидаемые memberships;
- неизвестные/осиротевшие записи вынесены в отдельный список;
- ни один пользователь не получает admin только потому, что документ отсутствовал.

### Критерий приёмки

- membership создана для 100% подтверждённых связей;
- конфликты рассмотрены вручную;
- отчёт сохранён вне публичного Git, если содержит PII.

---

## [ ] SEC-006 — Заменить приглашение с паролем на одноразовое приглашение

**Ветка:** `remediation/SEC-006-secure-invitations`

### Удалить

Из `src/store/authStore.ts`:

```text
прямой вызов identitytoolkit accounts:signUp
создание пароля приглашённому администратором
прямую запись role/companyId в users/{uid}
```

### Создать backend commands

```text
inviteMember
acceptInvite
cancelInvite
```

### Модель приглашения

```text
invitations/{inviteId}
  companyId
  emailNormalized
  role
  tokenHash
  status
  expiresAt
  createdBy
  createdAt
```

### Требования

1. Raw token не хранить в Firestore.
2. Приглашение одноразовое и имеет срок действия.
3. При принятии:
   - пользователь авторизован;
   - email подтверждён;
   - email совпадает с приглашением;
   - токен не истёк и не использован;
   - membership создаётся сервером.
4. Пароль пользователь задаёт сам через обычный Firebase Auth flow.
5. Отправка ссылки выполняется через server-side email provider.
6. Секрет email provider хранится в secret manager/functions secrets.
7. Direct client read/write для `invitations` запрещён Rules.

### UI

Обновить:

```text
src/pages/Users.tsx
страницу принятия приглашения
маршруты App.tsx
```

### Критерий приёмки

- администратор больше не знает пароль приглашённого;
- старый REST signup отсутствует в bundle;
- повторное/просроченное приглашение отклоняется;
- роль задаётся только сервером после проверки admin.

---

## [ ] SEC-007 — Перенести смену роли, отключение и удаление участника на сервер

**Ветка:** `remediation/SEC-007-member-management-functions`

### Создать callable functions

```text
changeMemberRole
disableMember
restoreMember
removeMember
```

### Правила

1. Только active admin соответствующей компании.
2. Нельзя изменить роль участника другой компании.
3. Нельзя повысить себя обходным payload.
4. Нельзя удалить/понизить последнего active admin.
5. `removeMember` удаляет доступ к конкретной компании.
6. Глобальный Firebase Auth user не удаляется, если у него есть другие active memberships.
7. Глобальный disable/delete Auth account выполняется отдельным account-level процессом.
8. Каждая операция записывается в audit log.
9. Membership `disabled` должна немедленно блокироваться Rules, независимо от срока жизни Auth token.

### Изменить

```text
src/store/authStore.ts
src/pages/Users.tsx
src/pages/Settings.tsx
```

### Критерий приёмки

- `deleteDoc(users/{uid})` больше не используется как «удаление пользователя»;
- клиент не может напрямую поменять role;
- последний admin защищён;
- multi-company доступ не ломается.

---

## [ ] SEC-008 — Удалить fail-open recovery из `authStore.ts`

**Ветка:** `remediation/SEC-008-fail-closed-auth-store`

### Исправить

```text
src/store/authStore.ts
src/hooks/useAuth.ts
защищённые маршруты
```

### Удалить поведение

- автоматическое создание `role: 'admin'`, если `users/{uid}` отсутствует;
- автоматическое создание компании при отсутствии документа;
- разрешение работать из in-memory/localStorage после ошибки Rules/Firestore;
- fallback домашней роли для неизвестной active company;
- возврат успешной регистрации при незавершённой Firestore setup.

### Новые состояния сессии

```ts
type SessionState =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'setup_required'; uid: string }
  | { status: 'access_denied'; reason: string }
  | { status: 'data_error'; reason: string }
  | { status: 'ready'; user: UserProfile; memberships: Membership[] }
```

### Обязательное поведение

1. Нет membership — компания не загружается.
2. Отсутствует профиль — пользователь направляется в безопасный setup/support flow.
3. Ошибка Firestore не превращается в локальный доступ.
4. `getEffectiveRole()` возвращает `Role | null`.
5. `null` означает запрет.
6. Logout очищает весь session state.

### Тесты

- Auth account есть, user profile нет;
- profile есть, membership нет;
- membership disabled;
- activeCompanyId относится к другому пользователю;
- Firestore permission-denied;
- network error;
- повторный вход другим пользователем в той же вкладке.

### Критерий приёмки

- отсутствующие/повреждённые данные никогда не дают admin;
- нет локального обхода серверного запрета;
- все ошибки сессии видимы пользователю.

---

## [ ] SEC-009 — Сделать переключение компании fail-closed

**Ветка:** `remediation/SEC-009-safe-company-switch`

### Изменить

```text
src/store/authStore.ts
src/store/companyStore.ts
src/components/layout/Sidebar.tsx
src/components/layout/Layout.tsx
```

### Действия

1. Список компаний строить только из серверных active memberships.
2. До сохранения `activeCompanyId` проверить, что он есть в этом списке.
3. При отказе:
   - не менять текущую компанию;
   - не сохранять ID в `localStorage`;
   - показать typed error.
4. Добавить generation/request token, чтобы поздний ответ компании A не перезаписал уже выбранную компанию B.
5. Снимать listener старой компании до подключения новой.
6. Удалить `window.location.reload()` после переключения.
7. Sidebar, Users и Settings должны использовать роль активной компании.

### Тесты

- произвольный companyId;
- быстрые A → B → A;
- медленный ответ старого запроса;
- membership была отключена во время сессии;
- переключение после logout/login другого пользователя.

### Критерий приёмки

- невозможно открыть компанию, которой нет в active memberships;
- stale async response не меняет текущую компанию;
- reload страницы не нужен.

---

## [ ] SEC-010 — Ввести единую capability-модель в UI

**Ветка:** `remediation/SEC-010-ui-capabilities`

### Создать

```text
src/auth/capabilities.ts
src/auth/useCapabilities.ts
src/components/auth/RequireCapability.tsx
```

### Пример capabilities

```text
company.read
transaction.create
transaction.update
transaction.delete
account.manage
budget.manage
company.settings.manage
member.manage
period.close
```

### Действия

1. Маппинг role → capabilities хранить в одном месте.
2. Admin-only routes защищать route guard.
3. Viewer не должен видеть активные write-кнопки.
4. Store/repository methods должны возвращать typed `permission_denied`, а не молча `undefined`.
5. Удалить разрозненные проверки `user.role` по страницам.

### Важно

Этот пункт улучшает UX, но не заменяет Rules.

### Критерий приёмки

- UI активной компании соответствует effective role;
- нет write modal, который viewer может открыть и затем получить молчаливый отказ;
- Playwright проверяет viewer/accountant/admin интерфейс.

---

## [ ] SEC-011 — Добавить deny-by-default Firestore Rules для текущей схемы

**Ветка:** `remediation/SEC-011-firestore-rules`

### Создать

```text
firestore.rules
firestore.indexes.json
tests/rules/helpers.ts
tests/rules/company-access.spec.ts
tests/rules/members.spec.ts
tests/rules/company-data.spec.ts
```

### Минимальная политика

1. `request.auth == null` → deny.
2. `companies/{companyId}` читается только active member.
3. `company_data/{companyId}` читается только active member.
4. `company_data/{companyId}` изменяется только accountant/admin.
5. `members` напрямую клиентом не изменяются.
6. `users/{uid}`:
   - пользователь может читать свой профиль;
   - может менять только безопасный whitelist полей профиля;
   - не может менять role, memberships, owner, security fields.
7. `invitations` недоступны напрямую клиенту.
8. Неизвестные коллекции → deny.
9. Rules не используют старые `users.role`/`users.companies` как источник полномочий.

### Обязательная тестовая матрица

| Сценарий | Ожидание |
|---|---|
| unauthenticated read/write | deny |
| member reads own company | allow |
| member reads foreign company | deny |
| viewer writes company data | deny |
| accountant writes operation data | allow |
| accountant changes company settings/security | deny |
| admin manages обычные данные | allow |
| client writes membership | deny |
| disabled member reads | deny |
| missing membership | deny |
| user changes own role field | deny |
| arbitrary companyId | deny |

### Критерий приёмки

- все Rules tests проходят в Emulator Suite;
- нет `allow read, write: if request.auth != null` для company data;
- нет wildcard allow для неизвестных путей;
- production Rules полностью воспроизводимы из Git.

---

## [ ] SEC-012 — Провести контролируемый security deployment

**Ветка:** release checklist, код уже должен быть готов предыдущими задачами.

### Порядок deployment

1. Включить maintenance/read-only режим.
2. Проверить свежую резервную копию.
3. Развернуть Cloud Functions.
4. Выполнить membership backfill.
5. Проверить, что у каждой компании есть active admin.
6. Развернуть новые Rules.
7. Выполнить smoke-проверки через три тестовых аккаунта:
   - viewer;
   - accountant;
   - admin.
8. Развернуть обновлённый client.
9. Проверить старую открытую вкладку: её небезопасные direct writes должны отвергаться Rules.
10. Проверить приглашение, смену роли, удаление membership, switch company.
11. Только после успешной проверки снять maintenance/read-only режим.

### Rollback

- клиент можно вернуть к предыдущему bundle;
- Rules нельзя откатывать к заведомо открытой версии;
- при ошибке оставить maintenance и применить заранее проверенный restrictive rollback ruleset;
- membership backfill не удалять автоматически.

### Критерий приёмки

- production доступ проверен реальными role accounts;
- cross-company read/write отклоняется;
- old client не может обойти новые Rules;
- security logs не показывают массовые permission errors у легитимных пользователей.

---

## [ ] SEC-013 — Подключить App Check, email verification и усиление admin accounts

**Ветка:** `remediation/SEC-013-app-check-and-account-hardening`

### Действия

1. Подключить App Check сначала в monitoring mode.
2. Проверить, что легитимные web clients получают валидные tokens.
3. После наблюдения включить enforcement для:
   - Firestore;
   - callable functions.
4. Для приглашений требовать verified email.
5. Для admin рекомендовать/включить MFA после проверки поддерживаемого Firebase flow.
6. Добавить страницу управления сессиями и security notices в продуктовый backlog.

### Важно

App Check не заменяет Auth, Rules и role validation.

### Критерий приёмки

- enforcement не блокирует легитимное приложение;
- прямые автоматизированные обращения без App Check усложнены;
- admin flow требует подтверждённый email.

---

## Контрольная точка GATE-1

Переход к этапу 2 разрешён только когда:

- [ ] canonical membership работает;
- [ ] fail-open recovery удалён;
- [ ] switchCompany проверяет membership;
- [ ] приглашения и роли управляются сервером;
- [ ] Firestore Rules покрыты тестами;
- [ ] production deployment проверен viewer/accountant/admin аккаунтами;
- [ ] произвольный пользователь не может читать/писать чужую компанию.

---

# ЭТАП 2. Жизненный цикл сессии, сохранение и защита локальных данных

## Цель этапа

Устранить утечки между пользователями/компаниями, fire-and-forget сохранение и тихое перетирание данных до полной архитектурной миграции.

---

## [ ] STATE-001 — Удалить загрузку финансовых данных до завершения Auth

**Ветка:** `remediation/STATE-001-auth-bound-data-lifecycle`

### Изменить

```text
src/store/companyStore.ts
src/store/authStore.ts
src/store/useStore.ts
```

### Действия

1. Удалить module-level preload последней компании из `localStorage`.
2. Загружать company data только когда известны:
   - Firebase uid;
   - active membership;
   - active companyId.
3. Добавить методы:

```text
initializeSession(uid, companyId)
disposeSession()
resetState()
```

4. При logout:
   - снять `onSnapshot`;
   - отменить pending reads;
   - очистить in-memory state;
   - очистить company cache текущего пользователя;
   - уведомить UI.
5. При входе другого пользователя не показывать предыдущие данные ни на один render.

### Тесты

- холодный старт без Auth;
- logout;
- login другим пользователем;
- смена компании;
- permission-denied listener;
- размонтирование root.

### Критерий приёмки

- финансовые данные не появляются до подтверждённой membership;
- listener после logout отсутствует;
- второй пользователь не видит state первого.

---

## [ ] STATE-002 — Защитить `init()` от гонок

**Ветка:** `remediation/STATE-002-init-race-protection`

### Действия

1. Добавить generation counter или Abort-like token.
2. Каждый async load и snapshot callback проверяет:

```text
session generation
uid
companyId
```

3. Поздний ответ старой компании игнорируется.
4. Должна существовать одна точка, владеющая инициализацией company session.
5. Удалить дублирующий `companyStore.init()` из `Layout`, если он уже вызывается session coordinator.

### Тесты

- `init(A)` и сразу `init(B)`;
- B завершился раньше A;
- logout во время getDoc;
- switch во время snapshot callback.

### Критерий приёмки

- старый async result не может перезаписать новую session;
- одновременно существует максимум один актуальный snapshot listener.

---

## [ ] STATE-003 — Сделать сохранение подтверждаемым и видимым

**Ветка:** `remediation/STATE-003-save-state`

### Изменить

```text
src/store/companyStore.ts
src/components/layout/Header.tsx
компонент уведомлений
```

### Действия

1. `persist()` должен возвращать `Promise<Result>`.
2. Store mutation не должна безусловно считаться успешной сразу после локального изменения.
3. Ввести состояния:

```text
idle
saving
saved
offline
conflict
error
```

4. Ошибка Firestore отображается пользователю.
5. Добавить retry.
6. Для опасных операций показывать подтверждённый результат.
7. Убрать сохранение ошибок только в `console.error`.
8. Добавить Error Boundary и централизованный typed error mapper.

### Критерий приёмки

- пользователь видит, сохранены ли данные;
- failed write не выглядит как окончательный успех;
- retry работает;
- ошибки доступны мониторингу.

---

## [ ] STATE-004 — Временно устранить last-write-wins на монодокументе

**Ветка:** `remediation/STATE-004-monodoc-revision-control`

### Цель

До перехода на подколлекции запретить тихое перетирание изменений двумя пользователями.

### Действия

1. Добавить в текущий документ:

```text
schemaVersion
revision
updatedAt
updatedBy
```

2. `updatedAt` задавать server timestamp.
3. Удалить `_savedAt = Date.now()` как механизм выбора победителя.
4. Каждая запись текущего монодокумента выполняется через Firestore transaction:
   - прочитать текущую `revision`;
   - сравнить с base revision клиента;
   - при совпадении записать новую версию и `revision + 1`;
   - при несовпадении вернуть `conflict` без перезаписи.
5. На конфликт:
   - не выполнять автоматический last-write-wins;
   - показать пользователю сообщение;
   - загрузить серверную версию;
   - предложить повторить команду на свежих данных.
6. Offline write в этой временной модели не считать подтверждённым. Хранить его как локальный draft/queue с явным статусом.

### Тесты

- два клиента редактируют один base revision;
- первый commit успешен;
- второй получает conflict;
- часы одного клиента отстают/спешат;
- повтор команды на свежей revision.

### Критерий приёмки

- два одновременных редактора не теряют изменения молча;
- client clock не влияет на порядок коммитов;
- конфликт видим и воспроизводим.

---

## [ ] STATE-005 — Удалить полный финансовый dataset из `localStorage`

**Ветка:** `remediation/STATE-005-remove-sensitive-localstorage`

### Действия

1. Удалить ключи вида:

```text
company_data_{companyId}
finapp_last_company_id
```

2. В `localStorage` разрешить только:
   - безопасные UI preferences;
   - active company ID, дополнительно привязанный к uid;
   - не содержащие PII настройки.
3. Если требуется offline режим, использовать Firestore offline persistence/IndexedDB после подтверждения Auth и membership.
4. Очищать persistence/cache при logout и account switch согласно выбранной политике.
5. Добавить одноразовую миграцию удаления старых `company_data_*` ключей.
6. Рассмотреть перенос приложения с общего `github.io` origin на отдельный custom domain.

### Тесты

- после загрузки нет financial JSON в localStorage;
- logout удаляет user-bound cache;
- старый legacy key очищается;
- второй пользователь не получает cache первого.

### Критерий приёмки

- полные операции, счета, ИНН и реквизиты не лежат в `localStorage`;
- кеширование не начинается до Auth;
- legacy data удаляется контролируемо.

---

## [ ] STATE-006 — Добавить schema version и миграции текущего формата

**Ветка:** `remediation/STATE-006-runtime-data-migrations`

### Создать

```text
src/data/schemas/companyData.ts
src/data/migrations/index.ts
src/data/migrations/v1-to-v2.ts
```

### Действия

1. Проверять текущий `company_data` runtime-схемой.
2. Хранить `schemaVersion`.
3. Defaults добавлять через явную миграцию, а не через повторяющиеся `if (!field)` в store.
4. Неизвестную будущую версию не открывать на запись старым клиентом.
5. Повреждённый документ переводить в recoverable error, не молча заменять пустыми массивами.
6. Миграции покрыть fixture-тестами.

### Критерий приёмки

- загрузка данных детерминирована;
- старые схемы мигрируются тестируемо;
- повреждённые данные не маскируются.

---

## [ ] STATE-007 — Добавить аудит security и критичных финансовых действий

**Ветка:** `remediation/STATE-007-audit-log`

### Минимально логировать

```text
company created
member invited/accepted/disabled/restored/removed
role changed
company settings changed
period closed/reopened
import committed/rolled back
transaction deleted/bulk updated
```

### Поля

```text
actorUid
companyId
action
entityType
entityId
requestId
before/after summary
createdAt server timestamp
```

### Требования

- security events пишет backend;
- клиент не может редактировать audit log;
- sensitive data не дублируется без необходимости;
- audit log имеет правила retention и доступа.

### Критерий приёмки

- административное действие можно связать с пользователем и временем;
- audit запись нельзя подделать обычным клиентом.

---

## Контрольная точка GATE-2

- [ ] данные не загружаются до Auth/membership;
- [ ] logout очищает state и listener;
- [ ] init защищён от гонок;
- [ ] сохранение имеет видимый статус;
- [ ] stale writer получает conflict, а не перетирает данные;
- [ ] полный dataset отсутствует в localStorage;
- [ ] текущая схема валидируется и версионируется.

---

# ЭТАП 3. Тестовый фундамент и финансовая корректность

## Цель этапа

Сначала формализовать финансовые инварианты, затем исправлять код. Нельзя переходить к архитектурной миграции, не имея тестов, которые доказывают сохранность сумм и остатков.

---

## [ ] TEST-001 — Добавить unit/component/E2E test infrastructure

**Ветка:** `remediation/TEST-001-test-infrastructure`

### Добавить

```text
Vitest
React Testing Library
jsdom
@firebase/rules-unit-testing
Playwright
fast-check
```

### Создать

```text
vitest.config.ts
src/test/setup.ts
tests/fixtures/
e2e/
playwright.config.ts
```

### Scripts

```json
{
  "test": "vitest",
  "test:run": "vitest run",
  "test:coverage": "vitest run --coverage",
  "test:rules": "...",
  "test:e2e": "playwright test",
  "typecheck": "tsc -b --pretty false"
}
```

### Критерий приёмки

- есть по одному проходящему smoke test для unit, component, Rules и E2E;
- CI запускает unit и Rules;
- E2E запускается минимум на security/release PR.

---

## [ ] FIN-001 — Вынести денежные проверки в отдельный domain module

**Ветка:** `remediation/FIN-001-money-domain`

### Создать

```text
src/domain/money/
  money.ts
  validation.ts
  money.spec.ts
```

### На первом шаге

Пока старая схема хранит `number`, централизовать:

```text
Number.isFinite
amount > 0
MAX_MONEY
округление
валюту
количество допустимых знаков
```

### Запретить

```text
NaN
Infinity
-Infinity
частично распарсенные строки
нулевые суммы там, где операция обязана менять деньги
```

### Критерий приёмки

- формы, импорт и store используют один валидатор;
- нет разрозненного `parseFloat` без полной проверки;
- тесты покрывают границы.

---

## [ ] FIN-002 — Вынести применение операций к счетам в pure functions

**Ветка:** `remediation/FIN-002-ledger-functions`

### Создать

```text
src/domain/ledger/applyTransaction.ts
src/domain/ledger/revertTransaction.ts
src/domain/ledger/updateTransaction.ts
src/domain/ledger/ledger.spec.ts
```

### Действия

1. Удалить дублированные `accounts.map(...)` из:
   - add;
   - delete;
   - update;
   - batch update;
   - recurring;
   - calendar;
   - split.
2. Pure functions не должны знать о React, Firestore или localStorage.
3. Покрыть:
   - income;
   - expense;
   - same-currency transfer;
   - cross-currency transfer;
   - update с изменением account/type/amount;
   - delete;
   - отсутствующий account;
   - одинаковый from/to account.

### Property-based инварианты

```text
apply(tx) + revert(tx) = исходное состояние
update(old → new) = revert(old) + apply(new)
```

### Критерий приёмки

- одна реализация финансового воздействия операции;
- store только координирует вызовы;
- тесты ловят расхождение остатков.

---

## [ ] FIN-003 — Исправить `splitTransaction()`

**Ветка:** `remediation/FIN-003-safe-split`

### Текущий файл

```text
src/store/companyStore.ts
```

### Требования

1. Минимум две части.
2. Каждая сумма конечна и больше нуля.
3. Сумма частей обязана равняться сумме оригинала в денежной модели.
4. При несовпадении вернуть typed validation error.
5. Split выполняется как одна domain command.
6. При ошибке ни оригинал, ни баланс не меняются.
7. IDs создаются безопасно, без `Date.now()`.
8. Transfer split либо явно поддерживается тестами, либо запрещён.

### Тесты

- 100 = 60 + 40;
- 100 != 60 + 30;
- отрицательная часть;
- NaN;
- закрытый период;
- повтор команды;
- balance до/после одинаков.

### Критерий приёмки

- split не может изменить общий остаток;
- ошибка не приводит к частичному изменению state.

---

## [ ] FIN-004 — Исправить календарную арифметику повторов

**Ветка:** `remediation/FIN-004-recurring-date-policy`

### Создать

```text
src/domain/recurrence/advanceDate.ts
src/domain/recurrence/advanceDate.spec.ts
```

### Решения

1. Не использовать неявную timezone-семантику `new Date('YYYY-MM-DD')`.
2. Зафиксировать политику day-of-month:
   - если исходная дата — последний день месяца, следующая тоже последний день;
   - иначе day clamp к последнему существующему дню.
3. Явно определить:
   - weekly;
   - monthly;
   - quarterly;
   - yearly;
   - leap year.

### Тесты

```text
2026-01-31 -> 2026-02-28
2024-01-31 -> 2024-02-29
2024-02-29 yearly -> утверждённая политика
2026-08-31 quarterly -> корректная дата
```

### Критерий приёмки

- повтор не перескакивает неожиданно через месяц;
- политика документирована и покрыта тестами.

---

## [ ] FIN-005 — Исправить проведение платёжного календаря

**Ветка:** `remediation/FIN-005-calendar-payment-command`

### Требования

1. Нельзя подставлять первый счёт при отсутствующем `accountId`.
2. Пользователь обязан выбрать существующий счёт.
3. Фактическая дата платежа передаётся явно.
4. Созданная операция хранит `calendarItemId`.
5. Calendar item хранит `transactionId`.
6. Повторное проведение идемпотентно.
7. Item status и transaction создаются атомарно.
8. Предусмотреть отмену проведения с понятной политикой для закрытого периода.

### Тесты

- счёт не выбран;
- счёт удалён;
- два клика одновременно;
- повтор одного request ID;
- фактическая дата отличается от плановой;
- closed period.

### Критерий приёмки

- неверный счёт не выбирается молча;
- двойное проведение невозможно;
- операция и calendar item не расходятся.

---

## [ ] FIN-006 — Зафиксировать правила закрытого периода

**Ветка:** `remediation/FIN-006-closing-period`

### Действия

1. Закрытие/открытие периода разрешить только admin capability.
2. Проверять ограничение:
   - в domain command;
   - в Firestore Rules или server command;
   - в UI.
3. Запретить перенос операции из открытого периода в закрытый.
4. Определить поведение imports и recurring для закрытого периода.
5. Записывать close/reopen в audit log.

### Критерий приёмки

- обход UI не позволяет изменить закрытый период;
- массовые операции также соблюдают правило;
- есть тесты boundary date.

---

## [ ] FIN-007 — Заменить ID на UUID/Firestore IDs

**Ветка:** `remediation/FIN-007-stable-ids`

### Заменить

```text
'id' + Date.now()
'co_' + Date.now()
'b' + Date.now()
'tx' + Date.now()
```

### Правила

1. Новые сущности получают `crypto.randomUUID()` или Firestore document ID.
2. Существующие IDs сохраняются при миграции.
3. Import rows используют детерминированный idempotency/fingerprint ID там, где нужен безопасный повтор.
4. IDs не несут временную/роль-семантику.

### Критерий приёмки

- два параллельных создания не конфликтуют;
- ID generation централизована;
- тесты не зависят от реального времени.

---

## [ ] FIN-008 — Создать эталонные fixtures отчётов

**Ветка:** `remediation/FIN-008-report-golden-tests`

### Создать

```text
tests/fixtures/company-basic.json
tests/fixtures/company-multicurrency.json
tests/fixtures/company-loans-capital.json
tests/fixtures/company-projects.json
src/domain/reports/*.spec.ts
```

### Зафиксировать ожидаемые результаты

- остатки по счетам;
- ДДС;
- P&L;
- бюджеты plan/fact;
- проекты;
- перевод между валютами;
- выбранный период;
- cash date и recognition date.

### Отдельное решение по экрану Balance

До появления полноценного ledger:

- либо переименовать в «Упрощённый баланс денежных средств»;
- либо явно показать ограничение методологии;
- не заявлять полноценный бухгалтерский/управленческий баланс.

### Критерий приёмки

- изменение формул отчёта ломает тест, если изменился ожидаемый результат;
- методология каждого отчёта записана в `docs/finance/`.

---

## Контрольная точка GATE-3

- [ ] тестовая инфраструктура работает;
- [ ] денежные значения валидируются централизованно;
- [ ] ledger effects покрыты pure tests;
- [ ] split сохраняет сумму;
- [ ] recurring dates исправлены;
- [ ] payment calendar атомарен и идемпотентен;
- [ ] закрытый период защищён не только UI;
- [ ] основные отчёты имеют golden fixtures.

---

# ЭТАП 4. Безопасный и идемпотентный импорт банковских файлов

## Цель этапа

Удалить vulnerable `xlsx@0.18.5`, исключить зависание UI, тихую порчу дат/сумм, частичный импорт и дубли.

---

## [ ] IMP-001 — Сначала создать набор импортных fixtures и threat cases

**Ветка:** `remediation/IMP-001-import-fixtures`

### Создать fixtures

```text
tests/fixtures/import/
  valid.xlsx
  valid.csv
  quoted.csv
  multiline.csv
  bom.csv
  invalid-date.xlsx
  invalid-amount.xlsx
  formula-cells.xlsx
  oversized-row.csv
  duplicate-rows.csv
  malformed.xlsx
```

### Сценарии

- DD.MM.YYYY;
- ISO date;
- невозможная дата;
- запятая/точка как decimal separator;
- пробелы и non-breaking spaces;
- отрицательная сумма;
- `NaN`/`Infinity`/scientific notation;
- длинная ячейка;
- quoted delimiter;
- newline внутри CSV field;
- повтор одного файла;
- частично совпадающие операции.

### Критерий приёмки

- текущие ошибки парсера воспроизводятся тестами;
- fixtures не содержат настоящие банковские/персональные данные.

---

## [ ] IMP-002 — Удалить `xlsx@0.18.5`

**Ветка:** `remediation/IMP-002-replace-xlsx`

### Выбранная стратегия

- `.xlsx`: `read-excel-file` browser build;
- `.csv`: Papa Parse;
- legacy `.xls`: не поддерживать;
- экспорт Excel, если нужен отдельно: лёгкий write-only package, не возвращать vulnerable parser.

### Изменить

```text
package.json
package-lock.json
src/utils/parseImport.ts
```

### Действия

1. Удалить dependency `xlsx`.
2. Проверить, что `xlsx` отсутствует в lockfile и production bundle.
3. Добавить новые parser dependencies с точными lockfile версиями.
4. Запустить dependency audit.
5. Обновить UI допустимых форматов.

### Критерий приёмки

- `npm ls xlsx` не показывает пакет;
- `.xls` отклоняется понятным сообщением;
- fixtures `.xlsx` и `.csv` проходят новым parser.

---

## [ ] IMP-003 — Перенести parsing в Web Worker

**Ветка:** `remediation/IMP-003-import-worker`

### Создать

```text
src/workers/import.worker.ts
src/features/import/workerClient.ts
src/features/import/protocol.ts
```

### Требования

1. Parsing не выполняется в UI thread.
2. Есть сообщения:

```text
start
progress
parsed
validation-error
fatal-error
cancelled
```

3. Worker можно завершить по cancel/unmount.
4. Поздний результат отменённого файла игнорируется.
5. Библиотеки парсинга загружаются только при открытии import flow.

### Критерий приёмки

- большой допустимый файл не блокирует основной интерфейс;
- cancel освобождает worker;
- import parser отсутствует в initial chunk.

---

## [ ] IMP-004 — Ввести жёсткие лимиты и строгий parser

**Ветка:** `remediation/IMP-004-import-validation`

### Вынести конфигурацию

```text
src/features/import/importLimits.ts
```

### Начальные лимиты

```text
file size: 10 MB
sheets: 1
rows: 20 000
columns: 100
cell length: 10 000 characters
formats: .xlsx, .csv
```

Лимиты должны быть централизованы и изменяемы, но не отключаться пользовательским input.

### Правила parsing

1. Проверять extension, MIME и сигнатуру, не доверяя только одному признаку.
2. Не использовать generic `new Date(userString)` fallback.
3. Допускать только явно поддержанные date formats.
4. Проверять реальную календарную дату.
5. Amount parser обязан полностью разобрать строку.
6. Проверять `Number.isFinite`, диапазон и precision.
7. Ограничивать длину комментариев, контрагентов и реквизитов.
8. Формулы не выполнять и не интерпретировать как код.
9. External links/macros не поддерживать.
10. Невалидная строка остаётся видимой в preview с причиной, а не пропадает молча.

### Критерий приёмки

- malformed/oversized input отклоняется до записи данных;
- невозможные даты не импортируются;
- частично корректная сумма вроде `100abc` не принимается;
- UI показывает количество valid/invalid rows.

---

## [ ] IMP-005 — Объединить два сценария импорта в один feature flow

**Ветка:** `remediation/IMP-005-unified-import-flow`

### Создать

```text
src/features/import/
  ImportWizard.tsx
  steps/
  stateMachine.ts
  mapping.ts
  validation.ts
```

### Единая последовательность

```text
Upload
→ Parse
→ Column mapping
→ Validation
→ Account/category mapping
→ Deduplication
→ Review
→ Commit
→ Result/reconciliation
```

### Изменить

```text
src/pages/Import.tsx
src/pages/Accounts.tsx
```

`Accounts.tsx` должен открывать тот же wizard с заранее выбранным счётом, а не иметь отдельный importer.

### Правила

1. Счёт не создаётся необратимо до подтверждения общего действия либо создаётся явно как отдельное подтверждённое действие.
2. Категория не подставляется молча как «первая подходящая».
3. Неопределённые строки получают статус `unclassified`.
4. Пользователь видит итоговые счета, категории и контрагентов до commit.

### Критерий приёмки

- один parser и один import pipeline для всех экранов;
- одинаковая дедупликация;
- cancel не оставляет неожиданные операции/контрагентов.

---

## [ ] IMP-006 — Сделать дедупликацию линейной и устойчивой

**Ветка:** `remediation/IMP-006-import-deduplication`

### Действия

1. Создать normalized fingerprint.
2. При наличии банковского operation ID использовать его как главный внешний идентификатор.
3. При отсутствии ID fingerprint строить из нормализованных полей, например:

```text
companyId
accountId
date
amount
currency
type
normalizedComment
counterparty identifiers
```

4. Существующие fingerprints загружать в `Set`/indexed query.
5. Убрать `.some()` по всем transactions для каждой preview row.
6. Отображать:
   - новый;
   - точный дубль;
   - возможный дубль;
   - конфликт.

### Тесты

- повтор того же файла;
- одинаковая сумма/дата, но разные bank IDs;
- пробелы/регистр в комментарии;
- две одинаковые реальные операции без bank ID;
- производительность на fixture большого объёма.

### Критерий приёмки

- повторный импорт не создаёт дубли;
- сложность не является `O(importRows × allTransactions)`;
- пользователь может просмотреть спорные совпадения.

---

## [ ] IMP-007 — Ввести import session, идемпотентный commit и rollback

**Ветка:** `remediation/IMP-007-import-session`

### Целевая модель

```text
companies/{companyId}/imports/{importId}
```

Поля:

```text
status: pending | committing | completed | failed | rolled_back
fileHash
rowCount
validCount
createdCount
duplicateCount
errorCount
createdBy
createdAt
completedAt
checkpoint
```

Каждая созданная операция содержит `importId` и deterministic row ID/fingerprint.

### Действия

1. Создать session до записи операций.
2. Записывать данные chunked/idempotent способом в пределах актуальных Firestore limits.
3. Не делать тысячу вызовов `companyStore.addTransaction()` и тысячу полных `setDoc`.
4. Частично записанные `pending` данные не должны попадать в обычные отчёты как завершённый импорт.
5. Повтор commit продолжает session или безопасно сообщает, что она завершена.
6. Rollback удаляет/сторнирует все данные `importId` и пересчитывает affected summaries.
7. Result screen показывает полный итог.

### Критерий приёмки

- падение на середине не создаёт неопознаваемую половину импорта;
- повтор не создаёт дубли;
- импорт можно откатить целиком;
- отчёты не включают незавершённую session.

---

## [ ] IMP-008 — Добавить security/performance regression tests импорта

**Ветка:** `remediation/IMP-008-import-regression-suite`

### Проверки

- limits;
- malformed ZIP/XML;
- очень длинные строки;
- formulas;
- CSV quoting;
- worker cancellation;
- duplicate performance;
- partial failure;
- rollback;
- retry;
- permission denied;
- viewer не может commit;
- closed period rows.

### Критерий приёмки

- import suite запускается в CI;
- уязвимые/невалидные fixtures не достигают Firestore;
- worker не остаётся жить после закрытия wizard.

---

## Контрольная точка GATE-4

- [ ] `xlsx@0.18.5` отсутствует;
- [ ] parser работает в Worker;
- [ ] лимиты и строгая валидация включены;
- [ ] два import flow объединены;
- [ ] дедупликация идемпотентна;
- [ ] partial import можно продолжить или откатить;
- [ ] import regression suite проходит.

После GATE-4 допустим ограниченный пилот только при выполненных GATE-1 и GATE-2. Полноценная многопользовательская эксплуатация всё ещё блокируется монодокументной архитектурой.

---

# ЭТАП 5. Миграция Firestore с монодокумента на подколлекции

## Цель этапа

Убрать жёсткий размер документа, hot-document contention, полные перезаписи и невозможность запросов/пагинации.

---

## [ ] ARCH-001 — Утвердить целевую Firestore-схему

**Ветка:** `remediation/ARCH-001-firestore-schema-adr`

### Создать

```text
docs/adr/002-firestore-domain-schema.md
```

### Целевая структура

```text
companies/{companyId}
companies/{companyId}/members/{uid}
companies/{companyId}/accounts/{accountId}
companies/{companyId}/transactions/{transactionId}
companies/{companyId}/categories/{categoryId}
companies/{companyId}/counterparties/{counterpartyId}
companies/{companyId}/projects/{projectId}
companies/{companyId}/budgets/{budgetId}
companies/{companyId}/recurringTemplates/{templateId}
companies/{companyId}/paymentCalendar/{itemId}
companies/{companyId}/imports/{importId}
companies/{companyId}/auditLog/{eventId}
companies/{companyId}/summaries/{summaryId}
```

### Общие поля документов

```text
schemaVersion
createdAt server timestamp
createdBy
updatedAt server timestamp
updatedBy
revision
```

### Обязательные решения ADR

1. `transactions` — source of truth.
2. `account.balance` — не единственный источник истины; это проверяемый cache/summary.
3. Отчёты строятся из ledger/query или проверенных aggregates.
4. Суммы в новой схеме хранятся в minor units или согласованном decimal representation.
5. FX operation фиксирует:
   - source amount/currency;
   - target amount/currency;
   - rate;
   - rate date;
   - source;
   - rounding mode.
6. Запросы проектируются по периоду, company, account, category, project.
7. Никакие растущие массивы операций не хранятся внутри company document.

### Критерий приёмки

- схема утверждена до написания migration script;
- понятны authoritative fields и caches;
- перечислены необходимые indexes и Rules.

---

## [ ] ARCH-002 — Ввести repository layer до переключения схемы

**Ветка:** `remediation/ARCH-002-repositories`

### Создать

```text
src/data/repositories/CompanyRepository.ts
src/data/repositories/TransactionRepository.ts
src/data/repositories/AccountRepository.ts
src/data/repositories/ImportRepository.ts
src/data/firestore/
src/data/legacy/
```

### Действия

1. Страницы и domain commands не должны импортировать Firebase SDK напрямую.
2. Реализовать два адаптера:
   - legacy monodoc;
   - new collections.
3. Выбор адаптера контролируется server-controlled feature flag/config, а не случайным localStorage.
4. Интерфейсы возвращают typed results и errors.
5. Добавить contract tests, которые одинаково запускаются для legacy и new repository.

### Критерий приёмки

- UI не знает физическую схему Firestore;
- можно переключить read path без переписывания страниц;
- legacy/new adapters проходят общие contract tests.

---

## [ ] ARCH-003 — Создать новую схему, indexes и Rules в staging

**Ветка:** `remediation/ARCH-003-new-firestore-collections`

### Действия

1. Реализовать new repository для каждой коллекции.
2. Обновить `firestore.rules` для path-based membership.
3. Добавить `firestore.indexes.json` для реальных запросов.
4. Добавить Rules tests для каждой новой коллекции.
5. Проверить ограничение полей, типов, company path и ролей.
6. Не удалять legacy Rules до cutover.

### Критерий приёмки

- CRUD работает в staging;
- cross-company access закрыт;
- queries выполняются без missing-index errors;
- новые документы не содержат растущие вложенные arrays.

---

## [ ] ARCH-004 — Реализовать атомарные transaction commands

**Ветка:** `remediation/ARCH-004-transaction-write-path`

### Commands

```text
createTransaction
updateTransaction
deleteTransaction
splitTransaction
createTransfer
payCalendarItem
```

### Требования

1. Связанные документы изменяются Firestore transaction/batched write согласно актуальным ограничениям сервиса.
2. Command имеет request/idempotency ID.
3. Проверяется current revision изменяемой сущности.
4. Account summary обновляется атомарно либо помечается как cache, который можно пересобрать.
5. Reports не доверяют непроверенному client balance.
6. При конфликте возвращается typed conflict.
7. Rules валидируют company membership, role и критичные immutable fields.

### Критерий приёмки

- два пользователя могут создавать разные операции без перезаписи всей компании;
- update/delete не теряют concurrent changes;
- balance/summary можно сверить и пересобрать из ledger.

---

## [ ] ARCH-005 — Перевести чтение операций на query + pagination

**Ветка:** `remediation/ARCH-005-transaction-queries`

### Действия

1. Запрашивать операции по company subcollection.
2. Использовать `orderBy`, `limit`, cursor pagination.
3. Фильтр периода должен применяться в Firestore query, а не после загрузки всей истории.
4. Добавить queries по:
   - date range;
   - account;
   - category;
   - project;
   - importId.
5. Обработать realtime update для текущего окна данных.
6. Отчёты загружают необходимый диапазон, а не весь dataset безусловно.

### Критерий приёмки

- открытие страницы не читает всю историю компании;
- список поддерживает следующую страницу;
- количество reads измерено и документировано.

---

## [ ] ARCH-006 — Написать идемпотентный migration script

**Ветка:** `remediation/ARCH-006-data-migration-script`

### Создать

```text
scripts/migrate-company-data.ts
scripts/verify-company-migration.ts
scripts/rollback-company-migration.ts
docs/migrations/COMPANY_DATA_V2.md
```

### Требования

1. `--dry-run` по умолчанию.
2. Мигрировать одну компанию или список компаний.
3. Сохранять существующие entity IDs.
4. Добавлять schemaVersion/audit metadata.
5. Иметь checkpoints.
6. Повторный запуск не создаёт дубли.
7. Не удалять legacy document.
8. Создавать machine-readable report.

### Обязательные сверки до/после

```text
количество accounts
количество transactions по типам
количество categories/counterparties/projects
сумма income/expense по валютам
остаток каждого account
количество budgets/recurring/calendar items
контрольные отчёты по fixtures/selected companies
```

### Критерий приёмки

- dry-run не пишет данные;
- повторный реальный запуск безопасен;
- verifier обнаруживает намеренно внесённое расхождение;
- rollback протестирован в staging.

---

## [ ] ARCH-007 — Провести полную staging rehearsal на анонимизированной копии

**Ветка:** release/migration task.

### Действия

1. Подготовить анонимизированную копию representative production data.
2. Выполнить baseline migration.
3. Запустить verifier.
4. Прогнать E2E:
   - login;
   - company switch;
   - create/update/delete transaction;
   - split;
   - import;
   - reports;
   - viewer/accountant/admin.
5. Симулировать interruption migration и повторный запуск.
6. Проверить rollback.
7. Зафиксировать exact runbook.

### Критерий приёмки

- rehearsal проходит от начала до конца;
- суммы и counts совпадают;
- interruption/retry не создаёт дубли;
- rollback реально исполнен.

---

## [ ] ARCH-008 — Выполнить production cutover без длительного dual-write

**Ветка:** controlled release.

### Предпочтительная стратегия

Не держать длительный client-side dual-write, потому что он сам создаёт новую проблему расхождения. Использовать maintenance cutover.

### Порядок

1. Проверить backup.
2. Включить maintenance/read-only.
3. Выполнить основной backfill.
4. Выполнить финальный delta pass.
5. Запустить verifier.
6. Развернуть client с new repository read/write path.
7. Развернуть окончательные Rules/indexes.
8. Выполнить smoke/E2E на production test company.
9. Проверить counts, balances и отчёты выбранных компаний.
10. Только после прохождения GATE открыть запись пользователям.
11. Legacy `company_data/{companyId}` оставить read-only как rollback snapshot.

### Критерий приёмки

- все компании прошли verifier;
- new writes создают отдельные документы;
- монодокумент не изменяется клиентом;
- пользователи не возвращаются к старому path при ошибке.

---

## [ ] ARCH-009 — Добавить автоматическую сверку ledger и summaries

**Ветка:** `remediation/ARCH-009-ledger-reconciliation`

### Действия

1. Реализовать server/admin verifier остатка счёта из transactions.
2. Сравнивать с cached summary.
3. Логировать расхождения.
4. Не исправлять расхождение молча без audit event.
5. Добавить manual rebuild command для admin/support.
6. Добавить метрики размера коллекций и ошибок write path.

### Критерий приёмки

- любой balance cache может быть пересобран;
- расхождение обнаруживается автоматически;
- отчёты не зависят от необратимо повреждаемого поля.

---

## [ ] ARCH-010 — Вывести legacy монодокумент из эксплуатации

**Ветка:** `remediation/ARCH-010-remove-legacy-monodoc`

### Условия начала

- new schema работает;
- verifier стабильно проходит;
- rollback window закрыт отдельным решением;
- резервные копии сохранены.

### Действия

1. Удалить legacy repository write path.
2. Удалить `_savedAt`, full-document `setDoc` и связанные cache keys.
3. Оставить migration reader только в административном script, если нужен.
4. Закрыть legacy path Rules на write, затем на read для clients.
5. Архивировать старые документы по утверждённой retention policy.

### Критерий приёмки

- приложение не читает/не пишет `company_data/{companyId}`;
- ни одна операция не сериализует всю компанию;
- размер company metadata не растёт вместе с историей операций.

---

## Контрольная точка GATE-5

- [ ] transactions находятся в отдельных документах;
- [ ] membership и Rules работают по company path;
- [ ] writes атомарны/идемпотентны;
- [ ] есть pagination и date-range queries;
- [ ] migration verifier проходит;
- [ ] legacy monodoc больше не является write path;
- [ ] два одновременных редактора не перетирают друг друга.

После GATE-5 снимается архитектурный блокер многопользовательской production-эксплуатации.

---

# ЭТАП 6. Рефакторинг state, TypeScript и ответственности

## Цель этапа

После стабилизации схемы убрать mutable singleton, глобальные перерендеры и смешение domain/data/UI логики.

---

## [ ] CODE-001 — Разделить `companyStore.ts` на domain/application/data слои

**Ветка:** `remediation/CODE-001-split-company-store`

### Целевая структура

```text
src/domain/
src/application/commands/
src/data/repositories/
src/features/
src/stores/
```

### Правило ответственности

- domain: расчёты и инварианты;
- application command: orchestration одного use case;
- repository: Firestore;
- store: session/UI state;
- page: composition и routing;
- component: rendering/interaction.

### Критерий приёмки

- `companyStore.ts` больше не содержит import parser, Firestore sync, role authorization и все финансовые формулы одновременно;
- business rules тестируются без React/Firebase.

---

## [ ] CODE-002 — Заменить глобальный forceUpdate-store на selector-based state

**Ветка:** `remediation/CODE-002-selector-store`

### Выбранный подход

- Zustand с selectors для session/UI/application state;
- Firestore data — через repository/hooks и ограниченные feature stores;
- не возвращать весь mutable store каждому компоненту.

### Изменить

```text
src/store/useStore.ts
src/store/authStore.ts
src/store/companyStore.ts
consumers
```

### Требования

1. Компонент подписывается только на нужный slice.
2. Изменение calendar item не перерендеривает не связанные страницы.
3. Snapshots immutable.
4. Subscription lifecycle корректен для React.
5. React Profiler показывает сокращение лишних render.

### Критерий приёмки

- отсутствует ручной `forceUpdate(n => n + 1)` для всего приложения;
- selectors покрыты tests;
- крупные страницы не получают весь company dataset без необходимости.

---

## [ ] CODE-003 — Включать строгий TypeScript по ступеням

**Ветка:** отдельная на каждую ступень.

### Порядок

1. `strictNullChecks`.
2. `noImplicitAny`.
3. полный `strict`.
4. `noUncheckedIndexedAccess`.
5. `exactOptionalPropertyTypes`.
6. type-aware ESLint rules.

### Правила

- не закрывать ошибки массовыми `as unknown as`;
- не добавлять бездумный `any`;
- внешние данные проходят runtime schema;
- exhaustive switches для role/type/status.

### Критерий приёмки

- каждая ступень зелёная в CI до перехода к следующей;
- количество suppressions измерено и уменьшается;
- финансовые DTO не основаны на unchecked assertions.

---

## [ ] CODE-004 — Разделить крупные страницы на feature-компоненты

**Ветка:** по одной feature за PR.

### Приоритет

```text
Transactions.tsx
Accounts.tsx
Import.tsx
Dashboard.tsx
Forecast.tsx
```

### Пример для Transactions

```text
src/features/transactions/
  TransactionTable.tsx
  TransactionFilters.tsx
  TransactionEditor.tsx
  BulkActions.tsx
  useTransactionQuery.ts
  useTransactionCommands.ts
```

### Критерий приёмки

- page отвечает за route composition;
- финансовые формулы отсутствуют в JSX;
- feature units имеют tests;
- нет дублированных `.find()`/mapping по крупным массивам в каждом render.

---

## [ ] CODE-005 — Исправить async cleanup и React lifecycle defects

**Ветка:** `remediation/CODE-005-async-lifecycle`

### Исправить минимум

- FX request в `Accounts.tsx`: AbortController/generation check;
- setState во время render в `Layout.tsx`;
- cleanup workers/listeners/timeouts;
- Error Boundary для lazy routes и data errors;
- stale modal state после company switch;
- зависимые effects с корректными dependencies.

### Критерий приёмки

- нет state update от устаревшего FX response;
- нет render-phase state update;
- tests покрывают unmount/cancel/switch.

---

## Контрольная точка GATE-6

- [ ] domain/data/UI разделены;
- [ ] глобальный forceUpdate удалён;
- [ ] TypeScript strict включён по утверждённой ступени;
- [ ] крупные страницы разбиты по use cases;
- [ ] async resources корректно очищаются.

---

# ЭТАП 7. Производительность и размер bundle

## Цель этапа

Снизить initial load и обеспечить масштабирование списков после архитектурной миграции.

---

## [ ] PERF-001 — Добавить постоянный bundle analysis и budgets

**Ветка:** `remediation/PERF-001-bundle-budgets`

### Действия

1. Добавить visualizer/report для production build.
2. Сохранять размеры initial и route chunks в CI artifact.
3. Установить provisional budgets после baseline, например:
   - initial JS gzip ≤ 300 KB;
   - отдельный route chunk ≤ 250 KB gzip;
   - regression > 10% требует объяснения.
4. Не скрывать warning простым увеличением `chunkSizeWarningLimit`.

### Критерий приёмки

- каждый PR показывает изменение bundle;
- budget failure блокирует необъяснённую регрессию.

---

## [ ] PERF-002 — Добавить route-level code splitting

**Ветка:** `remediation/PERF-002-lazy-routes`

### Изменить

```text
src/App.tsx
```

### Действия

1. Перевести страницы на `React.lazy(() => import(...))`.
2. Добавить `Suspense` с page skeleton.
3. Добавить Error Boundary для chunk load errors.
4. Login/Register не должны загружать reports, charts, import и dnd features.
5. Lazy declarations размещать на module level.

### Критерий приёмки

- production build содержит route chunks;
- dashboard код не загружается на login;
- lazy load error имеет recoverable UI.

---

## [ ] PERF-003 — Вынести тяжёлые feature dependencies

**Ветка:** `remediation/PERF-003-heavy-feature-chunks`

### Разделить

- import parser — только import worker;
- Recharts — только dashboard/report routes;
- dnd-kit — только feature, где есть drag-and-drop;
- admin/member management — отдельный admin route chunk.

### Критерий приёмки

- parser/charts/dnd отсутствуют в login initial dependency graph;
- загрузка происходит только при открытии feature.

---

## [ ] PERF-004 — Настроить chunking под фактическую версию Vite

**Ветка:** `remediation/PERF-004-vite-chunking`

### Важно

Проект использует Vite 8, поэтому не копировать без проверки старые примеры `build.rollupOptions`. Использовать актуальную конфигурацию Vite 8/Rolldown и сначала измерить результат естественных dynamic imports.

### Действия

1. Сначала проверить chunks после `React.lazy`.
2. Только затем группировать стабильные vendor chunks.
3. Не создавать один огромный `vendor` chunk.
4. Проверить cache behavior между deployments.
5. Обработать preload/chunk load errors.

### Критерий приёмки

- chunking основан на измерениях;
- нет общего тяжёлого vendor chunk, отменяющего lazy loading;
- повторный deployment не оставляет пользователя с необработанной ошибкой старого chunk URL.

---

## [ ] PERF-005 — Добавить pagination и virtualization в UI

**Ветка:** по feature.

### Приоритет

```text
Transactions table
Import preview
Counterparties
Audit log
```

### Действия

1. Firestore cursor pagination.
2. Виртуализировать большие таблицы.
3. Создавать memoized maps `id -> entity`.
4. Убрать повторные линейные `.find()` внутри больших loops/render.
5. Добавить performance fixtures на крупные datasets.

### Критерий приёмки

- DOM не содержит десятки тысяч строк одновременно;
- открытие списка не требует загрузки всей истории;
- interaction latency измерена на large fixture.

---

## [ ] PERF-006 — Зафиксировать Web Vitals и regression checks

**Ветка:** `remediation/PERF-006-web-vitals`

### Измерять

- login initial load;
- first authenticated shell;
- dashboard;
- transaction table;
- import parsing/preview;
- report range change.

### Критерий приёмки

- показатели сравниваются с `TECHNICAL_BASELINE.md`;
- ухудшения не маскируются субъективной оценкой.

---

## Контрольная точка GATE-7

- [ ] страницы загружаются лениво;
- [ ] тяжёлые библиотеки не входят в initial route;
- [ ] chunking соответствует актуальному Vite;
- [ ] таблицы paginated/virtualized;
- [ ] bundle budgets и Web Vitals работают в CI/release checks.

---

# ЭТАП 8. UX и продуктовая надёжность

## Цель этапа

Сделать безопасную архитектуру понятной пользователю: показать статус синхронизации, права, конфликты, onboarding и контролируемый импорт.

---

## [ ] UX-001 — Показать sync/offline/conflict state

**Ветка:** `remediation/UX-001-sync-status`

### UI должен показывать

```text
Сохранение…
Сохранено
Нет сети
Есть несохранённые изменения
Конфликт версии
Ошибка сохранения — повторить
Последняя успешная синхронизация
```

### Критерий приёмки

- пользователь не предполагает, что данные сохранены, когда это не так;
- конфликт имеет понятный recovery flow.

---

## [ ] UX-002 — Завершить read-only UX ролей

**Ветка:** `remediation/UX-002-read-only-mode`

### Действия

1. Viewer видит отчёты и данные.
2. Write buttons скрыты/disabled с объяснением.
3. Accountant не видит управление ролями/security.
4. Admin actions требуют подтверждения.
5. Role active company видна в интерфейсе.

### Критерий приёмки

- ни одна роль не сталкивается с молчаливым отказом после заполнения формы;
- permission denied объясняется корректно.

---

## [ ] UX-003 — Добавить guided onboarding

**Ветка:** `remediation/UX-003-onboarding`

### Последовательность

```text
1. Компания и базовая валюта
2. Счета и начальные остатки
3. Импорт выписки
4. Категории
5. Проекты/направления
6. Cash vs recognition policy
7. Приглашение сотрудника
8. Первый ДДС/P&L
```

### Критерий приёмки

- новый пользователь понимает первый следующий шаг;
- можно пропустить необязательный этап и вернуться;
- progress хранится per company.

---

## [ ] UX-004 — Добавить undo/rollback и историю изменений

**Ветка:** `remediation/UX-004-history-and-undo`

### Приоритет

- import rollback;
- bulk categorization undo;
- delete transaction recovery;
- role/security audit view;
- period close/reopen history.

### Критерий приёмки

- массовая ошибка не требует ручного восстановления каждой строки;
- пользователь видит, кто изменил данные.

---

## [ ] UX-005 — Уточнить методологию отчётов

**Ветка:** `remediation/UX-005-report-methodology`

### Действия

1. Для ДДС, P&L и Balance добавить описание метода.
2. Не называть группировку по `relatedDate` полноценным accrual accounting без AR/AP ledger.
3. Упрощённый Balance обозначить честно до внедрения двойной записи.
4. Добавить drill-down от цифры отчёта к операциям.
5. Добавить предупреждения о некатегоризированных операциях.

### Критерий приёмки

- пользователь понимает происхождение цифры;
- продукт не создаёт ложного впечатления бухгалтерской полноты.

---

## [ ] UX-006 — Добавить trust/security pages и отдельный origin

**Ветка:** `remediation/UX-006-trust-layer`

### Добавить

```text
Privacy policy
Terms
Security overview
Data export/delete process
Backup policy
Support/contact
```

### Инфраструктура

1. Перейти на отдельный custom domain приложения.
2. Настроить HTTPS, CSP и безопасные headers в доступных пределах hosting platform.
3. Не размещать другие недоверенные приложения на том же origin.

### Критерий приёмки

- пользователь понимает, где и как хранятся данные;
- приложение имеет отдельную origin-границу;
- есть процесс экспорта и удаления данных.

---

## Контрольная точка GATE-8

- [ ] sync/error/conflict видимы;
- [ ] роли имеют завершённый UX;
- [ ] onboarding ведёт к первому полезному результату;
- [ ] массовые действия откатываются;
- [ ] методология отчётов прозрачна;
- [ ] trust/security документы опубликованы.

---

# ЭТАП 9. Продуктовый backlog после стабилизации

Эти задачи выполняются только после закрытия GATE-5. Порядок основан на ценности для малого бизнеса и зависимостях модели данных.

## [ ] PROD-001 — Банковская синхронизация и полноценная сверка

- bank operation ID;
- incremental sync;
- reconciliation opening/closing balance;
- очередь неизвестных операций;
- обучаемые правила категоризации;
- контроль дублей.

## [ ] PROD-002 — Платёжные заявки и согласование

- инициатор;
- согласующий;
- лимиты;
- статусы;
- вложения;
- комментарии;
- связь с payment calendar;
- audit trail.

## [ ] PROD-003 — Дебиторская и кредиторская задолженность

- invoices/acts/obligations;
- due dates;
- partial payments;
- aging;
- overdue alerts;
- привязка банковской оплаты.

## [ ] PROD-004 — Настоящий accrual/double-entry ledger

- chart of management accounts;
- double-entry postings;
- AR/AP;
- loans/capital;
- сторно;
- closing;
- полноценный управленческий balance.

## [ ] PROD-005 — 13-недельный cash forecast и сценарии

- base/optimistic/pessimistic;
- кассовые разрывы;
- sensitivity;
- planned vs actual;
- alerts.

## [ ] PROD-006 — Unit economics и распределение расходов

- проекты/направления;
- direct/indirect costs;
- allocation rules;
- gross/contribution margin;
- profitability by client/project/product.

## [ ] PROD-007 — Консолидация нескольких юрлиц

- group reporting;
- intercompany transactions;
- eliminations;
- multiple base currencies;
- group roles.

## [ ] PROD-008 — Интеграции для РФ

- 1С;
- CRM;
- ЭДО;
- маркетплейсы;
- acquiring;
- Telegram/email notifications;
- налоговый/платёжный календарь.

---

# 10. Итоговые release-границы

## Уровень A — только разработка/staging

Пока не закрыты `GATE-0` и `GATE-1`, реальные финансовые данные и multi-user доступ не допускаются.

## Уровень B — ограниченный пилот

Допустим только после:

```text
GATE-1 security
GATE-2 session/data lifecycle
GATE-3 financial invariants
GATE-4 import safety
```

При этом монодокумент ещё ограничивает безопасную многопользовательскую работу.

## Уровень C — многопользовательская production-эксплуатация

Допустима после `GATE-5`, когда:

- операции находятся в отдельных документах;
- нет full-document last-write-wins;
- migration verified;
- Rules и membership работают серверно;
- отчёты и остатки сверяются.

## Уровень D — коммерчески зрелый продукт

Требует `GATE-6`–`GATE-8` и выбранной части продуктового backlog.

---

# 11. Шаблон отчёта по каждому выполненному пункту

```markdown
## Task
SEC-XXX — название

## Branch / commit
...

## Что изменено
- ...

## Какие риски закрыты
- ...

## Какие файлы затронуты
- ...

## Миграция данных
- нет / описание

## Проверки
- [ ] npm ci
- [ ] npm run lint
- [ ] npm run typecheck
- [ ] npm run test:run
- [ ] npm run test:rules
- [ ] npm run test:e2e
- [ ] npm run build

## Фактический вывод тестов
...

## Ручная проверка
...

## Security review
...

## Rollback
...

## Известные ограничения
...

## Следующий разрешённый пункт
...
```

---

# 12. Формат задания для последовательной работы с ревьюером

Для начала каждого шага использовать формулировку:

```text
Открой REMEDIATION_PLAN.md и выполни только пункт <TASK-ID>.
Не переходи к следующему пункту.
Сначала перепроверь текущее состояние ветки и добавь тест/воспроизведение.
После изменений покажи:
1) какие файлы изменены;
2) полный diff по существу;
3) результаты lint/typecheck/tests/build;
4) риски и rollback;
5) выполнены ли все критерии приёмки пункта.
```

Для ревью готовой реализации:

```text
Проведи независимое ревью выполнения пункта <TASK-ID> из REMEDIATION_PLAN.md.
Не доверяй описанию автора PR: перепроверь код, тесты, Rules и миграционные последствия.
Дай вердикт PASS / CHANGES REQUIRED и перечисли блокирующие замечания.
```

---

# 13. Критические напоминания

1. Firebase web config не является границей безопасности. Граница — Auth, Rules, server-side authorization и корректная модель данных.
2. UI role checks нужны для UX, но не защищают Firestore.
3. App Check дополняет, но не заменяет Rules.
4. Монодокумент должен быть временно защищён revision conflict, а затем выведен из эксплуатации.
5. `localStorage` не должен хранить полную рабочую копию финансов компании.
6. Любая финансовая мутация должна иметь тест на сохранение суммы/остатка.
7. Любой массовый импорт должен быть идемпотентным, возобновляемым или откатываемым.
8. Нельзя считать задачу выполненной по факту «сборка зелёная» без проверок прав и финансовых инвариантов.

---

# 14. Официальные технические справочники

- Firebase Security Rules unit testing: https://firebase.google.com/docs/rules/unit-tests
- Firestore transactions and batched writes: https://firebase.google.com/docs/firestore/manage-data/transactions
- Firebase Admin user management: https://firebase.google.com/docs/auth/admin/manage-users
- Firebase callable functions: https://firebase.google.com/docs/functions/callable
- React `lazy`: https://react.dev/reference/react/lazy
- Vite production build and current chunking configuration: https://vite.dev/guide/build
