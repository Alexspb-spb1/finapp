# BASE-005 — Technical baseline

```text
TASK_ID: BASE-005
PHASE: MEASUREMENT ONLY — NO FIXES APPLIED
```

Generated: **2026-07-30T19:10:47Z** (UTC)

**`TESTED_BASELINE_SHA = 7d637d29b4ad4c3dcacde9e9bf46ffe385096171`**
(commit A — `chore(base-005): add reproducible baseline tooling`; all
measurements below were taken on exactly this commit).

Исходный `origin/main` перед этой задачей:
`1a642460b21e27cc1c0973cb4141ebffc81e4a0f` (= merge SHA PR
[#5](https://github.com/Alexspb-spb1/finapp/pull/5), BASE-004 принята).

## Что это за документ

Это **измерение**, а не исправление. Каждый найденный недостаток (низкий
Lighthouse score, npm-уязвимость, отсутствие code-splitting) зафиксирован
как есть — ничего не исправлено, ни один результат не улучшен изменением
кода. Задача BASE-005 — дать воспроизводимую точку отсчёта, с которой
будущие изменения можно будет объективно сравнивать.

## Окружение

| Параметр | Значение |
|---|---|
| ОС | Windows 10 Pro (NT 10.0.19045, win32/x64) |
| Node.js | v24.16.0 |
| npm | 11.13.0 |
| TypeScript | 6.0.3 |
| Vite | 8.0.13 |
| Chrome executable (headless, Lighthouse) | 151.0.7922.71 |
| Chrome User-Agent token | 151.0.0.0 (`HeadlessChrome/151.0.0.0`; User-Agent намеренно сокращает номер версии и не равен версии executable) |
| Lighthouse | 13.4.1 |
| Java (Firestore Emulator) | portable Temurin 21.0.12 (системная Java не менялась) |

## Команды и результаты

Все команды выполнены на `TESTED_BASELINE_SHA`, свежий `node_modules`
(изолированный `npm --cache <временный каталог>`).

| Команда | Exit code | Результат |
|---|---|---|
| `npm ci` | 0 | PASS — 929 пакетов |
| `npm run lint` | 0 | PASS — 0 ошибок, 1 предупреждение (см. ниже) |
| `npm run typecheck` (`tsc -b --pretty false`) | 0 | PASS — 0 ошибок TypeScript |
| `npm run test:staging-preflight` | 0 | PASS — 5/5 синтетических сценариев |
| `npx tsc --noEmit -p tests/rules/tsconfig.json` | 0 | PASS |
| `npm run test:rules` (Firestore Emulator, portable Java 21) | 0 | **PASS — 77/77, 0 failed, 0 skipped** |
| `npm run test:unit` | 0 | PASS — 9/9 |
| `npm run build` | 0 | PASS |
| `npm run build:staging` | 0 | PASS — production ID отсутствует в staging bundle (проверено `grep -rl`) |
| `npm audit --json` | 1 | Результат зафиксирован честно — см. «npm audit» ниже. Ненулевой exit — ожидаемое следствие найденных уязвимостей, не сбой сети (валидный непустой JSON получен) |
| `npm ls xlsx --depth=0` | 0 | `xlsx@0.18.5` |
| `npm run build -- --manifest` | 0 | PASS |
| `npm run baseline:bundle` | 0 | PASS — см. «Bundle baseline» ниже |
| `git diff --check` | 0 | PASS |

### TypeScript / ESLint — количество ошибок и предупреждений
- TypeScript: **0 ошибок** (`tsc -b --pretty false`, exit 0, пустой вывод).
- ESLint: **0 ошибок, 1 предупреждение** — `src/pages/Balance.tsx:119:6`,
  `react-hooks/exhaustive-deps` («React Hook useMemo has a missing
  dependency: 'isFinancialKind'»). Предупреждение **не исправлено** — это
  сознательное решение задачи (измерение, не починка); отмечено как
  известная находка ниже.

## Bundle baseline

Метод: `npm run build -- --manifest`, затем `npm run baseline:bundle`
(Node-only скрипт, `scripts/technicalBaseline/report-bundle.mjs`).
Полный сырой отчёт: `docs/remediation/evidence/BASE-005-bundle-report.json`.

**Определение "initial JS"**: entry-чанк + полное транзитивное замыкание
его статических `imports` из `dist/.vite/manifest.json`. Chunks,
достижимые только через `dynamicImports`, в initial JS не входят и
считаются отдельно.

| Параметр | Значение |
|---|---|
| Entry chunk | `assets/index-C5yUrrGO.js` |
| Initial JS файлов | 1 |
| Initial JS raw | 1 892 447 байт (~1.80 MiB) |
| Initial JS gzip | 538 574 байт (~526 KiB) |
| Initial JS Brotli | 438 180 байт (~428 KiB) |
| Initial CSS файлов | 1 |
| Initial CSS raw / gzip / Brotli | 62 151 / 10 345 / 8 411 байт |
| Dynamic-only JS chunks | **0** — приложение не использует `import()` вообще; весь код собран в один статический бандл |
| Всего JS chunks | 1 |
| Всего CSS файлов | 1 |
| Общий размер `dist/` | 1 969 813 байт (~1.88 MiB) |

**Найдено, не исправлено**: весь код приложения собирается в один
JS-чанк ~1.8 MiB (raw) без единого `import()` — то же предупреждение,
которое печатает сам Vite при каждой сборке («Some chunks are larger than
500 kB after minification»). Большой единый бандл создаёт общую нагрузку
для login и dashboard и может ухудшать абсолютные показатели обоих
маршрутов. Он, однако, сам по себе **не объясняет разницу** между score
login 0.72 и dashboard 0.58, потому что оба маршрута загружают один и тот
же entry-бандл. Более высокие LCP и TBT dashboard также совместимы с
дополнительной загрузкой данных и рендерингом авторизованного интерфейса;
вклад отдельных факторов этим baseline не изолировался. **Не исправлено в
этой задаче** — BASE-005 измеряет, не чинит.

### Воспроизводимость (обязательная проверка)
`npm run build` и `npm run build -- --manifest` дают **побитово
идентичные** JS/CSS assets (одинаковые имена файлов, одинаковый SHA-256) —
проверено явным сравнением на этом же коммите **в одном и том же
зафиксированном окружении**: Windows 10, Node.js 24.16.0, npm 11.13.0,
Vite 8.0.13. `--manifest` не меняет chunking.
`BASE_005_BLOCKED_BUNDLE_REPRODUCIBILITY` не потребовался.

Это не утверждение о переносимости хешей между ОС и toolchain. При
независимой проверке того же SHA под Linux и другой версией Node.js
получился другой JS SHA-256. Для побитового сравнения нужно повторять
зафиксированное окружение; в другом окружении сравниваются структура,
размеры и перечень чанков, а не обязательное совпадение хеша.

## npm audit baseline

Полный обезличенный JSON: `docs/remediation/evidence/BASE-005-npm-audit.json`.
**Уязвимости не исправлялись** — `npm audit fix`, `npm update`,
`npm install <pkg>` не выполнялись ни разу в этой задаче.

| Severity | Количество |
|---|---|
| critical | 0 |
| high | 20 |
| moderate | 7 |
| low | 1 |
| **Итого** | **28** |

`xlsx` — **прямая (direct)** зависимость, установленная версия
**`0.18.5`**, `fixAvailable: false` в npm registry на момент проверки (две
известные advisories: prototype pollution `GHSA-4r6h-8v6p-xvw6` и ReDoS
`GHSA-5pgg-2g8v-p4x9`, обе `high`, обе без официального фикса для этой
major-ветки в реестре). Замена/обновление `xlsx` **не входит в scope**
`BASE-005` — зафиксировано как известная находка для отдельной задачи.

**Ограничение измерения**: `npm audit` обращается к живому реестру за
актуальной базой advisories, поэтому результат не гарантированно
идентичен при повторном запуске в другой момент времени, даже на том же
`package-lock.json` — при первой пробной проверке в рамках этой же сессии
было зафиксировано 35 уязвимостей (14 moderate вместо 7); итоговое
зафиксированное число (28) — результат **финального** прогона, часть
официальной последовательности проверок раздела «Команды и результаты»
выше. Это не расхождение в самом проекте, а изменчивость внешней базы
данных advisories между двумя моментами времени в течение сессии.

## Lighthouse — login

Маршрут: `http://127.0.0.1:<port>/finapp/#/login` (неавторизованный).
3 запуска, отдельный чистый временный Chrome-профиль на каждый запуск.
Полный обезличенный JSON: `docs/remediation/evidence/BASE-005-lighthouse-login.json`.

| Метрика | Run 1 | Run 2 | Run 3 | **Медиана** |
|---|---|---|---|---|
| Performance | 0.72 | 0.72 | 0.72 | **0.72** |
| Accessibility | 0.79 | 0.79 | 0.79 | **0.79** |
| Best Practices | 1.00 | 1.00 | 1.00 | **1.00** |
| SEO | 0.90 | 0.90 | 0.90 | **0.90** |
| FCP (ms) | 4659.0 | 4623.4 | 4683.8 | **4659.0** |
| LCP (ms) | 4659.0 | 4623.4 | 4683.8 | **4659.0** |
| Speed Index (ms) | 4327 | 4294 | 4349 | **4327** |
| TBT (ms) | 9.2 | 10.8 | 23.0 | **10.8** |
| CLS | 0 | 0 | 0 | **0** |

## Lighthouse — dashboard

Маршрут: `http://127.0.0.1:<port>/finapp/#/` (авторизованный). 3 запуска,
один и тот же выделенный временный Chrome-профиль во всех трёх (явно
разрешено заданием для dashboard-кейса). Полный обезличенный JSON:
`docs/remediation/evidence/BASE-005-lighthouse-dashboard.json`.

| Метрика | Run 1 | Run 2 | Run 3 | **Медиана** |
|---|---|---|---|---|
| Performance | 0.58 | 0.59 | 0.57 | **0.58** |
| Accessibility | 0.79 | 0.79 | 0.79 | **0.79** |
| Best Practices | 1.00 | 1.00 | 1.00 | **1.00** |
| SEO | 0.90 | 0.90 | 0.90 | **0.90** |
| FCP (ms) | 4694.5 | 4528.0 | 4726.1 | **4694.5** |
| LCP (ms) | 7970.8 | 7818.0 | 8001.4 | **7970.8** |
| Speed Index (ms) | 7290 | 7140 | 7315 | **7290** |
| TBT (ms) | 149.9 | 135.0 | 162.2 | **149.9** |
| CLS | 0 | 0 | 0 | **0** |

### Общие параметры обоих прогонов
- Режим эмуляции: `simulate` (стандартный Lighthouse `--preset=perf`)
- Throttling: RTT 150 ms, download ≈1475 Kbps, upload 675 Kbps, CPU
  slowdown ×4 (стандартный симулированный mobile-профиль Lighthouse)
- Viewport: 412×823, `deviceScaleFactor` 1.75, `mobile: true`
- Категории: Performance, Accessibility, Best Practices, SEO

## Синтетическая среда авторизации (только для dashboard)

- Firebase Auth + Firestore **Emulator Suite**, project ID `demo-finapp`
  (`firebase emulators:start --project demo-finapp --only auth,firestore`).
  Никакого staging/production Firebase не использовалось.
- Приложение собрано в существующем emulator-совместимом режиме
  (`VITE_USE_FIREBASE_EMULATORS=true`, уже реализованная поддержка в
  `src/lib/firebase.ts`/`firebaseEnvCore.mjs` — код приложения не
  менялся).
- Синтетический пользователь создан **через реальный UI-флоу регистрации**
  приложения (Puppeteer заполнял и отправлял настоящую форму
  `/#/register` — два шага, ровно как это делает реальный пользователь),
  а не прямым вызовом Auth Admin API или `authStore` в обход UI. Никакого
  обхода `ProtectedRoute` — маршрут `/finapp/#/` реально прошёл через
  полный auth-редирект и отрисовал настоящий dashboard.
- Email синтетического пользователя — уникальный, домен `.invalid`
  (RFC 2606, никогда не резолвится). Название компании — синтетическое.
  Никаких реальных ФИО/email/финансовых данных не использовалось нигде.
- После измерений: эмуляторы Auth/Firestore остановлены обычным
  завершением процесса, **без** `--export-on-exit` и без
  `--import`/`firestore:delete` — никакое состояние не экспортировалось и
  не сохранялось. Временный `.env.emulator.local` (git-ignored, не
  коммитился) удалён после использования. Debug-логи эмуляторов
  (`firebase-debug.log`, `firestore-debug.log`, оба и так git-ignored)
  удалены.
- **Внешних Firebase-записей не было** — весь синтетический пользователь и
  все связанные документы существовали только в локальном Emulator Suite
  в памяти процесса и были уничтожены вместе с остановкой эмуляторов.

## Известные ограничения и источники погрешности

1. Однопоточная сборка в один JS-чанк (0 dynamic imports) является общей
   нагрузкой для обоих маршрутов и может ухудшать их абсолютные показатели,
   но не доказывает причину разницы login 0.72 и dashboard 0.58. Dashboard
   дополнительно загружает данные и рендерит авторизованный интерфейс;
   вклад факторов отдельно не измерялся.
2. Побитовая воспроизводимость JS/CSS подтверждена внутри одинакового
   Windows/Node/npm/Vite-окружения. Linux или другая версия Node.js может
   дать другой content hash на том же исходном SHA; это ограничивает
   межплатформенное сравнение хешей.
3. `npm audit` использует живую базу advisories реестра — результат может
   незначительно отличаться при повторном запуске в другой момент времени
   даже без изменения зависимостей (см. пояснение в разделе «npm audit
   baseline»).
4. Lighthouse-измерения выполнены в `simulate`-режиме (не throttling
   реального устройства) на headless Chrome под Windows в виртуализированной
   рабочей станции — абсолютные цифры могут отличаться на другом железе;
   относительные различия между login/dashboard и будущие сравнения с этим
   baseline остаются валидными при том же методе измерения.
5. Дашборд-профиль Chrome использовался один на все 3 прогона (явно
   разрешено заданием) — в отличие от login, где каждый прогон получил
   отдельный чистый профиль.

## Подтверждения

- **Ничего не исправлялось.** Найденные npm-уязвимости, ESLint-предупреждение,
  отсутствие code-splitting — зафиксированы как есть. `npm audit fix`,
  `npm update`, `npm install <pkg>` не выполнялись.
- **Зависимости не обновлялись.** `package-lock.json` побитово не изменился
  относительно `origin/main` (`git diff origin/main -- package-lock.json` —
  пусто).
- **Staging/production не затрагивались.** Единственное внешнее состояние —
  локальный Firebase Emulator Suite (`demo-finapp`), уничтоженное вместе с
  остановкой процесса. `.env.staging.local` использовался только для
  штатной проверки `npm run build:staging` (как и в предыдущих задачах),
  никаких staging-записей не выполнялось.
- **Deploy не выполнялся** — ни Hosting, ни Firebase Rules/indexes/Functions,
  нигде.
- **Firebase Rules, `.firebaserc`, `firebase.json`, GitHub Actions** — не
  менялись.
- **Runtime-код `src/**`** — не менялся.

## Точные команды воспроизведения

```bash
git checkout 7d637d29b4ad4c3dcacde9e9bf46ffe385096171
npm ci
npm run lint
npm run typecheck
npm run test:staging-preflight
npx tsc --noEmit -p tests/rules/tsconfig.json
npm run test:rules
npm run test:unit
npm run build
npm run build:staging     # требует локальный .env.staging.local
npm audit --json
npm ls xlsx --depth=0
npm run build -- --manifest
npm run baseline:bundle
```

### Полная процедура воспроизведения Lighthouse

Ниже приведена процедура непосредственно в этом отчёте; внешнего файла
`docs/remediation/reports/BASE-005-technical-baseline.md` не существует и
он не требуется.

1. Использовать Windows 10 x64, Node.js 24.16.0, npm 11.13.0, Java 21,
   Chrome executable 151.0.7922.71 и Lighthouse 13.4.1. User-Agent Chrome
   при этом показывает сокращённый токен `HeadlessChrome/151.0.0.0`.
2. На чистом checkout `TESTED_BASELINE_SHA` выполнить `npm ci`.
3. Создать только локальный, git-ignored файл `.env.emulator.local`:

```dotenv
VITE_APP_ENV=development
VITE_USE_FIREBASE_EMULATORS=true
VITE_FIREBASE_API_KEY=local-emulator-only
VITE_FIREBASE_AUTH_DOMAIN=demo-finapp.invalid
VITE_FIREBASE_PROJECT_ID=demo-finapp
VITE_FIREBASE_STORAGE_BUCKET=demo-finapp.invalid
VITE_FIREBASE_MESSAGING_SENDER_ID=000000000000
VITE_FIREBASE_APP_ID=local-emulator-only
VITE_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
VITE_FIREBASE_FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
```

4. В первом терминале запустить эмуляторы без import/export:

```powershell
npx firebase emulators:start --project demo-finapp --only auth,firestore
```

Дождаться готовности Auth на `127.0.0.1:9099` и Firestore на
`127.0.0.1:8080`.

5. Во втором терминале собрать emulator-mode и запустить preview только на
   loopback:

```powershell
npm run build -- --mode emulator
npm run preview -- --host 127.0.0.1 --port 4173
```

6. В отдельный временный каталог установить инструменты, не меняя
   `package.json` и `package-lock.json`. Для повторной процедуры
   фиксируется Puppeteer 25.4.0; он используется только для подготовки
   изолированного профиля, а Lighthouse-измерение выполняет Lighthouse
   13.4.1:

```powershell
$baselineTools = Join-Path $env:TEMP "finapp-base-005-lighthouse"
$baselineCache = Join-Path $baselineTools "npm-cache"
New-Item -ItemType Directory -Force -Path $baselineTools | Out-Null
$env:PUPPETEER_SKIP_DOWNLOAD = "true"
npm install --prefix $baselineTools --cache $baselineCache --no-save lighthouse@13.4.1 puppeteer@25.4.0
```

7. Для login выполнить три запуска по
   `http://127.0.0.1:4173/finapp/#/login`; каждый запуск должен получить
   новый пустой `user-data-dir`. Для dashboard сначала открыть
   `http://127.0.0.1:4173/finapp/#/register` системным Chrome
   151.0.7922.71 через Puppeteer в отдельном временном `user-data-dir`,
   затем через настоящий двухшаговый UI заполнить только синтетические
   значения: имя, уникальный email в домене `.invalid`, пароль,
   подтверждение пароля, тип ООО и синтетическое название компании; ИНН
   оставить пустым. Дождаться фактического URL `/finapp/#/` и появления
   содержимого dashboard, закрыть Chrome и использовать тот же профиль для
   всех трёх dashboard-запусков. Прямые вызовы Auth API и обход
   `ProtectedRoute` не допускаются.
8. Каждый Lighthouse-запуск выполнять headless с системным Chrome и
   соответствующим изолированным профилем, сохраняя сырой JSON только во
   временный каталог. Эквивалентная форма команды:

```powershell
$env:CHROME_PATH = "<путь-к-chrome.exe-151.0.7922.71>"
node "$baselineTools\node_modules\lighthouse\cli\index.js" `
  "http://127.0.0.1:4173/finapp/#/login" `
  --chrome-flags="--headless=new --user-data-dir=<изолированный-профиль>" `
  --form-factor=mobile `
  --screenEmulation.mobile=true `
  --screenEmulation.width=412 `
  --screenEmulation.height=823 `
  --screenEmulation.deviceScaleFactor=1.75 `
  --throttling-method=simulate `
  --throttling.rttMs=150 `
  --throttling.throughputKbps=1638.4 `
  --throttling.requestLatencyMs=562.5 `
  --throttling.downloadThroughputKbps=1474.56 `
  --throttling.uploadThroughputKbps=675 `
  --throttling.cpuSlowdownMultiplier=4 `
  --only-categories=performance,accessibility,best-practices,seo `
  --output=json `
  --output-path="<временный-report.json>" `
  --quiet
```

Для dashboard заменить URL на
`http://127.0.0.1:4173/finapp/#/` и трижды использовать один
подготовленный авторизованный профиль. Перед принятием результата сверить
фактические параметры из raw JSON с evidence: viewport 412×823,
`deviceScaleFactor=1.75`, RTT 150 ms, download ≈1475 Kbps, upload
675 Kbps, CPU slowdown ×4, `simulate`.

9. Из трёх raw JSON для каждого маршрута извлечь категории, FCP, LCP,
   Speed Index, TBT и CLS; медиана считается отдельно по каждой метрике.
   Не коммитить raw reports, профиль, синтетический email или пароль.
10. Остановить preview и Emulator Suite обычным завершением процессов,
    без export/import; удалить `.env.emulator.local`, временные профили,
    raw reports и временный каталог инструментов. Не обращаться к staging
    или production Firebase.

Оригинальный временный automation-script и версия Puppeteer не были
включены в evidence коммита B. Поэтому сохранённые численные результаты
воспроизводятся методологически по процедуре выше, но это не обещание
побитового совпадения raw Lighthouse JSON на другом запуске. Версии
Chrome executable, User-Agent и Lighthouse, а также все параметры
эмуляции, viewport и throttling зафиксированы явно.

## Rollback

Ревёрт двух коммитов этой задачи (`chore(base-005): add reproducible
baseline tooling` и `docs(base-005): record technical baseline evidence`).
Внешние системы откатывать не требуется — эта задача не производила ни
одной внешней записи, кроме уже уничтоженного локального Emulator Suite.

## Следующий разрешённый пункт

Не определяется и не анализируется в рамках этой задачи. Следующий шаг —
независимый аудит именно `BASE-005`, НЕ `BASE-006`, НЕ `SEC-001` и НЕ
исправление любой из зафиксированных здесь находок.
