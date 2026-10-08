#!/usr/bin/env node
// FINAPP-1.0-M1 R3 synthetic UI smoke of the round-3 behaviour, against a locally served frontend build.
//
//   node m1-ui-smoke-r3.mjs --target <staging|emulator> --expected-head <sha> --run-dir <abs> --dist <abs build dir>
//                           [--web-config <abs staging web config file>]   (required for staging, forbidden for emulator)
//
// Runs after `seed`, `ui` and `api` (the API mode left U3 removed from company A but still a member of B,
// and U1 - the owner of A - with no membership at all). It proves what the audit findings were about, in the
// real browser, against the live Rules:
//   U1  U3 (home company A lost, B kept) signs in and gets company B - sign-in is not broken by the lost
//       company, the switcher offers only B, there is no "no access" screen (finding 3);
//   U2  U1 (ownerId of A, no membership anywhere) signs in and gets the dedicated "no access" screen, not an
//       error screen and not company A (findings 2 and 3); "Check again" stays there; "Sign out" works.
// Every browser request passes the same allowlist route policy as the `ui` mode (m1-ui-smoke.mjs); here no
// callable is expected at all, so the PASS gate demands zero changeMemberRole POSTs as well.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { guardRun, privateDir, loadStagingWebConfig, journal, writeOnce, saveFixture, readJson, stop, Stop } from './m1-core.mjs'
import { ORIGIN, newCounts, uiPassProblems, attachPolicy, countPageErrors, serve } from './m1-ui-smoke.mjs'

const RUNTIME_MODULES = 'D:\\projects\\finapp\\.runtime\\node_modules'
const WAIT = 45000
export const NO_ACCESS_HEADING = 'Нет доступа к компании'

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
const recordDecision = (request, decision) => {
  if (requestLog === null) return
  const u = new URL(request.url())
  fs.appendFileSync(requestLog, `${JSON.stringify({ method: request.method(), host: u.host, path: u.pathname, action: decision.action, category: decision.category, detail: decision.detail })}\n`)
}

async function openLogin(browser, targetName, user) {
  const context = await browser.newContext()
  await attachPolicy(context, targetName, counts, recordDecision)
  const page = await context.newPage()
  activePage = page
  countPageErrors(page, counts)
  await page.goto(`${ORIGIN}/finapp/#/login`, { waitUntil: 'domcontentloaded', timeout: WAIT })
  await page.locator('input[type="email"]').fill(user.email, { timeout: WAIT })
  await page.locator('input[type="password"]').fill(user.password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  return { context, page }
}

try {
  const target = guardRun({ target: opts['--target'], expectedHead: opts['--expected-head'] })
  const webConfig = target.name === 'staging' ? await loadStagingWebConfig(opts['--web-config']) : null
  runDir = privateDir(opts['--run-dir'], { mustExist: true })
  log = journal(runDir)
  const fixtureFile = path.join(runDir, 'fixture.json')
  const fx = readJson(fixtureFile)
  if (fx.steps.seed !== 'DONE' || fx.steps.ui !== 'DONE' || fx.steps.api !== 'DONE') stop('ui-r3', 'must run after seed, ui and api')
  if (fx.steps.uiR3) stop('ui-r3', 'already attempted — reconcile, never repeat')
  const dist = opts['--dist']
  if (!path.isAbsolute(dist) || !fs.existsSync(path.join(dist, 'index.html'))) stop('ui-r3', 'dist missing')
  const bundle = fs.readdirSync(path.join(dist, 'assets')).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(dist, 'assets', f), 'utf8')).join('\n')
  const bound = target.name === 'staging'
    ? bundle.includes(webConfig.projectId) && bundle.includes(webConfig.apiKey) && !bundle.includes('finapp-prod-10a83')
    : bundle.includes('demo-finapp')
  if (!bound) stop('ui-r3', 'dist is not built from the verified web config', 'integrity')
  fx.steps.uiR3 = 'MAY_BE_SENT'; saveFixture(fixtureFile, fx, log)
  log.append('MODE_START', { mode: 'ui-r3', target: target.name })
  requestLog = path.join(runDir, `ui-r3-requests-${Date.now()}.jsonl`)

  const { admin, viewer } = fx.users
  const A = fx.companies.A, B = fx.companies.B

  const require = createRequire(path.join(RUNTIME_MODULES, 'x.js'))
  const { chromium } = require('playwright')
  const server = await serve(dist)
  const browser = await chromium.launch({ headless: true })
  try {
    // U1 — U3 lost company A (still its legacy home company in the profile) but is a member of B.
    let s = await openLogin(browser, target.name, viewer)
    await s.page.getByRole('link', { name: 'Операции' }).first().waitFor({ timeout: WAIT })
    check('U1.signed-in-despite-lost-company', true)
    await s.page.getByText(B.name, { exact: true }).first().waitFor({ timeout: WAIT })
    check('U1.company-B-opened', true)
    check('U1.no-access-screen-absent', await s.page.getByText(NO_ACCESS_HEADING, { exact: true }).count() === 0)
    check('U1.viewer-no-users-nav', await s.page.getByRole('link', { name: 'Пользователи' }).count() === 0)
    await s.page.getByRole('button', { name: B.name }).first().click()
    await s.page.getByRole('button', { name: B.name }).last().waitFor({ timeout: WAIT })
    check('U1.switcher-offers-B', true)
    check('U1.switcher-does-not-offer-lost-A', await s.page.getByRole('button', { name: A.name }).count() === 0 && await s.page.getByText(A.name, { exact: true }).count() === 0)
    await s.context.close()

    // U2 — U1 owns A (ownerId) but has no membership anywhere: the dedicated screen, nothing else.
    s = await openLogin(browser, target.name, admin)
    await s.page.getByText(NO_ACCESS_HEADING, { exact: true }).waitFor({ timeout: WAIT })
    check('U2.no-access-screen-shown', true)
    check('U2.app-shell-absent', await s.page.getByRole('link', { name: 'Операции' }).count() === 0)
    check('U2.owned-company-name-absent', await s.page.getByText(A.name, { exact: true }).count() === 0)
    await s.page.getByRole('button', { name: 'Проверить снова' }).click()
    await s.page.getByRole('button', { name: 'Проверить снова' }).waitFor({ timeout: WAIT })
    await s.page.waitForTimeout(1500)
    check('U2.recheck-stays-on-no-access', await s.page.getByText(NO_ACCESS_HEADING, { exact: true }).count() === 1 && await s.page.getByRole('link', { name: 'Операции' }).count() === 0)
    await s.page.getByRole('button', { name: 'Выйти' }).click()
    await s.page.locator('input[type="password"]').waitFor({ timeout: WAIT })
    check('U2.sign-out-returns-to-login', true)
    await s.context.close()
  } catch (error) {
    if (activePage) { try { await activePage.screenshot({ path: path.join(runDir, `ui-r3-stop-${Date.now()}.png`), fullPage: true }) } catch { /* best effort */ } }
    if (error instanceof Stop) throw error
    stop(`ui-flow after ${activeStep}`, String(error?.message ?? error).split('\n')[0].slice(0, 300), 'ui-flow')
  } finally {
    await browser.close()
    server.close()
  }

  const problems = uiPassProblems(counts, { expectedChangeMemberRolePosts: 0 })
  if (counts.listCompanyMembersPosts !== 0) problems.push(`listCompanyMembersPosts=${counts.listCompanyMembersPosts} (expected 0)`)
  check('UI-R3.pass-gate', problems.length === 0, { problems, counts })
  fx.steps.uiR3 = 'DONE'; saveFixture(fixtureFile, fx, log)
  const summary = { mode: 'ui-r3', target: target.name, status: 'PASS', checks: results.length, counts }
  writeOnce(path.join(runDir, `result-ui-r3-${Date.now()}.json`), { ...summary, results })
  log.append('MODE_PASS', summary)
  console.log(`M1_UI_R3_SMOKE_PASS checks=${results.length} pageErrors=${counts.pageErrors} externalBlocked=${counts.externalBlocked} unexpectedAuthBlocked=${counts.unexpectedAuthBlocked} unexpectedFirestoreBlocked=${counts.unexpectedFirestoreBlocked} unexpectedM1MutationBlocked=${counts.unexpectedM1MutationBlocked}`)
} catch (error) {
  const reason = error instanceof Stop ? error.message : `unexpected: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`
  const kind = error instanceof Stop ? error.kind : 'unexpected'
  if (log) log.append('MODE_STOP', { mode: 'ui-r3', kind, reason, afterStep: activeStep, counts })
  if (runDir) writeOnce(path.join(runDir, `result-ui-r3-${Date.now()}.json`), { mode: 'ui-r3', status: 'STOP', kind, reason, results, counts })
  console.error(`M1_UI_R3_SMOKE_STOP kind=${kind} ${reason}`)
  process.exitCode = 2
}
