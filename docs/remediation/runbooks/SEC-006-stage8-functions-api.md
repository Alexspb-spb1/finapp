# SEC-006 Stage 8 — enable the Functions API on staging

Status: **PREPARED — NOT EXECUTED**. Separate owner approval is required for
this package. The previous inventory approval did not permit API enablement.

The approved read-only inventory stopped at Functions GET with HTTP 403,
`SERVICE_DISABLED`, after project/database GET succeeded. That evidence is
not permission to activate a service. This helper performs fresh preflight;
it does not assume the API remains disabled from the earlier response.

## Exact proposed scope

- Project: `finapp-staging` only.
- Requested activation: **`cloudfunctions.googleapis.com` only**.
- Artifact: `apiActivation.mjs`, `apiActivationCore.mjs` and imported
  `inventoryCore.mjs` at the final independently reviewed task SHA. The
  approval request must state that exact SHA and corresponding PASS/CI.
- No Functions deployment/build, billing-plan upgrade, manual activation of
  other APIs, operator IAM grants, Auth/data mutation, email or cleanup.
- Google may perform its normal provider-managed prerequisite/service-agent
  effects as part of activating this API. The approval explicitly covers
  those ordinary activation effects; it does not claim that exactly one
  cloud setting changes or that Service Usage metadata lists every effect.
- If Google requires a billing-plan upgrade, accepting terms, additional
  operator IAM work or another unknown operator choice, stop and prepare
  that concrete change separately. Do not accept prompts or broaden scope.

Enabling an API makes its service available; this request does not invoke a
Function, submit a build, create a function or change the billing plan.
Provider quota accounting may apply. No monetary amount is invented here;
any separately requested billable resource remains outside this package.

## Local contract and checks

The installed locked `firebase-tools` 15.24.0 source establishes:

- `lib/ensureApiEnabled.js`: `check()` uses GET
  `/v1/projects/{projectId}/services/{api}`; `enable()` uses POST to the same
  resource with `:enable`. Project ID is supported by the CLI contract.
- Its generic `ensure()` caches state, retries enable and can emit telemetry;
  **this helper does not call it**.
- `lib/operation-poller.js` reads a returned operation resource with GET and
  interprets `done`/`error`. The helper uses its own bounded poll loop.
- `lib/apiv2.js` uses global fetch and may retry transport failures. The
  helper's fetch guard permits at most **one native activation dispatch**,
  even if the library retries after a timeout/premature close. Do not infer
  that `retries: 0` alone guarantees a single network attempt.

The unauthenticated public [Service Usage v1 discovery document](https://serviceusage.googleapis.com/$discovery/rest?version=v1),
revision `20260819`, was also read during preparation, without project
requests or credentials. `services.get` takes only the resource name (no
`view` parameter) and returns service configuration/enabled state. Its Service
schema explicitly states that fields filtered out from List are present in
Get; `ServiceConfig.usage` references `Usage.requirements`. The enable request
schema is an empty object, and operations GET uses `operations/{id}`. Missing
or incompatible live fields still fail closed; documentation is not live
project-state evidence.

```powershell
npm.cmd run test:functions-api-preflight
node scripts/invitationRehearsal/apiActivation.mjs --help
```

The required CI self-test uses Node 24.16.0 and installed dependencies only.
Twelve local tests cover mode/project/service/HEAD/environment guards,
projected metadata, response validation, no activation in inspect mode,
single native dispatch after timeout, guarded redirects, already-enabled
idempotence, billing/unknown requirements, durable before-POST journal,
bounded LRO success/failure/timeout and HEAD changes. No credentials, local
SDK config values or live endpoints are accessed by these tests.

## Concrete command template for the final approval request

Replace the two uppercase placeholders with the reviewed 40-character SHA
and a new unique filename before asking permission. Do not execute placeholders.
Run directly on that clean task branch; this package does not require PR
merge or a Pages publication.

```powershell
git status --short
git rev-parse HEAD
node scripts/invitationRehearsal/apiActivation.mjs --mode enable --project finapp-staging --service cloudfunctions.googleapis.com --expected-head REVIEWED_HEAD --out D:\projects\finapp\.runtime\sec006-functions-api-UNIQUE.jsonl
```

The output parent must exist outside the checkout; the file must not exist.
The helper opens it exclusively and never overwrites another inventory or
journal. Every journal event checks the complete UTF-8 byte write and fsyncs
before continuing. A journal failure before activation blocks dispatch.
Keep this private evidence, including a returned operation name; do not put
raw provider responses or credentials in public Git.

## Execution sequence and request allowlist

1. Enforce exact project/service/mode and clean reviewed HEAD. Reuse the
   existing standard Firebase CLI account with a refresh token; reject
   access-token-only sessions, ADC/environment tokens, endpoint overrides,
   disabled TLS and unsafe environment spellings including Windows case
   variations. No login, account substitution or permission grant occurs.
2. GET `https://firebase.googleapis.com/v1beta1/projects/finapp-staging`,
   projected to `projectId,projectNumber`.
3. GET `https://serviceusage.googleapis.com/v1/projects/finapp-staging/services/cloudfunctions.googleapis.com`,
   projected to `name,state,config(name,usage(requirements))`. Confirm exact
   service identity and canonical project ID/number. Record fresh state and
   selected usage requirements only.
4. If already `ENABLED`, record `FUNCTIONS_API_ALREADY_ENABLED` and stop
   without POST. If state/requirements are malformed or unknown, stop.
5. Supported reported prerequisites are
   `serviceusage.googleapis.com/billing-enabled` and standard
   `serviceusage.googleapis.com/tos/cloud`. For billing, GET
   `https://cloudbilling.googleapis.com/v1/projects/finapp-staging/billingInfo`
   projected to `projectId,billingEnabled`; require existing enabled billing.
   Standard Cloud ToS is a known provider-enforced prerequisite: the enable
   endpoint must enforce already-fulfilled terms. This helper does not
   independently verify acceptance and has no acceptTerms request; a refusal
   or precondition error stops the run without accepting terms or retrying.
   The public discovery `Usage.requirements` description states Cloud APIs
   must include `serviceusage.googleapis.com/tos/cloud`; merely seeing this
   known requirement is not treated as a request to accept new terms.
   An explicit empty requirement list is also supported. Missing/unknown
   requirements stop activation. Never upgrade billing or accept terms.
6. Persist the preflight, read service state again, require unchanged
   requirements, recheck clean reviewed HEAD, then durably record
   `API_ENABLE_REQUEST_MAY_BE_SENT` **before** dispatch.
7. POST **once at most** to
   `https://serviceusage.googleapis.com/v1/projects/finapp-staging/services/cloudfunctions.googleapis.com:enable`
   with `{}`. The fetch boundary rechecks HEAD immediately before native
   dispatch and permanently consumes the single attempt even on failure.
8. Validate and immediately journal the returned operation name, then allow
   GET only to that exact `https://serviceusage.googleapis.com/v1/operations/{id}`.
   Poll at most 12 times, waiting five seconds between polls; request timeout
   is ten seconds. Library GET retries and auth latency can extend wall time;
   this is an attempt bound, not a promise of completion within one minute.
9. Require operation `done=true` without error, then freshly GET service
   state and verify `ENABLED` plus unchanged clean reviewed HEAD. Record
   `FUNCTIONS_API_ENABLED_VERIFIED`.

All resource GETs and the one POST use fixed origins/paths and reject
redirects. Standard CLI session refresh is the only additional POST:
`https://www.googleapis.com/oauth2/v3/token`, also with redirects rejected.
Provider errors/response bodies are suppressed; journal events expose only
selected metadata and fixed outcomes. No `batchEnable`, `disable`, arbitrary
operation GET, Functions/IAM/billing mutation or other service activation
can pass this helper's transport guard.

## Safe stops, uncertainty and rollback

- Exit `0`: inspection or an already-enabled/verified-enabled API only. This
  does not mean deployment, invitations or production readiness.
- Exit `2`: precondition failure, operation failure or journal/access error.
- Exit `3`: `API_ENABLE_UNCERTAIN` after an ambiguous POST, malformed result,
  poll timeout/read error, HEAD drift or inconsistent postcondition.
- `beforeState` identifies preflight only. `observedAfterState` is null unless
  a later service GET established it; an uncertain/failed operation does not
  claim the API remains disabled from its initial state.
- Any journal ending in `API_ENABLE_REQUEST_MAY_BE_SENT` is also uncertain
  even when the process crashed before recording another event. A partial
  final journal line must not erase the preceding durable uncertainty event.

After any possibly dispatched request, **do not rerun enable**. Preserve the
journal and obtain current service/operation state read-only. The separately
invocable `--mode inspect` with the same fixed target, reviewed SHA and a
new output file reads current service metadata without POST. Resuming an
unresolved operation after this process ends requires an explicitly reviewed
read-only command for the exact journaled operation; this helper does not
accept an arbitrary operation argument.

There is no automatic disable/rollback. Disabling an API can affect existing
workloads and dependencies, so any such reversal requires a fresh impact
inventory and separate owner-approved command. The retained before-state
and operation journal support that decision but are not a backup of the
whole project. Existing Rules/Functions artifacts, financial data, SEC-005
backups and rollback windows remain untouched.

The final owner-approved package may explicitly bundle successful activation
and then the original full inventory at the same newly reviewed HEAD. In
that case execute both authorized steps without asking again; stop before
inventory if activation is unsuccessful or uncertain. If the approval does
not include inventory, do not silently add it. Functions, Rules,
indexes, fixture writes, real verification email and rehearsal remain open
and require their later concrete package. No SEC-005 migration or maintenance
command is included here.
