#!/usr/bin/env node
// BASE-004-PREPROD-STAGING-01 — reproducible real-staging security
// verification harness.
//
// Runs the 12 required security-scenario groups (22 discrete checks)
// against the ACTUAL deployed Firestore Rules on a real Firebase project,
// using the real Firebase Client SDK — not the emulator, not a mock.
//
// Setup/cleanup of synthetic fixtures uses Admin REST calls authenticated
// through the operator's already-authorized `firebase login` session (no
// separate credential file, no secret embedded in this script). Every
// actual security ASSERTION is made through the unprivileged Client SDK,
// fully subject to whatever Rules are currently deployed.
//
// Usage (one command):
//   node scripts/stagingVerify/run.mjs
//
// Required local state (never read into this script's own persisted
// output): a `.env.staging.local` file at the repo root with
// VITE_FIREBASE_* pointing at the target staging project, and an
// authenticated `firebase login` CLI session with access to that project.
//
// Configurable via environment variable (not hardcoded):
//   STAGING_PROJECT_ID   — must equal the staging project id embedded in
//                          .env.staging.local (defaults to reading it from
//                          that file). Refuses to run if it resolves to
//                          the production project id.
//
// This script NEVER prints: API keys, tokens, fingerprints, passwords, or
// any other credential/secret value. Only PASS/FAIL scenario outcomes and
// non-sensitive identifiers (project id, ruleset name, synthetic fixture
// ids) are written to stdout or to the JSON result file.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const require_ = createRequire(import.meta.url)

// ── Load firebase-tools' already-authenticated CLI session (Admin REST,
//    setup/cleanup only — never used for the security assertions) ─────────
function ftLib(p) {
  return require_(path.join(REPO_ROOT, 'node_modules/firebase-tools/lib', p))
}
const authMod = ftLib('auth.js')
const requireAuthMod = ftLib('requireAuth.js')
const apiv2Mod = ftLib('apiv2.js')
const rulesMod = ftLib('gcp/rules.js')

// ── Load the real Firebase Client SDK (already a project dependency) ──────
const { initializeApp } = await import('firebase/app')
const { getAuth, signInWithEmailAndPassword, signOut } = await import('firebase/auth')
const {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs, limit,
} = await import('firebase/firestore')

// ── Parse .env.staging.local (same convention as scripts/verify-staging-env.mjs) ──
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const raw = fs.readFileSync(filePath, 'utf-8')
  const result = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

const envLocal = parseEnvFile(path.join(REPO_ROOT, '.env.staging.local'))
const sdkConfig = {
  apiKey: envLocal.VITE_FIREBASE_API_KEY,
  authDomain: envLocal.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: envLocal.VITE_FIREBASE_PROJECT_ID,
  storageBucket: envLocal.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: envLocal.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: envLocal.VITE_FIREBASE_APP_ID,
}

const PROJECT_ID = process.env.STAGING_PROJECT_ID || sdkConfig.projectId
if (!PROJECT_ID) {
  console.error('BLOCKED: no STAGING_PROJECT_ID resolvable (missing .env.staging.local?)')
  process.exit(2)
}
if (PROJECT_ID === 'finapp-prod-10a83') {
  console.error('BLOCKED: refusing to run against the production project id.')
  process.exit(2)
}
if (PROJECT_ID !== sdkConfig.projectId) {
  console.error('BLOCKED: STAGING_PROJECT_ID does not match .env.staging.local VITE_FIREBASE_PROJECT_ID.')
  process.exit(2)
}
for (const [k, v] of Object.entries(sdkConfig)) {
  if (!v) {
    console.error(`BLOCKED: missing ${k} in .env.staging.local — cannot initialize a real Client SDK session.`)
    process.exit(2)
  }
}

// Identity Toolkit's Admin REST API (used for synthetic fixture Auth
// account setup/cleanup only) requires an explicit quota project when
// authenticating via a signed-in user rather than a service account.
// Not a secret — this is just the project id we're already targeting.
process.env.GOOGLE_CLOUD_QUOTA_PROJECT = PROJECT_ID

const firestoreClient = new apiv2Mod.Client({ urlPrefix: 'https://firestore.googleapis.com', apiVersion: 'v1' })
const identityClient = new apiv2Mod.Client({ urlPrefix: 'https://identitytoolkit.googleapis.com', apiVersion: 'v1' })

function toFirestoreValue(v) {
  if (v === undefined || v === null) return { nullValue: null }
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') return { doubleValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } }
  if (typeof v === 'object') return { mapValue: { fields: toFirestoreFields(v) } }
  throw new Error('unsupported fixture value type')
}
function toFirestoreFields(obj) {
  const fields = {}
  for (const [k, val] of Object.entries(obj)) fields[k] = toFirestoreValue(val)
  return fields
}
function genPassword() {
  return crypto.randomBytes(18).toString('base64url') + 'Aa1!'
}

async function main() {
  const startedAt = new Date().toISOString()
  const account = authMod.getGlobalDefaultAccount()
  if (!account) throw new Error('No default firebase-tools account logged in (`firebase login` required).')
  await requireAuthMod.requireAuth({})

  // Resolve the source SHA being verified (git HEAD of this checkout).
  let sourceSha = 'UNKNOWN'
  try {
    sourceSha = require_('node:child_process')
      .execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim()
  } catch { /* not fatal — recorded as UNKNOWN */ }

  // Local vs active staging Rules hash (informational — this harness never
  // deploys; that is a separate, explicitly-gated step in the main task).
  const localRulesSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(REPO_ROOT, 'firestore.rules'), 'utf8'), 'utf8')
    .digest('hex')
  let activeRulesSha256 = null
  let activeRulesetName = null
  try {
    const releases = await rulesMod.listAllReleases(PROJECT_ID)
    activeRulesetName = await rulesMod.getLatestRulesetName(PROJECT_ID, 'cloud.firestore', releases)
    if (activeRulesetName) {
      const files = await rulesMod.getRulesetContent(activeRulesetName)
      activeRulesSha256 = crypto.createHash('sha256').update(files[0].content, 'utf8').digest('hex')
    }
  } catch (e) {
    console.error('WARN: could not read active staging ruleset:', e.message)
  }

  const runId = Date.now().toString(36)
  const fixturePrefix = `stgv${runId}`
  const mk = (label) => `${fixturePrefix}${label}`
  const domain = 'example.invalid'

  const COMPANY_A = mk('coA')
  const COMPANY_B = mk('coB')
  const COMPANY_C = mk('coC')

  const userDefs = {
    ADMIN_A:       { uid: mk('uAdminA'),    role: 'admin',      companyId: COMPANY_A },
    ACCOUNTANT_A:  { uid: mk('uAcctA'),     role: 'accountant', companyId: COMPANY_A },
    VIEWER_A:      { uid: mk('uViewA'),     role: 'viewer',     companyId: COMPANY_A },
    ADMIN_B:       { uid: mk('uAdminB'),    role: 'admin',      companyId: COMPANY_B },
    MULTI_ADMIN_B: { uid: mk('uMultiAdmB'), role: 'viewer',     companyId: COMPANY_A, companies: [{ companyId: COMPANY_B, role: 'admin' }] },
    LIMITED_AT_B:  { uid: mk('uLimB'),      role: 'admin',      companyId: COMPANY_A, companies: [{ companyId: COMPANY_B, role: 'viewer' }] },
    NO_PROFILE:    { uid: mk('uNoProfile') },
  }

  const created = { companies: [], companyData: [], userDocs: [], authUsers: [] }
  const credentials = {} // in-memory ONLY — never written to disk/JSON

  const app = initializeApp(sdkConfig, `stagingVerify-${runId}`)
  const auth = getAuth(app)
  const db = getFirestore(app)

  const results = []
  function record(id, name, expect, actual, ok) {
    results.push({ id, name, expect, actual, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} — [${id}] ${name} (expected ${expect}, got ${actual})`)
  }
  async function expectDeny(id, name, fn) {
    try { await fn(); record(id, name, 'DENY', 'ALLOW', false) }
    catch (e) {
      const denied = e?.code === 'permission-denied'
      record(id, name, 'DENY', denied ? 'DENY' : `ERROR(${e?.code})`, denied)
    }
  }
  async function expectAllow(id, name, fn) {
    try { await fn(); record(id, name, 'ALLOW', 'ALLOW', true) }
    catch (e) { record(id, name, 'ALLOW', `DENY(${e?.code})`, false) }
  }
  async function signIn(label) {
    const c = credentials[label]
    await signInWithEmailAndPassword(auth, c.email, c.password)
  }

  let cleanupReport = null

  try {
    // ── Fixture setup (Admin REST, bypasses Rules for SETUP ONLY) ────────
    const now = new Date().toISOString()
    await firestoreClient.post(
      `/projects/${PROJECT_ID}/databases/(default)/documents/companies?documentId=${COMPANY_A}`,
      { fields: toFirestoreFields({ id: COMPANY_A, name: `Verify CoA ${runId}`, legalType: 'ooo', currency: 'RUB', createdAt: now, ownerId: userDefs.ADMIN_A.uid }) },
    )
    created.companies.push(COMPANY_A)
    await firestoreClient.post(
      `/projects/${PROJECT_ID}/databases/(default)/documents/companies?documentId=${COMPANY_B}`,
      { fields: toFirestoreFields({ id: COMPANY_B, name: `Verify CoB ${runId}`, legalType: 'ip', currency: 'RUB', createdAt: now, ownerId: userDefs.ADMIN_B.uid }) },
    )
    created.companies.push(COMPANY_B)
    await firestoreClient.post(
      `/projects/${PROJECT_ID}/databases/(default)/documents/companies?documentId=${COMPANY_C}`,
      { fields: toFirestoreFields({ id: COMPANY_C, name: `Verify CoC ${runId}`, legalType: 'ip', currency: 'RUB', createdAt: now, ownerId: userDefs.ADMIN_B.uid }) },
    )
    created.companies.push(COMPANY_C)

    const emptyCompanyData = { accounts: [], categories: [], counterparties: [], transactions: [], projects: [], rules: [], budgets: [], recurring: [], paymentCalendar: [] }
    for (const cid of [COMPANY_A, COMPANY_B]) {
      await firestoreClient.post(
        `/projects/${PROJECT_ID}/databases/(default)/documents/company_data?documentId=${cid}`,
        { fields: toFirestoreFields(emptyCompanyData) },
      )
      created.companyData.push(cid)
    }

    for (const [label, def] of Object.entries(userDefs)) {
      const email = `${mk(label.toLowerCase())}@${domain}`
      const password = genPassword()
      await identityClient.post(`/projects/${PROJECT_ID}/accounts`, {
        localId: def.uid, email, password, emailVerified: true,
      })
      created.authUsers.push(def.uid)
      credentials[label] = { uid: def.uid, email, password }

      if (label !== 'NO_PROFILE') {
        const docBody = { id: def.uid, name: label, email, createdAt: now, role: def.role, companyId: def.companyId }
        if (def.companies) docBody.companies = def.companies
        await firestoreClient.post(
          `/projects/${PROJECT_ID}/databases/(default)/documents/users?documentId=${def.uid}`,
          { fields: toFirestoreFields(docBody) },
        )
        created.userDocs.push(def.uid)
      }
    }

    // ── 22 real Client-SDK security checks (12 required groups) ──────────
    await signOut(auth).catch(() => {})
    await expectDeny('1', 'unauthenticated get company_data/A', () => getDoc(doc(db, 'company_data', COMPANY_A)))

    await signIn('NO_PROFILE')
    await expectDeny('2', 'no-profile user get company_data/A', () => getDoc(doc(db, 'company_data', COMPANY_A)))
    await signOut(auth)

    await signIn('VIEWER_A')
    await expectDeny('3a', 'self-update role', () => updateDoc(doc(db, 'users', userDefs.VIEWER_A.uid), { role: 'admin' }))
    await expectDeny('3b', 'self-update companyId', () => updateDoc(doc(db, 'users', userDefs.VIEWER_A.uid), { companyId: COMPANY_B }))
    await expectDeny('3c', 'self-update companies[]', () => updateDoc(doc(db, 'users', userDefs.VIEWER_A.uid), { companies: [{ companyId: COMPANY_B, role: 'admin' }] }))
    await signOut(auth)

    await signIn('ADMIN_B')
    await expectDeny('4a', 'cross-company read company_data/A', () => getDoc(doc(db, 'company_data', COMPANY_A)))
    await expectDeny('4b', 'cross-company write company_data/A', () => updateDoc(doc(db, 'company_data', COMPANY_A), { closingDate: '2026-06-30' }))
    await signOut(auth)

    await signIn('VIEWER_A')
    await expectAllow('5a', 'viewer reads own company_data/A', () => getDoc(doc(db, 'company_data', COMPANY_A)))
    await expectDeny('5b', 'viewer cannot write company_data/A', () => updateDoc(doc(db, 'company_data', COMPANY_A), { accounts: [{ id: 'x' }] }))
    await signOut(auth)

    await signIn('ACCOUNTANT_A')
    await expectAllow('6a', 'accountant normal write company_data/A', () => updateDoc(doc(db, 'company_data', COMPANY_A), { accounts: [{ id: 'acc-1' }] }))
    await expectDeny('6b', 'accountant sets closingDate', () => updateDoc(doc(db, 'company_data', COMPANY_A), { closingDate: '2026-06-30' }))
    await signOut(auth)

    await signIn('ADMIN_A')
    await expectAllow('7', 'admin sets closingDate company_data/A', () => updateDoc(doc(db, 'company_data', COMPANY_A), { closingDate: '2026-06-30' }))
    await expectAllow('8', 'query users where companyId==A (own company)', () => getDocs(query(collection(db, 'users'), where('companyId', '==', COMPANY_A))))
    await signOut(auth)

    await signIn('MULTI_ADMIN_B')
    await expectAllow('9', 'query users where companyId==B (additional membership)', () => getDocs(query(collection(db, 'users'), where('companyId', '==', COMPANY_B))))
    await signOut(auth)

    await signIn('LIMITED_AT_B')
    await expectDeny('10a', 'home-admin (viewer at B) cannot update companies/B', () => updateDoc(doc(db, 'companies', COMPANY_B), { name: 'Hijacked' }))
    await expectDeny('10b', 'home-admin (viewer at B) cannot set closingDate at B', () => updateDoc(doc(db, 'company_data', COMPANY_B), { closingDate: '2026-06-30' }))
    await signOut(auth)

    await signIn('MULTI_ADMIN_B')
    await expectAllow('10c', 'control: real additional-admin (B) CAN update companies/B', () => updateDoc(doc(db, 'companies', COMPANY_B), { name: 'Renamed by real admin' }))
    await signOut(auth)

    await signIn('ADMIN_A')
    await expectDeny('11a', 'unrestricted collection(users) query', () => getDocs(collection(db, 'users')))
    await expectDeny('11b', 'unrestricted query with only limit()', () => getDocs(query(collection(db, 'users'), limit(5))))
    await expectDeny('11c', 'mixed in-query [A,C]', () => getDocs(query(collection(db, 'users'), where('companyId', 'in', [COMPANY_A, COMPANY_C]))))
    await expectDeny('12a', 'spoof ownerId on new company create', () => setDoc(doc(db, 'companies', `${COMPANY_A}_spoof`), {
      id: `${COMPANY_A}_spoof`, name: 'Spoofed', legalType: 'ip', currency: 'RUB', createdAt: new Date().toISOString(), ownerId: userDefs.ADMIN_B.uid,
    }))
    await expectDeny('12b', 'spoof ownerId on update companies/A', () => updateDoc(doc(db, 'companies', COMPANY_A), { ownerId: userDefs.ADMIN_B.uid }))
    await signOut(auth)
  } finally {
    // ── Cleanup — ALWAYS runs, even on failure/throw above ────────────────
    const del = { companies: 0, companyData: 0, userDocs: 0, authUsers: 0 }
    const errors = []
    for (const id of created.companies) {
      try { await firestoreClient.delete(`/projects/${PROJECT_ID}/databases/(default)/documents/companies/${id}`); del.companies++ }
      catch (e) { errors.push(`companies/${id}: ${e.message}`) }
      try { await firestoreClient.delete(`/projects/${PROJECT_ID}/databases/(default)/documents/companies/${id}_spoof`) } catch { /* expected: never created */ }
    }
    for (const id of created.companyData) {
      try { await firestoreClient.delete(`/projects/${PROJECT_ID}/databases/(default)/documents/company_data/${id}`); del.companyData++ }
      catch (e) { errors.push(`company_data/${id}: ${e.message}`) }
    }
    for (const uid of created.userDocs) {
      try { await firestoreClient.delete(`/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`); del.userDocs++ }
      catch (e) { errors.push(`users/${uid}: ${e.message}`) }
    }
    for (const uid of created.authUsers) {
      try { await identityClient.post(`/projects/${PROJECT_ID}/accounts:delete`, { localId: uid }); del.authUsers++ }
      catch (e) { errors.push(`auth/${uid}: ${e.message}`) }
    }

    // Independent zero-residue re-verification (re-query, not trust deletes).
    const residue = {}
    for (const col of ['companies', 'company_data', 'users']) {
      try {
        const res = await firestoreClient.post(
          `/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
          { structuredQuery: { from: [{ collectionId: col }] } },
        )
        const docs = (Array.isArray(res.body) ? res.body : [res.body])
          .filter(x => x.document)
          .map(x => x.document.name.split('/').pop())
          .filter(id => id.includes(fixturePrefix))
        residue[col] = docs.length
      } catch (e) { residue[col] = `ERROR: ${e.message}` }
    }
    let authResidue = 0
    for (const uid of created.authUsers) {
      try {
        const r = await identityClient.post(`/projects/${PROJECT_ID}/accounts:lookup`, { localId: [uid] })
        if (r.body?.users?.length) authResidue++
      } catch { /* lookup error treated as "not found" is unsafe — count as residue */ authResidue++ }
    }

    cleanupReport = {
      deleted: del,
      errors,
      residue: { ...residue, authUsers: authResidue },
      zeroResidueConfirmed: Object.values(residue).every(v => v === 0) && authResidue === 0,
    }
  }

  const failed = results.filter(r => !r.ok)
  const finishedAt = new Date().toISOString()

  const output = {
    projectId: PROJECT_ID,
    startedAt,
    finishedAt,
    sourceGitSha: sourceSha,
    localRulesSha256,
    activeStagingRulesetName: activeRulesetName,
    activeStagingRulesSha256: activeRulesSha256,
    localMatchesActiveStaging: activeRulesSha256 === localRulesSha256,
    fixturePrefix,
    fixturesCreated: {
      companies: created.companies.length,
      companyData: created.companyData.length,
      userDocs: created.userDocs.length,
      authUsers: created.authUsers.length,
    },
    fixturesDeleted: cleanupReport?.deleted ?? null,
    cleanupErrors: cleanupReport?.errors ?? [],
    zeroResidueConfirmed: cleanupReport?.zeroResidueConfirmed ?? false,
    scenarios: results,
    summary: {
      total: results.length,
      pass: results.length - failed.length,
      fail: failed.length,
      skipped: 0,
    },
  }

  const outPath = path.join(REPO_ROOT, 'docs/remediation/evidence/BASE-004-PREPROD-STAGING-scenarios-result.json')
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n')

  console.log('')
  console.log(`TOTAL: ${output.summary.total}  PASS: ${output.summary.pass}  FAIL: ${output.summary.fail}  SKIPPED: ${output.summary.skipped}`)
  console.log(`Zero residue confirmed: ${output.zeroResidueConfirmed}`)
  console.log(`Result written to: ${outPath}`)

  process.exitCode = (failed.length === 0 && output.zeroResidueConfirmed) ? 0 : 1
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exitCode = 2
})
