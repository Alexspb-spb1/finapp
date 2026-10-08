#!/usr/bin/env node
// FINAPP-1.0-M1 R3 synthetic smoke — API, Rules and fixture lifecycle (HEAD 714d0f91, round-3 Rules).
//
//   node m1-smoke.mjs --target <staging|emulator> --expected-head <sha> --run-dir <abs> --mode <mode>
//                     [--web-config <abs staging web config file>]   (required for staging, forbidden for emulator)
//
// Exit codes: 0 PASS; 2 STOP; 3 cleanup refused (no deletes, recovery manifest written);
//             4 cleanup stopped after deletes may have been sent (run `inventory` next).
// The run directory gets a protected Windows ACL (current user, SYSTEM, Administrators)
// that is re-verified by every mode before the manifest is read or written.
//
// Modes (each is a separate process; non-zero exit = STOP):
//   preflight    read-only: maintenance flag, fixture emails absent. Creates run dir + fixture plan.
//   seed         3 Auth users, 2 createCompany calls, 1 operator commit (memberships/profiles). U3 (viewer) is a
//                member of BOTH companies, so that removing it from A leaves a company to fall back to (R3 finding 3).
//   api          roster, negative roles, changeRole/disable/restore/remove, last-admin, Rules probes R1-R4 and the
//                round-3 probes R5-R7: profiles are self-only, ownerId grants nothing, a lost company grants nothing.
//   cleanup      deletes exactly the fixture documents and Auth users recorded in the run dir,
//                only if gates G1–G5 pass; otherwise writes a recovery manifest and deletes nothing.
//                Requires --rules-status <untouched|verified-new|rolled-back|unconfirmed>
//                (verified-new = the ROUND-3 target Rules were verified live; rolled-back = the round-2 Rules were restored)
//                [--rules-evidence <abs verify-current-rules jsonl>] [--rules-rollback-deploy-exit <n>].
//   verify-clean read-only: every fixture path and Auth user is absent.
//   inventory    read-only: records what remains for this run (after a partial/interrupted cleanup).
import path from 'node:path'
import fs from 'node:fs'
import {
  EXPECTED_HEAD, guardRun, privateDir, loadStagingWebConfig, journal, writeOnce, readJson, newFixturePlan, stop, Stop, saveFixture, readJournal, sha256, CLEANUP_SAFE_STOP_KINDS,
  PRE_DISPATCH_REASON_CODES,
  encodeFields, decodeFields, randomUUID, MAX_DOCUMENTS, MAX_AUTH_USERS, DOC_BUDGET,
} from './m1-core.mjs'
import { makeTransport } from './m1-transport.mjs'

const MODES = ['preflight', 'seed', 'api', 'cleanup', 'verify-clean', 'inventory']
// Process exit codes (the package branches on them).
const EXIT = Object.freeze({ PASS: 0, STOP: 2, CLEANUP_REFUSED: 3, CLEANUP_PARTIAL: 4 })
let deletesMayHaveBeenSent = false
const ALLOWED_SUBCOLLECTIONS = ['members', 'audit_events', 'idempotency_receipts']

// Canonical Rules hashes: the pre-release round-2 Rules live on staging before the release (and the rollback
// target) and the round-3 target Rules at the reviewed HEAD 714d0f91.
const RULES_OLD = 'f117e489f9549da9083c19bdf4104b3651aa500061aa52426f09cb6fe492adda'
const RULES_NEW = 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd'
const RULES_STATUSES = ['untouched', 'verified-new', 'rolled-back', 'unconfirmed']

function parseArgs(argv) {
  const out = {}
  const base = ['--target', '--expected-head', '--run-dir', '--mode']
  const cleanupOnly = ['--rules-status', '--rules-evidence', '--rules-rollback-deploy-exit']
  if (argv.length % 2 !== 0) stop('args', 'usage')
  for (let i = 0; i < argv.length; i += 2) {
    if (![...base, ...cleanupOnly, '--web-config'].includes(argv[i]) || Object.hasOwn(out, argv[i]) || argv[i + 1] === undefined) stop('args', 'usage')
    out[argv[i]] = argv[i + 1]
  }
  if (base.some(k => !Object.hasOwn(out, k)) || !MODES.includes(out['--mode'])) stop('args', 'mode')
  const extras = cleanupOnly.filter(k => Object.hasOwn(out, k))
  // Cleanup must be told the Rules state explicitly; other modes accept no extras.
  if (out['--mode'] === 'cleanup' ? !RULES_STATUSES.includes(out['--rules-status']) : extras.length) stop('args', 'rules status')
  // Staging always needs the explicit web config; the emulator never takes one.
  if ((out['--target'] === 'staging') !== Object.hasOwn(out, '--web-config')) stop('args', '--web-config is required for staging and forbidden for emulator')
  return {
    target: out['--target'], expectedHead: out['--expected-head'], runDir: out['--run-dir'], mode: out['--mode'], webConfig: out['--web-config'],
    rules: { status: out['--rules-status'], evidence: out['--rules-evidence'], rollbackDeployExit: out['--rules-rollback-deploy-exit'] },
  }
}

/** Validates a stagingResources `verify-current-rules` journal as Rules evidence. */
function readRulesEvidence(file, expectedHash) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.existsSync(file)) return { ok: false, why: 'evidence file missing' }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  let e
  try { e = JSON.parse(lines.at(-1)) } catch { return { ok: false, why: 'evidence unreadable' } }
  const ok = lines.length === 1 && e.mode === 'verify-current-rules' && e.project === 'finapp-staging' &&
    e.status === 'CURRENT_RULES_HASH_VERIFIED' && e.sourceHead === EXPECTED_HEAD && e.canonicalSha256 === expectedHash &&
    !Number.isNaN(Date.parse(e.finishedAt))
  return ok ? { ok: true, finishedAt: e.finishedAt, fileSha256: sha256(fs.readFileSync(file)) } : { ok: false, why: `evidence does not verify ${expectedHash === RULES_OLD ? 'pre-release (round-2)' : 'target (round-3)'} Rules` }
}

const counters = { requests: 0, authCreates: 0, authDeletes: 0, operatorCommits: 0, invitationCallsRefused: 0, callables: {} }
const results = []
function check(step, condition, detail) {
  results.push({ step, pass: Boolean(condition), ...(detail === undefined ? {} : { detail }) })
  if (!condition) stop(step, detail === undefined ? 'assertion failed' : JSON.stringify(detail), 'assertion')
}

async function memberState(t, companyId, uid) {
  const d = await t.getDoc(`companies/${companyId}/members/${uid}`)
  if (!d.exists) return { exists: false }
  const f = decodeFields(d.fields)
  return { exists: true, role: f.role, status: f.status, uid: f.uid, updateTime: d.updateTime }
}
async function auditActions(t, companyId) {
  return (await t.listDocs(`companies/${companyId}`, 'audit_events')).map(d => decodeFields(d.fields).action)
}
function rosterMap(result) {
  return Object.fromEntries((result?.members ?? []).map(m => [m.uid, `${m.role}/${m.status}`]))
}
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

// ── preflight ───────────────────────────────────────────────────────────────
async function preflight(t, runDir, log) {
  const plan = newFixturePlan()
  const maintenance = await t.getDoc('system/maintenance')
  check('preflight.maintenance-off', !maintenance.exists || decodeFields(maintenance.fields).enabled !== true)
  const emails = Object.values(plan.users).map(u => u.email)
  const existing = await t.lookupAuth({ emails })
  check('preflight.fixture-emails-absent', existing.length === 0, { found: existing.length })
  saveFixture(path.join(runDir, 'fixture.json'), plan, log, { create: true })
  log.append('PREFLIGHT_OK', { runId: plan.runId, maxDocuments: MAX_DOCUMENTS, maxAuthUsers: MAX_AUTH_USERS })
}

// ── seed ────────────────────────────────────────────────────────────────────
/** After a creation intent: when the transport PROVED that nothing was sent, say so in the journal (same key, the very next event). Unknown outcomes journal nothing. */
function journalNotDispatched(log, event, fields, error) {
  if (error instanceof Stop && error.dispatch === 'not-dispatched' && PRE_DISPATCH_REASON_CODES.includes(error.reasonCode)) log.append(event, { ...fields, reasonCode: error.reasonCode })
}

async function seed(t, runDir, log) {
  const fixtureFile = path.join(runDir, 'fixture.json')
  const fx = readJson(fixtureFile)
  if (fx.steps.seed) stop('seed', 'already attempted — reconcile, never repeat')
  fx.steps.seed = 'MAY_BE_SENT'; saveFixture(fixtureFile, fx, log)
  const { admin, second, viewer } = fx.users

  for (const u of [admin, second, viewer]) {
    log.append('AUTH_CREATE_MAY_BE_SENT', { key: u.key })
    try { u.uid = await t.createAuthUser(u) } catch (error) { journalNotDispatched(log, 'AUTH_CREATE_NOT_DISPATCHED', { key: u.key }, error); throw error }
    saveFixture(fixtureFile, fx, log)
  }
  const idAdmin = await t.signIn(admin)
  const idSecond = await t.signIn(second)

  for (const [key, owner, token] of [['A', admin, idAdmin], ['B', second, idSecond]]) {
    log.append('CREATE_COMPANY_MAY_BE_SENT', { company: key })
    let r
    try { r = await t.call('createCompany', token, { idempotencyKey: randomUUID(), ownerName: owner.name, companyName: fx.companies[key].name, legalType: 'ip' }) } catch (error) { journalNotDispatched(log, 'CREATE_COMPANY_NOT_DISPATCHED', { company: key }, error); throw error }
    check(`seed.createCompany-${key}`, r.ok && typeof r.result?.companyId === 'string', r.ok ? undefined : { status: r.status, appCode: r.appCode })
    fx.companies[key].id = r.result.companyId
    saveFixture(fixtureFile, fx, log)
  }
  const A = fx.companies.A.id, B = fx.companies.B.id

  const secondProfile = await t.getDoc(`users/${second.uid}`)
  check('seed.second-profile-present', secondProfile.exists)
  const sp = decodeFields(secondProfile.fields)
  check('seed.second-profile-shape', sp.companyId === B && sp.role === 'admin' && sp.companies === undefined)

  const ts = [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }, { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }]
  const writes = [
    { update: { name: t.docName(`companies/${A}/members/${second.uid}`), fields: encodeFields({ uid: second.uid, role: 'accountant', status: 'active', invitedBy: admin.uid }) }, updateTransforms: ts, currentDocument: { exists: false } },
    { update: { name: t.docName(`companies/${A}/members/${viewer.uid}`), fields: encodeFields({ uid: viewer.uid, role: 'viewer', status: 'active', invitedBy: admin.uid }) }, updateTransforms: ts, currentDocument: { exists: false } },
    { update: { name: t.docName(`companies/${B}/members/${viewer.uid}`), fields: encodeFields({ uid: viewer.uid, role: 'viewer', status: 'active', invitedBy: second.uid }) }, updateTransforms: ts, currentDocument: { exists: false } },
    { update: { name: t.docName(`users/${viewer.uid}`), fields: encodeFields({ id: viewer.uid, name: viewer.name, email: viewer.email, role: 'viewer', companyId: A, companies: [{ companyId: A, role: 'viewer' }, { companyId: B, role: 'viewer' }], createdAt: new Date().toISOString() }) }, currentDocument: { exists: false } },
    { update: { name: t.docName(`users/${second.uid}`), fields: encodeFields({ companies: [{ companyId: B, role: 'admin' }, { companyId: A, role: 'accountant' }] }) }, updateMask: { fieldPaths: ['companies'] }, currentDocument: { updateTime: secondProfile.updateTime } },
  ]
  log.append('SEED_COMMIT_MAY_BE_SENT', { writes: writes.length })
  await t.commit(writes)

  const membersA = (await t.listDocs(`companies/${A}`, 'members')).map(d => decodeFields(d.fields))
  check('seed.readback-A', same(Object.fromEntries(membersA.map(m => [m.uid, `${m.role}/${m.status}`])),
    { [admin.uid]: 'admin/active', [second.uid]: 'accountant/active', [viewer.uid]: 'viewer/active' }))
  const membersB = (await t.listDocs(`companies/${B}`, 'members')).map(d => decodeFields(d.fields))
  check('seed.readback-B', same(Object.fromEntries(membersB.map(m => [m.uid, `${m.role}/${m.status}`])), { [second.uid]: 'admin/active', [viewer.uid]: 'viewer/active' }))
  check('seed.audit-A', JSON.stringify(await auditActions(t, A)) === JSON.stringify(['company_created']))
  check('seed.audit-B', JSON.stringify(await auditActions(t, B)) === JSON.stringify(['company_created']))

  fx.steps.seed = 'DONE'; saveFixture(fixtureFile, fx, log)
  log.append('SEED_OK', { companies: 2, authUsers: 3 })
}

// ── api ─────────────────────────────────────────────────────────────────────
async function api(t, runDir, log) {
  const fixtureFile = path.join(runDir, 'fixture.json')
  const fx = readJson(fixtureFile)
  if (fx.steps.seed !== 'DONE') stop('api', 'seed not done')
  if (fx.steps.api) stop('api', 'already attempted — reconcile, never repeat')
  fx.steps.api = 'MAY_BE_SENT'; saveFixture(fixtureFile, fx, log)
  const { admin, second, viewer } = fx.users
  const A = fx.companies.A.id, B = fx.companies.B.id
  const tok = { admin: await t.signIn(admin), second: await t.signIn(second), viewer: await t.signIn(viewer) }

  // Starting state: UI smoke leaves U3 as viewer; audit count may include UI events.
  const auditStart = (await auditActions(t, A)).length
  let expectedAudit = auditStart
  const expectRefusal = async (step, who, name, data, appCode, watch) => {
    const before = await memberState(t, A, watch)
    const r = await t.call(name, tok[who], data)
    check(step, !r.ok && r.appCode === appCode, { ok: r.ok, status: r.status, appCode: r.appCode })
    const after = await memberState(t, A, watch)
    check(`${step}.no-write`, JSON.stringify(before) === JSON.stringify(after) && (await auditActions(t, A)).length === expectedAudit)
  }
  const expectChange = async (step, name, data, changed, verify, who = 'admin') => {
    log.append('MUTATION_MAY_BE_SENT', { step, name })
    const r = await t.call(name, tok[who], data)
    check(step, r.ok && r.result?.changed === changed, r.ok ? { changed: r.result?.changed } : { status: r.status, appCode: r.appCode })
    if (changed) expectedAudit++
    check(`${step}.audit`, (await auditActions(t, A)).length === expectedAudit)
    if (verify) await verify()
  }

  // Roster (S1)
  const seeded = { [admin.uid]: 'admin/active', [second.uid]: 'accountant/active', [viewer.uid]: 'viewer/active' }
  let r = await t.call('listCompanyMembers', tok.admin, { companyId: A })
  check('S1.roster-admin', r.ok && same(rosterMap(r.result), seeded), r.ok ? rosterMap(r.result) : r)
  check('S1.roster-display-joined', r.ok && r.result.members.find(m => m.uid === viewer.uid)?.email === viewer.email)
  r = await t.call('listCompanyMembers', tok.viewer, { companyId: A })
  check('S1.roster-viewer', r.ok && same(rosterMap(r.result), seeded))
  r = await t.call('listCompanyMembers', tok.second, { companyId: B })
  check('S1.roster-B', r.ok && same(rosterMap(r.result), { [second.uid]: 'admin/active', [viewer.uid]: 'viewer/active' }))
  r = await t.call('listCompanyMembers', tok.admin, { companyId: B })
  check('S1.roster-outsider-refused', !r.ok && r.appCode === 'membership_not_found', r)

  // Negative roles (S2)
  await expectRefusal('S2.viewer-cannot-change-role', 'viewer', 'changeMemberRole', { companyId: A, subjectUid: second.uid, role: 'admin' }, 'insufficient_role', second.uid)
  await expectRefusal('S2.accountant-cannot-disable', 'second', 'disableMember', { companyId: A, subjectUid: viewer.uid }, 'insufficient_role', viewer.uid)
  await expectRefusal('S2.accountant-cannot-remove', 'second', 'removeMember', { companyId: A, subjectUid: admin.uid }, 'insufficient_role', admin.uid)
  await expectRefusal('S2.viewer-cannot-restore', 'viewer', 'restoreMember', { companyId: A, subjectUid: viewer.uid }, 'insufficient_role', viewer.uid)

  // Change role (S3)
  await expectChange('S3.change-role', 'changeMemberRole', { companyId: A, subjectUid: viewer.uid, role: 'accountant' }, true,
    async () => check('S3.readback', (await memberState(t, A, viewer.uid)).role === 'accountant'))
  await expectChange('S3.change-role-idempotent', 'changeMemberRole', { companyId: A, subjectUid: viewer.uid, role: 'accountant' }, false)

  // Disable (S4)
  await expectChange('S4.disable', 'disableMember', { companyId: A, subjectUid: viewer.uid }, true,
    async () => check('S4.readback', (await memberState(t, A, viewer.uid)).status === 'disabled'))
  await expectChange('S4.disable-idempotent', 'disableMember', { companyId: A, subjectUid: viewer.uid }, false)
  r = await t.call('listCompanyMembers', tok.viewer, { companyId: A })
  check('S4.disabled-member-refused', !r.ok && r.appCode === 'membership_inactive', r)
  r = await t.call('listCompanyMembers', tok.admin, { companyId: A })
  check('S4.admin-sees-disabled', r.ok && rosterMap(r.result)[viewer.uid] === 'accountant/disabled')
  check('R3.disabled-member-rules-denied', (await t.clientGet(`companies/${A}`, tok.viewer)) === 403)

  // Restore (S5)
  await expectChange('S5.restore', 'restoreMember', { companyId: A, subjectUid: viewer.uid }, true,
    async () => check('S5.readback', (await memberState(t, A, viewer.uid)).status === 'active'))
  await expectChange('S5.restore-idempotent', 'restoreMember', { companyId: A, subjectUid: viewer.uid }, false)
  check('R3.restored-member-rules-allowed', (await t.clientGet(`companies/${A}`, tok.viewer)) === 200)
  check('R4.member-can-read-roster-docs', (await t.clientList(`companies/${A}`, 'members', tok.second)) === 200)

  // Last admin (S6)
  await expectRefusal('S6.last-admin-demote', 'admin', 'changeMemberRole', { companyId: A, subjectUid: admin.uid, role: 'viewer' }, 'last_admin', admin.uid)
  await expectRefusal('S6.last-admin-disable', 'admin', 'disableMember', { companyId: A, subjectUid: admin.uid }, 'last_admin', admin.uid)
  await expectRefusal('S6.last-admin-remove', 'admin', 'removeMember', { companyId: A, subjectUid: admin.uid }, 'last_admin', admin.uid)

  // Rules: no client membership write, no orphan company (R1, R2)
  const before = await memberState(t, A, second.uid)
  const patch = await t.clientPatch(`companies/${A}/members/${second.uid}`, encodeFields({ role: 'admin' }), ['role'], tok.second)
  check('R1.client-membership-write-denied', patch === 403, { status: patch })
  check('R1.no-write', JSON.stringify(before) === JSON.stringify(await memberState(t, A, second.uid)))
  const orphan = await t.clientCommit([{ update: { name: t.docName(`companies/${fx.orphanProbeId}`), fields: encodeFields({ id: fx.orphanProbeId, name: 'probe', legalType: 'ip', currency: 'RUB', createdAt: new Date().toISOString(), ownerId: admin.uid }) }, currentDocument: { exists: false } }], tok.admin)
  check('R2.orphan-company-create-denied', orphan === 403, { status: orphan })
  check('R2.no-write', !(await t.getDoc(`companies/${fx.orphanProbeId}`)).exists)

  // Remove (S7)
  await expectChange('S7.remove', 'removeMember', { companyId: A, subjectUid: viewer.uid }, true,
    async () => check('S7.readback', !(await memberState(t, A, viewer.uid)).exists))
  await expectChange('S7.remove-idempotent', 'removeMember', { companyId: A, subjectUid: viewer.uid }, false)
  r = await t.call('listCompanyMembers', tok.viewer, { companyId: A })
  check('S7.removed-member-refused', !r.ok && r.appCode === 'membership_not_found', r)
  check('R3.removed-member-rules-denied', (await t.clientGet(`companies/${A}`, tok.viewer)) === 403)
  const stillThere = await t.lookupAuth({ localIds: [viewer.uid] })
  check('S7.auth-account-kept', stillThere.length === 1 && stillThere[0].disabled === false)

  // Round 3, finding 1 (R5): users/{uid} is readable by its owner only; there is no users query for the browser.
  // Round 2 let a colleague with a canonical membership (and even a removed member) read other profiles.
  check('R5.colleague-profile-denied', (await t.clientGet(`users/${admin.uid}`, tok.second)) === 403)
  check('R5.removed-member-colleague-profile-denied', (await t.clientGet(`users/${second.uid}`, tok.viewer)) === 403)
  check('R5.users-list-denied', (await t.clientListRoot('users', tok.second)) === 403)
  check('R5.own-profile-readable', (await t.clientGet(`users/${second.uid}`, tok.second)) === 200)

  // Round 3, finding 3 (R7): U3 lost company A but is still a member of B - Rules agree with membership, not with
  // the legacy profile fields (U3's profile still names A as its home company).
  check('R7.lost-company-denied', (await t.clientGet(`companies/${A}`, tok.viewer)) === 403)
  check('R7.other-company-readable', (await t.clientGet(`companies/${B}`, tok.viewer)) === 200)

  // Round 3, finding 2 (R6): ownerId grants nothing. U2 becomes a second admin of A and removes the owner U1 through
  // the real callables; U1 stays the ownerId of A but no longer has a membership.
  await expectChange('S8.promote-second', 'changeMemberRole', { companyId: A, subjectUid: second.uid, role: 'admin' }, true,
    async () => check('S8.readback-promote', (await memberState(t, A, second.uid)).role === 'admin'))
  await expectChange('S8.second-removes-owner', 'removeMember', { companyId: A, subjectUid: admin.uid }, true,
    async () => check('S8.owner-membership-gone', !(await memberState(t, A, admin.uid)).exists), 'second')
  check('S8.owner-field-unchanged', decodeFields((await t.getDoc(`companies/${A}`)).fields).ownerId === admin.uid)
  check('R6.owner-without-membership-denied', (await t.clientGet(`companies/${A}`, tok.admin)) === 403)
  check('R6.owner-own-profile-readable', (await t.clientGet(`users/${admin.uid}`, tok.admin)) === 200)
  r = await t.call('listCompanyMembers', tok.admin, { companyId: A })
  check('S8.owner-roster-refused', !r.ok && r.appCode === 'membership_not_found', r)

  check('S.audit-delta', expectedAudit - auditStart === DOC_BUDGET.apiAuditEvents, { delta: expectedAudit - auditStart })
  fx.steps.api = 'DONE'; saveFixture(fixtureFile, fx, log)
  log.append('API_OK', { checks: results.length })
}

// ── cleanup / verify ────────────────────────────────────────────────────────
const CATEGORY_OF = p => {
  const s = p.split('/')
  if (s[0] === 'companies' && s.length === 2) return s[1].endsWith('-orphan-probe') ? 'orphan_probe' : 'companies'
  if (s[0] === 'companies' && s.length === 4) return s[2]
  return s[0]
}
const categorize = paths => paths.reduce((acc, p) => { const c = CATEGORY_OF(p); acc[c] = (acc[c] ?? 0) + 1; return acc }, {})

/** Read-only enumeration of every path this run can own. Ownership problems are
 * collected, never thrown, so that a refusal can list all of them at once. */
async function fixturePaths(t, fx, problems = []) {
  const uids = Object.values(fx.users).map(u => u.uid).filter(Boolean)
  const paths = []
  for (const [key, ownerKey] of [['A', 'admin'], ['B', 'second']]) {
    const id = fx.companies[key].id
    if (!id) continue
    const company = await t.getDoc(`companies/${id}`)
    if (company.exists) {
      const f = decodeFields(company.fields)
      if (f.id !== id || f.ownerId !== fx.users[ownerKey].uid || f.name !== fx.companies[key].name) problems.push(`company ${key}: owner/name/id mismatch`)
    }
    // Always enumerated: subcollection documents can outlive a deleted parent.
    const collections = await t.listCollectionIds(`companies/${id}`)
    for (const c of collections.filter(c => !ALLOWED_SUBCOLLECTIONS.includes(c))) problems.push(`company ${key}: unexpected subcollection ${c}`)
    for (const c of collections.filter(c => ALLOWED_SUBCOLLECTIONS.includes(c))) {
      for (const d of await t.listDocs(`companies/${id}`, c)) {
        const docId = d.name.split('/').pop()
        if (c === 'members' && (!uids.includes(docId) || decodeFields(d.fields).uid !== docId)) problems.push(`company ${key}: non-fixture member`)
        paths.push(`companies/${id}/${c}/${docId}`)
      }
    }
    paths.push(`company_data/${id}`, `companies/${id}`)
  }
  for (const u of Object.values(fx.users).filter(u => u.uid)) {
    const profile = await t.getDoc(`users/${u.uid}`)
    if (profile.exists) {
      const f = decodeFields(profile.fields)
      if (f.id !== u.uid || f.email !== u.email) problems.push(`profile ${u.key}: id/email mismatch`)
    }
    paths.push(`users/${u.uid}`, `user_bootstrap/${u.uid}`)
  }
  const probe = await t.getDoc(`companies/${fx.orphanProbeId}`)
  if (probe.exists) {
    const f = decodeFields(probe.fields)
    if (f.id !== fx.orphanProbeId || f.ownerId !== fx.users.admin.uid) problems.push('orphan probe: owner/id mismatch')
  }
  paths.push(`companies/${fx.orphanProbeId}`)
  return paths
}

/** Cleanup gate (owner rule): deletes only if the manifest is intact, every
 * synthetic resource is proven to belong to this run, and no STOP reason puts
 * the reliability of cleanup in doubt. Entirely read-only. */
async function assessCleanup(t, runDir, fx, rules) {
  const failures = []
  const fixtureFile = path.join(runDir, 'fixture.json')
  const events = readJournal(runDir)

  // G1 — manifest integrity.
  const written = events.filter(e => e.event === 'FIXTURE_WRITTEN')
  const observed = sha256(fs.readFileSync(fixtureFile))
  if (!written.length || written.at(-1).sha256 !== observed) failures.push('G1 manifest hash differs from last journaled write')
  if (fx.format !== 'finapp-m1-smoke-fixture-v1' || !/^[0-9a-f]{8}$/.test(fx.runId ?? '')) failures.push('G1 manifest format')
  for (const u of Object.values(fx.users)) {
    if (!u.email.startsWith(`m1-${fx.runId}-`) || !u.email.endsWith('@example.invalid')) failures.push(`G1 manifest email pattern ${u.key}`)
  }

  // G2 — STOP reasons and unterminated modes (this cleanup's own MODE_START excluded).
  const priorEvents = events.slice(0, events.map(e => e.event).lastIndexOf('MODE_START'))
  let open = null
  for (const e of priorEvents) {
    if (e.event === 'MODE_START') { if (open) failures.push(`G2 mode ${open} never finished`); open = e.mode }
    if (e.event === 'MODE_PASS' || e.event === 'MODE_STOP') open = null
    if (e.event === 'MODE_STOP' && !CLEANUP_SAFE_STOP_KINDS.includes(e.kind) && !(e.mode === 'cleanup' && e.kind === 'cleanup-refused')) {
      failures.push(`G2 STOP in ${e.mode} of kind ${e.kind ?? 'unknown'}`)
    }
    if (e.event === 'MODE_STOP' && e.kind === 'transport-not-dispatched' && (e.dispatch !== 'not-dispatched' || !PRE_DISPATCH_REASON_CODES.includes(e.reasonCode))) failures.push(`G2 transport stop in ${e.mode} without proof that nothing was dispatched`)
  }
  if (open) failures.push(`G2 mode ${open} never finished`)

  // G3 — every possibly-sent creation has a recorded identifier.
  // The ONLY resolution is the proof event journaled directly after the intent (nothing can lie between them: the journal is written by one process, in order) for the same
  // key, carrying a connect-phase reason code. Anything else - including a plain transport stop whose outcome is unknown - keeps the creation unresolved.
  const provenNotDispatched = (i, event, field, value) => events[i + 1]?.event === event && events[i + 1][field] === value && PRE_DISPATCH_REASON_CODES.includes(events[i + 1].reasonCode)
  for (const [i, e] of events.entries()) {
    if (e.event === 'AUTH_CREATE_MAY_BE_SENT' && !fx.users[e.key]?.uid && !provenNotDispatched(i, 'AUTH_CREATE_NOT_DISPATCHED', 'key', e.key)) failures.push(`G3 auth user ${e.key} may exist without recorded uid`)
    if (e.event === 'CREATE_COMPANY_MAY_BE_SENT' && !fx.companies[e.company]?.id && !provenNotDispatched(i, 'CREATE_COMPANY_NOT_DISPATCHED', 'company', e.company)) failures.push(`G3 company ${e.company} may exist without recorded id`)
  }

  // G4 — ownership of every synthetic resource (read-only).
  let paths = [], existing = [], authPresent = []
  if (!failures.some(f => f.startsWith('G1'))) {
    const problems = []
    paths = await fixturePaths(t, fx, problems)
    for (const p of problems) failures.push(`G4 ${p}`)
    for (const p of paths) if ((await t.getDoc(p)).exists) existing.push(p)
    if (existing.length > MAX_DOCUMENTS) failures.push(`G4 ${existing.length} documents exceed budget ${MAX_DOCUMENTS}`)
    const companyIds = ['A', 'B'].map(k => fx.companies[k].id).filter(Boolean)
    if (companyIds.length && (await t.runQuery('invitations', 'companyId', companyIds)).length) failures.push('G4 invitation documents reference fixture companies')
    const uids = Object.values(fx.users).map(u => u.uid).filter(Boolean)
    authPresent = uids.length ? await t.lookupAuth({ localIds: uids }) : []
    const byEmail = await t.lookupAuth({ emails: Object.values(fx.users).map(u => u.email) })
    for (const a of [...authPresent, ...byEmail]) {
      const known = Object.values(fx.users).find(u => u.uid === a.uid)
      if (!known || known.email !== a.email) failures.push('G4 auth account does not match manifest')
    }
    if (authPresent.length > MAX_AUTH_USERS) failures.push('G4 auth users exceed budget')
  }

  // G5 — Rules state. After any Rules failure cleanup is allowed ONLY once a
  // rollback is confirmed: deploy exit exactly 0 AND a verify-current-rules
  // journal for the baseline hash finished after the failure. A failed,
  // missing, stale or ambiguous rollback refuses cleanup.
  const rulesFailureStops = events.filter(e => e.event === 'MODE_STOP' && /^R[1-9]\./.test(e.reason ?? ''))
  const orphanPresent = existing.includes(`companies/${fx.orphanProbeId}`)
  const rulesFailure = rulesFailureStops.length > 0 || orphanPresent
  const seedStarted = fx.steps?.seed !== undefined
  let rulesEvidence = null
  switch (rules.status) {
    case 'untouched':
      if (seedStarted) failures.push('G5 synthetic data exists, so Rules were deployed; status untouched is not acceptable')
      if (rulesFailure) failures.push('G5 Rules failure recorded but status untouched')
      break
    case 'verified-new': {
      if (rulesFailure) failures.push('G5 Rules failure recorded; cleanup requires a confirmed rollback')
      rulesEvidence = readRulesEvidence(rules.evidence, RULES_NEW)
      if (!rulesEvidence.ok) failures.push(`G5 ${rulesEvidence.why}`)
      break
    }
    case 'rolled-back': {
      if (rules.rollbackDeployExit !== '0') failures.push('G5 rollback deploy exit is not 0 — rollback not confirmed')
      rulesEvidence = readRulesEvidence(rules.evidence, RULES_OLD)
      if (!rulesEvidence.ok) failures.push(`G5 ${rulesEvidence.why} — rollback not confirmed`)
      else {
        const lastFailureAt = rulesFailureStops.map(e => Date.parse(e.at)).sort((a, b) => a - b).at(-1)
        if (lastFailureAt !== undefined && Date.parse(rulesEvidence.finishedAt) <= lastFailureAt) failures.push('G5 rollback evidence predates the Rules failure')
      }
      break
    }
    default:
      failures.push('G5 Rules state unconfirmed')
  }
  return { failures, existing, authPresent, observedFixtureSha256: observed, rules: { ...rules, rulesFailure, evidence: rulesEvidence } }
}

/** Journal lines for the recovery manifest; a damaged journal must not hide the manifest. */
function safeJournal(runDir) {
  try { return fs.existsSync(path.join(runDir, 'journal.jsonl')) ? readJournal(runDir) : [] } catch { return [] }
}

async function cleanup(t, runDir, log, rules) {
  const fixtureFile = path.join(runDir, 'fixture.json')
  let fx
  try { fx = readJson(fixtureFile) } catch { fx = null }
  // A gate that cannot complete (damaged journal, unreadable evidence, transport STOP) is a
  // refusal with a recovery manifest, never a bare stop: the deletes must not be reachable and
  // the operator must still get the manifest.
  let gate
  try {
    gate = fx ? await assessCleanup(t, runDir, fx, rules) : { failures: ['G1 manifest unreadable'], existing: [], authPresent: [], rules }
  } catch (e) {
    if (!(e instanceof Stop)) throw e
    gate = { failures: [`G0 cleanup gate could not complete: ${e.message}`], existing: [], authPresent: [], rules }
  }
  if (gate.failures.length) {
    const recovery = path.join(runDir, `recovery-manifest-${Date.now()}.json`)
    writeOnce(recovery, {
      format: 'finapp-m1-recovery-manifest-v1', createdAt: new Date().toISOString(), runId: fx?.runId ?? null,
      decision: 'CLEANUP_REFUSED_NO_DELETES', failures: gate.failures, rulesState: gate.rules,
      observedFixtureSha256: gate.observedFixtureSha256 ?? null,
      // Passwords are not needed for recovery and are left out of this file.
      fixtureSnapshot: fx && { ...fx, users: Object.fromEntries(Object.entries(fx.users).map(([k, u]) => [k, { ...u, password: '<omitted>' }])) },
      stops: safeJournal(runDir).filter(e => e.event === 'MODE_STOP'),
      existingDocumentCategories: categorize(gate.existing), existingDocumentPaths: gate.existing,
      authAccountsPresent: gate.authPresent.map(a => ({ uid: a.uid, email: a.email })),
    })
    log.append('CLEANUP_REFUSED', { failures: gate.failures.length, recoveryManifest: path.basename(recovery) })
    stop('cleanup', `refused without deletes: ${gate.failures.join('; ')}`, 'cleanup-refused')
  }
  const { existing, authPresent } = gate
  const categories = categorize(existing)
  if (existing.includes(`companies/${fx.orphanProbeId}`)) log.append('RULES_DEFECT_ORPHAN_PRESENT')
  deletesMayHaveBeenSent = true
  log.append('CLEANUP_DOCS_MAY_BE_SENT', { count: existing.length, categories, rulesStatus: rules.status, rulesEvidenceSha256: gate.rules.evidence?.fileSha256 ?? null })
  for (let i = 0; i < existing.length; i += 100) {
    await t.commit(existing.slice(i, i + 100).map(p => ({ delete: t.docName(p), currentDocument: { exists: true } })))
  }
  for (const u of authPresent) {
    const known = Object.values(fx.users).find(x => x.uid === u.uid)
    log.append('AUTH_DELETE_MAY_BE_SENT', { key: known.key })
    await t.deleteAuthUser(u.uid)
  }
  fx.steps.cleanup = { documentsDeleted: existing.length, categories, authUsersDeleted: authPresent.length, at: new Date().toISOString() }
  saveFixture(fixtureFile, fx, log)
  log.append('CLEANUP_OK', fx.steps.cleanup)
  await verifyClean(t, runDir, log)
}

/** Read-only inventory of what remains for this run — used after a partial or
 * interrupted cleanup. No gates, no deletes; exits PASS when the reads succeed,
 * regardless of how much remains. */
async function inventory(t, runDir, log) {
  const fx = readJson(path.join(runDir, 'fixture.json'))
  const problems = []
  const paths = await fixturePaths(t, fx, problems)
  const remaining = []
  for (const p of paths) if ((await t.getDoc(p)).exists) remaining.push(p)
  const uids = Object.values(fx.users).map(u => u.uid).filter(Boolean)
  const byUid = uids.length ? await t.lookupAuth({ localIds: uids }) : []
  const byEmail = await t.lookupAuth({ emails: Object.values(fx.users).map(u => u.email) })
  const report = {
    format: 'finapp-m1-inventory-v1', createdAt: new Date().toISOString(), runId: fx.runId,
    remainingDocumentCount: remaining.length, remainingDocumentCategories: categorize(remaining), remainingDocumentPaths: remaining,
    authAccountsPresent: [...new Map([...byUid, ...byEmail].map(a => [a.uid, { uid: a.uid, email: a.email }])).values()],
    ownershipProblems: problems,
  }
  const file = path.join(runDir, `inventory-${Date.now()}.json`)
  writeOnce(file, report)
  log.append('INVENTORY_WRITTEN', { file: path.basename(file), remainingDocuments: remaining.length, categories: report.remainingDocumentCategories, authAccounts: report.authAccountsPresent.length })
  check('inventory.recorded', true)
}

async function verifyClean(t, runDir, log) {
  const fx = readJson(path.join(runDir, 'fixture.json'))
  const problems = []
  const paths = await fixturePaths(t, fx, problems)
  const left = []
  for (const p of paths) if ((await t.getDoc(p)).exists) left.push(p)
  check('verify-clean.documents-absent', left.length === 0, { remaining: left.length, categories: categorize(left) })
  const uids = Object.values(fx.users).map(u => u.uid).filter(Boolean)
  const users = uids.length ? await t.lookupAuth({ localIds: uids }) : []
  const byEmail = await t.lookupAuth({ emails: Object.values(fx.users).map(u => u.email) })
  check('verify-clean.auth-absent', users.length === 0 && byEmail.length === 0, { byUid: users.length, byEmail: byEmail.length })
  log.append('VERIFY_CLEAN_OK', { pathsChecked: paths.length })
}

// ── main ────────────────────────────────────────────────────────────────────
let runDir, log
const opts = (() => { try { return parseArgs(process.argv.slice(2)) } catch (e) { console.error(`STOP ${e.message}`); process.exit(2) } })()
try {
  const target = guardRun(opts)
  // Validated before the run directory is created or opened.
  const webConfig = target.name === 'staging' ? await loadStagingWebConfig(opts.webConfig) : null
  runDir = privateDir(opts.runDir, { mustExist: opts.mode !== 'preflight' })
  log = journal(runDir)
  log.append('MODE_START', { mode: opts.mode, target: target.name, project: target.project })
  const t = await makeTransport(target, { counters, webConfig })
  await { preflight, seed, api, cleanup, 'verify-clean': verifyClean, inventory }[opts.mode](t, runDir, log, opts.rules)
  const summary = { mode: opts.mode, target: target.name, status: 'PASS', checks: results.length, counters }
  writeOnce(path.join(runDir, `result-${opts.mode}-${Date.now()}.json`), { ...summary, results })
  log.append('MODE_PASS', summary)
  console.log(`M1_SMOKE_${opts.mode.toUpperCase().replace('-', '_')}_PASS checks=${results.length} requests=${counters.requests} invitationCallsRefused=${counters.invitationCallsRefused}`)
} catch (error) {
  const reason = error instanceof Stop ? error.message : 'unexpected error'
  const kind = error instanceof Stop ? error.kind : 'unexpected'
  const exitCode = kind === 'cleanup-refused' ? EXIT.CLEANUP_REFUSED
    : opts.mode === 'cleanup' && deletesMayHaveBeenSent ? EXIT.CLEANUP_PARTIAL : EXIT.STOP
  const evidence = error instanceof Stop ? Object.fromEntries(['reasonCode', 'dispatch', 'elapsedMs'].filter(k => error[k] !== undefined).map(k => [k, error[k]])) : {}
  if (log) log.append('MODE_STOP', { mode: opts.mode, kind, reason, ...evidence, exitCode, deletesMayHaveBeenSent, counters })
  if (runDir && fs.existsSync(runDir)) writeOnce(path.join(runDir, `result-${opts.mode}-${Date.now()}.json`), { mode: opts.mode, status: 'STOP', kind, reason, ...evidence, exitCode, deletesMayHaveBeenSent, results, counters })
  console.error(`M1_SMOKE_STOP mode=${opts.mode} kind=${kind} exit=${exitCode} ${reason}`)
  if (!(error instanceof Stop)) console.error(error?.stack?.split('\n').slice(0, 3).join('\n'))
  process.exitCode = exitCode
}
