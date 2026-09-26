# BANK-003 — Sber multi-company server integration

## Итоговый статус

PARTIAL. Реализована приватная серверная часть и synthetic contracts; **банковский
ГОСТ-verifier, deployment wiring и sandbox не завершены**.
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
- Приватные HTTP begin/callback handlers: Firebase Admin SDK с revocation checks,
  recent login, exact-Origin/JSON/bearer CSRF boundary, host-only HttpOnly cookie,
  fixed clean redirect и abort/deadline. Клиентский request.auth не используется.
- Firebase SecretParam readers: отдельные sandbox/production bindings, lazy reads,
  strict bounded JSON, keyring rotation/read-old support, mTLS material provider.
  Секреты не создавались, не устанавливались и не читались из облака.

## Файлы

`functions/src/banks/sber/{protocol,provider,service,secrets,transport,adapter,http,runtimeSecrets}.ts`
и README; пять новых test files; `storage/store.ts`; `tests/rules/banks.test.ts`;
этот отчёт. Нет изменений frontend, index exports, deployment или lockfiles.

## Критерии

- [x] Продуктовая multi-company модель; отдельные customer tokens, общий platform client.
- [x] OAuth state/callback isolation, replay/late-response protection.
- [x] Encrypted token storage, concurrent refresh/restart/revoke guards.
- [x] Read-only transport and documented bounded statement mapping.
- [x] Локальные unit/emulator/Rules и regression проверки.
- [ ] Production ГОСТ/signature verifier и доверенная bank certificate policy.
- [x] Приватные HTTP handlers и Firebase secret/session adapters; 49 новых unit checks
  и один end-to-end domain/Firestore test с synthetic Auth.
- [ ] Развёрнутые endpoints/proxy, реальная выдача Firebase session cookies, установка
  secrets и browser navigation: код не монтирован, внешние действия не выполнялись.
- [ ] Подтверждение bank issuer/claims/scopes/page limits и настоящий mTLS handshake.
- [ ] Sandbox/live acceptance, независимый review и exact-head общий CI.

## Проверки

| Проверка | Результат | Примечание |
|---|---|---|
| functions lint/typecheck/build | PASS | Node 22.23.3 |
| functions test:unit | PASS | 544 tests, 96 новых суммарно (47 + 49) |
| Firestore-only bank emulator suite | PASS | 63 distinct tests covered: 62 full suite + updated Sber subset 21; 21 новых суммарно |
| root lint/typecheck/test:unit/build | PASS | 248 unit; baseline Balance.tsx/bundle warnings |
| root test:rules | PASS | 129 tests; credentials/state deny расширены |
| Rules TypeScript | PASS | existing test tsconfig |
| npm ci | BASELINE REUSED | успешная установка BANK-002, идентичные lockfiles; зависимости не менялись |
| test:run / test:e2e | NOT AVAILABLE | scripts отсутствуют |
| Full Functions emulator / remote CI | NOT VERIFIED | прежний local Unix socket EPERM; stacked PR не запускает main-only CI |
| git diff --check | PASS | финальный diff |
| Sber sandbox / mTLS handshake / GOST fixture | NOT RUN | нет подготовленного bank runtime/access, внешние вызовы не выполнялись |

```text
Functions unit: 24 files, 544 passed
Bank Firestore integration: full suite 62 passed; updated Sber subset 21 passed
Distinct bank integration cases covered: 63 (42 access/storage + 21 Sber)
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
HTTP factory использует проверенную Firebase session + HttpOnly cookie и не
формирует identity из браузерного JSON. SDK revocation вызывается с true.
Proxy/hosting logging, cookie forwarding, browser navigation и actual Firebase Auth
ещё не проверены; SDK в тестах подменён, Firestore transactions — настоящие. Identity authority — canonical
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
provisioning уже реализованных secret/session adapters и callback wiring, затем sandbox. Счета <=50; normalized
page <=100 rows и core size limits. SWIFT-only/revaluation/unknown currencies
не импортируются. Balances/incremental не заявлены. Remote revoke через bank portal.
Автоматический cleanup state/credential retention и polling scheduler не развёрнуты.

Полный CI запускать на принятой dependency chain и точном HEAD; не менять workflow
или базу PR ради обхода требований. Независимое принятие BANK-001/002 не заявлено.

## Следующий шаг

Закрыть оставшиеся BANK-003 integration gates, затем BANK-004 UI. Реальный pilot
только по отдельному подготовленному пакету разрешения; в этом цикле не выполнялся.

## Продолжение 2026-09-26 — HTTP и secret runtime adapters

Baseline HEAD: `0d5d8d2e68197438fdb0176edfca9a489bf1c828`, clean worktree;
remote Draft #32 совпал. BANK-003 roadmap прочитан из BANK-000, текущие
CLAUDE.md/config/scripts проверены. `http.ts`/`runtimeSecrets.ts` отсутствовали;
47 исходных Sber unit tests прошли до изменения production-кода.
Node для Functions 22.23.3, npm 11.13.0; root Node 24.16.0.

Изменения: 2 production files, 2 unit suites, дополнительный emulator case, README
и этот отчёт. Нет изменения index, Rules, frontend, dependencies или lockfiles.
Существующие callback/refresh/ledger guards не ослаблены.

49 новых unit tests проверяют Origin/CSRF, forged auth, revoked/old/expired login,
secure cookie/binding, duplicate headers/query/cookies, cancellation, fixed redirect,
таймаут, отсутствие утечки ошибок; secret shape/size, unknown key, retained-key
rotation. Новый Firestore test проводит HTTP begin/callback через реальный service:
чужой browser cookie не вызывает exchange, правильный активирует connection,
повторный callback не вызывает второй exchange, токены хранятся зашифрованно.

Независимое ревью не проводилось. Firebase Auth/Secret Manager и HTTP proxy не
запускались; tests используют SDK doubles. Эти проверки не доказывают production
session issuance, browser SameSite behavior или настоящий mTLS handshake.
Требуется совместимый HTTPS reverse proxy с сохранением host-only cookie; существующий
Pages hosting не изменён. Логи ingress/proxy должны исключать callback query и
чувствительные headers. Не монтировать до проверки этих условий.

Дополнительное исследование подписи (только публичная документация, не API банка):
- Официальный token-schema пример: header alg=gost34.10-2012, payload={},
  signature 4277 bytes, BER/CMS SignedData, GOST-2012 hash/signature OIDs.
  Это не полноценный положительный login fixture; не заменять CMS обычным JWS.
- Публичный CA-файл из ссылки OAuth documentation:
  `https://cdn-app.sberdevices.ru/misc/0.0.0/assets/bsm-docs/6020194e_sberca-root-ext.crt`
  SHA-256 `6020194ec636999bbd8db1db9530fb0aa023ae404c85f833330e3add015e3b16`,
  subject/issuer SberCA Root Ext, RSA-4096, validity 2020-10-29—2040-10-24.
  Это корневой CA, не подтверждённый ГОСТ signing leaf. Файл не установлен
  как доверенный ключ и не включён в production trust.
- Локальный OpenSSL 3.0.13 предоставляет только default provider.
  GOST/CMS runtime, точные подписываемые данные, signing chain/revocation и
  действительные positive/negative fixtures остаются незакрытым gate.

Первичные источники HTTP/secret API (проверены 2026-09-26):
https://firebase.google.com/docs/auth/admin/manage-cookies
https://firebase.google.com/docs/functions/config-env
Источники Сбера — README, OAuth page и официальный token schema.

Итог продолжения: PARTIAL; 50 новых проверок (49 unit + 1 Firestore).
Полный банковский BANK-003 ещё не принят. Следующий разрешённый шаг остаётся
BANK-003: GOST/CMS verification + точный пакет sandbox deployment, затем independent
review/CI; BANK-004/005 не начаты.
