# BANK-ADR-001 — изолированное получение банковских данных

Статус: предложение для review; 2026-09-26. BANK-001 реализует только
контракты, валидацию, синтетический адаптер и серверную границу. Долговечное
хранилище, OAuth, worker и ledger publication — следующие этапы.

## Владение и доступ

Единственный tenant — `companyId`, не Firebase uid и не ИНН из браузера.
Все ключи включают компанию; компании с одинаковым внешним счётом всё равно
не делят документы, токены, курсоры, receipts или результаты.
Идентичность caller берётся только из проверенного `CallableRequest.auth`.
Существующие authz helpers применяются к exact company path. Предлагаемая
политика в рамках ADR-001: просмотр — active member; управление секретами,
согласиями, подключениями, отключение — active admin; запуск синхронизации
— active accountant/admin. Не вводятся новые роли или fallback на ownerId.
Политику согласовать при BANK-004 с canonical capabilities основной ветки.

Операции записи читают membership, maintenance, lifecycle компании,
feature flag, connection generation, consent и job fence **в той же
транзакции**, что фиксирует результат. Предварительного разрешения перед
сетевым запросом недостаточно. Worker использует server-owned job, заново
проверяет действующее право инициатора/владельца согласия; утрата права
останавливает работу до подтверждения другим администратором.

## Три разных канала

- API adapter: discovery счетов, остатки, страница операций, возможности
  авторизации/отзыва/инкремента. Cursor непрозрачен ядру, ограничен по длине.
- File adapter: проверенный формат, кодировка, размер, parse + provenance.
- Email adapter: проверенная доставка и вложение; это push-ingestion, без
  фиктивных `listAccounts`/`refreshToken`/поллинга банковского API.

Capabilities содержат неизвестные значения явно, а не обещают поддержку.
Неизвестный bankId или формат отклоняется. Реестр доступных адаптеров
отдельный от каталога потенциальных банков. Ни один метод платежей не нужен.

## Модель и пути будущего хранения (BANK-002)

Предлагаемые server-only коллекции в отдельном пространстве:

| Путь | Назначение |
|---|---|
| `bankCompanies/{companyId}` | tombstone/lifecycle и generation |
| `bankCompanies/{companyId}/connections/{id}` | bankId, channel, consent, status, epoch; только ссылка на секрет |
| `bankCompanies/{companyId}/accounts/{id}` | стабильная идентичность счёта и связь с финсчётом |
| `bankCompanies/{companyId}/operations/{id}` | только банковские данные и source revision |
| `bankCompanies/{companyId}/jobs/{id}` | lease, fence, retryAt, окно и cursor |
| `bankCompanies/{companyId}/receipts/{id}` | ingestion / публикация / сверка |
| `bankCompanies/{companyId}/outbox/{id}` | неизменяемые предложения для ledger |
| `bankCompanies/{companyId}/events/{id}` | allowlist событий без банковского payload |

Firestore implementation, Rules/IAM, индексы и retention отдельно
проектируются и проверяются emulator-тестами в BANK-002. Никаких
cloud-коллекций или миграций BANK-001 не создаёт. Клиенту — только DTO через
сервер; прямой client SDK доступ к bankCompanies запрещён при включении.

Деньги: signed minor units в десятичной **строке**, отдельно ISO currency
и exponent (первая реализация RUB/USD/EUR/CNY=2, JPY=0, KWD=3; остальное
отклоняется до регистрации валюты). Преобразование из decimal string через
BigInt; никогда через parseFloat/Number. Отрицательная сумма — списание.
Дата `YYYY-MM-DD` — банковская календарная дата, не UTC-сдвиг Date;
booking/value dates раздельны. Остаток хранится с asOf, не вычисляется
слепым применением каждой повторно полученной операции.

Operation хранит stable bank account key, provider ID при наличии,
booking date, value date, amount, status, purpose, counterparty реквизиты,
источник и revision. Не содержит categories/projects/comments/splits.
Ручная разметка остаётся отдельной ledger-сущностью. Обновление bank row
не заменяет пользовательские поля.

## Идентичность, повторы и исправления

Сильный ключ = company + bank + stable account + provider operation ID.
connection ID в ключ не входит: переподключение не создаёт новую операцию.
Сравниваются нормализованные банковские поля, не сырые JSON и не порядок
ключей. Совпадение сильного ключа и банковских полей — duplicate; изменение
полей — correction с ожидаемой revision и отдельной сверкой.

Одинаковая дата/сумма не даёт права удалять запись. Без сильного ключа
fingerprint — только кандидат на сверку; совпадение даже всех доступных
полей может быть двумя платежами. Сохраняем multiplicity и source lineage.
Повтор того же файла/письма закрывается receipt hash + row identity;
между API/file/email — alias сильных ID либо reconciliation decision.
Разные provider ID считаются разными операциями даже при равных суммах.
Проверки охватывают page boundaries, overlapping windows, retries и reconnect.

Перевод между своими счетами: две связанные банковские ноги; сначала
кандидат по двум принадлежащим компании счетам, валюте/сумме/референсу,
затем подтверждение. Он не становится доходом/расходом автоматически.
Исправление в закрытом периоде — `blocked_closed_period` на стороне ledger,
а банковский оригинал сохраняется; период не открывается фоновым заданием.

## Worker и выключение

Server-controlled flag отсутствует/невалиден/недоступен => off. Его
выключение запрещает connect/enqueue, следующий bank request, commit page
и publication. Уже начавшийся HTTP-запрос может завершиться, но его ответ
не применяется. Нужны AbortSignal/timeout и повторный transactional gate.
Off не должен мешать **отключению** и отзыву уже существующего подключения.

Job арендуется транзакционно с монотонным fencing token; сохранение страницы,
ingestion receipts и cursor атомарно. Lease expiry и старый fence запрещают
запись даже после рестарта. 429 учитывает Retry-After; 5xx/timeouts — capped
backoff+jitter; 401 — единственное сериализованное refresh с CAS версии
секрета; 403/revoked — requires_reauth/consent_revoked без бесконечных retry.
Не сохранять cursor раньше операций. Защита от циклических курсоров и
page limit: остановка с ошибкой, никогда ложное «полностью загружено».

Disconnect сначала увеличивает generation и блокирует новые commits,
потом отменяет jobs, удаляет секреты и пытается отозвать доступ у банка.
Повтор безопасен. Ошибка удалённого revoke не возобновляет локальный доступ.
Company deletion сначала создаёт tombstone/generation и останавливает
outbox; физическое удаление и retention — отдельная политика основной системы.
Events: `connection_disabled`, `consent_revoked`, `company_deleting` с
companyId, connectionId (если есть), generation, eventId, server timestamp.
Consumers принимают повторы и события не по порядку через generation.

## Контракт публикации и зависимость от ARCH

BANK не пишет `company_data`. Publication port принимает envelope v1:
companyId, stable operation key, source revision, expected ledger revision,
bank data, idempotency key и текущую generation. Результаты:
`applied(receiptId, ledgerId)`, `already_applied`, `needs_review`,
`blocked_closed_period`, `rejected`. Receipt и ledger write атомарны на
стороне получателя; повтор не меняет balance. Разметка не входит в envelope.
Право и generation проверяются на момент final commit, а не только выдачи
envelope. Пока такого получателя нет, port возвращает `publication_unavailable`.

Зависимости: ARCH-001 (schema/money), ARCH-002/003 (repositories/storage),
ARCH-004 (атомарные команды), ARCH-008 (устранение конкурентной legacy записи),
FIN-006 (closed period), canonical auth/capabilities PR 28 и lifecycle
SEC-008/009. BANK-005 проверяет эти условия по фактам перед подключением;
готового интерфейса в main сейчас нет. Готовность BANK-001/002 не означает
готовность основных отчётов.

## OAuth, secrets, email

Одноразовый случайный OAuth state хранится сервером в хэшированном виде с
TTL, uid, companyId, connectionId, generation, redirect URI из allowlist и
browser session binding. Callback потребляет state атомарно и заново
проверяет membership/lifecycle; companyId из query не является источником
истины. PKCE применять там, где поддерживается банком. Проверить issuer,
audience и identity организации; несовпадение счета с компанией требует
сверки. Callback logging должен исключать code/state/token и полный URL.

SecretStore — серверная граница для encrypted tokens/certificates с
версией и rotation; plaintext не попадает в Firestore DTO, Git, VITE_,
localStorage, audit, exceptions, screenshots. Выпуск/ротация сертификатов
проверяются с overlap и rollback; refresh-token CAS и lease защищают гонку.
Логи используют только allowlist event code/count/jobId, без суммы,
назначения, реквизитов, банковских ответов или текстов ошибок провайдера.

Email: server-owned random recipient mapping, подтверждённые банком счета,
проверенная подпись webhook почтового провайдера + timestamp/replay check,
SPF/DKIM/DMARC и ожидаемый sender domain из доверенного envelope. Одного
адреса и видимого From недостаточно. Вложения: size/count/MIME/magic,
кодировка, ограниченная распаковка, запрет активного содержимого, quarantine
при неоднозначности. Суммы/счета сверяются до допуска в outbox. Источник
«email» не превращает данные в подтверждённый банковский API-ответ.
