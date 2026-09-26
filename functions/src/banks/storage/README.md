# BANK-002: private durable ingestion

This directory is not imported by `src/index.ts`. There is no callable, trigger,
scheduler, real bank adapter, secret, or ledger writer. The global flag remains
absent/off by default. Tests use synthetic fixtures and demo Firestore only.

## Server boundary

`installVerifiedGrant` accepts a platform-authenticated admin request and a
SEPARATE trusted server grant. BANK-003 must verify bank consent/account identity
before invoking it; never pass request.data as that grant. The server supplies
consent.grantedBy and connection generation. Ledger account mapping is rejected.
Reconnect replaces account bindings and increments generation. IDs are scoped
within a company; stable operation identity excludes connection and channel.

`enqueue` derives actorUid from authenticated claims, uses existing canonical
membership/maintenance helpers, and pins tenant/policy/connection generations.
Client requestId is an idempotency key, not a credential. Reuse with different
parameters fails; reuse after revocation does not revive the old job.

`claim`, `readWork`, `commitPage`, and `fail` recheck company existence, active
canonical actor and consent-grantor membership, maintenance, policy, connection,
consent expiry, account binding and pinned generations within their transaction.
A fence plus owner prevents an expired worker from writing after replacement.
Do not expose these private worker methods to browser requests.

Use `setBankModuleEnabled` only in a separately authorized operator workflow.
Every write increments generation, including off/on. Direct Admin SDK edits
which reset/reuse generation violate the protocol. Browser Rules deny all bank
paths, including to company admins; existing Rules were not changed.

`disconnect` works while the bank flag is off. `markCompanyDeleting` creates a
non-resurrectable banking tombstone and must be integrated BEFORE company
removal in the future lifecycle task. These invalidate work logically without
an unbounded job sweep. Stored job status can still say queued/running;
fresh guards deny it. There is no deployed sweeper or UI status projection.
A deleted/recreated company ID must never bypass the tombstone protocol.

## Collections under bankCompanies/{companyId}

| Collection | Durable content |
|---|---|
| connections | validated read-only consent; generation; no tokens |
| bindings | connection-authorized bank account identity and currency |
| jobs | immutable window/actor/generations; cursor; lease/fence; retries |
| jobs/{id}/receipts | page index, canonical payload digest, committing owner/fence |
| jobs/{id}/cursors | hashed previously returned cursor, loop prevention |
| operations | immutable original bank fields, review disposition/revision |
| observations | deduplicated correction proposals; original not overwritten |
| matchBuckets | company/bank/account/date/currency/amount hasWeak marker |
| outbox | idempotent operation/revision intents; always state=blocked |

A transaction commits the ENTIRE page, receipt, cursor, corrections and outbox,
or none of them. The caller supplies the cursor/pageIndex used for that fetch;
a changed lease or page cannot accidentally commit into the next page. Replaying
a matching committed receipt is read-only and permitted after lease expiry,
subject to current authorization. A different payload/owner/fence fails.

Strong provider IDs deduplicate across jobs, pages, reconnects and channels.
Changed banking fields preserve the original, increment revision only for a new
proposal, and require review. Repeating the same proposal is idempotent.
Equal amounts with different strong IDs remain distinct. Missing IDs preserve
EACH occurrence in quarantine. Re-fetching a new overlapping weak-ID job can
create additional review candidates: they are intentionally not silently dropped.
No category/project/comment/split/ledger annotation is stored or overwritten.

`staged` does NOT mean financially approved or publishable. If a weak occurrence
arrives after a strong one, matchBuckets.hasWeak becomes true; existing strong
rows are not fan-out rewritten. Every future reconciliation/publication consumer
MUST read the current bucket and row revision as well as current authorization,
consent/generations, closed periods and ledger revision in its commit protocol.
Outbox is only durable blocked intent, not a BANK-001 PublicationEnvelope yet:
expectedLedgerRevision/idempotent ledger receipt require BANK-005 and ARCH.
There is no API in this module to unblock or consume it. Own transfers are not
classified as income. No balance, report, company_data or ledger writes occur.

## Bounds and recovery

- At most 100 rows and 512 KiB normalized JSON per page; at most 1000 pages/job.
  At most 403 writes/page (rows + buckets + observations + outbox + metadata).
  BANK-003 must request a compatible page size or preserve provider pagination
  when splitting; truncation is forbidden. Oversize data fails atomically.
- Lease 60s; provider timeout 30s. No network inside Firestore transactions.
  A crash before commit repeats the page after lease expiry. After commit it
  resumes the persisted next cursor. No in-memory state is required for recovery.
- Empty pages with a nextCursor continue; null is the only end marker. Cursor
  cycles and bounds throw, never report a partial statement as complete.
- Exponential backoff + deterministic jitter; Retry-After up to 24h; maximum
  eight consecutive provider failures, reset after a successful page.
  Reauth/revocation increments connection generation and blocks other jobs.
- Abort/timeout ignores late adapter results even if the adapter ignores abort.
  Auth/storage/validation errors propagate; the lease expires for recovery.
  A scheduler must surface persistent validation errors instead of spinning.
- Error storage uses enum categories only, never a provider response body.

## Verification

From functions with Node 22 and Java 21:

```sh
npx firebase emulators:exec --project demo-finapp --only firestore "npx vitest run test/emulator/banksStorage.test.ts test/emulator/banksAccess.test.ts"
```

Root `npm run test:rules` checks private bank paths using a separate demo rules
project, avoiding interference with existing rules fixtures. No production
resources, migration, deployment, real bank request or credentials are needed.

Remaining integrations: bank consent/refresh (BANK-003), scheduling and UI
(BANK-004 integration), company lifecycle wiring, ledger publication (BANK-005).
