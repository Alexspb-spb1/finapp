import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

// The one known real run-id that actually reached finapp-staging on 2026-09-11
// (executor state / recovery manifest, package f9f82cf). Reusing it must be
// structurally impossible, not merely discouraged by procedure.
export const PRIOR_RUN_IDS = Object.freeze(['stage8-mtww3p0r-1ae5cb84b43c285e'])

const blocked = () => { throw new Error('run_id_guard_blocked') }
const RUN_ID_RE = /^[a-z][a-z0-9-]{7,39}$/
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function generateRunId(randomSource = randomBytes) {
  const bytes = randomSource(20)
  if (!Buffer.isBuffer(bytes) || bytes.length !== 20) blocked()
  const id = `gate-${bytes.toString('hex').slice(0, 30)}`
  if (!RUN_ID_RE.test(id) || id.length > 40 || PRIOR_RUN_IDS.includes(id)) blocked()
  return id
}

function listExistingNamesSync(dir) {
  try { return fs.readdirSync(dir) } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

// Refuses a run-id that (a) is a known prior run-id, (b) fails the shared
// safeRunId shape, or (c) already has ANY evidence/manifest/journal/claim
// file for it in the claim directory — this is the "existing manifest" and
// "existing namespace" collision guard, checked before anything external.
export function assertRunIdAllowed(runId, { claimedDir, extraForbidden = [] } = {}) {
  if (!RUN_ID_RE.test(runId)) blocked()
  if (typeof claimedDir !== 'string' || !path.isAbsolute(claimedDir)) blocked()
  const forbidden = new Set([...PRIOR_RUN_IDS, ...extraForbidden])
  if (forbidden.has(runId)) blocked()
  const names = listExistingNamesSync(claimedDir)
  if (names.some(name => name.includes(runId))) blocked()
  return true
}

// Writes a durable, exclusive (`wx`) claim marker for runId BEFORE any
// external (staging) creation is attempted. A second claim for the same
// run-id is refused by assertRunIdAllowed before this ever runs, and by the
// `wx` flag itself if called twice regardless.
export function claimRunId(runId, { claimedDir, project, sourceHead, now = () => new Date() } = {}) {
  assertRunIdAllowed(runId, { claimedDir })
  if (typeof project !== 'string' || !project) blocked()
  if (!/^[a-f0-9]{40}$/.test(sourceHead ?? '')) blocked()
  const at = now()
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) blocked()
  const claimedAt = at.toISOString()
  const payload = Object.freeze({ version: 1, runId, project, sourceHead, claimedAt })
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  const markerPath = path.join(claimedDir, `run-id-claim-${runId}.json`)
  let fd
  try {
    fd = fs.openSync(markerPath, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset)
      if (!Number.isSafeInteger(written) || written < 1 || written > bytes.length - offset) blocked()
      offset += written
    }
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  if (!fs.readFileSync(markerPath).equals(bytes)) blocked()
  if (process.platform !== 'win32' && (fs.statSync(markerPath).mode & 0o777) !== 0o600) blocked()
  return Object.freeze({ markerPath, claimedAt })
}

export function readClaim(markerPath) {
  if (typeof markerPath !== 'string' || !path.isAbsolute(markerPath)) blocked()
  const bytes = fs.readFileSync(markerPath)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { blocked() }
  if (!record(value) || value.version !== 1 || !RUN_ID_RE.test(value.runId ?? '')) blocked()
  return value
}
