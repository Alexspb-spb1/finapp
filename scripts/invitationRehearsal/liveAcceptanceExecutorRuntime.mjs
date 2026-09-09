import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assertNoSecretMaterial, liveAcceptanceTransport, PROJECT, SCENARIO_NAMES } from './liveAcceptanceCore.mjs'
import { createLiveBrowserRequestBinder } from './liveAcceptanceBrowserCore.mjs'
import {
  assertPrivateRecoveryMaterial, createDurableLiveJournal, createDurableRecoveryCheckpoint,
  createLiveStagingExecutor, createVisibleOwnerHandoff,
} from './liveAcceptanceExecutorCore.mjs'
import {
  createCallableDispatchPrimitive, createFirebaseReadOnlyPreflightAdapters,
  createGuardedFirebaseToolsSessionLoader, createIncrementalFirestoreReconciler,
  createSemanticFirestoreReadbackAdapter, createSyntheticVerifiedAuthAdapter,
  runLiveAcceptanceComposition,
} from './liveAcceptanceExecutorAdapters.mjs'
import { createFixedLiveScenarioOperations, createHeldAdminInvitationOperations } from './liveAcceptanceExecutorOperations.mjs'
import {
  createAdminInvitationPlaywrightDriver, createBoundedVisiblePlaywrightSessionFactory,
  createHeldPlaywrightRequestBridge, createPostFixturePlaywrightUiVerifier,
  createSixScenarioComposer, validateLivePlaywrightUiEvidence,
} from './liveAcceptancePlaywrightCore.mjs'
import { openFreshStagingLoopbackGate, LOOPBACK_ORIGIN, STAGING_CONFIG_KEYS } from './liveAcceptanceLoopbackCore.mjs'
import { createFixedIdentityTokenLifecycle } from './liveAcceptanceTokenLifecycle.mjs'
import { normalizeMailbox } from './mailboxDiscoveryCore.mjs'
import { computeFirebaseConfigFingerprint, fingerprintsMatch } from '../lib/firebaseConfigFingerprint.mjs'

export const FIXED_CHROME_EXECUTABLE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
export const LIVE_MAILBOX_FILE_ENV = 'FINAPP_STAGE8_MAILBOX_FILE'
export const LIVE_MAILBOX_BASENAME = 'stage8-mailbox.txt'

const blocked = () => { throw new Error('live_executor_runtime_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const sha256 = value => createHash('sha256').update(value).digest('hex')
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const frozen = value => Object.freeze(structuredClone(value))

const UI_STEPS_BY_SCENARIO = Object.freeze({
  'mailbox-cancelled-invitation': Object.freeze(['admin-copy-link', 'owner-a-admin-ui']),
  'mailbox-resend-token-rotation': Object.freeze([]),
  'wrong-identity-denial': Object.freeze([]),
  'owner-mailbox-verification-acceptance': Object.freeze(['owner-mailbox-accountant-ui', 'owner-mailbox-reload-recovered']),
  'existing-user-company-isolation': Object.freeze([
    'owner-b-company-b-admin-ui', 'owner-b-company-a-viewer-ui', 'owner-b-direct-url-denial', 'owner-b-company-b-restored',
  ]),
  'same-uid-replay-session-recovery': Object.freeze([
    'owner-b-offline-blocked', 'owner-b-online-recovered', 'owner-b-two-tab-logout',
  ]),
})

export function buildVerifiedScenarioRows({ scenarioNames, backendEvidence, uiEvidence }) {
  if (!Array.isArray(scenarioNames) || JSON.stringify(scenarioNames) !== JSON.stringify(SCENARIO_NAMES) ||
      !Array.isArray(backendEvidence) || backendEvidence.length < SCENARIO_NAMES.length) blocked()
  const verifiedUi = validateLivePlaywrightUiEvidence(uiEvidence)
  const uiByStep = new Map(verifiedUi.evidence.map(row => [row.step, row]))
  return frozen(SCENARIO_NAMES.map(name => {
    const backend = backendEvidence.filter(row => record(row) && row.scenario === name &&
      typeof row.kind === 'string' && typeof row.slot === 'string' &&
      (row.readbackSha256 === null || hex64(row.readbackSha256)))
    const ui = UI_STEPS_BY_SCENARIO[name]?.map(step => uiByStep.get(step))
    if (!backend.length || !ui || ui.some(row => !row)) blocked()
    const evidenceSha256 = sha256(JSON.stringify({
      backend: backend.map(row => ({ kind: row.kind, slot: row.slot, readbackSha256: row.readbackSha256 })),
      ui: ui.map(row => ({ step: row.step, observationSha256: row.observationSha256 })),
    }))
    return { name, status: 'PASS', evidenceSha256 }
  }))
}

async function signInSyntheticOwner(page, account) {
  if (!page || !record(account) || typeof account.email !== 'string' || typeof account.password !== 'string' ||
      !account.email || account.password.length < 20) blocked()
  await page.locator('input[type="email"]').fill(account.email)
  await page.locator('input[type="password"]').fill(account.password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  return { signedIn: true }
}

function parseStagingConfig(bytes) {
  const lines = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
  const entries = new Map()
  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (!match || entries.has(match[1])) blocked()
    entries.set(match[1], match[2])
  }
  const names = {
    apiKey: 'VITE_FIREBASE_API_KEY', authDomain: 'VITE_FIREBASE_AUTH_DOMAIN', projectId: 'VITE_FIREBASE_PROJECT_ID',
    storageBucket: 'VITE_FIREBASE_STORAGE_BUCKET', messagingSenderId: 'VITE_FIREBASE_MESSAGING_SENDER_ID', appId: 'VITE_FIREBASE_APP_ID',
  }
  const config = Object.fromEntries(STAGING_CONFIG_KEYS.map(key => [key, entries.get(names[key])]))
  if (entries.get('VITE_APP_ENV') !== 'staging' || entries.get('STAGING_FIREBASE_CONFIG_FINGERPRINT') === undefined ||
      Object.values(config).some(value => typeof value !== 'string' || !value) || config.projectId !== PROJECT) blocked()
  const fingerprint = computeFirebaseConfigFingerprint(config)
  if (!fingerprintsMatch(fingerprint, entries.get('STAGING_FIREBASE_CONFIG_FINGERPRINT'))) blocked()
  return { config, fingerprint, apiKeySha256: sha256(config.apiKey) }
}

function privateMailbox(filename, expectedSha256, repoRoot, io) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !hex64(expectedSha256) || !io.existsSync(filename) ||
      io.lstatSync(filename).isSymbolicLink() || !io.lstatSync(filename).isFile()) blocked()
  const relative = path.relative(io.realpathSync(repoRoot), io.realpathSync(filename))
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) blocked()
  const bytes = io.readFileSync(filename)
  if (bytes.length < 3 || bytes.length > 512) blocked()
  const value = normalizeMailbox(bytes.toString('utf8').trim())
  if (sha256(value) !== expectedSha256) blocked()
  return value
}

function boundMailboxFile(repoRoot, environment) {
  const fixed = path.resolve(path.dirname(repoRoot), '.runtime', LIVE_MAILBOX_BASENAME)
  const configured = environment[LIVE_MAILBOX_FILE_ENV]
  if (configured !== undefined && (typeof configured !== 'string' || path.resolve(configured) !== fixed)) blocked()
  return fixed
}

function loadConcreteRuntimePrerequisites({ repoRoot, approval, environment = process.env, io = fs }) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || !record(approval) ||
      !hex64(approval.mailboxSha256) || !hex64(approval.stagingFingerprint) || !record(environment)) blocked()
  const configPath = path.join(repoRoot, '.env.staging.local')
  if (!io.existsSync(configPath) || io.lstatSync(configPath).isSymbolicLink() || !io.lstatSync(configPath).isFile() ||
      !io.existsSync(FIXED_CHROME_EXECUTABLE) || io.lstatSync(FIXED_CHROME_EXECUTABLE).isSymbolicLink() ||
      !io.lstatSync(FIXED_CHROME_EXECUTABLE).isFile()) blocked()
  const parsed = parseStagingConfig(io.readFileSync(configPath))
  if (parsed.fingerprint !== approval.stagingFingerprint) blocked()
  const mailbox = privateMailbox(boundMailboxFile(repoRoot, environment), approval.mailboxSha256, repoRoot, io)
  return { configPath, parsed, mailbox, chromeExecutable: FIXED_CHROME_EXECUTABLE }
}

/** Return only hashes/booleans; raw mailbox and API config stay in the private loader closure. */
export function validateConcreteRuntimePrerequisites(options) {
  const value = loadConcreteRuntimePrerequisites(options)
  return frozen({ project: PROJECT, configPresent: true, mailboxSha256: sha256(value.mailbox),
    stagingFingerprint: value.parsed.fingerprint, apiKeySha256: value.parsed.apiKeySha256,
    chromeExecutablePresent: true })
}

function gitState(repoRoot) {
  const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return { head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain', '--untracked-files=all']) }
}

export function resolveStagingBuildInvocation({ platform = process.platform, execPath = process.execPath, io = fs } = {}) {
  if (typeof platform !== 'string' || typeof execPath !== 'string' || !io) blocked()
  if (platform !== 'win32') return frozen({ executable: 'npm', arguments: ['run', 'build:staging'] })
  if (!path.isAbsolute(execPath)) blocked()
  if (!io.existsSync(execPath) || io.lstatSync(execPath).isSymbolicLink() || !io.lstatSync(execPath).isFile()) blocked()
  const canonical = value => value.toLowerCase()
  const realExecPath = io.realpathSync(execPath)
  if (canonical(realExecPath) !== canonical(path.resolve(execPath))) blocked()
  const realNodeDirectory = path.dirname(realExecPath)
  const npmCli = path.join(realNodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!io.existsSync(npmCli) || io.lstatSync(npmCli).isSymbolicLink() || !io.lstatSync(npmCli).isFile()) blocked()
  const realNpmCli = io.realpathSync(npmCli)
  const relative = path.relative(realNodeDirectory, realNpmCli)
  if (canonical(realNpmCli) !== canonical(path.resolve(npmCli)) || relative.startsWith(`..${path.sep}`) ||
      relative === '..' || path.isAbsolute(relative)) blocked()
  return frozen({ executable: realExecPath, arguments: [realNpmCli, 'run', 'build:staging'] })
}

function buildStaging(repoRoot) {
  const started = Date.now()
  const invocation = resolveStagingBuildInvocation()
  const result = spawnSync(invocation.executable, invocation.arguments, { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  return { exitCode: result.status ?? 1, sourceHead: gitState(repoRoot).head, finishedAtMs: Math.max(started, Date.now()),
    stdoutSha256: sha256(result.stdout ?? ''), stderrSha256: sha256(result.stderr ?? '') }
}

function immutableFiles(root, io) {
  const files = new Map()
  const visit = directory => {
    for (const entry of io.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) blocked()
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile()) files.set(path.relative(root, target).split(path.sep).join('/'), io.readFileSync(target))
      else blocked()
    }
  }
  visit(root)
  if (!files.has('index.html')) blocked()
  return files
}

export async function spawnImmutableServer({ host, port, root, basePath, notFoundFile, immutableInventorySha256 }, io) {
  const files = immutableFiles(root, io), index = files.get(notFoundFile)
  const rows = [...files].map(([name, bytes]) => ({ path: name, size: bytes.length, sha256: sha256(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const capturedInventorySha256 = sha256(JSON.stringify(rows))
  if (!index || host !== '127.0.0.1' || port !== 5177 || basePath !== '/finapp/' || notFoundFile !== '404.html' ||
      !hex64(immutableInventorySha256) || capturedInventorySha256 !== immutableInventorySha256) blocked()
  let exitCode = null, running = true
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || typeof request.url !== 'string') { response.writeHead(405); response.end(); return }
    const url = new URL(request.url, LOOPBACK_ORIGIN)
    if (url.origin !== LOOPBACK_ORIGIN || url.search || url.hash || !url.pathname.startsWith(basePath)) {
      response.writeHead(404); response.end(index); return
    }
    let name
    try { name = url.pathname === basePath ? 'index.html' : decodeURIComponent(url.pathname.slice(basePath.length)) } catch {
      response.writeHead(400); response.end(); return
    }
    const bytes = files.get(name)
    if (!bytes) { response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); response.end(index); return }
    const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream'
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); response.end(bytes)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  server.once('close', () => { running = false; exitCode = 0 })
  return Object.freeze({ pid: process.pid, host, port, status: async () => ({ running, exitCode }),
    attest: async () => ({ servedFrom: LOOPBACK_ORIGIN, immutableInventorySha256: capturedInventorySha256 }),
    close: async () => { if (running) await new Promise(resolve => server.close(resolve)) } })
}

async function probeLoopback({ origin, indexPath, notFoundPath }) {
  try {
    const [index, missing] = await Promise.all([fetch(`${origin}${indexPath}`, { redirect: 'error' }),
      fetch(`${origin}${notFoundPath}`, { redirect: 'error' })])
    const [indexBytes, missingBytes] = await Promise.all([index.arrayBuffer(), missing.arrayBuffer()])
    return { ready: true, status: index.status, indexSha256: sha256(Buffer.from(indexBytes)),
      notFoundStatus: missing.status, notFoundSha256: sha256(Buffer.from(missingBytes)) }
  } catch { return { ready: false } }
}

export function createCountedTransport(fetchImpl = globalThis.fetch) {
  const guarded = liveAcceptanceTransport(fetchImpl)
  let authorized = 0, dispatched = 0, closed = false
  return Object.freeze({
    authorizeRequest(spec) { if (closed) blocked(); guarded.authorizeRequest(spec); authorized++ },
    async fetch(input, init) { if (closed) blocked(); dispatched++; return guarded.fetch(input, init) },
    close: async () => { closed = true },
    counts: () => ({ authorizedRequests: authorized, dispatchedRequests: dispatched, oauthRefreshes: 0 }),
  })
}

function generatedSecrets() {
  const suffix = randomBytes(8).toString('hex')
  const runId = `stage8-${Date.now().toString(36)}-${suffix}`.slice(0, 39)
  const account = identity => ({ uid: `${runId}-${identity}`, email: `${runId}.${identity.toLowerCase()}@example.invalid`,
    password: randomBytes(32).toString('base64url') })
  return { runId, ownerA: account('ownerA'), ownerB: account('ownerB'),
    idempotencyA: randomBytes(32).toString('base64url'), idempotencyB: randomBytes(32).toString('base64url') }
}

async function pauseOwner(action) {
  const message = action.action === 'OWNER_ENTER_CREDENTIAL'
    ? 'Enter the mailbox password in the visible browser, then press Enter here.'
    : 'Complete the verification email in the visible browser, then press Enter here.'
  process.stderr.write(`${message}\n`)
  const prompt = readline.createInterface({ input: process.stdin, output: process.stderr })
  try { await prompt.question('> ') } finally { prompt.close() }
  return { acknowledged: true }
}

export function writePrivateOutput(filename, value, io = fs) {
  if (record(value) && Object.hasOwn(value, 'recoveryManifest')) assertPrivateRecoveryMaterial(value)
  else assertNoSecretMaterial(value)
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const descriptor = io.openSync(filename, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) {
      const written = io.writeSync(descriptor, bytes, offset, bytes.length - offset)
      if (!Number.isSafeInteger(written) || written < 1 || written > bytes.length - offset) blocked()
      offset += written
    }
    io.fsyncSync(descriptor)
  } finally { io.closeSync(descriptor) }
  if (!io.readFileSync(filename).equals(bytes)) blocked()
}

export function createFixedChromiumLauncher(chromium, executablePath = FIXED_CHROME_EXECUTABLE) {
  if (!chromium || typeof chromium.launch !== 'function' || executablePath !== FIXED_CHROME_EXECUTABLE) blocked()
  return Object.freeze({
    async launch(options) {
      if (!exactKeys(options, ['headless']) || options.headless !== false) blocked()
      return chromium.launch({ headless: false, executablePath })
    },
  })
}

export async function summarizeVerificationResponse(response, meta, expectedMailbox) {
  if (!response || typeof response.status !== 'function' || typeof response.json !== 'function' ||
      !record(meta) || !hex64(meta.requestSha256)) blocked()
  const status = response.status()
  const value = await response.json()
  if (status !== 200 || !exactKeys(value, ['kind', 'email']) ||
      value.kind !== 'identitytoolkit#GetOobConfirmationCodeResponse' ||
      normalizeMailbox(value.email) !== normalizeMailbox(expectedMailbox)) blocked()
  return frozen({ requestSha256: meta.requestSha256, outcomeSha256: sha256(JSON.stringify({ sent: true })) })
}

export function createConcreteLiveAcceptanceRuntime({ repoRoot, io = fs }) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || io.realpathSync(repoRoot) !== path.resolve(repoRoot)) blocked()
  return Object.freeze({
    async run({ parsed, paths, approval, recheckHead }) {
      if (!record(parsed) || !record(paths) || !record(approval) || typeof recheckHead !== 'function') blocked()
      await recheckHead()
      const local = loadConcreteRuntimePrerequisites({ repoRoot, approval, io })
      const secrets = generatedSecrets()
      let providerTransport = null, tokenLifecycle = null, incremental = null
      const playwrightClosers = []
      const registerPlaywrightCloser = close => {
        if (typeof close !== 'function' || playwrightClosers.includes(close)) blocked()
        playwrightClosers.push(close)
      }
      const playwrightClose = async () => {
        let failure = null
        for (const close of [...playwrightClosers].reverse()) {
          try { await close() } catch (error) { failure ??= error }
        }
        playwrightClosers.length = 0
        if (failure) throw failure
      }
      const stages = {
        openLoopback: async ({ sourceHead }) => openFreshStagingLoopbackGate({ repoRoot, distDir: path.join(repoRoot, 'dist'),
          expectedHead: sourceHead, expectedStagingFingerprint: approval.stagingFingerprint,
          expectedApiKeySha256: local.parsed.apiKeySha256, gitState: async () => gitState(repoRoot),
          loadSixFieldConfig: async () => local.parsed.config, runBuild: async () => buildStaging(repoRoot),
          spawnServer: spec => spawnImmutableServer(spec, io), probeReady: probeLoopback, io }),
        openProvider: async () => {
          await recheckHead()
          const loader = createGuardedFirebaseToolsSessionLoader({ repoRoot })
          const session = await loader.execute({ approvalValidated: true, localGatesValidated: true })
          providerTransport = createCountedTransport()
          tokenLifecycle = createFixedIdentityTokenLifecycle({ transport: providerTransport, apiKey: local.parsed.config.apiKey,
            accounts: { ownerA: secrets.ownerA, ownerB: secrets.ownerB }, mailbox: local.mailbox })
          return { session, transport: providerTransport, close: providerTransport.close }
        },
        createJournal: async ({ filename }) => createDurableLiveJournal({ filename, repoRoot, io }),
        createRecoveryCheckpoint: async ({ filename, sourceHead }) =>
          createDurableRecoveryCheckpoint({ filename, repoRoot, sourceHead, io }),
        openPlaywright: async () => {
          const module = await import('playwright-core')
          if (!module.chromium || typeof module.chromium.launch !== 'function') blocked()
          const chromium = createFixedChromiumLauncher(module.chromium, local.chromeExecutable)
          const close = async () => playwrightClose()
          return { browser: Object.freeze({ chromium, close }), close }
        },
        runScenarios: async ({ sourceHead, loopbackReceipt, journal, recoveryCheckpoint, providerSession, browser }) => {
          if (!exactKeys(loopbackReceipt, ['sourceHead', 'servedFrom', 'stagingFingerprint', 'apiKeySha256',
            'distInventorySha256', 'immutableDistAttestationSha256']) || loopbackReceipt.sourceHead !== sourceHead ||
              loopbackReceipt.servedFrom !== LOOPBACK_ORIGIN || loopbackReceipt.stagingFingerprint !== local.parsed.fingerprint ||
              loopbackReceipt.apiKeySha256 !== local.parsed.apiKeySha256 || !hex64(loopbackReceipt.distInventorySha256) ||
              !hex64(loopbackReceipt.immutableDistAttestationSha256)) blocked()
          const preflightAdapters = createFirebaseReadOnlyPreflightAdapters({ session: providerSession, sourceHead,
            mailbox: local.mailbox, expectedAuthMetadataSha256: approval.authMetadataSha256,
            stagingBuildProbe: async () => ({ sourceHead: loopbackReceipt.sourceHead,
              stagingFingerprint: loopbackReceipt.stagingFingerprint, servedFrom: loopbackReceipt.servedFrom,
              sixFieldsVerified: true }) })
          const initial = { runId: secrets.runId, mailboxSha256: approval.mailboxSha256,
            ownerASubjectSha256: sha256(secrets.ownerA.email), ownerBSubjectSha256: sha256(secrets.ownerB.email) }
          const executor = createLiveStagingExecutor({ journal, preflightAdapters,
            expectedPreflight: { sourceHead, functionsSha256: approval.functionsSha256,
              authMetadataSha256: approval.authMetadataSha256, stagingFingerprint: approval.stagingFingerprint,
              mailboxSha256: approval.mailboxSha256 }, initial, recoveryCheckpoint })
          const rawBinder = createLiveBrowserRequestBinder({ stagingFingerprint: local.parsed.fingerprint,
            expectedStagingFingerprint: approval.stagingFingerprint, apiKeySha256: local.parsed.apiKeySha256,
            journalBytes: journal.bytes(), readJournal: journal.bytes })
          let browserRequests = 0
          const binder = Object.freeze({ ...rawBinder, async bind(request) {
            const decision = await rawBinder.bind(request)
            if (decision.action === 'continue') browserRequests++
            return decision
          } })
          const primitive = createCallableDispatchPrimitive({ transport: providerTransport, getIdToken: tokenLifecycle.getIdToken })
          const bridge = createHeldPlaywrightRequestBridge({
            summarizeRegistration: tokenLifecycle.captureOwnerMailboxRegistration,
            summarizeVerification: (response, meta) => summarizeVerificationResponse(response, meta, local.mailbox),
            summarizeAccept: (response, meta) => primitive.summarizeHeld('acceptInvite', response, meta),
            summarizeAccess: (response, meta) => primitive.summarizeHeld('getCompanyAccess', response, meta),
            getExpectedMailboxUid: tokenLifecycle.ownerMailboxUid,
            captureOwnerMailboxForcedRefresh: tokenLifecycle.captureOwnerMailboxForcedRefresh,
          })
          let activeOwnerPage = null
          const clearOwnerClipboard = async () => {
            if (!activeOwnerPage || typeof activeOwnerPage.isClosed !== 'function' || activeOwnerPage.isClosed()) blocked()
            const result = await activeOwnerPage.evaluate(async () => {
              const api = navigator.clipboard
              if (!api || typeof api.writeText !== 'function' || typeof api.readText !== 'function') throw new Error('clipboard_unavailable')
              await api.writeText('')
              return { cleared: await api.readText() === '' }
            })
            if (!exactKeys(result, ['cleared']) || result.cleared !== true) blocked()
            return result
          }
          const sessionFactory = createBoundedVisiblePlaywrightSessionFactory({ chromium: browser.chromium, browserBinder: binder,
            mailboxSha256: approval.mailboxSha256, localStaticOrigin: LOOPBACK_ORIGIN,
            secretActions: {
              async navigateInvitation(page) {
                activeOwnerPage = page
                const state = executor.snapshot().state
                await primitive.withCapability(state.mailboxFinalCapabilitySha256, async token => {
                  await page.goto(`${LOOPBACK_ORIGIN}/finapp/accept-invite/${encodeURIComponent(state.mailboxFinalInviteId)}#token=${token}`,
                    { waitUntil: 'networkidle' })
                  return { completed: true }
                })
                return { navigated: true }
              },
              async fillMailbox(_page, locator) { await locator.fill(local.mailbox); return { filled: true } },
              async clearClipboard(page) {
                if (activeOwnerPage && page !== activeOwnerPage) blocked()
                activeOwnerPage = page
                return clearOwnerClipboard()
              },
            }, requestBridge: bridge,
          })
          const openSession = async options => {
            const session = await sessionFactory.openSession(options)
            if (!playwrightClosers.includes(sessionFactory.close)) registerPlaywrightCloser(sessionFactory.close)
            return session
          }
          const ownerHandoff = createVisibleOwnerHandoff({ openSession, pause: pauseOwner })
          incremental = createIncrementalFirestoreReconciler({ session: providerSession, recoveryCheckpoint })
          const checkedAuth = createSyntheticVerifiedAuthAdapter({ session: providerSession, runId: secrets.runId,
            accounts: { ownerA: secrets.ownerA, ownerB: secrets.ownerB } })
          let firstMutationChecked = false
          const authAdapter = { slot(identity, subjectSha256) {
            const operation = checkedAuth.slot(identity, subjectSha256)
            return Object.freeze({ ...operation, async dispatch(permit) {
              if (!firstMutationChecked) { await recheckHead(); firstMutationChecked = true }
              return operation.dispatch(permit)
            } })
          } }
          const normalPath = { prepare: callable => bridge.takePreparedNormal(callable),
            dispatch: (callable, permit) => bridge.release({ operation: callable, permit }),
            ownerMailboxUid: tokenLifecycle.ownerMailboxUid, clearClipboard: clearOwnerClipboard }
          const baseOperations = createFixedLiveScenarioOperations({ authAdapter, callablePrimitive: primitive, reconciler: incremental,
            normalPath, secrets: { mailbox: local.mailbox, ownerAEmail: secrets.ownerA.email, ownerBEmail: secrets.ownerB.email,
              idempotencyA: secrets.idempotencyA, idempotencyB: secrets.idempotencyB } })

          const adminDriver = createAdminInvitationPlaywrightDriver({
            chromium: browser.chromium, browserBinder: binder, localStaticOrigin: LOOPBACK_ORIGIN,
            secretActions: {
              signInOwnerA: page => signInSyntheticOwner(page, secrets.ownerA),
              async fillInviteMailbox(_page, locator) { await locator.fill(local.mailbox); return { filled: true } },
            },
            summarizeInvitation: (response, meta) => primitive.summarizeHeld('inviteMember', response, meta),
            summarizeList: (response, meta) => primitive.summarizeHeld('listInvitations', response, meta),
          })
          registerPlaywrightCloser(adminDriver.close)
          const adminOperations = createHeldAdminInvitationOperations({ reconciler: incremental, adminDriver,
            mailbox: local.mailbox, mailboxSha256: approval.mailboxSha256 })
          const operations = Object.freeze({
            fixtures: Object.freeze({ ...baseOperations.fixtures, createMailboxCancelledInvite: adminOperations.invitation }),
            readOnly: Object.freeze({ ...baseOperations.readOnly, listCancelledPending: adminOperations.list }),
            clipboard: Object.freeze({ clear: async () => ({ deferred: true }) }),
          })
          const deferredOwnerHandoff = Object.freeze({ ...ownerHandoff, close: async () => ({ deferred: true }) })
          const composer = createSixScenarioComposer({ executor, browserBinder: binder, ownerHandoff: deferredOwnerHandoff, operations })
          const result = await composer.run()
          const uiVerifier = createPostFixturePlaywrightUiVerifier({
            chromium: browser.chromium, browserBinder: binder, localStaticOrigin: LOOPBACK_ORIGIN,
            secretActions: { signIn: (page, identity) => {
              const account = identity === 'ownerA' ? secrets.ownerA : identity === 'ownerB' ? secrets.ownerB : null
              return signInSyntheticOwner(page, account)
            } },
            borrowVerifiedMailboxSession: async () => {
              if (!activeOwnerPage || typeof activeOwnerPage.context !== 'function') blocked()
              return { page: activeOwnerPage, context: activeOwnerPage.context() }
            },
          })
          registerPlaywrightCloser(uiVerifier.close)
          const postFixtureUi = await uiVerifier.run()
          const verifiedUi = validateLivePlaywrightUiEvidence([adminDriver.readEvidence(), ...postFixtureUi.evidence])
          const scenarios = buildVerifiedScenarioRows({ scenarioNames: result.scenarios,
            backendEvidence: result.evidence, uiEvidence: verifiedUi.evidence })
          await clearOwnerClipboard()
          await ownerHandoff.close()
          const safeState = executor.snapshot().state
          const semanticState = Object.fromEntries(['ownerAUid', 'ownerBUid', 'ownerMailboxUid', 'companyAId', 'companyBId',
            'mailboxCancelledInviteId', 'mailboxFinalInviteId', 'ownerBInviteId', 'mailboxCancelledCapabilitySha256',
            'mailboxFinalCapabilitySha256', 'ownerBCapabilitySha256', 'mailboxLockId', 'ownerBLockId'].map(key => [key, safeState[key]]))
          return {
            scenarios, uiEvidence: verifiedUi.evidence, uiEvidenceSha256: verifiedUi.evidenceSha256,
            materializeFixturePlan: executor.materializeFixturePlan,
            readSemanticState: () => frozen(semanticState), readReplayProof: incremental.readReplayProof,
            readCallableCounts: () => { const { total: _total, verificationDispatches: _email, ...counts } = rawBinder.counts(); return counts },
            readTransportCounts: () => { const counts = providerTransport.counts(); return { ...counts,
              authorizedRequests: counts.authorizedRequests + browserRequests,
              dispatchedRequests: counts.dispatchedRequests + browserRequests,
              verificationDispatches: rawBinder.counts().verificationDispatches } },
            verifyAcceptance: executor.verifyAcceptance, buildCleanupPlanOnly: executor.buildCleanupPlanOnly,
          }
        },
        createSemanticReadback: async ({ session, plan, state }) => createSemanticFirestoreReadbackAdapter({ session, plan, state,
          ownerASubjectSha256: sha256(secrets.ownerA.email), ownerBEmailSha256: sha256(secrets.ownerB.email) }),
        writeOutput: async ({ filename, value }) => { await recheckHead(); writePrivateOutput(filename, value, io) },
      }
      const value = await runLiveAcceptanceComposition({ context: { sourceHead: parsed['--expected-head'],
        journalPath: paths['--journal'], outputPath: paths['--out'] }, stages })
      if (value.status !== 'LIVE_ACCEPTANCE_VERIFIED') blocked()
      return { status: value.status }
    },
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) blocked()
