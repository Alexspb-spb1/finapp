# BANK-002 — durable banking ingestion

## Итоговый статус

PARTIAL — реализация и локальные проверки завершены; независимый review и
полный Functions emulator / exact-head GitHub CI текущей ветки не подтверждены.
Ничего не развёрнуто, модуль не включён. Дата: 2026-09-26.

## Branch / commit

- branch: `feature/bank-integrations-bank-002`
- base SHA: `a1cac9cbcdbfe132117f3f19e82777ab06463ed3` (BANK-001, Draft PR #30)
- result SHA: commit, содержащий этот отчёт; точный SHA указан в Draft PR.
- PR направлен в `feature/bank-integrations-bank-001`: один BANK-подэтап в diff.
  После принятия зависимости потребуются retarget в main и проверки нового HEAD.

## Проверенное исходное состояние

Main `6d713fe77164b5d7f096a85509d73b43bd9dad13`; PR #30 не принят, замечаний не
было на момент проверки. BANK-001 содержит только in-memory preview, identity
classifier и private auth boundary: отсутствуют storage, receipts и leases.
Baseline-тест импорта BankStore до реализации воспроизвёл missing module.
В финальном наборе вместо структурной проверки — проверки схем и реального
Firestore поведения. Общие authz helpers и default-deny Rules сохранены.

## Что изменено

- Изолированный Admin-SDK repository с проверенным server grant, canonical
  actor/grantor membership, account binding, consent и generations.
- Durable jobs, request idempotency, leases/fences, restart, bounded retry/backoff
  с Retry-After; terminal reauth/revocation блокирует остальные задания.
- Атомарная страница: banking rows + correction proposals + blocked outbox +
  receipt + cursor. Повтор после потери подтверждения безопасен.
- Strong IDs дедуплицируются между страницами/окнами/подключениями/каналами.
  Исправления не перезаписывают оригинал; одинаковое предложение не повторяется.
  Weak-ID occurrences сохраняются отдельно для сверки, без silent dedupe.
- Одностраничный worker: сеть вне транзакции, timeout/abort, свежий guard при
  commit, игнорирование запоздавшего ответа, безопасные категории ошибок.
- Disconnect, private company-deletion tombstone hook и operator-only policy
  generation helper. Нет запуска оператора, cloud migration или lifecycle wiring.
- Rules regression доказывает deny read/list/create/update/delete, включая admin.

## Почему это BANK-002

Только хранилище интеграционных данных и восстановление ingestion. Outbox
остаётся blocked; нет публикации, OAuth, UI, scheduler или реального адаптера.
`company_data`, ledger, frontend stores, Firebase exports, Rules и CI не менялись.
Схема и будущие consumer obligations описаны в storage/README.md.

## Затронутые файлы

- `functions/src/banks/storage/{schema,store,worker,policy}.ts`
- `functions/src/banks/storage/README.md`
- `functions/test/unit/banks/storage.test.ts`
- `functions/test/emulator/banksStorage.test.ts`
- `tests/rules/banks.test.ts`
- этот отчёт.

## Критерии приёмки

- [x] Server-only tenant isolation, canonical permissions, default-off.
- [x] Durable receipts, conservative dedupe, correction quarantine, blocked outbox.
- [x] Page/cursor atomicity; lost-ack replay; restart; lease/fence concurrency.
- [x] Отзыв прав/consent, disconnect, off/on, maintenance, deletion блокируют commit.
- [x] Local unit, Firestore concurrency, Rules deny, typecheck/lint/build.
- [ ] Независимый review, принятие BANK-001 и exact-head общий CI.
- [ ] Подключение реального банка и публикация — BANK-003/005, не этот этап.

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| root/functions `npm ci` | PASS | lockfiles не изменены |
| root `npm run lint` | PASS | baseline warning Balance.tsx:119 |
| root `npm run typecheck` | PASS | Node 24.16.0 / npm 11.13.0 |
| root `npm run test:unit` | PASS | 248 tests |
| root `npm run test:rules` | PASS | 129 tests, Java 21 |
| root `npm run test:migration` | PASS | 570 tests, 24 files, synthetic emulator |
| root `npm exec -- tsc --noEmit -p tests/rules/tsconfig.json` | PASS | новый Rules test типизирован |
| root `npm run build` | PASS | baseline large-chunk warning |
| functions lint/typecheck/build | PASS | Node 22.23.3 |
| functions `npm run test:unit` | PASS | 448 tests, включая 10 новых |
| Firestore-only bank integration command из storage/README | PASS | 42 tests, 35 новых |
| 17 existing invitation/staging/release self-test scripts из CI | PASS | только offline/synthetic self-tests |
| `git diff --check` | PASS | финальный staged diff |
| `npm run test:run` / `npm run test:e2e` | NOT AVAILABLE | scripts отсутствуют в package.json |
| Полный functions `npm run test:emulator` | NOT VERIFIED | ранее Functions runtime блокировался EPERM при bind /tmp/fire_emu_*.sock; повторно не запускался |
| Exact-head GitHub CI | NOT VERIFIED | workflow фильтрует PR base=main; текущий PR stacked |

Существенный вывод:

```text
BANK Firestore: 2 files, 42 tests passed
Functions unit: 20 files, 448 tests passed
Root unit: 17 files, 248 tests passed
Rules: 2 files, 129 tests passed
```

Проверены реальные транзакции эмулятора: конкурентные claims и overlapping jobs;
истёкший worker; неправильная последняя строка не создаёт частичных данных;
перезапуск с next cursor; empty intermediate page/loop; повтор correction;
запоздавший adapter response после восьми видов изменения доступа; off/on;
missing/corrupt state; consent expiry/grantor demotion; retry budget и abort.
На финальном прогоне конкурентных commits эмулятор один раз вернул code 3
`Transaction is invalid or closed`, который SDK не повторяет автоматически.
Тест теперь ждёт завершения обоих attempts, допускает только эту конкретную
ошибку и проверяет реальное восстановление lease/cursor до двух completed jobs
с одной receipt на каждый и без дополнительных rows/outbox. Другие ошибки
не поглощаются. Production code не получил emulator-specific retry обхода.
Все идентификаторы и суммы синтетические, реальные банки не вызывались.

## Security review

Самопроверка, НЕ Independent PASS. Browser не получает Admin-SDK methods.
Grant — отдельный доверенный server argument; BANK-003 обязан проверить
банковское согласие и владение счётом до вызова. Ошибки провайдера сохраняются
только enum-категориями. Никаких токенов, секретов или raw-response логов.
Every worker transaction rechecks current auth/consent/generation; stored leases
не являются бессрочной авторизацией. Policy off/on обязан использовать monotonic
operator helper; прямое переиспользование generation нарушает протокол.

## Данные и миграция

Внешних изменений нет. Только отдельные demo-emulator данные, с cleanup.
Не нужны backfill/dry-run/checksums production; идемпотентность и атомарность
проверены на синтетических фикстурах. Существующая разметка пользователя не
является частью банковской схемы, и код не имеет ledger writer.

## Ручная проверка

UI отсутствует по scope. Проверено, что storage не импортирован в Functions
index и нет deployment/scheduler/callable изменений. Ни flag, ни OAuth не
включались во внешнем окружении.

## Rollback

До merge закрыть Draft PR/не включать branch; текущая production не затронута.
После будущего merge revert BANK-002 commit в отдельном PR. Если позднее схема
будет развёрнута: сначала monotonic disable и остановка workers, затем отдельный
пакет rollback/backup. Не удалять данные автоматически и не откатывать generations.

## Известные ограничения

- Outbox — только blocked intents, не готовые PublicationEnvelope; ledger revision,
  manual resolution, closed periods и transfer handling появятся в BANK-005/ARCH.
- `staged` не означает approved. При позднем weak match прошлые strong rows не
  fan-out переписываются; будущий consumer обязан читать текущий matchBucket.
- Повтор слабых операций в новом overlapping job может дать новые кандидаты
  сверки. Без bank ID невозможно безопасно отличить одинаковые реальные платежи.
- Логическая инвалидизация не массово меняет сохранённые статусы заданий.
  Company tombstone hook пока не подключён к существующему удалению компании.
- Provider page <=100 rows/512 KiB, job <=1000 pages. BANK-003 должен обеспечить
  совместимую пагинацию; превышение отклоняется без обрезки и ложного completion.
- Только private API-page runner; реальная file/email verification и scheduling
  не реализованы. Persistent validation errors должен показывать будущий scheduler.

## Дополнительные находки вне scope

CI запускается только на PR в main. Изменение workflow/автодеплоя не требуется
для этого этапа и не выполнено. Baseline Balance.tsx warning и bundle warning
оставлены без несвязанных правок. BANK-001 остаётся Draft зависимостью.

## Diff summary

9 новых файлов: private storage/worker/policy/schema, contract documentation,
unit/emulator/Rules regression tests и этот отчёт. Нет изменённых existing files.

## Следующий пункт

BANK-003 — Sber adapter/OAuth/secret boundary. В этом цикле не начинался.
