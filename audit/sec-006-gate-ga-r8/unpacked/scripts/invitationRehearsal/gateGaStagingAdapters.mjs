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
// (gateGaStagingCliSelfTest.mjs) and (b) the fully real, independently
// exercised emulator twin (gateGaEmulatorAdapters.mjs, gateGaIntegrationSuite.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { PROJECT, DATABASE } from './inventoryCore.mjs'
import { createGuardedFirebaseToolsSessionLoader, createGateGaStagingRestClient } from './liveAcceptanceExecutorAdapters.mjs'
import { parseStagingConfig } from './liveAcceptanceExecutorRuntime.mjs'

const blocked = reason => { throw new Error(`gate_ga_staging_adapters_blocked:${reason ?? ''}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const FUNCTIONS_BASE_URL = `https://us-central1-${PROJECT}.cloudfunctions.net`

export async function createGateGaStagingAdapters({ repoRoot, io = fs, runTag }) {
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
    const response = await fetch(`${FUNCTIONS_BASE_URL}/${fn}`, { method: 'POST', headers, body: JSON.stringify({ data: body }) })
    const json = await response.json()
    return { httpStatus: response.status, json }
  }
  async function identity(p, body) {
    const response = await fetch(identityUrl(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) blocked(`identity_call_failed:${p}:${response.status}`)
    return response.json()
  }
  function docPath(relative) { return `${rest.documentsRoot}/${relative}` }
  function firestoreValueToPlain(fields) {
    const out = {}
    for (const [key, value] of Object.entries(fields ?? {})) {
      if ('stringValue' in value) out[key] = value.stringValue
      else if ('booleanValue' in value) out[key] = value.booleanValue
      else if ('timestampValue' in value) out[key] = { toMillis: () => Date.parse(value.timestampValue) }
      else out[key] = value
    }
    return out
  }

  return {
    async probeReadiness(fn) {
      const response = await fetch(`${FUNCTIONS_BASE_URL}/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: {} }) })
      const contentType = response.headers.get('content-type') ?? ''
      if (response.status !== 401 || !contentType.includes('application/json')) return { ready: false, httpStatus: response.status, verdict: 'not-ready' }
      const body = await response.json()
      const ready = body?.error?.status === 'UNAUTHENTICATED' && body?.error?.details?.appCode === 'auth_required'
      return { ready, httpStatus: response.status, verdict: ready ? 'ready' : 'not-ready' }
    },

    // R6: admin-level OAuth lookup (projects/{PROJECT}/accounts:lookup via
    // the guarded firebase-tools REST client), same pattern already used by
    // every other by-email/by-uid lookup in this file. The client, API-key
    // `accounts:lookup` endpoint used before R6 only resolves the CALLER's
    // own account from an idToken — it does not support an arbitrary `email`
    // array at all, so this call would have failed against real staging
    // (the same class of bug fixed for checkVerification in R5's emulator
    // adapter, caught there only because that one was actually executed).
    async recipientPreflight(recipient) {
      if (typeof recipient !== 'string' || recipient.length === 0) blocked('recipient_required')
      const lookup = await rest.post(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, { email: [recipient] })
      const exists = Array.isArray(lookup.users) && lookup.users.length > 0
      return { project: PROJECT, recipientSha256: sha256(recipient.trim().toLowerCase()), accountExists: exists, absent: !exists }
    },

    async createAdminAndCompany() {
      const adminUid = `${runTag}-admin`
      const adminEmail = `${runTag}-admin@example.invalid`
      const adminPassword = cryptoPassword()
      const signUp = await identity('accounts:signUp', { email: adminEmail, password: adminPassword, returnSecureToken: true })
      // The admin's email must be marked verified server-side (Admin Auth
      // REST) before any requireVerifiedEmail-gated callable will accept it —
      // gate-G-A creates and verifies its own bounded synthetic admin, it
      // never uses a real person's account for this role. A fresh sign-in
      // (same password as signUp, generated once above — not twice) is
      // required afterward: the signUp token's own claims were minted before
      // this update and would still read email_verified:false.
      await rest.post(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, { localId: signUp.localId, emailVerified: true })
      const signIn = await identity('accounts:signInWithPassword', { email: adminEmail, password: adminPassword, returnSecureToken: true })
      const { json } = await callable('createCompany', { idToken: signIn.idToken, body: {
        idempotencyKey: `${runTag}-idem`, ownerName: 'Gate GA Admin', companyName: `Gate GA Co ${runTag}`, legalType: 'ooo',
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

    async inviteRecipient({ companyId, adminIdToken, recipient }) {
      const { json } = await callable('inviteMember', { idToken: adminIdToken, body: { companyId, email: recipient, role: 'accountant' } })
      if (!json?.result?.inviteId) blocked(`invite_failed:${JSON.stringify(json)}`)
      return { inviteId: json.result.inviteId, invitationPath: `invitations/${json.result.inviteId}`, lockPath: null, token: json.result.token }
    },

    // gate-G-A (R6): the password is a real CSPRNG secret, generated once by
    // the orchestrator's email checkpoint (gateGaEmailVerificationCore.mjs)
    // and passed in here — never derived from the recipient's identity (a
    // deterministic function of a public value is not a secret), and never
    // persisted anywhere but that one private, durable, git-ignored
    // checkpoint file. This account is a bounded synthetic test account
    // deleted by this same run's cleanup (or, on timeout, by the
    // timeout-triggered cleanup) — not a real person's credential.
    async registerRecipient({ recipient, password }) {
      if (typeof password !== 'string' || password.length < 16) blocked('bad_recipient_password')
      const signUp = await identity('accounts:signUp', { email: recipient, password, returnSecureToken: true })
      return { recipientUid: signUp.localId, idToken: signUp.idToken, profilePath: `users/${signUp.localId}` }
    },

    async sendVerificationEmail({ idToken }) {
      await identity('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken })
      // Real staging cannot read its own outbound email inbox (by design —
      // no mailbox access anywhere in this codebase). Dispatch success is
      // taken from the Identity Toolkit call itself not throwing; the OOB
      // code is never available to this process — the owner opens the real
      // mailbox and clicks the real link themselves (see the orchestrator's
      // onOwnerActionRequired message); this adapter never completes
      // verification itself, unlike its emulator twin.
      return { dispatched: true, oobCode: null }
    },

    // Real, read-only Admin Auth lookup — this is what the orchestrator's
    // bounded poll loop calls repeatedly until the owner's real click flips
    // emailVerified, or the deadline passes. No throw-stub, no
    // owner-in-the-loop gap left unimplemented: this is the real thing.
    async checkVerification({ recipientUid }) {
      const lookup = await rest.post(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, { localId: [recipientUid] })
      const user = lookup.users?.[0]
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
      try {
        const doc = await rest.get(docPath(`companies/${companyId}/members/${recipientUid}`))
        return { role: firestoreValueToPlain(doc.fields).role ?? null }
      } catch (error) { if (error?.status === 404) return { role: null }; throw error }
    },
    async auditEventCount(companyId) {
      const query = { structuredQuery: { from: [{ collectionId: 'audit_events' }] } }
      const rows = await rest.post(`${rest.documentsRoot.replace(/\/documents$/, '')}/documents/companies/${companyId}:runQuery`, query)
      return Array.isArray(rows) ? rows.filter(row => row.document).length : 0
    },
    async memberUpdatedAtMs(companyId, uid) {
      try {
        const doc = await rest.get(docPath(`companies/${companyId}/members/${uid}`))
        return firestoreValueToPlain(doc.fields).updatedAt?.toMillis?.() ?? null
      } catch { return null }
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
      try {
        const doc = await rest.get(docPath(relativePath))
        return { exists: true, stateSha256: sha256(JSON.stringify(doc.fields ?? {})) }
      } catch (error) { if (error?.status === 404) return { exists: false, stateSha256: null }; throw error }
    },
    async deleteDoc(relativePath) { await rest.del(docPath(relativePath)) },
    async deleteAuthUser(uid) { await rest.post(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`, { localId: uid }) },
    async authUserExists(uid) {
      const lookup = await rest.post(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, { localId: [uid] })
      return Array.isArray(lookup.users) && lookup.users.length > 0
    },
    async authUserExistsByEmail(email) {
      const lookup = await rest.post(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, { email: [email] })
      return Array.isArray(lookup.users) && lookup.users.length > 0
    },

    async legacyInventory(plan) {
      const [ownerARead, ownerBRead] = plan.reads.filter(r => r.kind === 'auth-by-uid')
      const lookupA = await rest.post(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, { localId: [ownerARead.uid] })
      const ownerAAuth = lookupA.users?.[0] ? { exists: true, uid: lookupA.users[0].localId } : { exists: false, uid: null }
      const lookupB = await rest.post(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, { localId: [ownerBRead.uid] })
      const ownerBAuth = { exists: Boolean(lookupB.users?.[0]) }
      const bootstrap = await (async () => {
        try { const doc = await rest.get(docPath(`user_bootstrap/${ownerARead.uid}`)); return { exists: true, ownerUid: firestoreValueToPlain(doc.fields).ownerUid ?? ownerARead.uid } }
        catch (error) { if (error?.status === 404) return { exists: false, ownerUid: null }; throw error }
      })()
      const companyQuery = { structuredQuery: { from: [{ collectionId: 'companies' }], where: { fieldFilter: { field: { fieldPath: 'ownerUid' }, op: 'EQUAL', value: { stringValue: ownerARead.uid } } } } }
      const companyRows = await rest.post(`${rest.documentsRoot}:runQuery`, companyQuery)
      const companies = []
      for (const row of (Array.isArray(companyRows) ? companyRows : []).filter(r => r.document)) {
        const id = row.document.name.split('/').at(-1)
        const data = firestoreValueToPlain(row.document.fields)
        const subcollections = (await rest.post(`${docPath(`companies/${id}`)}:listCollectionIds`, {})).collectionIds ?? []
        const companyDataExists = await this.readDoc(`company_data/${id}`).then(d => d.exists)
        companies.push({
          id, name: data.name, ownerUid: data.ownerUid, ownerName: data.ownerName, legalType: data.legalType,
          idempotencyKeySha256: data.idempotencyKeySha256, companyDataExists, subcollections, members: [], auditEvents: [],
        })
      }
      return { ownerAAuth, ownerBAuth, bootstrap, companies }
    },

    legacyAdapters: {
      async listChildCollections(p) { const body = await rest.post(`${docPath(p)}:listCollectionIds`, {}); return Array.isArray(body?.collectionIds) ? body.collectionIds : [] },
      async readDoc(p) { try { const doc = await rest.get(docPath(p)); return { exists: true, stateSha256: sha256(JSON.stringify(doc.fields ?? {})) } } catch (error) { if (error?.status === 404) return { exists: false, stateSha256: null }; throw error } },
      async deleteDoc(p) { await rest.del(docPath(p)) },
      async deleteAuthUser(uid) { await rest.post(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`, { localId: uid }) },
      async authUserExists(uid) { const lookup = await rest.post(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, { localId: [uid] }); return Array.isArray(lookup.users) && lookup.users.length > 0 },
      async authUserExistsByEmail() { return false },
    },
  }
}

// R6: real CSPRNG, not Date.now()/Math.random() (neither is a
// cryptographically secure source — Math.random() in particular is
// predictable). Bounded synthetic password for a bounded synthetic account
// this same run creates and deletes — never a real credential, never reused
// across runs. Used only for the admin account, which is never resumed
// across process restarts (created fresh every run) — unlike the recipient,
// whose CSPRNG password is generated once by the email checkpoint and
// persisted there for resume (see gateGaEmailVerificationCore.mjs).
function cryptoPassword() {
  return `GateGA-${randomBytes(24).toString('base64url')}!Aa1`
}
