#!/usr/bin/env node
// Fail-closed CLI gate for the future SEC-006 Stage 8 live executor. Help,
// self-test and invalid arguments never load Firebase credentials or a browser.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LIVE_EXECUTOR_MISSING_ADAPTERS } from './liveAcceptanceExecutorAdapters.mjs'
import {
  EXECUTOR_HELP, executeApprovedLiveRuntime, routeExecutorCli,
} from './liveAcceptanceExecutorCliCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
async function execute(parsed) {
  const git = command => execFileSync('git', ['--no-replace-objects', ...command], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const outcome = await executeApprovedLiveRuntime({ parsed, repoRoot: root, io: fs, missingAdapters: LIVE_EXECUTOR_MISSING_ADAPTERS,
    gitState: async () => ({
    head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain', '--untracked-files=all']),
  }), loadRuntime: async () => {
      const module = await import('./liveAcceptanceExecutorRuntime.mjs')
      return module.createConcreteLiveAcceptanceRuntime({ repoRoot: root, io: fs })
    } })
  if (outcome.status === 'ADAPTERS_INCOMPLETE') {
    console.error(`LIVE_ACCEPTANCE_EXECUTOR_STOPPED reason=adapters_incomplete missing=${outcome.missing.join(',')}; credentials and network were not loaded; journal/output were not created.`)
  } else {
    console.log('LIVE_ACCEPTANCE_VERIFIED: private journal and sanitized output saved; cleanup remains deferred.')
  }
  return outcome.exitCode
}

try {
  process.exitCode = await routeExecutorCli({
    args: process.argv.slice(2),
    writeHelp: async () => {
      console.log(EXECUTOR_HELP)
      console.log('Current status: concrete fail-closed runtime implemented. Execution remains disabled while any explicit live-shape marker is listed and until an exact private approval is supplied.')
    },
    runSelfTests: async () => {
      const result = spawnSync(process.execPath, [...process.execArgv, '--test', '--test-isolation=none',
        path.join(root, 'scripts/invitationRehearsal/liveAcceptanceExecutorSelfTest.mjs'),
        path.join(root, 'scripts/invitationRehearsal/liveAcceptanceExecutorCliSelfTest.mjs'),
        path.join(root, 'scripts/invitationRehearsal/liveAcceptanceExecutorAdaptersSelfTest.mjs'),
        path.join(root, 'scripts/invitationRehearsal/liveAcceptanceExecutorOperationsSelfTest.mjs'),
        path.join(root, 'scripts/invitationRehearsal/liveAcceptanceExecutorRuntimeSelfTest.mjs'),
        path.join(root, 'scripts/invitationRehearsal/liveAcceptanceTokenLifecycleSelfTest.mjs'),
        path.join(root, 'scripts/invitationRehearsal/liveAcceptanceLoopbackSelfTest.mjs'),
        path.join(root, 'scripts/invitationRehearsal/liveAcceptancePlaywrightSelfTest.mjs')], { stdio: 'inherit' })
      return result.status ?? 1
    },
    execute,
  })
} catch {
  console.error('LIVE_ACCEPTANCE_EXECUTOR_STOPPED reason=local_gate; expected exact --execute arguments, clean reviewed HEAD, unexpired exact-hash private approval, and new private journal/output paths. Credentials and network were not loaded; no mutation, email, browser action or cleanup was attempted.')
  process.exitCode = 2
}
