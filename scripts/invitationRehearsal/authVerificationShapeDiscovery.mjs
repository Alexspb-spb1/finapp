#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runAuthVerificationShapeDiscovery } from './authVerificationShapeDiscoveryCore.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const git = arguments_ => execFileSync('git', arguments_, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

try {
  const result = await runAuthVerificationShapeDiscovery({
    args: process.argv.slice(2), repoRoot: root, io: fs,
    gitState: async () => ({ head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain', '--untracked-files=all']) }),
    loadRuntime: async () => {
      const adapters = await import('./liveAcceptanceExecutorAdapters.mjs')
      if (typeof adapters.createGuardedFirebaseToolsSessionLoader !== 'function' ||
          typeof adapters.discoverFirebaseAuthTemplateMetadata !== 'function') throw new Error('adapter_contract')
      const loader = adapters.createGuardedFirebaseToolsSessionLoader({ repoRoot: root })
      return Object.freeze({
        openSession: gates => loader.execute(gates),
        discover: session => adapters.discoverFirebaseAuthTemplateMetadata({ session }),
      })
    },
  })
  console.log(`AUTH_VERIFICATION_TEMPLATE_SHAPE_DISCOVERED receipt=${result.output}`)
} catch {
  console.error('AUTH_VERIFICATION_TEMPLATE_SHAPE_DISCOVERY_STOPPED: exact project/HEAD/new external path, guarded session, sanitized response or durable receipt check failed. No template body, headers, tokens or provider error were emitted.')
  process.exitCode = 2
}
