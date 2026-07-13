# BASE-002 — Создать отдельное staging Firebase-окружение

## Итоговый статус
READY_FOR_REVIEW

Реализация выполнена (см. «Часть 2» ниже). `[ ]` в `REMEDIATION_PLAN.md`
**не менялся** — по протоколу `CLAUDE.md` это разрешено только после
`REVIEW_RESULT: PASS`.

Единственный содержательный пробел — реальные Firebase Web SDK config
значения для `finapp-staging-web` (apiKey/authDomain/storageBucket/
messagingSenderId/appId) не были предоставлены владельцем (в OWNER_INPUT
задачи они остались как незаполненные плейсхолдеры). Это не дефект
реализации: код и guard-скрипт корректно и предсказуемо отказывают в этой
ситуации, что и является частью требуемого поведения. См.
`OWNER_ACTION_REQUIRED` в конце файла.

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

- [x] staging project ID отличается от production (`finapp-staging` ≠ `finapp-prod-10a83`, зафиксировано в `.firebaserc` и `firebaseEnv.ts`)
- [x] staging build не может использовать production Auth/Firestore (доказано негативным тестом C)
- [x] emulator development использует только `demo-finapp` (доказано реальным запуском Emulator Suite, раздел D)
- [x] локальные env-файлы не отслеживаются Git (раздел A)
- [x] реальные config values отсутствуют в Git и в этом отчёте (не предоставлялись владельцем; в отчёт не копировались)
- [x] staging визуально отличается от production (баннер, подтверждено в собранном бандле)
- [x] приложение не использует Realtime Database (раздел E)
- [x] Firebase deploy не выполнялся (не запускалась ни разу команда `firebase deploy`)
- [x] Cloud Functions deploy не выполнялся (scaffold не создавался, deploy невозможен физически)
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

1. **Предоставить реальные значения Firebase Web SDK config** для
   `finapp-staging-web` (apiKey, authDomain, storageBucket,
   messagingSenderId, appId) — Firebase Console → Finapp Staging →
   Settings → General → Your apps → finapp-staging-web → SDK setup and
   configuration → Config. Вставить их в уже подготовленные закомментированные
   строки в `.env.staging.local` (локально, не в Git) и раскомментировать.
2. **Решить судьбу случайно созданной Realtime Database** в
   `finapp-staging` — удалить через Firebase Console, либо явно
   подтвердить и настроить её собственные deny-all правила, если удаление
   почему-то нежелательно. Приложение её не использует и не будет
   использовать без отдельного решения.
3. **Решение по Blaze/billing и Cloud Functions** — до этого решения
   Cloud Functions scaffold сознательно не создавался; когда решение будет
   принято, потребуется отдельная задача (вне `BASE-002`).
4. После получения (1) — подтвердить и, если нужно, инициировать
   независимое ревью реального `npm run build:staging` против настоящего
   staging-проекта (эта сессия проверила логику только на тестовых
   фиктивных значениях).
