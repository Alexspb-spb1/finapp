// Real (never fake, never staging/production) adapters for the gate-G-A
// orchestrator's 'emulator' profile: real firebase-admin Firestore/Auth
// calls against the local Firestore+Auth emulators, real HTTP to the local
// Functions emulator serving the actual compiled functions/lib/index.js,
// and real Firebase Auth Emulator REST calls (signUp/signIn/sendOobCode/
// accounts:update) for the recipient's own registration+verification —
// exactly the mechanic a real user's browser would drive, without a
// browser. The UI/Playwright layer is intentionally not re-driven here (see
// gateGaOrchestratorCore.mjs header) — this file proves the callable/
// Firestore/Auth-level contract for real, against the real compiled
// functions/src/index.ts (createCompany/inviteMember/acceptInvite paths
// read from functions/src to keep this file's request/response shapes
// exactly synchronized with the real schemas — see comments below).
import { createHash, randomBytes } from 'node:crypto'

const blocked = reason => { throw new Error(`gate_ga_emulator_adapters_blocked:${reason ?? ''}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
// R6: CSPRNG, generated fresh per run — never a fixed literal, even for the
// local-only emulator admin account (which is never resumed across process
// restarts, so it needs no durable storage, unlike the recipient's password).
const generateAdminPassword = () => `GateGA-${randomBytes(24).toString('base64url')}!Aa1`

export function createGateGaEmulatorAdapters({
  functionsBaseUrl, authEmulatorHost, db, auth, runTag, legacySeed = null,
}) {
  if (typeof functionsBaseUrl !== 'string' || !functionsBaseUrl.startsWith('http://127.0.0.1:')) blocked('bad_functions_base_url')
  if (typeof authEmulatorHost !== 'string' || !authEmulatorHost.startsWith('127.0.0.1:')) blocked('bad_auth_emulator_host')
  const identityUrl = path => `http://${authEmulatorHost}/identitytoolkit.googleapis.com/v1/${path}?key=demo-emulator-key`
  const oobInboxUrl = () => `http://${authEmulatorHost}/emulator/v1/projects/demo-finapp/oobCodes`

  async function callable(fn, { idToken, body = {} } = {}) {
    const headers = { 'content-type': 'application/json' }
    if (idToken) headers.authorization = `Bearer ${idToken}`
    const response = await fetch(`${functionsBaseUrl}/${fn}`, { method: 'POST', headers, body: JSON.stringify({ data: body }) })
    const json = await response.json()
    return { httpStatus: response.status, json }
  }
  async function identity(path, body) {
    const response = await fetch(identityUrl(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) blocked(`identity_call_failed:${path}:${response.status}:${await response.text()}`)
    return response.json()
  }
  async function auditEventCount(companyId) {
    const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
    return snap.size
  }
  async function memberSnapshot(companyId, uid) {
    const snap = await db.doc(`companies/${companyId}/members/${uid}`).get()
    return snap.exists ? { exists: true, role: snap.data().role, updatedAtMs: snap.data().updatedAt?.toMillis?.() ?? null } : { exists: false, role: null, updatedAtMs: null }
  }

  return {
    async probeReadiness(fn) {
      const response = await fetch(`${functionsBaseUrl}/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: {} }) })
      const contentType = response.headers.get('content-type') ?? ''
      if (response.status !== 401 || !contentType.includes('application/json')) return { ready: false, httpStatus: response.status, verdict: 'not-ready' }
      const body = await response.json()
      const ready = body?.error?.status === 'UNAUTHENTICATED' && body?.error?.details?.appCode === 'auth_required'
      return { ready, httpStatus: response.status, verdict: ready ? 'ready' : 'not-ready' }
    },

    async recipientPreflight(recipient) {
      if (typeof recipient !== 'string' || recipient.length === 0) blocked('recipient_required')
      let exists = true
      try { await auth.getUserByEmail(recipient); exists = true } catch (error) { if (error?.code === 'auth/user-not-found') exists = false; else throw error }
      return { project: 'demo-finapp', recipientSha256: sha256(recipient.trim().toLowerCase()), accountExists: exists, absent: !exists }
    },

    async createAdminAndCompany() {
      const adminUid = `${runTag}-admin`
      const adminEmail = `${runTag}-admin@example.invalid`
      const adminPassword = generateAdminPassword()
      await auth.createUser({ uid: adminUid, email: adminEmail, password: adminPassword, emailVerified: true })
      const signIn = await identity('accounts:signInWithPassword', { email: adminEmail, password: adminPassword, returnSecureToken: true })
      const { json } = await callable('createCompany', { idToken: signIn.idToken, body: {
        idempotencyKey: `${runTag}-idem`, ownerName: 'Gate GA Admin', companyName: `Gate GA Co ${runTag}`, legalType: 'ooo',
      } })
      if (!json?.result?.companyId) blocked(`create_company_failed:${JSON.stringify(json)}`)
      const companyId = json.result.companyId
      return {
        adminUid, companyId,
        memberPath: `companies/${companyId}/members/${adminUid}`,
        dataPath: `company_data/${companyId}`,
        profilePath: `users/${adminUid}`,
        bootstrapPath: `user_bootstrap/${adminUid}`,
        adminIdToken: signIn.idToken,
      }
    },

    async inviteRecipient({ companyId, adminIdToken, recipient }) {
      const { json } = await callable('inviteMember', { idToken: adminIdToken, body: { companyId, email: recipient, role: 'accountant' } })
      if (!json?.result?.inviteId) blocked(`invite_failed:${JSON.stringify(json)}`)
      const inviteId = json.result.inviteId
      const invDoc = await db.doc(`invitations/${inviteId}`).get()
      if (!invDoc.exists) blocked('invitation_not_found_after_create')
      const lockSnap = await db.collection('invitationLocks').where('inviteId', '==', inviteId).limit(1).get()
      const lockPath = lockSnap.empty ? null : lockSnap.docs[0].ref.path
      return { inviteId, invitationPath: `invitations/${inviteId}`, lockPath, token: json.result.token }
    },

    async registerRecipient({ recipient, password }) {
      if (typeof password !== 'string' || password.length < 16) blocked('bad_recipient_password')
      const signUp = await identity('accounts:signUp', { email: recipient, password, returnSecureToken: true })
      return { recipientUid: signUp.localId, idToken: signUp.idToken, profilePath: `users/${signUp.localId}` }
    },

    // Sends the real Auth Emulator verification email exactly once (the
    // caller — module R5's checkpoint — is what actually enforces "once
    // ever"; this call itself has no memory of prior calls). After a short
    // real, non-blocking delay this test-only emulator adapter completes the
    // captured OOB code itself, simulating the owner clicking the link a
    // moment later — this is what lets gateGaIntegrationSuite.mjs prove the
    // orchestrator's real polling loop genuinely waits and then detects a
    // real emailVerified flip, against real Firebase Auth Emulator REST, not
    // a stub. The staging adapter (gateGaStagingAdapters.mjs) has NO
    // equivalent auto-complete — real verification there requires the real
    // owner to click the real link; nothing in this codebase can do that for
    // staging, by design.
    async sendVerificationEmail({ idToken }) {
      const before = await (await fetch(oobInboxUrl())).json()
      await identity('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken })
      const after = await (await fetch(oobInboxUrl())).json()
      const dispatched = after.oobCodes.length === before.oobCodes.length + 1
      const oobCode = dispatched ? after.oobCodes.at(-1).oobCode : null
      if (oobCode && !process.env.GATE_GA_DISABLE_EMULATOR_AUTO_CLICK) {
        setTimeout(() => { identity('accounts:update', { oobCode }).catch(() => {}) }, 120)
      }
      return { dispatched, oobCode }
    },

    // Admin-level lookup by uid (not the client accounts:lookup REST call,
    // which only resolves the CALLER's own account from an idToken, not an
    // arbitrary uid) — the same firebase-admin auth handle already used for
    // every other by-uid lookup in this file (authUserExists, deleteAuthUser).
    async checkVerification({ recipientUid }) {
      let user
      try { user = await auth.getUser(recipientUid) } catch (error) { if (error?.code === 'auth/user-not-found') blocked('recipient_auth_not_found_during_poll'); throw error }
      return { uid: user.uid, email: user.email, emailVerified: user.emailVerified === true }
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
      const snapshot = await memberSnapshot(companyId, recipientUid)
      return { role: snapshot.role }
    },

    async auditEventCount(companyId) { return auditEventCount(companyId) },
    async memberUpdatedAtMs(companyId, uid) { return (await memberSnapshot(companyId, uid)).updatedAtMs },
    async findAuditEventPaths(companyId) {
      const snap = await db.collection('companies').doc(companyId).collection('audit_events').get()
      return snap.docs.map(doc => doc.ref.path)
    },

    async seedUnexpectedSubcollection(ledger) {
      const companyPath = ledger.createdFirestorePaths.find(p => /^companies\/[^/]+$/.test(p))
      if (!companyPath) blocked('no_company_path_in_ledger_for_fault')
      await db.doc(companyPath).collection('mystery_collection').doc().set({ injected: true })
    },

    async listChildCollections(path) { return (await db.doc(path).listCollections()).map(c => c.id) },
    async readDoc(path) { const snap = await db.doc(path).get(); return { exists: snap.exists, stateSha256: snap.exists ? sha256(JSON.stringify(snap.data())) : null } },
    async deleteDoc(path) { await db.doc(path).delete() },
    async deleteAuthUser(uid) { await auth.deleteUser(uid) },
    async authUserExists(uid) { try { await auth.getUser(uid); return true } catch (error) { if (error?.code === 'auth/user-not-found') return false; throw error } },
    async authUserExistsByEmail(email) { try { await auth.getUserByEmail(email); return true } catch (error) { if (error?.code === 'auth/user-not-found') return false; throw error } },

    // Real read-only resolution of planLegacyInventory()'s spec against this
    // emulator's actual Firestore/Auth — never a canned object. `legacySeed`
    // only supplies which identifiers to look for (LEGACY_KNOWN is fixed to
    // the real 2026-09-11 uid, which obviously does not exist on a fresh
    // emulator project unless a test seeds it under that exact uid).
    async legacyInventory(plan) {
      void legacySeed
      const [ownerARead, ownerBRead] = plan.reads.filter(r => r.kind === 'auth-by-uid')
      const ownerAUid = ownerARead.uid
      const ownerBUid = ownerBRead.uid
      let ownerAAuth = { exists: false, uid: null }
      try { const u = await auth.getUser(ownerAUid); ownerAAuth = { exists: true, uid: u.uid } } catch (error) { if (error?.code !== 'auth/user-not-found') throw error }
      let ownerBAuth = { exists: false }
      try { await auth.getUser(ownerBUid); ownerBAuth = { exists: true } } catch (error) { if (error?.code !== 'auth/user-not-found') throw error }
      const bootstrapSnap = await db.doc(`user_bootstrap/${ownerAUid}`).get()
      const bootstrap = bootstrapSnap.exists ? { exists: true, ownerUid: bootstrapSnap.data().ownerUid ?? ownerAUid } : { exists: false, ownerUid: null }
      const companiesSnap = await db.collection('companies').where('ownerUid', '==', ownerAUid).get()
      const companies = []
      for (const doc of companiesSnap.docs) {
        const data = doc.data()
        const subcollections = (await doc.ref.listCollections()).map(c => c.id)
        const membersSnap = await doc.ref.collection('members').get()
        const members = membersSnap.docs.map(m => ({ uid: m.id, role: m.data().role }))
        const auditSnap = await doc.ref.collection('audit_events').get()
        const auditEvents = auditSnap.docs.map(a => ({ id: a.id, action: a.data().action }))
        const companyDataExists = (await db.doc(`company_data/${doc.id}`).get()).exists
        companies.push({
          id: doc.id, name: data.name, ownerUid: data.ownerUid, ownerName: data.ownerName, legalType: data.legalType,
          idempotencyKeySha256: data.idempotencyKeySha256, companyDataExists, subcollections, members, auditEvents,
        })
      }
      return { ownerAAuth, ownerBAuth, bootstrap, companies }
    },

    legacyAdapters: {
      async listChildCollections(path) { return (await db.doc(path).listCollections()).map(c => c.id) },
      async readDoc(path) { const snap = await db.doc(path).get(); return { exists: snap.exists, stateSha256: snap.exists ? sha256(JSON.stringify(snap.data())) : null } },
      async deleteDoc(path) { await db.doc(path).delete() },
      async deleteAuthUser(uid) { await auth.deleteUser(uid) },
      async authUserExists(uid) { try { await auth.getUser(uid); return true } catch (error) { if (error?.code === 'auth/user-not-found') return false; throw error } },
      async authUserExistsByEmail() { return false },
    },
  }
}
