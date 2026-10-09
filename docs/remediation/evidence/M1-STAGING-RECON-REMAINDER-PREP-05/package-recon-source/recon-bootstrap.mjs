// Credential bootstrap of the read-only reconciliation: a READ-ONLY look at the cached Firebase CLI login. This is the ONLY place that touches an owner credential file,
// and it is reached only from the permitted `execute` path after the one-use claim - never from plan / selftest / permit-draft / tests.
//
// Why not the CLI's own request path: firebase-tools (lib/auth.js refreshTokens -> updateAccount -> configstore.set("tokens", ...)) WRITES the refreshed token back to the owner's
// configstore file, answers an HTTP 400/401 of the token endpoint by using the REFRESH token as the access token, and refreshes again on any 401 of an API call. Those are
// undeclared extra calls and a write to an owner credential file, so this package does none of it:
//   - it reads `tokens.access_token` and `tokens.expires_at` from <XDG_CONFIG_HOME or ~/.config>/configstore/firebase-tools.json (the file firebase-tools itself uses), in memory;
//   - it requires the cached access token to stay valid for at least `minRemainingMs` (longer than the whole bounded run), otherwise it STOPS (the owner refreshes the login
//     with the normal Firebase CLI BEFORE the run - an action of the owner, outside this package);
//   - it never calls the token endpoint (not in the request allowlist), never writes the file, never prints or stores the token; a 401/403 of an API is a STOP, not a refresh.
// Everything here fails closed with a closed code (no path, content or message of the underlying error).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Blocked, RECON } from './recon-pins.mjs'

export function configPath(env = process.env, homedir = os.homedir()) {
  const base = env.XDG_CONFIG_HOME || path.join(homedir, '.config')
  return path.join(base, 'configstore', 'firebase-tools.json')
}

/** Returns { accessToken, remainingMs, reads: 1, writes: 0, tokenEndpointCalls: 0 } or throws Blocked(<closed code>). `fsx` is injectable for tests. */
export function readCachedLogin({ env = process.env, now = () => Date.now(), minRemainingMs = RECON.limits.minTokenRemainingMs, fsx = fs, homedir = os.homedir() } = {}) {
  let text
  try { text = fsx.readFileSync(configPath(env, homedir), 'utf8') } catch (e) { throw new Blocked(e?.code === 'ENOENT' ? 'credential-config-missing' : 'credential-config-unreadable') }
  let tokens
  try { tokens = JSON.parse(text)?.tokens } catch { throw new Blocked('credential-config-unreadable') }
  text = null
  const accessToken = tokens?.access_token
  const expiresAt = tokens?.expires_at
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4096 || /\s/.test(accessToken) || !Number.isFinite(expiresAt)) throw new Blocked('credential-token-missing')
  const remainingMs = expiresAt - now()
  if (remainingMs < minRemainingMs) throw new Blocked('credential-too-old')
  return { accessToken, remainingMs, reads: 1, writes: 0, tokenEndpointCalls: 0 }
}
