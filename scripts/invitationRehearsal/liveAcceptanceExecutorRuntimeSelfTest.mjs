import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildVerifiedScenarioRows, createConcreteLiveAcceptanceRuntime, createCountedTransport, createFixedChromiumLauncher,
  FIXED_CHROME_EXECUTABLE, LIVE_MAILBOX_FILE_ENV, spawnImmutableServer, summarizeVerificationResponse,
  resolveStagingBuildInvocation, validateConcreteRuntimePrerequisites, writePrivateOutput,
} from './liveAcceptanceExecutorRuntime.mjs'
import { SCENARIO_NAMES } from './liveAcceptanceCore.mjs'
import { LIVE_PLAYWRIGHT_UI_STEPS } from './liveAcceptancePlaywrightCore.mjs'
import { computeFirebaseConfigFingerprint } from '../lib/firebaseConfigFingerprint.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const config = {
  apiKey: 'private_api_key_1234567890', authDomain: 'finapp-staging.firebaseapp.com', projectId: 'finapp-staging',
  storageBucket: 'finapp-staging.firebasestorage.app', messagingSenderId: '123456789', appId: '1:123:web:abc',
}
const envBytes = () => Buffer.from([
  'VITE_APP_ENV=staging', `VITE_FIREBASE_API_KEY=${config.apiKey}`, `VITE_FIREBASE_AUTH_DOMAIN=${config.authDomain}`,
  `VITE_FIREBASE_PROJECT_ID=${config.projectId}`, `VITE_FIREBASE_STORAGE_BUCKET=${config.storageBucket}`,
  `VITE_FIREBASE_MESSAGING_SENDER_ID=${config.messagingSenderId}`, `VITE_FIREBASE_APP_ID=${config.appId}`,
  `STAGING_FIREBASE_CONFIG_FINGERPRINT=${computeFirebaseConfigFingerprint(config)}`, '',
].join('\n'))

test('scenario PASS rows require backend evidence and every validated live UI observation', () => {
  const backendEvidence = SCENARIO_NAMES.map((scenario, index) => ({
    scenario, kind: 'fixture', slot: `slot-${index}`, readbackSha256: h(`backend-${index}`),
  }))
  const uiEvidence = LIVE_PLAYWRIGHT_UI_STEPS.map(step => ({
    step, status: 'PASS', observationSha256: h(step),
    ...(step === 'admin-copy-link' ? { initialListSource: 'verified-empty-local-bootstrap' } : {}),
  }))
  const rows = buildVerifiedScenarioRows({ scenarioNames: [...SCENARIO_NAMES], backendEvidence, uiEvidence })
  assert.equal(rows.length, 6)
  assert.deepEqual(rows.map(row => row.name), [...SCENARIO_NAMES])
  assert.equal(rows.every(row => row.status === 'PASS' && /^[a-f0-9]{64}$/.test(row.evidenceSha256)), true)
  assert.throws(() => buildVerifiedScenarioRows({ scenarioNames: [...SCENARIO_NAMES], backendEvidence: backendEvidence.slice(1), uiEvidence }))
  assert.throws(() => buildVerifiedScenarioRows({ scenarioNames: [...SCENARIO_NAMES], backendEvidence, uiEvidence: uiEvidence.slice(1) }))
})

function withFixedChrome(io = fs) {
  return new Proxy(io, { get(target, property) {
    if (property === 'existsSync') return filename => filename === FIXED_CHROME_EXECUTABLE ? true : target.existsSync(filename)
    if (property === 'lstatSync') return filename => filename === FIXED_CHROME_EXECUTABLE
      ? { isFile: () => true, isSymbolicLink: () => false } : target.lstatSync(filename)
    const member = target[property]
    return typeof member === 'function' ? member.bind(target) : member
  } })
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finapp-live-runtime-'))
  const repoRoot = path.join(base, 'repo'), privateRoot = path.join(base, '.runtime')
  fs.mkdirSync(repoRoot); fs.mkdirSync(privateRoot)
  fs.writeFileSync(path.join(repoRoot, '.env.staging.local'), envBytes())
  const mailbox = 'mailbox@example.invalid', mailboxFile = path.join(privateRoot, 'stage8-mailbox.txt')
  fs.writeFileSync(mailboxFile, `${mailbox}\n`)
  t.after(() => {
    const resolved = path.resolve(base)
    assert.equal(resolved.startsWith(path.resolve(os.tmpdir())), true)
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return { repoRoot, mailbox, mailboxFile, approval: { mailboxSha256: h(mailbox), stagingFingerprint: computeFirebaseConfigFingerprint(config) } }
}

test('runtime prerequisites bind the private mailbox path and exact six-field config without exposing values', t => {
  const value = fixture(t)
  const fakeIo = withFixedChrome()
  const receipt = validateConcreteRuntimePrerequisites({ repoRoot: value.repoRoot, approval: value.approval, io: fakeIo,
    environment: { [LIVE_MAILBOX_FILE_ENV]: value.mailboxFile } })
  assert.notEqual(value.approval.stagingFingerprint, h(JSON.stringify(config)))
  assert.deepEqual(Object.keys(receipt).sort(), ['apiKeySha256', 'chromeExecutablePresent', 'configPresent',
    'mailboxSha256', 'project', 'stagingFingerprint'].sort())
  assert.equal(receipt.mailboxSha256, h(value.mailbox))
  assert.equal(JSON.stringify(receipt).includes(value.mailbox), false)
  assert.equal(JSON.stringify(receipt).includes(config.apiKey), false)
})

test('runtime prerequisites fail closed on missing mailbox and missing or altered staging config', t => {
  const value = fixture(t)
  const fakeIo = withFixedChrome()
  fs.rmSync(value.mailboxFile)
  assert.throws(() => validateConcreteRuntimePrerequisites({ repoRoot: value.repoRoot, approval: value.approval, environment: {}, io: fakeIo }))
  fs.writeFileSync(value.mailboxFile, `${value.mailbox}\n`)
  assert.throws(() => validateConcreteRuntimePrerequisites({ repoRoot: value.repoRoot, approval: value.approval,
    environment: { [LIVE_MAILBOX_FILE_ENV]: path.join(path.dirname(value.mailboxFile), 'alternate.txt') }, io: fakeIo }))
  fs.rmSync(path.join(value.repoRoot, '.env.staging.local'))
  assert.throws(() => validateConcreteRuntimePrerequisites({ repoRoot: value.repoRoot, approval: value.approval,
    environment: { [LIVE_MAILBOX_FILE_ENV]: value.mailboxFile }, io: fakeIo }))
  fs.writeFileSync(path.join(value.repoRoot, '.env.staging.local'), Buffer.from(envBytes().toString().replace('finapp-staging.firebaseapp.com', 'foreign.example')))
  assert.throws(() => validateConcreteRuntimePrerequisites({ repoRoot: value.repoRoot, approval: value.approval,
    environment: { [LIVE_MAILBOX_FILE_ENV]: value.mailboxFile }, io: fakeIo }))
  const legacyJsonFingerprint = h(JSON.stringify(config))
  fs.writeFileSync(path.join(value.repoRoot, '.env.staging.local'), Buffer.from(envBytes().toString()
    .replace(computeFirebaseConfigFingerprint(config), legacyJsonFingerprint)))
  assert.throws(() => validateConcreteRuntimePrerequisites({ repoRoot: value.repoRoot,
    approval: { ...value.approval, stagingFingerprint: legacyJsonFingerprint },
    environment: { [LIVE_MAILBOX_FILE_ENV]: value.mailboxFile }, io: fakeIo }))
})

test('runtime prerequisites fail closed when the fixed Chrome executable is absent', t => {
  const value = fixture(t)
  const fakeIo = new Proxy(fs, { get(target, property) {
    if (property === 'existsSync') return filename => filename === FIXED_CHROME_EXECUTABLE ? false : target.existsSync(filename)
    const member = target[property]
    return typeof member === 'function' ? member.bind(target) : member
  } })
  assert.throws(() => validateConcreteRuntimePrerequisites({ repoRoot: value.repoRoot, approval: value.approval,
    environment: { [LIVE_MAILBOX_FILE_ENV]: value.mailboxFile }, io: fakeIo }))
})

test('runtime checks HEAD before reading local private inputs or loading any runtime stage', async t => {
  const value = fixture(t)
  let checks = 0, reads = 0
  const fakeIo = new Proxy(fs, { get(target, property) {
    if (property === 'readFileSync') return (...args) => { reads++; return target.readFileSync(...args) }
    const member = target[property]
    return typeof member === 'function' ? member.bind(target) : member
  } })
  const runtime = createConcreteLiveAcceptanceRuntime({ repoRoot: value.repoRoot, io: fakeIo })
  await assert.rejects(() => runtime.run({ parsed: { '--expected-head': 'a'.repeat(40) },
    paths: { '--journal': path.join(value.repoRoot, 'journal'), '--out': path.join(value.repoRoot, 'out') },
    approval: value.approval, recheckHead: async () => { checks++; throw new Error('head-drift') } }))
  assert.equal(checks, 1)
  assert.equal(reads, 0)
})

test('Windows staging build invokes adjacent npm CLI through the current Node executable', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finapp-live-npm-cli-'))
  const execPath = path.join(base, 'node.exe')
  const npmCli = path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  fs.mkdirSync(path.dirname(npmCli), { recursive: true })
  fs.writeFileSync(execPath, 'fixture executable\n')
  fs.writeFileSync(npmCli, '/* fixture */\n')
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  assert.deepEqual(resolveStagingBuildInvocation({ platform: 'win32', execPath }), {
    executable: execPath, arguments: [npmCli, 'run', 'build:staging'],
  })
  assert.deepEqual(resolveStagingBuildInvocation({ platform: 'linux', execPath: '/usr/bin/node' }), {
    executable: 'npm', arguments: ['run', 'build:staging'],
  })
  fs.rmSync(npmCli)
  assert.throws(() => resolveStagingBuildInvocation({ platform: 'win32', execPath }))
})

test('Windows staging build rejects escaped, symlinked, relative and non-file runtime paths', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finapp-live-npm-containment-'))
  const nodeDirectory = path.join(base, 'node'), outside = path.join(base, 'outside')
  const execPath = path.join(nodeDirectory, 'node.exe')
  const escapedNpmCli = path.join(outside, 'npm', 'bin', 'npm-cli.js')
  fs.mkdirSync(path.dirname(escapedNpmCli), { recursive: true })
  fs.mkdirSync(nodeDirectory)
  fs.writeFileSync(execPath, 'fixture executable\n')
  fs.writeFileSync(escapedNpmCli, '/* escaped fixture */\n')
  fs.symlinkSync(outside, path.join(nodeDirectory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  assert.throws(() => resolveStagingBuildInvocation({ platform: 'win32', execPath }))
  assert.throws(() => resolveStagingBuildInvocation({ platform: 'win32', execPath: 'node.exe' }))
  assert.throws(() => resolveStagingBuildInvocation({ platform: 'win32', execPath: path.join(base, 'missing.exe') }))
  assert.throws(() => resolveStagingBuildInvocation({ platform: 'win32', execPath: nodeDirectory }))

  const finalPath = path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const finalSymlinkIo = new Proxy(fs, { get(target, property) {
    if (property === 'lstatSync') return filename => path.resolve(filename) === path.resolve(finalPath)
      ? { isFile: () => true, isSymbolicLink: () => true } : target.lstatSync(filename)
    const member = target[property]
    return typeof member === 'function' ? member.bind(target) : member
  } })
  assert.throws(() => resolveStagingBuildInvocation({ platform: 'win32', execPath, io: finalSymlinkIo }))
})

test('counted transport records a native dispatch attempt before awaiting an uncertain response', async () => {
  let transport
  transport = createCountedTransport(async () => {
    assert.equal(transport.counts().dispatchedRequests, 1)
    throw new Error('unknown-native-outcome')
  })
  const url = 'https://firebase.googleapis.com/v1beta1/projects/finapp-staging'
  transport.authorizeRequest({ method: 'GET', url, bodySha256: null })
  await assert.rejects(() => transport.fetch(url))
  assert.deepEqual(transport.counts(), { authorizedRequests: 1, dispatchedRequests: 1, oauthRefreshes: 0 })
})

test('private output rejects zero, negative and oversized write progress', t => {
  const value = fixture(t)
  for (const progress of [0, -1, 100_000]) {
    const filename = path.join(value.repoRoot, `out-${String(progress).replace('-', 'n')}.json`)
    const fakeIo = new Proxy(fs, { get(target, property) {
      if (property === 'writeSync') return () => progress
      const member = target[property]
      return typeof member === 'function' ? member.bind(target) : member
    } })
    assert.throws(() => writePrivateOutput(filename, { status: 'SAFE' }, fakeIo))
  }
})

test('private output accepts recovery-only idempotency material but still rejects credentials', t => {
  const value = fixture(t)
  const filename = path.join(value.privateRoot ?? path.dirname(value.mailboxFile), 'recovery.json')
  const recovery = { status: 'RECOVERY_REQUIRED', recoveryManifest: {
    idempotency: { createCompanyA: { idempotencyKey: 'generated-recovery-key-1234567890' } },
  } }
  writePrivateOutput(filename, recovery)
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), recovery)
  assert.throws(() => writePrivateOutput(path.join(path.dirname(value.mailboxFile), 'forbidden.json'), {
    status: 'RECOVERY_REQUIRED', recoveryManifest: { password: 'must-never-persist' },
  }))
})

test('fixed Chromium wrapper injects the exact executable path and rejects caller launch drift', async () => {
  const calls = []
  const wrapped = createFixedChromiumLauncher({ async launch(options) { calls.push(options); return { close: async () => {} } } })
  await wrapped.launch({ headless: false })
  assert.deepEqual(calls, [{ headless: false, executablePath: FIXED_CHROME_EXECUTABLE }])
  await assert.rejects(() => wrapped.launch({ headless: true }))
  await assert.rejects(() => wrapped.launch({ headless: false, executablePath: 'alternate' }))
})

test('verification response accepts the real email shape but emits hashes only', async () => {
  const requestSha256 = h('verification-request')
  const mailbox = 'mailbox@example.invalid'
  const body = { kind: 'identitytoolkit#GetOobConfirmationCodeResponse', email: mailbox }
  const safe = await summarizeVerificationResponse({ status: () => 200, json: async () => body },
    { requestSha256 }, mailbox)
  assert.deepEqual(Object.keys(safe).sort(), ['outcomeSha256', 'requestSha256'])
  assert.equal(JSON.stringify(safe).includes(mailbox), false)
  await assert.rejects(() => summarizeVerificationResponse({ status: () => 200, json: async () => ({ ...body, extra: true }) },
    { requestSha256 }, mailbox))
})

test('immutable child attests its own in-memory inventory instead of echoing the supplied hash', async t => {
  const value = fixture(t), dist = path.join(value.repoRoot, 'runtime-dist')
  fs.mkdirSync(dist)
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>ok</html>')
  fs.writeFileSync(path.join(dist, '404.html'), '<html>ok</html>')
  const rows = ['404.html', 'index.html'].map(name => {
    const bytes = fs.readFileSync(path.join(dist, name))
    return { path: name, size: bytes.length, sha256: h(bytes) }
  })
  const inventory = h(JSON.stringify(rows))
  const child = await spawnImmutableServer({ host: '127.0.0.1', port: 5177, root: dist, basePath: '/finapp/',
    notFoundFile: '404.html', immutableInventorySha256: inventory }, fs)
  t.after(() => child.close())
  assert.deepEqual(Object.keys(child).sort(), ['attest', 'close', 'host', 'pid', 'port', 'status'])
  assert.deepEqual(await child.attest(), { servedFrom: 'http://127.0.0.1:5177', immutableInventorySha256: inventory })
  await child.close()
  await assert.rejects(() => spawnImmutableServer({ host: '127.0.0.1', port: 5177, root: dist, basePath: '/finapp/',
    notFoundFile: '404.html', immutableInventorySha256: h('wrong') }, fs))
})
