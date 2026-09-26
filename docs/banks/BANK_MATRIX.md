# Матрица банков

Дата проверки источников: **2026-09-26**. Это исследование доступных каналов,
не результат подключения. Все 16 адаптеров: **not_implemented**.
«Не подтверждено» означает пробел в проверенной публичной документации,
а не утверждение об отсутствии услуги. Тарифы РКО не равны стоимости API.
API эквайринга/СБП/курсов валют не считается API выписок по расчётному счёту.

## Канал, разные клиенты и требования

| Банк | Официальный канал выписок | Разные клиенты ФинУчёта | Договор / регистрация / сертификат | Read-only и отзыв | Источник |
|---|---|---|---|---|---|
| СберБизнес | Sber API REST; export 1C/MT940 | Да, набор «Платформам»; «Компаниям» только одна организация | Набор в договоре, client_id/secret, redirect, TLS-сертификат | GET_STATEMENT_ACCOUNT, минимальные identity/account scopes; отзыв consent/токенов и сертификата | S1–S5 |
| Т-Банк | T-API, GET /api/v1/statement | Есть прямая и партнёрская интеграция; нужна регистрация именно партнёрской | Учётная запись бизнеса и согласование партнёрского доступа; требования сертификата уточнить | Ограничить правами счетов/выписок; точный механизм отзыва партнёрского consent уточнить | T1–T2 |
| Альфа-Банк | Alfa API, statement/transactions | Официально описана B2B SaaS передача третьим лицам по согласию | Договор, developer portal, client ID/secret, TLS; точный профиль защиты выбранного сервиса уточнить | Только scopes выписок/счетов; отзыв договора описан в документации; consent revoke endpoint проверить | A1–A3 |
| Точка | Точка.API, счета/выписки | OAuth-приложение с разрешениями клиента; JWT собственной компании не заменяет этот сценарий | Регистрация OAuth-приложения, redirect/client credentials; отдельный сертификат не подтверждён | Выбирать read permissions; API consent lifecycle; окончательный revoke contract проверить | P1–P3 |
| Модульбанк | API, /v1/operation-history/{accountId} | Регистрация приложения описана; условия доступа к разным клиентам требуют подтверждения | Документация предлагает регистрацию через api@modulbank.ru; auth/scopes и сертификаты проверить до адаптера | Выписки — чтение; запрет платежных методов в адаптере, банковское ограничение токена/отзыв уточнить | M1 |
| ВТБ | Интеграционный Банк-Клиент, DirectBank; есть портал API | Доступ платформы к выпискам разных клиентов публично не подтверждён | Договор/подключение ИБК и актуальная спецификация; сертификаты по выбранному каналу | Ограничения полномочий и отзыв для сторонней платформы уточнить | V1–V3 |
| Газпромбанк | Host-to-host: обороты/остатки, DirectBank | Описаны компания и дочерние структуры; это не доказательство SaaS для независимых клиентов | Корпоративное согласование H2H; протокол/сертификаты получить у банка | Режим получения выписок; банковские read-only scopes и отзыв уточнить | G1 |
| ПСБ | H2H: рублёвые выписки; DirectBank | Публичный H2H для корпоративных клиентов, платформенный доступ не подтверждён | Условия корпоративного H2H и сертификатов согласовать | Read-only credentials / отзыв уточнить | B1–B2 |
| Совкомбанк | SCB Business API (host2host), запрос выписки | Подключение собственной ERP; multi-client SaaS не подтверждён | Согласование подключения услуги; профиль сертификатов не подтверждён | Отключение услуги по заявлению; granular read-only уточнить | C1–C2 |
| Россельхозбанк | «Свой Бизнес», выписки и 1C:DirectBank | Открытый API выписок для платформы не подтверждён | Клиент ДБО/DirectBank; самостоятельный SaaS-доступ и сертификаты уточнить | Файлы только на чтение; отдельные API права/отзыв неизвестны | R1 |
| МКБ | «Ваш Банк Онлайн», выписки/отчёты | API выписок для платформы не подтверждён | ДБО; платформенный договор/сертификаты неизвестны | Файл на чтение; API scopes/отзыв неизвестны | K1 |
| Уралсиб | «Уралсиб Бизнес Онлайн», DirectBank | API для независимой платформы не подтверждён | ДБО/DirectBank; требования стороннего приложения уточнить | Файл на чтение; API scopes/отзыв неизвестны | U1 |
| Ак Барс | ДБО: экспорт 1C, отправка email, рассылка выписок; DirectBank | Для email — собственная настройка каждой организации; общий API не подтверждён | ДБО; доверенный канал email и формат вложений требуется проверить | Только получаемые файлы; остановка рассылки в банке + локальный recipient revoke | Q1–Q2 |
| Банк «Санкт-Петербург» | Direct BSPB/1C: получение выписок | Платформенный API выписок не подтверждён | Рублёвый расчётный счёт, договор/настройка Direct BSPB | Банковские read-only права/отзыв уточнить | N1 |
| ДОМ.РФ | «Бизнес Онлайн», выписки по счетам | Платформенный API не подтверждён | ДБО; отдельное API соглашение/сертификаты неизвестны | Файл на чтение; API права/отзыв неизвестны | D1 |
| Райффайзенбанк | Актуальный developer portal: API выписок и Code Flow, sandbox | Технический Code Flow есть; приём нового SaaS-партнёра/клиентов не подтверждён | Договор, регистрация интеграции; текущие условия и защита канала уточнить | Минимальные permissions и revoke flow проверить | F1–F3 |

## История, обновление, лимиты, стоимость и тестовая среда

`НП` = не подтверждено в проверенных источниках, требуется уточнение до
промышленного включения. Частота локального scheduler — наше решение,
но она не может превышать условия банка. Наличие sandbox в документации
не означает, что мы получили в него доступ или выполнили запрос.

| Банк | История / обновление | Лимиты / стоимость | Sandbox | Внешний блокер / следующий шаг |
|---|---|---|---|---|
| Сбер | Предыдущие 5 лет + текущий год; дневная пагинация, отдельный increment текущего дня | 429 описан, численный RPS НП; подключение/API заявлены бесплатными | Официальная песочница, пока не вызывалась | «Платформам», конкретные scopes/TLS/redirect и секреты; сначала fixtures |
| Т-Банк | Параметры периода statement; допустимая глубина и polling НП | RPS/цена НП | Доступ тестового statement НП | Партнёрская регистрация и contract методов |
| Альфа | Период/пагинация statement; глубина и polling НП | RPS/цена НП | Есть официальная sandbox инструкция | Договор, client credentials/TLS, scopes |
| Точка | API выписок и webhook канал; глубина/частота НП | RPS/цена НП | Доступная нам песочница НП | OAuth registration/consent, limits, statement schema |
| Модульбанк | operation-history с records/skip; глубина/polling НП | RPS/цена НП | Описана ограниченная sandbox; history filters records/skip | Условия partner app, auth, актуальный API contract |
| ВТБ | ИБК/DirectBank; глубина/polling НП | RPS/цена НП | Портал предлагает тестирование; конкретная sandbox выписок НП | Доступ сторонней платформе, specs |
| Газпромбанк | H2H/DirectBank; глубина/polling НП | RPS/цена НП | НП | SaaS-договор и технический протокол |
| ПСБ | H2H/DirectBank; глубина/polling НП | RPS/цена НП | НП | Подтвердить SaaS либо регулярный email официально |
| Совкомбанк | H2H; глубина/polling НП | RPS/цена НП | НП | SaaS eligibility, спецификация и credential policy |
| Россельхозбанк | ДБО/DirectBank; глубина/polling НП | Лимиты/цена НП | НП | Проверенный файл выписки либо API договор |
| МКБ | Период выписки в ДБО; глубина/автообновление НП | Лимиты/цена НП | НП | Проверенный файл/официальный платформенный канал |
| Уралсиб | ДБО/DirectBank; глубина/частота НП | Лимиты/цена НП | НП | Проверенный файл/платформенная спецификация |
| Ак Барс | Email-рассылка; точное расписание/глубина НП | Лимиты/цена НП | НП | Доверенная доставка, реальный формат и account binding |
| Банк «Санкт-Петербург» | Direct BSPB; глубина/частота НП | Лимиты/цена НП | НП | Подтверждение самостоятельного доступа вне 1C |
| ДОМ.РФ | Выписки ДБО; глубина/автообновление НП | Лимиты/цена НП | НП | Проверенный формат файла/канал платформы |
| Райффайзенбанк | API выписок; глубина/частота НП | Лимиты/цена НП | Официально описаны Code Flow и synthetic statements | Проверить текущий onboarding, ограничения договора и доступ именно ФинУчёта |

## Источники

Все ссылки ниже проверялись 2026-09-26. Для Сбера получен полный текст.
Для T/Alfa/Точка/Модуль основные страницы обнаружены в официальном поисковом
индексе; повторное открытие части документации вернуло timeout/502. Поэтому
не заявляем полную проверку их схем/лимитов. Остальные страницы — официальные
инструкции/описания услуг, не автоматически разрешение на SaaS API.

- S1: https://developers.sber.ru/docs/ru/sber-api/start/overview
- S2: https://developers.sber.ru/docs/ru/sber-api/start/connect
- S3: https://developers.sber.ru/docs/ru/sber-api/scenarios/rko/statements/overview
- S4: https://developers.sber.ru/docs/ru/sber-api/specifications/statement/transactions
- S5: https://developers.sber.ru/docs/ru/sber-api/start/sandbox
- T1: https://developer.tbank.ru/docs/api/t-api
- T2: https://developer.tbank.ru/docs/api/get-api-v-1-statement
- A1: https://alfabank.ru/sme/alfaapi/
- A2: https://developers.alfabank.ru/products/alfa-api
- A3: https://developers.alfabank.ru/products/alfa-api/documentation/articles/connection/articles/instruction/instruction
- P1: https://developers.tochka.com/docs/tochka-api/
- P2: https://developers.tochka.com/docs/tochka-api/algoritm-raboty-po-oauth-2.0
- P3: https://developers.tochka.com/docs/tochka-api/api/rabota-s-razresheniyami
- M1: https://api.modulbank.ru/
- V1: https://developer.vtb.ru/
- V2: https://www.vtb.ru/malyj-biznes/otkryt-schet/distancionnoe-obsluzhivanie/integracionniy-bank-klient/
- V3: https://www.vtb.ru/malyj-biznes/online-servisy/directbank/
- G1: https://www.gazprombank.ru/corporate/page/h2h/
- B1: https://www.psbank.ru/corporate/dbo/host-to-host
- B2: https://www.psbank.ru/business/bookkeeping/direct_bank
- C1: https://sovcombank.ru/corp/rko/scb-business-api
- C2: https://sovcombank.ru/document/17714
- R1: https://www.rshb.ru/business/svoy-business-dbo
- K1: https://vbo-help.mkb.ru/ru/Выписки_и_отчеты
- U1: https://uralsib.ru/business/internet-bank
- Q1: https://corp.akbars.ru/ru/img/instr_abbd.pdf
- Q2: https://corp.akbars.ru/ru/img/instr_1C.pdf
- N1: https://www.bspb.ru/business/distant-services/1C
- D1: https://domrfbank.ru/corporate/online/bank/
- F1: https://developer.raiffeisen.ru/
- F2: https://developer.raiffeisen.ru/docs/sandbox
- F3: https://developer.raiffeisen.ru/docs/howToStart/tokens/howToGetTokensByCodeFlow

## Три канала и опыт Adesk

Изучены https://help.adesk.ru/article/8527 и
https://help.adesk.ru/article/8504 как пример UX: выбор банка, связка со
счётом, период первой загрузки, состояние интеграции. Описанный другим
сервисом канал не является разрешением использовать его в ФинУчёте.
Подсказка Adesk о регулярных выписках ПСБ требует первичного подтверждения
у банка. Email разрешаем только после проверки origin/account/attachment.

Для всех банков резерв — ручной импорт **проверенного** формата через
существующий импорт, без объявления поддержки произвольного XLSX/PDF.
Старый browser parser не переиспользуется на сервере вслепую: сначала
проверить точность money и сформировать bank-specific synthetic fixtures.
Для банков без подтверждённого API сначала формат файла, затем email,
если подтверждена регулярная отправка. Не используем scraping ДБО или
пароли банка в ФинУчёте.
