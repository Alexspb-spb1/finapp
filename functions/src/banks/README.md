# BANK-001: private server core

This directory is deliberately not exported from `src/index.ts`. It creates
no callable, scheduler, Firestore write, bank HTTP request or secret. Default
adapter registry is empty and the server flag defaults to disabled. The
existing app has no import of this module. BANK-000 design/research is in
the separate [PR 29](https://github.com/Alexspb-spb1/finapp/pull/29).

- `contracts.ts`: strict runtime data boundaries; provider responses are unknown.
- `money.ts`: decimal text to exact signed minor-unit strings via BigInt.
- `identity.ts`: conservative comparison, stable key across reconnect/channels;
  ambiguous matches require review. Not a persistent deduplication database.
- `ports.ts`: separate API, file, email, publication and lifecycle contracts.
- `access.ts`: canonical authz helpers + current company + maintenance +
  server-controlled `system/bankIntegrations` flag. All mutating checks need
  the mutation's Transaction. This alone is not a production worker guard:
  connection/consent/tombstone/generation/fence checks remain BANK-002.
- `preview.ts`: bounded in-memory pagination harness; fresh injected guard
  before/after each call, strict tenant/account/currency/date validation.
  No persistence, retries, balance calculation or full production sync.
- `adapters/`: explicit registry and deterministic synthetic adapter only.

Only test data has been exercised. There is no Sber adapter, OAuth flow,
secret store, UI route, email/file parser, durable job queue or ledger writer
yet. Do not enable this as a production module based on passing unit tests.

## Verification

From `functions/`:

```sh
npm ci
npm run lint
npm run typecheck
npm exec -- vitest run test/unit/banks
npm run test:unit
npm run build
npm exec -- firebase emulators:exec --project demo-finapp --only firestore 'vitest run test/emulator/banksAccess.test.ts'
npm run test:emulator
```

Use Node 22 and Java 21+. Root uses its own pinned Node/npm versions.
The private guard integration test refuses to run outside `demo-finapp`
with Firestore at `127.0.0.1:8080`. It does not test platform JWT verification;
existing callable suites cover that layer. No bank credentials are needed.
