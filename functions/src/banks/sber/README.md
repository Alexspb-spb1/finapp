# BANK-003 — Sber platform integration (private, synthetic-tested)

Status: PARTIAL. Server logic exists; this is NOT a connected bank product.
Nothing here is imported by Functions index, registered globally, or deployed.
No bank credentials, live accounts, external requests or configuration were used.

## Multi-company flow

1. A platform-verified admin initiates `begin` for a selected company/connection.
   The company's canonical `companies/{id}.inn` must already be present.
   The future HTTP layer supplies a server-verified, HttpOnly session binding;
   neither caller UID nor session authority comes from request payload fields.
2. The service persists only a hash of a 256-bit OAuth state. It pins user,
   session hash, company INN, tenant/policy/connection generations, config and
   nonce. TTL is ten minutes; reconnect invalidates preceding attempts/jobs.
3. User authorizes at Sber's own page. The callback immediately consumes state
   once, exchanges code server-side, validates signed ID token + signed user-info,
   subject/issuer/audience/nonce/expiry, bank INN and consent expiry.
4. One Firestore transaction rechecks current authority and atomically activates
   the BANK-002 connection/bindings, persists encrypted tokens and completes state.
   A failed/uncertain code exchange requires a fresh authorization; no code replay.
5. BANK-002 workers construct a per-job account-scoped SberAdapter with a trusted
   account binding. Token reads recheck current connection/consent/actor/generations.
   Each connection has its OWN encrypted tokens. There is no global customer token.

`listAccounts` on this job-scoped adapter returns the bound account only.
The complete consented account set is installed during callback and stored as
BANK-002 bindings. Future BANK-004 account selection reads those bindings through
an authorized server endpoint; it must not call job-scoped listAccounts as a
full bank-account directory.

## Security and token recovery

- Shared application configuration identifies the platform; customer tokens are
  separate. Requested scopes are exactly `openid GET_STATEMENT_ACCOUNT accounts
  inn offerExpirationDate sub`. Extra granted scopes (including payments) fail.
- Tokens are AES-256-GCM encrypted; authenticated context pins company,
  connection, generation and token version. Server keyring has no default key.
  Key IDs allow the runtime to retain old decryption keys during rotation.
- Encryption keys, client secret, PFX/password and trusted CA bundle must come
  from deployment's secret manager. This PR defines injected providers and does
  not provision one, print secrets, or create environment files.
- Refresh uses a durable 60-second lease, owner, monotonically increasing fence
  and token version CAS. Only one worker refreshes; late responses cannot replace
  a winner or reconnect. Access expiry is based conservatively on request start
  plus the bank's expires_in, never an assumed permanent lifetime.
- An uncertain refresh keeps the old encrypted pair. Recovery reuses it after
  lease expiry only within one hour of the first attempt, following Sber's
  documented recovery recommendation. Outside that window require reauthorization.
  Retry-After is persisted. Terminal refresh errors invalidate the connection.
- Missing/corrupt state, membership loss, consent expiry, module off/on,
  reconnect/deletion and changing INN/config deny use. Disconnect blocks local
  access immediately; remote consent revocation is through the bank portal in
  this version (no automated revoke capability advertised).
- Future HTTP handlers MUST verify the Firebase session, bind a Secure/HttpOnly
  SameSite cookie, apply CSRF/origin controls to begin, avoid callback query/code
  logging, send no-store/no-referrer, and clear callback URL/session state.
  No callback/callable route or scheduler is included in this PR.

## Signed bank responses — explicit remaining blocker

The official token/user-info examples include `gost34.10-2012` signatures.
`BankSignatureVerifier` is a REQUIRED trusted server component. It must verify
bank signature, approved algorithm, trusted pinned bank key/certificate chain
and relevant certificate validity/revocation policy. It must never trust a key
from the token itself or fetch arbitrary jku/x5u URLs. Issuer must be pinned to
metadata confirmed for the registered bank service/environment.

There is NO production GOST verifier in this PR. The supplied unavailable
implementation always denies. Unit tests use real signatures from a synthetic
RSA key to exercise claim validation; they are NOT proof of Sber GOST support.
Do not wire a verifier that merely decodes JSON, returns true, or skips signature
validation. Before bank sandbox/pilot, implement and independently review the
bank-compatible verifier/runtime and validate bank-supplied positive/negative
fixtures. No production activation is allowed until this blocker is resolved.

## REST and monetary correctness

Fixed API origins: fintech-test.sberbank.ru:9443 (sandbox) and
fintech.sberbank.ru:9443 (production). Authorize uses sbi.sberbank.ru:9443 even
for sandbox. Token/user-info are v2; statements use
`/fintech/api/v2/statement/transactions`.

The Node HTTPS transport requires PFX, CA bundle and normal hostname validation,
TLS >=1.2, disallows redirects and arbitrary resources, caps response at 2 MiB
and total HTTP duration at 20s. No payment resource can be requested.
The transport mocks test these policies; a real mTLS handshake has NOT been tested.

Statements are fetched one day/page at a time. Persisted cursor is {date,page},
not a provider URL. Only a validated next relation advances page; its origin,
path, account/date, page+1 and allowlisted parameters must agree. Absent next
advances to the next requested day, including after an empty day. Only after the
last day does cursor become null. BANK-002 still bounds jobs at 1000 pages.

JSON numeric lexemes are preserved using Node 22 JSON.parse source context.
Amounts never pass through binary floating point. Bank operationId is used for
strong identity; uuid/number/hashAbc are NOT guessed substitutes. Missing IDs
therefore remain weak candidates for BANK-002 review. Direction sets amount sign;
calendar operation date is not shifted to UTC; transfer fields supply counterparty.

Supported accounts: existing core currencies RUB/USD/EUR/CNY/JPY/KWD, mapped from
numeric account currency code (810 and 643 -> RUB). Maximum 50 consented accounts.
Supported transaction payloads: rurTransfer and curTransfer with explicit
payer/payee fields and matching owned account. Raw SWIFT-only, FX revaluation,
ambiguous/missing details, unsupported currency, >100 rows/page or core field/size
limits FAIL the page atomically. No truncation or partial success. This is a
restricted first adapter, not a claim to support every Sber transaction format.
Provider page-size/splitting and full FX coverage require sandbox evidence before
pilot. `balances=false`, `incremental=false`, evidence=`synthetic_tested`.

## Sources inspected 2026-09-26

Primary source schemas were retrieved from the official LLM documentation
(the HTML pages defer schema rendering). No downloaded bank response fixtures
or full third-party documentation are committed; tests are invented synthetic data.

- https://developers.sber.ru/docs/ru/sber-api/llms-full.txt
- https://developers.sber.ru/docs/ru/sber-api/start/oauth
- https://developers.sber.ru/docs/ru/sber-api/specifications/oauth/oauth-authorize-get
- https://developers.sber.ru/docs/ru/sber-api/specifications/oauth/oauth-token-post
- https://developers.sber.ru/docs/ru/sber-api/specifications/oauth/oauth-user-info-get
- https://developers.sber.ru/docs/ru/sber-api/specifications/statement/transactions
- https://developers.sber.ru/docs/ru/sber-api/start/tls

The Postman collection has an older unversioned token path; current resource
specification v2 takes precedence. No Postman scripts (including token logging)
were executed or copied.

## Next concrete acceptance gates

1. Review #31 dependency and this private implementation; complete exact-head CI.
2. Implement bank-compatible signature verification and real server secret/session
   providers; confirm exact issuer/claim availability/scopes and registered callback.
3. Provide an approved sandbox execution package with artifact SHA, callback,
   platform client, TLS/CA setup, secret installation, company/account allowlist,
   test period, expected counts/amounts, safe-stop and rollback. No credentials in chat.
4. Sandbox contract verification, including multi-page limits, mTLS, signed bank
   fixtures, refresh rotation and consent revoke. Only then a separate real pilot.
5. BANK-004 mounts UI/endpoints; BANK-005/ARCH enables ledger publication.
