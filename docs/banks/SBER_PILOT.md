# Сбер: подготовка BANK-003/006

Статус: план, не исполненный пакет подключения. На 2026-09-26 нет bank
sandbox/live проверки, выбранного deployment target или рабочего callback.
Сообщение владельца об активном «Компаниям» принято как вводная, не как
доказательство получения выписки.

Для собственного ИП — изолированный company pilot «Компаниям». Для разных
клиентов — отдельный сервис «Платформам» и consent каждого клиента.
Связывание одного client_id/токена с произвольными companyId запрещено.

Официальная база: [наборы](https://developers.sber.ru/docs/ru/sber-api/start/overview),
[кабинет](https://developers.sber.ru/docs/ru/sber-api/start/connect),
[sandbox](https://developers.sber.ru/docs/ru/sber-api/start/sandbox),
[OAuth](https://developers.sber.ru/docs/ru/sber-api/start/oauth),
[REST выписка](https://developers.sber.ru/docs/ru/sber-api/specifications/statement/transactions).

REST — первый канал. MCP_COMMON/MCP_STATEMENT не требуются ядру. Метод
выписки требует GET_STATEMENT_ACCOUNT; окончательный read-only scope для
списка счетов и identity сопоставить с зарегистрированным набором и точным
методом. GET_CLIENT_ACCOUNTS из кабинета ещё не проверен вызовом. Не
запрашивать платежные/подписывающие полномочия «на будущее».

Сервер проверяет все страницы за каждый запрошенный банковский день.
`links.rel=next` определяет продолжение; next URL валидируется по host/path,
не используется как произвольный URL (SSRF). История метода — предыдущие
5 лет + текущий год; это не гарантия доступности каждого закрытого счёта.

## Что должно войти в конкретный пакет

| Поле | Условие перед предложением владельцу |
|---|---|
| Artifact | reviewed SHA адаптера и результаты local + sandbox tests |
| Окружение | явно выбранное pilot/staging, ID компании и allowlist одного счёта |
| Callback | реальный HTTPS URL с выбранного deploy target, зарегистрированный у банка; сейчас не придумывать домен |
| Секреты | client_id, secret, TLS certificate/key/passphrase в server secret store через защищённую консоль/CLI с stdin; не через чат/аргументы команд/скриншот |
| OAuth | одноразовый state с TTL и session binding, exact redirect, fresh membership/consent, company identity сверка |
| Ротация | сроки секрета/сертификата и токенов из конкретной выдачи; тест refresh CAS и alert до истечения |
| Preflight | off по умолчанию, verified admin, no payment scopes, allowlisted endpoint/TLS, лимиты запроса и периода |
| Прогон | один согласованный период, все страницы, counts, дебет/кредит/остатки по валютам, ручная сверка с исходной выпиской |
| Повтор | тот же период => тот же набор, нет повторных ledger writes |
| Safe-stop | flag off + generation++, jobs cancelled; in-flight result не публикуется |
| Rollback | остановить ingestion/publication, отозвать consent/токены, удалить секреты; не удалять учётные операции без отдельной корректировки |

Кабинет Сбера документирует различия срока токенов, созданных в кабинете и
после OAuth refresh, и ротацию client_secret. Не зашивать один постоянный
срок жизни в код; хранить фактические expiry и версию. Автоматическую
ротацию тестировать отдельно от получения первой выписки.

Действия владельца понадобятся после подготовки BANK-003: подтвердить
подключение «Платформам» для сервиса и предоставить доступ через безопасную
установку секретов. Для текущего локального BANK-001 это не требуется.
