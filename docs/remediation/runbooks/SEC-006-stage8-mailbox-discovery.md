# SEC-006 Stage 8 — mailbox discovery approval package

Status: **PREPARED — NOT EXECUTED**. This is a narrow read-only prerequisite
for the later live invitation/email rehearsal. It does not authorize creating
an Auth account, writing Firestore documents, calling a deployed Function,
sending email, cleanup, deployment, merge, Pages or production activity.

## Purpose and fixed scope

The owner supplied a mailbox privately. Before choosing the new-user or
existing-user rehearsal path, determine whether that exact address already has
an account in `finapp-staging` and, only if it does, whether its exact
`users/{uid}` profile exists. An existing account/profile is preserved and
stops preparation of a new-user mutation package until its impact is reviewed.

The mailbox lives in a private one-line file outside the checkout. Neither the
address, UID, profile content nor credentials appear in source, console output
or the private result. The result retains only existence flags, email-verification
state, account creation epoch when supplied by Firebase, and SHA-256 hashes of
the UID and raw Firestore profile fields.

## Required gates and exact command

Bind `REVIEWED_HEAD` to the clean commit independently reviewed for this helper
and require exact-head `ci`/`functions` success on Draft PR27. Use the existing
Firebase CLI login only; no ADC, service-account file, emulator, debug mode,
custom endpoint or alternate identity is allowed. Both private paths must be
absolute and outside the checkout, and the output must not exist.

```powershell
node scripts/invitationRehearsal/mailboxDiscovery.mjs --self-test
node scripts/invitationRehearsal/mailboxDiscovery.mjs --project finapp-staging --expected-head REVIEWED_HEAD --mailbox-file D:\projects\finapp\.runtime\stage8-mailbox.txt --out D:\projects\finapp\.runtime\stage8-mailbox-discovery-REVIEWED_HEAD.json
```

The real command issues only:

1. `GET /v1beta1/projects/finapp-staging` with a response projection;
2. one read-only `POST /v1/projects/finapp-staging/accounts:lookup` containing
   the exact mailbox in the request body;
3. only if the account exists, one `GET` for its validated
   `/v1/projects/finapp-staging/databases/(default)/documents/users/{uid}`;
4. a normal OAuth refresh POST if the existing CLI session requires it.

The guarded fetch boundary rejects every other host, project, path and method,
all redirects, request bodies on GET, any lookup body other than the one exact
mailbox, and a profile request before the returned UID is validated and
explicitly allowed. Every resource request uses a fresh options object and
`retries:0`, so the installed CLI cannot retain the lookup body on a later GET
or replay the lookup after a transport failure. The helper rechecks clean exact HEAD after the requests and
creates the private receipt with `wx`, never overwriting evidence. Provider
errors are collapsed to one fixed message.

## Decision after discovery

- `accountExists=false`: prepare a bounded new-user live package. It may later
  create one synthetic verified admin, one synthetic company, one invitation,
  one owner-controlled Auth registration, one Firebase verification email and
  exact cleanup, but none of those actions is authorized here.
- `accountExists=true`: preserve the account. A later package must use the
  existing-user flow and separately back up/review any profile or membership
  changes. It must not reset the password, administratively verify email or
  overwrite the profile.

This read-only result does not verify email delivery, invite behavior or access,
and does not close SEC-006.
