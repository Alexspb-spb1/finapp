#!/usr/bin/env node
// Fail-closed CLI gate for the SEC-006 Stage 8 gate-G-A live executor.
// Help, self-test and invalid arguments never load Firebase credentials or
// a browser. gate-G-A (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8): the ONLY
// runtime this file's execute() ever loads is
// createGateGaOrchestratedRuntime (gateGaStagingRuntime.mjs), which itself
// only ever calls runGateGaOrchestrator (gateGaOrchestratorCore.mjs) — the
// historical createConcreteLiveAcceptanceRuntime (plan-only cleanup) is
// never imported, referenced or reachable from this file. See
// liveAcceptanceExecutorCliSelfTest.mjs / gateGaStagingCliSelfTest.mjs for
// the source-level tests that fail if that ever regresses.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LIVE_EXECUTOR_MISSING_ADAPTERS } from './liveAcceptanceExecutorAdapters.mjs'
import {
  EXECUTOR_HELP, executeApprovedLiveRuntime, routeExecutorCli,
} from './liveAcceptanceExecutorCliCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const packageDir = path.dirname(fileURLToPath(import.meta.url))

async function execute(parsed) {
  const git = command => execFileSync('git', ['--no-replace-objects', ...command], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const outcome = await executeApprovedLiveRuntime({
    parsed, repoRoot: root, io: fs, missingAdapters: LIVE_EXECUTOR_MISSING_ADAPTERS,
    gitState: async () => ({
      head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain', '--untracked-files=all']),
    }),
    loadRuntime: async () => {
      const { createGateGaOrchestratedRuntime } = await import('./gateGaStagingRuntime.mjs')
      return createGateGaOrchestratedRuntime({
        repoRoot: root, packageDir, io: fs,
        buildStagingAdapters: async ({ runTag }) => {
          const { createGateGaStagingAdapters } = await import('./gateGaStagingAdapters.mjs')
          return createGateGaStagingAdapters({ repoRoot: root, io: fs, runTag })
        },
        buildEmulatorFirebaseHandles: async ({ runTag }) => {
          if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
            throw new Error('emulator_profile_requires_emulator_host_env')
          }
          const { initializeApp } = await import('firebase-admin/app')
          const { getFirestore } = await import('firebase-admin/firestore')
          const { getAuth } = await import('firebase-admin/auth')
          const app = initializeApp({ projectId: 'demo-finapp' }, `gate-ga-cli-${runTag}`)
          return { db: getFirestore(app), auth: getAuth(app), runTag }
        },
      })
    },
  })
  if (outcome.status === 'ADAPTERS_INCOMPLETE') {
    console.error(`LIVE_ACCEPTANCE_EXECUTOR_STOPPED reason=adapters_incomplete missing=${outcome.missing.join(',')}; credentials and network were not loaded; journal/output were not created.`)
  } else if (outcome.status === 'PASS') {
    console.log(`GATE_GA_ORCHESTRATED_PASS runId_present=${Boolean(outcome.orchestratorResult?.runId)}; current-run and (if applicable) legacy cleanup were verified; private journal and sanitized output saved.`)
  } else {
    console.log(`GATE_GA_ORCHESTRATED_SAFE_STOP reason=${outcome.orchestratorResult?.reason ?? outcome.orchestratorResult?.flowOutcome?.reason ?? 'unspecified'}; cleanup for the current run was attempted per the recorded state; private journal and sanitized output saved.`)
  }
  return outcome.exitCode
}

try {
  process.exitCode = await routeExecutorCli({
    args: process.argv.slice(2),
    writeHelp: async () => {
      console.log(EXECUTOR_HELP)
      console.log('Current status: gate-G-A orchestrated runtime (preflight -> run-id claim -> recipient guard -> legacy inventory -> readiness -> flow -> real cleanup/verify-clean -> legacy cleanup/verify-clean -> PASS/SAFE_STOP). Execution remains disabled until an exact, unexpired, gate-G-A-shaped private approval is supplied.')
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
        path.join(root, 'scripts/invitationRehearsal/liveAcceptancePlaywrightSelfTest.mjs'),
        path.join(root, 'scripts/invitationRehearsal/gateGaStagingCliSelfTest.mjs')], { stdio: 'inherit' })
      return result.status ?? 1
    },
    execute,
  })
} catch {
  console.error('LIVE_ACCEPTANCE_EXECUTOR_STOPPED reason=local_gate; expected exact --execute arguments, clean reviewed HEAD, unexpired exact-hash private approval, and new private journal/output paths. Credentials and network were not loaded; no mutation, email, browser action or cleanup was attempted.')
  process.exitCode = 2
}
