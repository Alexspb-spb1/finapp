#!/usr/bin/env node
// FINAPP-1.0-M1 R3 synthetic UI smoke against a locally served frontend build (round-2 behaviours, run against round-3 Rules).
// The round-3 flows (lost company, no-access screen) live in m1-ui-smoke-r3.mjs and run after the API mode.
//
//   node m1-ui-smoke.mjs --target <staging|emulator> --expected-head <sha> --run-dir <abs> --dist <abs build dir>
//                        [--web-config <abs staging web config file>]   (required for staging, forbidden for emulator)
//
// Runs after `seed` and before `api`. The served build must contain the verified
// projectId and API key (checked as booleans). Every browser request passes the
// allowlist route policy below; anything not explicitly allowed is aborted and
// counted, and the final PASS gate requires the unexpected counters to be zero.
//
// The policy and the PASS gate are exported for deterministic tests
// (ui-route-policy-tests.mjs); the smoke itself only runs when executed directly.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { guardRun, privateDir, loadStagingWebConfig, journal, writeOnce, saveFixture, readJson, stop, Stop, decodeFields } from './m1-core.mjs'
import { makeTransport } from './m1-transport.mjs'

const RUNTIME_MODULES = 'D:\\projects\\finapp\\.runtime\\node_modules'
export const ORIGIN = 'http://127.0.0.1:5177'
const WAIT = 45000

// ── Route policy ────────────────────────────────────────────────────────────
// UI may call only these callables. Every other callable — including the other
// M1 mutations, invitation callables, createCompany and unknown names — is an
// unexpected mutation. `listInvitations` is requested automatically by the admin
// Users page; it is blocked and counted separately as an expected, known request.
export const UI_ALLOWED_CALLABLES = Object.freeze(['listCompanyMembers', 'changeMemberRole'])
export const UI_EXPECTED_BLOCKED_CALLABLES = Object.freeze(['listInvitations'])
const LISTEN_CHANNEL = '/google.firestore.v1.Firestore/Listen/channel'

export function policyEndpoints(targetName) {
  if (targetName === 'staging') {
    return Object.freeze({
      project: 'finapp-staging',
      auth: Object.freeze({
        'POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword': 'signInWithPassword',
        'POST https://identitytoolkit.googleapis.com/v1/accounts:lookup': 'accounts:lookup',
        'POST https://securetoken.googleapis.com/v1/token': 'token refresh',
      }),
      firestoreOrigin: 'https://firestore.googleapis.com',
      callable: url => url.origin === 'https://us-central1-finapp-staging.cloudfunctions.net' && /^\/[A-Za-z]+$/.test(url.pathname) ? url.pathname.slice(1) : null,
      functionsOrigins: ['https://us-central1-finapp-staging.cloudfunctions.net'],
    })
  }
  if (targetName === 'emulator') {
    return Object.freeze({
      project: 'demo-finapp',
      auth: Object.freeze({
        'POST http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword': 'signInWithPassword',
        'POST http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:lookup': 'accounts:lookup',
        'POST http://127.0.0.1:9099/securetoken.googleapis.com/v1/token': 'token refresh',
      }),
      firestoreOrigin: 'http://127.0.0.1:8080',
      callable: url => url.origin === 'http://127.0.0.1:5001' && /^\/demo-finapp\/us-central1\/[A-Za-z]+$/.test(url.pathname) ? url.pathname.split('/').pop() : null,
      functionsOrigins: ['http://127.0.0.1:5001'],
    })
  }
  throw new Error('unknown target')
}

export function newCounts() {
  return {
    allowed: 0, reloadReLogins: 0, pageErrors: 0,
    externalBlocked: 0, unexpectedAuthBlocked: 0, unexpectedFirestoreBlocked: 0, unexpectedM1MutationBlocked: 0,
    expectedListInvitationsBlocked: 0, changeMemberRolePosts: 0, listCompanyMembersPosts: 0,
  }
}

const AUTH_HOSTS = new Set(['identitytoolkit.googleapis.com', 'securetoken.googleapis.com', 'www.googleapis.com'])

/**
 * Pure decision for one request: { action: 'continue'|'abort', category, detail }.
 * `request` needs url() and method(). Mutates `counts`. No I/O.
 */
export function decideRequest(targetName, request, counts) {
  const ep = policyEndpoints(targetName)
  const method = request.method()
  let url
  try { url = new URL(request.url()) } catch { counts.externalBlocked++; return { action: 'abort', category: 'external', detail: 'unparseable url' } }
  const base = `${url.origin}${url.pathname}`
  const allow = (category, detail) => { counts.allowed++; return { action: 'continue', category, detail } }
  const block = (counter, category, detail) => { counts[counter]++; return { action: 'abort', category, detail } }

  // Local static build: GET under /finapp/ only.
  if (url.origin === ORIGIN) {
    return method === 'GET' && url.pathname.startsWith('/finapp/') ? allow('static', 'build asset') : block('externalBlocked', 'external', 'non-GET or path outside /finapp/ on local origin')
  }

  // Auth: exactly three endpoints (CORS preflight of the same endpoints allowed).
  const authKey = `POST ${base}`
  const isAuthOrigin = targetName === 'emulator'
    ? url.origin === 'http://127.0.0.1:9099'
    : AUTH_HOSTS.has(url.host)
  if (isAuthOrigin) {
    if (Object.hasOwn(ep.auth, authKey) && (method === 'POST' || method === 'OPTIONS')) return allow('auth', ep.auth[authKey])
    return block('unexpectedAuthBlocked', 'auth', `${method} ${url.pathname}`)
  }

  // Firestore: only the Listen WebChannel bound to exactly this project's (default) database.
  if (url.origin === ep.firestoreOrigin || (targetName === 'staging' && url.host.endsWith('firestore.googleapis.com'))) {
    const database = url.searchParams.get('database')
    const expected = `projects/${ep.project}/databases/(default)`
    if (url.origin === ep.firestoreOrigin && url.pathname === LISTEN_CHANNEL && (method === 'GET' || method === 'POST') && database === expected) {
      return allow('firestore', 'listen')
    }
    return block('unexpectedFirestoreBlocked', 'firestore', `${method} ${url.pathname}${database !== null && database !== expected ? ' (foreign database)' : ''}`)
  }

  // Callables: only listCompanyMembers and changeMemberRole.
  if (ep.functionsOrigins.includes(url.origin)) {
    const name = ep.callable(url)
    if (name && UI_ALLOWED_CALLABLES.includes(name) && (method === 'POST' || method === 'OPTIONS')) {
      if (method === 'POST' && name === 'changeMemberRole') counts.changeMemberRolePosts++
      if (method === 'POST' && name === 'listCompanyMembers') counts.listCompanyMembersPosts++
      return allow('callable', name)
    }
    if (name && UI_EXPECTED_BLOCKED_CALLABLES.includes(name)) return block('expectedListInvitationsBlocked', 'callable', `${name} (expected, blocked)`)
    return block('unexpectedM1MutationBlocked', 'callable', `${method} ${name ?? url.pathname}`)
  }

  return block('externalBlocked', 'external', url.host)
}

/** PASS gate for the UI mode. Returns the list of violations (empty = PASS). */
export function uiPassProblems(counts, { expectedChangeMemberRolePosts = 3 } = {}) {
  const problems = []
  for (const key of ['pageErrors', 'externalBlocked', 'unexpectedAuthBlocked', 'unexpectedFirestoreBlocked', 'unexpectedM1MutationBlocked']) {
    if (counts[key] !== 0) problems.push(`${key}=${counts[key]}`)
  }
  if (counts.changeMemberRolePosts !== expectedChangeMemberRolePosts) problems.push(`changeMemberRolePosts=${counts.changeMemberRolePosts} (expected ${expectedChangeMemberRolePosts})`)
  return problems
}

/** Attaches the policy and the page-error counter to a browser context/page. */
export async function attachPolicy(context, targetName, counts, onDecision = () => {}) {
  await context.route('**/*', route => {
    const request = route.request()
    const decision = decideRequest(targetName, request, counts)
    onDecision(request, decision)
    return decision.action === 'continue' ? route.continue() : route.abort()
  })
}
export function countPageErrors(page, counts) {
  page.on('pageerror', () => { counts.pageErrors++ })
}

export function serve(dist, port = 5177) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
  const root = fs.realpathSync(dist)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, ORIGIN)
    if (!url.pathname.startsWith('/finapp/')) { res.writeHead(404).end(); return }
    let rel = decodeURIComponent(url.pathname.slice('/finapp/'.length)) || 'index.html'
    const file = path.resolve(root, rel)
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) rel = 'index.html'
    const target = path.resolve(root, rel)
    res.writeHead(200, { 'content-type': types[path.extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    fs.createReadStream(target).pipe(res)
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

// ── Smoke (only when executed directly) ─────────────────────────────────────
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
if (isMain) await main()

async function main() {
  const argv = process.argv.slice(2)
  const keys = ['--target', '--expected-head', '--run-dir', '--dist', '--web-config']
  const opts = {}
  if (argv.length % 2 !== 0) { console.error('usage'); process.exit(2) }
  for (let i = 0; i < argv.length; i += 2) {
    if (!keys.includes(argv[i]) || Object.hasOwn(opts, argv[i])) { console.error('usage'); process.exit(2) }
    opts[argv[i]] = argv[i + 1]
  }
  if (keys.slice(0, 4).some(k => !opts[k]) || (opts['--target'] === 'staging') !== Boolean(opts['--web-config'])) {
    console.error('usage: --web-config is required for staging and forbidden for emulator'); process.exit(2)
  }

  const results = []
  const counts = newCounts()
  let runDir, log, activePage = null, activeStep = 'init', requestLog = null
  const check = (step, condition, detail) => {
    activeStep = step
    results.push({ step, pass: Boolean(condition), ...(detail === undefined ? {} : { detail }) })
    if (!condition) stop(step, detail === undefined ? 'assertion failed' : JSON.stringify(detail), 'assertion')
  }
  // Sanitized request journal: method, host, path, decision. Never query strings, headers or bodies.
  const recordDecision = (request, decision) => {
    if (requestLog === null) return
    const u = new URL(request.url())
    fs.appendFileSync(requestLog, `${JSON.stringify({ method: request.method(), host: u.host, path: u.pathname, action: decision.action, category: decision.category, detail: decision.detail })}\n`)
  }

  async function login(browser, targetName, user) {
    const context = await browser.newContext()
    await attachPolicy(context, targetName, counts, recordDecision)
    const page = await context.newPage()
    activePage = page
    countPageErrors(page, counts)
    await page.goto(`${ORIGIN}/finapp/#/login`, { waitUntil: 'domcontentloaded', timeout: WAIT })
    await page.locator('input[type="email"]').fill(user.email, { timeout: WAIT })
    await page.locator('input[type="password"]').fill(user.password)
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    await page.getByRole('link', { name: 'Операции' }).first().waitFor({ timeout: WAIT })
    return { context, page }
  }
  const gotoUsers = async page => { await page.evaluate(() => { location.hash = '#/users' }); await page.waitForTimeout(500) }
  const row = (page, email) => page.locator('li', { hasText: email })
  const rowRole = async (page, email, label) => { await row(page, email).getByText(label, { exact: true }).waitFor({ timeout: WAIT }) }

  try {
    const target = guardRun({ target: opts['--target'], expectedHead: opts['--expected-head'] })
    const webConfig = target.name === 'staging' ? await loadStagingWebConfig(opts['--web-config']) : null
    runDir = privateDir(opts['--run-dir'], { mustExist: true })
    log = journal(runDir)
    const fixtureFile = path.join(runDir, 'fixture.json')
    const fx = readJson(fixtureFile)
    if (fx.steps.seed !== 'DONE' || fx.steps.api) stop('ui', 'must run after seed and before api')
    if (fx.steps.ui) stop('ui', 'already attempted — reconcile, never repeat')
    const dist = opts['--dist']
    if (!path.isAbsolute(dist) || !fs.existsSync(path.join(dist, 'index.html'))) stop('ui', 'dist missing')
    // The served build must be bound to the same verified config (booleans only, values never printed).
    const bundle = fs.readdirSync(path.join(dist, 'assets')).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(dist, 'assets', f), 'utf8')).join('\n')
    const bound = target.name === 'staging'
      ? bundle.includes(webConfig.projectId) && bundle.includes(webConfig.apiKey) && !bundle.includes('finapp-prod-10a83')
      : bundle.includes('demo-finapp')
    if (!bound) stop('ui', 'dist is not built from the verified web config', 'integrity')
    fx.steps.ui = 'MAY_BE_SENT'; saveFixture(fixtureFile, fx, log)
    log.append('MODE_START', { mode: 'ui', target: target.name })
    requestLog = path.join(runDir, `ui-requests-${Date.now()}.jsonl`)

    const t = await makeTransport(target, { webConfig, counters: { requests: 0, authCreates: 0, authDeletes: 0, operatorCommits: 0, invitationCallsRefused: 0, callables: {} } })
    const { admin, second, viewer } = fx.users
    const A = fx.companies.A.id
    const auditCount = async () => (await t.listDocs(`companies/${A}`, 'audit_events')).length
    const auditBefore = await auditCount()

    const require = createRequire(path.join(RUNTIME_MODULES, 'x.js'))
    const { chromium } = require('playwright')
    const server = await serve(dist)
    const browser = await chromium.launch({ headless: true })
    try {
      // F1 — admin sees the canonical roster and management controls.
      let s = await login(browser, target.name, admin)
      check('F1.admin-nav-users-visible', await s.page.getByRole('link', { name: 'Пользователи' }).count() === 1)
      await gotoUsers(s.page)
      await rowRole(s.page, admin.email, 'Администратор')
      await rowRole(s.page, second.email, 'Бухгалтер')
      await rowRole(s.page, viewer.email, 'Наблюдатель')
      check('F1.roster-rows', await s.page.locator('li', { hasText: '@example.invalid' }).count() === 3)
      check('F1.manage-buttons', await s.page.locator('button[title="Изменить роль"]').count() === 3)

      // F2 — role change through the UI, then back.
      for (const [label, step] of [['Бухгалтер', 'F2.ui-change-to-accountant'], ['Наблюдатель', 'F2.ui-change-back-to-viewer']]) {
        await row(s.page, viewer.email).locator('button[title="Изменить роль"]').click()
        const form = s.page.locator('form', { hasText: 'Роль в этой компании' })
        await form.getByRole('button', { name: label, exact: true }).click()
        await form.getByRole('button', { name: 'Сохранить' }).click()
        await form.waitFor({ state: 'detached', timeout: WAIT })
        await rowRole(s.page, viewer.email, label)
        check(step, true)
      }
      const viewerDoc = decodeFields((await t.getDoc(`companies/${A}/members/${viewer.uid}`)).fields)
      check('F2.readback', viewerDoc.role === 'viewer' && viewerDoc.status === 'active')
      check('F2.audit', await auditCount() === auditBefore + 2)

      // F3 — last-admin refusal is shown and nothing changes.
      await row(s.page, admin.email).locator('button[title="Изменить роль"]').click()
      const form = s.page.locator('form', { hasText: 'Роль в этой компании' })
      await form.getByRole('button', { name: 'Наблюдатель', exact: true }).click()
      await form.getByRole('button', { name: 'Сохранить' }).click()
      await form.getByRole('alert').filter({ hasText: 'последнего администратора' }).waitFor({ timeout: WAIT })
      check('F3.last-admin-message', true)
      await form.getByRole('button', { name: 'Отмена' }).click()
      await rowRole(s.page, admin.email, 'Администратор')
      check('F3.no-write', decodeFields((await t.getDoc(`companies/${A}/members/${admin.uid}`)).fields).role === 'admin' && await auditCount() === auditBefore + 2)
      await s.context.close()

      // F4 — viewer: no admin navigation, no management controls.
      s = await login(browser, target.name, viewer)
      check('F4.viewer-no-users-nav', await s.page.getByRole('link', { name: 'Пользователи' }).count() === 0)
      await gotoUsers(s.page)
      await s.page.getByText('Управление пользователями доступно администратору', { exact: false }).waitFor({ timeout: WAIT })
      check('F4.viewer-no-manage-buttons', await s.page.locator('button[title="Изменить роль"]').count() === 0)
      await s.context.close()

      // F5 — second user: admin in B, accountant in A; switching changes capabilities.
      s = await login(browser, target.name, second)
      await s.page.getByText(fx.companies.B.name, { exact: true }).first().waitFor({ timeout: WAIT })
      check('F5.home-B-admin-nav', await s.page.getByRole('link', { name: 'Пользователи' }).count() === 1)
      await gotoUsers(s.page)
      await rowRole(s.page, second.email, 'Администратор')
      check('F5.B-roster-two', await s.page.locator('li', { hasText: '@example.invalid' }).count() === 2)
      const switchTo = async (fromName, toName) => {
        activeStep = `switch:${fromName === fx.companies.B.name ? 'B->A' : 'A->B'}`
        await s.page.getByRole('button', { name: fromName }).first().click()
        await Promise.all([
          s.page.waitForEvent('load', { timeout: WAIT }),
          s.page.getByRole('button', { name: toName }).last().click(),
        ])
        // Pre-existing app behaviour (reproduced on main 6d713fe, not M1): a reload can land
        // on #/login after the 3s auth fallback timer. The selected company persists in
        // localStorage, so signing in again is still a faithful switch check.
        const ready = s.page.getByRole('link', { name: 'Операции' }).first()
        const loginForm = s.page.locator('input[type="password"]')
        await Promise.race([ready.waitFor({ timeout: WAIT }), loginForm.waitFor({ timeout: WAIT })])
        if (await loginForm.count()) {
          counts.reloadReLogins++
          await s.page.locator('input[type="email"]').fill(second.email)
          await loginForm.fill(second.password)
          await s.page.getByRole('button', { name: 'Войти', exact: true }).click()
          await ready.waitFor({ timeout: WAIT })
        }
        await s.page.getByText(toName, { exact: true }).first().waitFor({ timeout: WAIT })
        await s.page.waitForTimeout(1500)
      }
      await switchTo(fx.companies.B.name, fx.companies.A.name)
      check('F5.A-accountant-no-users-nav', await s.page.getByRole('link', { name: 'Пользователи' }).count() === 0)
      await gotoUsers(s.page)
      await s.page.getByText('Управление пользователями доступно администратору', { exact: false }).waitFor({ timeout: WAIT })
      check('F5.A-no-manage-buttons', await s.page.locator('button[title="Изменить роль"]').count() === 0)
      await switchTo(fx.companies.A.name, fx.companies.B.name)
      check('F5.back-to-B-admin-nav', await s.page.getByRole('link', { name: 'Пользователи' }).count() === 1)
      await s.context.close()
    } catch (error) {
      if (activePage) { try { await activePage.screenshot({ path: path.join(runDir, `ui-stop-${Date.now()}.png`), fullPage: true }) } catch { /* best effort */ } }
      // A browser/Playwright failure does not touch the manifest or operator transport;
      // Stops raised inside the block (assertions, transport) keep their own kind.
      if (error instanceof Stop) throw error
      stop(`ui-flow after ${activeStep}`, String(error?.message ?? error).split('\n')[0].slice(0, 300), 'ui-flow')
    } finally {
      await browser.close()
      server.close()
    }

    // Final PASS gate — explicit, all counters must be zero.
    const problems = uiPassProblems(counts)
    check('UI.pass-gate', problems.length === 0, { problems, counts })
    fx.steps.ui = 'DONE'; saveFixture(fixtureFile, fx, log)
    const summary = { mode: 'ui', target: target.name, status: 'PASS', checks: results.length, counts }
    writeOnce(path.join(runDir, `result-ui-${Date.now()}.json`), { ...summary, results })
    log.append('MODE_PASS', summary)
    console.log(`M1_UI_SMOKE_PASS checks=${results.length} pageErrors=${counts.pageErrors} externalBlocked=${counts.externalBlocked} unexpectedAuthBlocked=${counts.unexpectedAuthBlocked} unexpectedFirestoreBlocked=${counts.unexpectedFirestoreBlocked} unexpectedM1MutationBlocked=${counts.unexpectedM1MutationBlocked} expectedListInvitationsBlocked=${counts.expectedListInvitationsBlocked} changeMemberRolePosts=${counts.changeMemberRolePosts}`)
  } catch (error) {
    const reason = error instanceof Stop ? error.message : `unexpected: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`
    const kind = error instanceof Stop ? error.kind : 'unexpected'
    if (log) log.append('MODE_STOP', { mode: 'ui', kind, reason, afterStep: activeStep, counts })
    if (runDir) writeOnce(path.join(runDir, `result-ui-${Date.now()}.json`), { mode: 'ui', status: 'STOP', kind, reason, results, counts })
    console.error(`M1_UI_SMOKE_STOP kind=${kind} ${reason}`)
    process.exitCode = 2
  }
}
