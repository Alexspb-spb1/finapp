#!/usr/bin/env node
// Read-only cloud inventory. --self-test and --help never load firebase-tools
// auth/config modules. Real execution requires approval of the linked runbook.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { guard, guardCliAccount, guardedFetch, inventory, PROJECT } from './inventoryCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--self-test') {
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', path.join(root, 'scripts/invitationRehearsal/inventorySelfTest.mjs')], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
if (args.length === 1 && args[0] === '--help') {
  console.log('node scripts/invitationRehearsal/inventory.mjs --project finapp-staging --expected-head <40-char-reviewed-SHA> --out <new-absolute-JSON-path-outside-checkout>')
  process.exit(0)
}

const originalFetch = globalThis.fetch
try {
  if (args.length !== 6 || args[0] !== '--project' || args[2] !== '--expected-head' || args[4] !== '--out') throw new Error('arguments')
  const options = { project: args[1], expectedHead: args[3], env: process.env }
  const gitState = () => ({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    status: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  })
  guard({ ...options, ...gitState() })
  const output = args[5]
  if (!path.isAbsolute(output) || fs.existsSync(output)) throw new Error('output')
  const parent = fs.realpathSync(path.dirname(output))
  const relative = path.relative(fs.realpathSync(root), parent)
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('output')
  // Open only at completion with wx: never overwrite an existing artifact.
  const outputPath = path.join(parent, path.basename(output))
  globalThis.fetch = guardedFetch(originalFetch)
  const require = createRequire(import.meta.url)
  const ft = name => require(path.join(root, 'node_modules/firebase-tools/lib', name))
  let Client
  const report = await inventory({
    options, gitState,
    localRules: () => fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8'),
    authorize: async () => {
      // Standard installed CLI session only, no CLI entry/update notifier,
      // no ADC fallback, no debug transport, no raw error logging.
      const { logger } = ft('logger.js')
      logger.silent = true
      const account = ft('auth.js').getGlobalDefaultAccount()
      guardCliAccount(account)
      const authenticated = await ft('requireAuth.js').requireAuth({ project: PROJECT, user: account.user, tokens: account.tokens }, true)
      if (!authenticated) throw new Error('auth')
      Client = ft('apiv2.js').Client
    },
    get: async spec => {
      const client = new Client({ urlPrefix: spec.origin, auth: true })
      const response = await client.get(spec.path, {
        queryParams: spec.queryParams,
        headers: { 'x-goog-user-project': PROJECT },
        skipLog: { body: true, resBody: true, queryParams: true },
        redirect: 'error',
        timeout: 30000,
      })
      return response.body
    },
  })
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log('INVENTORY_COMPLETE_RELEASE_BLOCKED: sanitized report written; no deployment, data changes or email performed.')
} catch {
  // Never print API exceptions: they may contain tokens/config/user data.
  console.error('INVENTORY_BLOCKED: arguments, clean reviewed HEAD, safe environment, existing CLI access, API response or output check failed. No release authorization implied. No report was overwritten.')
  process.exitCode = 2
} finally {
  globalThis.fetch = originalFetch
}
