# BANK-001 — независимое серверное ядро

## Итоговый статус

PARTIAL — независимое ядро реализовано и проверено на синтетических данных;
полный локальный Functions emulator заблокирован окружением. Требуется
независимый review и проверка CI актуального SHA перед принятием. Это не
утверждение о завершении всего банковского модуля или подключении банка.

## Branch / commit

- Branch: `feature/bank-integrations-bank-001`.
- Base: `6d713fe77164b5d7f096a85509d73b43bd9dad13` (`main`).
- Result SHA: Git commit этого отчёта / текущий HEAD Draft PR.
- Архитектура/исследование: отдельный BANK-000, PR 29. Runtime не зависит
  от его документов, поэтому BANK-001 также направлен в main для exact-head CI.

## Проверенное исходное состояние

Аудит BANK-000 подтвердил monodoc write path, существующие authz helpers и
открытый PR28. Банковских серверных модулей нет. До реализации создан
`contracts.test.ts`; запуск на baseline завершился `Cannot find module
../../../src/banks/money` (test collection failed). Это доказательство
отсутствующего модуля, не заявление о выполнении assertions в red-прогоне.

## Что изменено и почему входит в BANK-001

- Strict contracts для банковских сумм, дат, операций, счетов и connections;
  ограничены размеры, валюты и допустимые поля.
- API, email и file имеют разные интерфейсы. Добавлены job, lifecycle и
  publication contracts; единственный publisher явно отказывает в публикации.
- Точные minor units через BigInt: большие значения, отрицательные суммы,
  валюты с 0/2/3 знаками; числа с плавающей точкой на входе не принимаются.
- Conservative identity classifier: company/bank/account isolation,
  стабильный provider ID, corrections и ambiguous review. Нет ложного
  обещания durable dedupe/restart semantics.
- Серверный gate использует прежние authz helpers и canonical membership,
  проверяет компанию, maintenance и fail-closed flag. Для мутаций требуется
  Transaction; disconnect допускается при выключенном флаге.
- Явный реестр адаптеров пуст по умолчанию. Есть только synthetic bank и
  bounded preview; контроль до/после await, защита scope от изменения
  адаптером, межкомпанейной подмены, cursor loop и чрезмерной загрузки.
- 83 новых unit-теста и 7 Firestore integration tests. Второй тестовый API
  с другим курсором работает без изменения ядра.

Затронуты только новые файлы `functions/src/banks/`,
`functions/test/unit/banks/`, `functions/test/emulator/banksAccess.test.ts`
и этот отчёт. Изменений существующих файлов приложения нет.

## Критерии приёмки и проверки

| Проверка | Результат |
|---|---|
| Root npm ci | PASS, Node 24.16.0 / npm 11.13.0 |
| Functions npm ci | PASS, Node 22.23.3 / npm 11.9.0; Functions требует Node 22 |
| Root lint/typecheck/build | PASS; прежнее предупреждение Balance.tsx и большой bundle |
| Root unit | PASS, 248/248 |
| Root Rules emulator (Java 21.0.12.1) | PASS, 126/126 |
| Functions lint/typecheck/build | PASS |
| BANK unit | PASS, 83/83 |
| Functions все unit, включая BANK | PASS, 437/437 |
| BANK private guard, настоящий Firestore emulator | PASS, 7/7 |
| Full Functions emulator | BLOCKED locally: `listen EPERM /tmp/fire_emu_*.sock`; stopped with SIGINT after infrastructure error, не PASS |
| test:run / test:e2e | NOT AVAILABLE: таких scripts нет; использован существующий test:unit |
| Миграционные тесты | Не запускались локально: миграция не меняется; existing CI включает их |
| git diff --check | PASS |
| GitHub CI | Смотри проверки текущего SHA PR; это отдельное доказательство от локальных команд |

Существенный вывод:

```text
BANK:     Test Files 3 passed; Tests 83 passed
Functions Test Files 19 passed; Tests 437 passed
Root:     Test Files 17 passed; Tests 248 passed
Rules:    Test Files 1 passed; Tests 126 passed
BANK DB:  Test Files 1 passed; Tests 7 passed
```

В начале Java 17 блокировала Rules. Установлена локальная Java 21, затем
Rules успешно проверены. Локальные дополнительные runtime находятся вне
репозитория, package.json/lockfiles/workflows не изменялись. Ограничение
Unix-сокетов Functions не обходилось и не маскировалось; изолированная
проверка private guard использует только разрешённый Firestore emulator.

## Security review

Самопроверка, не независимый PASS: отсутствует клиентская точка входа,
альтернативные роли, browser secret, cloud write или bank endpoint.
Strict schema отвергает token/markup-поля; safe errors не передают provider
messages. Fixtures полностью синтетические. Tests проверяют payload/path
spoofing, company B без membership, revoked/corrupted role, flag off,
maintenance, удалённую компанию и invalid provider payload.

Отмена in-flight preview проверяется deferred promises без таймеров.
Она доказывает повторный вызов injected guard и отбрасывание результата;
production consent/generation/fence store этим не реализован.

## Данные, миграция, ручная проверка и rollback

Данные/миграция: нет. Компания и банковские данные в облаке не читались.
Во всех локальных emulator tests только demo-finapp и синтетические fixtures.
`companyStore`, `company_data`, финансовые модели, Rules, auth и deploy
не изменены. Модуль не экспортирован из Functions entrypoint и не входит
в браузерный bundle. Ручного UI/sandbox/live сценария нет.

Rollback: закрыть Draft PR; после отдельного разрешённого merge — revert
этого commit. Ни миграция, ни удаление данных не нужны, так как runtime
entrypoint не подключён.

## Известные ограничения / следующий этап

BANK-002: durable server repository, receipts, pagination checkpoints,
leases/fences, outbox и полный lifecycle в одной транзакции. До этого нет
гарантии идемпотентной фоновой синхронизации — её worker ещё не существует.
BANK-003: реальный Sber REST/OAuth/TLS/refresh и sandbox; BANK-004: экран.
BANK-005: безопасный publisher зависит от ARCH и canonical lifecycle.
Ни один банк не помечен sandbox-tested/live-verified. От владельца для
продолжения локальной разработки секреты или облачное разрешение не нужны.
