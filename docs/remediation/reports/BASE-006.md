# BASE-006 — Создать отдельный CI workflow для проверок PR

## Итоговый статус
READY_FOR_REVIEW

## Branch / commit
- branch: `remediation/BASE-006-ci`
- base SHA: `9800f88ab46bac36819bf82271d03f26cf8d5299` (PR #6 merge SHA, `origin/main`)
- result SHA: `ec20f33` (полный SHA см. `git show --stat --oneline HEAD` на ветке `remediation/BASE-006-ci`)

## Проверенное исходное состояние
- Подтверждено, что `origin/main` находится на ожидаемом SHA `9800f88ab46bac36819bf82271d03f26cf8d5299` и что PR #6 (BASE-005) смёржен именно этим коммитом (`gh pr view 6 --json state,mergedAt,mergeCommit`).
- Прочитано текущее содержимое `.github/workflows/deploy.yml` на `origin/main`: единственный workflow, объединяющий build+lint+build и deploy в одном файле, триггерится на `push`, `pull_request` и `workflow_dispatch`; job `deploy` защищён условием `github.event_name == 'push' && github.ref == 'refs/heads/main'`, но job `build` (lint + production build) выполнялся для любого PR без выделенного самостоятельного CI-workflow.
- Прочитано текущее содержимое `package.json` — не было полей `engines`/`packageManager`, не было `.nvmrc`.
- Baseline подтверждён: до изменений в репозитории не было отдельного `ci.yml`, не было пиннинга версии Node/npm.

## Что изменено
1. Создан `.nvmrc` с содержимым `24.16.0`.
2. В `package.json` добавлены `"engines": {"node": "24.16.0", "npm": "11.13.0"}` и `"packageManager": "npm@11.13.0"`. Проверено, что это НЕ меняет `package-lock.json` при `npm ci` (см. раздел «Проверки» и «Известные ограничения» — при явном `npm install --package-lock-only` lockfile получает добавочный блок `engines` в описании корневого пакета; это не используется ни локально в задаче, ни в CI/deploy, где применяется исключительно `npm ci`, и после проверки lockfile был возвращён в исходное состояние командой `git checkout -- package-lock.json`).
3. Создан `.github/workflows/ci.yml` — отдельный workflow `CI`:
   - триггеры: `pull_request` → `main`, `push` → `main`, `workflow_dispatch`;
   - `permissions: contents: read` (единственное право, ничего лишнего);
   - `concurrency` с `cancel-in-progress: true`;
   - `actions/checkout@v4`, `actions/setup-node@v4` (версия из `.nvmrc` через `node-version-file`), `actions/setup-java@v4` (temurin 21);
   - явная проверка совпадения фактической версии Node/npm с `package.json.engines` — CI падает при расхождении;
   - последовательность: `npm ci` → `npm run lint` → `npm run typecheck` → `npm run test:staging-preflight` → `npm exec -- tsc --noEmit -p tests/rules/tsconfig.json` → `npm run test:unit` → `npm run test:rules` → `npm run build`;
   - никаких Firebase secrets, `.env.local`, `npm audit`, `npm audit fix`, `npm update`, `firebase deploy`, `build:staging`.
4. Изменён `.github/workflows/deploy.yml`:
   - убран триггер `pull_request`;
   - вместо прямого `push`-триггера на job `build` теперь используется `workflow_run` на workflow `CI` (`types: [completed]`);
   - job `build` защищён условием `github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main'` (плюс отдельная ветка условия для ручного `workflow_dispatch`);
   - `checkout` использует точный `ref: ${{ github.event.workflow_run.head_sha || github.sha }}`, чтобы деплоился именно тот коммит, для которого CI был зелёным;
   - версия Node берётся из `.nvmrc` (`node-version-file`) вместо захардкоженной `20`;
   - шаги build/upload-pages-artifact/deploy-pages сохранены без изменений логики; production Firebase-переменные остаются только в этом workflow, после CI-гейта, и не логируются.

## Почему изменения входят в текущий пункт
Все изменения строго ограничены целью BASE-006 — отдельный CI workflow для проверок PR, не смешанный с деплоем, плюс минимально необходимая инфраструктура для его согласованной работы (пиннинг версии Node/npm через `.nvmrc`/`engines`, разведение deploy-workflow через `workflow_run`, чтобы деплой никогда не запускался напрямую по PR-событию и запускался только после успешного `CI` на `main`).

## Затронутые файлы
- `.github/workflows/ci.yml` (новый)
- `.github/workflows/deploy.yml` (изменён)
- `.nvmrc` (новый)
- `package.json` (добавлены `engines`/`packageManager`)
- `REMEDIATION_PLAN.md` (обновлены статусы BASE-005 → `[x]`, BASE-006 → `[-]`)
- `docs/remediation/reports/BASE-006.md` (этот отчёт)

## Критерии приемки
- [x] Отдельный workflow `CI`, независимый от деплоя, запускающий `npm ci`/lint/typecheck/staging-preflight/unit-тесты/Rules-тесты/production build на PR и push в `main`.
- [x] Деплой полностью разделён на `deploy.yml`, никогда не запускается напрямую по `pull_request`.
- [x] Деплой запускается только через `workflow_run` после успешного `CI` на `push` в `main`, с checkout на точный `head_sha`.
- [x] Версия Node зафиксирована через `.nvmrc` и используется в обоих workflow вместо хардкода.
- [x] `package.json` дополнен `engines`/`packageManager` без изменения `package-lock.json`.
- [x] В `ci.yml` нет Firebase secrets и запрещённых команд (`npm audit`, `npm audit fix`, `npm update`, `firebase deploy`, `build:staging`).
- [x] YAML-синтаксис обоих файлов проверен (`js-yaml` из `node_modules`, `actionlint` недоступен — см. ниже).
- [x] Проверка через реальный GitHub Actions run на Draft PR — PR #7, run `30717598459`, все 14 шагов job `ci` зелёные; `Deploy to GitHub Pages` не запустился для этого PR (подтверждено `gh run list` — последний Deploy run датирован мержем BASE-005, до создания этого PR).

## Проверки
| Команда | Результат | Примечание |
|---|---|---|
| `npm ci` | PASS | 929 packages, Node v24.16.0 / npm 11.13.0 |
| `npm run lint` | PASS | 0 errors, 1 pre-existing warning в `src/pages/Balance.tsx` (не входит в scope BASE-006, не исправлялся) |
| `npm run typecheck` | PASS | без вывода |
| `npm run test:staging-preflight` | PASS | 5/5 сценариев |
| `npm exec -- tsc --noEmit -p tests/rules/tsconfig.json` | PASS | без вывода |
| `npm run test:unit` | PASS | 9/9 тестов |
| `npm run test:rules` | PASS | 77/77 тестов (совпадает с ранее зафиксированным количеством), Java 21 (Temurin, портативная сборка) |
| `npm run build` | PASS | без секретов Firebase — сборка не требует их на этапе build (см. security review) |
| `git diff --check` | PASS | только предупреждение о LF/CRLF от Git (autocrlf), не ошибка whitespace |
| `git status --short` | PASS | только ожидаемые изменённые/новые файлы |
| `actionlint` | NOT AVAILABLE | не установлен в окружении; новую зависимость не добавлял (запрещено scope). Синтаксис проверен через `js-yaml`, уже присутствующий в `node_modules` |
| Проверка lockfile-эффекта от `engines` | ИНФОРМАЦИОННО | `npm install --package-lock-only` показал добавление блока `engines` в корневой пакет lockfile; `npm ci` (реально используемая команда) lockfile НЕ меняет — подтверждено дважды |
| `gh api repos/.../branches/main/protection` | Branch not protected (404) | зафиксировано честно, ничего не менялось |

## Фактический вывод существенных тестов
```text
test:rules:
 Test Files  1 passed (1)
      Tests  77 passed (77)
   Duration  8.94s

test:unit:
 Test Files  1 passed (1)
      Tests  9 passed (9)

test:staging-preflight:
✓ Все 5 сценариев staging-preflight прошли как ожидалось.
```

## Security review
- `ci.yml`: `permissions: contents: read` — никаких дополнительных прав. Нет обращений к `secrets.*`. Нет доступа к внешним Firebase-проектам — Rules-тесты идут исключительно через `demo-finapp` эмулятор (`firebase emulators:exec --project demo-finapp`).
- `deploy.yml`: `pull_request` триггер удалён — PR больше не может напрямую инициировать job `build`/`deploy`. `workflow_run` gate проверяет одновременно `conclusion == success`, `event == 'push'`, `head_branch == 'main'` — совпадение всех трёх условий делает невозможным запуск деплоя из PR-прогона `CI` или из прогона на другой ветке. Checkout использует точный `github.event.workflow_run.head_sha`, а не произвольный `main` на момент запуска деплоя — то есть деплоится именно проверенный CI коммит.
- Проверено на отсутствие цикла: `ci.yml` не триггерится на `workflow_run`, `deploy.yml` не триггерится на `push`/`pull_request` напрямую — цепочка `push → CI → workflow_run(CI) → Deploy` линейна, без циклов.
- Секреты Firebase (`VITE_FIREBASE_*`) остаются только в `deploy.yml`, шаг `build` job, после прохождения gate — не используются и не логируются в `ci.yml`.
- Локальный `npm run build` без каких-либо `VITE_FIREBASE_*` переменных окружения и без `.env.local` завершился успешно (см. `src/lib/firebase.ts` — `resolveFirebaseEnv` выполняется в рантайме браузера, а не во время `vite build`), что подтверждает: production build в CI не требует секретов и не блокируется их отсутствием.
- Скан обоих новых/изменённых workflow-файлов на токены/пароли/ключи/email/хосты/абсолютные пути — совпадений не найдено, кроме легитимных `${{ secrets.VITE_FIREBASE_* }}` ссылок в `deploy.yml` (без значений).

## Данные и миграция
- нет — задача не затрагивает данные, Firestore Rules, миграции.

## Ручная проверка
- После push и создания Draft PR необходимо подтвердить в GitHub Actions UI: `CI` автоматически запустился на PR, все шаги (`npm ci`, lint, typecheck, staging-preflight, rules-tsconfig typecheck, unit, rules, build) завершились успешно; `Deploy to GitHub Pages` НЕ запустился для события `pull_request` (workflow_run срабатывает только после push в `main`, чего на Draft PR не происходит).

## Rollback
- `git revert <result-SHA>` на ветке `remediation/BASE-006-ci` либо простое закрытие/непринятие PR — изменения ограничены workflow-файлами, `.nvmrc` и `package.json`; откат не затрагивает данные, Firestore Rules, зависимости в `package-lock.json` (не менялся).

## Известные ограничения
- `actionlint` недоступен в окружении — синтаксическая проверка выполнена через `js-yaml`, что подтверждает валидность YAML, но не заменяет полноценный line-level lint workflow-специфичных полей/схемы Actions.
- Реальное поведение `workflow_run` (включая корректную работу gate-условий и checkout на `head_sha`) может быть окончательно подтверждено только после реального прогона на GitHub — локально это не воспроизводимо. Будет проверено на этапе push/Draft PR перед финальным ответом пользователю.
- Branch protection для `main` на момент проверки отсутствует (`404 Branch not protected`) — зафиksировано как факт, никак не менялось в рамках этой задачи.
- Существующее предупреждение ESLint (`react-hooks/exhaustive-deps` в `src/pages/Balance.tsx`) не устранялось — вне scope BASE-006.

## Дополнительные находки вне scope
- Production-бандл (`dist/assets/index-*.js`, ~1.89 MB / gzip 544 KB) превышает предупредительный порог Vite (500 KB) — уже зафиксировано в BASE-005 (`TECHNICAL_BASELINE.md`), повторно всплывает при каждом build; не относится к CI-задаче.
- Branch protection для `main` не настроен — потенциальный отдельный пункт плана (например, требование прохождения `CI` перед merge через required status checks), не выполнялось и не предлагается к исполнению в рамках BASE-006.

## Diff summary
```text
 .github/workflows/deploy.yml | 13 +++++++------
 REMEDIATION_PLAN.md          |  6 ++++--
 package.json                 |  5 +++++
 3 files changed, 16 insertions(+), 8 deletions(-)
 (плюс новые файлы: .github/workflows/ci.yml, .nvmrc, docs/remediation/reports/BASE-006.md)
```

## Следующий разрешенный пункт
- BASE-007 (см. `REMEDIATION_PLAN.md`) — НЕ начинать.
