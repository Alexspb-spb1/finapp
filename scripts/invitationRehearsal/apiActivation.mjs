#!/usr/bin/env node
// Executes only the separately owner-approved fixed Functions API package.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { guardCliAccount, PROJECT } from './inventoryCore.mjs'
import { activationGuard, activationTransport, persistJournal, runFunctionsApi, SERVICE_URL } from './apiActivationCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--self-test') {
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', path.join(root, 'scripts/invitationRehearsal/apiActivationSelfTest.mjs')], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
if (args.length === 1 && args[0] === '--help') {
  console.log('node scripts/invitationRehearsal/apiActivation.mjs --mode <inspect|enable> --project finapp-staging --service cloudfunctions.googleapis.com --expected-head <reviewed-SHA> --out <new-absolute-private-JSONL-path>')
  console.log('Enable mode requires separate owner approval. At most one enable POST; no automatic retry or disable.')
  process.exit(0)
}
const originalFetch = globalThis.fetch
let journal
try {
  if (args.length !== 10 || args[0] !== '--mode' || args[2] !== '--project' || args[4] !== '--service' || args[6] !== '--expected-head' || args[8] !== '--out') throw new Error('arguments')
  const options = { mode: args[1], project: args[3], service: args[5], expectedHead: args[7], env: process.env }
  const gitState = () => ({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    status: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  })
  activationGuard(options, gitState())
  const output = args[9]
  if (!path.isAbsolute(output) || fs.existsSync(output)) throw new Error('output')
  const parent = fs.realpathSync(path.dirname(output))
  const relative = path.relative(fs.realpathSync(root), parent)
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('output')
  const outputPath = path.join(parent, path.basename(output))
  const require = createRequire(import.meta.url)
  const ft = name => require(path.join(root, 'node_modules/firebase-tools/lib', name))
  const transport = activationTransport(originalFetch, options.mode, () => activationGuard(options, gitState()))
  globalThis.fetch = transport.fetch
  // Reserve a NEW durable private journal before authentication or requests.
  journal = fs.openSync(outputPath, 'wx', 0o600)
  const persist = event => persistJournal(journal, event, fs)
  let Client
  const report = await runFunctionsApi({
    options, gitState, persist, allowOperation: transport.allowOperation,
    authorize: async () => {
      ft('logger.js').logger.silent = true
      const account = ft('auth.js').getGlobalDefaultAccount()
      guardCliAccount(account)
      const authenticated = await ft('requireAuth.js').requireAuth({ project: PROJECT, user: account.user, tokens: account.tokens }, true)
      if (!authenticated) throw new Error('auth')
      Client = ft('apiv2.js').Client
    },
    get: async (target, fields) => {
      const url = new URL(target)
      const client = new Client({ urlPrefix: url.origin, auth: true })
      const response = await client.get(url.pathname, {
        queryParams: { fields }, headers: { 'x-goog-user-project': PROJECT },
        skipLog: { body: true, resBody: true, queryParams: true },
        redirect: 'error', retries: 0, timeout: 10000,
      })
      return response.body
    },
    post: async () => {
      const url = new URL(`${SERVICE_URL}:enable`)
      const client = new Client({ urlPrefix: url.origin, auth: true })
      const response = await client.post(url.pathname, {}, {
        headers: { 'x-goog-user-project': PROJECT },
        skipLog: { body: true, resBody: true, queryParams: true },
        redirect: 'error', retries: 0, timeout: 10000,
      })
      return response.body
    },
  })
  console.log(`${report.status}: private journal retained; no deployment, plan upgrade or rollback performed.`)
  if (report.status === 'API_ENABLE_UNCERTAIN') process.exitCode = 3
  else if (report.status.startsWith('API_ENABLE_')) process.exitCode = 2
} catch {
  console.error('FUNCTIONS_API_STOPPED: guard, access, response or journal check failed. Inspect retained journal and current state read-only before any retry. Provider errors are suppressed.')
  process.exitCode = 2
} finally {
  globalThis.fetch = originalFetch
  if (journal !== undefined) fs.closeSync(journal)
}
