# BANK-000 — аудит и архитектура банковского модуля

Статус: PARTIAL — подготовлен для review; контрактные сведения/тарифы ряда
банков ещё требуют подтверждения. Ни один банк не подключён.

- Branch: `feature/bank-integrations-bank-000`
- Base: `6d713fe77164b5d7f096a85509d73b43bd9dad13`
- Result SHA: commit этого отчёта (проверяется Git/PR).

Исходное состояние и доказательства: `docs/banks/AUDIT.md`.
Изменены только новые файлы `docs/banks/*.md` и этот отчёт.
Подготовлены матрица 16 банков, отдельные API/file/email каналы, ADR,
модель tenancy, publication/lifecycle contracts и BANK-000…006 backlog.
Общая миграция/авторизация не меняются. Пилот Сбера — отдельный план.

Проверки: прочитаны main, PR28, активные ветки, CLAUDE, checkpoint, ADR,
relevant remediation dependencies; выполнен `git diff --check`.
Документационная задача не имеет искусственных runtime-тестов. Общие
runtime-проверки выполняются и фиксируются в BANK-001 на том же baseline.

Security: секреты/реальные данные не использованы. Cloud actions: нет.
Manual review: ссылки и матрица проверены; неизвестные поля помечены НП.
Rollback: закрыть Draft PR; после merge — revert документационного commit.
На данные rollback не влияет.

Ограничения: BANK-000 не подтверждает bank sandbox/live, pricing/contracts
и не меняет фактическое deployment состояние. Нужен независимый review.
Следующий разрешённый текущим заданием этап — BANK-001 (независимое ядро).
