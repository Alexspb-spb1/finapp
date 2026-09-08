# SEC-006 Stage 8 — live staging invitation and real-email acceptance

Status: **LOCAL EXECUTOR VALIDATED — AUTH-SHAPE READ-ONLY DISCOVERY AUTHORIZED; LIVE FIXTURES/EMAIL NOT AUTHORIZED**.

This package is the behavioral staging gate that follows the completed backend
deployment and the read-only mailbox discovery. It targets only
`finapp-staging`. It creates bounded synthetic fixtures, registers the
owner-controlled mailbox only through the invitation entry page, requests at
most one Firebase verification email, and pauses for two owner actions in a
visible local browser. It does not touch production, deploy code or Rules,
change billing, configure email, read mailbox contents, open the email action
link, merge PR27 or publish Pages.

## Bound evidence and preconditions

- Checkout: `D:\projects\finapp\finapp-sec006-stage8`.
- Branch: `remediation/SEC-006-stage-8-rehearsal`.
- Draft PR: <https://github.com/Alexspb-spb1/finapp/pull/27>.
- The final package must substitute one independently reviewed clean
  `REVIEWED_HEAD`, prove PR head equality, and show `ci` and `functions`
  success for that exact commit.
- Mailbox input remains the private regular file
  `D:\projects\finapp\.runtime\stage8-mailbox.txt`. The address is never
  copied to source, commands, console output or receipts.
- Completed mailbox discovery receipt:
  `D:\projects\finapp\.runtime\stage8-mailbox-discovery-5e476df.json`, SHA-256
  `b9be2d78de4711406361be6bb4be55b90e9ada3d78275a55dc130719da96ffe6`.
  It records `accountExists=false`, `profileExists=false`, zero mutations and
  zero emails. The live runner repeats the exact lookup immediately before its
  first write; the saved receipt alone is not treated as fresh authorization.
- Completed backend deployment receipt:
  `D:\projects\finapp\.runtime\stage8-deployment-final-ab1bd67.json`, SHA-256
  `f7b93c7787a0e2f709f57d547eee7abb382322c48d4e576566f9fdd1b0b2267d`.
- Existing Rules source backup:
  `D:\projects\finapp\.runtime\stage8-rules-before-ab1bd67.json`, SHA-256
  `9ad40708294a0f35e5f0f293c5ebad414957d4517477b186bb456f849fc57635`.
  The package never restores it automatically.

Immediately before mutations, fresh read-only checks must still prove:

1. project `finapp-staging`, native `(default)` database in `eur3`, billing
   enabled;
2. exactly the eight approved Gen2 Functions are `ACTIVE` with the reviewed
   Node22/resource caps, and `authzProbe` is absent;
3. active Rules canonical SHA-256 is
   `15bbc0050dd1ed2259c921818794b4f234c4457ad3e66ee2d0fa1da6d148f89d`;
4. the invitation composite index is `READY`, and the existing field override
   count/hash remains `1` /
   `af2e9e80c150cc9a6b2f4c5f5bae330dacb214d7a104188fa5ef4fcfad3c6aee`;
5. email/password signup is enabled, user signup is not disabled, and the
   verification-email method/template/callback-domain metadata is present and
   structurally valid without reading or retaining its body, SMTP password or
   other provider secrets;
6. `system/maintenance` is absent or inactive; the runner never toggles it;
7. the exact mailbox still has no Auth account and no `users/{uid}` profile;
8. the fresh staging build passes its six-field configuration fingerprint and
   is served only from loopback. The browser blocks every origin except the
   loopback static server, the exact Firebase Auth/Firestore endpoints and the
   eight staging callable endpoints. The known legacy exchange-rate request is
   aborted before dispatch.

Any mismatch is a safe stop before the first write.

## Exact bounded fixture and callable envelope

The runner creates two random run-scoped synthetic verified Auth owners without
sending them email. Each invokes `createCompany` once with a pre-journaled
idempotency key: owner A creates Company A and owner B creates Company B. The
server-generated company IDs are reconciled through the exact
`user_bootstrap/{uid}` receipts before any continuation after uncertainty.

Owner A then exercises the invitation UI/callables:

1. invitation 1 to the private mailbox is created, listed, copied in memory,
   previewed and cancelled; revoked preview is denied;
2. invitation 2 to the same mailbox is created; an immediate resend receives
   the cooldown refusal without a write; after the real 60-second interval one
   resend succeeds; the old token is denied and the new token previews;
3. verified owner B first receives the mailbox link as the wrong identity and
   is denied with no partial write;
4. the mailbox owner registers through that invitation page and accepts as
   `accountant` only after real Firebase email verification;
5. invitation 3 lets existing owner B join Company A as `viewer`; Company B
   remains their admin company. Cross-company access, role-dependent UI,
   company switching, direct URLs, two tabs, logout, reload and offline
   recovery are checked;
6. same-UID acceptance replay succeeds without changing invitation/member/
   profile update times or adding an audit event.

The fixed maximum retained state before a later cleanup decision is:

| Resource | Maximum |
|---|---:|
| Auth accounts | 3 (two synthetic, one owner mailbox) |
| `companies` | 2 |
| `company_data` | 2 |
| `user_bootstrap` | 2 |
| `users` profiles | 3 |
| membership documents | 4 |
| invitations | 3 |
| invitation locks | 2 |
| audit events | 9 |
| unique Firestore documents | 27 |
| real verification emails | 1 |

Callable POST caps are: `createCompany=2`, `inviteMember=3`,
`cancelInvite=1`, `resendInvite=2` (one denied, one successful),
`acceptInvite<=6`, `listInvitations<=10`, `previewInvite<=8`, and
`getCompanyAccess<=7`, with at most 40 callable POST requests overall. Every
other callable or excess request is blocked. A mutating callable with an
unknown outcome is never blindly repeated. Only `createCompany` with the exact
same journaled idempotency key/payload and same-UID `acceptInvite` after
read-only reconciliation are replay-safe.

## Owner actions and exactly-one email boundary

The runner opens invitation 2 in a new visible, non-persistent browser context.
The URL fragment must be synchronously removed before application/Firebase
initialization; no financial module or cached company data may load before
access confirmation. Raw invitation tokens never enter a file, environment
variable, shell argument, journal, trace, HAR, screenshot, browser storage or
console output. Clipboard is cleared immediately after the copy check.

The first pause displays the registration form with the mailbox already filled.
The owner types a new password directly into that browser and reports only that
the field is ready. The runner checks only that a nonempty value of sufficient
length exists; it never reads the value. It then submits registration and
independently confirms one new unverified Auth account while the profile and
membership remain absent.

Before clicking the verification button, the private JSONL journal is written
and fsynced with `VERIFICATION_SEND_MAY_BE_SENT`. The browser transport then
permits exactly one `accounts:sendOobCode` POST with
`requestType=VERIFY_EMAIL`; a second dispatch is rejected even after reload.
Timeout or lost response is `UNKNOWN` and forbids a resend under this package.

The second pause asks the owner to open the received message and click the
Firebase verification link in a separate mailbox/browser tab. The runner does
not read the mailbox, extract or generate an OOB code/link, or administratively
set `emailVerified`. The original invitation tab stays open with its capability
only in memory. After the owner reports completion, that tab executes its normal
`reload` + forced ID-token refresh + `acceptInvite` + `getCompanyAccess` path.

## Durable journal, safe stops and retained state

The private journal is created with `wx`, restrictive permissions and a full
fsync after every state transition. Each possible mutation has a durable
`MAY_BE_SENT` event before dispatch and a read-only reconciliation event after
the response. It retains run-scoped IDs, safe hashes, timestamps, update-time
preconditions, disposition and counters. It excludes mailbox, passwords, raw
invitation/OOB/ID/refresh tokens, provider bodies and raw errors. The public
result contains only counts, PASS/blocked state, artifact hashes and zero-leak
counters.

Safe-stop conditions include HEAD/PR/CI/artifact/resource/config drift, active
maintenance, mailbox or fixture collision, unexpected endpoint/callable/data,
short journal write or fsync failure, token/storage/log leakage, any second
email attempt, and every unknown non-idempotent mutation outcome. On a stop the
runner closes its browser and retains all confirmed or uncertain fixtures plus
the journal for read-only reconciliation. It does not improvise cleanup.

The owner mailbox Auth account is an intentional staging result after success:
it remains present and verified, with the owner-chosen password. This changes
the discovery baseline from absent to existing and must be recorded honestly.

## Cleanup and rollback boundary

No cleanup is authorized by this package. Existing Stage 8 instructions retain
fixtures and the deployment rollback window until a separate decision. A later
cleanup package must be generated from the successful private manifest and
fresh readback. It may delete only the exact synthetic/run-created Firestore
documents and the two synthetic Auth accounts. It must preserve the owner
mailbox Auth account, its email verification and password.

The cleanup planner must enumerate member and audit subdocuments explicitly;
deleting a parent company is insufficient. Owner profile/membership deletion,
if requested, uses the recorded create/update times as preconditions and stops
on drift. No wildcard collection deletion, Rules/index/Functions removal,
billing change, Artifact Registry policy, production action or automatic Rules
restore is included.

## Final execution command

The final reviewed commit will replace `REVIEWED_HEAD` and bind fresh preflight
receipt hashes. The exact invocation is emitted into a private approval file
only after the implementation self-tests, emulator rehearsal, independent PASS
and exact-head CI succeed. Until then this runbook is preparation, not owner
authorization and not evidence of a live email or completed SEC-006.

Before that package is generated, the owner has authorized one narrow
read-only Auth verification-template shape discovery against `finapp-staging`.
It runs only from a clean checkpoint HEAD, reads the Firebase project identity
and selected Auth configuration fields, omits template content and provider
credentials, and writes a new private sanitized receipt outside the checkout:

```text
node scripts/invitationRehearsal/authVerificationShapeDiscovery.mjs --project finapp-staging --expected-head <CHECKPOINT_HEAD> --out D:\projects\finapp\.runtime\stage8-auth-shape-<SHORT_HEAD>.json
```

The discovery performs no Auth/data mutation, callable invocation, email,
cleanup, production, Pages or merge action. A failed or drifting read leaves
the live executor marker in place.
