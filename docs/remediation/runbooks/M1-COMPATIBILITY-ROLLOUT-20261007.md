# M1 — актуальная матрица совместимости и предложение rollout/rollback (2026-10-07)

Статус: **PROPOSAL, PREPARED_NOT_AUTHORIZED.** Документ ничего не выполняет и не даёт допуска ни на один шаг.
Задача: `M1-SAFE-STOP-RECOVERY-01`. Источник фактов — `.runtime/AUDIT_CURRENT_STATE_20261007.md` (аудит 2026-10-07: чтения live-систем и
локальные проверки), `docs/remediation/reports/PROD-LOGIN-20261007.md` (ветка hotfix), сохранённые артефакты run `r3-ab9fb2fe`
и исходники PR #28. Новых обращений к Firebase/VDS в этом блоке не было; значения ниже помечены источником:
**[A]** — зафиксировано аудитом/артефактами, **[S]** — следует из исходников/тестов этого репозитория, **[?]** — не проверено.

## 1. Фактическое состояние (на 2026-10-07)

| Слой | Production (`finapp-prod-10a83`) | Staging (`finapp-staging`) |
|---|---|---|
| GitHub | `main` = `6d713fe77164b5d7f096a85509d73b43bd9dad13` **[A]** | PR #28 OPEN, HEAD `714d0f91c60a582ee87dc7da82d6249b3106329f`, не слит **[A]** |
| Frontend на VDS (`app.aktivmetr.ru` / stage-root) | login hotfix `6c51d5ca…` от `main`, release `/srv/aktivmetr-app/releases/6c51d5c-login-20261007` **[A]** | артефакт `714d0f91` (15 файлов совпали с `m1-dist-staging-714d0f91`) **[A]** |
| Frontend на GitHub Pages | сборка `main` (клиент `6d713fe`, читает `users` list) **[A]/[S]** | — |
| Firestore Rules | canonical round 3, SHA-256 `c4fe4c09…19fd`, release.updateTime 2026-10-03T19:42:58Z **[A]** | тот же SHA-256, updateTime 2026-10-07T08:06:12Z (выкачены run `r3-ab9fb2fe`) **[A]** |
| Cloud Functions | `createCompany`, `authzProbe` (ACTIVE, nodejs22, us-central1); **нет** `listCompanyMembers` и остальных member/invitation **[A]** | 13 функций ACTIVE (5 M1 callable + `createCompany` + `authzProbe` + 6 invitation) **[A]** |
| Auth / Firestore / Functions runtime | Google; VDS — только static frontend **[A]** | Google **[A]** |

`main` Rules имеют другой SHA-256 (`15bbc005…f89d`) — production **не** соответствует ни полному `main`, ни полному PR #28.

## 2. Матрица совместимости клиент × серверная часть

Клиенты: **C0** — клиент `main` (`6d713fe`): при входе и переключении компании делает `getDocs(query(collection(db,'users'), where('companyId'…)))`;
**C1** — login hotfix `6c51d5ca` (убран users-query, roster/приглашения честно помечены unavailable; **постоянным решением не является**);
**C2** — полный клиент PR #28 (`714d0f91`): читает только `users/{uid}` (`getDoc`, `src/store/authStore.ts:533,639,713`; ни одного `collection(db,'users')` в `src/`) **[S]**,
roster через callable `listCompanyMembers`.

| Клиент | Rules R3 (canonical, live) | Functions сейчас (prod: 2) | Functions Set A (7: +5 M1) |
|---|---|---|---|
| **C0** (main, GitHub Pages) | **вход ломается**: `users` list запрещён безусловно → `data_error` → возврат на login **[A]** | — | — |
| **C1** (VDS сейчас) | вход работает; Users/Settings: «roster unavailable», управление закрыто **[A]** | как слева | вход работает, новые callable не вызываются — безвредно **[S]** |
| **C2** (PR #28) | вход **должен** работать (own-profile `get` разрешён, users-list не используется) **[S]**, на staging эмулятор-тесты `tests/rules/*` покрывают это; на production не проверялось **[?]** | вход работает, но `listCompanyMembers`/роли/lifecycle вернут ошибку (функций нет); поведение экрана Users в этом режиме **[?]** не проверено | полный функционал (roster, роли, отключение/восстановление/удаление) |

Ограничения C2, известные из `docs/remediation/reports/FINAPP-1.0-M1.md` (проверено чтением, не на production): компании обнаруживаются клиентом только из legacy-подсказок профиля (`companyId`/`companies[]`) с последующей проверкой собственного canonical membership — активный membership компании, отсутствующей в этих полях профиля, клиентом не обнаруживается; изменения чужих ролей видны после перезагрузки; экран «Нет доступа к компании» проверен только jsdom-тестами (в браузере — нет). Для настоящей учётной записи владельца аудит подтвердил согласованность профиля/компании/membership (маскированные IAM-чтения), поэтому P5 разумен, но это проверяется именно на шаге P5.

Выводы, которые меняют прежний план:

1. **Rules уже canonical в production.** Шаг «выкатить Rules round 3» (P4 пакета v6, окно «frontend → Rules») для production **больше не существует**;
   `m1p-pins.mjs` (строка с проверкой `the round-3 Rules are already live in production: nothing to deploy`) отказывается создавать pins — этот guard теперь верен, его
   нельзя отключать, а пакет v6 нельзя запускать. Нужен новый пакет без Rules-окна (см. §4).
2. **Прежний порядок «Functions → Pages → Rules» недостаточен.** Frontend production — VDS, а не Pages; merge `main` запускает только GitHub Pages
   (`.github/workflows/deploy.yml`: CI success → `npm ci`, lint, build с секретами репозитория `VITE_FIREBASE_*` → `deploy-pages`) и **не** обновляет VDS и **не** выкатывает Functions.
3. **Откат Rules к round 2 не является откатом входа.** Клиенты C0/legacy при canonical Rules не входят **[A]**; возвращать Rules нельзя считать восстановлением входа.
   Единственный безопасный откат frontend — на C1 (hotfix), совместимый с R3.
4. **Регрессионный сценарий релиза «запрет users list не ломает вход» обязателен** (§5, проверка G1).

Что в `FINAPP-1.0-M1.md` (раздел «Подготовленный порядок production deployment») **устарело для production**: таблица «клиент × Rules» и вывод о «едином окне Pages + Rules» относятся к состоянию, когда Rules ещё были прежними. Сейчас Rules уже canonical, окна «frontend → Rules» нет, а клиентом production является VDS-release hotfix, а не Pages. Сам отчёт не редактировался (это отдельный пункт).

## 3. Staging — состояние и предложение

Состояние **[A]**: run `r3-ab9fb2fe` (v6 пакет) — шаги 0–5 выполнены, `EXPORT_VERIFIED` (реальный `operations describe`), Rules round 3 выкачены и проверены;
шаг 6 (smoke `seed`) остановился: первый же запрос создания Auth-пользователя завершился `transport: network failure POST accounts` через 10,7 с;
`cleanup` отказал (`G2`/`G3`), удалений не было; STAGE_PASS нет. Остаточных синтетических ресурсов не обнаружено на 2026-10-07T08:08Z (inventory, чтения) и
на 17:23Z (аудиторский `accounts:lookup` по точному субъекту): это отсутствие «на момент чтения», не доказательство, что запрос никогда не был обработан.
Staging сейчас = C2 (VDS stage root) + R3 + 13 функций, то есть **уже в целевом для production состоянии клиента/Rules**.

Что остаётся доказать на staging (синтетические данные, **не** настоящие аккаунты): `seed` → `ui` → `api` (R1–R7, ownerId-probe) → `ui-r3` → `cleanup` → `verify-clean` на R3 + 13 функциях + C2.

Предлагаемая последовательность (каждый шаг — отдельный допуск владельца на конкретные bytes; **ничего не выполняется этим документом**):

| № | Шаг | Предусловие | Проверка после шага | Откат |
|---|---|---|---|---|
| S0 | Независимый аудит исправления transport/recovery (этот блок) и нового пакета-кандидата | PASS аудитора | воспроизведение «до/после» (отчёт §Проверки) | — |
| S1 | **Smoke-only** запуск на staging: readiness → preflight → seed → ui → api → ui-r3 → cleanup → verify-clean | штатный оркестратор **не подходит** (шаг 1 требует live Rules = round 2, `state-rules-target` → STOP; шаги 4–5 экспортируют и деплоят Rules): нужен либо (a) допуск владельца на откат staging Rules к round 2 и повтор полного прогона, либо (b) отдельная версия оркестратора «smoke-only на R3» с собственными тестами и аудитом | read-only: те же 13 функций, Rules = `c4fe4c09…`; inventory после cleanup пуст | cleanup + verify-clean; Rules/Functions в smoke не меняются |
| S2 | При (a): откат staging Rules к round 2 по подготовленному каталогу (`m1-deploy-wrapper --kind rules-rollback`) | допуск; backup Rules есть в evidence прежнего run | `verify-current-rules` = `f117e489…` | повторная выкатка R3 только отдельным допуском |

Оценка: вариант (b) соответствует реальному production-пути (Rules уже live), вариант (a) повторяет репетицию окна, которого в production больше нет. Решение за аудитором/владельцем.

## 4. Production — предложение (новый пакет; прежний v6 не использовать)

Отправная точка: **R3 live + C1 на VDS + 2 функции.** Цель: C2 на VDS + Set A функций, роли/roster работают. Rules не меняются.

Allowlist Functions (точный, из `m1p-deploy.deployArgs`): 
`firebase deploy --project finapp-prod-10a83 --only functions:authzProbe,functions:changeMemberRole,functions:createCompany,functions:disableMember,functions:listCompanyMembers,functions:removeMember,functions:restoreMember --non-interactive`.
Invitation-функции (`inviteMember`, `listInvitations`, `cancelInvite`, `resendInvite`, `previewInvite`, `acceptInvite`, `getCompanyAccess`) **не** входят и не деплоятся.
Вариант A′ (для решения аудитора): только 5 новых callable (без перевыкатки `createCompany`/`authzProbe`, у которых при перевыкатке меняются лимиты: 256 MiB, CPU 1, concurrency 1, max 1) — минимальное воздействие на работающие функции; прежнее решение владельца — 7 функций (Set A).

Источник frontend artifact: **локальная воспроизводимая сборка из точного коммита** (HEAD PR #28 / tree-идентичный squash-коммит, `npm ci`, `npm run build`) с шестью публичными
значениями Firebase-конфигурации production, скопированными из текущего опубликованного bundle (как в hotfix), манифест SHA-256 всех файлов. Сборка GitHub Pages **не** используется как источник
для VDS (ключи — секреты репозитория, артефакт нельзя сверить побайтно).

| № | Шаг | Предусловие | Проверка после шага (read-only, остановка при любом расхождении) | Откат |
|---|---|---|---|---|
| P0 | Preflight, только чтение | допуск на preflight | Rules SHA-256 = `c4fe4c09…`; функции = `createCompany`, `authzProbe`; `main` и PR #28 HEAD ожидаемые; VDS symlink → `6c51d5c-login-20261007`, 15 файлов по HTTPS = манифест hotfix; maintenance off | — |
| P1 | Свежий backup Firestore export (перед включением изменяющих callable) | P0 | `EXPORT_VERIFIED` (операция SUCCESSFUL, префикс, листинг), `freshnessAnchor` ≤ 30 мин до P3 | export — справочная копия; import не входит в откат |
| P2 | Gate: STAGE_PASS (S1) на **тех же bytes** | S1 принят аудитором | evidence S1 | — |
| P3 | Deploy Functions по allowlist выше | P1, P2; допуск C | список функций: ровно allowlist, ACTIVE/GEN_2/nodejs22/us-central1, caps; неаутентифицированный POST к 5 callable → слой приложения (401 `UNAUTHENTICATED`), invitation-функции → 404 | C1 не вызывает новые callable → оставить как есть; удаление функций — только отдельный допуск (destructive) |
| P4 | Публикация C2 на VDS: новый каталог `releases/<sha8>-m1-<date>`, checkpoint + `rollback.sh` (по образцу `login-fix-20261007`), атомарное переключение symlink, nginx не меняется | P3; допуск D на конкретный артефакт | 15+ файлов по HTTPS = манифест; root и `/finapp/` index; в bundle нет `finapp-staging`, есть production project id; старые hashed assets сохранены для открытых вкладок | `bash /srv/aktivmetr-app/checkpoints/<…>/rollback.sh` → hotfix C1 (совместим с R3); Rules не откатываются |
| P5 | Проверка владельцем настоящим аккаунтом, **только чтение**: вход, выбор компании, Users открывается и показывает состав (`listCompanyMembers`); без смены ролей | P4 | консоль браузера без `authStore`/`companyStore` ошибок; нет «Нет доступа» у владельца | rollback.sh |
| P6 | Merge PR #28 в `main` (запускает GitHub Pages — внешний шаг) | P3–P5; `m1p-tree-check`-эквивалент: tree `origin/main` = tree проверенного HEAD, remote main = fetched main | Pages отдаёт C2 с маркером «Нет доступа к компании»; Functions уже развёрнуты (иначе Pages-клиент увидит только ошибки roster) | revert PR (Pages) — отдельный допуск; VDS уже C2/C1 |

Порядок «P3 до P6» обязателен: после merge Pages сразу публикует C2 против production, а Functions автоматически не выкатываются.

## 5. Обязательные проверки релиза

| № | Проверка | Где/как |
|---|---|---|
| G1 | **«Запрет users list не ломает вход»** (регресс hotfix): клиент входит и открывает компанию, когда `users` list = deny и доступен только own-profile `get` | эмулятор: `tests/rules/authStore.rulesIntegration.test.ts` и `firestore.rules.test.ts` на байтах Rules с pinned SHA-256 `c4fe4c09…`; повторить для hotfix-fixture; на staging — шаг `ui` smoke (вход синтетического пользователя при R3) |
| G2 | Rules в production не меняются (SHA-256 до = после каждого шага) | read-only `verify-current-rules` |
| G3 | Точный состав Functions до/после | read-only inventory/функции-check |
| G4 | Артефакт VDS = манифест (побайтно, HTTPS) | после P4 и после rollback |
| G5 | Синтетические данные не создаются в production | smoke только на staging |

## 6. Синтетика и настоящие аккаунты

| | Синтетические (smoke) | Настоящие |
|---|---|---|
| Где | только staging (`finapp-staging`) | production и личные проверки |
| Создание | оператор через Admin API, `m1-<runId>-*@example.invalid`, `emailVerified=true`, пароли в приватном `fixture.json` (ACL), не в чат/GitHub | владельцем в штатном UI |
| Действия | seed → ui → api (смена ролей, отключение, удаление, ownerId-probe) → cleanup → verify-clean | P5: только чтение; смена ролей — по решению владельца на тестовом коллеге |
| Удаление | cleanup под воротами G0–G5; без ворот — отказ и recovery manifest | не удаляется инструментами |

## 7. Что нужно разрешить отдельно (ничего из этого не выполнялось и не разрешено)

1. Staging S1 (a или b) и, для (a), откат staging Rules. 2. Production P0–P6 по шагам. 3. Публикация hotfix-ветки в GitHub (обычный push/Draft PR) либо
решение о замещении hotfix полным C2. 4. Любые live-чтения сверх уже выполненных аудитом.
