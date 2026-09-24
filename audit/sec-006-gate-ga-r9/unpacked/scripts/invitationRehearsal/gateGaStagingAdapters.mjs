// Real staging adapters for the gate-G-A orchestrator's 'staging' profile —
// the twin of gateGaEmulatorAdapters.mjs, same adapter interface, but bound
// to real `https://us-central1-finapp-staging.cloudfunctions.net`,
// real Firestore/Auth Admin REST (via the already-guarded firebase-tools
// session/Client — createGateGaStagingRestClient, added to
// liveAcceptanceExecutorAdapters.mjs specifically for this file), and real
// Identity Toolkit REST for the recipient's own registration/verification,
// using the real Web API key from the reviewed .env.staging.local (via
// parseStagingConfig, unchanged, reused from liveAcceptanceExecutorRuntime.mjs).
//
// NEVER EXECUTED against real staging in this session — see the R4 package
// notes. Proven only via (a) unit-level DI/stub composition
// (gateGaStagingCliSelfTest.mjs, gateGaStagingAdaptersCoreSelfTest.mjs) and
// (b) the fully real, independently exercised emulator twin
// (gateGaEmulatorAdapters.mjs, gateGaIntegrationSuite.mjs).
//
// FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9: an independent review of R8 found
// that its recovery/reconciliation logic (closing the crash windows between
// an external effect completing and this run's own local durable write
// recording it) had only ever been implemented in the EMULATOR twin — this
// file, the one that would actually run against real staging, still used
// R7's process-local `runTag` for admin identity and had no
// reconcileAdminAndCompany/reconcileInvitation/findAuthUidByEmail at all.
// R9 closes that gap for real, in this file, with one structural
// difference from the emulator: Identity Toolkit's `accounts:signUp` can
// NEVER be given a caller-chosen uid (the server always assigns it) — so
// where the emulator adapter forces an exact Auth uid via the Admin SDK,
// this file instead derives a deterministic EMAIL from the run's own
// durable runId (gateGaAdminIdentityCore.mjs — the exact same shared
// function the emulator adapter uses) and recovers the real, server-
// assigned uid by an exact accounts:lookup on that email. No password is
// ever needed on resume either: reconciliation resets the admin's password
// via the Admin-level accounts:update endpoint this file already calls for
// emailVerified (an OAuth-scoped, admin-authorized call — not the public
// API-key surface), then signs in with the fresh password. Both identity
// derivations are pure functions of runId alone, so they are
// independently, byte-for-byte recomputable by a genuinely separate
// process with its own fresh runTag — no extra "remember it somewhere"
// bookkeeping beyond the run-id claim that already exists before the
// first external call.
//
// This file's actual logic — every branch, every lookup, every
// reconciliation decision — now lives in the exported, network-agnostic
// createGateGaStagingAdaptersCore({rest, identity, callable, project}):
// injectable REST/identity/callable clients, so gateGaStagingAdaptersCoreSelfTest.mjs
// can exercise the REAL branches this file runs (not just its emulator
// twin) against controlled fakes, with zero network and zero emulator
// dependency. createGateGaStagingAdapters (below) is now a thin wrapper
// that builds the real guarded session/REST client and the real Identity
// Toolkit/callable HTTP calls, then delegates to the core.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { PROJECT } from './inventoryCore.mjs'
import { createGuardedFirebaseToolsSessionLoader, createGateGaStagingRestClient } from './liveAcceptanceExecutorAdapters.mjs'
import { parseStagingConfig } from './liveAcceptanceExecutorRuntime.mjs'
import { deriveAdminIdentity } from './gateGaAdminIdentityCore.mjs'
import { computeInvitationLockId } from './gateGaInvitationLockCore.mjs'

const blocked = reason => { throw new Error(`gate_ga_staging_adapters_blocked:${reason ?? ''}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const FUNCTIONS_BASE_URL_FOR = project => `https://us-central1-${project}.cloudfunctions.net`

// R9: recurses into `mapValue` — a real Firestore REST document field
// (e.g. `user_bootstrap/{uid}`'s `result` field, an object, not a scalar)
// is returned as `{mapValue: {fields: {...}}}`, and the ORIGINAL flat
// version of this function (never actually exercised against a real
// nested field before R9's reconcileAdminAndCompany started reading
// `result.companyId`) would have silently passed that whole wrapper
// through unparsed — `result.companyId` would have been `undefined`
// against real staging Firestore. Caught by gateGaStagingAdaptersCoreSelfTest.mjs,
// which is exactly why that file's fakes model the real nested REST shape
// instead of a flattened approximation.
function firestoreValueToPlain(fields) {
  const out = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if ('stringValue' in value) out[key] = value.stringValue
    else if ('booleanValue' in value) out[key] = value.booleanValue
    else if ('integerValue' in value) out[key] = Number(value.integerValue)
    else if ('doubleValue' in value) out[key] = value.doubleValue
    else if ('nullValue' in value) out[key] = null
    else if ('timestampValue' in value) out[key] = { toMillis: () => Date.parse(value.timestampValue) }
    else if ('mapValue' in value) out[key] = firestoreValueToPlain(value.mapValue.fields)
    else if ('arrayValue' in value) out[key] = (value.arrayValue.values ?? []).map(v => firestoreValueToPlain({ v }).v)
    else out[key] = value
  }
  return out
}

// R6: real CSPRNG, not Date.now()/Math.random() (neither is a
// cryptographically secure source — Math.random() in particular is
// predictable). Bounded synthetic password for a bounded synthetic account
// this same run creates and deletes — never a real credential, never reused
// across runs.
export function cryptoPassword() {
  return `GateGA-${randomBytes(24).toString('base64url')}!Aa1`
}

/**
 * The real adapter logic, network-agnostic: every branch a real staging run
 * would take, driven entirely by the injected `rest`/`identity`/`callable`
 * clients — never `fetch` or any other hardcoded transport directly. This
 * is what gateGaStagingAdaptersCoreSelfTest.mjs exercises with controlled
 * fakes to prove the REAL staging code (not just the emulator twin) closes
 * every R9-reviewed gap: deterministic-by-runId admin identity, real
 * reconciliation of admin/company/invitation/recipient, a real
 * `lockPath` from `inviteRecipient` (was hardcoded `null`), and cleanup
 * that actually removes the invitation lock document, not just the
 * invitation itself.
 */
export function createGateGaStagingAdaptersCore({ rest, identity, callable, project = PROJECT, generatePassword = cryptoPassword }) {
  if (!rest || typeof rest.get !== 'function' || typeof rest.post !== 'function' || typeof rest.del !== 'function' || typeof rest.documentsRoot !== 'string') blocked('bad_rest_client')
  if (typeof identity !== 'function') blocked('bad_identity_client')
  if (typeof callable !== 'function') blocked('bad_callable_client')
  const accountsUrl = p => `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:${p}`
  function docPath(relative) { return `${rest.documentsRoot}/${relative}` }

  async function lookupByEmail(email) {
    const lookup = await rest.post(accountsUrl('lookup'), { email: [email] })
    return lookup.users?.[0] ?? null
  }
  async function lookupByUid(uid) {
    const lookup = await rest.post(accountsUrl('lookup'), { localId: [uid] })
    return lookup.users?.[0] ?? null
  }
  async function readDocOrNull(relativePath) {
    try { return await rest.get(docPath(relativePath)) } catch (error) { if (error?.status === 404) return null; throw error }
  }

  return {
    async probeReadiness(fn) {
      const response = await fetchProbe(FUNCTIONS_BASE_URL_FOR(project), fn)
      return response
    },

    // R6: admin-level OAuth lookup (projects/{PROJECT}/accounts:lookup via
    // the guarded firebase-tools REST client) — the API-key `accounts:lookup`
    // endpoint only resolves the CALLER's own account from an idToken, not
    // an arbitrary `email` array, so this must go through the admin-level
    // (OAuth-scoped) surface `rest` already provides.
    async recipientPreflight(recipient) {
      if (typeof recipient !== 'string' || recipient.length === 0) blocked('recipient_required')
      const user = await lookupByEmail(recipient)
      return { project, recipientSha256: sha256(recipient.trim().toLowerCase()), accountExists: Boolean(user), absent: !user }
    },

    // R9: `runId` is required — the admin's email is a pure function of it
    // (gateGaAdminIdentityCore.mjs), never of `runTag`. `onInternalCheckpoint`
    // fires once, right after the admin Auth account is confirmed created
    // AND verified, before the company is created — the same real crash
    // window gateGaCrashWindowsCliTest.mjs proves against the emulator
    // twin; this file is what actually needs to close it for real staging.
    async createAdminAndCompany({ runId, onInternalCheckpoint = () => {} } = {}) {
      const { adminEmail, idempotencyKey } = deriveAdminIdentity(runId)
      const adminPassword = generatePassword()
      const signUp = await identity('accounts:signUp', { email: adminEmail, password: adminPassword, returnSecureToken: true })
      // The admin's email must be marked verified server-side (Admin Auth
      // REST) before any requireVerifiedEmail-gated callable will accept it
      // — gate-G-A creates and verifies its own bounded synthetic admin, it
      // never uses a real person's account for this role.
      await rest.post(accountsUrl('update'), { localId: signUp.localId, emailVerified: true })
      await onInternalCheckpoint('ADMIN_AUTH_CREATED_PRE_COMPANY')
      // A fresh sign-in (same password as signUp, generated once above —
      // not twice) is required afterward: the signUp token's own claims
      // were minted before the emailVerified update and would still read
      // email_verified:false.
      const signIn = await identity('accounts:signInWithPassword', { email: adminEmail, password: adminPassword, returnSecureToken: true })
      const { json } = await callable('createCompany', { idToken: signIn.idToken, body: {
        idempotencyKey, ownerName: 'Gate GA Admin', companyName: 'Gate GA Co', legalType: 'ooo',
      } })
      if (!json?.result?.companyId) blocked(`create_company_failed:${JSON.stringify(json)}`)
      const companyId = json.result.companyId
      return {
        adminUid: signUp.localId, companyId,
        memberPath: `companies/${companyId}/members/${signUp.localId}`,
        dataPath: `company_data/${companyId}`,
        profilePath: `users/${signUp.localId}`,
        bootstrapPath: `user_bootstrap/${signUp.localId}`,
        adminIdToken: signIn.idToken,
      }
    },

    // R9: narrow, exact, read-only resume reconciliation — the real
    // staging counterpart of the emulator adapter's method of the same
    // name. adminEmail is recomputed from `runId` (never stored
    // separately — recomputing a pure function of an already-durable value
    // IS the durable record); the real, server-assigned uid is then
    // recovered by an exact accounts:lookup on that email. No password
    // survives a crash (never persisted, by design) and none is needed:
    // an Admin-level accounts:update password reset (the SAME OAuth-scoped
    // endpoint already used for emailVerified — never the public API-key
    // surface) proves control of the account exactly as legitimately as
    // the original password-based sign-in did, without ever needing to
    // recover or guess the original.
    async reconcileAdminAndCompany({ runId }) {
      const { adminEmail } = deriveAdminIdentity(runId)
      const user = await lookupByEmail(adminEmail)
      if (!user) return { found: false }
      const adminUid = user.localId
      const bootstrapDoc = await readDocOrNull(`user_bootstrap/${adminUid}`)
      if (!bootstrapDoc) return { found: true, orphaned: true, adminUid }
      const companyId = firestoreValueToPlain(bootstrapDoc.fields)?.result?.companyId
      if (typeof companyId !== 'string' || !companyId) blocked('bootstrap_receipt_missing_company_id')
      const freshPassword = generatePassword()
      await rest.post(accountsUrl('update'), { localId: adminUid, password: freshPassword })
      const signIn = await identity('accounts:signInWithPassword', { email: adminEmail, password: freshPassword, returnSecureToken: true })
      return {
        found: true, orphaned: false, adminUid, companyId,
        memberPath: `companies/${companyId}/members/${adminUid}`,
        dataPath: `company_data/${companyId}`,
        profilePath: `users/${adminUid}`,
        bootstrapPath: `user_bootstrap/${adminUid}`,
        adminIdToken: signIn.idToken,
      }
    },

    // R9: was hardcoded `lockPath: null` — meaning NEITHER a fresh
    // invitation's lock document nor its cleanup were ever real for
    // staging. computeInvitationLockId is the SAME pure function
    // functions/src/schemas/invitation.ts's own computeInvitationLockId
    // mirrors (gateGaInvitationLockCore.mjs) — no query needed, the lock's
    // path is fully determined by (companyId, emailNormalized), both
    // already known at this call site.
    async inviteRecipient({ companyId, adminIdToken, recipient }) {
      const { json } = await callable('inviteMember', { idToken: adminIdToken, body: { companyId, email: recipient, role: 'accountant' } })
      if (!json?.result?.inviteId) blocked(`invite_failed:${JSON.stringify(json)}`)
      const lockId = computeInvitationLockId(companyId, recipient.trim().toLowerCase())
      return { inviteId: json.result.inviteId, invitationPath: `invitations/${json.result.inviteId}`, lockPath: `invitationLocks/${lockId}`, token: json.result.token }
    },

    // R9: point-read of the deterministic invitationLocks/{lockId} doc —
    // never a query/scan. The raw invitation token is never persisted
    // anywhere (SEC-006 design), so a found invitation can never be safely
    // resumed into accept — it is reconciled into the ledger and cleaned
    // up instead, exactly like the emulator twin.
    async reconcileInvitation({ companyId, recipient }) {
      const emailNormalized = recipient.trim().toLowerCase()
      const lockId = computeInvitationLockId(companyId, emailNormalized)
      const lockPath = `invitationLocks/${lockId}`
      const lockDoc = await readDocOrNull(lockPath)
      if (!lockDoc) return { found: false }
      const inviteId = firestoreValueToPlain(lockDoc.fields)?.currentInviteId
      if (typeof inviteId !== 'string' || !inviteId) blocked('invitation_lock_missing_invite_id')
      return { found: true, inviteId, invitationPath: `invitations/${inviteId}`, lockPath }
    },

    // R9: resolves a uid by exact email — used ONLY to recover a
    // recipient's Auth uid when a crash landed between registerRecipient()
    // returning and the checkpoint durably recording it. Bound to the
    // single owner-confirmed recipient email already validated earlier in
    // the flow, never an arbitrary or attacker-influenced address.
    async findAuthUidByEmail(email) {
      const user = await lookupByEmail(email)
      return { uid: user ? user.localId : null }
    },

    // gate-G-A (R6): the password is a real CSPRNG secret, generated once
    // by the orchestrator's email checkpoint (gateGaEmailVerificationCore.mjs)
    // and passed in here — never derived from the recipient's identity, and
    // never persisted anywhere but that one private, durable, git-ignored
    // checkpoint file.
    async registerRecipient({ recipient, password }) {
      if (typeof password !== 'string' || password.length < 16) blocked('bad_recipient_password')
      const signUp = await identity('accounts:signUp', { email: recipient, password, returnSecureToken: true })
      return { recipientUid: signUp.localId, idToken: signUp.idToken, profilePath: `users/${signUp.localId}` }
    },

    async sendVerificationEmail({ idToken }) {
      await identity('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken })
      // Real staging cannot read its own outbound email inbox (by design —
      // no mailbox access anywhere in this codebase). Dispatch success is
      // taken from the Identity Toolkit call itself not throwing; the owner
      // opens the real mailbox and clicks the real link themselves.
      return { dispatched: true, oobCode: null }
    },

    async checkVerification({ recipientUid }) {
      const user = await lookupByUid(recipientUid)
      if (!user) blocked('recipient_auth_not_found_during_poll')
      return { uid: user.localId, email: user.email, emailVerified: user.emailVerified === true }
    },

    async signInRecipient({ recipient, password }) {
      if (typeof password !== 'string' || password.length < 16) blocked('bad_recipient_password')
      const signIn = await identity('accounts:signInWithPassword', { email: recipient, password, returnSecureToken: true })
      return { idToken: signIn.idToken }
    },

    async acceptInvite({ idToken, inviteId, token }) {
      const { json } = await callable('acceptInvite', { idToken, body: { inviteId, token } })
      if (!json?.result?.companyId) return { ok: false, reason: JSON.stringify(json) }
      return { ok: true, companyId: json.result.companyId }
    },

    async readCompanyRoleFor({ recipientUid, companyId }) {
      const doc = await readDocOrNull(`companies/${companyId}/members/${recipientUid}`)
      return { role: doc ? (firestoreValueToPlain(doc.fields).role ?? null) : null }
    },
    async auditEventCount(companyId) {
      const query = { structuredQuery: { from: [{ collectionId: 'audit_events' }] } }
      const rows = await rest.post(`${rest.documentsRoot.replace(/\/documents$/, '')}/documents/companies/${companyId}:runQuery`, query)
      return Array.isArray(rows) ? rows.filter(row => row.document).length : 0
    },
    async memberUpdatedAtMs(companyId, uid) {
      const doc = await readDocOrNull(`companies/${companyId}/members/${uid}`)
      return doc ? (firestoreValueToPlain(doc.fields).updatedAt?.toMillis?.() ?? null) : null
    },
    async findAuditEventPaths(companyId) {
      const query = { structuredQuery: { from: [{ collectionId: 'audit_events' }] } }
      const rows = await rest.post(`${rest.documentsRoot.replace(/\/documents$/, '')}/documents/companies/${companyId}:runQuery`, query)
      return (Array.isArray(rows) ? rows : []).filter(row => row.document).map(row => row.document.name.slice(row.document.name.indexOf('/documents/') + '/documents/'.length))
    },

    async listChildCollections(relativePath) {
      const body = await rest.post(`${docPath(relativePath)}:listCollectionIds`, {})
      return Array.isArray(body?.collectionIds) ? body.collectionIds : []
    },
    async readDoc(relativePath) {
      const doc = await readDocOrNull(relativePath)
      return doc ? { exists: true, stateSha256: sha256(JSON.stringify(doc.fields ?? {})) } : { exists: false, stateSha256: null }
    },
    async deleteDoc(relativePath) { await rest.del(docPath(relativePath)) },
    async deleteAuthUser(uid) { await rest.post(accountsUrl('delete'), { localId: uid }) },
    async authUserExists(uid) { return Boolean(await lookupByUid(uid)) },
    async authUserExistsByEmail(email) { return Boolean(await lookupByEmail(email)) },

    async legacyInventory(plan) {
      const [ownerARead, ownerBRead] = plan.reads.filter(r => r.kind === 'auth-by-uid')
      const userA = await lookupByUid(ownerARead.uid)
      const ownerAAuth = userA ? { exists: true, uid: userA.localId } : { exists: false, uid: null }
      const ownerBAuth = { exists: Boolean(await lookupByUid(ownerBRead.uid)) }
      const bootstrapDoc = await readDocOrNull(`user_bootstrap/${ownerARead.uid}`)
      const bootstrap = bootstrapDoc ? { exists: true, ownerUid: firestoreValueToPlain(bootstrapDoc.fields).ownerUid ?? ownerARead.uid } : { exists: false, ownerUid: null }
      const companyQuery = { structuredQuery: { from: [{ collectionId: 'companies' }], where: { fieldFilter: { field: { fieldPath: 'ownerUid' }, op: 'EQUAL', value: { stringValue: ownerARead.uid } } } } }
      const companyRows = await rest.post(`${rest.documentsRoot}:runQuery`, companyQuery)
      const companies = []
      for (const row of (Array.isArray(companyRows) ? companyRows : []).filter(r => r.document)) {
        const id = row.document.name.split('/').at(-1)
        const data = firestoreValueToPlain(row.document.fields)
        const subcollections = (await rest.post(`${docPath(`companies/${id}`)}:listCollectionIds`, {})).collectionIds ?? []
        const companyDataDoc = await readDocOrNull(`company_data/${id}`)
        companies.push({
          id, name: data.name, ownerUid: data.ownerUid, ownerName: data.ownerName, legalType: data.legalType,
          idempotencyKeySha256: data.idempotencyKeySha256, companyDataExists: Boolean(companyDataDoc), subcollections, members: [], auditEvents: [],
        })
      }
      return { ownerAAuth, ownerBAuth, bootstrap, companies }
    },

    legacyAdapters: {
      async listChildCollections(p) { const body = await rest.post(`${docPath(p)}:listCollectionIds`, {}); return Array.isArray(body?.collectionIds) ? body.collectionIds : [] },
      async readDoc(p) { const doc = await readDocOrNull(p); return doc ? { exists: true, stateSha256: sha256(JSON.stringify(doc.fields ?? {})) } : { exists: false, stateSha256: null } },
      async deleteDoc(p) { await rest.del(docPath(p)) },
      async deleteAuthUser(uid) { await rest.post(accountsUrl('delete'), { localId: uid }) },
      async authUserExists(uid) { return Boolean(await lookupByUid(uid)) },
      async authUserExistsByEmail() { return false },
    },
  }
}

async function fetchProbe(functionsBaseUrl, fn) {
  const response = await fetch(`${functionsBaseUrl}/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: {} }) })
  const contentType = response.headers.get('content-type') ?? ''
  if (response.status !== 401 || !contentType.includes('application/json')) return { ready: false, httpStatus: response.status, verdict: 'not-ready' }
  const body = await response.json()
  const ready = body?.error?.status === 'UNAUTHENTICATED' && body?.error?.details?.appCode === 'auth_required'
  return { ready, httpStatus: response.status, verdict: ready ? 'ready' : 'not-ready' }
}

/** The real, network-touching wrapper: builds the real guarded
 * firebase-tools session/REST client and the real Identity Toolkit/callable
 * HTTP calls, then delegates every actual decision to
 * createGateGaStagingAdaptersCore. NEVER EXECUTED in this session — see the
 * file header. `runTag` is accepted for interface parity with the emulator
 * adapter factory but is no longer used for admin/company identity (see
 * gateGaAdminIdentityCore.mjs) — the orchestrator always supplies `runId`
 * to createAdminAndCompany/reconcileAdminAndCompany directly. */
export async function createGateGaStagingAdapters({ repoRoot, io = fs, runTag }) {
  void runTag
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) blocked('bad_repo_root')
  const configPath = path.join(repoRoot, '.env.staging.local')
  if (!io.existsSync(configPath)) blocked('missing_staging_web_config')
  const { config } = parseStagingConfig(io.readFileSync(configPath))
  const identityUrl = p => `https://identitytoolkit.googleapis.com/v1/${p}?key=${config.apiKey}`

  const loader = createGuardedFirebaseToolsSessionLoader({ repoRoot })
  const session = await loader.execute({ approvalValidated: true, localGatesValidated: true })
  const rest = createGateGaStagingRestClient({ session })

  async function callable(fn, { idToken, body = {} } = {}) {
    const headers = { 'content-type': 'application/json' }
    if (idToken) headers.authorization = `Bearer ${idToken}`
    const response = await fetch(`${FUNCTIONS_BASE_URL_FOR(PROJECT)}/${fn}`, { method: 'POST', headers, body: JSON.stringify({ data: body }) })
    const json = await response.json()
    return { httpStatus: response.status, json }
  }
  async function identity(p, body) {
    const response = await fetch(identityUrl(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) blocked(`identity_call_failed:${p}:${response.status}`)
    return response.json()
  }

  return createGateGaStagingAdaptersCore({ rest, identity, callable, project: PROJECT })
}
