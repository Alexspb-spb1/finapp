# SEC-006 Stage 8: integrated local rehearsal

`scripts/browser/stage8-rehearsal.cjs` exercises the actual production `dist`
through a loopback static server, including the generated Pages `404.html`.
It does not use Vite, HMR, application-source imports, mocked callable responses,
or the Firebase Admin SDK to accept invitations. Admin is used only for synthetic
fixtures and independent database assertions in `demo-finapp`.

Prerequisites: root dependencies installed, production build with the explicit
synthetic emulator Firebase environment, Auth/Firestore/Functions emulators on
127.0.0.1 ports 9099/8080/5001, and Playwright Chromium available. Port 5176 must
be free; the helper starts and stops its static server itself.

```powershell
$env:FINAPP_BROWSER_TOOLS = 'D:\projects\finapp\.runtime'
node scripts/browser/stage8-rehearsal.cjs
```

The scenario begins with administrator UI create and actual clipboard copy,
then new-user registration and existing-user sign-in. Both unverified identities
are denied access before the UI requests a verification email. The helper consumes
the actual Auth emulator email action code, returns to the original browser tab,
and verifies acceptance and canonical membership. This is **not real email delivery**.

Additional cases cover cancelled/expired invitations, wrong account, rotation and
old-token denial, 60-second cooldown and five rotations, double click, a real
successful accept response deliberately dropped before delivery, idempotent retry
with unchanged invitation/member/profile update times, offline failure/recovery,
two independent clients accepting simultaneously, and cross-company role isolation.
Synthetic timestamps advance only cooldown/expiry fixtures; the helper does not
wait seven days or mutate emulator email verification flags.

Browser requests are restricted to fixed loopback ports. The existing financial
app requested its exchange-rate API once after admin login; that request was
aborted before sending and recorded as `legacy-exchange-rate`. Every other
external origin fails the check. Evidence uses fixed labels, never arbitrary
hostnames or exception names. Capability tokens never
enter network URLs, web storage, IndexedDB, screenshots, traces, console output,
or evidence files. There are no browser traces or raw failure dumps. Named steps
and helper source line numbers identify failures without exposing request payloads.

On success `rehearsal.json` records the exact HTML/JS/CSS artifact hashes, scenario
names and isolation counters; `accepted-viewer.png` shows a synthetic accepted
viewer. A failed run writes only `failure.json` with safe step/counter evidence.
Use the report/checkpoint to distinguish an earlier failed run from a later PASS.

Local PASS does not close SEC-006. Actual staging/production deployment, real
verification email delivery and release acceptance remain separate external gates.

## Recorded local execution

The full static-browser rehearsal passed: 13 isolated browser contexts, zero
uncaught page errors, zero capability-bearing network URLs, one blocked legacy
exchange-rate attempt and zero live actions. The screenshot was inspected: it
shows the synthetic Alpha company and the accepted viewer's read-only banner.

Emulator cold-start discovery initially exceeded the default 10 seconds; the
suite started successfully with `FUNCTIONS_DISCOVERY_TIMEOUT=60`. That was an
infrastructure startup issue, preceding browser execution.

Intermediate helper failures were corrected before the complete PASS:

- The role select's computed accessible name includes option text; the helper
  now selects the only combobox inside the create dialog. The company selector
  similarly matches the actual company name without assuming span whitespace.
- Moving only `lastSentAt` produced an impossible synthetic chronology, which
  the real resend callable correctly rejected. Cooldown fixtures now move
  `createdAt` and `lastSentAt` consistently.
- The storage observer initially ran in auxiliary blank documents and caused
  `SecurityError`. It is now restricted to actual app-origin documents; the
  complete rerun recorded zero page errors without suppressing app errors.

The final evidence contains the successful run only. No production code was
changed to accommodate the rehearsal.
