# BANK-003 — Sber multi-company server integration

## Итоговый статус

PARTIAL. Реализована приватная серверная часть и synthetic contracts; **банковский
ГОСТ-verifier, HTTP/session/secret deployment wiring и sandbox не завершены**.
Это не работающая банковская интеграция в production. Модуль не включён.

## Branch / commit

- branch: `feature/bank-integrations-bank-003`
- base: `5cd17629d6e68a6632d6b3cd2bf79100ecceb312`, BANK-002 / Draft PR #31.
- result: commit с этим отчётом; точный SHA указан в отдельном Draft PR.
- PR stacked на BANK-002, без merge/deployment.

## Baseline и источники

BANK-002 содержит только synthetic adapter, durable store и private guards.
Импорт отсутствовавшего Sber protocol воспроизвёл baseline failure до его реализации.
Официальные HTML и llms-full.txt Сбера проверены 2026-09-26; ссылки и ограничения
контрактов записаны в `functions/src/banks/sber/README.md`.

В актуальных схемах: v2 OAuth endpoints, signed JWT user-info, operationId,
_links, numeric money, direction, rurTransfer/curTransfer. Обнаружены ГОСТ-подписи;
подмена их простой JSON-декодировкой запрещена. Устаревший Postman token path
не использован. Ни один банковский endpoint не вызывался.

## Изменения в рамках BANK-003

- OAuth state 256-bit, hash-only storage, TTL, привязка к user/session/company INN,
  config и generations. Одноразовый callback, fresh canonical admin check.
- Одной транзакцией: активация подключения и счетов BANK-002, encrypted tokens,
  completed state. Минимальное расширение installVerifiedGrant — optional outer
  transaction; поведение предыдущих callers сохранено и проверено.
- Отдельные AES-256-GCM credentials для каждой компании/connection, authenticated
  context и keyring port; секреты не в UI, исходниках или логах.
- Durable refresh lease/fence/version CAS, восстановление неопределённого ответа
  в ограниченном окне, persisted Retry-After, terminal requires_reauth.
- Read-only REST provider, обязательная signature-verification boundary, строгая
  проверка claims, matching subject/INN/consent и минимальных scopes.
- Fixed-host mTLS transport: PFX/CA/hostname verification, no redirects, timeout,
  bounded response; безопасная классификация ошибок без банковского payload.
- Statement adapter: date/page cursor, проверка next URL без SSRF, точные суммы,
  дедупликационный ID, привязка account/currency. Неизвестные форматы отвергаются.
- Rules regression дополнен private credentials и bankOAuthStates; Rules не менялись.

## Файлы

`functions/src/banks/sber/{protocol,provider,service,secrets,transport,adapter}.ts`
и README; три новых test files; `storage/store.ts`; `tests/rules/banks.test.ts`;
этот отчёт. Нет изменений frontend, index exports, deployment или lockfiles.

## Критерии

- [x] Продуктовая multi-company модель; отдельные customer tokens, общий platform client.
- [x] OAuth state/callback isolation, replay/late-response protection.
- [x] Encrypted token storage, concurrent refresh/restart/revoke guards.
- [x] Read-only transport and documented bounded statement mapping.
- [x] Локальные unit/emulator/Rules и regression проверки.
- [ ] Production ГОСТ/signature verifier и доверенная bank certificate policy.
- [ ] Реальные secret/session providers и HTTP callback — private methods ещё не endpoints.
- [ ] Подтверждение bank issuer/claims/scopes/page limits и настоящий mTLS handshake.
- [ ] Sandbox/live acceptance, независимый review и exact-head общий CI.

## Проверки

| Проверка | Результат | Примечание |
|---|---|---|
| functions lint/typecheck/build | PASS | Node 22.23.3 |
| functions test:unit | PASS | 495 tests, 47 новых |
| Firestore-only bank emulator suite | PASS | 62 tests, 20 новых |
| root lint/typecheck/test:unit/build | PASS | 248 unit; baseline Balance.tsx/bundle warnings |
| root test:rules | PASS | 129 tests; credentials/state deny расширены |
| Rules TypeScript | PASS | existing test tsconfig |
| npm ci | BASELINE REUSED | успешная установка BANK-002, идентичные lockfiles; зависимости не менялись |
| test:run / test:e2e | NOT AVAILABLE | scripts отсутствуют |
| Full Functions emulator / remote CI | NOT VERIFIED | прежний local Unix socket EPERM; stacked PR не запускает main-only CI |
| git diff --check | PASS | финальный diff |
| Sber sandbox / mTLS handshake / GOST fixture | NOT RUN | нет подготовленного bank runtime/access, внешние вызовы не выполнялись |

```text
Functions unit: 22 files, 495 passed
Bank Firestore integration: 3 files, 62 passed
Root unit: 17 files, 248 passed
Rules: 2 files, 129 passed
```

Проверки включают state replay и race; иной user/session/tenant; token ciphertext
swap; matching INN; late callback after disconnect/off-on/revoke/delete/new attempt;
refresh single-flight, process restart, stale response fencing, unknown outcome
window, Retry-After и disconnect during refresh. Unit tests проверяют денежную
точность, date/page progression, SSRF, negative/zero/debit/credit, unsupported
formats, scope narrowing, signed synthetic RSA claims и mTLS transport policy.
RSA fixtures подтверждают поведение boundary, НЕ поддержку ГОСТ Сбера.

## Security review

Самопроверка, не Independent PASS. Ни default production key, ни permissive
signature verifier нет. Unavailable verifier всегда отказывает. Проверка подписи
банка — обязательный незавершённый компонент; его нельзя заменить return true.
Future HTTP code должен использовать проверенную Firebase session + HttpOnly cookie,
не формировать request.auth из браузерного JSON. Identity authority — canonical
membership; банковская организация дополнительно сверяется с company INN.

## Данные / ручная проверка / rollback

Только synthetic demo Firestore с cleanup; production не читалась и не менялась.
UI отсутствует по scope, index ничего не экспортирует. Внешняя миграция не нужна.
До merge rollback — не включать/закрыть Draft. После будущего merge — revert commit
отдельным PR. Если позднее deploy: сначала monotonic bank disable и stop workers,
затем отдельный approved rollback. Не удалять ledger и не снижать generations.

## Ограничения и оставшаяся работа

Подробно в Sber README. Этот PR НЕ закрывает весь BANK-003: требуется реальная
проверка ГОСТ-подписей/цепочки и выбранное server runtime, подтверждённые metadata,
secret/session adapters и callback wiring, затем sandbox. Счета <=50; normalized
page <=100 rows и core size limits. SWIFT-only/revaluation/unknown currencies
не импортируются. Balances/incremental не заявлены. Remote revoke через bank portal.
Автоматический cleanup state/credential retention и polling scheduler не развёрнуты.

Полный CI запускать на принятой dependency chain и точном HEAD; не менять workflow
или базу PR ради обхода требований. Независимое принятие BANK-001/002 не заявлено.

## Следующий шаг

Закрыть оставшиеся BANK-003 integration gates, затем BANK-004 UI. Реальный pilot
только по отдельному подготовленному пакету разрешения; в этом цикле не выполнялся.
