import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  LOOPBACK_ORIGIN, STAGING_CONFIG_KEYS, openFreshStagingLoopbackGate,
} from './liveAcceptanceLoopbackCore.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const head = 'a'.repeat(40)
const config = Object.freeze({
  apiKey: 'test-fixture-api-key-AAAAAAAAAAAAAAAAAAAAAAAAAA',
  authDomain: 'finapp-staging.firebaseapp.com', projectId: 'finapp-staging',
  storageBucket: 'finapp-staging.appspot.com', messagingSenderId: '111111111111',
  appId: '1:111111111111:web:testfixture0000000000',
})
const fingerprint = h(JSON.stringify(Object.fromEntries(STAGING_CONFIG_KEYS.map(key => [key, config[key]]))))

function removeTemporary(base) {
  const resolved = fs.realpathSync(base), temp = fs.realpathSync(os.tmpdir())
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('finapp-loopback-')) throw new Error('temporary_path')
  fs.rmSync(resolved, { recursive: true, force: true })
}

function writeDist(dist) {
  fs.mkdirSync(path.join(dist, '.vite'), { recursive: true })
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  const html = Buffer.from('<!doctype html><script type="module" src="/finapp/assets/app.js"></script>')
  fs.writeFileSync(path.join(dist, 'index.html'), html)
  fs.writeFileSync(path.join(dist, '404.html'), html)
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'globalThis.__finapp = true')
  fs.writeFileSync(path.join(dist, '.vite', 'manifest.json'), JSON.stringify({ 'index.html': { file: 'assets/app.js', isEntry: true } }))
}

function setup(t, override = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finapp-loopback-'))
  const repoRoot = path.join(base, 'repo'), distDir = path.join(repoRoot, 'dist')
  fs.mkdirSync(repoRoot)
  t.after(() => removeTemporary(base))
  let clock = Date.now() - 1_000, childClosed = 0, buildCalls = 0, spawnCalls = 0, immutableInventorySha256 = null
  const child = {
    pid: 4321, host: '127.0.0.1', port: 5177,
    async status() { return { running: true, exitCode: null } },
    async attest() { return { servedFrom: LOOPBACK_ORIGIN, immutableInventorySha256 } },
    async close() { childClosed++ },
  }
  const options = {
    repoRoot, distDir, expectedHead: head, expectedStagingFingerprint: fingerprint, expectedApiKeySha256: h(config.apiKey),
    gitState: async () => ({ head, status: '' }), loadSixFieldConfig: async () => ({ ...config }),
    runBuild: async spec => {
      buildCalls++
      assert.deepEqual(spec.args, ['run', 'build:staging']); assert.equal(spec.capturePolicy, 'hashes-only')
      writeDist(distDir); clock += 100
      return { exitCode: 0, sourceHead: head, finishedAtMs: clock, stdoutSha256: h('stdout'), stderrSha256: h('stderr') }
    },
    spawnServer: async spec => {
      spawnCalls++
      immutableInventorySha256 = spec.immutableInventorySha256
      assert.deepEqual({ host: spec.host, port: spec.port, fallbackHost: spec.fallbackHost, basePath: spec.basePath,
        notFoundFile: spec.notFoundFile }, { host: '127.0.0.1', port: 5177, fallbackHost: null, basePath: '/finapp/', notFoundFile: '404.html' })
      return child
    },
    probeReady: async value => {
      assert.deepEqual(value, { origin: LOOPBACK_ORIGIN, indexPath: '/finapp/', notFoundPath: '/finapp/__missing__' })
      const digest = h(fs.readFileSync(path.join(distDir, 'index.html')))
      return { ready: true, status: 200, indexSha256: digest, notFoundStatus: 404, notFoundSha256: digest }
    },
    now: () => clock, sleep: async ms => { clock += ms }, readinessTimeoutMs: 200,
    ...override,
  }
  return { base, repoRoot, distDir, child, options,
    counts: () => ({ childClosed, buildCalls, spawnCalls }), setClock: value => { clock = value } }
}

test('fresh clean staging build serves one immutable /finapp snapshot on exact loopback only', async t => {
  const value = setup(t)
  const gate = await openFreshStagingLoopbackGate(value.options)
  assert.deepEqual(gate.receipt, {
    sourceHead: head, servedFrom: LOOPBACK_ORIGIN, stagingFingerprint: fingerprint,
    apiKeySha256: h(config.apiKey), distInventorySha256: gate.receipt.distInventorySha256,
    immutableDistAttestationSha256: gate.receipt.immutableDistAttestationSha256,
  })
  assert.match(gate.receipt.distInventorySha256, /^[a-f0-9]{64}$/)
  assert.match(gate.receipt.immutableDistAttestationSha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(gate).includes(config.apiKey), false)
  assert.deepEqual(Object.keys(gate).sort(), ['close', 'receipt'])
  await gate.close(); await gate.close()
  assert.deepEqual(value.counts(), { childClosed: 1, buildCalls: 1, spawnCalls: 1 })
})

test('stale dist and altered six-field config fail before server start', async t => {
  const stale = setup(t)
  writeDist(stale.distDir)
  const old = new Date(Date.now() - 60_000)
  for (const filename of ['index.html', '404.html', path.join('assets', 'app.js'), path.join('.vite', 'manifest.json')]) {
    fs.utimesSync(path.join(stale.distDir, filename), old, old)
  }
  stale.setClock(Date.now())
  stale.options.runBuild = async () => ({ exitCode: 0, sourceHead: head, finishedAtMs: Date.now() + 1,
    stdoutSha256: h('stdout'), stderrSha256: h('stderr') })
  await assert.rejects(() => openFreshStagingLoopbackGate(stale.options))
  assert.equal(stale.counts().spawnCalls, 0)

  const altered = setup(t, { loadSixFieldConfig: async () => ({ ...config, authDomain: 'altered.invalid' }) })
  await assert.rejects(() => openFreshStagingLoopbackGate(altered.options))
  assert.equal(altered.counts().buildCalls, 0)
})

test('dirty or different source HEAD fails before config and build', async t => {
  for (const gitState of [async () => ({ head: 'b'.repeat(40), status: '' }), async () => ({ head, status: ' M src/file.ts' })]) {
    let configReads = 0
    const value = setup(t, { gitState, loadSixFieldConfig: async () => { configReads++; return { ...config } } })
    await assert.rejects(() => openFreshStagingLoopbackGate(value.options))
    assert.equal(configReads, 0); assert.equal(value.counts().buildCalls, 0)
  }
})

test('non-loopback child, port collision and early child exit all teardown fail closed', async t => {
  const foreign = setup(t)
  foreign.options.spawnServer = async () => ({ ...foreign.child, host: '0.0.0.0' })
  await assert.rejects(() => openFreshStagingLoopbackGate(foreign.options))
  assert.equal(foreign.counts().childClosed, 1)

  const collision = setup(t)
  collision.options.spawnServer = async () => { throw new Error('EADDRINUSE') }
  await assert.rejects(() => openFreshStagingLoopbackGate(collision.options))
  assert.equal(collision.counts().childClosed, 0)

  const exited = setup(t)
  exited.child.status = async () => ({ running: false, exitCode: 2 })
  await assert.rejects(() => openFreshStagingLoopbackGate(exited.options))
  assert.equal(exited.counts().childClosed, 1)
})

test('symlinked dist entry and file drift after readiness are rejected with teardown', async t => {
  const symlinked = setup(t)
  const io = new Proxy(fs, { get(target, property) {
    if (property !== 'lstatSync') return Reflect.get(target, property)
    return filename => {
      const stat = target.lstatSync(filename)
      if (path.basename(String(filename)) !== 'app.js') return stat
      return new Proxy(stat, { get(statTarget, statProperty) {
        if (statProperty === 'isSymbolicLink') return () => true
        return Reflect.get(statTarget, statProperty)
      } })
    }
  } })
  symlinked.options.io = io
  await assert.rejects(() => openFreshStagingLoopbackGate(symlinked.options))
  assert.equal(symlinked.counts().spawnCalls, 0)

  const drifted = setup(t)
  drifted.options.probeReady = async () => {
    const digest = h(fs.readFileSync(path.join(drifted.distDir, 'index.html')))
    fs.appendFileSync(path.join(drifted.distDir, 'assets', 'app.js'), '\n// drift')
    return { ready: true, status: 200, indexSha256: digest, notFoundStatus: 404, notFoundSha256: digest }
  }
  await assert.rejects(() => openFreshStagingLoopbackGate(drifted.options))
  assert.equal(drifted.counts().childClosed, 1)
})

test('readiness timeout closes the still-running child without trying another host or port', async t => {
  const value = setup(t, { probeReady: async () => ({ ready: false }) })
  await assert.rejects(() => openFreshStagingLoopbackGate(value.options))
  assert.equal(value.counts().childClosed, 1)
  assert.equal(value.counts().spawnCalls, 1)
})

test('post-readiness immutable server attestation rejects wrong origin, wrong inventory, and callback failure', async t => {
  const cases = [
    async child => ({ ...child, attest: async () => ({ servedFrom: 'http://localhost:5177', immutableInventorySha256: h('inventory') }) }),
    async child => ({ ...child, attest: async () => ({ servedFrom: LOOPBACK_ORIGIN, immutableInventorySha256: h('wrong-inventory') }) }),
    async child => ({ ...child, attest: async () => { throw new Error('attestation-failed') } }),
  ]
  for (const replace of cases) {
    const value = setup(t)
    value.options.spawnServer = async spec => replace({ ...value.child,
      attest: async () => ({ servedFrom: LOOPBACK_ORIGIN, immutableInventorySha256: spec.immutableInventorySha256 }) })
    await assert.rejects(() => openFreshStagingLoopbackGate(value.options))
    assert.equal(value.counts().childClosed, 1)
  }
})
