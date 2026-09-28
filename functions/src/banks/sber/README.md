# BANK-003 — Sber platform integration (private, synthetic-tested)

Status: PARTIAL. Server logic exists; this is NOT a connected bank product.
Nothing here is imported by Functions index, registered globally, or deployed.
No bank credentials, live accounts, external requests or configuration were used.

## Multi-company flow

1. A platform-verified admin initiates `begin` for a selected company/connection.
   The company's canonical `companies/{id}.inn` must already be present.
   The private HTTP factory supplies a server-verified, HttpOnly session binding;
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
- Encryption keys, client secret, PFX/password and trusted CA bundle come from
  Firebase SecretParam readers in `runtimeSecrets.ts`; definitions are lazy and
  sandbox/production names are separate. No secrets are provisioned or installed.
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
- Private HTTP handlers implement verified Firebase sessions, Secure/HttpOnly
  SameSite cookies, origin controls, no-store/no-referrer and clean redirects.
  They are not mounted as Cloud Functions or browser routes. No scheduler exists.
- Every Sber API request through `MtlsTransport`, including token, user-info and
  statements, now requires a `FirestoreSberRateGate`. It is shared by all
  connections for the same platform client and environment (not per company).
  The bank's platform documentation requires more than two seconds between
  requests. A Firestore transaction grants one request slot; release after
  response/error starts a 2200 ms cooldown. A 45-second crash lease exceeds
  the 20-second HTTP timeout. Waiting is abortable and bounded to 25 seconds;
  failure never bypasses the gate. No network occurs inside a transaction.
  Gate state lives under private `bankSberRequestGates/{environment}-{clientHash}`.
  Actual bank timing, cross-region clock skew, long process pauses and multi
  instance operation require sandbox/observability validation before activation.

## HTTP/session boundary (implemented, not deployed)

`createSberHttpHandlers` receives Admin `Auth`, the real `SberConnections` service,
Sber config, and fixed begin/return URLs. All three URLs must share one HTTPS
origin with distinct paths; request Host/Forwarded headers never select redirects.
The future frontend and backend must use that same origin. Existing Pages hosting
has NOT been changed to provide this routing.

- Begin: POST, exact configured path, exact Origin, JSON <=2 KiB, no CORS,
  optional Fetch Metadata must be same-origin. Only companyId/connectionId are
  accepted. A bearer Firebase ID token is checked with revocation enabled,
  verified email and sign-in within five minutes. Browser-supplied auth is ignored.
  This implies reauthentication in the future UI for an older login.
- A ten-minute Firebase session cookie is combined with fresh 256-bit randomness.
  Only the SHA-256 binding reaches OAuth state storage. Cookie name is
  `__Host-finapp-sber`, Path=/, Secure, HttpOnly, SameSite=Lax, no Domain.
  One pending browser flow is supported; a new begin replaces its cookie.
- Callback: top-level GET; exactly one state and code; reject duplicate/unknown
  query parameters, duplicate security headers/cookies, expired/revoked sessions.
  Admin SDK verifies the session cookie; existing transactional service rechecks
  the initiating UID, cookie binding, admin membership, tenant/INN/generations.
- Bank error/denial and malformed responses redirect to the same fixed failure
  URL. Successful activation redirects to a fixed success URL. Both clear the
  temporary cookie and exclude bank code/state/user/account data. UI MUST fetch
  authorized connection status; a URL result flag is not authoritative evidence.
- Callback passes abort on browser disconnect and a 30s deadline to the service.
  SDK/provider exceptions are sanitized; handlers contain no request logging.

Hosting/proxy access logs and error middleware are a separate deployment gate:
they MUST exclude callback query strings, Authorization, Cookie and response
Set-Cookie. Preserve this host-only cookie; do not assume a Firebase Hosting
rewrite forwards arbitrary cookie names. Configure/test a compatible same-origin
reverse proxy before mounting. Do not rename to a broadly shared auth cookie as
a workaround. Browser navigation, actual Firebase Auth/session issuance and this
proxy behavior have not been exercised; unit tests substitute Admin SDK.
The Firestore integration test uses real domain transactions but synthetic Auth.
The proposed routes and browser/proxy acceptance checks are in `ROUTING.md`.

## Secret manager readers (implemented, no secret installation)

`defineSberSecretProviders(environment)` declares two Firebase secret parameters:
`FINAPP_SBER_SANDBOX_KEYRING`/`FINAPP_SBER_SANDBOX_TRANSPORT` or their PRODUCTION
counterparts. Nothing is read until the runtime readers are called. A future
composition root must bind BOTH returned `bindings` to each relevant function.
No environment-variable fallback, generated default key, or frontend secret exists.

- KEYRING JSON: `currentKeyId`, `keys` map of ID to canonical base64 of exactly
  32 bytes. Maximum eight keys. Current ID must exist. Retain previous IDs/material
  for decryption; never replace material under an existing ID. Deploy a new ID,
  retain old keys until all dependent ciphertext is rotated and verified, then
  remove old keys in a separately reviewed operation. No bulk rotation is included.
- TRANSPORT JSON: nonempty `clientSecret`, canonical `pfxBase64`, nonempty
  `passphrase`, `ca` array of individual PEM certificates. Bounded JSON <=65000
  bytes. Readers validate shape, NOT certificate validity/trust or PFX password;
  Node's TLS stack must still validate the actual material at handshake.
- Unavailable/malformed secrets or unknown key IDs fail closed with safe errors.
  Read permissions, project/region, concrete versions, certificate rotation and
  secret installation are unconfigured deployment gates. No secrets belong in chat.

## Signed bank responses — explicit remaining blocker

The official token/user-info examples include `gost34.10-2012` signatures.
`BankSignatureVerifier` is a REQUIRED trusted server component. It must verify
bank signature, approved algorithm, trusted pinned bank key/certificate chain
and relevant certificate validity/revocation policy. It must never trust a key
from the token itself or fetch arbitrary jku/x5u URLs. Issuer must be pinned to
metadata confirmed for the registered bank service/environment.

There is NO production GOST verifier in this PR. The supplied unavailable
implementation always denies. Unit tests use real signatures from a synthetic
RSA key to exercise claim validation behind an injected synthetic verifier;
the fixture declares the bank's GOST header but does NOT have a GOST signature.
The server boundary rejects RS256 even when that test verifier accepts its RSA
signature. These tests are NOT proof of Sber GOST support.
Do not wire a verifier that merely decodes JSON, returns true, or skips signature
validation. Before bank sandbox/pilot, implement and independently review the
bank-compatible verifier/runtime and validate bank-supplied positive/negative
fixtures. No production activation is allowed until this blocker is resolved.

Additional public-document inspection on 2026-09-26: the token-schema example has
an empty `{}` payload and a 4277-byte BER/CMS SignedData signature with GOST-2012
OIDs; it is not a valid positive login fixture or an ordinary raw JWS signature.
The OAuth page's linked `6020194e_sberca-root-ext.crt` is an RSA root CA, not a
confirmed GOST signing leaf. Do not pin it as the token signer or invent a chain
from it. Local OpenSSL exposes only its default provider. The exact CMS signed
content, bank signing chain, revocation policy and GOST-compatible runtime need
confirmation and bank-compatible test vectors before this gate can close.
Further inspection on 2026-09-28: the CMS example embeds a certificate from a
test organization, and contains no embedded content. It cannot establish the
production Sber token signing identity or serve as a positive bank token fixture.
The SberBusiness ID platform guide also documents the greater-than-two-second
API interval; this triggered the private rate gate above.

To close the signature gate, obtain through a controlled test channel full
bank-signed synthetic sandbox ID token and user-info fixtures with claims
matching the registered client, the signing leaf/chain and documented trust and
revocation policy. Never paste real customer tokens into chat or commit them.
Confirm whether the detached CMS content is the literal JWS
`base64url(header).base64url(payload)` bytes or another canonical representation;
the public example does not establish this. Verify the same fixtures with the
chosen GOST/CMS runtime, then exercise corrupted header/payload/signature,
wrong signer, expired/revoked certificate, missing nonce and cross-client issuer
and audience. The verifier must use configured trust, not the CMS embedded
certificate as a trust anchor. Keep the default unavailable verifier until the
positive and negative bank cases pass and the runtime is independently reviewed.

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
- https://developers.sber.ru/docs/ru/sber-api/scenarios/profile-creation/sbbid/overview

The Postman collection has an older unversioned token path; current resource
specification v2 takes precedence. No Postman scripts (including token logging)
were executed or copied.

## Next concrete acceptance gates

1. Review #31 dependency and this private implementation; complete exact-head CI.
2. Implement bank-compatible signature verification; provision and verify the
   implemented secret/session adapters and mount HTTP behind a reviewed proxy.
   Confirm exact issuer/claim availability/scopes and registered callback.
3. Provide an approved sandbox execution package with artifact SHA, callback,
   platform client, TLS/CA setup, secret installation, company/account allowlist,
   test period, expected counts/amounts, safe-stop and rollback. No credentials in chat.
4. Sandbox contract verification, including multi-page limits, mTLS, signed bank
   fixtures, refresh rotation and consent revoke. Only then a separate real pilot.
5. BANK-004 mounts UI/endpoints; BANK-005/ARCH enables ledger publication.
