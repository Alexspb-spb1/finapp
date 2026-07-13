# BASE-001 — Зафиксировать исходный commit и заморозить функциональные изменения

## Итоговый статус
PARTIAL

## Branch / commit
- branch: `remediation/BASE-001-baseline`
- base SHA: `3c2ed4c2573252d9e7652b11809fa0a4bb574cbc` (`remediation/main`)
- result SHA: см. `git rev-parse HEAD` на ветке `remediation/BASE-001-baseline` — это коммит,
  добавляющий `docs/remediation/BASELINE.md` и этот отчёт поверх base SHA (единственный
  коммит задачи; итоговый хеш не фиксировался здесь заранее во избежание циклической ссылки
  «отчёт содержит хеш коммита, которым сам же добавляется»)

## Проверенное исходное состояние
- Подтверждено `git status --short` (чисто), `git branch --show-current`
  (`claude/repository-analysis-mkk7mg` в начале сессии), `git rev-parse HEAD`
  (`b0680bf4dd7a2255a8861b846fdde64d90329c6d`), `git log --oneline --decorate -10`.
- Ветка `remediation/main` изначально не была получена локально (`git fetch`
  требовался, чтобы её увидеть) — после `git fetch origin --prune` найдена
  на remote.
- `git merge-base --is-ancestor origin/claude/repository-analysis-mkk7mg
  origin/remediation/main` → **YES**: `remediation/main` действительно
  основана на аудируемой ветке, как и утверждалось в задаче.
- `remediation/main` = `claude/repository-analysis-mkk7mg` (`b0680bf`) + 1 коммит
  `3c2ed4c` («Add files via upload»), которым добавлены `CLAUDE.md`,
  `REMEDIATION_PLAN.md`, `PROJECT_STATUS.md`. Всё три файла подтверждены
  `git ls-tree -r --name-only origin/remediation/main`.
- Ветка `remediation/BASE-001-baseline` создана строго от `remediation/main`,
  как требует запись `BASE-001` в `REMEDIATION_PLAN.md`.
- Последний production deployment подтверждён независимо через GitHub
  Actions REST API (`actions_list` / `actions_get`, read-only), а не
  предположен — см. `docs/remediation/BASELINE.md`, раздел 5.

## Что изменено
- Создан `docs/remediation/BASELINE.md` (новый файл) с зафиксированным
  commit SHA, версиями Node/npm, доступными npm scripts, состоянием
  Firebase/CI-конфигурации в репозитории, подтверждённым фактом последнего
  production deployment и явными `OWNER_INPUT_REQUIRED` там, где данные
  нельзя получить из репозитория.
- Создан этот отчёт `docs/remediation/reports/BASE-001.md`.
- Функциональный код приложения **не изменён**.

## Почему изменения входят в текущий пункт
Ровно те действия, что перечислены в `REMEDIATION_PLAN.md` для `BASE-001`:
зафиксировать SHA, создать `docs/remediation/BASELINE.md` с перечисленными
полями, задокументировать заморозку функциональных изменений до
прохождения `GATE-0`. Ветка `remediation/main` уже была создана владельцем
до начала задачи — по условию задачи она не пересоздавалась и не менялась.

## Затронутые файлы
- `docs/remediation/BASELINE.md` (новый)
- `docs/remediation/reports/BASE-001.md` (новый, этот файл)

## Критерии приёмки
- [x] существует неизменяемая исходная точка — зафиксирована как
      `remediation/main @ 3c2ed4c2573252d9e7652b11809fa0a4bb574cbc`
      (проверено `git rev-parse`, не предположено).
- [x] понятно, из какого commit выполняется аудит и исправление — оба SHA
      (`claude/repository-analysis-mkk7mg` и `remediation/main`) зафиксированы
      и связь между ними подтверждена `merge-base --is-ancestor`.
- [ ] новые feature-PR не смешиваются с remediation — **это организационное
      правило, а не проверяемое инструментами условие сейчас.** Правило
      явно зафиксировано в `BASELINE.md` (раздел 7), но я не могу
      технически гарантировать, что владелец или кто-то ещё не запушит
      функциональный код напрямую в `remediation/main` в будущем — это
      вне возможностей текущей задачи (потребовался бы, например, branch
      protection на GitHub, что не входит в объём `BASE-001` и не было
      запрошено).

## Проверки
| Команда | Результат | Примечание |
|---|---|---|
| `git status --short` | PASS | чисто на каждом шаге, посторонних изменений не было |
| `git branch --show-current` | PASS | зафиксировано на каждом этапе |
| `git rev-parse HEAD` | PASS | зафиксировано для всех трёх релевантных веток |
| `git log --oneline --decorate -10` | PASS | вывод приложен ниже |
| `git merge-base --is-ancestor origin/claude/repository-analysis-mkk7mg origin/remediation/main` | PASS | подтверждено: YES |
| `node --version` | PASS | `v22.22.2` (локально в этой сессии) |
| `npm --version` | PASS | `10.9.7` (локально в этой сессии) |
| `npm ci` | PASS | 311 packages, 3 известные уязвимости (не в объёме `BASE-001`, будет `BASE-005`) |
| `npm run lint` | PASS | 0 ошибок, 0 предупреждений |
| `npm run typecheck` | NOT AVAILABLE | script отсутствует в `package.json`; появится в `BASE-005`/`TEST-001` |
| `npm run test:run` | NOT AVAILABLE | script и тестовая инфраструктура отсутствуют; появится в `TEST-001` |
| `npm run test:rules` | NOT AVAILABLE | script и `firestore.rules` отсутствуют; появится в `BASE-004`/`SEC-011` |
| `npm run test:e2e` | NOT AVAILABLE | script и Playwright-конфигурация отсутствуют; появится в `TEST-001` |
| `npm run build` | PASS | `tsc -b && vite build` — успешно, один чанк ~1.88 МБ (известное, не в объёме `BASE-001`) |
| `git diff --check` | PASS | exit code 0, конфликтов пробелов/маркеров нет |
| `git status --short` (финально) | PASS | только новые файлы этой задачи |

## Фактический вывод существенных тестов
```text
$ git merge-base --is-ancestor origin/claude/repository-analysis-mkk7mg origin/remediation/main && echo "YES - ancestor"
YES - ancestor

$ npm run build (хвост)
vite v8.0.13 building client environment for production...
✓ 2367 modules transformed.
dist/index.html                     0.47 kB │ gzip:   0.29 kB
dist/assets/index-DfxZYI-H.css     61.74 kB │ gzip:  10.53 kB
dist/assets/index-3wrtej2p.js   1,879.13 kB │ gzip: 540.35 kB
✓ built in 1.44s

$ npm run lint
> eslint .
(без вывода — 0 ошибок)
```

GitHub Actions API (read-only, репозиторий `Alexspb-spb1/finapp`):
```text
run 29251907411 — build: success, deploy: success
branch: main, commit 928940b6f79034b7a8beea6195e87b39609a3954
created_at: 2026-07-13T12:58:27Z, deploy completed_at: 2026-07-13T12:59:08Z
html_url: https://github.com/Alexspb-spb1/finapp/actions/runs/29251907411
```

## Security review
- Секреты, токены, пароли, service account JSON или production-данные в
  созданные файлы **не записывались** — проверено визуально при
  составлении `BASELINE.md`: единственное персональное данное — публичный
  email автора коммита `928940b6f7` (`lesenenok8787@gmail.com`), который
  уже открыто виден в истории публичного GitHub-репозитория через
  `git log`/GitHub UI, то есть не является новым раскрытием.
- Реальный Firebase `projectId` не был и не мог быть получен из доступных
  этой сессии источников — явно помечен `OWNER_INPUT_REQUIRED`, а не
  предположен по названию репозитория/проекта.
- Live-URL приложения указан с пометкой уровня уверенности («определено по
  конфигурации, не подтверждено HTTP-запросом») — сессия не имеет
  исходящего доступа в открытый интернет (проверено: `curl` вернул код `000`).

## Данные и миграция
- нет — `BASE-001` не затрагивает данные Firestore/Auth, миграций не выполнялось.

## Ручная проверка
- Не выполнялась и не требовалась: `BASE-001` — документационная задача,
  не изменяющая поведение приложения. Живое приложение не открывалось и не
  тестировалось вручную в рамках этой задачи.

## Rollback
- Откатить эту задачу: удалить ветку `remediation/BASE-001-baseline`
  локально/на remote (она никуда не смёржена и не запушена в рамках этой
  сессии — push не выполнялся, как и требует протокол).
- Данные не менялись, откатывать в Firebase/Firestore нечего.

## Известные ограничения
- Live URL приложения (`https://alexspb-spb1.github.io/finapp/`) указан с
  высокой, но не стопроцентной уверенностью — не подтверждён прямым HTTP-запросом
  из-за отсутствия исходящего интернет-доступа в этой рабочей среде.
  Владелец должен подтвердить его самостоятельно (открыть в браузере).
- Firebase project ID, ответственный за Firebase Console, аварийные
  контакты и подтверждённый способ отката production Firestore-данных/Rules
  **не установлены** — явно помечены `OWNER_INPUT_REQUIRED` в
  `docs/remediation/BASELINE.md` (раздел 6). Эти пробелы блокируют переход
  к `BASE-002`–`BASE-004`, но не блокируют сам факт фиксации baseline.
- Правило «не смешивать remediation с feature-PR» зафиксировано
  документально, но не обеспечено технически (нет branch protection) —
  см. критерии приёмки выше.
- Push и merge не выполнялись согласно протоколу («Разрешено создавать
  локальную task-ветку… Не выполняй push, если пользователь прямо не
  попросил»). Ветка существует только локально в этой сессии.

## Дополнительные находки вне scope
- Коммит `928940b6f79034b7a8beea6195e87b39609a3954` («Add files via
  upload») запушен **напрямую в `main`** через GitHub web UI (committer
  `GitHub`/`web-flow`), минуя PR/CI-ревью, и тут же вызвал реальный
  production deploy (run `29251907411`). Это не входит в объём `BASE-001`,
  но стоит учитывать в `BASE-006` (CI на PR) и как процессный риск —
  прямые пуши в `main` в обход ревью продолжают быть возможны.
- `.nvmrc` отсутствует, локальная версия Node (22.x) расходится с версией
  CI (20.x) — прямо относится к `BASE-006`, не исправлялось сейчас.
- `npm audit` при `npm ci` на этой ветке показал те же 3 известные
  уязвимости (включая high-severity `xlsx`), что уже зафиксированы в
  `PROJECT_STATUS.md` — подробная фиксация версий/аудита относится к
  `BASE-005`, здесь только подтверждено, что состояние не изменилось.

## Diff summary
```text
 docs/remediation/BASELINE.md | 123 +++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 123 insertions(+)
```
(плюс этот отчёт, добавленный после снятия diff --stat)

## Следующий разрешённый пункт
- `BASE-002` — Создать отдельное staging Firebase-окружение.
- **Не начинать.**
