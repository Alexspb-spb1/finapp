// gate-G-A durable run manifest (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8).
// The full-flow counterpart to gateGaEmailVerificationCore.mjs's email
// checkpoint: written BEFORE the first external (Auth/Firestore/callable)
// write of a run, so a killed/restarted process resumes the SAME run
// (same runId, same admin/company/invite identifiers, same ledger) instead
// of silently creating a second, orphaned set of resources. Every write is
// exclusive/CAS-style durable (`wx`/rewrite + fsync + reread-verify), same
// pattern as the run-id claim and the email checkpoint.
import fs from 'node:fs'
import path from 'node:path'

const blocked = reason => { throw new Error(`gate_ga_run_manifest_blocked:${reason ?? ''}`) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export const RUN_MANIFEST_VERSION = 1
// CLAIMED: written before any external write — admin/company not yet
//   confirmed created. ADMIN_CREATED: admin+company confirmed, invite not
//   yet confirmed. INVITED: admin+company+invite all confirmed — the rest of
//   the flow (recipient registration/email/verification/accept/replay) is
//   entirely driven by the separately-resumable email checkpoint from here.
export const RUN_PHASES = Object.freeze(['CLAIMED', 'ADMIN_CREATED', 'INVITED'])

export function runManifestPathFor({ claimedDir }) {
  if (typeof claimedDir !== 'string' || !path.isAbsolute(claimedDir)) blocked('bad_claimed_dir')
  return path.join(claimedDir, 'run-manifest.json')
}

// Exclusive create only (the first claim) — no overwrite risk, the target
// cannot already exist. R8: `verifyFileAcl` runs HERE, inside the helper
// itself, immediately after every create/replace lands — never left to a
// call site to remember. POSIX mode bits (0o600) are not enforced by Node
// on Windows; the directory ACL plus this per-file check are the only
// real protection.
function durableCreate(p, value, io, verifyFileAcl) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  let fd
  try {
    fd = io.openSync(p, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset)
      if (!Number.isSafeInteger(written) || written < 1) blocked('short_write')
      offset += written
    }
    io.fsyncSync(fd)
  } finally { if (fd !== undefined) io.closeSync(fd) }
  if (!io.readFileSync(p).equals(bytes)) blocked('reread_mismatch')
  verifyFileAcl({ filePath: p })
}

// Atomic replace for every subsequent update (R7): write the full new
// content to a fresh, exclusively-created temp sibling, fsync +
// reread-verify it, then rename it over the real path — a single filesystem
// operation, so a process killed at any point leaves either the ORIGINAL
// manifest fully intact or the swap fully complete, never a truncated or
// partially-written file. Replaces the historical `open(path, 'w')`
// in-place overwrite.
function durableReplace(p, value, io, verifyFileAcl) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let fd
  try {
    fd = io.openSync(tmp, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset)
      if (!Number.isSafeInteger(written) || written < 1) blocked('short_write')
      offset += written
    }
    io.fsyncSync(fd)
  } finally { if (fd !== undefined) io.closeSync(fd) }
  if (!io.readFileSync(tmp).equals(bytes)) { io.unlinkSync(tmp); blocked('reread_mismatch') }
  io.renameSync(tmp, p)
  verifyFileAcl({ filePath: p })
}

function validRunLedger(ledger) {
  return record(ledger) && typeof ledger.runId === 'string' && ledger.runId &&
    Array.isArray(ledger.createdAuthUids) && ledger.createdAuthUids.every(v => typeof v === 'string') &&
    Array.isArray(ledger.createdFirestorePaths) && ledger.createdFirestorePaths.every(v => typeof v === 'string') &&
    Array.isArray(ledger.casPaths) && typeof ledger.ownerMailboxUidCreated === 'boolean'
}

/** Returns null if no manifest exists (a genuinely fresh claimedDir); throws
 * (fail-closed) if a manifest exists but is not well-formed — a corrupted or
 * partially-written manifest must never be silently treated as absent, and
 * must never be resumed from. */
export function readRunManifest({ claimedDir, io = fs }) {
  const p = runManifestPathFor({ claimedDir })
  if (!io.existsSync(p)) return null
  let value
  try { value = JSON.parse(io.readFileSync(p, 'utf8')) } catch { blocked('run_manifest_corrupt') }
  if (!record(value) || value.version !== RUN_MANIFEST_VERSION || !RUN_PHASES.includes(value.phase) ||
      typeof value.runId !== 'string' || !value.runId ||
      typeof value.recipientSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.recipientSha256) ||
      !validRunLedger(value.ledger) ||
      (value.admin !== null && !record(value.admin)) || (value.invite !== null && !record(value.invite)) ||
      (value.phase !== 'CLAIMED' && value.admin === null) ||
      (value.phase === 'INVITED' && value.invite === null)) blocked('run_manifest_corrupt')
  return value
}

/** Called exactly once, right after the run-id claim succeeds and before any
 * external write. Refuses (never overwrites) if a manifest already exists at
 * this path — `claimedDir` is expected to be a brand-new private directory
 * per fresh run; an existing manifest there means either a genuine collision
 * or that the caller should have passed `resume:true` instead. */
export function claimRunManifest({ claimedDir, runId, project, profile, recipientSha256, sourceHead, now = () => new Date(), io = fs, verifyFileAcl = () => {} }) {
  if (io.existsSync(runManifestPathFor({ claimedDir }))) blocked('run_manifest_already_exists')
  const value = {
    version: RUN_MANIFEST_VERSION, runId, project, profile, recipientSha256, sourceHead,
    phase: 'CLAIMED', admin: null, invite: null,
    ledger: { runId, createdAuthUids: [], ownerMailboxUidCreated: false, createdFirestorePaths: [], casPaths: [] },
    createdAt: now().toISOString(), updatedAt: now().toISOString(),
  }
  durableCreate(runManifestPathFor({ claimedDir }), value, io, verifyFileAcl)
  return Object.freeze(structuredClone(value))
}

/** CAS-style update: `fromPhase` must match the manifest's current phase, or
 * this refuses — a phase this caller didn't itself observe (e.g. a stale
 * in-memory read racing another writer) can never be silently advanced
 * past. `patch` may set `phase`, `admin`, `invite`, and/or replace `ledger`
 * (always the FULL ledger object — callers pass the whole updated ledger,
 * not a partial merge, so a resumed reader always sees a complete, valid one). */
export function updateRunManifest({ claimedDir, fromPhase, patch, now = () => new Date(), io = fs, verifyFileAcl = () => {} }) {
  const existing = readRunManifest({ claimedDir, io })
  if (!existing) blocked('run_manifest_missing')
  if (existing.phase !== fromPhase) blocked('run_manifest_phase_mismatch')
  const value = { ...existing, ...patch, updatedAt: now().toISOString() }
  durableReplace(runManifestPathFor({ claimedDir }), value, io, verifyFileAcl)
  return Object.freeze(structuredClone(value))
}
