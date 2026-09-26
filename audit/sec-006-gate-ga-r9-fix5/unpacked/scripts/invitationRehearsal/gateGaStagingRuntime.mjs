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
import { runGateGaOrchestrator } from './gateGaOrchestratorCore.mjs'
import { createGateGaEmulatorAdapters } from './gateGaEmulatorAdapters.mjs'
import { makeDurableEventJournal } from './gateGaDurableJournalCore.mjs'
import { ensurePrivateDirectoryAcl, verifyPrivateFileAcl } from './gateGaPrivateDirAclCore.mjs'

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

// R8: the actual journal content now lives in a crash-safe directory of
// one immutable file per event (gateGaDurableJournalCore.mjs) — a kill
// exactly mid-write can no longer leave a truncated final line that blocks
// an otherwise-healthy resume (see that module's header comment for why).
//
// The CLI's own `--journal` argument, and validatePrivateExecutorPaths's
// existence check on it (existing iff --resume true), are UNCHANGED — that
// is a reviewed security boundary this file does not touch. `--journal`
// still names a single FILE, which this file now uses purely as a small,
// atomically-created MARKER (never appended to again): its existence is
// exactly what --resume checks, and it also records where the real event
// directory lives, so a second process pointed at the same `--journal`
// path finds the same directory. The event directory itself is a sibling
// of that marker, inside the same ACL-locked claimedDir.
export function journalEventsDirFor(journalMarkerPath) {
  return `${journalMarkerPath}.events.d`
}

// Exported so real two-process crash-window tests (gateGaCrashWindowsCliTest.mjs)
// can set up process-1's journal with the EXACT SAME code the literal CLI's
// process-2 resume will read — the strongest possible proof that the two
// genuinely agree on the same on-disk journal format, not a hand-rolled
// approximation of it in the test.
// R9-followup: genuinely crash-atomic, not just exclusive-create — a kill
// exactly mid-write must never leave a truncated/partial file at
// `filePath` itself. `--out` IS validated not to exist before run() is
// ever called (validatePrivateExecutorPaths), so a plain `wx` directly to
// the final path was not unsafe for OVERWRITE, but it was unsafe for
// PARTIAL WRITE: a kill after openSync('wx') but before the write+fsync
// finished would leave exactly that partial content sitting at the real
// `--out` path, where the CLI's own caller (or the crash-window tests)
// would read it back as if it were complete. The fix is the SAME
// temp-file-then-atomic-rename pattern already proven throughout this
// codebase (gateGaEmailVerificationCore.mjs, gateGaRunManifestCore.mjs,
// gateGaDurableJournalCore.mjs): the temp file is exclusively created
// (`wx`) in the SAME directory as `filePath` (so the rename is a single
// filesystem operation, never a cross-volume copy), fully written,
// fsync'd, and reread-verified BEFORE the rename ever happens. A kill at
// any point before the rename leaves only a stray, ignorable `.tmp-*`
// file and `filePath` still absent; a kill during or after the rename
// either leaves the swap incomplete (POSIX/NTFS rename of a fully-written
// file is a single metadata operation, not a byte-by-byte copy — there is
// no partial-rename state) or fully complete. `filePath` therefore either
// does not exist, or contains the complete, valid JSON — never anything
// in between.
// Exported so gateGaStagingRuntimeOutputAtomicitySelfTest.mjs's real
// kill/fault test can call the EXACT function run() uses, with a custom
// `io` that freezes mid-write, rather than a hand-reimplemented
// approximation of it.
export function durableWriteJsonFile(filePath, value, io) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const fd = io.openSync(tmp, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) offset += io.writeSync(fd, bytes, offset, bytes.length - offset)
    io.fsyncSync(fd)
  } finally { io.closeSync(fd) }
  if (!io.readFileSync(tmp).equals(bytes)) { io.unlinkSync(tmp); blocked('out_reread_mismatch') }
  io.renameSync(tmp, filePath)
}

// Exported so real two-process crash-window tests (gateGaCrashWindowsCliTest.mjs)
// can set up process-1's journal with the EXACT SAME code the literal CLI's
// process-2 resume will read — the strongest possible proof that the two
// genuinely agree on the same on-disk journal format, not a hand-rolled
// approximation of it in the test.
export function makeDurableFileJournal(journalPath, io) {
  const eventsDir = journalEventsDirFor(journalPath)
  const journal = makeDurableEventJournal(eventsDir, { io, ensureAcl: ensurePrivateDirectoryAcl, verifyFileAcl: verifyPrivateFileAcl })
  if (!io.existsSync(journalPath)) {
    // Single atomic write, never touched again — the marker's only job is
    // to satisfy --resume's existence check and point at eventsDir.
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, eventsDir: path.basename(eventsDir) }, null, 2)}\n`, 'utf8')
    const fd = io.openSync(journalPath, 'wx', 0o600)
    try { io.writeSync(fd, bytes); io.fsyncSync(fd) } finally { io.closeSync(fd) }
    verifyPrivateFileAcl({ filePath: journalPath })
  }
  return journal
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
    async run({ parsed, paths, approval, recheckHead, resume = false, legacyCleanupApproved = false }) {
      await recheckHead()
      const integrity = verifyPackageIntegrity({ packageDir, io })
      if (!integrity.ok) blocked(`package_integrity:${JSON.stringify(integrity.mismatches)}`)
      await recheckHead()

      const profile = parsed['--profile']
      const claimedDir = path.dirname(paths['--journal'])
      // Lock down claimedDir BEFORE the journal (marker file + event
      // directory) is ever created inside it — the same "ACL before any
      // checkpoint/manifest/journal write" ordering the orchestrator's own
      // step 0.5 enforces, needed here too because the journal is set up
      // at this outer layer, before runGateGaOrchestrator is even called.
      ensurePrivateDirectoryAcl({ dir: claimedDir })
      const journal = makeDurableFileJournal(paths['--journal'], io)
      const readFile = async relativePath => io.readFileSync(path.join(packageDir, relativePath))
      const seamExpectedHashes = parseCodeSha256Sums(io.readFileSync(path.join(packageDir, 'CODE-SHA256SUMS.txt'), 'utf8'))

      // A resource-naming tag, independent of the orchestrator's own
      // claimed run-id (module B claims and journals that separately,
      // inside runGateGaOrchestrator) — only used here to build unique
      // Auth/Firestore identifiers for this process's adapters when it
      // creates NEW resources. Unused on a true resume (admin/company/
      // invite already exist and are reused from the run manifest), so a
      // fresh tag per process on resume is harmless.
      const resourceTag = `gaR9${Date.now().toString(36)}${randomTagSuffix()}`

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
        resume, legacyCleanupApproved,
      })
      await recheckHead()
      // R9: --out's parent directory is not necessarily claimedDir (a
      // reviewed approval's --out path is free to point anywhere inside
      // the repo-relative private-path validator's allowed root) — lock it
      // down independently, the same "ACL before any write" rule as
      // everywhere else, then write atomically (temp + wx + fsync +
      // reread-verify + rename, never a single in-place writeFileSync) and
      // verify the real file's ACL immediately after. POSIX mode bits
      // (0o600) are not enforced by Node on Windows — the directory ACL
      // plus this verify are the only real protection.
      const outDir = path.dirname(paths['--out'])
      ensurePrivateDirectoryAcl({ dir: outDir })
      durableWriteJsonFile(paths['--out'], result, io)
      verifyPrivateFileAcl({ filePath: paths['--out'] })
      return result
    },
  })
}
