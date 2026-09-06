# Stage 7 local acceptance evidence

Only synthetic demo-finapp fixtures; no real emails, financial data or live calls.
`acceptance.json`, `accept-desktop.png`, `accept-mobile.png` describe the actual
Chromium run against a production build with local emulator configuration.

Prerequisites: locked npm installs; root Node24.16.0/npm11.13.0; Functions
Node22.23.2; Java21; matching Playwright1.63.0/Chromium headless shell1243.
`FINAPP_BROWSER_TOOLS` points at a separate package directory containing
Playwright (`D:/projects/finapp/.runtime` on the author's host).

Run Auth/Firestore/Functions emulators for demo-finapp (firebase.json ports),
build Functions first. Copy only synthetic emulator configuration into ignored
`.env.development.local`, as specified in `.env.example`, with demo-finapp ID,
emulators=true and a dummy API key. Never reuse live credentials.

```powershell
npm.cmd run build -- --mode development
npm.cmd run preview -- --host 127.0.0.1 --port 5176 --strictPort
```

In a separate shell, from repository root:

```powershell
$env:FINAPP_BROWSER_TOOLS='D:\projects\finapp\.runtime'
node scripts/browser/stage7-smoke.cjs
node scripts/browser/stage7-bootstrap.cjs
```

Smoke creates synthetic users/invitations through the local callable pipeline.
It redeems the actual Auth Emulator verification action code (not an Admin SDK
emailVerified shortcut). It proves no profile/company at invitation registration,
no early financial module/cache loading, unverified and wrong-account denial,
viewer/accountant acceptance, replay without writes, disabled-member denial,
post-accept logout/re-login with a new-document sentinel, two-tab logout, refresh
recovery using a fresh tab, and responsive rendering. Network is loopback-only.
Run after other emulator tests; suites share system/maintenance and database.

Bootstrap verifier serves actual dist/404.html and injects a real external
observer into every downstream production module. A separate loopback server
receives real POSTs containing only the scrubbed URL. Five cases passed: valid,
malformed value, malformed key, duplicate token plus retained anchor, unrelated
anchor. Build also enforces a static module allowlist before the scrub.

Earlier attempts recorded two harness limitations: same-document navigation to
the original fragment cannot recapture a memory token (new-tab recovery is now
explicit), and old Login labels are not programmatically associated (the helper
uses its existing input types). One Vite HMR run lost the transient token; final
acceptance deliberately uses the production build, without HMR. Independent
review found post-accept re-login stuck in loading; explicit sanitized reload
corrected it and the real browser document sentinel verifies that correction.
An observer run against a build with no Firebase configuration timed out before
rendering; the documented mode-development build with synthetic configuration
is required for browser execution. The ordinary unconfigured build still passes
the mandatory compile/build check; it is not a usable runtime artifact.

This evidence does not establish real email delivery or live membership Rules.
Stage8 and SEC008/009/011/STATE001 remain separate open requirements.
