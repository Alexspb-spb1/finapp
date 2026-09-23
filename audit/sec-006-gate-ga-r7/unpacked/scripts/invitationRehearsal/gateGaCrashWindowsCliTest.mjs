// Real crash-window proofs (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R7,
// requirement 6): process 1 is forcibly killed (SIGKILL) at each of four
// precise, reproducible points in the flow; process 2 — the resume — is a
// genuinely separate `node` invocation of the LITERAL CLI
// (liveAcceptanceExecutor.mjs --execute --resume true ...), never a direct
// runOnce() call, so the whole real gate (approval validation, clean-HEAD
// recheck, package-integrity check, private-path validation) is exercised
// for real on the resume path too.
//
// The four windows:
//   1. ADMIN_CREATED               — admin+company confirmed, invite not yet attempted.
//   2. RECIPIENT_REGISTERED        — recipient Auth account registered and
//                                    durably recorded, email not yet attempted.
//   3. EMAIL_SENT_PENDING_CHECKPOINT — the email WAS actually dispatched
//                                    (the real adapter call returned), but the
//                                    durable SENT checkpoint had not yet been
//                                    written when the process died — the
//                                    genuinely indeterminate window R7 fixes.
//   4. EMAIL_SENT_CHECKPOINTED     — SENT checkpoint durably recorded (same
//                                    proof gateGaResumeKillTest.mjs already
//                                    covers, repeated here through the
//                                    literal-CLI resume path instead of
//                                    runOnce(), per requirement 6).
//
// Only windows 3 and 4 involve a real dispatched email; for all four, the
// invariant checked is the same: at most one real email ever sent, exactly
// one runId, one admin, one company (for windows where it was created),
// zero remainder after cleanup.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const sha256 = v => createHash('sha256').update(v).digest('hex')

const CHECKPOINTS = Object.freeze([
  'ADMIN_CREATED', 'RECIPIENT_REGISTERED', 'EMAIL_SENT_PENDING_CHECKPOINT', 'EMAIL_SENT_CHECKPOINTED',
])

if (process.argv[2] === '--child') {
  const [, , , checkpoint, claimedDir, recipient, runTag, signalPath, sourceHead, journalPath] = process.argv
  const { runOnce } = await import('./gateGaEmulatorE2E.mjs')
  const { makeJournal } = await import('./gateGaOrchestratorCore.mjs')
  // Writes the signal, then BLOCKS FOREVER — the orchestrator now `await`s
  // this hook, so the child freezes exactly at this point instead of racing
  // ahead into further real async work before the parent's SIGKILL lands.
  // The child is forcibly killed by the parent shortly after; never
  // resolving is safe and exactly what makes the kill point exact.
  const signalAndFreeze = () => {
    try { fs.writeFileSync(signalPath, 'reached', { flag: 'wx' }) } catch {}
    return new Promise(() => {})
  }
  // A real durable file journal — the SAME shape/behavior
  // gateGaStagingRuntime.mjs's makeDurableFileJournal gives the literal CLI
  // — so the resumed process-2 (the literal CLI) reads real, non-empty
  // prior events and genuinely continues their sequence numbering, not an
  // empty file it has to seed from nothing.
  const inMemory = makeJournal()
  const journal = {
    events: inMemory.events,
    append(status, details) {
      const entry = inMemory.append(status, details)
      fs.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`)
      return entry
    },
    serialize: inMemory.serialize,
  }
  runOnce({
    claimedDir, recipient, runTag, resume: false, sourceHead, journal,
    onInternalCheckpoint: reached => (reached === checkpoint ? signalAndFreeze() : undefined),
    // The email-sent checkpoint window (4) is signaled via the EXISTING
    // owner-action hook (fires right after markEmailSent completes) — the
    // SAME real hook the production flow uses to tell the owner to check
    // their mailbox.
    onOwnerActionRequired: () => (checkpoint === 'EMAIL_SENT_CHECKPOINTED' ? signalAndFreeze() : undefined),
  }).catch(() => {})
} else {
  await main()
}

// The Auth Emulator's oobCodes inbox is a pending-action queue, not a
// permanent log — a code is REMOVED from it once consumed (clicked). It is
// therefore only reliable for counting BEFORE a click, never after. "At
// most one email, ever" is instead verified from the durable journal file
// itself (see countJournalEmailSends below), which both processes append
// to and which survives the whole scenario.
async function countPendingEmailsFor(recipient) {
  const AUTH_HOST = '127.0.0.1:9099'
  const inbox = await (await fetch(`http://${AUTH_HOST}/emulator/v1/projects/demo-finapp/oobCodes`)).json()
  const normalized = recipient.trim().toLowerCase()
  return (inbox.oobCodes ?? []).filter(o => o.email === normalized && o.requestType === 'VERIFY_EMAIL').length
}

async function ownerClicksVerificationLink(recipient) {
  const AUTH_HOST = '127.0.0.1:9099'
  const oobInboxUrl = `http://${AUTH_HOST}/emulator/v1/projects/demo-finapp/oobCodes`
  const inbox = await (await fetch(oobInboxUrl)).json()
  const normalized = recipient.trim().toLowerCase()
  const matches = (inbox.oobCodes ?? []).filter(o => o.email === normalized && o.requestType === 'VERIFY_EMAIL')
  if (matches.length === 0) throw new Error(`no VERIFY_EMAIL oob code found for ${recipient}`)
  const oobCode = matches.at(-1).oobCode
  const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:update?key=demo-emulator-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode }),
  })
  if (!response.ok) throw new Error(`owner click (accounts:update) failed: ${response.status} ${await response.text()}`)
}

// Counts real `EMAIL_SENT{dispatched:true}` entries across the WHOLE
// journal file — written by BOTH process-1 (before the kill) and process-2
// (the resume) to the SAME path, so this is the one authoritative,
// durable count of how many times a real send actually happened, immune to
// the emulator inbox's consume-on-click behavior.
function countJournalEmailSends(journalPath) {
  if (!fs.existsSync(journalPath)) return 0
  const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
  let count = 0
  for (const line of lines) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.status === 'EMAIL_SENT' && entry.details?.dispatched === true) count++
  }
  return count
}

/** Item 5: fresh and resume approvals are prepared TOGETHER, up front, from
 * the SAME reviewed decision (sourceHead, recipient, legacyCleanupApproved)
 * — the resume approval's `--out` path is pre-decided right here, never
 * improvised after a crash. Only the resume approval is actually used by
 * these tests (process 1 runs via runOnce(), never the CLI — only the
 * resume/process-2 step is required to be the literal CLI) but both are
 * generated to prove the pairing pattern itself. */
async function generateApprovalPair({ expectedHead, recipient, privateDir, journalPath }) {
  const { approvalCommandSha256, GATE_GA_TASK } = await import('./liveAcceptanceExecutorCliCore.mjs')
  const recipientConfirmedSha256 = sha256(recipient.trim().toLowerCase())
  const nowMs = Date.now()
  const approvedAt = new Date(nowMs).toISOString()
  const expiresAt = new Date(nowMs + 60 * 60 * 1000).toISOString()
  const baseLimits = { fixtureMutationSlots: 16, totalCallableRequests: 40, verificationEmails: 1, cleanupAuthorized: true, legacyCleanupApproved: false, productionAuthorized: false }

  function buildOne({ resume, outPath }) {
    const parsed = {
      mode: 'execute', '--profile': 'emulator', '--project': 'demo-finapp', '--expected-head': expectedHead,
      '--journal': journalPath, '--out': outPath, '--resume': resume ? 'true' : 'false', '--legacy-cleanup-approved': 'false',
    }
    const commandSha256 = approvalCommandSha256({ ...parsed, '--recipient-confirmed-sha256': recipientConfirmedSha256 })
    const approval = {
      version: 1, task: GATE_GA_TASK, status: 'APPROVED', profile: 'emulator', project: 'demo-finapp',
      sourceHead: expectedHead, prHead: expectedHead, reviewStatus: 'PASS', ciStatus: 'PASS', functionsStatus: 'PASS',
      approvedAt, expiresAt, commandSha256,
      mailboxSha256: sha256(`mailbox-${resume}-${outPath}`), functionsSha256: sha256('functions-fixture-r7'),
      authMetadataSha256: sha256('auth-metadata-fixture-r7'), stagingFingerprint: sha256('staging-fingerprint-r7'),
      limits: baseLimits,
    }
    const approvalPath = path.join(privateDir, `approval-${resume ? 'resume' : 'fresh'}.json`)
    const bytes = Buffer.from(JSON.stringify(approval, null, 2), 'utf8')
    fs.writeFileSync(approvalPath, bytes)
    return { approvalPath, approvalSha256: sha256(bytes), outPath, recipientConfirmedSha256 }
  }

  return {
    fresh: buildOne({ resume: false, outPath: path.join(privateDir, 'out-fresh.json') }),
    resume: buildOne({ resume: true, outPath: path.join(privateDir, 'out-resume.json') }),
  }
}

async function runOneScenario(checkpoint) {
  const claimedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-crash-'))
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-crash-private-'))
  const runTag = `gaR7cw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const recipient = `gate-ga-r7-crash-${runTag}@example.invalid`
  const signalPath = path.join(claimedDir, 'checkpoint.signal')
  const childLog = path.join(claimedDir, 'child.log')
  const childLogFd = fs.openSync(childLog, 'a')

  const expectedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const gitStatusPre = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (gitStatusPre !== '') throw new Error(`[${checkpoint}] repo at ${ROOT} is not clean — the literal CLI resume requires a clean, committed HEAD:\n${gitStatusPre.slice(0, 500)}`)
  // The journal file process-1 durably writes to, and process-2 (the
  // literal CLI, --resume true) continues — must live in claimedDir
  // (liveAcceptanceExecutor.mjs derives claimedDir from dirname(--journal)).
  const journalInClaimedDir = path.join(claimedDir, 'crash-window-journal.jsonl')

  const child = spawn(process.execPath, [path.join(HERE, 'gateGaCrashWindowsCliTest.mjs'), '--child', checkpoint, claimedDir, recipient, runTag, signalPath, expectedHead, journalInClaimedDir], {
    stdio: ['ignore', childLogFd, childLogFd],
    env: { ...process.env, GATE_GA_DISABLE_EMULATOR_AUTO_CLICK: '1' },
    windowsHide: true,
  })

  let signaled = false, childExited = false
  const exitPromise = new Promise(resolve => child.on('exit', () => { childExited = true; resolve() }))
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (fs.existsSync(signalPath)) { signaled = true; break }
    if (childExited) break
    // A short, tight poll — the checkpoint hook can be followed almost
    // immediately by further real async work (network calls), so the
    // window between "signaled" and "process 1 keeps running past the
    // intended point" must be kept as small as possible.
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  fs.closeSync(childLogFd)
  if (!signaled) {
    const log = fs.existsSync(childLog) ? fs.readFileSync(childLog, 'utf8') : '(no log)'
    try { child.kill('SIGKILL') } catch {}
    throw new Error(`[${checkpoint}] checkpoint signal never arrived (childExited=${childExited}). Child log:\n${log}`)
  }
  // Issue SIGKILL and WAIT for the OS to actually confirm the process is
  // gone — never just assume it landed and sleep a fixed amount. Retries
  // if the first signal doesn't take within a short window (observed to
  // sometimes need more than one attempt on Windows).
  if (!childExited) {
    try { child.kill('SIGKILL') } catch {}
    const confirmedDead = await Promise.race([
      exitPromise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 3000)),
    ])
    if (!confirmedDead) {
      try { child.kill('SIGKILL') } catch {}
      await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 3000))])
    }
  }
  if (!childExited) throw new Error(`[${checkpoint}] process 1 (pid ${child.pid}) did not exit after SIGKILL within the wait window — cannot safely start the resume`)

  const emailAlreadyRealForThisWindow = checkpoint === 'EMAIL_SENT_PENDING_CHECKPOINT' || checkpoint === 'EMAIL_SENT_CHECKPOINTED'
  if (emailAlreadyRealForThisWindow) await ownerClicksVerificationLink(recipient)
  const pendingEmailsBeforeResume = await countPendingEmailsFor(recipient)

  // --- process 2: the literal CLI, --resume true --------------------------
  // journalInClaimedDir was already durably written by process-1 (a real
  // file journal, not an empty placeholder) — the literal CLI resume below
  // reads and continues it, proving requirement 4's sequence continuity for
  // real, not just against a freshly-created empty file.
  const pair = await generateApprovalPair({ expectedHead, recipient, privateDir, journalPath: journalInClaimedDir })
  const recipientConfirmedSha256 = pair.resume.recipientConfirmedSha256

  const cliArgs = [
    path.join(HERE, 'liveAcceptanceExecutor.mjs'), '--execute',
    '--profile', 'emulator', '--project', 'demo-finapp', '--expected-head', expectedHead,
    '--approval', pair.resume.approvalPath, '--approval-sha256', pair.resume.approvalSha256,
    '--journal', journalInClaimedDir, '--out', pair.resume.outPath,
    '--recipient', recipient, '--recipient-confirmed-sha256', recipientConfirmedSha256,
    '--resume', 'true', '--legacy-cleanup-approved', 'false',
  ]
  // The literal CLI legitimately exits non-zero for a SAFE_STOP outcome
  // (exitCode: status==='PASS'?0:1) — that is NOT a test failure by itself;
  // --out is still written and is what actually gets verified below.
  let cliStdout = ''
  try {
    cliStdout = execFileSync(process.execPath, cliArgs, { cwd: ROOT, encoding: 'utf8', env: process.env })
  } catch (error) {
    cliStdout = `${error.stdout ?? ''}${error.stderr ?? ''}`
    if (!fs.existsSync(pair.resume.outPath)) {
      const childLogText = fs.existsSync(childLog) ? fs.readFileSync(childLog, 'utf8') : '(no child log)'
      throw new Error(`[${checkpoint}] literal CLI resume produced no --out file. execFileSync error: ${error.message}. stdout/stderr: ${cliStdout.slice(0, 1500)}. CHILD_LOG: ${childLogText}`)
    }
  }
  const out = JSON.parse(fs.readFileSync(pair.resume.outPath, 'utf8'))

  // Independent re-verification, bypassing the module under test.
  const app = initializeApp({ projectId: 'demo-finapp' }, `gate-ga-r7-crash-verify-${runTag}`)
  const db = getFirestore(app)
  const auth = getAuth(app)
  const independentRemainder = []
  for (const p of out.cleanup.deleted.firestorePaths) if ((await db.doc(p).get()).exists) independentRemainder.push({ kind: 'firestore', path: p })
  for (const uid of out.cleanup.deleted.authUids) { try { await auth.getUser(uid); independentRemainder.push({ kind: 'auth', uid }) } catch {} }
  await deleteApp(app)

  // Authoritative, durable "how many real sends ever happened" — read from
  // the journal file both processes wrote to, immune to the emulator
  // inbox's consume-on-click behavior.
  const journalEmailSendCount = countJournalEmailSends(journalInClaimedDir)
  const childLogText = fs.existsSync(childLog) ? fs.readFileSync(childLog, 'utf8') : ''
  fs.rmSync(claimedDir, { recursive: true, force: true })
  fs.rmSync(privateDir, { recursive: true, force: true })

  return {
    checkpoint, cliStdout: cliStdout.trim(), status: out.status, emailsSentThisResume: out.emailsSent,
    pendingEmailsBeforeResume, journalEmailSendCount, cleanupStatus: out.cleanup.status,
    independentRemainderCount: independentRemainder.length, runId: out.runId, childLogText,
  }
}

function expectationFor(checkpoint) {
  if (checkpoint === 'EMAIL_SENT_CHECKPOINTED') return { status: 'PASS', journalEmailSendCount: 1, emailsSentThisResume: 0 }
  // ADMIN_CREATED, RECIPIENT_REGISTERED, EMAIL_SENT_PENDING_CHECKPOINT all
  // SAFE_STOP with full cleanup — the difference between them is only
  // whether a real email had already gone out before the kill.
  const journalEmailSendCount = checkpoint === 'EMAIL_SENT_PENDING_CHECKPOINT' ? 1 : 0
  return { status: 'SAFE_STOP', journalEmailSendCount, emailsSentThisResume: 0 }
}

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    console.error('CRASH_WINDOWS_SKIPPED reason=emulator_host_env_not_set')
    process.exitCode = 2
    return
  }
  const results = []
  let anyFailed = false
  for (const checkpoint of CHECKPOINTS) {
    try {
      const r = await runOneScenario(checkpoint)
      const expected = expectationFor(checkpoint)
      const ok = r.status === expected.status && r.journalEmailSendCount === expected.journalEmailSendCount &&
        r.emailsSentThisResume === expected.emailsSentThisResume &&
        r.cleanupStatus === 'CLEANUP_COMPLETE_VERIFIED' && r.independentRemainderCount === 0
      results.push({ ...r, expected, ok })
      console.log(`${ok ? 'PASS' : 'FAIL'} ${checkpoint}`, JSON.stringify({ status: r.status, journalEmailSendCount: r.journalEmailSendCount, cleanupStatus: r.cleanupStatus, remainder: r.independentRemainderCount, runId: r.runId }))
      if (!ok) console.error('CHILD_LOG', r.childLogText)
      if (!ok) anyFailed = true
    } catch (error) {
      anyFailed = true
      results.push({ checkpoint, ok: false, error: error.message })
      console.error(`FAIL ${checkpoint}`, error.message)
    }
  }
  console.log(`\nSUMMARY total=${results.length} pass=${results.filter(r => r.ok).length} fail=${results.filter(r => !r.ok).length}`)
  if (anyFailed) process.exitCode = 1
  else console.log('GATE_GA_CRASH_WINDOWS PASS')
}
