# BASE-002 — Создать отдельное staging Firebase-окружение

## Итоговый статус
PREFLIGHT_COMPLETE — OWNER_ACTION_REQUIRED

Это **только preflight-отчёт**. Сама задача `BASE-002` (создание staging
Firebase/GCP project, `.firebaserc`, `firebase.json`, разделение env-конфигов,
staging-индикатор в UI) **не реализована** и не начата. `[ ]` в
`REMEDIATION_PLAN.md` не менялся.

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
