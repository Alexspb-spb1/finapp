// gate-G-A crash-safe durable journal (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8).
//
// R7's journal was a single growing file, one JSON line appended per event
// (fs.appendFileSync). A kill exactly mid-write could leave a truncated
// final line, and the R7 reader treated ANY corrupt line — including that
// truncated last one — as full journal corruption, refusing resume/cleanup
// entirely even though every event before it was perfectly intact.
//
// R8 replaces this with one immutable file per event, using the same
// exclusive-create ('wx') + fsync + reread-verify + atomic-rename pattern
// already proven for checkpoints and the run manifest
// (gateGaEmailVerificationCore.mjs / gateGaRunManifestCore.mjs). A kill
// mid-write leaves only a stray '.tmp-*' file that never matches the final
// 'event-NNNNNNNN.json' naming pattern and is therefore simply ignored by
// the reader — never partially visible, never mistaken for a real event.
// This is a provable protocol, not a probabilistic one: recovery after a
// kill at ANY point during an event write is defined to reconstruct
// exactly the events that were fully, durably committed before the kill —
// nothing more, nothing less.
import fs from 'node:fs'
import path from 'node:path'

const blocked = reason => { throw new Error(`gate_ga_durable_journal_blocked:${reason ?? ''}`) }
const EVENT_FILE_RE = /^event-(\d{8})\.json$/

function eventFileName(seq) {
  if (!Number.isInteger(seq) || seq < 0) blocked('bad_seq')
  return `event-${String(seq).padStart(8, '0')}.json`
}

function durableWriteEventFile(dir, seq, entry, io) {
  const finalPath = path.join(dir, eventFileName(seq))
  const bytes = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8')
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  let fd
  try {
    fd = io.openSync(tmp, 'wx', 0o600)
    let written = 0
    while (written < bytes.length) written += io.writeSync(fd, bytes, written, bytes.length - written)
    io.fsyncSync(fd)
  } finally {
    if (fd !== undefined) io.closeSync(fd)
  }
  if (!io.readFileSync(tmp).equals(bytes)) { io.unlinkSync(tmp); blocked('reread_mismatch') }
  io.renameSync(tmp, finalPath)
  return finalPath
}

/** Reads every durably-committed event from `dir`, in seq order. Stray
 * '.tmp-*' files from an interrupted write are ignored by construction
 * (they never match the event-NNNNNNNN.json pattern). A real event file
 * whose CONTENT is corrupt (not just missing — actually present but
 * unparseable JSON, or a seq that doesn't match its own filename/position)
 * is still treated as genuine corruption and blocks resume — the exclusive
 * create + reread-verify + atomic-rename write path makes that outcome
 * possible only via external tampering or a filesystem-level fault, never
 * via an ordinary kill mid-write. */
export function readExistingDurableJournalEvents(dir, io = fs) {
  if (!io.existsSync(dir)) return []
  const files = io.readdirSync(dir).filter(f => EVENT_FILE_RE.test(f)).sort()
  const events = []
  for (let i = 0; i < files.length; i++) {
    const match = EVENT_FILE_RE.exec(files[i])
    const seqFromName = Number(match[1])
    let entry
    try { entry = JSON.parse(io.readFileSync(path.join(dir, files[i]), 'utf8')) } catch { blocked(`journal_event_corrupt:${files[i]}`) }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) blocked(`journal_event_corrupt:${files[i]}`)
    if (entry.seq !== seqFromName || entry.seq !== i) blocked(`journal_event_sequence_mismatch:${files[i]}`)
    if (typeof entry.status !== 'string' || !entry.status || typeof entry.at !== 'string' || !entry.at) blocked(`journal_event_corrupt:${files[i]}`)
    if (entry.details === null || typeof entry.details !== 'object' || Array.isArray(entry.details)) blocked(`journal_event_corrupt:${files[i]}`)
    events.push(entry)
  }
  return events
}

/** Creates (if missing) and locks down `dir`, replays any existing
 * durably-committed events (continuing seq numbering, never restarting at
 * 0 — the same resume contract as R7's file journal), and returns a
 * journal object with the same {events, append, serialize} shape used
 * throughout the orchestrator. `ensureAcl`/`verifyFileAcl` default to the
 * real Windows ACL guard; injectable only for tests that intentionally
 * exercise a non-Windows/no-op path. */
export function makeDurableEventJournal(dir, {
  io = fs,
  ensureAcl = () => {},
  verifyFileAcl = () => {},
} = {}) {
  if (typeof dir !== 'string' || dir.length === 0) blocked('bad_dir')
  if (!io.existsSync(dir)) io.mkdirSync(dir, { recursive: true })
  ensureAcl({ dir })
  const existingEvents = readExistingDurableJournalEvents(dir, io)
  const list = [...existingEvents]
  return {
    events: list,
    append(status, details) {
      const entry = { seq: list.length, status, at: new Date().toISOString(), details: structuredClone(details ?? {}) }
      const filePath = durableWriteEventFile(dir, entry.seq, entry, io)
      verifyFileAcl({ filePath })
      list.push(entry)
      return entry
    },
    serialize() { return `${list.map(e => JSON.stringify(e)).join('\n')}\n` },
  }
}
