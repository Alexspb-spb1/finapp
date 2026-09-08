import fs from 'node:fs'
import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { computeFirebaseConfigFingerprint } from '../lib/firebaseConfigFingerprint.mjs'

export const LOOPBACK_HOST = '127.0.0.1'
export const LOOPBACK_PORT = 5177
export const LOOPBACK_ORIGIN = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`
export const STAGING_CONFIG_KEYS = Object.freeze(['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'])

const blocked = () => { throw new Error('live_loopback_gate_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sameHash = (left, right) => hex64(left) && hex64(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
const frozen = value => Object.freeze(structuredClone(value))

function validateGitState(value, expectedHead) {
  if (!exactKeys(value, ['head', 'status']) || value.head !== expectedHead || value.status !== '') blocked()
}

function validateConfig(config, expectedFingerprint, expectedApiKeySha256) {
  if (!exactKeys(config, STAGING_CONFIG_KEYS) || Object.values(config).some(value => typeof value !== 'string' || value.length < 1 || value.length > 2048) ||
      config.projectId !== 'finapp-staging' || /finapp-prod-10a83/i.test(JSON.stringify(config))) blocked()
  const fingerprint = computeFirebaseConfigFingerprint(config)
  if (!sameHash(fingerprint, expectedFingerprint) || !sameHash(sha256(config.apiKey), expectedApiKeySha256)) blocked()
  return { fingerprint, apiKeySha256: sha256(config.apiKey) }
}

function relativePosix(root, filename) { return path.relative(root, filename).split(path.sep).join('/') }

function inventoryDist(distRoot, io, buildStartedAtMs) {
  if (!path.isAbsolute(distRoot) || !Number.isFinite(buildStartedAtMs)) blocked()
  const rootStat = io.lstatSync(distRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) blocked()
  const rows = []
  const visit = directory => {
    const entries = io.readdirSync(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..') blocked()
      const target = path.join(directory, entry.name), stat = io.lstatSync(target)
      if (stat.isSymbolicLink()) blocked()
      if (stat.isDirectory()) { visit(target); continue }
      if (!stat.isFile() || stat.size < 0 || stat.size > 64 * 1024 * 1024 || stat.mtimeMs < buildStartedAtMs) blocked()
      const relative = relativePosix(distRoot, target)
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) blocked()
      const bytes = io.readFileSync(target)
      if (bytes.length !== stat.size) blocked()
      rows.push({ path: relative, size: stat.size, sha256: sha256(bytes) })
    }
  }
  visit(distRoot)
  if (!rows.length || rows.length > 10_000 || new Set(rows.map(row => row.path)).size !== rows.length) blocked()
  const byName = Object.fromEntries(rows.map(row => [row.path, row]))
  for (const required of ['index.html', '404.html', '.vite/manifest.json']) if (!byName[required]) blocked()
  if (byName['index.html'].sha256 !== byName['404.html'].sha256) blocked()
  const indexBytes = io.readFileSync(path.join(distRoot, 'index.html'))
  const html = indexBytes.toString('utf8')
  if (html.includes('/src/') || html.includes('@vite') || html.includes('finapp-prod-10a83')) blocked()
  const absoluteAssets = [...html.matchAll(/(?:src|href)=["'](\/[^"']+)["']/g)].map(match => match[1])
  if (!absoluteAssets.length || absoluteAssets.some(value => !value.startsWith('/finapp/'))) blocked()
  let manifest
  try { manifest = JSON.parse(io.readFileSync(path.join(distRoot, '.vite/manifest.json'), 'utf8')) } catch { blocked() }
  if (!record(manifest) || !Object.values(manifest).some(value => record(value) && value.isEntry === true)) blocked()
  rows.sort((a, b) => a.path.localeCompare(b.path))
  return { rows, inventorySha256: sha256(JSON.stringify(rows)), indexSha256: byName['index.html'].sha256 }
}

function validateChild(child) {
  if (!exactKeys(child, ['pid', 'host', 'port', 'status', 'attest', 'close']) || !Number.isSafeInteger(child.pid) || child.pid < 1 ||
      child.host !== LOOPBACK_HOST || child.port !== LOOPBACK_PORT || typeof child.status !== 'function' ||
      typeof child.attest !== 'function' || typeof child.close !== 'function') blocked()
}

/** Build a fresh staging artifact, then start one immutable loopback child.
 * Config values and build logs stay inside injected closures; this gate returns
 * only hashes and the fixed loopback origin. */
export async function openFreshStagingLoopbackGate({
  repoRoot, distDir, expectedHead, expectedStagingFingerprint, expectedApiKeySha256,
  gitState, loadSixFieldConfig, runBuild, spawnServer, probeReady,
  io = fs, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), readinessTimeoutMs = 15_000,
}) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || io.realpathSync(repoRoot) !== path.resolve(repoRoot) ||
      distDir !== path.join(repoRoot, 'dist') || !/^[a-f0-9]{40}$/.test(expectedHead) || !hex64(expectedStagingFingerprint) ||
      !hex64(expectedApiKeySha256) || [gitState, loadSixFieldConfig, runBuild, spawnServer, probeReady, now, sleep].some(value => typeof value !== 'function') ||
      !Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 100 || readinessTimeoutMs > 60_000) blocked()
  let child = null, closed = false
  const close = async () => {
    if (closed) return
    closed = true
    if (child) await child.close()
  }
  try {
    validateGitState(await gitState(), expectedHead)
    const configHashes = validateConfig(await loadSixFieldConfig(), expectedStagingFingerprint, expectedApiKeySha256)
    const buildStartedAtMs = now()
    if (!Number.isFinite(buildStartedAtMs) || buildStartedAtMs < 0) blocked()
    const build = await runBuild(Object.freeze({ command: 'npm.cmd', args: Object.freeze(['run', 'build:staging']), cwd: repoRoot,
      sourceHead: expectedHead, capturePolicy: 'hashes-only' }))
    if (!exactKeys(build, ['exitCode', 'sourceHead', 'finishedAtMs', 'stdoutSha256', 'stderrSha256']) || build.exitCode !== 0 ||
        build.sourceHead !== expectedHead || !Number.isFinite(build.finishedAtMs) || build.finishedAtMs < buildStartedAtMs ||
        !hex64(build.stdoutSha256) || !hex64(build.stderrSha256)) blocked()
    validateGitState(await gitState(), expectedHead)
    const initial = inventoryDist(distDir, io, buildStartedAtMs)
    child = await spawnServer(Object.freeze({ host: LOOPBACK_HOST, port: LOOPBACK_PORT, fallbackHost: null,
      root: distDir, basePath: '/finapp/', notFoundFile: '404.html', immutableInventorySha256: initial.inventorySha256 }))
    validateChild(child)
    const readinessStartedAt = now()
    if (!Number.isFinite(readinessStartedAt)) blocked()
    let ready = null
    while (now() - readinessStartedAt <= readinessTimeoutMs) {
      const status = await child.status()
      if (!exactKeys(status, ['running', 'exitCode']) || typeof status.running !== 'boolean' ||
          !(status.exitCode === null || Number.isSafeInteger(status.exitCode))) blocked()
      if (!status.running) blocked()
      const probe = await probeReady(Object.freeze({ origin: LOOPBACK_ORIGIN, indexPath: '/finapp/', notFoundPath: '/finapp/__missing__' }))
      if (exactKeys(probe, ['ready']) && probe.ready === false) { await sleep(25); continue }
      if (!exactKeys(probe, ['ready', 'status', 'indexSha256', 'notFoundStatus', 'notFoundSha256']) || probe.ready !== true ||
          probe.status !== 200 || probe.notFoundStatus !== 404 || probe.indexSha256 !== initial.indexSha256 ||
          probe.notFoundSha256 !== initial.indexSha256) blocked()
      ready = probe; break
    }
    if (!ready) blocked()
    validateGitState(await gitState(), expectedHead)
    const finalInventory = inventoryDist(distDir, io, buildStartedAtMs)
    if (!sameHash(initial.inventorySha256, finalInventory.inventorySha256)) blocked()
    const attestation = await child.attest()
    if (!exactKeys(attestation, ['servedFrom', 'immutableInventorySha256']) || attestation.servedFrom !== LOOPBACK_ORIGIN ||
        !sameHash(attestation.immutableInventorySha256, finalInventory.inventorySha256)) blocked()
    const receipt = frozen({ sourceHead: expectedHead, servedFrom: LOOPBACK_ORIGIN,
      stagingFingerprint: configHashes.fingerprint, apiKeySha256: configHashes.apiKeySha256,
      distInventorySha256: initial.inventorySha256, immutableDistAttestationSha256: sha256(JSON.stringify(attestation)) })
    return Object.freeze({ receipt, close })
  } catch {
    try { await close() } catch { /* retain original fail-closed outcome */ }
    throw new Error('live_loopback_gate_blocked')
  }
}
