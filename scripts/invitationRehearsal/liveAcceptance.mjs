#!/usr/bin/env node
// Preparation-only entry point for the future SEC-006 Stage 8 live rehearsal.
// This file deliberately has no live execution path until the complete browser
// contract can be exercised safely. It performs local, fail-closed validation
// and writes only private, sanitized PREPARED evidence outside the checkout.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareLiveAcceptance } from './liveAcceptanceCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const help = 'node scripts/invitationRehearsal/liveAcceptance.mjs --project finapp-staging --expected-head <reviewed-40-char-SHA> --mailbox-file <absolute-private-file> --discovery-receipt <absolute-private-JSON> --manifest <new-absolute-private-JSON> --journal <new-absolute-private-JSONL> --out <new-absolute-private-JSON>'

if (args.length === 1 && args[0] === '--self-test') {
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', path.join(root, 'scripts/invitationRehearsal/liveAcceptanceSelfTest.mjs')], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
if (args.length === 1 && args[0] === '--help') {
  console.log(help)
  console.log('Preparation only: validates the pinned absent-mailbox receipt and hashes the current local dist, then saves PREPARED evidence. Cloud requests, callables, Auth/data writes, email, browser automation and cleanup are disabled.')
  process.exit(0)
}

const sha256 = value => createHash('sha256').update(value).digest('hex')

function parseArgs(values) {
  const names = ['--project', '--expected-head', '--mailbox-file', '--discovery-receipt', '--manifest', '--journal', '--out']
  if (values.length !== names.length * 2) throw new Error('arguments')
  const parsed = {}
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]
    const value = values[index + 1]
    if (!names.includes(name) || Object.hasOwn(parsed, name) || !value || value.startsWith('--')) throw new Error('arguments')
    parsed[name] = value
  }
  if (Object.keys(parsed).length !== names.length) throw new Error('arguments')
  return parsed
}

function gitState() {
  const git = command => execFileSync('git', command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return { head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain', '--untracked-files=all']) }
}

function privatePath(input, existing) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || fs.existsSync(input) !== existing) throw new Error('private_path')
  const parent = fs.realpathSync(path.dirname(input))
  if (existing && fs.lstatSync(input).isSymbolicLink()) throw new Error('private_path')
  const resolved = existing ? fs.realpathSync(input) : path.join(parent, path.basename(input))
  const relative = path.relative(fs.realpathSync(root), resolved)
  if ((!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) ||
      (existing && (fs.lstatSync(resolved).isSymbolicLink() || !fs.lstatSync(resolved).isFile()))) throw new Error('private_path')
  return resolved
}

function readPrivate(pathname, maximumBytes) {
  const stat = fs.statSync(pathname)
  if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) throw new Error('private_input')
  return fs.readFileSync(pathname, 'utf8')
}

function distInventory() {
  const base = path.join(root, 'dist')
  const baseStat = fs.lstatSync(base)
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('dist')
  const files = []
  const visit = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name)
      const stat = fs.lstatSync(filename)
      if (stat.isSymbolicLink()) throw new Error('dist')
      if (stat.isDirectory()) visit(filename)
      else if (stat.isFile()) {
        const bytes = fs.readFileSync(filename)
        files.push({ path: path.relative(root, filename).split(path.sep).join('/'), sha256: sha256(bytes) })
      } else throw new Error('dist')
    }
  }
  visit(base)
  files.sort((left, right) => left.path.localeCompare(right.path))
  if (files.length < 3 || !files.some(file => file.path === 'dist/index.html') ||
      !files.some(file => file.path === 'dist/404.html') ||
      !files.some(file => file.path === 'dist/.vite/manifest.json')) throw new Error('dist')
  return files
}

function durableWrite(pathname, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const descriptor = fs.openSync(pathname, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  const stored = fs.readFileSync(pathname)
  if (!stored.equals(bytes)) throw new Error('durability')
  return sha256(stored)
}

function appendJournal(descriptor, event) {
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`)
  let offset = 0
  while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
  fs.fsyncSync(descriptor)
}

let journalDescriptor
try {
  const parsed = parseArgs(args)
  const mailboxFile = privatePath(parsed['--mailbox-file'], true)
  const discoveryFile = privatePath(parsed['--discovery-receipt'], true)
  const manifestFile = privatePath(parsed['--manifest'], false)
  const journalFile = privatePath(parsed['--journal'], false)
  const outputFile = privatePath(parsed['--out'], false)
  const unique = new Set([mailboxFile, discoveryFile, manifestFile, journalFile, outputFile].map(value => value.toLowerCase()))
  if (unique.size !== 5) throw new Error('private_path')

  // Reserve every output before doing substantive work. `wx` prevents an old
  // live artifact from being truncated or silently reused.
  journalDescriptor = fs.openSync(journalFile, 'wx', 0o600)
  appendJournal(journalDescriptor, {
    task: 'SEC-006 Stage 8 live acceptance',
    status: 'PREPARATION_STARTED',
    project: parsed['--project'],
    sourceHead: parsed['--expected-head'],
    cloudRequests: 0,
    cloudMutations: 0,
    emailsMayBeSent: 0,
  })

  const stateBefore = gitState()
  const discoveryReceipt = fs.readFileSync(discoveryFile)
  if (discoveryReceipt.length < 1 || discoveryReceipt.length > 64 * 1024) throw new Error('private_input')
  const preparation = await prepareLiveAcceptance({
    options: {
      project: parsed['--project'],
      expectedHead: parsed['--expected-head'],
      runId: `stage8-${parsed['--expected-head'].slice(0, 12)}`,
      env: process.env,
    },
    gitState: stateBefore,
    mailboxText: readPrivate(mailboxFile, 512),
    discoveryReceipt,
    distFiles: distInventory(),
    now: () => new Date().toISOString(),
  })

  const stateAfter = gitState()
  if (stateAfter.head !== stateBefore.head || stateAfter.status !== stateBefore.status) throw new Error('git_drift')
  const manifestSha256 = durableWrite(manifestFile, preparation)
  appendJournal(journalDescriptor, {
    task: preparation.task,
    status: preparation.status,
    project: preparation.project,
    sourceHead: preparation.sourceHead,
    manifestSha256,
    cloudRequests: 0,
    cloudMutations: 0,
    emailsMayBeSent: 0,
  })
  const result = {
    task: 'SEC-006 Stage 8 live acceptance',
    status: 'LIVE_ACCEPTANCE_PREPARED',
    project: 'finapp-staging',
    sourceHead: parsed['--expected-head'],
    manifestSha256,
    liveExecutionEnabled: false,
    cloudRequests: 0,
    cloudMutations: 0,
    emailsSent: 0,
    cleanupPerformed: false,
    nextAction: 'Implement and independently review the complete fail-closed live UI runner before requesting separate owner approval.',
  }
  durableWrite(outputFile, result)
  console.log('LIVE_ACCEPTANCE_PREPARED: private sanitized manifest, journal and outcome saved; live execution disabled; cloud requests 0, mutations 0, emails 0.')
} catch {
  if (journalDescriptor !== undefined) {
    try {
      appendJournal(journalDescriptor, {
        task: 'SEC-006 Stage 8 live acceptance',
        status: 'PREPARATION_STOPPED',
        cloudRequests: 0,
        cloudMutations: 0,
        emailsMayBeSent: 0,
      })
    } catch { /* retain any evidence already synced */ }
  }
  console.error('LIVE_ACCEPTANCE_STOPPED: arguments, exact clean HEAD, private paths, discovery evidence, staging dist or durable output check failed. Live execution is disabled; provider details suppressed; no cloud request, mutation, email or cleanup was attempted.')
  process.exitCode = 2
} finally {
  if (journalDescriptor !== undefined) fs.closeSync(journalDescriptor)
}
