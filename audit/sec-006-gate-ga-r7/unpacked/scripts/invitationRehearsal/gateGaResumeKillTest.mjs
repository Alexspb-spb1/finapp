// Real two-process resume proof (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R7,
// requirement 9): process 1 is forcibly killed (SIGKILL — no graceful
// shutdown, no chance to run its own cleanup, nothing beyond what was
// already durably persisted to disk before the kill) the instant the email
// has been sent. Process 2 is a genuinely separate `node` invocation,
// started fresh with resume:true against the SAME claimedDir/recipient, and
// must: never register the recipient or send a second email, reach a real
// PASS, and independently re-verify zero remainder — proving one email, one
// runId, one admin, one company, one invitation, full cleanup.
//
// Signaling between the two OS processes is file-based (a sentinel file
// written the instant onOwnerActionRequired fires, polled by the parent)
// rather than IPC/stdio — deliberately the simplest, most debuggable
// mechanism available, since anything richer (fork() message-passing,
// inherited stdio) adds failure modes of its own that are irrelevant to
// what this test is actually proving.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

const HERE = path.dirname(fileURLToPath(import.meta.url))

if (process.argv[2] === '--child') {
  const [, , , claimedDir, recipient, runTag, signalPath] = process.argv
  const { runOnce } = await import('./gateGaEmulatorE2E.mjs')
  runOnce({
    claimedDir, recipient, runTag, resume: false,
    onOwnerActionRequired: () => { try { fs.writeFileSync(signalPath, 'sent', { flag: 'wx' }) } catch {} },
  }).catch(() => {})
} else {
  await main()
}

// The emulator adapter's own "simulate the owner clicking the link" runs on
// a setTimeout INSIDE the same process that sends the email — fine for the
// single-process E2E driver, but fundamentally incompatible with THIS test:
// killing the child the instant the email is sent also kills that pending
// timer, so the click would sometimes never happen (a real race, not a flake
// in the R6 code under test). GATE_GA_DISABLE_EMULATOR_AUTO_CLICK turns that
// in-process auto-click off for the child; the PARENT performs the "owner's
// click" itself afterward, directly against the Auth Emulator REST API —
// exactly like a real, independent owner action in a real, separate browser
// would, deterministically, not racing anything.
async function ownerClicksVerificationLink(recipient) {
  const AUTH_HOST = '127.0.0.1:9099'
  const oobInboxUrl = `http://${AUTH_HOST}/emulator/v1/projects/demo-finapp/oobCodes`
  const inbox = await (await fetch(oobInboxUrl)).json()
  // Firebase Auth lowercases stored emails — the oobCodes inbox reflects
  // that normalized form even if the caller signed up with mixed case.
  const normalized = recipient.trim().toLowerCase()
  const matches = (inbox.oobCodes ?? []).filter(o => o.email === normalized && o.requestType === 'VERIFY_EMAIL')
  if (matches.length === 0) throw new Error(`no VERIFY_EMAIL oob code found for ${recipient}`)
  const oobCode = matches.at(-1).oobCode
  const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:update?key=demo-emulator-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode }),
  })
  if (!response.ok) throw new Error(`owner click (accounts:update) failed: ${response.status} ${await response.text()}`)
}

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    console.error('RESUME_KILL_SKIPPED reason=emulator_host_env_not_set')
    process.exitCode = 2
    return
  }
  const claimedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-resume-kill-'))
  const runTag = `gaR6kill${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const recipient = `gate-ga-r6-resume-kill-${runTag}@example.invalid`
  const signalPath = path.join(claimedDir, 'email-sent.signal')
  const childLog = path.join(claimedDir, 'child.log')
  const childLogFd = fs.openSync(childLog, 'a')

  const child = spawn(process.execPath, [path.join(HERE, 'gateGaResumeKillTest.mjs'), '--child', claimedDir, recipient, runTag, signalPath], {
    stdio: ['ignore', childLogFd, childLogFd],
    env: { ...process.env, GATE_GA_DISABLE_EMULATOR_AUTO_CLICK: '1' },
    windowsHide: true,
  })

  const deadline = Date.now() + 30_000
  let signaled = false
  let childExited = false
  child.on('exit', () => { childExited = true })
  while (Date.now() < deadline) {
    if (fs.existsSync(signalPath)) { signaled = true; break }
    if (childExited) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  fs.closeSync(childLogFd)

  if (!signaled) {
    const log = fs.existsSync(childLog) ? fs.readFileSync(childLog, 'utf8') : '(no child log)'
    console.error('RESUME_KILL_FAILED reason=email_sent_signal_never_arrived', JSON.stringify({ childExited }))
    console.error('CHILD_LOG', log)
    try { child.kill('SIGKILL') } catch {}
    fs.rmSync(claimedDir, { recursive: true, force: true })
    process.exitCode = 1
    return
  }

  // The instant the signal file exists, the checkpoint write it followed
  // (markEmailSent, fsync'd) has already happened — kill NOW, before this
  // process gets anywhere near polling/accept/cleanup.
  child.kill('SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 500))

  // The owner's real action, performed here by the PARENT — deterministic,
  // never racing a dead process's own pending timer.
  await ownerClicksVerificationLink(recipient)

  const { runOnce } = await import('./gateGaEmulatorE2E.mjs')
  const app = initializeApp({ projectId: 'demo-finapp' }, `gate-ga-r6-resume-verify-${runTag}`)
  const db = getFirestore(app)
  const auth = getAuth(app)
  void db; void auth

  const { result, independentRemainder } = await runOnce({
    claimedDir, recipient, runTag: `${runTag}resume`, resume: true,
  })

  const adminUids = result.cleanup.deleted.authUids.filter(uid => uid.endsWith('-admin'))
  const companyPaths = result.cleanup.deleted.firestorePaths.filter(p => /^companies\/[^/]+$/.test(p))
  const invitationPaths = result.cleanup.deleted.firestorePaths.filter(p => /^invitations\//.test(p))

  await deleteApp(app)
  fs.rmSync(claimedDir, { recursive: true, force: true })

  const summary = {
    status: result.status, reason: result.reason, runId: result.runId, emailsSent: result.emailsSent,
    cleanupStatus: result.cleanup.status, adminCount: adminUids.length, companyCount: companyPaths.length,
    invitationCount: invitationPaths.length, independentRemainderCount: independentRemainder.length,
    journalHasRunResumed: result.journal.some(e => e.status === 'RUN_RESUMED'),
    journalHasAdminResumed: result.journal.some(e => e.status === 'ADMIN_AND_COMPANY_RESUMED'),
    journalHasInvitationResumed: result.journal.some(e => e.status === 'INVITATION_RESUMED'),
    journalHasEmailResumedFromCheckpoint: result.journal.some(e => e.status === 'EMAIL_RESUMED_FROM_CHECKPOINT'),
  }
  console.log('RESUME_KILL_RESULT', JSON.stringify(summary))

  const ok = result.status === 'PASS' && result.emailsSent === 0 && adminUids.length === 1 && companyPaths.length === 1 &&
    invitationPaths.length === 1 && independentRemainder.length === 0 &&
    summary.journalHasRunResumed && summary.journalHasAdminResumed && summary.journalHasInvitationResumed && summary.journalHasEmailResumedFromCheckpoint
  if (!ok) { console.error('RESUME_KILL_FAILED', JSON.stringify(summary)); console.error('FULL_JOURNAL', JSON.stringify(result.journal, null, 2)); process.exitCode = 1 }
  else console.log('GATE_GA_RESUME_KILL PASS')
}
