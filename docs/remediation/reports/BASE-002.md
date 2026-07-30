# BASE-002 — Создать отдельное staging Firebase-окружение

## Итоговый статус

```text
REVIEW_RESULT: PASS
TASK_ID: BASE-002
FINAL_STATUS: ACCEPTED
```

Независимое финальное ревью получено и принято. `[x]` в
`REMEDIATION_PLAN.md` проставлен по протоколу `CLAUDE.md` (раздел 11,
«При `PASS`») — только после этого явного `REVIEW_RESULT: PASS`, не
раньше. Полный протокол финальной реальной проверки — «Часть 5» ниже.

**История ревью:**
- Раунд 1 → `CHANGES REQUIRED / BLOCKED` (6 замечаний по коду) — исправлено, см. «Часть 3».
- Раунд 2 → `CODE REVIEW: PASS`, но `BASE-002: BLOCKED_REAL_STAGING_VERIFICATION`
  — весь код принят, требовалась фактическая проверка настоящего
  staging-Firebase. В той сессии `.env.staging.local` отсутствовал —
  зафиксировано `OWNER_ACTION_REQUIRED`, см. «Часть 4».
- Раунд 3 (этот) → владелец предоставил реальную конфигурацию
  `finapp-staging-web` и корректный `STAGING_FIREBASE_CONFIG_FINGERPRINT`
  через локальный (не в Git) `.env.staging.local`. Реальная staging-сборка,
  реальная Auth-проверка (создание и удаление временного тестового
  пользователя) и реальная Firestore-проверка (`PERMISSION_DENIED`,
  ожидаемо для deny-all Rules) — все выполнены и подтверждены. См. «Часть 5».

**Решения владельца, зафиксированные ранее и подтверждённые в этом раунде:**
- Cloud Functions: **`DEFERRED_TO_SEC-003_BY_OWNER`** — не создаются и не
  разворачиваются, Blaze не подключается.
- Realtime Database (случайно созданная в `finapp-staging`): **не удаляется
  и не изменяется** — отдельный `OWNER_ACTION_REQUIRED`.
- Второе веб-приложение в `finapp-staging` (если существует помимо
  `finapp-staging-web`) — не трогалось, не удалялось, не изменялось;
  отдельный `OWNER_ACTION_REQUIRED`, если требует внимания владельца.

Статус `READY_FOR_FINAL_REVIEW` означает: код принят (раунд 2), реальная
staging-проверка пройдена (раунд 3, «Часть 5»). Это **не** равно `[x]` в
`REMEDIATION_PLAN.md` — отметка ставится только после явного
`REVIEW_RESULT: PASS` от независимого ревьюера по протоколу `CLAUDE.md`.

---

# Часть 1 — Preflight (без изменений, для истории)

## Branch / commit
- branch: `remediation/BASE-002-staging`
- base SHA: `3f68e205749d9b7e5fff4bdac8b1f5819078b2b7` (`remediation/main`, merge PR #1 BASE-001)
- result SHA: см. `git rev-parse HEAD` на ветке после коммита этого отчёта
  (единственный коммит цикла — сам этот файл; проблема самоссылки решена
  так же, как в `BASE-001` — итоговый SHA не встраивается в файл, который
  этот же коммит добавляет)

## Синхронизация перед началом (проверено, не предположено)
```text
$ git fetch origin --prune
 - [deleted]  (none)  -> origin/remediation/BASE-001-baseline
   3c2ed4c..3f68e20  remediation/main -> origin/remediation/main

$ git switch remediation/main && git pull --ff-only origin remediation/main
Fast-forward 3c2ed4c..3f68e20
 REMEDIATION_PLAN.md | 2 +-
 docs/remediation/BASELINE.md | 274 ++++...
 docs/remediation/reports/BASE-001.md | 237 ++++...

$ git log -1 3f68e20
commit 3f68e205749d9b7e5fff4bdac8b1f5819078b2b7
Merge: 3c2ed4c eb09199
Merge pull request #1 from Alexspb-spb1/remediation/BASE-001-baseline
BASE-001: зафиксировать baseline remediation

$ grep -n "BASE-001" REMEDIATION_PLAN.md
93: ## [x] BASE-001 — ...

$ git status --short
(пусто — дерево чистое)
```
Все пять условий синхронизации подтверждены: fetch выполнен, ветка
переключена, ff-only pull прошёл без конфликтов, merge-коммит `3f68e20`
присутствует в истории и соответствует ожидаемому, `BASE-001` отмечена
`[x]`, дерево чистое.

Локальная ветка `remediation/BASE-001-baseline` удалена командой
`git branch -d` (безопасное удаление, сработало только потому, что ветка
полностью влита — Git отказал бы иначе) — remote-копия уже была удалена
GitHub автоматически после merge PR #1. `remediation/main` и `main` не
удалялись и не изменялись напрямую.

Ветка `remediation/BASE-002-staging` создана от актуального
`remediation/main` (`3f68e20`).

## Preflight-проверки (фактическое состояние среды и репозитория)

### 1. Установлен ли Firebase CLI
Глобально — **нет** (`which firebase` → не найден, `firebase --version` →
`command not found`). Через `npx firebase-tools@latest --version` CLI
успешно резолвится и запускается (версия `15.23.0`), т.е. технически
доступен по требованию через npm registry, но не установлен как
постоянный инструмент в этой среде.

### 2. Авторизация Firebase CLI
**Не авторизован.** `npx firebase-tools login:list` →
`⚠ No authorized accounts, run "firebase login"`. Интерактивный
`firebase login` (браузерный OAuth) не запускался — это заведомо owner-
действие, не входящее в preflight.

### 3. Доступные Firebase-проекты текущему аккаунту
**Не может быть проверено** — команда `firebase projects:list` требует
авторизации (см. пункт 2), которой нет. Не выполнялась.

### 4. Production project ID, используемый приложением
`finapp-prod-10a83` — задокументирован в `docs/remediation/BASELINE.md`
(раздел 6) как **заявленный владельцем** факт (`OWNER_INPUT`, 2026-07-13),
без независимого технического подтверждения (сессия не имеет доступа к
Firebase Console/CLI). В самом Git этот ID нигде не закоммичен — только
имя GitHub Secret `VITE_FIREBASE_PROJECT_ID` в `.github/workflows/deploy.yml`.

### 5. Существующие файлы
| Файл/директория | Статус |
|---|---|
| `.firebaserc` | НЕ СУЩЕСТВУЕТ |
| `firebase.json` | НЕ СУЩЕСТВУЕТ |
| `firestore.rules` | НЕ СУЩЕСТВУЕТ |
| `firestore.indexes.json` | НЕ СУЩЕСТВУЕТ |
| `functions/` | НЕ СУЩЕСТВУЕТ |
| `.env.example` | СУЩЕСТВУЕТ (только плейсхолдеры) |
| `.env` / `.env.local` / `.env.development.local` / `.env.staging.local` / `.env.production.local` | НЕ СУЩЕСТВУЮТ |

Все шесть отсутствующих файлов/директорий — это ровно то, что должен
создать сам `BASE-002` (см. `REMEDIATION_PLAN.md`, действия 1–4). Их
отсутствие сейчас — ожидаемое стартовое состояние, а не проблема.

### 6. Ожидаемые VITE_FIREBASE_* переменные
Из `src/lib/firebase.ts` и `.env.example`, ровно 6 переменных:
```text
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
```
Других Firebase-переменных (например, `measurementId`) код не использует.

### 7. Содержит ли Git секреты/реальные env-значения
**Нет**, проверено, а не предположено:
- `git log --all --diff-filter=A --name-only` по `.env*` файлам — в истории
  когда-либо добавлялся только `.env.example`; `.env`/`.env.local` и т.п.
  никогда не коммитились.
- Содержимое `.env.example` во всех версиях — только плейсхолдеры
  (`AIzaSy...`, `your-project`, `123456789`, `abc123`), реальных значений нет.
- Широкий grep по всем `.ts`/`.tsx`/`.js`/`.json`/`.md`/`.yml` файлам на
  паттерн реального Firebase API key (`AIzaSy` + 30+ символов) — ничего
  не найдено.

### 8. Workflows в `.github/workflows`
Единственный файл — `deploy.yml` («Deploy to GitHub Pages»):
триггеры `push`/`pull_request` в `main`, `workflow_dispatch`; job `build`
(`npm ci` → `npm run lint` → `npm run build` с `VITE_FIREBASE_*` из
`secrets.*` → `upload-pages-artifact`); job `deploy` (только при `push` в
`main`) — публикует статику на GitHub Pages через `actions/deploy-pages@v4`.
Отдельного CI-workflow для staging/PR-проверок Firebase-функций нет —
это ожидаемо, появится в `BASE-006`.

### 9. Возможно ли создать отдельный staging Firebase/GCP project из текущей среды
**Нет, по двум независимым причинам:**
1. Firebase CLI не авторизован (пункт 2) — создание проекта требует
   аутентифицированного аккаунта с правами на GCP Resource Manager.
2. У этой рабочей среды **нет исходящего доступа в открытый интернет**:
   `curl` к `https://firebase.google.com` и `https://console.firebase.google.com`
   вернул код `000` (таймаут/недоступно) для обоих адресов. Единственный
   работающий сетевой канал в этой сессии — локальный git-прокси для
   операций с текущим GitHub-репозиторием; прямых вызовов к Firebase/GCP
   API эта среда выполнить не может, даже при наличии авторизации.

### 10. Что потребует действия владельца
Да, обязательно, по всем перечисленным пунктам ниже (раздел
OWNER_INPUT_REQUIRED) — создание GCP/Firebase-проекта, включение billing
(если потребуется), выбор региона, включение сервисов (Auth, Firestore,
Functions) физически может выполнить только владелец через свою
авторизованную сессию (Firebase Console или `firebase login` на его
собственной машине/окружении с интернет-доступом) — не эта песочница.

## OWNER_INPUT_REQUIRED

Ничего из следующего не выдумано и не выбрано самостоятельно — все
значения должен предоставить/подтвердить владелец:

- **Предлагаемое имя staging Firebase project** — не выбрано. Рекомендация
  по неймингу (не решение): что-то явно отличимое от `finapp-prod-10a83`,
  например `finapp-staging` — но финальное имя выбирает владелец.
- **Предлагаемый уникальный project ID** — Firebase/GCP project ID
  глобально уникален и назначается при создании; заранее зарезервировать
  его без доступа к Firebase Console нельзя. Владелец должен либо создать
  проект и сообщить фактический ID, либо явно согласовать шаблон
  (например `finapp-staging-<random>`), который Claude Code сможет
  использовать при следующей задаче — если будет отдельное разрешение и
  рабочий доступ к Firebase CLI/Console из подходящей среды.
- **Регион Firestore** — не выбран. Требует решения владельца (обычно
  выбирается один раз навсегда для проекта, влияет на задержку и
  комплаенс; типичный вариант для РФ-аудитории — `eur3`/`europe-west` или
  аналог, но это не техническая рекомендация этой сессии, а вопрос к
  владельцу).
- **Регион Cloud Functions** — не выбран, аналогично; обычно должен
  совпадать/быть близким к региону Firestore для снижения задержки.
- **Нужен ли billing (Blaze plan) для предусмотренной конфигурации** —
  зависит от того, понадобятся ли Cloud Functions за пределами бесплатной
  квоты и от планов на App Check/дополнительные сервисы (`SEC-013`).
  Firebase Authentication и Cloud Firestore в базовом объёме доступны на
  Spark (бесплатном) плане; Cloud Functions 2nd gen обычно требует Blaze
  (billing включён) даже в пределах бесплатной квоты использования.
  Финальное решение и включение billing — только владелец.
- **Какие действия должен выполнить владелец вручную:**
  - создать новый Firebase/GCP project для staging через Firebase Console
    (или `firebase login` + `firebase projects:create` в своей среде с
    интернет-доступом);
  - включить нужные сервисы (Authentication, Firestore, при необходимости
    Cloud Functions/billing);
  - выбрать регион(ы);
  - сгенерировать Web App config (`apiKey`, `authDomain`, `projectId` и т.д.)
    для staging;
  - предоставить эти значения либо напрямую (для локальной
    `.env.staging.local`, вне Git), либо через GitHub Secrets (для CI).
- **Какие действия после отдельного разрешения сможет выполнить Claude Code:**
  - создать в репозитории `.firebaserc`, `firebase.json`,
    `firestore.indexes.json`-заглушку, обновлённый `.env.example` с новыми
    ключами окружений — без реальных значений;
  - настроить `.env.development.local`/`.env.staging.local`/`.env.production.local`
    именование и логику выбора конфигурации в коде;
  - добавить визуальный индикатор staging-сборки в UI;
  - настроить Emulator Suite для локальной разработки;
  — при условии, что реальные project ID/ключи для staging уже предоставлены
    владельцем (см. выше) — сама эта сессия не может их сгенерировать.
- **Какие значения должны храниться только локально или в GitHub Secrets:**
  все реальные Firebase Web App config значения (`apiKey`, `authDomain`,
  `projectId`, `storageBucket`, `messagingSenderId`, `appId`) как для
  staging, так и для production — никогда не в Git, только в
  `.env.*.local` (уже в `.gitignore` через `*.local`) локально и в GitHub
  Secrets для CI/CD. Это уже частично соблюдается сейчас (production
  секреты — только в GitHub Secrets), тот же принцип должен
  распространиться на staging.
- **Как гарантировать, что staging никогда не подключится к production:**
  - разные project ID technically enforced на уровне Firebase SDK
    (`projectId` в конфиге однозначно определяет, к какому проекту
    подключается клиент — перепутать возможно только человеческой
    ошибкой в переменных окружения, не кодом);
  - явный визуальный индикатор staging-сборки в UI (требование
    `REMEDIATION_PLAN.md`, действие 7) — чтобы человек не спутал вкладки;
  - отдельные наборы GitHub Secrets/env-файлов с явными именами
    (`VITE_FIREBASE_PROJECT_ID` для prod через основной deploy workflow,
    отдельный набор — для будущего staging workflow, который появится в
    `BASE-002`/`BASE-006`);
  - CI-переменные для staging-деплоя должны жить в отдельном
    GitHub Environment (например `staging`) с собственным набором
    Secrets, недоступным job'ам production-деплоя, и наоборот.
  Все перечисленные меры — план, а не факт: они должны быть реализованы
  в самой задаче `BASE-002`, сейчас только зафиксированы как требования.

## Ограничения этого запуска — соблюдены
Не создавался Firebase/GCP project; billing не включался; Firestore
database/Authentication/Cloud Functions не создавались/не включались;
`firebase deploy` не выполнялся; production не менялся; Firestore Rules
не менялись (их и не существует в репо); реальные секреты не добавлялись;
`BASE-003` не начиналась; push/merge/PR не выполнялись; функциональный код
не менялся (подтверждено: `git status --short` пуст до создания этого
файла, `npm run build` проходит без изменений в `src/`).

## Проверки
| Команда | Результат |
|---|---|
| `git fetch origin --prune` | PASS |
| `git pull --ff-only origin remediation/main` | PASS (fast-forward) |
| Merge commit `3f68e20` в истории | PASS (подтверждено `git log`) |
| `BASE-001` отмечена `[x]` | PASS |
| `git status --short` (до и после preflight) | PASS (чисто) |
| `npm ci` | PASS |
| `npm run lint` | PASS (0 ошибок) |
| `npm run build` | PASS |
| Firebase CLI доступен (`npx firebase-tools`) | PASS (v15.23.0, по требованию) |
| Firebase CLI авторизован | **FAIL** — не авторизован, ожидаемо на этом этапе |
| Исходящий доступ к Firebase/GCP из этой среды | **FAIL** — недоступен (`curl` → код `000`) |

## Предварительный план выполнения BASE-002 (на основании фактического состояния)

Не реализуется сейчас — план для следующего разрешённого цикла, после
получения `OWNER_INPUT_REQUIRED` выше:

1. Получить от владельца: staging project ID (или подтверждение, что его
   создаст сам владелец и передаст готовые значения), регион(ы), решение
   по billing.
2. Если владелец создаёт staging-проект сам — получить сгенерированный Web
   App config и явное разрешение вида `EXTERNAL_ACTION_APPROVED: BASE-002 /
   ENVIRONMENT: staging` (по протоколу `CLAUDE.md`, раздел 5), прежде чем
   Claude Code будет что-либо конфигурировать под конкретный staging project ID.
3. Добавить `.firebaserc` (со staging и production алиасами — но без
   реальных секретов, project ID в `.firebaserc` не является секретом и
   обычно коммитится), `firebase.json` (Firestore/Functions/Emulators
   секции), `firestore.indexes.json`-заглушку.
4. Ввести `.env.development.local`/`.env.staging.local`/`.env.production.local`
   именование, обновить `src/lib/firebase.ts`/build-конфигурацию, если
   потребуется явный выбор окружения.
5. Обновить `.env.example`, задокументировать в README/BASELINE, какие
   переменные для какого окружения.
6. Добавить визуальный индикатор staging-сборки в UI (например, бейдж в
   `Header.tsx`, видимый только при staging `projectId`).
7. Настроить Emulator Suite конфигурацию для локальной разработки без
   реального Firebase-проекта.
8. Обновить `.gitignore`, если нужно (уже есть `*.local`, скорее всего
   изменений не потребуется — проверить при реализации).
9. Не трогать `deploy.yml` в объёме `BASE-002` (отдельный CI/staging
   workflow — предмет `BASE-006`), если явно не потребуется для
   критерия приёмки «локальная разработка может запускаться через
   Emulator Suite».
10. Прогнать критерии приёмки `BASE-002`: staging никогда не обращается к
    production Firestore/Auth (проверить визуально/логически, т.к. e2e-
    тестов пока нет — `TEST-001` не выполнена); production и staging имеют
    разные project ID (тривиально, если оба реальны и различны);
    Emulator Suite запускается локально; секреты отсутствуют в Git
    (`git log`-скан, аналогично тому, что проверено в этом preflight).

## Известные ограничения
- Пункты 3 («доступные Firebase-проекты») этого preflight не выполнен —
  технически невозможен без авторизации CLI, которую эта сессия не может
  выполнить (интерактивный OAuth).
- Даже при наличии авторизации, у этой среды нет исходящего доступа в
  интернет для вызовов к Firebase/GCP API — реальное создание
  проекта/включение сервисов физически не может быть выполнено из этой
  сессии ни сейчас, ни, вероятно, в будущих циклах без смены среды
  выполнения или альтернативного канала (например, владелец выполняет
  команды сам по инструкции, которую подготовит Claude Code).
- Production project ID (`finapp-prod-10a83`) остаётся неподтверждённым
  технически — та же оговорка, что и в `BASELINE.md`.

## Дополнительные находки вне scope
- Сетевая изоляция этой рабочей среды (нет общего исходящего интернета,
  только git-прокси) — важный факт для планирования **всех** последующих
  задач, которые предполагают реальное взаимодействие с Firebase/GCP
  (`BASE-002`–`BASE-004`, `SEC-003` и далее). Часть этих задач физически
  не может быть выполнена автономно этой сессией и потребует либо
  ручного выполнения владельцем по подготовленной инструкции, либо смены
  среды выполнения с сетевым доступом. Стоит явно зафиксировать это как
  системное ограничение процесса, а не решать точечно на каждой задаче.

## Diff summary
```text
 docs/remediation/reports/BASE-002.md | (новый файл)
 1 file changed
```

## Следующий разрешённый пункт
Сама `BASE-002` — но её реализация заблокирована до получения
`OWNER_INPUT_REQUIRED` выше. **Не начинаю.**

---

# Часть 2 — Реализация (после получения OWNER_INPUT)

## Уточнение к Части 1

Preflight (выше) утверждал: «у этой среды нет исходящего доступа в интернет
для вызовов к Firebase/GCP API — реальное создание проекта/включение
сервисов физически не может быть выполнено». **Это было неточно.**
Фактическая проверка через `curl -sS "$HTTPS_PROXY/__agentproxy/status"`
показала: прокси **точечно блокирует** `firebase.google.com:443`
(`gateway answered 403 to CONNECT — policy denial`), но НЕ блокирует
хосты, с которых `firebase-tools` реально скачивает бинарники эмуляторов
(Google Cloud Storage). В результате Firebase Emulator Suite (Auth +
Firestore) **фактически запустился и был проверен** в этой сессии — см.
раздел D ниже. Заблокирован именно `firebase.google.com`/Console/реальный
Firebase API — то есть создание/настройка реального staging-проекта
по-прежнему требует действий владельца, но локальная разработка через
Emulator Suite технически доступна прямо сейчас, без правок сети.

## OWNER_INPUT, использованный в этой реализации

| Поле | Значение |
|---|---|
| Staging project ID | `finapp-staging` |
| Production project ID | `finapp-prod-10a83` |
| Firestore region | `europe-west3` |
| Functions region | `europe-west3` (зафиксировано, Functions-scaffold не создавался — см. ниже) |
| Billing plan | Spark |
| Auth | Email/Password enabled |
| Firestore | Standard edition, production mode, deny-all rules |
| Web app | `finapp-staging-web` |
| Firebase Web SDK config (apiKey/authDomain/storageBucket/messagingSenderId/appId) | **НЕ предоставлены** — в сообщении задачи остались как `<ВСТАВЬ ...>`. Не были придуманы/подставлены. |

Realtime Database в staging-проекте создана случайно и **не используется**
этим приложением: не добавлялся `databaseURL`, не импортировался
`firebase/database`, не настраивался Realtime Database Emulator. Это
задокументированный неиспользуемый ресурс — его удаление или проверку
deny-all правил должен выполнить владелец отдельно, вне этой задачи.

## Что создано

| Файл | Назначение |
|---|---|
| `.firebaserc` | Явные aliases `staging`→`finapp-staging`, `production`→`finapp-prod-10a83`. Без `default` — CLI никогда не выберет проект неявно. |
| `firebase.json` | Только `firestore` (rules/indexes путь) + `emulators` (auth :9099, firestore :8080, ui :4000, `singleProjectMode: true`). Без `functions`, без `database` (Realtime DB). |
| `firestore.rules` | Deny-all baseline для эмулятора. В файле явный комментарий: это НЕ production Rules, не разворачивался. |
| `firestore.indexes.json` | Пустой (`{"indexes": [], "fieldOverrides": []}`). |
| `src/lib/firebaseEnv.ts` | Чистая функция `resolveFirebaseEnv()` — валидация обязательных переменных и допустимых комбинаций `VITE_APP_ENV`/`VITE_USE_FIREBASE_EMULATORS`/`projectId`. Без побочных эффектов, без чтения `import.meta.env` напрямую (принимает источник параметром) — можно тестировать изолированно. |
| `src/lib/firebase.ts` (изменён) | Использует `resolveFirebaseEnv()`; подключает Auth/Firestore Emulator только при `VITE_USE_FIREBASE_EMULATORS=true`, один раз (guard на `globalThis`, переживает Vite HMR); `ignoreUndefinedProperties: true` сохранён; без `databaseURL`, без импорта `firebase/database`. |
| `scripts/verify-staging-env.mjs` | Preflight-guard для `npm run build:staging`. Читает `.env`/`.env.staging`/`.env.staging.local` (приоритет как у Vite), затем `process.env` поверх (для точечных негативных тестов без правки файлов). Переиспользует `resolveFirebaseEnv()` — не дублирует логику. Никогда не печатает значения переменных. |
| `src/components/layout/EnvironmentBanner.tsx` | Баннер `STAGING — ТЕСТОВАЯ СРЕДА`, обычный текст (не только цвет), `role="status"`, своя полоса в потоке документа. |
| `src/components/layout/Layout.tsx` (изменён) | Рендерит `EnvironmentBanner` между Header и Sidebar/main-областью — только при `VITE_APP_ENV === 'staging'`, только на защищённых страницах (внутри `Layout`, т.е. после `ProtectedRoute`), не перекрывает навигацию. |
| `.env.example` (изменён) | Добавлены `VITE_APP_ENV`, `VITE_USE_FIREBASE_EMULATORS`, `VITE_FIREBASE_AUTH_EMULATOR_HOST`, `VITE_FIREBASE_FIRESTORE_EMULATOR_HOST` с пояснениями. Только плейсхолдеры. |
| `.gitignore` (изменён) | Добавлены `.env.local`, `.env.*.local`, `firebase-debug*.log`, `firestore-debug.log`, `ui-debug.log`, `.firebase/`, `firebase-export/`, `emulator-data/`, `.secret.local`, `functions/.secret.local`. Существующие правила не удалялись. |
| `package.json` (изменён) | Добавлены scripts `build:staging` и `firebase:emulators`. Зависимости и lockfile не менялись — `firebase-tools` не добавлен как devDependency, используется через `npx --yes firebase-tools` (портируемо, без изменения `package-lock.json`). |

### Локальные файлы (созданы, НЕ в Git)

- `.env.staging.local` — `VITE_APP_ENV=staging`, `VITE_USE_FIREBASE_EMULATORS=false`,
  `VITE_FIREBASE_PROJECT_ID=finapp-staging` заполнены реальными
  OWNER_INPUT-значениями. Пять полей Firebase Web SDK config оставлены
  закомментированными с меткой `TODO(OWNER_ACTION_REQUIRED)` — реальные
  значения не были предоставлены, придуманные значения **не вписывались**.
  Содержимое файла в этот отчёт не копируется (по требованию задачи).
- `.env.development.local` — `VITE_APP_ENV=development`,
  `VITE_USE_FIREBASE_EMULATORS=true`, `VITE_FIREBASE_PROJECT_ID=demo-finapp`,
  адреса эмуляторов `127.0.0.1:9099`/`127.0.0.1:8080`. Остальные обязательные
  поля заполнены безопасными фиктивными значениями, годными только для
  `projectId=demo-finapp` (официальная Firebase-конвенция «demo-» проектов —
  реальных сетевых вызовов не происходит, поэтому это не секреты). Содержимое
  файла в отчёт не копируется.
- `.env.production.local` — **не создавался и не заполнялся**, как и
  требовала задача. Production-конфигурация в этой задаче не
  предоставлялась и не копировалась из staging.

## Cloud Functions — сознательно не создавались

**ОБНОВЛЕНО В «ЧАСТЬ 4»: статус изменён на `DEFERRED_TO_SEC-003_BY_OWNER`** —
владелец формально принял решение отложить создание/развёртывание Cloud
Functions до `SEC-003`, Blaze сейчас не подключается (см. «Часть 4», раздел
«Решения владельца»). Текст ниже, помечавший статус как
`BLOCKED_OWNER_DECISION` (ожидание решения), оставлен для истории — решение
уже получено.

**Статус (раунд 1, история): `BLOCKED_OWNER_DECISION`.** Не отмечаю этот пункт выполненным —
`REMEDIATION_PLAN.md` перечисляет Cloud Functions среди сервисов staging-
окружения (действие 2), и решение по Blaze/billing принадлежит владельцу,
не этой сессии (см. `CLAUDE.md`, раздел 5 — production/staging cloud-
операции без явного разрешения запрещены). Ниже — обоснование, почему это
не блокирует остальные критерии `BASE-002`, но сам пункт остаётся
`BLOCKED_OWNER_DECISION`, а не выполненным.

Задача явно разрешала не создавать scaffold, если он «создаёт
несоразмерный diff или не нужен для критериев BASE-002» — этим и
воспользовался. Обоснование:

- ни один критерий приёмки `BASE-002` из `REMEDIATION_PLAN.md` не требует
  Cloud Functions (`staging никогда не обращается к production
  Firestore/Auth`, `разные project ID`, `Emulator Suite для Firestore/Auth
  запускается локально`, `секреты отсутствуют в Git` — всё это уже
  выполнено без Functions);
- добавление `functions/` потребовало бы отдельный `package.json`,
  `tsconfig.json`, новые зависимости и, вероятно, изменения
  `package-lock.json` — то есть заметно больший diff и риск, не
  оправданный текущим критерием;
- реальный Cloud Functions deployment запрещён этой задачей в любом
  случае (Blaze/billing — отдельное решение владельца), поэтому даже
  созданный scaffold не мог бы быть развёрнут и проверен end-to-end сейчас.

**Функциональный вывод:** Cloud Functions deployment не выполнялся и не
мог быть выполнен (нет scaffold, нет Blaze). Это ограничение, а не
скрытая часть работы. Регион `europe-west3` зафиксирован для будущего
использования (см. таблицу OWNER_INPUT выше).

## Как запустить приложение

### С Firebase Emulator Suite (development)
```bash
npm run firebase:emulators   # терминал 1 — Auth :9099, Firestore :8080, UI :4000
npm run dev                  # терминал 2 — читает .env.development.local (Vite mode=development)
```
Проверить, что реально используется `demo-finapp`, а не staging/production:
в консоли браузера/логах эмулятора не должно быть обращений к
`*.googleapis.com` — все запросы идут на `127.0.0.1:9099`/`127.0.0.1:8080`.

### Staging build
```bash
npm run build:staging
```
Сначала выполняется `scripts/verify-staging-env.mjs` (без сборки, без сети) —
проверяет `VITE_APP_ENV=staging`, `projectId=finapp-staging`, отклоняет
production ID, требует все 6 обязательных `VITE_FIREBASE_*`. Только при
успехе запускаются `tsc -b` и `vite build --mode staging`.

**Сейчас эта команда завершается ошибкой** (см. проверки ниже) — реальные
Firebase Web SDK значения для `finapp-staging-web` не предоставлены. Это
ожидаемое, честно воспроизводимое поведение, а не баг.

### Как проверить фактический project ID в собранном staging-бандле
```bash
npm run build:staging   # после того как .env.staging.local будет дополнен реальными значениями
grep -c "finapp-staging" dist/assets/*.js       # ожидается: >0
grep -c "finapp-prod-10a83" dist/assets/*.js    # ожидается: 0 (см. ниже, почему это гарантировано архитектурно)
```

### Как остановить Emulator Suite
`Ctrl+C` в терминале, где запущен `npm run firebase:emulators` (или
`kill <pid>` процесса `firebase emulators:start`, а также дочернего
`java ... cloud-firestore-emulator...jar`, если родительский процесс не
успел закрыть его сам — так и произошло при тестировании ниже, см. раздел D).

## Обязательные проверки

### A. Репозиторий и env

| Проверка | Результат |
|---|---|
| `git status --short` | PASS — чисто/только ожидаемые изменения на каждом шаге |
| `git diff --check` | PASS (exit 0) |
| `git ls-files '.env*'` | PASS — только `.env.example` |
| `git check-ignore -v .env.staging.local` | PASS — `.gitignore:17:.env.*.local` |
| `git check-ignore -v .env.development.local` | PASS — `.gitignore:17:.env.*.local` |
| Скан staged diff на `AIzaSy...`-паттерн реального ключа | PASS — не найдено (было одно ложное срабатывание на текст `VITE_FIREBASE_API_KEY` — это имя переменной в коде, не значение) |
| Production project ID в `.env.staging.local` | PASS — `grep -c finapp-prod-10a83 .env.staging.local` → 0 |

### B. Сборка

| Проверка | Результат |
|---|---|
| `npm ci` | PASS |
| `npm run lint` | PASS — 0 ошибок, 0 предупреждений |
| `npm run build` (обычный production build, без изменений поведения) | PASS |
| `npm run build:staging` против реального `.env.staging.local` | **FAIL, ожидаемо** — «отсутствуют обязательные переменные окружения: VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_STORAGE_BUCKET, VITE_FIREBASE_MESSAGING_SENDER_ID, VITE_FIREBASE_APP_ID» — потому что реальные значения не предоставлены. `dist/` не создаётся (guard остановил до `tsc`/`vite`). |
| `npm run build:staging` с полным набором тестовых фиктивных значений (через CLI env, файл не менялся) | PASS — сборка проходит, `dist/` создан |
| Скан `dist/` (из позитивного теста) на `finapp-prod-10a83` | PASS — **0 вхождений** (после рефакторинга — см. ниже) |
| Скан `dist/` на `finapp-staging` | PASS — 1 вхождение (активный `projectId` в собранном бандле) |
| Скан `dist/` на текст `STAGING — ТЕСТОВАЯ СРЕДА` | PASS — найден дословно |

**Важная находка и исправление в процессе работы:** первая версия
`src/lib/firebaseEnv.ts` хранила `PRODUCTION_PROJECT_ID = 'finapp-prod-10a83'`
как экспортируемую константу для явного специфического сообщения об
ошибке. Поскольку этот модуль импортируется в `src/lib/firebase.ts` и
попадает в клиентский бандл, эта строка **физически присутствовала**
в `dist/*.js` и находилась обычным `grep` — формально нарушая критерий
«скан dist/ на finapp-prod-10a83 → NOT FOUND», хотя реальный
security-смысл (staging не может аутентифицироваться в production) был
соблюдён полностью. Исправлено: специфическая проверка с явным
упоминанием production ID осталась только в
`scripts/verify-staging-env.mjs` (Node-скрипт, никогда не попадает в
`dist/`), а клиентский `firebaseEnv.ts` использует только строгий
allowlist (`projectId должен точно равняться "finapp-staging"`), который
отклоняет production ID (и любой другой) не называя его по значению.
Это обнаружено и исправлено самостоятельно, до передачи на ревью — см.
diff `src/lib/firebaseEnv.ts` в этом коммите (одна логическая правка).

### C. Негативные проверки (все — без изменения `.env.staging.local`, через CLI env override)

| Сценарий | Результат |
|---|---|
| `VITE_FIREBASE_PROJECT_ID=finapp-prod-10a83` + остальные 5 полей заполнены | FAIL, ожидаемо: «VITE_FIREBASE_PROJECT_ID равен production project ID (finapp-prod-10a83) — staging build не может использовать production Firebase project» |
| Ровно одна обязательная переменная отсутствует (`VITE_FIREBASE_APP_ID`), остальные 4 заполнены | FAIL, ожидаемо: «отсутствуют обязательные переменные окружения: VITE_FIREBASE_APP_ID» — названа именно и только она |
| Полный валидный набор (тестовые фиктивные значения, `projectId=finapp-staging`) | PASS — сборка проходит целиком |
| `.env.staging.local` после всех трёх тестов | Не изменён — подтверждено `git status --short .env.staging.local` после каждого теста |

### D. Emulator Suite

| Проверка | Результат |
|---|---|
| `java -version` | PASS — OpenJDK 21.0.10 |
| Firebase CLI version | PASS — `15.23.0` (через `npx --yes firebase-tools`, не установлен глобально) |
| Запуск `firebase emulators:start --project demo-finapp --only auth,firestore` | **PASS** — вопреки ожиданиям из preflight (см. «Уточнение к Части 1» выше), бинарник `cloud-firestore-emulator-v1.21.0.jar` и `ui-v1.15.0.zip` успешно скачались, все эмуляторы поднялись за ~6 секунд |
| Emulator UI на :4000 | PASS — `curl http://127.0.0.1:4000/` → HTTP 200 |
| Auth Emulator на :9099 | PASS — `curl http://127.0.0.1:9099/emulator/v1/projects/demo-finapp/config` → HTTP 200, вернул реальный JSON конфиг |
| Firestore Emulator на :8080 | PASS — `curl http://127.0.0.1:8080/` → HTTP 200 |
| Лог содержит `demo-finapp` | PASS — подтверждено `grep` по логу emulators:start |
| Безопасная остановка Emulator Suite | PASS, с оговоркой: `kill` родительского `npx`-процесса не сразу докаскадировал до дочерних `firebase`/`java` процессов (типичное поведение npx-обёртки) — потребовался дополнительный `pkill -f "firebase emulators:start"` + `pkill -f cloud-firestore-emulator`. После этого все процессы завершены. |
| Порты освобождены после остановки | PASS — 4000/9099/8080/9150/4400/4500 все свободны, подтверждено проверкой `/dev/tcp/127.0.0.1/<port>` |
| Отсутствие orphan-процессов | PASS — `pgrep` после остановки ничего не находит |
| Побочный артефакт `firestore-debug.log` в корне репозитория | Обнаружен и удалён вручную после проверки на отсутствие секретов (файл уже покрыт правилом `.gitignore`, в `git status` не отображался и до удаления) |

Раздел D — полностью **PASS**, не PARTIAL, как можно было бы ожидать из
preflight-отчёта (см. «Уточнение к Части 1»).

### E. Код

| Проверка | Результат |
|---|---|
| Импорт `firebase/database` где-либо в `src/` | PASS — не найден |
| `databaseURL` где-либо в `src/` | PASS — не найден |
| Подключение к Realtime Database | PASS — отсутствует (не импортирован сам SDK) |
| `database` в `firebase.json` (Realtime DB Emulator) | PASS — отсутствует |
| Подключение к эмуляторам защищено от повторного вызова | PASS (по коду) — `globalThis.__FINAPP_EMULATORS_CONNECTED__` флаг в `src/lib/firebase.ts`, переживает Vite HMR (флаг на `globalThis`, а не в замыкании модуля, которое HMR может пересоздать); прямого автоматического теста HMR-сценария в браузере не проводилось (нет тестовой инфраструктуры/браузерного окружения с реальным dev-сервером в этой проверке) — оценка сделана по коду, а не по live-наблюдению |

## Критерии готовности — сверка

**ВАЖНО (исправлено в «Часть 3» по замечанию независимого ревью №1):**
строка ниже — «staging build не может использовать production Auth/Firestore
(доказано негативным тестом C)» — сформулирована **неточно** и оставлена
здесь только для истории (не редактирую задним числом). Негативный тест C
доказывал только несовпадение **projectId**. Он НЕ доказывал и не мог
доказывать изоляцию Firebase **Authentication**, потому что `apiKey`
идентифицирует Firebase-проект для Auth API независимо от `projectId`, и
конфигурация с verified staging `projectId`, но `apiKey` от другого (в т.ч.
production) проекта прошла бы этот тест. Корректная, раздельная
Firestore/Auth сверка — в «Часть 3», раздел «Критерии готовности — сверка
(обновлено)».

- [x] staging project ID отличается от production (`finapp-staging` ≠ `finapp-prod-10a83`, зафиксировано в `.firebaserc` и `firebaseEnv.ts`)
- [x] ~~staging build не может использовать production Auth/Firestore (доказано негативным тестом C)~~ — **см. исправление выше и «Часть 3»: доказан только projectId, не полная Auth-конфигурация**
- [x] emulator development использует только `demo-finapp` (доказано реальным запуском Emulator Suite, раздел D)
- [x] локальные env-файлы не отслеживаются Git (раздел A)
- [x] реальные config values отсутствуют в Git и в этом отчёте (не предоставлялись владельцем; в отчёт не копировались)
- [x] staging визуально отличается от production (баннер, подтверждено в собранном бандле)
- [x] приложение не использует Realtime Database (раздел E)
- [x] Firebase deploy не выполнялся (не запускалась ни разу команда `firebase deploy`)
- [ ] Cloud Functions — **см. «Часть 3»: статус `BLOCKED_OWNER_DECISION`, не отмечаю выполненным**
- [x] обязательные проверки честно зафиксированы (включая найденную и исправленную проблему с production ID в бандле, и уточнение неверного вывода preflight по сети)

## Известные ограничения

- Реальный staging Firebase project **функционально не проверен end-to-end**
  (нет проверенного `npm run build:staging` с реальными данными, нет
  ручного входа через staging Auth/Firestore) — блокировано отсутствием
  реальных SDK-значений от владельца. Как только они будут добавлены в
  `.env.staging.local` (строки уже подготовлены, только раскомментировать
  и заполнить), `npm run build:staging` должен пройти без дополнительных
  правок кода — это было доказано тем же самым кодом с тестовыми
  фиктивными значениями.
- HMR-сценарий повторного подключения к эмуляторам проверен только по
  коду (globalThis-guard), не live-наблюдением в браузере с `npm run dev`.
- Production Firestore Rules по-прежнему не получены и не проверены
  (`BASE-004`, ещё не выполнена) — `firestore.rules` в этом репозитории
  однозначно помечен как emulator/staging-baseline, не production.
- Realtime Database в staging-проекте существует и не удалена — вне
  контроля этой сессии (нет доступа к Firebase Console), задокументирована
  как отдельное действие владельца.

## OWNER_ACTION_REQUIRED

**См. также «Часть 4» (актуальный, самый свежий раунд)** — список ниже
описывает состояние на момент раунда 2 ревью; в «Часть 4» зафиксировано,
что пункты 1–2 по-прежнему `OWNER_ACTION_REQUIRED` (эта сессия не может их
восполнить), пункт 3 (Realtime Database) остаётся отдельным
`OWNER_ACTION_REQUIRED` по прямому указанию владельца (не удалять/не
изменять), а пункт 4 (Cloud Functions) разрешён владельцем как
`DEFERRED_TO_SEC-003_BY_OWNER`.

1. **Предоставить реальные значения Firebase Web SDK config** для
   `finapp-staging-web` (apiKey, authDomain, storageBucket,
   messagingSenderId, appId) — Firebase Console → Finapp Staging →
   Settings → General → Your apps → finapp-staging-web → SDK setup and
   configuration → Config. Вставить их в уже подготовленные закомментированные
   строки в `.env.staging.local` (локально, не в Git) и раскомментировать.
2. **Вычислить и предоставить `STAGING_FIREBASE_CONFIG_FINGERPRINT`**
   (новое, добавлено по замечанию №1 независимого ревью) — после получения
   (1), вычислить SHA-256 fingerprint утверждённого staging Web SDK config:
   ```bash
   node -e "
   import('./scripts/lib/firebaseConfigFingerprint.mjs').then(({computeFirebaseConfigFingerprint}) => {
     console.log(computeFirebaseConfigFingerprint({
       apiKey: '<реальный apiKey finapp-staging-web>',
       authDomain: '<реальный authDomain>',
       projectId: 'finapp-staging',
       storageBucket: '<реальный storageBucket>',
       messagingSenderId: '<реальный messagingSenderId>',
       appId: '<реальный appId>',
     }))
   })
   "
   ```
   Полученное 64-символьное hex-значение сохранить:
   - локально — как `STAGING_FIREBASE_CONFIG_FINGERPRINT=<значение>` в
     `.env.staging.local` (без префикса `VITE_`, не в Git);
   - в CI — как GitHub Secret с тем же именем, без префикса `VITE_`, в
     отдельном шаге `env:` (не как build-arg `VITE_*`).
   Без этого значения `npm run build:staging` завершается `BLOCKED`
   (проверено — см. «Часть 3»).
3. **Решить судьбу случайно созданной Realtime Database** в
   `finapp-staging` — удалить через Firebase Console, либо явно
   подтвердить и настроить её собственные deny-all правила, если удаление
   почему-то нежелательно. Приложение её не использует и не будет
   использовать без отдельного решения.
4. **Решение по Blaze/billing и Cloud Functions** (`BLOCKED_OWNER_DECISION`)
   — до этого решения Cloud Functions scaffold сознательно не создавался;
   когда решение будет принято, потребуется отдельная задача (вне
   `BASE-002`, вероятно `SEC-003`).
5. После получения (1) и (2) — подтвердить и, если нужно, инициировать
   независимое ревью реального `npm run build:staging` против настоящего
   staging-проекта (эта сессия проверила логику только на синтетических
   тестовых значениях, включая полный fingerprint-механизм — см. «Часть 3»).

---

# Часть 3 — Исправления по независимому ревью (CHANGES REQUIRED / BLOCKED)

## Branch / commit

- branch: `remediation/BASE-002-staging` (та же ветка, новый коммит поверх `bc1e589`)
- base SHA (эта итерация): `bc1e589` (последний коммит «Часть 2»)
- result SHA: см. `git rev-parse HEAD` на ветке после коммита этого исправления
  (та же самоссылочная оговорка, что и в «Часть 1»/«Часть 2» — итоговый SHA
  не встраивается в файл, который этот же коммит добавляет)

## Соответствие ветки/PR инструкции

Работа продолжена **в существующей ветке** `remediation/BASE-002-staging` и
**в существующем Draft PR №2** — новая ветка и новый PR не создавались,
`git branch --show-current` подтверждён равным `remediation/BASE-002-staging`
перед началом работы. `BASE-003` не начиналась. PR не мёржился.

## Сводка замечаний ревью и что изменено

### Замечание №1 (КРИТИЧЕСКОЕ) — проверка только projectId не гарантирует изоляцию Auth

**Признано корректным без оговорок.** Прежняя реализация (`resolveFirebaseEnv`)
проверяла только `VITE_FIREBASE_PROJECT_ID` — конфигурация с верным staging
`projectId`, но `apiKey` от другого (в т.ч. production) проекта, прошла бы
эту проверку. Формулировки в «Часть 2», утверждавшие «staging build не может
использовать production Auth», были **переоценкой** — это исправлено явной
пометкой в тексте «Часть 2» (не переписывался задним числом, только помечен)
и корректной сводкой ниже.

**Что сделано:**

- Добавлен `scripts/lib/firebaseConfigFingerprint.mjs` — Node-only модуль
  (`node:crypto`, не импортируется из `src/`, никогда не бандлится),
  вычисляющий SHA-256 hex-дайджест детерминированной нормализованной строки
  из **всех шести** полей конфигурации (`apiKey`, `authDomain`, `projectId`,
  `storageBucket`, `messagingSenderId`, `appId`) в фиксированном порядке.
- Добавлен `scripts/lib/stagingPreflight.mjs` — чистая функция
  `runStagingPreflight(source)`, объединяющая структурную проверку
  (`resolveFirebaseEnv`, projectId/обязательные поля) и fingerprint-проверку.
  Используется и реальным CLI (`scripts/verify-staging-env.mjs`), и
  воспроизводимым self-test (`scripts/test-staging-preflight.mjs`) — один
  источник правды для обоих.
- Ожидаемый fingerprint читается из переменной **`STAGING_FIREBASE_CONFIG_FINGERPRINT`**
  — без префикса `VITE_` (требование ревью соблюдено буквально), поэтому
  Vite физически не может включить её в `import.meta.env`/клиентский бандл
  (Vite экспонирует клиенту только `VITE_*`-переменные — это встроенное
  поведение Vite, не полагающееся на дисциплину разработчика). Источник —
  `.env.staging.local` (локально, вне Git) либо `process.env` напрямую
  (для GitHub Secret в CI).
- **Отсутствие** `STAGING_FIREBASE_CONFIG_FINGERPRINT` → `runStagingPreflight`
  возвращает `{ ok: false, blocked: true, reason: ... }` — CLI-скрипт
  завершается кодом `1` с текстом, явно содержащим слово «BLOCKED».
- **Несовпадение** вычисленного и ожидаемого fingerprint → `{ ok: false }`
  (не `blocked`, т.к. это не отсутствие данных, а прямое несоответствие) —
  тоже `FAIL`, сообщение не называет реальные значения полей.
- Ни один реальный секрет не коммитится: fingerprint — однонаправленный
  SHA-256 (необратим), но даже он не хранится в Git — только имя переменной
  окружения в `.env.example` (закомментированная строка-плейсхолдер).

**Воспроизводимые проверки (требование ревью — все выполнены):**

1. Программный self-test `scripts/test-staging-preflight.mjs` — 5 сценариев
   ровно по списку ревью, вызывает `runStagingPreflight()` напрямую с
   синтетическими (вымышленными) конфигурациями, без файлов/сети/реальных
   секретов. Добавлен как `npm run test:staging-preflight`.
2. Дополнительно каждый сценарий воспроизведён **end-to-end через реальный
   CLI-вход** `node scripts/verify-staging-env.mjs` с синтетическими
   значениями через переменные окружения — фактический вывод ниже (раздел
   «Фактический вывод команд»).

### Замечание №2 — несовместимость с Node.js (`--experimental-strip-types`)

**Исправлено.** `--experimental-strip-types` (Node ≥22.6) полностью удалён.
Логика вынесена из TypeScript в обычный JavaScript:

- `src/lib/firebaseEnvCore.mjs` — вся прежняя логика `firebaseEnv.ts`
  (structural validation, projectId allowlist) перенесена сюда как plain JS
  (без TS-синтаксиса). Импортируется и клиентским кодом (через тонкую
  TS-обёртку), и Node-скриптами в `scripts/` напрямую — без какого-либо
  TS-loader'а.
- `src/lib/firebaseEnvCore.d.mts` — типы для `.mjs`-модуля (стандартное
  соглашение TypeScript: `.mjs` + соседний `.d.mts`).
- `src/lib/firebaseEnv.ts` — теперь только тонкий типизированный
  re-export из `./firebaseEnvCore.mjs` (не содержит логики).
- `scripts/verify-staging-env.mjs`, `scripts/lib/stagingPreflight.mjs`,
  `scripts/lib/firebaseConfigFingerprint.mjs`, `scripts/test-staging-preflight.mjs`
  — все обычный JavaScript (`.mjs`), не требуют флагов Node.
- `package.json`: `"build:staging": "node scripts/verify-staging-env.mjs && tsc -b && vite build --mode staging"`
  — без `--experimental-strip-types`.
- Node-версия GitHub workflow (`deploy.yml`) **не менялась** — как и
  требовало замечание («её фиксация относится к `BASE-006`»); подтверждено
  `git diff` не затрагивает `.github/workflows/`.
- Проверено: `npx tsc -b --pretty false` резолвит типы `.mjs` через
  `.d.mts` без ошибок (см. «Фактический вывод команд»); эта версия Node в
  контейнере (`v22.22.2`) технически поддерживала бы
  `--experimental-strip-types`, но сам факт того, что flag больше нигде не
  используется, подтверждён `grep -r "experimental-strip-types"` → 0
  вхождений в отслеживаемых файлах.

### Замечание №3 — закрепить Firebase CLI

**Исправлено.** `firebase-tools` добавлен в `devDependencies` с точной
(без caret/tilde) версией `15.24.0` (`engines.node: >=20.0.0 || >=22.0.0 ||
>=24.0.0` — совместимо с Node 20 в CI). `package-lock.json` обновлён через
`npm install --save-dev --save-exact firebase-tools@15.24.0` (не
редактировался вручную). `package.json`:
`"firebase:emulators": "firebase emulators:start --project demo-finapp"`
— без `npx --yes`; npm-скрипты автоматически добавляют `node_modules/.bin`
в `PATH`, поэтому `firebase` резолвится в локальный закреплённый бинарник.
Проверено: `npx --no-install firebase --version` → `15.24.0` (флаг
`--no-install` запрещает npx скачивать что-либо — резолвится только то, что
уже установлено локально); `which firebase` на хосте не находит глобального
бинарника — используется исключительно закреплённая devDependency.

### Замечание №4 — статус и утверждения в отчёте

**Исправлено:**

- Верхний блок «Итоговый статус» переписан — явно указывает, что первый
  раунд ревью вернул `CHANGES REQUIRED / BLOCKED`, перечисляет все шесть
  замечаний и текущие открытые пробелы.
- В «Часть 2» строка «staging build не может использовать production
  Auth/Firestore (доказано негативным тестом C)» помечена как переоценённая
  (не отредактирована задним числом — оставлена видимой с перечёркиванием
  и пояснением) в разделах «Критерии готовности — сверка».
- Ниже — обновлённая, раздельная Firestore/Auth сверка критериев (см.
  «Критерии готовности — сверка (обновлено)»).
- Реальный `npm run build:staging` и Auth/Firestore end-to-end по-прежнему
  явно `BLOCKED` — не заявляю обратного нигде в отчёте.
- Cloud Functions — статус `BLOCKED_OWNER_DECISION` (см. замечание №5 ниже
  и правку в разделе «Cloud Functions — сознательно не создавались»).

### Замечание №5 — Cloud Functions

**Не создавались и не разворачивались** — как и до этого раунда ревью
(факт не изменился), но теперь статус явно зафиксирован как
`BLOCKED_OWNER_DECISION` в заголовке соответствующего раздела «Часть 2» и в
таблице критериев ниже, а не подразумевался как «выполнено, потому что не
требуется». Решение по Blaze/billing остаётся за владельцем; отдельная
задача (вероятно, часть `SEC-003`) потребуется после этого решения.

### Замечание №6 — повторные проверки

Выполнены все перечисленные проверки — фактический вывод см. ниже.

## Критерии готовности — сверка (обновлено)

Раздельно, как и требует замечание №4:

| Критерий | Статус | Обоснование |
|---|---|---|
| staging/production — разные project ID | **PASS** | `finapp-staging` ≠ `finapp-prod-10a83`, `.firebaserc` + строгий allowlist в `firebaseEnvCore.mjs` |
| staging Firestore изолирован от production | **PASS** (доказано) | Разные `projectId` + структурная проверка `resolveFirebaseEnv`; Firestore SDK использует `projectId` напрямую для маршрутизации — этого достаточно для Firestore |
| staging Firebase Authentication изолирован от production | **PASS (структурно), реальный E2E — BLOCKED** | SHA-256 fingerprint всех 6 полей конфигурации (включая `apiKey`, используемый Auth API) проверяется и доказан на синтетических данных (5/5 сценариев); реальная проверка против настоящего `finapp-staging-web` API key невозможна, пока владелец не предоставил (1) реальные SDK-значения и (2) `STAGING_FIREBASE_CONFIG_FINGERPRINT` |
| emulator development использует только `demo-finapp` | **PASS** | Реальный запуск Emulator Suite, раздел D «Часть 2» (без изменений в этом раунде) |
| локальные env-файлы не отслеживаются Git | **PASS** | `git ls-files '.env*'` → только `.env.example` |
| секреты (реальные config values, fingerprint) отсутствуют в Git | **PASS** | Скан diff/staged на `AIzaSy...`, `private_key`, `BEGIN...KEY`, `client_secret`, `service account` → ничего в реальном коде/конфигах (единственное совпадение — сам этот отчёт, цитирующий шаблон скана как документацию; при скане с исключением `docs/remediation/reports/BASE-002.md` — 0 совпадений); `.env.example` содержит только имя переменной без значения |
| staging визуально отличается от production | **PASS** | Баннер, без изменений в этом раунде |
| приложение не использует Realtime Database | **PASS** | Без изменений в этом раунде |
| Firebase deploy | **PASS (не выполнялся)** | Ни разу не запускалась команда `firebase deploy` |
| Node.js совместимость preflight-скрипта | **PASS** | `--experimental-strip-types` удалён; все `scripts/**/*.mjs` — обычный JS, работают на Node ≥20 |
| Firebase CLI закреплён | **PASS** | `firebase-tools@15.24.0` (точная версия) в `devDependencies`, `package-lock.json` обновлён |
| Cloud Functions | **BLOCKED_OWNER_DECISION** | Требует решения владельца по Blaze/billing; scaffold сознательно не создавался |
| Реальный `npm run build:staging` против настоящего staging-проекта | **BLOCKED** | Ждёт (1) реальных SDK-значений и (2) `STAGING_FIREBASE_CONFIG_FINGERPRINT` от владельца |
| Реальная сквозная проверка Auth/Firestore staging | **BLOCKED** | Та же причина |

## Фактический вывод команд (эта итерация)

### Обязательные проверки

```text
$ npm ci
added 601 packages, and audited 913 packages in ~28s
14 vulnerabilities (1 low, 10 moderate, 3 high) — npm audit fix доступен,
не в scope BASE-002 (см. IMP-002 по xlsx отдельно; рост числа уязвимостей —
целиком за счёт транзитивных зависимостей firebase-tools, ожидаемо для
такого CLI-пакета)

$ npm run lint
> eslint .
(без вывода — 0 ошибок)

$ npx tsc -b --pretty false
(без вывода — типы .mjs через .d.mts резолвятся корректно)

$ npm run build
> tsc -b && vite build
✓ 2370 modules transformed
dist/assets/index-*.js  1,882.68 kB │ gzip: 541.75 kB
✓ built in ~1.2s

$ grep -rc "finapp-prod-10a83" dist/assets/*.js   → 0
$ grep -rc "STAGING_FIREBASE_CONFIG_FINGERPRINT" dist/assets/*.js   → 0
(dist/ удалён после проверки — не коммитится, покрыт .gitignore)

$ git diff --check origin/remediation/main..HEAD -- .
(exit 0 — без конфликтов пробелов/окончаний строк)

$ git ls-files '.env*'
.env.example

$ git diff --cached | grep -E "AIzaSy[A-Za-z0-9_-]{25,}"
none found

$ git diff --cached | grep -iE "private_key|BEGIN (RSA|PRIVATE) KEY|client_secret|service.?account"
(1 совпадение — но это сам текст этого отчёта, цитирующий шаблон скана как
документацию, не секрет; после исключения самого файла отчёта:)
$ git diff --cached -- . ':!docs/remediation/reports/BASE-002.md' | grep -iE "private_key|BEGIN (RSA|PRIVATE) KEY|client_secret|service.?account"
none found in actual code/config changes
```

### Воспроизводимые preflight-сценарии (замечание №1)

```text
$ npm run test:staging-preflight
✓ PASS — Валидная синтетическая конфигурация + совпадающий fingerprint
✓ PASS — staging projectId, но несовпадающий API key (fingerprint не совпадёт)
✓ PASS — Отсутствующий ожидаемый fingerprint (переменная не задана)
✓ PASS — production projectId вместо staging
✓ PASS — Отсутствующее обязательное поле (VITE_FIREBASE_APP_ID)

✓ Все 5 сценариев staging-preflight прошли как ожидалось.
```

То же самое, независимо, через реальный CLI-вход (`scripts/verify-staging-env.mjs`),
с синтетическими значениями через переменные окружения (ни один файл не менялся):

```text
# Позитивный сценарий (валидная синтетическая конфигурация + совпадающий fingerprint)
$ VITE_APP_ENV=staging VITE_FIREBASE_API_KEY=test-fixture-... \
  ... STAGING_FIREBASE_CONFIG_FINGERPRINT=<64-hex> node scripts/verify-staging-env.mjs
✓ build:staging preflight OK — VITE_APP_ENV=staging, projectId=finapp-staging,
  все обязательные переменные заданы, SHA-256 fingerprint конфигурации
  совпадает с ожидаемым staging-набором
exit: 0

# Негативный: отсутствует STAGING_FIREBASE_CONFIG_FINGERPRINT
✖ build:staging preflight FAILED — BLOCKED
  Переменная окружения STAGING_FIREBASE_CONFIG_FINGERPRINT не задана — ...
exit: 1

# Негативный: staging projectId верный, но apiKey от другого проекта → fingerprint mismatch
✖ build:staging preflight FAILED
  SHA-256 fingerprint конфигурации Firebase Web SDK ... не совпадает
  с ожидаемым staging-fingerprint. ... apiKey может принадлежать другому
  проекту, включая production, даже если projectId указан верно.
exit: 1

# Негативный: production projectId
✖ build:staging preflight FAILED
  Firebase config: staging-окружение (VITE_APP_ENV=staging) допускает
  только projectId="finapp-staging" — обнаружен другой projectId
exit: 1

# Негативный: отсутствует обязательное поле VITE_FIREBASE_APP_ID
✖ build:staging preflight FAILED
  Firebase config: отсутствуют обязательные переменные окружения: VITE_FIREBASE_APP_ID
exit: 1
```

Ни одно из этих значений (fingerprint, тестовый apiKey) не является
реальным секретом — все синтетические, использовались только внутри
командной строки этой сессии, не сохранялись в файлы и не коммитились.

### Firebase CLI

```text
$ npx --no-install firebase --version
15.24.0

$ which firebase
(пусто — нет глобального бинарника, используется только локальная devDependency)
```

## Diff summary (эта итерация, `bc1e589` → HEAD)

```text
 .env.example                              |    27 +
 package-lock.json                         | 12250 +++++++++++++++++++++++-----
 package.json                              |     6 +-
 scripts/lib/firebaseConfigFingerprint.mjs |    53 +
 scripts/lib/stagingPreflight.mjs          |    90 +
 scripts/test-staging-preflight.mjs        |   116 +
 scripts/verify-staging-env.mjs            |    63 +-
 src/lib/firebaseEnv.ts                    |   147 +-
 src/lib/firebaseEnvCore.d.mts             |    45 +
 src/lib/firebaseEnvCore.mjs               |   131 +
 10 files changed, 10537 insertions(+), 2391 deletions(-)
```

Рост `package-lock.json` целиком объясняется транзитивным деревом
зависимостей `firebase-tools` (замечание №3) — это единственная причина
такого большого diff в этом файле; сам пакет не редактировался вручную.

## Известные ограничения (обновлено)

Все ограничения из «Часть 2» остаются в силе (Realtime Database, HMR
только по коду, production Firestore Rules не получены — `BASE-004`).
Дополнительно к ним:

- Fingerprint-механизм проверен только на синтетических данных — реальная
  проверка против настоящего `finapp-staging-web` API key требует (1) и (2)
  от владельца (см. `OWNER_ACTION_REQUIRED`).
- `npm audit` теперь показывает 14 уязвимостей (было 7) — рост целиком за
  счёт добавления `firebase-tools` как devDependency (замечание №3, прямое
  требование ревью); не в scope `BASE-002` по существу проблемы (dev-only
  зависимость, не попадает в клиентский bundle), но зафиксировано честно.
- Self-test (`test:staging-preflight`) — не часть общей тестовой
  инфраструктуры проекта (`Vitest`/`TEST-001` ещё не выполнена) — отдельный
  Node-скрипт с ручными assert'ами, сделан целенаправленно узким для этого
  замечания ревью, не претендует на замену будущей `TEST-001`.

## Следующий разрешённый пункт

Сама `BASE-002` — по-прежнему требует независимого ревью этого раунда
исправлений. **Не начинаю `BASE-003`.**

---

# Часть 4 — Попытка фактической проверки настоящего staging (раунд 2 ревью)

## Итог раунда 2 независимого ревью

`CODE REVIEW: PASS` — весь код, структура, fingerprint-механизм,
Node-совместимость и pinned CLI приняты без замечаний. Единственное
оставшееся требование: `BASE-002: BLOCKED_REAL_STAGING_VERIFICATION` —
фактическая проверка настоящего staging Firebase (реальная сборка, реальный
Auth-вход, реальное обращение к Firestore).

## Branch / commit

- branch: `remediation/BASE-002-staging` (та же ветка, без создания новой)
- PR: существующий Draft PR №2 (без создания нового)
- base SHA (эта итерация): `f86c234ab67b7ccd04b51bd097bc08698fd5a348`
- result SHA: см. `git rev-parse HEAD` после коммита этого раздела отчёта
  (та же самоссылочная оговорка, что и в предыдущих частях)

## Решения владельца, зафиксированные в этом раунде

Переданы напрямую в тексте задачи (без отдельного `EXTERNAL_ACTION_APPROVED`/
`PRODUCTION_ACTION_APPROVED` — это не production-операция и не изменение
внешнего окружения, а решение по объёму работ):

- **Cloud Functions: `DEFERRED_TO_SEC-003_BY_OWNER`.** Формально отложено.
  Scaffold не создаётся, deploy не выполняется, Blaze/billing не
  подключается в этой сессии. Задача, которая создаст `functions/`,
  переносится на `SEC-003` (или отдельный тикет после `SEC-003`).
- **Realtime Database (случайно созданная в `finapp-staging`): не
  удаляется и не изменяется.** Остаётся отдельным `OWNER_ACTION_REQUIRED`
  (см. ниже) — эта сессия не имеет доступа к Firebase Console и не
  предпринимала попыток что-либо там менять.

## Пункт 1 — Проверка `.env.staging.local`

**Результат: файл ОТСУТСТВУЕТ в этой рабочей среде.**

```text
$ ls -la .env* 2>/dev/null
-rw-r--r-- 1 root root 4299 <дата> .env.example

$ env | grep -cE "^VITE_FIREBASE|^STAGING_FIREBASE_CONFIG_FINGERPRINT|^VITE_APP_ENV|^VITE_USE_FIREBASE_EMULATORS"
0
```

Ни файла `.env.staging.local`, ни соответствующих значений в переменных
окружения процесса — нет. Это не обход/ошибка проверки: команды выше
доказывают отсутствие, а не значения (счётчик совпадений имён переменных,
не сами значения — согласно требованию задачи никогда не печатать значения).

**Причина:** эта сессия выполняется в новом изолированном контейнере
(см. системное описание среды — контейнер эфемерный, создаётся заново на
каждый запуск). Локальные файлы `.env.staging.local`/`.env.development.local`,
упомянутые как «созданы» в «Часть 2» предыдущего раунда, существовали
только в том, предыдущем, контейнере — они никогда не коммитились (это и
требовалось), и поэтому не переживают смену рабочей среды. Это ожидаемое
следствие модели «секреты только локально, никогда в Git» — обратная
сторона того же требования безопасности.

**Согласно прямому указанию задачи** («Если файла или значений нет —
остановись со статусом OWNER_ACTION_REQUIRED... Не подставляй вымышленные
значения») — останавливаюсь здесь по существу пунктов 2, 4 (частично) и 5.
Пункты 3 (`npm ci`/lint/tsc/preflight-тесты/`git diff --check`, не
требующие реальных секретов) и часть пункта 4 (попытка `build:staging` —
корректно блокируется) — выполнены и задокументированы ниже.

### OWNER_ACTION_REQUIRED — где получить значения

Владелец должен либо:
1. Создать/скопировать `.env.staging.local` в корне репозитория (рабочая
   копия, НЕ коммитить — уже покрыт `.gitignore`) со следующими реальными
   значениями:
   ```text
   VITE_APP_ENV=staging
   VITE_USE_FIREBASE_EMULATORS=false
   VITE_FIREBASE_API_KEY=<из Firebase Console>
   VITE_FIREBASE_AUTH_DOMAIN=<из Firebase Console>
   VITE_FIREBASE_PROJECT_ID=finapp-staging
   VITE_FIREBASE_STORAGE_BUCKET=<из Firebase Console>
   VITE_FIREBASE_MESSAGING_SENDER_ID=<из Firebase Console>
   VITE_FIREBASE_APP_ID=<из Firebase Console>
   STAGING_FIREBASE_CONFIG_FINGERPRINT=<вычисляется владельцем — см. OWNER_ACTION_REQUIRED пункт 2 выше по файлу, команда там же>
   ```
   Путь получения первых шести значений: Firebase Console → проект
   `finapp-staging` → Project settings → General → Your apps →
   `finapp-staging-web` → SDK setup and configuration → Config.
2. Либо запустить эту же проверку в среде, где `.env.staging.local` уже
   подготовлен (например, локальная машина владельца) — тогда пункты 2–5
   этого задания можно выполнить в той среде по тому же протоколу, который
   описан ниже (команды идентичны, отличие только в наличии реального
   файла).

Значения не выдуманы, не подставлены и не будут подставлены — таблица
PASS/FAIL/BLOCKED ниже отражает это честно.

## Пункт 2 — Структурные проверки конфигурации

**BLOCKED** — не может быть выполнено без данных из пункта 1. В частности:
- сравнение `VITE_FIREBASE_PROJECT_ID` с `finapp-staging` — требует реального значения;
- подтверждение `emulator mode` выключен — требует реального `.env.staging.local`;
- сравнение fingerprint — требует реального `STAGING_FIREBASE_CONFIG_FINGERPRINT`;
- подтверждение «ни одно поле не из production» — требует реальных полей.

Логика этих проверок реализована, детерминирована и уже доказана 5/5
воспроизводимыми сценариями на синтетических данных (раунд 1, «Часть 3») —
но это не заменяет проверку на реальных staging-значениях, которая
запрашивается в этом раунде.

## Пункт 3 — Проверки, не требующие реальных секретов (выполнены)

```text
$ npm ci
added 601 packages, and audited 913 packages
(тот же набор известных npm audit предупреждений, что и в «Часть 3» —
без изменений в этом раунде)

$ npm run lint
> eslint .
(без вывода — 0 ошибок)

$ npx tsc -b --pretty false
(без вывода — чисто)

$ npm run test:staging-preflight
✓ PASS — Валидная синтетическая конфигурация + совпадающий fingerprint
✓ PASS — staging projectId, но несовпадающий API key (fingerprint не совпадёт)
✓ PASS — Отсутствующий ожидаемый fingerprint (переменная не задана)
✓ PASS — production projectId вместо staging
✓ PASS — Отсутствующее обязательное поле (VITE_FIREBASE_APP_ID)
✓ Все 5 сценариев staging-preflight прошли как ожидалось.

$ git diff --check origin/remediation/main..HEAD -- .
(exit 0 — чисто)
```

Все пять — **PASS**.

## Пункт 4 — Настоящая staging-сборка

```text
$ npm run build:staging
> node scripts/verify-staging-env.mjs && tsc -b && vite build --mode staging

✖ build:staging preflight FAILED
  VITE_APP_ENV должен быть точно "staging"; текущий VITE_APP_ENV не задан
  (значения переменных и fingerprint в этом сообщении не выводятся)
exit code: 1

$ ls dist
ls: cannot access 'dist': No such file or directory
```

**Фактический результат: `build:staging` корректно завершился `BLOCKED`
до запуска `tsc`/`vite build` — `dist/` не создан.** Это не дефект и не
неожиданность — это ожидаемое, требуемое поведение guard-скрипта при
отсутствии реального staging-конфига (тот же механизм, что уже был доказан
на синтетических данных в раунде 1). Настоящая staging-сборка **не была
произведена** — не существует `dist/`, который можно было бы проверить на
присутствие staging-баннера/отсутствие production ID/отсутствие
`STAGING_FIREBASE_CONFIG_FINGERPRINT`/отсутствие подключения к эмуляторам.

### Проверка готового `dist/` (пункт 4 задания) — **BLOCKED, не выполнено**

Ни один из требуемых под-пунктов не может быть проверен, потому что
`dist/` для реального staging не существует:
- наличие staging-баннера в реальном staging `dist/` — BLOCKED;
- отсутствие `finapp-prod-10a83` в реальном staging `dist/` — BLOCKED;
- отсутствие `STAGING_FIREBASE_CONFIG_FINGERPRINT` в реальном staging `dist/` — BLOCKED;
- отсутствие production Firebase-параметров в реальном staging `dist/` — BLOCKED;
- отсутствие подключения к локальным эмуляторам в реальном staging `dist/` — BLOCKED.

(Эти же пять проверок **были** выполнены в раунде 1 на **синтетическом**
`dist/`, собранном из тестовых фиктивных значений — см. «Часть 2», раздел B
и «Часть 3». Это доказывает, что механизм работает корректно, но не
заменяет проверку на реальном staging-бандле, которая тут и запрашивается.)

`dist/` (синтетический, из проверки пункта 3 «Часть 2») не публиковался и
не разворачивался ни в этом раунде, ни в предыдущих — `npm run preview`,
`firebase deploy`, любые команды публикации не вызывались.

## Пункт 5 — Настоящая проверка staging (Auth/Firestore) — **BLOCKED, не выполнено**

Ничего из перечисленного не выполнялось:
- подтверждение обращения Firebase Authentication именно к `finapp-staging` — BLOCKED (нет реальных credentials, нет инициализированного Firebase App с реальным staging config);
- тестовый вход в staging и последующее удаление тестового пользователя — BLOCKED (то же основание; кроме того, создание/удаление даже тестового Auth-пользователя было бы преждевременным без работающего реального конфига);
- подтверждение, что Firestore SDK направляет запрос именно в `finapp-staging` — BLOCKED (то же основание);
- фиксация `PERMISSION_DENIED` как ожидаемого безопасного результата — BLOCKED (нет запроса, который мог бы вернуть этот код, без реального проекта);
- Firestore Rules не разворачивались и не изменялись (условие соблюдено — не было и попытки, т.к. весь пункт 5 заблокирован пунктом 1);
- в production ничего не создавалось и не изменялось (условие соблюдено — production Firebase вообще не затрагивался ни разу за все раунды).

Это не «пропущено по невнимательности» — это прямое, честное следствие
отсутствия реального `.env.staging.local` (пункт 1). Выполнение пункта 5
без реального staging-конфига потребовало бы либо (а) выдумать
данные — прямо запрещено, либо (б) подключиться к production под видом
staging — прямо запрещено и было бы серьёзным нарушением, либо (в)
пропустить проверку молча — было бы нечестной отчётностью. Выбран
единственный оставшийся вариант: зафиксировать `BLOCKED` и не заявлять
большего.

## Пункт 6 — Повторная проверка Git

```text
$ git status --short
(пусто до внесения правок отчёта в этом раунде)

$ git ls-files '.env*'
.env.example

$ git diff --cached -- . ':!docs/remediation/reports/BASE-002.md' \
    | grep -iE "AIzaSy[A-Za-z0-9_-]{25,}|private_key|BEGIN (RSA|PRIVATE) KEY|client_secret|service.?account|STAGING_FIREBASE_CONFIG_FINGERPRINT="
none found
```

- `.env.staging.local` не отслеживается (не существует физически в этой
  среде — заведомо не может попасть в Git; в любом случае покрыт
  `.gitignore: *.local`);
- реальные Firebase-значения не попали в diff (их и не было в этой сессии — нечему было попасть);
- секреты и fingerprint отсутствуют в отслеживаемых файлах;
- diff этого раунда содержит только правки `docs/remediation/reports/BASE-002.md`
  (и обновление описания PR №2 — вне Git) — код, `package.json`,
  `package-lock.json`, скрипты не менялись, т.к. по итогам раунда 2 ревью
  код принят без замечаний (`CODE REVIEW: PASS`).

## Сводная таблица — раздельно PASS / FAIL / BLOCKED

| # | Проверка | Статус |
|---|---|---|
| 1 | Наличие `.env.staging.local` с реальными значениями `finapp-staging` | **BLOCKED — OWNER_ACTION_REQUIRED** (файл отсутствует в этой рабочей среде) |
| 2 | `VITE_FIREBASE_PROJECT_ID` = `finapp-staging` (реально) | **BLOCKED** (зависит от пункта 1) |
| 2 | Emulator mode выключен (реально) | **BLOCKED** (зависит от пункта 1) |
| 2 | Fingerprint совпадает (реально) | **BLOCKED** (зависит от пункта 1) |
| 2 | Ни одно поле не из production (реально) | **BLOCKED** (зависит от пункта 1) |
| 3 | `npm ci` | **PASS** |
| 3 | `npm run test:staging-preflight` | **PASS** (5/5, синтетические данные) |
| 3 | `npm run lint` | **PASS** |
| 3 | `npx tsc -b --pretty false` | **PASS** |
| 3 | `git diff --check` | **PASS** |
| 4 | `npm run build:staging` (реальный) | **FAIL/BLOCKED, ожидаемо** — guard корректно останавливает сборку до `tsc`/`vite build`, `dist/` не создан |
| 4 | Проверка реального `dist/` (баннер/prod ID/fingerprint/эмуляторы) | **BLOCKED** (нет реального `dist/`) |
| 5 | Реальный Auth-вход в `finapp-staging` | **BLOCKED** |
| 5 | Реальное обращение к `finapp-staging` Firestore | **BLOCKED** |
| 5 | Подтверждение отсутствия production-доступа | **PASS** (production не затрагивался — ни разу за все раунды; но это подтверждено по факту отсутствия попыток, не по факту сравнения с реальным live-запросом) |
| 6 | Git: секреты/fingerprint отсутствуют, diff — только отчёт | **PASS** |
| — | Cloud Functions | **DEFERRED_TO_SEC-003_BY_OWNER** |
| — | Realtime Database (случайная, в `finapp-staging`) | **OWNER_ACTION_REQUIRED** (не удалялась, не изменялась) |

## Итоговый статус этого раунда

**`BLOCKED_REAL_STAGING_VERIFICATION`** — весь код принят (`CODE REVIEW:
PASS`), но фактическая проверка реального staging (пункты 1, 2, 4-частично,
5) не может быть выполнена в этой рабочей среде из-за отсутствия
предоставленных владельцем реальных значений. Это **не** `READY_FOR_FINAL_REVIEW`
— условие для этого статуса не выполнено.

`[ ]` `BASE-002` в `REMEDIATION_PLAN.md` **не изменялся**. `BASE-003` не
начиналась. PR №2 не мёржился, новая ветка/PR не создавались. Production
Firebase не затрагивался, production deployment не выполнялся.

## Известные ограничения (раунд 2)

- Эта сессия выполняется в новом, отличном от предыдущих раундов,
  контейнере — любые локальные (не Git) артефакты предыдущих раундов
  (`.env.staging.local`, `.env.development.local`, скачанные бинарники
  Emulator Suite) не сохранились. Это ожидаемо для модели «секреты только
  локально» и не является потерей рабочих данных — ничего из этого не
  должно было коммититься.
- До получения реальных значений (пункт 1) и, если потребуется, до
  доступа к среде с исходящей связностью к `identitytoolkit.googleapis.com`/
  `firestore.googleapis.com`, реальная проверка Auth/Firestore не может
  быть выполнена ни в этой, ни, вероятно, в аналогичной облачной сессии —
  тот же класс сетевого ограничения, что и был описан в «Часть 1» этого же
  отчёта (доступ к `firebase.google.com` блокируется прокси). Не проверено
  заново в этом раунде (не было реального конфига, чтобы проверить
  предметно) — фиксирую как открытый вопрос для владельца: если сеть
  окажется недоступна даже при наличии реального `.env.staging.local`,
  пункт 5 придётся выполнить не из облачной сессии Claude Code, а вручную
  владельцем или из среды с подтверждённой сетевой связностью.

## OWNER_ACTION_REQUIRED (сводно для этого раунда)

1. Предоставить реальные значения Firebase Web SDK config для
   `finapp-staging-web` + вычислить и предоставить
   `STAGING_FIREBASE_CONFIG_FINGERPRINT` (см. «Пункт 1» выше — точный
   путь получения и формат).
2. Решить, в какой среде выполнять пункт 5 (реальный Auth/Firestore
   вход), если у рабочей среды Claude Code на момент повторной попытки
   не будет исходящей сетевой связности к Firebase API.
3. Realtime Database в `finapp-staging` — остаётся неудалённой,
   неизменённой, отдельным `OWNER_ACTION_REQUIRED` по прямому указанию
   владельца (не трогать).

## Diff summary (этот раунд)

```text
 docs/remediation/reports/BASE-002.md | (только этот файл)
```

Код, `package.json`, `package-lock.json`, `scripts/`, `src/` — **не
менялись** в этом раунде (раунд 2 ревью — `CODE REVIEW: PASS`, менять
нечего).

## Следующий разрешённый пункт

Сама `BASE-002` — по-прежнему не завершена (`BLOCKED_REAL_STAGING_VERIFICATION`).
**Не начинаю `BASE-003`.**

---

# Часть 5 — Реальная staging-проверка (раунд 3, после получения OWNER_INPUT)

## Контекст

Владелец предоставил реальную Firebase Web SDK config для
`finapp-staging-web` (вставлена в чат владельцем напрямую). Локальный файл
`.env.staging.local` был создан в предыдущем ходе сессии (см. отдельный
запрос владельца «безопасно создай `.env.staging.local`»), содержит
реальные значения и корректно вычисленный (тем же кодом, что использует
`scripts/verify-staging-env.mjs`) `STAGING_FIREBASE_CONFIG_FINGERPRINT`.
**Ни одно значение из этого файла нигде не печаталось** — ни в этом
отчёте, ни в терминале, ни в PR. Все проверки ниже выполнены через
скрипты, которые выводят только булевы результаты, счётчики совпадений и
символьные коды ошибок Firebase SDK (`err.code`, например
`permission-denied`, `auth/operation-not-allowed`) — сами по себе это не
секреты, а стандартные протокольные идентификаторы.

## Branch / commit

- branch: `remediation/BASE-002-staging` (без создания новой)
- PR: существующий Draft PR №2 (без создания нового)
- base SHA: `efb8fd0061d3baebf186432da9d369d182768481`
- result SHA: см. `git rev-parse HEAD` после коммита этого раздела

## Решения владельца, подтверждённые/зафиксированные в этом раунде

- **Cloud Functions: `DEFERRED_TO_SEC-003_BY_OWNER`.** Не создавались, не
  разворачивались. Blaze не подключался. Ничего не изменено в этом раунде
  относительно предыдущего решения владельца (см. «Часть 4»).
- **Realtime Database** (случайно созданная в `finapp-staging`): не
  удалялась, не изменялась. Остаётся `OWNER_ACTION_REQUIRED`.
- **Второе веб-приложение** в `finapp-staging` (если владелец имел в виду
  под этим термином отдельный Web App помимo `finapp-staging-web`,
  например созданный вместе со случайной Realtime Database) — не
  затрагивалось, не удалялось, не изменялось этой сессией; остаётся
  отдельным `OWNER_ACTION_REQUIRED` — эта сессия не имеет доступа к
  Firebase Console, чтобы установить его точное назначение/статус.

## Шаг 1 — Структурная проверка `.env.staging.local` (без печати значений)

```text
$ git status --short
(пусто — файл не отслеживается)

$ git check-ignore -v .env.staging.local
.gitignore:17:.env.*.local	.env.staging.local

$ git ls-files '.env*'
.env.example
```

Структурная проверка (скрипт сравнивает значения программно, печатает
только PASS/FAIL по названию проверки, не сами значения):

```text
PASS — VITE_APP_ENV === "staging"
PASS — VITE_USE_FIREBASE_EMULATORS === "false"
PASS — VITE_FIREBASE_PROJECT_ID === "finapp-staging"
PASS — VITE_FIREBASE_PROJECT_ID !== production ID
PASS — все 6 обязательных VITE_FIREBASE_* полей присутствуют
PASS — ни одно из 6 полей НЕ равно production project ID
PASS — STAGING_FIREBASE_CONFIG_FINGERPRINT присутствует
PASS — fingerprint пересчитан (тем же кодом, что и preflight-guard) и совпадает с сохранённым
PASS — VITE_FIREBASE_DATABASE_URL отсутствует (Realtime DB не используется приложением)

OVERALL: PASS
```

**Все структурные проверки — PASS.**

## Шаг 2 — Обязательные команды

```text
$ npm ci
added 601 packages, and audited 913 packages
(тот же набор npm audit предупреждений, что и в предыдущих раундах — без изменений)

$ npm run test:staging-preflight
✓ PASS — Валидная синтетическая конфигурация + совпадающий fingerprint
✓ PASS — staging projectId, но несовпадающий API key (fingerprint не совпадёт)
✓ PASS — Отсутствующий ожидаемый fingerprint (переменная не задана)
✓ PASS — production projectId вместо staging
✓ PASS — Отсутствующее обязательное поле (VITE_FIREBASE_APP_ID)
✓ Все 5 сценариев staging-preflight прошли как ожидалось.

$ npm run build:staging
> node scripts/verify-staging-env.mjs && tsc -b && vite build --mode staging
✓ build:staging preflight OK — VITE_APP_ENV=staging, projectId=finapp-staging,
  все обязательные переменные заданы, SHA-256 fingerprint конфигурации
  совпадает с ожидаемым staging-набором
vite v8.0.13 building client environment for staging...
✓ 2370 modules transformed
dist/assets/index-*.js  1,883.48 kB │ gzip: 542.09 kB
✓ built in 1.14s
exit code: 0

$ npm run lint
> eslint .
(без вывода — 0 ошибок)

$ npx tsc -b --pretty false
(без вывода — чисто)

$ git diff --check origin/remediation/main..HEAD -- .
(exit 0 — чисто)
```

**Все шесть команд — PASS. Это первый раунд, где `npm run build:staging`
реально прошёл целиком (preflight → `tsc` → `vite build --mode staging`) —
против настоящего, а не синтетического, staging-конфига.**

## Шаг 3 — Проверка реального `dist/`

Скрипт сканирует собранный бандл и печатает только PASS/FAIL и счётчики
совпадений — никогда сами совпавшие строки:

```text
PASS — staging-баннер (текст "STAGING — ТЕСТОВАЯ СРЕДА") присутствует
PASS — production project ID отсутствует (найдено: 0)
PASS — имя переменной STAGING_FIREBASE_CONFIG_FINGERPRINT отсутствует
PASS — значение fingerprint отсутствует в бандле
PASS — VITE_USE_FIREBASE_EMULATORS=false в .env.staging.local (не секрет — булев флаг)
PASS — build:staging успешно прошёл с projectId=finapp-staging (доказывает
       useEmulators не было true — иначе preflight потребовал бы
       projectId=demo-finapp и упал)
PASS — VITE_FIREBASE_DATABASE_URL/databaseURL literal absent from bundle

OVERALL: PASS
```

**Важная оговорка (честно, как и требовала задача):** Firebase Web SDK
config (`apiKey`, `authDomain`, `storageBucket`, `messagingSenderId`,
`appId`, `projectId`) **по своей природе присутствует** в клиентском
бандле — это встроенное, ожидаемое поведение любого Firebase web-приложения
(Firebase apiKey не является секретом в традиционном смысле — он публично
виден в любом развёрнутом Firebase web-приложении; реальная защита
обеспечивается Firestore/Auth Rules и серверной проверкой, а не сокрытием
apiKey). Присутствие этих полей в `dist/` — не дефект и не нарушение
изоляции; проверялось именно то, что явно требовалось: staging-баннер
присутствует, production ID отсутствует, fingerprint (имя и значение)
отсутствует, приложение не подключено к локальным эмуляторам, Realtime
Database URL отсутствует.

`dist/` **не публиковался**, не разворачивался, не добавлялся в Git —
удалён (`rm -rf dist`) сразу после проверки.

## Шаг 4 — Реальная проверка Firebase staging

### Firestore

```text
=== Firestore check ===
RESULT: read threw an error, code="permission-denied"
RESULT: PERMISSION_DENIED — expected, safe confirmation that deny-all
        Firestore Rules are active and enforced for finapp-staging
TARGET_PROJECT_CONFIRMED: yes
```

**Результат: PASS.** Тестовый запрос чтения к заведомо тестовому,
несуществующему пути (`_staging_healthcheck/claude-verify-<random>`)
выполнен через Firestore SDK, инициализированный исключительно
конфигурацией `finapp-staging` (JS SDK физически не может перенаправить
запрос в другой проект — projectId зашит в инициализацию клиента). Ответ —
`permission-denied`, что является **ожидаемым, безопасным подтверждением**
того, что: (а) запрос действительно достиг `finapp-staging`, и (б) deny-all
Firestore Rules baseline активны и работают. Документы не создавались и не
изменялись. Firestore Rules не разворачивались и не изменялись.

### Authentication

```text
=== Auth check ===
RESULT: temporary test user created successfully in staging Authentication
        (email/password provider is enabled)
TARGET_PROJECT_CONFIRMED: yes
CLEANUP: temporary test user deleted successfully
```

**Результат: PASS.** Email/Password provider оказался уже включён в
`finapp-staging` (не этой сессией — она ничего не включала). Создан один
временный тестовый пользователь со случайным локальным email
(`claude-verify-<random>@example.invalid`, домен `.invalid` зарезервирован
RFC 2606 специально для тестовых адресов, не существует и не может ничего
получить) и случайным паролем (24 байта, сгенерированы `crypto.randomBytes`,
никогда не выводились). Пользователь **удалён немедленно** в блоке
`finally` сразу после создания — подтверждено сообщением `CLEANUP:
temporary test user deleted successfully`. Production Authentication не
затрагивался (использовался исключительно `finapp-staging` Auth instance).
Никакие новые Authentication providers не включались — Email/Password уже
был включён до этой проверки.

### Подтверждение отсутствия production-доступа

**PASS.** Ни в одном из трёх раундов (включая этот) не выполнялось ни
одного запроса к `finapp-prod-10a83` — ни чтения, ни записи, ни
Auth-операций. Используемый в этом раунде Firebase App был инициализирован
исключительно конфигурацией из `.env.staging.local` (`projectId=finapp-staging`,
структурно подтверждено в Шаге 1) — Firebase JS SDK не имеет механизма
«переключиться» на другой проект в рамках уже инициализированного `app`.

## Шаг 5 — Безопасность Git (повторно, после реальной проверки)

```text
$ git status --short
(пусто)

$ git check-ignore -q .env.staging.local; echo $?
0   # (ignored: yes)

$ git ls-files '.env*'
.env.example

$ git status --short | grep -c "^.. dist"
0

$ git ls-files dist 2>/dev/null | wc -l
0
```

- `.env.staging.local` — не отслеживается (подтверждено дважды: до и после
  реальной проверки).
- `dist/` — не добавлялся в Git, удалён после проверки Шага 3.
- Реальные Firebase-значения и fingerprint — не попали ни в один
  отслеживаемый файл, ни в diff (единственный diff этого раунда —
  `docs/remediation/reports/BASE-002.md`, без секретов — см. скан ниже).
- Временный Node-скрипт, использованный для реальной проверки Auth/Firestore
  (`.claude-tmp-real-staging-check.mjs`, создан внутри репозитория только
  для того, чтобы bare-specifier импорты `firebase/*` резолвились через
  `node_modules` репозитория), **удалён сразу после использования**
  (`rm -f`) — подтверждено отсутствием в `git status` и в файловой системе.
  Он никогда не коммитился и не индексировался Git.

```text
$ git diff --cached -- . ':!docs/remediation/reports/BASE-002.md' \
    | grep -iE "AIzaSy...|private_key|BEGIN...KEY|client_secret|STAGING_FIREBASE_CONFIG_FINGERPRINT=[0-9a-f]{64}"
none found
```

**PASS** — production-файлы не изменены, изменения этого раунда
ограничены `docs/remediation/reports/BASE-002.md` (кода/скриптов/зависимостей
не потребовалось — раунд 2 уже закрыл все замечания по коду).

## Сводная таблица — раздельно PASS / FAIL / BLOCKED (раунд 3)

| # | Проверка | Статус |
|---|---|---|
| 1 | `.env.staging.local` существует, не в Git | **PASS** |
| 1 | `VITE_FIREBASE_PROJECT_ID` = `finapp-staging` | **PASS** |
| 1 | `VITE_USE_FIREBASE_EMULATORS=false` | **PASS** |
| 1 | Fingerprint совпадает | **PASS** |
| 1 | Production project ID не используется | **PASS** |
| 2 | `npm ci` | **PASS** |
| 2 | `npm run test:staging-preflight` (5/5) | **PASS** |
| 2 | `npm run build:staging` (реальный, полный прогон) | **PASS** |
| 2 | `npm run lint` | **PASS** |
| 2 | `npx tsc -b --pretty false` | **PASS** |
| 2 | `git diff --check` | **PASS** |
| 3 | staging-баннер в `dist/` | **PASS** |
| 3 | `finapp-prod-10a83` отсутствует в `dist/` | **PASS** |
| 3 | `STAGING_FIREBASE_CONFIG_FINGERPRINT` (имя и значение) отсутствует в `dist/` | **PASS** |
| 3 | Приложение не подключено к локальным эмуляторам | **PASS** |
| 3 | Firebase Web SDK config присутствует в `dist/` | **ОЖИДАЕМО** (не секрет, встроенное поведение Firebase web-приложений — см. оговорку Шага 3) |
| 4 | Реальный Auth-запрос направлен именно в `finapp-staging` | **PASS** |
| 4 | Email/Password provider включён, тестовый пользователь создан и удалён | **PASS** |
| 4 | Реальный Firestore-запрос направлен именно в `finapp-staging` | **PASS** |
| 4 | `PERMISSION_DENIED` как ожидаемое подтверждение работы Rules | **PASS** |
| 4 | Firestore Rules не развёрнуты/не изменены | **PASS** (условие соблюдено) |
| 4 | Отсутствие обращения к production | **PASS** |
| 5 | Git: секреты/fingerprint отсутствуют, diff — только отчёт | **PASS** |
| — | Cloud Functions | **DEFERRED_TO_SEC-003_BY_OWNER** |
| — | Realtime Database (случайная) | **OWNER_ACTION_REQUIRED** (не тронута) |
| — | Второе веб-приложение (если применимо) | **OWNER_ACTION_REQUIRED** (не тронуто, назначение не проверялось — нет доступа к Console) |

**FAIL: отсутствуют.** Все выполненные проверки — PASS; единственные не-PASS
записи — явно определённые `DEFERRED_TO_SEC-003_BY_OWNER` и
`OWNER_ACTION_REQUIRED`, оба по прямому решению/указанию владельца, не по
дефекту реализации.

## Итоговый статус этого раунда

**`READY_FOR_FINAL_REVIEW`.** Сборка (build:staging), реальная
Auth-проверка и реальная Firestore-проверка — все подтверждены. Это
соответствует условию задачи «если сборка, Auth и Firestore подтверждены,
установи READY_FOR_FINAL_REVIEW».

**Важно:** `[ ]` `BASE-002` в `REMEDIATION_PLAN.md` **не изменялся** — эта
сессия не ставит `[x]` самостоятельно; это разрешено только после явного
`REVIEW_RESULT: PASS` от независимого ревьюера (протокол `CLAUDE.md`,
раздел 1, пункт 7). `BASE-003` не начиналась. PR №2 не мёржился, новая
ветка/PR не создавались. Production Firebase не затрагивался, deployment
не выполнялся, Firestore Rules не изменялись, новые Authentication
providers не включались, Blaze не подключался, Realtime Database и второе
веб-приложение не удалялись/не изменялись.

## Известные ограничения (раунд 3)

- Firestore-проверка подтвердила `permission-denied` для одного
  конкретного тестового пути — это доказывает, что deny-all baseline
  Rules работают в общем случае, но не является исчерпывающим security-
  тестированием всех путей/ролей (это предмет `SEC-011`, отдельная
  задача — Rules unit-tests в Emulator Suite).
- Auth-проверка подтвердила, что Email/Password provider включён и
  функционален — не проверялись другие возможные providers (Google,
  Phone и т.д.), т.к. задача ограничивала проверку только Email/Password
  веткой.
- Второе веб-приложение (если оно существует в `finapp-staging` помимо
  `finapp-staging-web`) не было идентифицировано и не проверялось этой
  сессией — нет доступа к Firebase Console, чтобы установить его
  назначение. Остаётся открытым `OWNER_ACTION_REQUIRED`.
- Cloud Functions — по-прежнему не созданы, не развёрнуты
  (`DEFERRED_TO_SEC-003_BY_OWNER`, без изменений).

## Diff summary (этот раунд)

```text
 docs/remediation/reports/BASE-002.md | (только этот файл)
```

Код, `package.json`, `package-lock.json`, `scripts/`, `src/` — **не
менялись** в этом раунде. `.env.staging.local` не является частью diff (не
отслеживается Git).

## Следующий разрешённый пункт

Сама `BASE-002` — статус `READY_FOR_FINAL_REVIEW`. Ожидает
`REVIEW_RESULT: PASS` от независимого ревьюера, прежде чем `[x]` может
быть проставлен в `REMEDIATION_PLAN.md`. **Не начинаю `BASE-003`.**

---

# Часть 6 — Закрытие после независимого финального ревью

```text
REVIEW_RESULT: PASS
TASK_ID: BASE-002
FINAL_STATUS: ACCEPTED
```

## Что сделано в этом, финальном, шаге

1. `REMEDIATION_PLAN.md`: `## [ ] BASE-002 ...` → `## [x] BASE-002 ...` —
   изменена ровно одна строка, ничего больше в файле не тронуто.
2. Этот отчёт (`docs/remediation/reports/BASE-002.md`) дополнен блоком
   `REVIEW_RESULT: PASS / TASK_ID: BASE-002 / FINAL_STATUS: ACCEPTED`
   (см. «Итоговый статус» в начале файла и здесь).
3. Код, зависимости, `package.json`/`package-lock.json`, Firebase-конфигурация
   (`.firebaserc`, `firebase.json`, `firestore.rules`, `firestore.indexes.json`,
   `src/lib/firebaseEnv*`, `scripts/**`) — **не изменялись**.
4. `.env.staging.local`, production Firebase, Firestore Rules, Realtime
   Database, второе веб-приложение — **не затрагивались**.
5. Cloud Functions — статус остаётся **`DEFERRED_TO_SEC-003_BY_OWNER`**,
   без изменений.
6. `BASE-003` — не начиналась.

## Обязательные проверки этого шага

```text
$ git diff --check
(exit 0 — чисто)

$ git status --short
 M REMEDIATION_PLAN.md
 M docs/remediation/reports/BASE-002.md
```

Оба файла — ожидаемые изменения этого шага (чек-бокс плана + сам отчёт),
других изменений нет.

## Diff summary (этот коммит)

```text
 REMEDIATION_PLAN.md                  |  2 +-
 docs/remediation/reports/BASE-002.md | (добавлен блок REVIEW_RESULT + «Часть 6»)
```

## PR

- PR №2 переведён из Draft в Ready for review (после push этого коммита).
- PR не объединялся.

## Следующий разрешённый пункт

`BASE-003` — по `REMEDIATION_PLAN.md`, следующий невыполненный пункт после
`BASE-002`. **Не начинаю.**
