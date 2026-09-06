# SEC-006 Stage 6 synthetic browser evidence

Source runner: `scripts/browser/stage6-smoke.cjs` (run from repository root).
Requires root npm ci, Functions npm ci/build under Node22, Java21 and a local
Playwright1.63.0 + matching Chromium. Browser automation dependency may be
installed in an isolated tools directory; set FINAPP_BROWSER_TOOLS to that
directory (its node_modules must contain playwright). No application runtime
dependency or new global npm test:e2e command is introduced.

Start Auth/Firestore/Functions Emulator Suite with `--project demo-finapp`
and ports 9099/8080/5001 using the committed firebase.json. Start Vite at
`127.0.0.1:5176` with `.env.development.local` containing synthetic Firebase
configuration: VITE_APP_ENV=development, VITE_USE_FIREBASE_EMULATORS=true,
VITE_FIREBASE_PROJECT_ID=demo-finapp, VITE_FIREBASE_API_KEY=demo-key,
VITE_FIREBASE_AUTH_DOMAIN=demo-finapp.firebaseapp.com,
VITE_FIREBASE_STORAGE_BUCKET=demo-finapp.appspot.com,
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789,
VITE_FIREBASE_APP_ID=1:123456789:web:demo. Emulator hosts use loopback defaults.

Run `node scripts/browser/stage6-smoke.cjs`. Only loopback browser requests
are allowed. The script fixes Admin SDK project/hosts to demo-finapp localhost
before importing Firebase; creates fresh synthetic users/companies; never logs
raw invitation links/tokens or takes screenshots of them. Output screenshots
are desktop.png, mobile.png and mobile-create.png in this directory by default;
FINAPP_BROWSER_ARTIFACTS can select another directory. The script does not clean
up documents/users or touch other projects; stop local emulators after use.

Observed PASS (2026-09-06): create/list/resend/cancel through real callables;
no Auth-user creation by invitation; fragment link/clipboard; no token in local
or session storage; company switch clears link/data; mobile width; offline
refresh denial/recovery; two-tab logout; viewer/accountant denied. Rotation
backdates only its synthetic fixture by 120 seconds. The native dialog is also
captured at mobile width and closed using Escape. This is Stage6 verification,
not the Stage7 accept flow, actual email delivery or production acceptance.

Screenshots: desktop.png, mobile.png, mobile-create.png. All users and emails
are synthetic example.test fixtures; no secrets or live financial data.