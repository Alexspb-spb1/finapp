#!/usr/bin/env node
// Fixed staging Rules backup and additive index operation; never Rules writes,
// data writes, field-override changes, index deletion or service deployment.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { PROJECT, guardCliAccount } from './inventoryCore.mjs'
import { persistJournal } from './apiActivationCore.mjs'
import { resourcesGuard, resourcesTransport, runResources, URLS } from './stagingResourcesCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--self-test') {
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', path.join(root, 'scripts/invitationRehearsal/stagingResourcesSelfTest.mjs')], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
if (args.length === 1 && args[0] === '--help') {
  console.log('node scripts/invitationRehearsal/stagingResources.mjs --mode <backup-rules|verify-rules-backup|verify-current-rules|ensure-index|verify-index> --project finapp-staging --expected-head <reviewed-SHA> --out <new-absolute-private-journal.jsonl>')
  console.log('Rules modes: --expected-rules-hash <canonical-SHA256>; backup modes additionally --backup <absolute-private-backup.json>. Index modes: --expected-field-overrides-hash <approved-SHA256>.')
  console.log('verify-rules-backup is local-only. Every cloud mode needs its applicable owner approval. No deletion, Rules write or implicit deployment.')
  process.exit(0)
}
const originalFetch = globalThis.fetch
let journal
try {
  const parsed = {}
  const accepted = ['--mode', '--project', '--expected-head', '--out', '--backup', '--expected-rules-hash', '--expected-field-overrides-hash']
  if (!args.length || args.length % 2) throw new Error('arguments')
  for (let i = 0; i < args.length; i += 2) {
    if (!accepted.includes(args[i]) || Object.hasOwn(parsed, args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('arguments')
    parsed[args[i]] = args[i + 1]
  }
  const options = { mode: parsed['--mode'], project: parsed['--project'], expectedHead: parsed['--expected-head'],
    expectedRulesHash: parsed['--expected-rules-hash'], expectedFieldHash: parsed['--expected-field-overrides-hash'], env: process.env }
  const needsBackup = ['backup-rules', 'verify-rules-backup'].includes(options.mode)
  if (needsBackup !== Boolean(parsed['--backup']) || (options.mode?.includes('rules') ? options.expectedFieldHash !== undefined : options.expectedRulesHash !== undefined)) throw new Error('arguments')
  const gitState = () => ({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    status: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  })
  resourcesGuard(options, gitState())
  const privatePath = (input, existing) => {
    if (typeof input !== 'string' || !path.isAbsolute(input) || fs.existsSync(input) !== existing) throw new Error('private path')
    const resolved = existing ? fs.realpathSync(input) : path.join(fs.realpathSync(path.dirname(input)), path.basename(input))
    const relative = path.relative(fs.realpathSync(root), resolved)
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('private path')
    return resolved
  }
  const output = privatePath(parsed['--out'], false)
  const backup = needsBackup ? privatePath(parsed['--backup'], options.mode === 'verify-rules-backup') : undefined
  if (backup && backup.toLowerCase() === output.toLowerCase()) throw new Error('private path')
  const transport = resourcesTransport(originalFetch, options.mode, () => resourcesGuard(options, gitState()))
  globalThis.fetch = transport.fetch
  journal = fs.openSync(output, 'wx', 0o600)
  const persist = event => persistJournal(journal, event, fs)
  const require = createRequire(import.meta.url)
  const ft = name => require(path.join(root, 'node_modules/firebase-tools/lib', name))
  let Client
  const result = await runResources({
    options, gitState, transport, persist,
    readBackup: () => JSON.parse(fs.readFileSync(backup, 'utf8')),
    writeBackup: value => {
      const fd = fs.openSync(backup, 'wx', 0o600)
      try { persistJournal(fd, value, fs) } finally { fs.closeSync(fd) }
    },
    authorize: async () => {
      ft('logger.js').logger.silent = true
      const account = ft('auth.js').getGlobalDefaultAccount()
      guardCliAccount(account)
      const authenticated = await ft('requireAuth.js').requireAuth({ project: PROJECT, user: account.user, tokens: account.tokens }, true)
      if (!authenticated) throw new Error('auth')
      Client = ft('apiv2.js').Client
    },
    get: async (target, queryParams = {}) => {
      const url = new URL(target)
      const client = new Client({ urlPrefix: url.origin, auth: true })
      return (await client.get(url.pathname, { queryParams, headers: { 'x-goog-user-project': PROJECT },
        skipLog: { body: true, resBody: true, queryParams: true }, redirect: 'error', timeout: 10000 })).body
    },
    postIndex: async definition => {
      const url = new URL(URLS.create)
      const client = new Client({ urlPrefix: url.origin, auth: true })
      return (await client.post(url.pathname, definition, { headers: { 'x-goog-user-project': PROJECT },
        skipLog: { body: true, resBody: true, queryParams: true }, redirect: 'error', retries: 0, timeout: 10000 })).body
    },
  })
  console.log(`${result.status}: private journal retained; no Rules deployment, data changes or cleanup performed.`)
  const success = ['RULES_BACKUP_VERIFIED_LOCAL', 'RULES_BACKUP_SAVED_VERIFIED', 'CURRENT_RULES_HASH_VERIFIED', 'INVITATION_INDEX_READY_VERIFIED']
  if (result.status === 'INDEX_CREATE_UNCERTAIN') process.exitCode = 3
  else if (!success.includes(result.status)) process.exitCode = 2
} catch {
  console.error('STAGING_RESOURCES_STOPPED: guard, access, response, hash or journal check failed. Preserve artifacts and reconcile current state read-only before any mutation retry. Provider errors suppressed.')
  process.exitCode = 2
} finally {
  globalThis.fetch = originalFetch
  if (journal !== undefined) fs.closeSync(journal)
}
