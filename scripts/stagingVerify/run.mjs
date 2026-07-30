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
// Self-test (no network, no credentials, no fixtures — pure function checks):
//   node scripts/stagingVerify/run.mjs --self-test
//
// Required local state (never read into this script's own persisted
// output): a `.env.staging.local` file at the repo root with
// VITE_FIREBASE_* pointing at the target staging project, and an
// authenticated `firebase login` CLI session with access to that project.
//
// Configurable via environment variable (not hardcoded):
//   STAGING_PROJECT_ID   — must equal the staging project id embedded in
//                          .env.staging.local. Any mismatch (including a
//                          plausible-looking but different non-production
//                          project) is a fail-closed BLOCKED condition —
//                          not just a check for the production id.
//
// This script NEVER prints: API keys, tokens, fingerprints, passwords, or
// any other credential/secret value. Only PASS/FAIL scenario outcomes and
// non-sensitive identifiers (project id, ruleset name, synthetic fixture
// ids) are written to stdout or to the JSON result file.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const require_ = createRequire(import.meta.url)

const REQUIRED_PROJECT_ID = 'finapp-staging'
const FORBIDDEN_PRODUCTION_PROJECT_ID = 'finapp-prod-10a83'

// ── Pure, network-free, credential-free helper functions (exercised by
//    --self-test below, and used for real in main()) ───────────────────────

/**
 * Canonicalizes Rules source text for cross-platform-stable hashing:
 * CRLF -> LF, then any remaining lone CR -> LF. Does NOT touch meaningful
 * whitespace/indentation within lines, and does not normalize encoding
 * beyond treating the input as UTF-8 text (the caller must read the file
 * as UTF-8, which both `fs.readFileSync(path, 'utf8')` and the Firestore
 * Rules Management API response already guarantee).
 */
export function canonicalizeRulesText(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** SHA-256 hex digest of the canonicalized text. */
export function canonicalSha256(text) {
  return crypto.createHash('sha256').update(canonicalizeRulesText(text), 'utf8').digest('hex')
}

/**
 * Fail-closed project guard. Must be evaluated BEFORE any credential
 * acquisition (`requireAuth`), Admin REST client construction, or fixture
 * writes. Rejects not just the known production id, but ANY project id
 * other than the exact required staging id — including a plausible but
 * wrong non-production project — and rejects ambiguous state (conflicting
 * sources, emulator env vars pointing elsewhere during a real run).
 */
export function checkProjectGuard({ viteProjectId, resolvedProjectId, firestoreEmulatorHost, authEmulatorHost }) {
  const errors = []
  if (viteProjectId !== REQUIRED_PROJECT_ID) {
    errors.push(`VITE_FIREBASE_PROJECT_ID must be exactly "${REQUIRED_PROJECT_ID}", got "${viteProjectId}"`)
  }
  if (resolvedProjectId !== REQUIRED_PROJECT_ID) {
    errors.push(`resolved project id must be exactly "${REQUIRED_PROJECT_ID}", got "${resolvedProjectId}"`)
  }
  if (viteProjectId !== resolvedProjectId) {
    errors.push(`conflicting project id sources: VITE_FIREBASE_PROJECT_ID="${viteProjectId}" vs resolved="${resolvedProjectId}"`)
  }
  if (resolvedProjectId === FORBIDDEN_PRODUCTION_PROJECT_ID || viteProjectId === FORBIDDEN_PRODUCTION_PROJECT_ID) {
    errors.push('production project id detected — refusing unconditionally')
  }
  if (firestoreEmulatorHost || authEmulatorHost) {
    errors.push('FIRESTORE_EMULATOR_HOST/FIREBASE_AUTH_EMULATOR_HOST is set — refusing a real staging run to avoid ambiguity about the actual write target')
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Evaluates whether the local vs active-staging Rules hash check permits
 * proceeding. Any failure to obtain/parse/hash the active ruleset, or a
 * hash mismatch, is fail-closed BLOCKED — never treated as "assume OK" and
 * never satisfied by reusing a previously saved hash from an earlier run.
 */
export function evaluateRulesHashCheck({ localCanonicalSha256, activeCanonicalSha256, activeFetchError }) {
  if (activeFetchError) return { ok: false, reason: `could not read active staging ruleset: ${activeFetchError}` }
  if (!activeCanonicalSha256) return { ok: false, reason: 'active staging ruleset hash unavailable' }
  if (!localCanonicalSha256) return { ok: false, reason: 'local ruleset hash unavailable' }
  if (localCanonicalSha256 !== activeCanonicalSha256) return { ok: false, reason: 'local and active canonical SHA-256 do not match' }
  return { ok: true }
}

// ── --self-test: pure, no network, no credentials, no fixtures ────────────
async function runSelfTest() {
  const checks = []
  function check(name, ok, extra) { checks.push({ name, ok, extra: extra ?? null }); console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`) }

  // 1. LF vs CRLF of the same content hash identically after canonicalization.
  const lf = 'rules_version = \'2\';\nservice cloud.firestore {\n  match /x { allow read: if false; }\n}\n'
  const crlf = lf.replace(/\n/g, '\r\n')
  const crOnly = lf.replace(/\n/g, '\r')
  check('LF vs CRLF canonical SHA-256 match', canonicalSha256(lf) === canonicalSha256(crlf))
  check('LF vs lone-CR canonical SHA-256 match', canonicalSha256(lf) === canonicalSha256(crOnly))

  // 2. finapp-staging passes the project guard.
  check('project guard: finapp-staging passes', checkProjectGuard({
    viteProjectId: 'finapp-staging', resolvedProjectId: 'finapp-staging',
    firestoreEmulatorHost: undefined, authEmulatorHost: undefined,
  }).ok === true)

  // 3. finapp-prod-10a83 is blocked.
  check('project guard: finapp-prod-10a83 blocked', checkProjectGuard({
    viteProjectId: 'finapp-prod-10a83', resolvedProjectId: 'finapp-prod-10a83',
    firestoreEmulatorHost: undefined, authEmulatorHost: undefined,
  }).ok === false)

  // 4. An arbitrary other (non-production, non-staging) project id is blocked.
  check('project guard: arbitrary other project id blocked', checkProjectGuard({
    viteProjectId: 'some-other-firebase-project', resolvedProjectId: 'some-other-firebase-project',
    firestoreEmulatorHost: undefined, authEmulatorHost: undefined,
  }).ok === false)

  // 4b. Emulator env vars present blocks a real run even with the right id.
  check('project guard: emulator host vars block a real run', checkProjectGuard({
    viteProjectId: 'finapp-staging', resolvedProjectId: 'finapp-staging',
    firestoreEmulatorHost: '127.0.0.1:8080', authEmulatorHost: undefined,
  }).ok === false)

  // 5. Error reading the active ruleset is blocking.
  check('rules hash check: fetch error is blocking', evaluateRulesHashCheck({
    localCanonicalSha256: 'a'.repeat(64), activeCanonicalSha256: null, activeFetchError: 'network error',
  }).ok === false)

  // 6. Hash mismatch is blocking.
  check('rules hash check: mismatch is blocking', evaluateRulesHashCheck({
    localCanonicalSha256: 'a'.repeat(64), activeCanonicalSha256: 'b'.repeat(64), activeFetchError: null,
  }).ok === false)
  check('rules hash check: match is OK', evaluateRulesHashCheck({
    localCanonicalSha256: 'a'.repeat(64), activeCanonicalSha256: 'a'.repeat(64), activeFetchError: null,
  }).ok === true)

  const failed = checks.filter(c => !c.ok)
  console.log('')
  console.log(`SELF-TEST: ${checks.length} checks, ${checks.length - failed.length} passed, ${failed.length} failed`)
  return { checks, allPassed: failed.length === 0 }
}

if (process.argv.includes('--self-test')) {
  const { allPassed } = await runSelfTest()
  process.exit(allPassed ? 0 : 1)
}

// ── Real staging run below — network + credentials from here on ───────────

function ftLib(p) {
  return require_(path.join(REPO_ROOT, 'node_modules/firebase-tools/lib', p))
}

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

for (const [k, v] of Object.entries(sdkConfig)) {
  if (!v) {
    console.error(`BLOCKED: missing ${k} in .env.staging.local — cannot resolve staging config.`)
    process.exit(2)
  }
}

const resolvedProjectId = process.env.STAGING_PROJECT_ID || sdkConfig.projectId

// ── FAIL-CLOSED PROJECT GUARD — evaluated BEFORE requireAuth(), before any
//    Admin REST client is constructed, before a single fixture is written. ──
{
  const guard = checkProjectGuard({
    viteProjectId: sdkConfig.projectId,
    resolvedProjectId,
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST,
  })
  if (!guard.ok) {
    console.error('BASE_004_PREPROD_CORRECTION_02_BLOCKED_PROJECT_GUARD')
    for (const e of guard.errors) console.error(`  - ${e}`)
    process.exit(2)
  }
  console.log(`project guard: PASS (projectId=${resolvedProjectId})`)
}

const PROJECT_ID = resolvedProjectId

// ── Load firebase-tools' already-authenticated CLI session (Admin REST,
//    setup/cleanup only — never used for the security assertions) ─────────
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

// Identity Toolkit's Admin REST API (used for synthetic fixture Auth
// account setup/cleanup only) requires an explicit quota project when
// authenticating via a signed-in user rather than a service account.
// Not a secret — this is just the project id we already validated above.
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

  // Credential acquisition happens ONLY after the project guard above.
  const account = authMod.getGlobalDefaultAccount()
  if (!account) throw new Error('No default firebase-tools account logged in (`firebase login` required).')
  await requireAuthMod.requireAuth({})

  let sourceSha = 'UNKNOWN'
  try {
    sourceSha = require_('node:child_process')
      .execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim()
  } catch { /* not fatal — recorded as UNKNOWN */ }

  // ── Rules hash check — MUST happen before the first fixture is created,
  //    MUST be a fresh read-only fetch (never a reused/saved hash), and MUST
  //    block (non-zero exit, no fixtures, no scenarios, no deploy) on any
  //    failure to fetch/parse/hash or on a mismatch. ────────────────────────
  const localRulesRaw = fs.readFileSync(path.join(REPO_ROOT, 'firestore.rules'), 'utf8')
  const localCanonicalSha256 = canonicalSha256(localRulesRaw)

  let activeCanonicalSha256 = null
  let activeRulesetName = null
  let activeFetchError = null
  try {
    const releases = await rulesMod.listAllReleases(PROJECT_ID)
    activeRulesetName = await rulesMod.getLatestRulesetName(PROJECT_ID, 'cloud.firestore', releases)
    if (!activeRulesetName) {
      activeFetchError = 'no active cloud.firestore release found'
    } else {
      const files = await rulesMod.getRulesetContent(activeRulesetName)
      activeCanonicalSha256 = canonicalSha256(files[0].content)
    }
  } catch (e) {
    activeFetchError = e.message
  }

  const rulesHashCheck = evaluateRulesHashCheck({ localCanonicalSha256, activeCanonicalSha256, activeFetchError })
  if (!rulesHashCheck.ok) {
    console.error('BASE_004_PREPROD_CORRECTION_02_BLOCKED_RULES_HASH')
    console.error(`  - ${rulesHashCheck.reason}`)
    console.error('  No fixtures were created. No deploy was attempted.')
    process.exitCode = 2
    // Still write a minimal, honest JSON record of the blocked attempt.
    const outPath = path.join(REPO_ROOT, 'docs/remediation/evidence/BASE-004-PREPROD-STAGING-scenarios-result.json')
    fs.writeFileSync(outPath, JSON.stringify({
      status: 'BASE_004_PREPROD_CORRECTION_02_BLOCKED_RULES_HASH',
      projectId: PROJECT_ID,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceGitSha: sourceSha,
      normalizationAlgorithm: 'CRLF -> LF, then lone CR -> LF, UTF-8 text, SHA-256 hex of the canonicalized string',
      localCanonicalRulesSha256: localCanonicalSha256,
      activeStagingRulesetName: activeRulesetName,
      activeCanonicalRulesSha256: activeCanonicalSha256,
      rulesHashMatch: false,
      reason: rulesHashCheck.reason,
    }, null, 2) + '\n')
    return
  }
  console.log(`rules hash check: PASS (canonical SHA-256 matches, ${localCanonicalSha256})`)

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
  const selfTestResult = await runSelfTest()

  const output = {
    status: (failed.length === 0 && cleanupReport?.zeroResidueConfirmed && selfTestResult.allPassed)
      ? 'OK' : 'FAILED',
    projectId: PROJECT_ID,
    startedAt,
    finishedAt,
    sourceGitSha: sourceSha,
    normalizationAlgorithm: 'CRLF -> LF, then lone CR -> LF, UTF-8 text, SHA-256 hex of the canonicalized string',
    localCanonicalRulesSha256: localCanonicalSha256,
    activeStagingRulesetName: activeRulesetName,
    activeCanonicalRulesSha256: activeCanonicalSha256,
    rulesHashMatch: rulesHashCheck.ok,
    projectGuard: { ok: true, projectId: PROJECT_ID },
    selfTest: { allPassed: selfTestResult.allPassed, checks: selfTestResult.checks },
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
  console.log(`Self-test: ${selfTestResult.allPassed ? 'PASS' : 'FAIL'}`)
  console.log(`Result written to: ${outPath}`)

  process.exitCode = (failed.length === 0 && output.zeroResidueConfirmed && selfTestResult.allPassed) ? 0 : 1
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exitCode = 2
})
