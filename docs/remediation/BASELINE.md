# BASELINE — исходная точка remediation-плана

**Task:** BASE-001 — Зафиксировать исходный commit и заморозить функциональные изменения
**Дата фиксации:** 2026-07-13
**Зафиксировал:** Claude Code (сессия remediation/BASE-001-baseline)

Этот документ фиксирует объективно проверенное исходное состояние проекта
на момент начала remediation-плана. Значения, которые нельзя было надёжно
получить из репозитория или доступных инструментов, помечены
`OWNER_INPUT_REQUIRED` — они **не выдуманы**, а явно оставлены пустыми до
предоставления владельцем.

---

## 1. Commit SHA

| Ветка | HEAD SHA | Источник |
|---|---|---|
| `claude/repository-analysis-mkk7mg` (аудируемая ветка, `AUDITED_SOURCE_BRANCH`) | `b0680bf4dd7a2255a8861b846fdde64d90329c6d` | `git rev-parse origin/claude/repository-analysis-mkk7mg` |
| `remediation/main` (техническая ветка remediation, `BASE_BRANCH`) | `3c2ed4c2573252d9e7652b11809fa0a4bb574cbc` | `git rev-parse origin/remediation/main` |
| `remediation/BASE-001-baseline` (эта задача, создана от `remediation/main`) | `3c2ed4c2573252d9e7652b11809fa0a4bb574cbc` (на момент создания ветки) | `git rev-parse HEAD` |

Проверено: `git merge-base --is-ancestor origin/claude/repository-analysis-mkk7mg origin/remediation/main` → **YES** (ancestor).
`remediation/main` = `claude/repository-analysis-mkk7mg` (`b0680bf`) + 1 коммит `3c2ed4c` («Add files via upload» — добавлены `CLAUDE.md`, `REMEDIATION_PLAN.md`, `PROJECT_STATUS.md`).

**Исходная точка remediation-плана зафиксирована на `3c2ed4c2573252d9e7652b11809fa0a4bb574cbc` (`remediation/main`).**
С этого момента и до прохождения этапов 0–4 в эту ветку не должны попадать новые продуктовые фичи — только remediation-задачи по одной за раз, по протоколу из `CLAUDE.md`.

---

## 2. Окружение выполнения (в этой рабочей сессии)

| Параметр | Значение | Источник |
|---|---|---|
| Node.js (локально/в этой сессии) | `v22.22.2` | `node --version` |
| npm (локально/в этой сессии) | `10.9.7` | `npm --version` |
| Node.js в CI (`deploy.yml`) | `20` (через `actions/setup-node@v4`, `node-version: 20`) | `.github/workflows/deploy.yml` |
| npm в CI | не зафиксирован явно — версия npm, поставляемая с Node 20 в образе `ubuntu-latest` на момент запуска | `.github/workflows/deploy.yml` |
| `.nvmrc` | **отсутствует** | проверено `test -f .nvmrc` |

**Находка:** локальная версия Node (22.x) не совпадает с версией CI (20.x), и нигде не зафиксирована единая поддерживаемая LTS-версия. Это прямо входит в объём `BASE-006` («Зафиксировать одну поддерживаемую версию Node.js в `.nvmrc` и CI») — в рамках `BASE-001` не исправляется, только зафиксировано как факт.

---

## 3. package.json — доступные npm scripts

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "lint": "eslint .",
  "preview": "vite preview"
}
```

Отсутствуют (проверено явным поиском в `package.json`): `typecheck`, `test`, `test:run`, `test:coverage`, `test:rules`, `test:e2e`.
Эти script появятся на задачах `BASE-005`/`TEST-001` — в рамках `BASE-001` не добавляются.

---

## 4. Firebase / CI конфигурация, зафиксированная в репозитории

- В репозитории **нет** `.firebaserc`, `firebase.json`, `firestore.rules`, `firestore.indexes.json` — проверено явно (`test -f` для каждого файла, результат — не найдено ни одного).
- `.env.example` содержит только плейсхолдеры (`VITE_FIREBASE_API_KEY=AIzaSy...` и т.д.), реальных значений нет.
- Реальный Firebase `projectId` нигде не закоммичен — в `.github/workflows/deploy.yml` он передаётся в build исключительно через `${{ secrets.VITE_FIREBASE_PROJECT_ID }}`, значение секрета недоступно для чтения из репозитория или через доступные инструменты этой сессии.
- CI-workflow: единственный файл — `.github/workflows/deploy.yml` (`Deploy to GitHub Pages`), триггеры: `push` в `main`, `pull_request` в `main` (job `build`: `npm ci` → `npm run lint` → `npm run build` → `upload-pages-artifact`), `workflow_dispatch`. Job `deploy` (публикация на GitHub Pages через `actions/deploy-pages@v4`) выполняется только при `push` в `main` (`if: github.event_name == 'push' && github.ref == 'refs/heads/main'`).

---

## 5. Последний production deployment — подтверждено через GitHub Actions API

Проверено вызовом `actions_list` / `actions_get` (GitHub REST API, read-only) для `Alexspb-spb1/finapp`, workflow `deploy.yml`:

| Параметр | Значение |
|---|---|
| Run ID | `29251907411` (run #64) |
| Статус | `completed` / `success` (оба job: `build` — success, `deploy` — success) |
| Ветка | `main` |
| Commit | `928940b6f79034b7a8beea6195e87b39609a3954` («Add files via upload», автор Малышев Александр, `lesenenok8787@gmail.com`, закоммичено через GitHub web UI — committer `GitHub`/`web-flow`) |
| Время запуска | `2026-07-13T12:58:27Z` |
| Время завершения job `deploy` | `2026-07-13T12:59:08Z` |
| Ссылка на run | https://github.com/Alexspb-spb1/finapp/actions/runs/29251907411 |

Предыдущий известный успешный deployment (для справки, как потенциальная точка отката):
Run `27843178903`, `2026-06-19T18:50:27Z`, commit `64343b7727b95ace56c751f779c5e1fb87860f09` («ui: full-width top bar…»), `success`.

**Текущий URL приложения:**
`https://alexspb-spb1.github.io/finapp/`
— определено с высокой уверенностью по конфигурации (публичный репозиторий `Alexspb-spb1/finapp`, `vite.config.ts` → `base: '/finapp/'`, workflow деплоит через официальный `actions/deploy-pages@v4` в environment `github-pages`, стандартный паттерн URL GitHub Pages для user-repo).
**Не подтверждено прямым HTTP-запросом** — у этой рабочей среды нет исходящего доступа в открытый интернет (проверено: `curl` к этому адресу вернул код `000`/таймаут). Владелец должен подтвердить, что это действительно текущий рабочий URL (и что кастомный домен, если он есть, не используется вместо него).

---

## 6. OWNER_INPUT_REQUIRED — не может быть получено из репозитория

Следующие данные не выдуманы и не предполагаются — они должны быть предоставлены владельцем до перехода к задачам, где они реально нужны (`BASE-002`–`BASE-004`):

- **`OWNER_INPUT_REQUIRED` — Firebase project ID для production.** В репозитории и доступных этой сессии инструментах реальный `projectId` нигде не хранится (только имя GitHub Secret `VITE_FIREBASE_PROJECT_ID`, без значения).
- **`OWNER_INPUT_REQUIRED` — ответственный за доступ к Firebase Console.** Из репозитория видно только, что GitHub-аккаунт `Alexspb-spb1` (Малышев Александр, `lesenenok8787@gmail.com`) — владелец репозитория и автор последнего коммита на `main`. Это **не то же самое**, что подтверждённый владелец/администратор Firebase-проекта — требуется явное подтверждение владельца.
- **`OWNER_INPUT_REQUIRED` — аварийные контакты** (кто и как эскалирует инцидент, если продакшн недоступен или скомпрометирован).
- **`OWNER_INPUT_REQUIRED` — подтверждённый способ аварийного отката production Firebase-данных/Rules.** Ниже описан только откат **клиентской статической сборки** (это выводится из механики самого CI/CD и не требует ввода владельца), а не откат Firestore Rules/данных — этим отдельно занимаются `BASE-003`/`BASE-004`.

### Производный (не выдуманный) способ отката клиентской сборки

Выводится напрямую из механики `deploy.yml` и GitHub Pages, без предположений о содержимом:

1. Каждый успешный `push` в `main` полностью пересобирает и переразворачивает статический сайт (`actions/deploy-pages@v4`), предыдущая версия не хранится как отдельный откатываемый релиз внутри GitHub Pages.
2. Для отката к конкретному прежнему состоянию сайта нужно либо:
   - выполнить `git revert` коммита(ов), внёсших нежелательное изменение, и запушить в `main` (это запустит новый `deploy` с прежним кодом), либо
   - вручную перезапустить (`re-run`) ранее успешный workflow run (например, run `27843178903` от `64343b7727...`) через `actions_run_trigger` / GitHub UI — это пересоберёт и передеплоит именно тот исходный код.
3. Откат **не затрагивает** Firebase Auth/Firestore — если проблема в данных или Security Rules, этот способ не поможет; для этого нужны `BASE-003` (backup/restore) и `BASE-004` (Rules baseline), которые ещё не выполнены.

---

## 7. Заморозка функциональных изменений

С момента фиксации этого baseline (`remediation/main` @ `3c2ed4c2573252d9e7652b11809fa0a4bb574cbc`) и до прохождения `GATE-0`–`GATE-4`:

- в `remediation/*` ветки не должны попадать новые продуктовые фичи, не относящиеся к текущему `TASK_ID` из `REMEDIATION_PLAN.md`;
- каждая remediation-задача выполняется в отдельной ветке от `remediation/main`, по одному `TASK_ID` за цикл;
- слияние в `remediation/main` выполняется только после `REVIEW_RESULT: PASS` для конкретного `TASK_ID` (см. `CLAUDE.md`, разделы 9 и 11).

Эта задача (`BASE-001`) сама изменений в функциональный код приложения не вносит.
