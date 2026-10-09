#!/usr/bin/env node
// M1-STAGING-READONLY-RECON-PREP-03 - entry point of the bounded READ-ONLY reconciliation package. Status: PREPARED_NOT_AUTHORIZED.
//
//   node recon.mjs plan                  offline: the exact request allowlist, budgets, operation classes and pins as JSON
//   node recon.mjs selftest              offline: the package is consistent (sums, pins, allowlist, frontend pins vs the build manifest, fence pins)
//   node recon.mjs permit-draft          offline: a DRAFT permit with the byte bindings of THIS package (every operation off; not a permit)
//   node recon.mjs execute --permit <abs permit.json>
//                                        the one-use reading: refused (exit 3) unless the permit is valid for exactly these bytes; NOT run in the preparation block
//
// plan / selftest / permit-draft are OFFLINE modes: they refuse to start unless the loopback-only network fence is preloaded (use recon-offline.mjs, which builds the
// isolated environment) and no credential-like variable is present. They never read an owner credential file and never import a live adapter.
// Exit codes of execute: 0 every comparison equals its pin; 4 the reading completed and DIFFERENCES were observed; 2 STOP; 3 INIT_REFUSED (nothing was run).
// `execute` first compares the ACTUAL bytes of every file of this package with CODE-SHA256SUMS.txt (recon-integrity.mjs) and only then checks the permit, claims the namespace,
// reads the cached login or sends a request; a changed, missing or unlisted file is INIT_REFUSED (exit 3) with nothing claimed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { RECON, STOP_CODES } from './recon-pins.mjs'
import { permitTemplate } from './recon-permit.mjs'
import { loadPins, pinProblems, buildEntries, runRecon } from './recon-core.mjs'
import { validateExpected } from './m1-state-lib.mjs'
import { integrityProblems, parseSums, SUMS_FILE } from './recon-integrity.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CREDENTIAL_ENV = /^(GOOGLE_(?!CLOUD_PROJECT$)|GCLOUD(?!_PROJECT$)|CLOUDSDK_(?!CONFIG$)|FIREBASE_(?!EMULATORS_PATH$|CLI_DISABLE_UPDATE_CHECK$)|GH_|GITHUB_|AWS_|AZURE_|NPM_TOKEN|NODE_AUTH_TOKEN|HTTPS?_PROXY|ALL_PROXY)/i

export function offlineGuardProblems(env) {
  const problems = []
  if (!/loopback-only\.cjs/.test(env.NODE_OPTIONS ?? '')) problems.push('the loopback-only network fence is not preloaded')
  if (!env.M1_FENCE_LOG) problems.push('M1_FENCE_LOG is not set')
  if (Object.keys(env).some(k => CREDENTIAL_ENV.test(k) && env[k])) problems.push('credential-like environment variables are present')
  return problems
}

/** The same byte-integrity function that `execute` runs before its claim (actual files vs the manifest, unlisted files, unlisted imports). */
export function sumsProblems(dir = HERE) {
  let files = 0
  try { files = parseSums(fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8'))?.length ?? 0 } catch { /* reported by integrityProblems */ }
  return { problems: integrityProblems(dir), files }
}

export function selftest(dir = HERE) {
  const problems = []
  const sums = sumsProblems(dir)
  problems.push(...sums.problems)
  const pins = loadPins(dir)
  problems.push(...pinProblems(pins), ...validateExpected(pins.expected))
  const entries = buildEntries(pins)
  if (entries.length !== RECON.limits.maxRequests) problems.push('allowlist size differs from the request budget')
  // the frontend pins must equal the accepted staging build manifest, byte for byte
  const manifest = new Map(fs.readFileSync(path.join(dir, 'dist-staging-manifest.txt'), 'utf8').split('\n').filter(Boolean).map(l => [l.slice(66), l.slice(0, 64)]))
  for (const f of pins.frontend.files) if (manifest.get(f.path) !== f.sha256) problems.push(`frontend pin differs from the manifest: ${f.path}`)
  if (pins.frontend.index.sha256 !== manifest.get('index.html')) problems.push('frontend index pin')
  const fencePins = JSON.parse(fs.readFileSync(path.join(dir, 'offline-fence', 'FENCE-PINS.json'), 'utf8'))
  for (const [f, h] of Object.entries(fencePins)) if (createHash('sha256').update(fs.readFileSync(path.join(dir, 'offline-fence', f))).digest('hex') !== h) problems.push(`fence file ${f}`)
  if (STOP_CODES.length < 10) problems.push('stop codes')
  return { ok: problems.length === 0, problems, files: sums.files, entries: entries.length }
}

const arg = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const line = (status, extra = '') => console.log(`M1_RECON_STATUS=${status}${extra ? ` ${extra}` : ''}`)

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (['plan', 'selftest', 'permit-draft'].includes(cmd)) {
    const g = offlineGuardProblems(process.env)
    if (g.length) { line('INIT_REFUSED', `reason=offline guard: ${g[0]}`); process.exit(3) }
  }
  if (cmd === 'plan' || cmd === 'permit-draft') {
    // the bindings printed by these modes are the hashes of the manifest: they are only meaningful for a package whose actual bytes equal it
    const ip = integrityProblems(HERE)
    if (ip.length) { line('INIT_REFUSED', `reason=integrity: ${ip[0]}`); process.exit(3) }
  }
  if (cmd === 'plan') {
    const pins = loadPins(HERE)
    console.log(JSON.stringify({
      task: RECON.taskId, status: RECON.status, project: RECON.project, stageHost: RECON.stageHost, baselineDate: `${RECON.baselineDate} (dated baseline, not current facts)`, namespace: RECON.evidenceName,
      operationClasses: RECON.operationClasses, limits: RECON.limits,
      requests: buildEntries(pins).map(e => ({ id: e.id, class: e.class, method: e.method, host: e.host, path: e.path ?? e.pathPattern, query: e.query, maxRequests: e.maxRequests, maxResponseBytes: e.maxResponseBytes, auth: e.auth })),
      bindings: pins.hashes
    }, null, 2))
    return
  }
  if (cmd === 'selftest') {
    const r = selftest()
    line(r.ok ? 'SELFTEST_PASS' : 'SELFTEST_FAIL', `files=${r.files} requestEntries=${r.entries}${r.problems.length ? ` problems=${r.problems.slice(0, 3).join('; ')}` : ''}`)
    process.exit(r.ok ? 0 : 2)
  }
  if (cmd === 'permit-draft') {
    const h = loadPins(HERE).hashes
    const p = permitTemplate()
    p.bytes = { codeSums: h.codeSumsSha256, requestAllowlist: h.requestAllowlistSha256, frontendAllowlist: h.frontendAllowlistSha256, consumedSubjectPin: h.consumedSubjectPinSha256, expectedState: h.expectedStateSha256, distManifest: h.distManifestSha256 }
    console.log(JSON.stringify(p, null, 2))
    return
  }
  if (cmd === 'execute') {
    let permit = null
    try { permit = JSON.parse(fs.readFileSync(arg(rest, '--permit'), 'utf8')) } catch { /* refused by INIT */ }
    const r = await runRecon({ profile: 'staging', pkg: HERE, evDir: path.join(RECON.runtimeRoot, RECON.evidenceName), env: { ...process.env }, fetchImpl: globalThis.fetch, permit })
    line(r.status, r.stop ? `branch=${r.stop.branch} code=${r.stop.code}` : r.reason ? `reason=${r.reason}` : '')
    process.exit(r.exitCode)
  }
  console.error('usage: recon.mjs <plan|selftest|permit-draft|execute> ...')
  process.exit(3)
}
if (process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) await main()
