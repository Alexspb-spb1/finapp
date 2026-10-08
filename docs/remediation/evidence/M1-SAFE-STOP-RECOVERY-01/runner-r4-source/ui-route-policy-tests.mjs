// Deterministic tests for the UI smoke route policy and PASS gate (m1-ui-smoke.mjs).
// Unit part: pure decisions on synthetic requests, no network. Browser part: real
// Chromium against a local page that throws and requests forbidden/unknown URLs —
// no request leaves the machine (all are aborted by the policy).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { decideRequest, newCounts, uiPassProblems, attachPolicy, countPageErrors, serve, ORIGIN } from './m1-ui-smoke.mjs'

const results = []
const record = (name, pass, detail) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`) }
const req = (method, url) => ({ method: () => method, url: () => url })
const STG_DB = encodeURIComponent('projects/finapp-staging/databases/(default)')
const PROD_DB = encodeURIComponent('projects/finapp-prod-10a83/databases/(default)')
const EMU_DB = encodeURIComponent('projects/demo-finapp/databases/(default)')

/** Runs one request through the policy; returns decision + which counter moved. */
function run(target, method, url) {
  const counts = newCounts()
  const before = { ...counts }
  const d = decideRequest(target, req(method, url), counts)
  const moved = Object.keys(counts).filter(k => counts[k] !== before[k])
  return { action: d.action, moved }
}
function expectAllowed(name, target, method, url) {
  const r = run(target, method, url)
  record(name, r.action === 'continue' && r.moved.includes('allowed'), r)
}
function expectBlocked(name, target, method, url, counter) {
  const r = run(target, method, url)
  record(name, r.action === 'abort' && r.moved.length === 1 && r.moved[0] === counter, r)
}

// ── U1: staging reads and allowed calls ─────────────────────────────────────
expectAllowed('U1a staging Listen POST (exact database)', 'staging', 'POST', `https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=${STG_DB}&VER=8&RID=1`)
expectAllowed('U1b staging Listen GET (exact database)', 'staging', 'GET', `https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=${STG_DB}&VER=8&RID=rpc&SID=x&TYPE=xmlhttp`)
expectAllowed('U1c staging signInWithPassword', 'staging', 'POST', 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k')
expectAllowed('U1d staging accounts:lookup', 'staging', 'POST', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=k')
expectAllowed('U1e staging token refresh', 'staging', 'POST', 'https://securetoken.googleapis.com/v1/token?key=k')
expectAllowed('U1f staging listCompanyMembers', 'staging', 'POST', 'https://us-central1-finapp-staging.cloudfunctions.net/listCompanyMembers')
expectAllowed('U1g staging changeMemberRole', 'staging', 'POST', 'https://us-central1-finapp-staging.cloudfunctions.net/changeMemberRole')
expectAllowed('U1h local build asset', 'staging', 'GET', `${ORIGIN}/finapp/assets/index.js`)

// ── U2: production / foreign Firestore is blocked ───────────────────────────
expectBlocked('U2a production database on Listen channel', 'staging', 'POST', `https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=${PROD_DB}&VER=8`, 'unexpectedFirestoreBlocked')
expectBlocked('U2b production REST document read', 'staging', 'GET', 'https://firestore.googleapis.com/v1/projects/finapp-prod-10a83/databases/(default)/documents/users/x', 'unexpectedFirestoreBlocked')
expectBlocked('U2c Listen without database parameter', 'staging', 'POST', 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?VER=8', 'unexpectedFirestoreBlocked')
expectBlocked('U2d staging project, non-default database', 'staging', 'POST', `https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=${encodeURIComponent('projects/finapp-staging/databases/other')}`, 'unexpectedFirestoreBlocked')
expectBlocked('U2e emulator database sent to staging host', 'staging', 'POST', `https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=${EMU_DB}`, 'unexpectedFirestoreBlocked')
expectBlocked('U2f staging database sent to emulator host', 'emulator', 'POST', `http://127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel?database=${STG_DB}`, 'unexpectedFirestoreBlocked')
expectBlocked('U2g production functions host', 'staging', 'POST', 'https://us-central1-finapp-prod-10a83.cloudfunctions.net/listCompanyMembers', 'externalBlocked')

// ── U3: REST writes (and any REST) are blocked ──────────────────────────────
for (const m of ['PATCH', 'POST', 'DELETE', 'GET']) {
  expectBlocked(`U3 staging REST ${m} on documents`, 'staging', m, 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents/companies/x', 'unexpectedFirestoreBlocked')
}
expectBlocked('U3 emulator REST PATCH', 'emulator', 'PATCH', 'http://127.0.0.1:8080/v1/projects/demo-finapp/databases/(default)/documents/companies/x', 'unexpectedFirestoreBlocked')
expectBlocked('U3 staging REST runQuery POST', 'staging', 'POST', 'https://firestore.googleapis.com/v1/projects/finapp-staging/databases/(default)/documents:runQuery', 'unexpectedFirestoreBlocked')

// ── U4: Write channel / commit / batchWrite are blocked ─────────────────────
for (const [target, origin, db] of [['staging', 'https://firestore.googleapis.com', STG_DB], ['emulator', 'http://127.0.0.1:8080', EMU_DB]]) {
  const p = target === 'staging' ? 'finapp-staging' : 'demo-finapp'
  expectBlocked(`U4 ${target} Write channel`, target, 'POST', `${origin}/google.firestore.v1.Firestore/Write/channel?database=${db}&VER=8`, 'unexpectedFirestoreBlocked')
  expectBlocked(`U4 ${target} commit`, target, 'POST', `${origin}/v1/projects/${p}/databases/(default)/documents:commit`, 'unexpectedFirestoreBlocked')
  expectBlocked(`U4 ${target} batchWrite`, target, 'POST', `${origin}/v1/projects/${p}/databases/(default)/documents:batchWrite`, 'unexpectedFirestoreBlocked')
  expectBlocked(`U4 ${target} unknown RPC on channel host`, target, 'POST', `${origin}/google.firestore.v1.Firestore/BatchGetDocuments?database=${db}`, 'unexpectedFirestoreBlocked')
  expectBlocked(`U4 ${target} Listen with PUT`, target, 'PUT', `${origin}/google.firestore.v1.Firestore/Listen/channel?database=${db}`, 'unexpectedFirestoreBlocked')
}

// ── U5: unexpected M1 mutations and unknown callables are blocked ───────────
for (const target of ['staging', 'emulator']) {
  const fn = name => target === 'staging' ? `https://us-central1-finapp-staging.cloudfunctions.net/${name}` : `http://127.0.0.1:5001/demo-finapp/us-central1/${name}`
  for (const name of ['disableMember', 'restoreMember', 'removeMember', 'createCompany', 'inviteMember', 'cancelInvite', 'resendInvite', 'previewInvite', 'acceptInvite', 'getCompanyAccess', 'authzProbe', 'someUnknownCallable']) {
    expectBlocked(`U5 ${target} ${name}`, target, 'POST', fn(name), 'unexpectedM1MutationBlocked')
  }
  expectBlocked(`U5 ${target} listInvitations counted as expected-blocked`, target, 'POST', fn('listInvitations'), 'expectedListInvitationsBlocked')
  expectBlocked(`U5 ${target} allowed callable with GET`, target, 'GET', fn('changeMemberRole'), 'unexpectedM1MutationBlocked')
}
expectBlocked('U5 emulator callable for another project', 'emulator', 'POST', 'http://127.0.0.1:5001/finapp-staging/us-central1/changeMemberRole', 'unexpectedM1MutationBlocked')

// ── U6: every other Auth endpoint is blocked ────────────────────────────────
for (const p of ['/v1/accounts:sendOobCode', '/v1/accounts:update', '/v1/accounts:signUp', '/v1/accounts:delete', '/v1/accounts:signInWithIdp', '/v1/projects', '/v2/recaptchaConfig']) {
  expectBlocked(`U6 staging auth ${p}`, 'staging', 'POST', `https://identitytoolkit.googleapis.com${p}?key=k`, 'unexpectedAuthBlocked')
}
expectBlocked('U6 staging legacy identitytoolkit v3', 'staging', 'POST', 'https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=k', 'unexpectedAuthBlocked')
expectBlocked('U6 staging lookup with GET', 'staging', 'GET', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=k', 'unexpectedAuthBlocked')
expectBlocked('U6 emulator sendOobCode', 'emulator', 'POST', 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=k', 'unexpectedAuthBlocked')
expectBlocked('U6 emulator config endpoint', 'emulator', 'GET', 'http://127.0.0.1:9099/emulator/v1/projects/demo-finapp/config', 'unexpectedAuthBlocked')

// ── U7: unknown hosts and local-origin misuse ───────────────────────────────
expectBlocked('U7 unknown host', 'staging', 'GET', 'https://fonts.example.invalid/x.css', 'externalBlocked')
expectBlocked('U7 local origin outside /finapp/', 'staging', 'GET', `${ORIGIN}/other`, 'externalBlocked')
expectBlocked('U7 local origin POST', 'staging', 'POST', `${ORIGIN}/finapp/index.html`, 'externalBlocked')

// ── G: PASS gate ────────────────────────────────────────────────────────────
const ok = () => ({ ...newCounts(), changeMemberRolePosts: 3, expectedListInvitationsBlocked: 2 })
record('G0 clean counters pass', uiPassProblems(ok()).length === 0, uiPassProblems(ok()))
for (const key of ['pageErrors', 'externalBlocked', 'unexpectedAuthBlocked', 'unexpectedFirestoreBlocked', 'unexpectedM1MutationBlocked']) {
  const c = { ...ok(), [key]: 1 }
  record(`G ${key}=1 cannot PASS`, uiPassProblems(c).some(p => p.startsWith(`${key}=`)), uiPassProblems(c))
}
record('G changeMemberRolePosts=2 cannot PASS', uiPassProblems({ ...ok(), changeMemberRolePosts: 2 }).length === 1)

// ── B: real browser — pageerror and forbidden/unknown requests are counted and fail the gate ──
{
  const require = createRequire('D:\\projects\\finapp\\.runtime\\node_modules\\x.js')
  const { chromium } = require('playwright')
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-policy-page-'))
  fs.mkdirSync(path.join(dist, 'assets'))
  fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><title>policy test</title><script>
    const hit = u => fetch(u, { method: 'POST', mode: 'no-cors' }).catch(() => {});
    hit('https://unknown-host.example.invalid/collect');
    hit('http://127.0.0.1:8080/google.firestore.v1.Firestore/Write/channel?database=${EMU_DB}&VER=8');
    hit('http://127.0.0.1:5001/demo-finapp/us-central1/removeMember');
    hit('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=k');
    setTimeout(() => { throw new Error('synthetic page error') }, 50);
    setTimeout(() => { document.title = 'done' }, 400);
  </script>`)
  const server = await serve(dist)
  const browser = await chromium.launch({ headless: true })
  const counts = newCounts()
  const leaked = []
  try {
    const context = await browser.newContext()
    await attachPolicy(context, 'emulator', counts, (request, d) => { if (d.action === 'continue' && !request.url().startsWith(ORIGIN)) leaked.push(request.url()) })
    const page = await context.newPage()
    countPageErrors(page, counts)
    await page.goto(`${ORIGIN}/finapp/`, { waitUntil: 'load' })
    await page.waitForFunction(() => document.title === 'done', null, { timeout: 15000 })
    await page.waitForTimeout(500)
  } finally {
    await browser.close()
    server.close()
    fs.rmSync(dist, { recursive: true, force: true })
  }
  const problems = uiPassProblems({ ...counts, changeMemberRolePosts: 3 })
  const expected = ['pageErrors=1', 'externalBlocked=1', 'unexpectedAuthBlocked=1', 'unexpectedFirestoreBlocked=1', 'unexpectedM1MutationBlocked=1']
  record('B1 browser: page error + unknown host + Write channel + removeMember + sendOobCode are counted and cannot PASS',
    leaked.length === 0 && expected.every(p => problems.includes(p)), { problems, leaked })
}

const failed = results.filter(r => !r).length
console.log(`UI_ROUTE_POLICY_TESTS ${failed ? 'FAIL' : 'PASS'} ${results.length - failed}/${results.length}`)
process.exitCode = failed ? 1 : 0
