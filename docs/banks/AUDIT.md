# BANK-000 — актуальный аудит

Проверка: 2026-09-26. Источник — Git и GitHub API, не историческая сводка.

| Объект | Проверенный результат |
|---|---|
| main / base | `6d713fe77164b5d7f096a85509d73b43bd9dad13` |
| Открытые PR на момент начала | Только [№28](https://github.com/Alexspb-spb1/finapp/pull/28), canonical permissions; HEAD `8526a791ce3f62dee5a64aa239b795c609a39226` |
| Активная execution-ветка | `execution/sec-006-gate-ga-r9-fix5`, `e1310e5` |
| Активная audit-ветка | `audit/sec-006-gate-ga-r9-fix5`, `25b6f3c` |
| Идентификаторы BANK | В файлах Markdown всех 46 полученных remote-веток и их именах BANK-000/001 не найдены |
| Изоляция | Новый worktree `finapp-banks`, BANK-000 от main; BANK-001 — отдельная ветка от main, логически зависит от ADR BANK-000 |
| Инструкции | `CLAUDE.md`, `REMEDIATION_PLAN.md`, ADR-001, `docs/remediation/EXECUTION_STATE.md`; AGENTS.md в дереве main отсутствует |
| Runtime среды | Node 24.19.0 / npm 11.9.0 / Java 17; repo требует Node 24.16.0 / npm 11.13.0, Functions Node 22, CI Java 21 |

Подтверждено кодом:

1. React/TypeScript, Firebase Auth/Firestore, Functions существуют.
2. `Accounts.tsx` и `Import.tsx` используют существующий импорт; parser и
   `bankStatementImport.ts` уже реализуют дедупликацию. Transaction содержит
   `bankOperationId`/`importFingerprint`. Их нельзя заменять независимо.
3. `companyStore.persist()` вызывает `setDoc(company_data/{saveId}, state)`
   с полной копией состояния и сохраняет её в localStorage. Поэтому
   фоновое добавление операции в этот документ затем может быть затёрто
   браузером. Нет безопасного моста для автоматического импорта в отчёты.
4. `functions/src/lib/authz.ts` уже содержит `requireAuth`,
   `requireVerifiedEmail`, `requireActiveMember`, `requireRole`,
   `requireNotInMaintenanceMode`, `validateRequest`.
   `requireActiveMember` принимает Transaction и читает канонический путь.
   Банковский модуль должен использовать эти функции, не свою модель ролей.
5. В main каноническая модель ещё не внедрена во всех клиентских путях;
   открытый PR 28 нельзя считать слитым или задеплоенным.
6. ARCH-001…010 уже планируют отдельные документы, repositories,
   атомарные команды, миграцию и cutover. BANK не выполняет свою миграцию.
7. Checkpoint main фиксирует SEC-006 с ограниченной live-проверкой;
   invitation-specific acceptance остаётся отдельным gate. Более свежие
   execution/audit-ветки продолжают этот поток. Не повторяем его запуски,
   не удаляем его тестовые остатки и не переносим их разрешения на банки.
8. CI запускается для PR в main; Pages запускается после успешного push-CI
   main. Создание Draft PR не деплоит; merge main может деплоить, поэтому
   не входит в текущую авторизацию. BANK-001 направляем отдельным PR в
   main (runtime не зависит от новых документов), чтобы existing CI
   проверил его точный SHA. Никакого изменения workflow для этого не нужно.

Команды baseline: `git status --short`, `git rev-parse HEAD`,
`git for-each-ref --sort=-committerdate`, `git grep` по всем remote refs,
чтение package scripts и обоих workflows. Рабочее дерево исходно чистое.

Внешние Firebase/банковские данные не читались; действующее облачное
окружение и опубликованные Rules не перепроверялись. Этот аудит — о коде.
