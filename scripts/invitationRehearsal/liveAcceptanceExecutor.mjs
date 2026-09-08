#!/usr/bin/env node
// Fail-closed CLI gate for the future SEC-006 Stage 8 live executor. Help,
// self-test and invalid arguments never load Firebase credentials or a browser.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LIVE_EXECUTOR_MISSING_ADAPTERS } from './liveAcceptanceExecutorAdapters.mjs'
import {
  EXECUTOR_HELP, routeExecutorCli, validateCleanExecutorHead,
  validateExecutionApproval, validatePrivateExecutorPaths,
} from './liveAcceptanceExecutorCliCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
async function execute(parsed) {
  const paths = validatePrivateExecutorPaths({ parsed, repoRoot: root, io: fs })
  const stat = fs.statSync(paths['--approval'])
  if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) throw new Error('approval')
  const approvalBytes = fs.readFileSync(paths['--approval'])
  validateExecutionApproval({ parsed, bytes: approvalBytes })
  const git = command => execFileSync('git', command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  validateCleanExecutorHead({ parsed, gitState: {
    head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain', '--untracked-files=all']),
  } })
  if (LIVE_EXECUTOR_MISSING_ADAPTERS.length) {
    console.error(`LIVE_ACCEPTANCE_EXECUTOR_STOPPED reason=adapters_incomplete missing=${LIVE_EXECUTOR_MISSING_ADAPTERS.join(',')}; credentials and network were not loaded; journal/output were not created.`)
    process.exitCode = 2
  } else {
    throw new Error('executor_not_wired')
  }
  return process.exitCode ?? 0
}

try {
  process.exitCode = await routeExecutorCli({
    args: process.argv.slice(2),
    writeHelp: async () => {
      console.log(EXECUTOR_HELP)
      console.log('Current status: fail-closed CLI wiring only. Live execution remains disabled until every statically listed adapter is implemented and independently reviewed.')
    },
    runSelfTests: async () => {
      const result = spawnSync(process.execPath, [...process.execArgv, '--test', '--test-isolation=none',
        path.join(root, 'scripts/invitationRehearsal/liveAcceptanceExecutorSelfTest.mjs'),
        path.join(root, 'scripts/invitationRehearsal/liveAcceptanceExecutorCliSelfTest.mjs')], { stdio: 'inherit' })
      return result.status ?? 1
    },
    execute,
  })
} catch {
  console.error('LIVE_ACCEPTANCE_EXECUTOR_STOPPED reason=local_gate; expected exact --execute arguments, clean reviewed HEAD, unexpired exact-hash private approval, and new private journal/output paths. Credentials and network were not loaded; no mutation, email, browser action or cleanup was attempted.')
  process.exitCode = 2
}
