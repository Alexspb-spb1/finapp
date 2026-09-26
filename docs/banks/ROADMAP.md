# BANK roadmap

2026-09-26. Один PR — один BANK-подэтап. Номера проверены на свободность
перед началом; это отдельный backlog, не переписывающий REMEDIATION_PLAN.
По текущему заданию выполняем BANK-000 и независимый BANK-001; следующие
этапы перечислены с зависимостями и точной границей, не объявлены готовыми.

| ID | Результат и критерий приёмки | Зависимости |
|---|---|---|
| BANK-000 | baseline SHA/PR, матрица 16 банков, ADR, границы, план и пилотный checklist; пробелы источников явные | актуальный main |
| BANK-001 | strict runtime contracts, точные деньги/даты, отдельные API/file/email ports, test bank, fail-closed серверный gate на существующих authz helpers; unit tests и общий regression | BANK-000; без сетевых банков/записи |
| BANK-002 | server-only durable repository, ingestion receipts, conservative dedupe, атомарная страница+cursor, leases/fences/restart, outbox; emulator concurrency tests | BANK-001; отдельное согласование схемы интеграционных файлов |
| BANK-003 | Sber REST adapter + OAuth state/callback, secret port, refresh CAS, TLS, contract tests; запуск sandbox только при доступе | BANK-002, документация конкретной версии/полные scopes |
| BANK-004 | отдельный экран выбора банка/счетов/даты, статусы, lastSync/count/error, refresh/reconnect/disconnect; stale-response/company-switch tests | BANK-001 contracts; монтирование после canonical capabilities/lifecycle |
| BANK-005 | idempotent server publication receipt и сохранение разметки; concurrent import/browser test, closed-period/transfer tests | ARCH-001…004 и безопасный cutover ARCH-008, FIN-006; не мигрировать внутри BANK |
| BANK-006 | Сбер pilot, полная пагинация и сверка каждой валюты: opening + credits − debits = closing, counts/IDs, повторный запуск и disconnect | BANK-003/005 + конкретное разрешение владельца |
| BANK-007 | следующий банк: предварительно Т-Банк, порядок уточнить по доступу; тот же adapter contract suite без изменения core | договор/доступ; отдельный PR |
| BANK-008… | Точка, Альфа, Модульбанк, затем остальные; отдельный BANK-ID на каждый адаптер | matrix, bank-specific contract fixtures |
| Далее | verified file ingestion и защищённый email ingestion отдельными подэтапами | BANK-002, allowlisted formats, mailbox provider |
| Далее | Google Sheets export подтверждённых ledger data, отдельное OAuth consent, receipt, повторяемый batch и retry | BANK-005; отдельные export permissions |

## Обязательные проверки по мере реализации

- Другой tenant, payload uid/role/company spoof, missing/disabled membership,
  revoked admin, invalid document IDs, повреждённое состояние => deny.
- Gate off и ошибка чтения flag => нет запросов к банку/записей; disconnect
  доступен при off. Revocation/off/delete во время запроса => результат отвергнут.
- Точные большие суммы, дробные границы, несколько exponent, leap-day,
  неверные даты/NaN/Infinity/лишние поля => проверены.
- Повтор page/window/file/email, reconnect, crash между read/commit, lease
  expiry, конкурентные worker => нет дублей/потерь; cursor и receipts атомарны.
- Исправление сохраняет category/project/comment/split; собственный перевод
  не удваивает доход; закрытый период не изменяется.
- Банковская pagination завершена по официальному признаку, а не пустому
  массиву; неверный cursor/loop прекращает загрузку без ложного успеха.
- Secret canary отсутствует в DTO/error/audit; raw bank response не логируется.
- Основной ФинУчёт собирается и проходит regression при выключенном модуле.
- Второй независимый тестовый adapter проходит тот же contract suite.

## Порядок PR и включения

1. BANK-000 Draft в main, только документация.
2. BANK-001 отдельный stacked Draft в ветку BANK-000, только ядро/тесты/отчёт.
3. После review BANK-000 — retarget BANK-001 и exact-head CI. Merge,
   deployment и облачные изменения не выполняются в этом задании.
4. BANK-002/003/004 можно готовить без production-разрешений банка.
   Завершение sandbox/live отмечать отдельно от synthetic.
5. До любого внешнего запуска подготовить artifact SHA, environment,
   target/resources/callback, scopes/secrets, команды, preflight, expected
   result, safe-stop, rollback, затем запросить разрешение на этот пакет.
