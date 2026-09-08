# SEC-006 Stage 8 — live staging invitation and real-email acceptance

Status: **LOCAL REVIEW REMEDIATION VALIDATED — INDEPENDENT RE-REVIEW/EXACT-HEAD CI PENDING; LIVE FIXTURES/EMAIL NOT AUTHORIZED**.

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
the response. A separate append-only, hash-chained recovery stream is created
at `<out>.recovery.jsonl` with `wx`. Every accepted checkpoint is fully
written, fsynced and reread before execution can continue. It retains the exact
run-scoped Auth/Firestore/audit IDs, planned synthetic Auth UIDs, raw generated
`createCompany` idempotency material, provider snapshots, safe hashes,
create/update timestamps, CAS preconditions, dispositions and counters needed
for later reconciliation or cleanup. A complete `FINAL_MANIFEST` is durable
before teardown and before the one `--out` write; `RECOVERY_REQUIRED` remains
available if HEAD drift or output failure prevents the final output from being
committed. No second `--out` write is attempted. The recovery stream and output
exclude the mailbox, passwords, raw invitation/OOB/ID/refresh tokens, provider
bodies and raw errors. The returned public result contains only counts,
PASS/blocked state and artifact/evidence hashes.

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

The authorized discovery completed on clean checkpoint HEAD
`31c8aed4987c8fdde203744845dd6cdb4d4696de`. Private receipt:
`D:\projects\finapp\.runtime\stage8-auth-shape-31c8aed.json`, file SHA-256
`60ddb5305ea431f255abb259f7ad6a5c413f7e7e7abd8c966644085102eee1cc`.
It confirms enabled email/password signup, user signup not disabled, and the
required verification method/template/callback metadata. The sanitized
metadata SHA-256 is
`18f79f56b79525cf78aba6aa9c73cb310a92fd19ee3f1fa25d665e8ef6ddaa50`.
The first strict read stopped without a receipt because Firebase omitted a
protobuf-default `false` field; a sanitized field-presence probe confirmed that
shape, the validator was narrowed to that documented omission, and the clean
retry passed. All three invocations were read-only and emitted no provider
body, domain, mailbox, credentials or token.

## Independent-review remediation checkpoint

The first independent review of clean checkpoint HEAD
`337016d29e3f53dced939c03141f7369ba295856` returned `CHANGES REQUIRED` on
three remaining gaps: six unconditional scenario PASS rows without the claimed
UI observations, fail-open clipboard cleanup without a real admin copy-link
check, and no durable private recovery/cleanup manifest with exact recovery
material.

The corrected local tree now:

- creates the first mailbox invitation through the actual owner-A admin UI,
  validates the displayed link and clipboard value, immediately clears the
  clipboard and proves an empty readback; missing Clipboard API is a hard stop;
- permits the one synthetic empty invitation-list bootstrap only after a fresh
  exact Firestore query proves zero Company-A invitations, while the post-create
  list request is sent to the real callable and reconciled through the journal;
- records 11 typed Playwright evidence rows for admin/viewer/accountant UI,
  company switching, direct `/users` denial, offline/online recovery, two-tab
  logout and mailbox reload, then derives each of the six scenario PASS rows
  from both backend and required UI evidence;
- preserves the verified mailbox page until all post-fixture UI checks finish;
- writes the private recovery manifest on success and ordinary safe-stop paths,
  including all 16 fixture slots, all 14 read-only slots, verification-email
  state, exact resource/audit paths and IDs, generated idempotency inputs,
  timestamps, CAS cleanup preconditions and deferred cleanup dispositions.

Current local checks after these corrections: aggregate live executor 70/70,
adapters 13/13, runtime 11/11, Playwright 24/24, loopback 7/7, root unit
248/248, Rules 126/126, migration 570/570, Functions unit 354/354 and Functions
emulator 224/224. Root/Functions lint, typecheck and builds pass; root lint keeps
the pre-existing `Balance.tsx` hook warning. The first Rules command selected
the system Java 17 and stopped before tests; the required rerun explicitly put
the retained portable JRE 21 first in `PATH` and passed.

These results remain local evidence on an uncommitted tree. A clean commit,
independent `PASS`, matching PR head and successful exact-head `ci` plus
`functions` checks are still required before generating the private section-8
execution package. No live fixture, verification email, cleanup, production,
merge or Pages action was performed by this remediation.

### Second independent review and durable-recovery correction

Independent review of committed checkpoint HEAD
`bb5d1ea9350a8f0e0507af6537102b91a356a5ca` returned `CHANGES REQUIRED` on
four concrete blockers: the held admin callable summarizer rejected
`inviteMember`/`listInvitations`; the runtime reused unprepared stateful
readback closures for the replacement admin operations; recovery existed only
in process memory until final output paths; and an unexpected browser endpoint
could be aborted without necessarily invalidating otherwise successful UI
evidence.

The current local remediation gives the admin invitation and post-create list
operations their own prepare/dispatch/readback lifecycle and exact semantic
reconciliation. Held admin responses now use their validated sanitized shapes.
Mailbox, admin and post-fixture browser drivers latch every denied, unexpected
or classifier-error auxiliary route and refuse successful evidence afterward.
The runtime passes one durable recovery checkpoint to both the executor and the
incremental provider reconciler. The CLI proves the deterministic recovery path
`<out>.recovery.jsonl` is new, outside the checkout, has a real existing
parent and is distinct from the approval, journal and output paths before
loading the runtime.

Current local validation after all four corrections: root unit 248/248, Rules
126/126, migration 570/570, Functions unit 354/354, Functions emulator 224/224,
aggregate live executor 77/77, core 9/9, adapters 14/14, CLI 5/5, operations
2/2, runtime 11/11, Playwright 26/26 and loopback 7/7. Staging preflight and Auth
template discovery remain 5/5 each. Root/Functions lint, typecheck and builds
pass; root lint retains only the pre-existing `Balance.tsx` warning, and
`git diff --check` passes.

This corrected tree still requires a clean commit, independent `PASS`, matching
PR27 head and successful exact-head `ci` plus `functions` checks before the
private section-8 execution package can be generated. No live fixture,
verification email, cleanup, production, merge or Pages action was performed.

The first exact-head CI attempt for this correction, run `34269739048`, exposed
one test-fixture portability error: the mock Firebase loader received a
hard-coded Windows repository path, which its production absolute-path guard
correctly rejected on the Linux runner. The `functions` job passed, while `ci`
stopped at the aggregate executor before later checks. The fixture now uses
`path.resolve('.')`; the aggregate executor again passes 77/77 locally. A new
clean HEAD, independent review and both exact-head jobs are required.

The next exact-head run, `34270362756`, confirmed the loader fixture fix and
again passed `functions`, but found four remaining source locations with
Windows-only literals in the
composition test's journal/output paths. They are now derived from the native
filesystem root with `node:path`; a full scan finds no drive-letter literals in
the invitation self-tests, and the aggregate executor passes 77/77 locally.
This second failed run is also not a release gate.

Exact-head run `34271204957` subsequently passed both `ci` and `functions` on
independently reviewed HEAD `628bc8945dd5184cf495958e0157c4455e700af0`.
The following zero-network package-pin calculation exposed one local
integration mismatch: the new runtime and loopback guards used a JSON digest
for the six-field Firebase Web config, but the retained staging file and the
existing BASE-002 preflight use the canonical `key=value` newline digest from
`scripts/lib/firebaseConfigFingerprint.mjs`. That mismatch failed closed before
credentials or network, yet prevented any approved run. Both guards now reuse
the existing canonical helper, and regression tests prove they do not accept
the obsolete JSON digest. The hash-only local prerequisite check now accepts
the retained config/mailbox, and `build:staging` passes with that same canonical
fingerprint (after repeating outside the known sandbox Vite spawn/native-binding
restriction). A fresh independent review and exact-head CI remain required
before emitting the private execution artifact.

The first generated private package was rejected by independent review before
execution. Its command commitment used prior output names, the described
one-hour authorization was not enforced by the executor's former 24-hour upper
bound, and several procedural steps lacked exact commands. The executor now
requires an approval lifetime of exactly one hour and tests that even a
correctly rehashed two-hour artifact is rejected. After new review and
exact-head CI, the package must be regenerated with a reviewed fixed-path local
helper plus exact freshness, execution and postflight commands. The rejected
package does not authorize live work.

The next review found that the one-hour interval was exact but the instant
`now === expiresAt` still passed. The current CLI rejects at and after expiry,
with a regression assertion for the exact boundary. It remains subject to a
fresh review and exact-head CI before package regeneration.
