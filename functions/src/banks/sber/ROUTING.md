# BANK-003 — OAuth ingress contract (design, not deployed)

The Sber browser flow needs one stable HTTPS origin for the FinУчёт page,
`begin`, the bank callback and the result page. `createSberHttpHandlers` validates
that the three configured URLs have this same origin. The temporary
`__Host-finapp-sber` cookie is issued by `begin` and must arrive unchanged at
`callback`. The OAuth state is additionally stored as a hash and bound to the
verified Firebase user, company, nonce and connection generation.

## Proposed routes on the selected origin

| Route | Owner | Purpose |
|---|---|---|
| `/finapp/` and `/finapp/banks` | Static SPA | Bank connection page and result status read |
| `POST /api/banks/sber/begin` | Private BANK-003 handler | Fresh admin session and authorization URL |
| `GET /api/banks/sber/callback` | Private BANK-003 handler | One-time code exchange and clean redirect |

Once an approved hostname `H` is allocated and the proxy has been validated,
register **exactly** `https://H/api/banks/sber/callback` as the sandbox
`Redirect URI`. Set `beginUrl=https://H/api/banks/sber/begin` and
`returnUrl=https://H/finapp/banks`. The result URL flag is only a UI hint;
the page must fetch authorized connection status. Do not register a guessed
hostname or the current `https://` placeholder in the Sber cabinet.

## Ingress constraints and acceptance checks

- Serve the SPA and these two handlers from the same browser origin. Preserve
  the request `Cookie` to the callback and the response `Set-Cookie` from begin
  and callback, including Path=/, Secure, HttpOnly, SameSite=Lax and no Domain.
- Forward the original path and query only to the callback handler. No redirect
  or CDN cache may contain an OAuth code, state or cookie. Exclude callback
  query strings and Authorization/Cookie/Set-Cookie headers from ingress,
  proxy, CDN, application and error logs.
- Deny arbitrary CORS. Begin must require a recent Firebase ID token, exact
  Origin and same-origin Fetch Metadata. Callback must receive the host-only
  cookie after a top-level bank redirect; duplicate/malformed parameters fail.
- In a browser on the final origin, prove the begin response sets the cookie,
  the bank redirect returns that cookie, the callback sends a clean 303, and
  a second callback cannot activate again. Test a missing cookie and another
  user's session. Compare authorized status and account bindings, not the
  URL hint. Repeat after process restart.
- Run an ingress log inspection with synthetic canary values for code, state,
  Authorization and cookie. No canary may appear in persisted logs or traces.
  Verify request limits and timeout budget against the 30-second callback.

The current frontend deploys to GitHub Pages (`/finapp/`), which is static and
has no same-origin backend. Firebase Hosting rewrites to Functions/Cloud Run
strip ordinary incoming cookies and forward only a specially named
`__session` cookie. Renaming this host-prefixed callback cookie would change
the security contract. Therefore neither existing GitHub Pages nor a direct
Firebase Hosting rewrite meets the contract as written. Choose and review a
cookie-preserving HTTPS ingress that serves the SPA and routes to the private
backend (for example a dedicated reverse proxy) before configuring the bank.
Do not deploy a placeholder route or mount BANK-003 before signature/trust,
secrets, session issuance, logging and sandbox gates are passed.

Primary routing references:
https://firebase.google.com/docs/hosting/manage-cache
https://firebase.google.com/docs/hosting/full-config
