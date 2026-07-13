# BASE-001 — Зафиксировать исходный commit и заморозить функциональные изменения

## Итоговый статус
READY_FOR_REVIEW

## Branch / commit
- branch: `remediation/BASE-001-baseline`
- base SHA: `3c2ed4c2573252d9e7652b11809fa0a4bb574cbc` (`remediation/main`)
- task commits, подготовленные к первоначальному ревью (в порядке коммита):
  1. `e3226a8fb3cc6c355bba4bd6a871dca49527254a` — создание `BASELINE.md` и первой версии отчёта
  2. `166e3cf83af7d9cd2aab5cf4015bf86a8a0e6822` — внесение `OWNER_INPUT`, удаление лишних персональных данных, rollback-процедура
- canonical review head **не фиксируется как значение внутри этого файла**:
  итоговый SHA коммита, который добавит очередную версию самого отчёта,
  нельзя надёжно встроить в содержимое этого же коммита без самоссылки
  (хеш коммита вычисляется по его содержимому, включая этот файл — записать
  в файл SHA коммита, которым сам файл коммитится, невозможно без
  дополнительного коммита после). Canonical review head фиксируется внешне:
  актуальный `HEAD` ветки `remediation/BASE-001-baseline` на GitHub
  (https://github.com/Alexspb-spb1/finapp/tree/remediation/BASE-001-baseline)
  и в независимом review verdict, который ссылается на конкретный SHA на
  момент ревью.

## Исправления по независимому ревью

`REVIEW_RESULT: CHANGES REQUIRED` от независимого ревьюера указал на три
документационных замечания. Каждое перепроверено независимо (не принято на
слово) перед исправлением — командой `git diff --name-status <base> <commit>`:

1. **`BASELINE.md`, описание коммита `3c2ed4c` (раздел 1):** утверждалось,
   что коммитом добавлены `CLAUDE.md`, `REMEDIATION_PLAN.md` и
   `PROJECT_STATUS.md`. Проверено: `git diff --name-status b0680bf 3c2ed4c`
   → только `A CLAUDE.md`, `A REMEDIATION_PLAN.md`. `PROJECT_STATUS.md`
   уже существовал в родительской ветке `claude/repository-analysis-mkk7mg`
   (создан коммитом `0a0ea3e` в предыдущей сессии) — этим коммитом не
   добавлялся. **Исправлено.**
2. **`BASELINE.md`, раздел 8.1 (known-good production commit `928940b`):**
   утверждалось, что коммит добавил ту же тройку документов. Проверено:
   `git diff --name-status 64343b7727... 928940b6f7...` → только
   `A CLAUDE.md`. `REMEDIATION_PLAN.md` и `PROJECT_STATUS.md` на `main`
   вообще отсутствуют. **Исправлено** — вывод «клиентский бандл не
   изменился» сохранён, но обоснование переписано: коммит менял только
   корневой `CLAUDE.md`, не подключённый в Vite-сборку.
3. **`reports/BASE-001.md`, строка `result SHA: см. git rev-parse HEAD`:**
   нестабильная самоссылка. Заменена на список task commits, подготовленных
   к ревью (`e3226a8`, `166e3cf`), плюс явное пояснение, почему canonical
   review head фиксируется внешне (на GitHub и в review verdict), а не как
   значение внутри этого же файла — см. раздел «Branch / commit» выше.

Дополнительно выполнена проверка всего `BASELINE.md` на другие подобные
утверждения (`grep` по именам всех трёх файлов) — других мест с ошибочной
атрибуцией не найдено; оставшиеся упоминания `CLAUDE.md`/`REMEDIATION_PLAN.md`
в файле — это ссылки на сами файлы правил, а не утверждения о содержимом
конкретных коммитов.

## Проверенное исходное состояние
- Подтверждено `git status --short` (чисто), `git branch --show-current`
  (`remediation/BASE-001-baseline`), `git rev-parse HEAD`, `git log --oneline -5`
  в начале этого цикла.
- Повторно подтверждено: `remediation/main` (`3c2ed4c`) = `claude/repository-analysis-mkk7mg`
  (`b0680bf`) + 1 коммит «Add files via upload».
- Последний production deployment подтверждён независимо через GitHub Actions
  REST API (`actions_list`/`actions_get`) в предыдущем цикле — см.
  `docs/remediation/BASELINE.md`, раздел 5.
- Проверка «нет открытых feature-PR в `remediation/main`» (см. критерии
  приёмки ниже) выполнена доступной заменой: GitHub PR API в этой сессии
  недоступен (`github` MCP требует OAuth-авторизацию, сессия неинтерактивна —
  это ограничение инструмента, а не результат проверки). Выполнен
  `git fetch origin --prune` + `git ls-remote --heads origin`: на remote
  ровно три ветки (`claude/repository-analysis-mkk7mg`, `main`,
  `remediation/main`), дополнительных feature-веток нет. Ограничение метода
  зафиксировано честно: PR из форков этим способом не видны (см.
  `BASELINE.md`, раздел 7.1).

## Что изменено
- `docs/remediation/BASELINE.md`:
  - раздел 5 — убрано личное имя/email автора коммита (было не обязательно
    для `BASE-001`, оставлена только техническая атрибуция committer);
  - раздел 6 — заменён на фактические данные из `OWNER_INPUT` (Firebase
    project ID `finapp-prod-10a83`, ответственный за Firebase Console,
    публичный аварийный контакт), с явной пометкой, что project ID заявлен
    владельцем и не подтверждён технически этой сессией; приватные
    телефон/email прямо зафиксированы как хранящиеся вне репозитория;
  - добавлен раздел 8 — точная процедура возврата предыдущей версии
    клиентской сборки на основании `.github/workflows/deploy.yml`
    (два способа отката, known-good/fallback коммиты, способ проверки
    результата, условия признания rollback неуспешным) — только
    документация, ничего не выполнялось;
  - добавлен подраздел 7.1 — фиксация проверки отсутствия открытых
    feature-PR и её метода/ограничений.
- `docs/remediation/reports/BASE-001.md` — обновлён под новое состояние
  (этот файл).
- Функциональный код приложения по-прежнему **не изменён**.

## Почему изменения входят в текущий пункт
Все правки — прямое продолжение `BASE-001`: уточнение полей, явно
перечисленных в `REMEDIATION_PLAN.md` для `docs/remediation/BASELINE.md`
(Firebase project ID, ответственный, аварийные контакты, способ вернуть
предыдущую сборку), плюс удаление избыточных персональных данных и
перепроверка критерия приёмки — без выхода за рамки задачи.

## Затронутые файлы
- `docs/remediation/BASELINE.md` (изменён)
- `docs/remediation/reports/BASE-001.md` (изменён, этот файл)

## Критерии приёмки
- [x] существует неизменяемая исходная точка — `remediation/main @ 3c2ed4c2573252d9e7652b11809fa0a4bb574cbc`.
- [x] понятно, из какого commit выполняется аудит и исправление — оба SHA
      зафиксированы, связь подтверждена `merge-base --is-ancestor`.
- [x] новые feature-PR не смешиваются с remediation — отмечено выполненным
      как **процессное ограничение**: открытых feature-PR с target
      `remediation/main` доступными инструментами не обнаружено (см. выше),
      запрет смешивания зафиксирован в `CLAUDE.md` и `BASELINE.md` §7.
      Техническая защита веток (branch protection) сознательно не входит в
      объём `BASE-001` — это отдельный будущий пункт, отсутствие которой не
      отменяет выполнение текущего процессного критерия.

## Проверки
| Команда | Результат | Примечание |
|---|---|---|
| `npm ci` | PASS | 311 packages; 3 известные уязвимости (не в объёме `BASE-001`, будет `BASE-005`) |
| `npm run lint` | PASS | 0 ошибок, 0 предупреждений |
| `npm run build` | PASS | `tsc -b && vite build` — успешно |
| `git diff --check` | PASS | exit code 0 |
| `git status --short` | PASS | чисто после коммита |
| `npm run typecheck` / `test:run` / `test:rules` / `test:e2e` | NOT AVAILABLE | скрипты отсутствуют в `package.json` — вне объёма `BASE-001`, появятся в `BASE-005`/`TEST-001`/`SEC-011` |

## Фактический вывод существенных тестов
```text
$ npm ci
added 311 packages, and audited 312 packages
3 vulnerabilities (1 low, 2 high)

$ npm run lint
> eslint .
(без вывода — 0 ошибок)

$ npm run build
vite v8.0.13 building client environment for production...
✓ 2367 modules transformed.
dist/index.html                     0.47 kB │ gzip:   0.29 kB
dist/assets/index-*.css            61.74 kB │ gzip:  10.53 kB
dist/assets/index-*.js           1,879.13 kB │ gzip: 540.35 kB
✓ built in <2s

$ git diff --check
(exit code 0, без вывода)

$ git fetch origin --prune && git ls-remote --heads origin
b0680bf... refs/heads/claude/repository-analysis-mkk7mg
928940b... refs/heads/main
3c2ed4c... refs/heads/remediation/main
(других веток нет)
```

## Security review
- Личное имя и email автора коммита `928940b6f7` удалены из
  `BASELINE.md` и отчёта по прямому указанию владельца — в файлах остаётся
  только техническая атрибуция (committer `GitHub`/`web-flow`), без ФИО/email.
- Приватные телефон, личный email, пароли, токены, service account JSON,
  секреты GitHub Actions — не записывались и не запрашивались; приватные
  контакты явно задокументированы как хранящиеся вне репозитория, у
  владельца.
- Firebase project ID (`finapp-prod-10a83`) записан как **заявленный
  владельцем** факт, с явной оговоркой, что эта сессия не может независимо
  подтвердить его техническим путём (нет доступа к Firebase Console/CLI, а
  значение секрета GitHub Actions по-прежнему нечитаемо из репозитория).
- Раздел 8 (`BASELINE.md`) документирует rollback-процедуру, но explicitly
  требует `PRODUCTION_ACTION_APPROVED` перед фактическим выполнением —
  ничего не запускалось.

## Данные и миграция
- нет — `BASE-001` не затрагивает данные Firestore/Auth, миграций не выполнялось.

## Ручная проверка
- Не выполнялась и не требовалась: `BASE-001` — документационная задача.
  Живое приложение не открывалось, deploy/rollback не запускался.

## Rollback
- Откатить эту задачу: `git reset` до `3c2ed4c2573252d9e7652b11809fa0a4bb574cbc`
  на ветке `remediation/BASE-001-baseline`, либо просто удалить ветку — она
  не смёржена в `remediation/main`/`main`.
- На remote после push будет существовать только сама ветка
  `remediation/BASE-001-baseline` — `remediation/main`/`main` не менялись
  и не будут меняться в рамках этой задачи.
- Данные не менялись, откатывать в Firebase/Firestore нечего.

## Известные ограничения
- Проверка отсутствия открытых feature-PR выполнена без прямого доступа к
  GitHub PR API (см. раздел «Проверенное исходное состояние») — методом
  замены (`git ls-remote`), с честно указанным ограничением (PR из форков
  не были бы видны).
- Firebase project ID подтверждён только словом владельца, не технически.
- Способ аварийного отката production **данных**/Firestore Rules всё ещё
  `OWNER_INPUT_REQUIRED` — покрыт только клиентский rollback сборки
  (`BASELINE.md` §8). Это ожидаемо: данные/Rules — предмет `BASE-003`/`BASE-004`.
- Live URL приложения по-прежнему не подтверждён прямым HTTP-запросом
  (нет исходящего интернет-доступа в этой рабочей среде).
- В приложении нет видимого индикатора версии/сборки — затрудняет ручную
  визуальную проверку результата будущего rollback (зафиксировано как
  находка в `BASELINE.md` §8.4).

## Дополнительные находки вне scope
- Коммит `928940b6f7` запушен напрямую в `main` через GitHub web UI, минуя
  PR/CI-ревью, и тут же вызвал реальный prod-деплой — относится к `BASE-006`.
- `.nvmrc` отсутствует, локальный Node (22.x) ≠ CI Node (20.x) — относится к `BASE-006`.
- `npm audit`: те же 3 известные уязвимости, включая high-severity `xlsx`,
  без изменений — подробная фиксация относится к `BASE-005`.

## Diff summary

Кумулятивно за все циклы `BASE-001` (от `remediation/main` @ `3c2ed4c`, оба файла новые для этой ветки):
```text
 docs/remediation/BASELINE.md         | 274 +++++++++++++++++++++++++++++++++++
 docs/remediation/reports/BASE-001.md | 227 +++++++++++++++++++++++++++++
 2 files changed, 501 insertions(+)
```

Только этот исправляющий коммит (реакция на `REVIEW_RESULT: CHANGES REQUIRED`,
приблизительно — правки самого раздела diff summary естественным образом
чуть меняют собственный размер при каждой правке, аналогично проблеме
самоссылки с SHA из замечания №3):
```text
 docs/remediation/BASELINE.md         | ~15 lines changed
 docs/remediation/reports/BASE-001.md | ~65 lines changed
 2 files changed
```
Точные числа для всего коммита — в `git diff --stat` после `git commit`, см. вывод в чате после push.

## Следующий разрешённый пункт
- `BASE-002` — Создать отдельное staging Firebase-окружение.
- **Не начинать.**
