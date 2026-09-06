#!/usr/bin/env node
// Read-only staging deployment metadata checks. No deploy/activation, callable,
// Auth/config/data request. Help/self-test do not load CLI credentials.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { PROJECT, guardCliAccount } from './inventoryCore.mjs'
import { deploymentGuard, deploymentTransport, runDeploymentCheck } from './deploymentCheckCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--self-test') {
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', path.join(root, 'scripts/invitationRehearsal/deploymentCheckSelfTest.mjs')], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
if (args.length === 1 && args[0] === '--help') {
  console.log('node scripts/invitationRehearsal/deploymentCheck.mjs --mode <preflight|postflight> --project finapp-staging --expected-head <reviewed-40-char-SHA> --out <new-absolute-private-JSON-outside-checkout>')
  console.log('Read-only metadata; existing billing must be enabled. Does not deploy, upgrade billing, invoke callables or prove email delivery. Cloud mode requires applicable owner approval.')
  process.exit(0)
}
const originalFetch = globalThis.fetch
try {
  const parsed = {}, accepted = ['--mode', '--project', '--expected-head', '--out']
  if (args.length !== accepted.length * 2) throw new Error('arguments')
  for (let i = 0; i < args.length; i += 2) {
    if (!accepted.includes(args[i]) || Object.hasOwn(parsed, args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('arguments')
    parsed[args[i]] = args[i + 1]
  }
  const options = { mode: parsed['--mode'], project: parsed['--project'], expectedHead: parsed['--expected-head'], env: process.env }
  const gitState = () => ({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    status: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  })
  deploymentGuard(options, gitState())
  const output = parsed['--out']
  if (!path.isAbsolute(output) || fs.existsSync(output)) throw new Error('output')
  const parent = fs.realpathSync(path.dirname(output)), relative = path.relative(fs.realpathSync(root), parent)
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('output')
  const outputPath = path.join(parent, path.basename(output))
  globalThis.fetch = deploymentTransport(originalFetch)
  const require = createRequire(import.meta.url)
  const ft = name => require(path.join(root, 'node_modules/firebase-tools/lib', name))
  let Client
  const result = await runDeploymentCheck({
    options, gitState,
    authorize: async () => {
      ft('logger.js').logger.silent = true
      const account = ft('auth.js').getGlobalDefaultAccount()
      guardCliAccount(account)
      const authenticated = await ft('requireAuth.js').requireAuth({ project: PROJECT, user: account.user, tokens: account.tokens }, true)
      if (!authenticated) throw new Error('auth')
      Client = ft('apiv2.js').Client
    },
    get: async ({ url: target, queryParams }) => {
      const url = new URL(target), client = new Client({ urlPrefix: url.origin, auth: true })
      return (await client.get(url.pathname, { queryParams, headers: { 'x-goog-user-project': PROJECT },
        skipLog: { body: true, resBody: true, queryParams: true }, redirect: 'error', retries: 0, timeout: 10000 })).body
    },
  })
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(`${result.status}: private sanitized metadata saved; no deployment, callable invocation, data change or email performed.`)
} catch {
  console.error('DEPLOYMENT_CHECK_BLOCKED: guard, billing, baseline, endpoint metadata, access or output check failed. No automatic deployment/retry or billing upgrade. Provider details suppressed; existing evidence preserved.')
  process.exitCode = 2
} finally {
  globalThis.fetch = originalFetch
}
