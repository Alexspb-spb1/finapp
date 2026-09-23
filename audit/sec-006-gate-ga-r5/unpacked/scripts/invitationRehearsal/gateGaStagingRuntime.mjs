// The runtime loaded by liveAcceptanceExecutor.mjs's execute() path (both
// --profile staging and --profile emulator). This is the ONLY top-level
// runtime the CLI core is allowed to load — see
// gateGaStagingCliSelfTest.mjs's source-level seam test, which fails if
// liveAcceptanceExecutor.mjs ever again resolves directly to
// createConcreteLiveAcceptanceRuntime (the historical, plan-only runtime) as
// its top-level `run`.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { runGateGaOrchestrator, makeJournal } from './gateGaOrchestratorCore.mjs'
import { createGateGaEmulatorAdapters } from './gateGaEmulatorAdapters.mjs'

const blocked = reason => { throw new Error(`gate_ga_staging_runtime_blocked:${reason ?? ''}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const randomTagSuffix = () => randomBytes(6).toString('hex')

// CODE-SHA256SUMS.txt lives beside this file inside the unzipped, immutable
// package — never fetched, never regenerated at run time. Format: standard
// `sha256sum` output, `<hex>  <relative-path>` per line.
export function parseCodeSha256Sums(text) {
  if (typeof text !== 'string') blocked('sums_not_string')
  const lines = text.split('\n').map(line => line.trimEnd()).filter(Boolean)
  const map = {}
  for (const line of lines) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line)
    if (!match) blocked(`unparseable_sums_line:${line.slice(0, 40)}`)
    const [, hash, file] = match
    if (Object.hasOwn(map, file)) blocked('duplicate_sums_entry')
    map[file] = hash
  }
  if (Object.keys(map).length === 0) blocked('empty_sums')
  return Object.freeze(map)
}

/** Reads CODE-SHA256SUMS.txt from `dir` and verifies every listed
 * scripts/invitationRehearsal/*.mjs file against it — entirely local
 * filesystem I/O, no network, called before anything else in run(). */
export function verifyPackageIntegrity({ packageDir, io = fs }) {
  const sumsPath = path.join(packageDir, 'CODE-SHA256SUMS.txt')
  if (!io.existsSync(sumsPath)) blocked('missing_code_sha256sums')
  const expected = parseCodeSha256Sums(io.readFileSync(sumsPath, 'utf8'))
  const mismatches = []
  for (const [relativePath, expectedHash] of Object.entries(expected)) {
    const filePath = path.join(packageDir, relativePath)
    if (!io.existsSync(filePath)) { mismatches.push({ file: relativePath, reason: 'MISSING' }); continue }
    const actual = sha256(io.readFileSync(filePath))
    if (actual !== expectedHash) mismatches.push({ file: relativePath, reason: 'HASH_MISMATCH', expectedHash, actual })
  }
  if (mismatches.length) return Object.freeze({ ok: false, mismatches: Object.freeze(mismatches) })
  return Object.freeze({ ok: true, mismatches: Object.freeze([]), fileCount: Object.keys(expected).length })
}

function makeDurableFileJournal(journalPath, io) {
  const inMemory = makeJournal()
  return {
    events: inMemory.events,
    append(status, details) {
      const entry = inMemory.append(status, details)
      io.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`)
      return entry
    },
    serialize: inMemory.serialize,
  }
}

/**
 * profile === 'emulator': fully real, already-tested adapters
 * (createGateGaEmulatorAdapters) against the local Firestore+Auth+Functions
 * emulators — never staging/production.
 *
 * profile === 'staging': buildStagingAdapters must be supplied by the
 * caller (liveAcceptanceExecutor.mjs) — it is never constructed inside this
 * file with a hardcoded network client, so this module itself never dials
 * out. This keeps the "no network from a file that hasn't been reviewed for
 * that specific purpose" boundary exactly where the historical runtime drew
 * it (liveAcceptanceExecutorRuntime.mjs), while still making the emulator
 * path fully self-contained and independently testable.
 */
export function createGateGaOrchestratedRuntime({ repoRoot, packageDir, io = fs, buildStagingAdapters, buildEmulatorFirebaseHandles }) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) blocked('bad_repo_root')
  if (typeof packageDir !== 'string' || !path.isAbsolute(packageDir)) blocked('bad_package_dir')
  return Object.freeze({
    async run({ parsed, paths, approval, recheckHead }) {
      await recheckHead()
      const integrity = verifyPackageIntegrity({ packageDir, io })
      if (!integrity.ok) blocked(`package_integrity:${JSON.stringify(integrity.mismatches)}`)
      await recheckHead()

      const profile = parsed['--profile']
      const journal = makeDurableFileJournal(paths['--journal'], io)
      const claimedDir = path.dirname(paths['--journal'])
      const readFile = async relativePath => io.readFileSync(path.join(packageDir, relativePath))
      const seamExpectedHashes = parseCodeSha256Sums(io.readFileSync(path.join(packageDir, 'CODE-SHA256SUMS.txt'), 'utf8'))

      // A resource-naming tag, independent of the orchestrator's own
      // claimed run-id (module B claims and journals that separately,
      // inside runGateGaOrchestrator) — only used here to build unique
      // Auth/Firestore identifiers for this process's adapters.
      const resourceTag = `gaR4${Date.now().toString(36)}${randomTagSuffix()}`

      let adapters
      if (profile === 'emulator') {
        const handles = await buildEmulatorFirebaseHandles({ runTag: resourceTag })
        adapters = createGateGaEmulatorAdapters({
          functionsBaseUrl: 'http://127.0.0.1:5001/demo-finapp/us-central1',
          authEmulatorHost: '127.0.0.1:9099', db: handles.db, auth: handles.auth, runTag: handles.runTag ?? resourceTag,
        })
      } else if (profile === 'staging') {
        if (typeof buildStagingAdapters !== 'function') blocked('staging_adapters_not_supplied')
        adapters = await buildStagingAdapters({ repoRoot, approval, sourceHead: parsed['--expected-head'], recheckHead, runTag: resourceTag })
      } else {
        blocked('unknown_profile')
      }

      const result = await runGateGaOrchestrator({
        profile, project: parsed['--project'], seamExpectedHashes, readFile,
        recipient: parsed['--recipient'], ownerConfirmedRecipientSha256: parsed['--recipient-confirmed-sha256'],
        adapters, claimedDir, sourceHead: parsed['--expected-head'], journal,
      })
      await recheckHead()
      io.writeFileSync(paths['--out'], `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      return result
    },
  })
}
