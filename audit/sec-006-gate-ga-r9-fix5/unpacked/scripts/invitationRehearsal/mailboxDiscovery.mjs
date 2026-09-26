#!/usr/bin/env node
// Narrow read-only staging lookup. It never prints or persists the mailbox,
// uid, profile fields, credentials, tokens or raw provider errors.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { guard, guardCliAccount, PROJECT } from './inventoryCore.mjs'
import { createMailboxRequests, discoverMailbox, discoveryTransport, normalizeMailbox } from './mailboxDiscoveryCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--self-test') {
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', path.join(root, 'scripts/invitationRehearsal/mailboxDiscoverySelfTest.mjs')], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
if (args.length === 1 && args[0] === '--help') {
  console.log('node scripts/invitationRehearsal/mailboxDiscovery.mjs --project finapp-staging --expected-head <reviewed-SHA> --mailbox-file <absolute-private-file> --out <new-absolute-private-JSON>')
  process.exit(0)
}

const originalFetch = globalThis.fetch
try {
  if (args.length !== 8 || args[0] !== '--project' || args[2] !== '--expected-head' || args[4] !== '--mailbox-file' || args[6] !== '--out') throw new Error('arguments')
  const options = { project: args[1], expectedHead: args[3], env: process.env }
  const gitState = () => ({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    status: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  })
  guard({ ...options, ...gitState() })
  const mailboxFile = args[5]
  const output = args[7]
  if (!path.isAbsolute(mailboxFile) || !path.isAbsolute(output) || fs.existsSync(output)) throw new Error('paths')
  const rootReal = fs.realpathSync(root)
  const outside = (value, existingFile = false) => {
    const realParent = fs.realpathSync(path.dirname(value))
    const relative = path.relative(rootReal, realParent)
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('paths')
    const resolved = path.join(realParent, path.basename(value))
    if (existingFile) {
      const stat = fs.lstatSync(resolved)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) throw new Error('paths')
      const realFile = fs.realpathSync(resolved)
      const fileRelative = path.relative(rootReal, realFile)
      if (!fileRelative.startsWith(`..${path.sep}`) && fileRelative !== '..' && !path.isAbsolute(fileRelative)) throw new Error('paths')
      return realFile
    }
    return resolved
  }
  const safeMailboxFile = outside(mailboxFile, true)
  const safeOutput = outside(output)
  const mailbox = normalizeMailbox(fs.readFileSync(safeMailboxFile, 'utf8'))
  const transport = discoveryTransport(originalFetch, mailbox)
  globalThis.fetch = transport.fetch
  const require = createRequire(import.meta.url)
  const ft = name => require(path.join(root, 'node_modules/firebase-tools/lib', name))
  const { logger } = ft('logger.js')
  logger.silent = true
  const account = ft('auth.js').getGlobalDefaultAccount()
  guardCliAccount(account)
  const authenticated = await ft('requireAuth.js').requireAuth({ project: PROJECT, user: account.user, tokens: account.tokens }, true)
  if (!authenticated) throw new Error('auth')
  const Client = ft('apiv2.js').Client
  const report = await discoverMailbox({ mailbox, ...createMailboxRequests({ Client, transport, mailbox }) })
  guard({ ...options, ...gitState() })
  fs.writeFileSync(safeOutput, `${JSON.stringify({ ...report, sourceHead: options.expectedHead }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log('MAILBOX_DISCOVERY_COMPLETE: private sanitized receipt saved; cloud mutations 0, emails 0.')
} catch {
  console.error('MAILBOX_DISCOVERY_BLOCKED: arguments, clean reviewed HEAD, private paths, CLI access, exact staging response or output check failed; no raw provider data printed.')
  process.exitCode = 2
} finally {
  globalThis.fetch = originalFetch
}
