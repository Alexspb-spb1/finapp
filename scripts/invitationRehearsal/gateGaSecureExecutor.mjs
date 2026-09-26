#!/usr/bin/env node
// Hard, network-preceding gate wrapper around the REAL, UNMODIFIED
// liveAcceptanceExecutor.mjs flow. FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-
// EVIDENCE-BINDING, item 4. Everything below is byte-for-byte the same
// wiring as liveAcceptanceExecutor.mjs (same imports, same
// executeApprovedLiveRuntime, same routeExecutorCli, same
// buildStagingAdapters/buildEmulatorFirebaseHandles) with exactly one
// addition: two extra, required arguments (--functions-receipt,
// --expected-checker-source-head) and loadRuntime's returned runtime is
// wrapped with gateGaSecureExecutorCore.mjs's
// wrapRuntimeWithFunctionsEvidenceGate before being handed back — so the
// approval's functionsSha256 is re-verified against real evidence BEFORE
// runtime.run() is ever called, i.e. before any staging network/
// credential access is reachable at all. See
// gateGaSecureExecutorSelfTest.mjs for the full-production-wiring proof
// (zero network/fetch calls on a forged hash) and
// liveAcceptanceExecutor.mjs for the file this deliberately mirrors.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LIVE_EXECUTOR_MISSING_ADAPTERS } from './liveAcceptanceExecutorAdapters.mjs'
import { EXECUTOR_HELP, executeApprovedLiveRuntime, routeExecutorCli } from './liveAcceptanceExecutorCliCore.mjs'
import { wrapRuntimeWithFunctionsEvidenceGate } from './gateGaSecureExecutorCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const packageDir = path.dirname(fileURLToPath(import.meta.url))

function extractOwnArg(args, name) {
  const idx = args.indexOf(name)
  if (idx === -1 || idx + 1 >= args.length) return { rest: args, value: undefined }
  return { rest: [...args.slice(0, idx), ...args.slice(idx + 2)], value: args[idx + 1] }
}

async function execute(parsed, functionsReceiptPath, expectedCheckerSourceHead) {
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
      const realRuntime = createGateGaOrchestratedRuntime({
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
          const app = initializeApp({ projectId: 'demo-finapp' }, `gate-ga-secure-cli-${runTag}`)
          return { db: getFirestore(app), auth: getAuth(app), runTag }
        },
      })
      // The hard gate itself — see gateGaSecureExecutorCore.mjs. Reading
      // the receipt file is the only I/O added here; it happens before
      // realRuntime.run() is ever called, so it can never race with or
      // follow any network access.
      const stat = fs.lstatSync(functionsReceiptPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('functions_receipt_invalid')
      const functionsReceiptBytes = fs.readFileSync(functionsReceiptPath)
      return wrapRuntimeWithFunctionsEvidenceGate({ runtime: realRuntime, functionsReceiptBytes, expectedCheckerSourceHead })
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
  const rawArgs = process.argv.slice(2)
  const afterReceipt = extractOwnArg(rawArgs, '--functions-receipt')
  const afterCheckerHead = extractOwnArg(afterReceipt.rest, '--expected-checker-source-head')
  const standardArgs = afterCheckerHead.rest
  const functionsReceiptPath = afterReceipt.value
  const expectedCheckerSourceHead = afterCheckerHead.value
  if (standardArgs[0] === '--execute' && (!functionsReceiptPath || !expectedCheckerSourceHead)) throw new Error('missing_functions_evidence_gate_args')

  process.exitCode = await routeExecutorCli({
    args: standardArgs,
    writeHelp: async () => {
      console.log(EXECUTOR_HELP)
      console.log('gateGaSecureExecutor.mjs additionally REQUIRES, anywhere in the argument list: --functions-receipt <absolute-private-JSON, from gateGaDeploymentCheck13.mjs> --expected-checker-source-head <exact-40-hex>. Refuses, before any network/credential access, if the approval\'s functionsSha256 does not bind to that real receipt.')
    },
    runSelfTests: async () => {
      const result = spawnSync(process.execPath, [...process.execArgv, '--test', '--test-isolation=none',
        path.join(root, 'scripts/invitationRehearsal/gateGaSecureExecutorSelfTest.mjs')], { stdio: 'inherit' })
      return result.status ?? 1
    },
    execute: parsed => execute(parsed, functionsReceiptPath, expectedCheckerSourceHead),
  })
} catch {
  console.error('LIVE_ACCEPTANCE_EXECUTOR_STOPPED reason=local_gate; expected exact --execute arguments, clean reviewed HEAD, unexpired exact-hash private approval, a real bound --functions-receipt, and new private journal/output paths. Credentials and network were not loaded; no mutation, email, browser action or cleanup was attempted.')
  process.exitCode = 2
}
