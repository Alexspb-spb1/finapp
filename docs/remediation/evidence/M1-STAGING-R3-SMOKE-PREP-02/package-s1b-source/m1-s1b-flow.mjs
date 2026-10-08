// M1-STAGING-R3-SMOKE-PREP-02 (variant S1b) - the smoke-only flow:
//   readiness -> preflight (R3) -> seed -> ui -> api -> ui-r3 -> cleanup -> verify-clean
// for a staging project whose Rules are ALREADY the round-3 target. It has NO export, NO Rules/Functions/frontend deploy and NO Rules rollback branch.
// Conventions kept from the accepted R3/R4 orchestrator: every tool is a separate process with an argument array (no shell), the executor never repeats a
// smoke mode (no retry), the journal and the state are written before and after each step, intent-before-dispatch/fsync live inside the smoke tools, an
// unknown outcome is conservative (no automatic cleanup), and the first failed check is a SAFE_STOP.
// A staging execution needs a valid permit bound to these exact bytes (m1-s1b-permit.mjs). The rehearsal profile runs the SAME flow against the local
// emulators with no-network read stubs; it needs no permit and can reach no live system.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { S1B, namespaceProblems, targetProblems, loadBudget, budgetEnvValue, rulesMismatchReason, sha256Hex } from './m1-s1b-pins.mjs'
import { permitProblems } from './m1-s1b-permit.mjs'

export const EXIT = Object.freeze({ PASS: 0, SAFE_STOP: 2, INIT_REFUSED: 3 })
// Stop kinds after which the smoke tool's own gates may be asked to clean up (accepted policy: the manifest and the transport stay trustworthy).
export const AUTO_CLEANUP_KINDS = Object.freeze(['assertion', 'ui-flow'])
const FORBIDDEN_STAGING_ENV = /^(FIREBASE_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_OPTIONS)$|EMULATOR/i
const CI_RUN_ID = '36830077757'

class FlowStop extends Error { constructor(step, reason) { super(`${step}: ${reason}`); this.step = step; this.reason = reason } }

/** Pure. What may happen to the synthetic resources after a STOP? `stop` = last MODE_STOP of the failing mode ({kind, dispatch, reasonCode, reason}) or null (all modes passed). */
export function cleanupDecision({ seedAttempted, stop, ops, rulesProbeFailure }) {
  if (!seedAttempted) return { run: false, why: 'seed-not-attempted' }
  if (!ops.cleanup || !ops.cleanupExactLookup) return { run: false, why: 'cleanup-not-permitted' }
  if (stop === null) return { run: true, why: 'all-modes-passed' }
  if (rulesProbeFailure) return { run: false, why: 'rules-probe-failure-needs-a-decision' }
  if (AUTO_CLEANUP_KINDS.includes(stop.kind)) return { run: true, why: `stop-kind-${stop.kind}` }
  if (stop.kind === 'transport-not-dispatched' && stop.dispatch === 'not-dispatched' && ops.cleanupAfterProvenNonDispatch === true) return { run: true, why: 'proven-non-dispatch-permitted' }
  // transport with an unknown outcome, unexpected errors, integrity/guard/manifest stops, credentials, budget, an unreadable journal: no automatic cleanup,
  // no inventory, no retry, no replay - a separate classification and decision is required.
  return { run: false, why: 'manual-classification-required' }
}

/** Reads the run journal. Returns {events} or {unreadable:true}. A damaged line makes the whole journal untrusted. */
export function readRunJournal(runDir) {
  try {
    const lines = fs.readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean)
    return { events: lines.map(l => JSON.parse(l)) }
  } catch { return { unreadable: true } }
}
/** Number of events in the run journal BEFORE a tool invocation: a missing file is an empty baseline, a damaged one is untrusted (null). */
export function journalBaseline(runDir) {
  try { return fs.readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).length } catch (e) { return e?.code === 'ENOENT' ? 0 : null }
}
/** The outcome of ONE invocation of mode, read from the events appended since baseline and tied to the process exit code. Anything not exactly one MODE_START and one
 * matching MODE_STOP of this invocation (missing, stale, damaged, ambiguous, exit code mismatch) is untrusted: { verified: false, kind: <reason> }. */
export function invocationOutcome(runDir, baseline, mode, exitCode) {
  if (baseline === null) return { verified: false, kind: 'journal-untrusted' }
  const j = readRunJournal(runDir)
  if (j.unreadable) return { verified: false, kind: 'journal-unreadable' }
  if (j.events.length < baseline) return { verified: false, kind: 'journal-stale' }
  const fresh = j.events.slice(baseline)
  const starts = fresh.filter(e => e.event === 'MODE_START' && e.mode === mode)
  const stops = fresh.filter(e => e.event === 'MODE_STOP' && e.mode === mode)
  if (starts.length !== 1) return { verified: false, kind: 'journal-missing-or-stale' }
  if (stops.length !== 1 || fresh.some(e => e.event === 'MODE_PASS' && e.mode === mode)) return { verified: false, kind: 'journal-ambiguous' }
  const e = stops[0]
  if (e.exitCode !== exitCode) return { verified: false, kind: 'journal-exit-mismatch' }
  return { verified: true, kind: e.kind, dispatch: e.dispatch ?? null, reasonCode: e.reasonCode ?? null, reason: typeof e.reason === 'string' ? e.reason : '', deletesMayHaveBeenSent: e.deletesMayHaveBeenSent === true }
}
/** The ONLY non-zero cleanup/verify-clean outcome that may be followed by the read-only inventory: a verified assertion that deletes completed but synthetic resources remain. */
export function verifiedRemainder(o) { return o?.verified === true && o.kind === 'assertion' && /^verify-clean\.(documents-absent|auth-absent): /.test(o.reason) }
/** A verified refusal by the cleanup gates (exit 3, no deletes): a STOP with a recovery manifest, never followed by anything. */
export function verifiedRefusal(o, exitCode) { return exitCode === 3 && o?.verified === true && o.kind === 'cleanup-refused' && o.deletesMayHaveBeenSent === false }
export function lastStopOf(events, mode) {
  const e = events.filter(x => x.event === 'MODE_STOP' && x.mode === mode).at(-1)
  return e ? { kind: e.kind, dispatch: e.dispatch ?? null, reasonCode: e.reasonCode ?? null, reason: typeof e.reason === 'string' ? e.reason : '' } : null
}

function webConfigFacts(file) {
  const text = fs.readFileSync(file, 'utf8')
  const m = text.match(/^\s*VITE_FIREBASE_PROJECT_ID\s*=\s*(.*)\s*$/m)
  return { project: m ? m[1].replace(/^(['"])(.*)\1$/, '$2').trim() : null, text }
}
const safeSha = file => { try { return sha256Hex(fs.readFileSync(file)) } catch { return null } }

export function defaultExec(label, argv, { env, cwd }) {
  const r = spawnSync(process.execPath, argv, { env, cwd, stdio: 'inherit', windowsHide: true })
  return r.status ?? 1
}
export function defaultGit(repo) {
  const run = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return {
    head: run(['rev-parse', 'HEAD']), status: run(['status', '--porcelain', '--untracked-files=all']),
    functionsUnchanged: () => { try { execFileSync('git', ['diff', '--quiet', S1B.priorHead, S1B.head, '--', 'functions', 'firebase.json', 'firestore.indexes.json', '.firebaserc'], { cwd: repo, stdio: 'ignore' }); return true } catch { return false } }
  }
}

/**
 * cfg: { profile, pkg, repo, evDir, runDir, stagingDist, uiDist, webConfig?, permit?, scenario?, rehearsalOps?, env, exec?, git?, now? }
 * Returns { status: 'PASS'|'SAFE_STOP'|'INIT_REFUSED', exitCode, reason?, stop?, state? }.
 */
export function runFlow(cfg) {
  const { profile, pkg, repo, evDir, runDir } = cfg
  const exec = cfg.exec ?? defaultExec
  const now = cfg.now ?? (() => Date.now())
  const env = { ...cfg.env }
  const refuse = reason => ({ status: 'INIT_REFUSED', exitCode: EXIT.INIT_REFUSED, reason })

  // ===== INIT: everything that can be decided without running a tool or creating a directory
  if (!['staging', 'rehearsal'].includes(profile)) return refuse('unknown profile')
  const ns = namespaceProblems({ profile, evidenceDir: evDir, runDir, exists: p => fs.existsSync(p) })
  if (ns.length) return refuse(`namespace: ${ns[0]}`)
  let budgetInfo
  try { budgetInfo = loadBudget(path.join(pkg, 'operation-budget.json')) } catch { return refuse('operation budget unreadable') }
  if (budgetInfo.problems.length) return refuse(`operation budget: ${budgetInfo.problems[0]}`)
  const expectedFile = path.join(pkg, 'expected-state-r3.json')
  const codeSumsSha = safeSha(path.join(pkg, 'CODE-SHA256SUMS.txt'))
  let ops
  if (profile === 'staging') {
    if (Object.keys(env).some(k => /^M1_STUB_/.test(k))) return refuse('stub environment variables present')
    if (Object.entries(env).some(([k, v]) => v && FORBIDDEN_STAGING_ENV.test(k))) return refuse('forbidden environment for a staging execution')
    if (!cfg.webConfig || !path.isAbsolute(cfg.webConfig) || !fs.existsSync(cfg.webConfig)) return refuse('explicit absolute web config required')
    let wc
    try { wc = webConfigFacts(cfg.webConfig) } catch { return refuse('web config unreadable') }
    const tp = targetProblems({ profile, project: S1B.project, webConfigProject: wc.project, values: [wc.text, runDir, evDir, ...Object.values(env)] })
    if (tp.length) return refuse(`target: ${tp[0]}`)
    const facts = {
      codeSumsSha256: codeSumsSha, budgetSha256: budgetInfo.sha256, expectedStateSha256: safeSha(expectedFile),
      distManifestSha256: safeSha(path.join(pkg, 'dist-staging-manifest.txt')), evidenceName: path.basename(evDir), runName: path.basename(runDir)
    }
    const pp = permitProblems(cfg.permit, facts, now())
    if (pp.length) return refuse(`permit: ${pp[0]}`)
    ops = cfg.permit.operations
  } else {
    ops = cfg.rehearsalOps ?? { cleanup: true, cleanupExactLookup: true, cleanupAfterProvenNonDispatch: false }
    if (!cfg.scenario || !path.isAbsolute(cfg.scenario) || !fs.existsSync(cfg.scenario)) return refuse('rehearsal requires an absolute scenario file')
  }
  // ONE-USE CLAIM of the evidence namespace: an ATOMIC, non-recursive mkdir (EEXIST = another run got there first or the namespace is consumed) BEFORE the first journal
  // write, state write or tool call. The existence check above is only an early refusal; this is the claim. A partially claimed namespace stays consumed (never deleted
  // or reused). Only the PARENT is created recursively. cfg.claimMkdir lets a test play the competitor at exactly this point (never passed by the CLI).
  const claimMkdir = cfg.claimMkdir ?? fs.mkdirSync
  try { fs.mkdirSync(path.dirname(evDir), { recursive: true }) } catch { return refuse('could not create the parent of the evidence directory') }
  try { claimMkdir(evDir) } catch (e) { return refuse(e?.code === 'EEXIST' ? 'evidence namespace already claimed (lost the race or consumed): nothing was run' : 'could not claim the evidence directory') }
  try { fs.writeFileSync(path.join(evDir, 's1b-claim.json'), JSON.stringify({ task: S1B.taskId, profile, pid: process.pid, claimedAt: new Date().toISOString() }) + '\n', { flag: 'wx' }) } catch { return refuse('could not write the claim marker (the namespace stays consumed)') }

  // ===== journal / state
  const journalFile = path.join(evDir, 's1b-journal.jsonl')
  const journal = (event, data = {}) => fs.appendFileSync(journalFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`)
  const state = {
    task: S1B.taskId, variant: S1B.variant, profile, head: S1B.head, startedAt: new Date().toISOString(), completed: [], stop: null,
    pins: { budgetSha256: budgetInfo.sha256, codeSumsSha256: codeSumsSha },
    rulesR3Verified: false, rulesEvidenceSha256: null, functionsVerified: false, readiness: null, seedAttempted: false, smoke: {}, cleanup: null, final: null,
    // Operator (admin) reads of documents prove nothing about CLIENT access; only the ui/api/ui-r3 modes (client tokens and a real browser) do.
    clientAccess: { adminReadsAreClientAccess: false, uiPass: false, apiPass: false, uiR3Pass: false }
  }
  const save = () => { const tmp = path.join(evDir, 's1b-state.json.tmp'); fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, path.join(evDir, 's1b-state.json')) }
  const checkpoint = name => { state.completed.push(name); journal('CHECKPOINT', { name }); save() }
  const stopStage = (step, reason) => { state.stop = { step, reason }; journal('STOP', { step, reason }); save(); throw new FlowStop(step, reason) }
  const ev = n => path.join(evDir, n)
  let git
  try { git = (cfg.git ?? defaultGit)(repo) } catch { git = { head: null, status: 'unreadable', functionsUnchanged: () => false } }

  // ===== tool table: the only place where staging and rehearsal differ
  const p = f => path.join(pkg, f)
  const stubPre = ['--require', p('stubs/no-network.cjs')]
  const stubEnv = profile === 'rehearsal' ? { M1_STUB_SCENARIO: cfg.scenario, M1_STUB_STATE: ev('stub-state'), M1_STUB_NETWORK_LOG: ev('stub-state/network-attempts.jsonl') } : {}
  if (profile === 'rehearsal') fs.mkdirSync(ev('stub-state'), { recursive: true })
  const tool = (name, args) => {
    const local = { sums: p('m1-verify-sums.mjs'), webConfigCheck: p('check-web-config.mjs'), stateCheck: p('m1-state-check.mjs'), showAcl: p('show-run-acl.mjs') }
    if (local[name]) return { argv: [local[name], ...args], env: {} }
    if (profile === 'staging') {
      const real = { stagingResources: path.join(repo, 'scripts/invitationRehearsal/stagingResources.mjs'), functionsCheck: p('m1-functions-check.mjs'), readiness: p('m1-readiness.mjs'), smoke: p('m1-smoke.mjs'), ui: p('m1-ui-smoke.mjs'), uir3: p('m1-ui-smoke-r3.mjs'), ci: p('m1-ci-check.mjs') }
      return { argv: [real[name], ...args], env: {} }
    }
    if (name === 'stagingResources' || name === 'functionsCheck') return { argv: [...stubPre, p('stubs/stub-s1b-reads.mjs'), name, ...args], env: stubEnv }
    if (name === 'ci') return { argv: [p('m1-ci-check.mjs'), ...args], env: stubEnv }
    const real = { readiness: p('m1-readiness.mjs'), smoke: p('m1-smoke.mjs'), ui: p('m1-ui-smoke.mjs'), uir3: p('m1-ui-smoke-r3.mjs') }
    return { argv: [real[name], ...args], env: {} }
  }
  const runTool = (label, name, args, mode = null) => {
    const t = tool(name, args)
    const childEnv = { ...env, ...t.env }
    if (mode) childEnv.M1_S1B_BUDGET = budgetEnvValue(budgetInfo.budget, mode)
    journal('RUN', { label })
    const code = exec(label, t.argv, { env: childEnv, cwd: repo })
    journal('EXIT', { label, exitCode: code })
    return code
  }
  const smokeBase = () => (profile === 'staging'
    ? ['--target', 'staging', '--expected-head', S1B.head, '--run-dir', runDir, '--web-config', cfg.webConfig]
    : ['--target', 'emulator', '--expected-head', S1B.head, '--run-dir', runDir])
  const uiArgs = () => [...smokeBase(), '--dist', cfg.uiDist]
  const readinessArgs = () => (profile === 'staging'
    ? ['--target', 'staging', '--expected-head', S1B.head, '--out-dir', ev('readiness')]
    : ['--target', 'emulator', '--expected-head', S1B.head, '--out-dir', ev('readiness'), '--deadline-ms', '30000', '--interval-ms', '500', '--request-timeout-ms', '5000'])
  const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'))

  journal('START', { task: S1B.taskId, profile, variant: S1B.variant, evidence: path.basename(evDir), budgetSha256: budgetInfo.sha256, operations: ops })
  save()
  try {
    // ===== step 0 - local gates (+ one GitHub read for the CI run of the reviewed head)
    if (!/^v24\.16\./.test(cfg.nodeVersion ?? process.version)) stopStage('step0', 'root Node is not the pinned v24.16')
    if (git.head !== S1B.head || git.status) stopStage('step0', 'application repository HEAD or worktree')
    if (runTool('code-sums', 'sums', ['--sums', p('CODE-SHA256SUMS.txt'), '--root', pkg]) !== 0) stopStage('step0', 'package code hashes')
    if (runTool('dist-manifest', 'sums', ['--manifest', p('dist-staging-manifest.txt'), '--dist', cfg.stagingDist]) !== 0) stopStage('step0', 'staging build manifest')
    if (profile === 'staging' && runTool('web-config-marker', 'webConfigCheck', ['--web-config', cfg.webConfig, '--dist', cfg.stagingDist]) !== 0) stopStage('step0', 'web config marker')
    if (!git.functionsUnchanged()) stopStage('step0', 'Functions or Firebase config changed since the reviewed prior head')
    if (runTool('local-rules-check', 'stateCheck', ['--mode', 'local-rules', '--expected', expectedFile, '--repo', repo, '--out', ev('state-check-local-rules.json')]) !== 0) stopStage('step0', 'pinned Rules files')
    if (runTool('ci-check', 'ci', ['--profile', profile === 'staging' ? 'staging' : 'rehearsal', '--run-id', CI_RUN_ID, '--expected-head', S1B.head, '--out', ev('ci-check.json')]) !== 0) stopStage('step0', 'CI check')
    checkpoint('step0')

    // ===== step 1 - read-only exact state: the 13 Functions and the live Rules == the round-3 target (anything else, round 2 included, is a STOP before any mutation)
    if (runTool('functions-state', 'functionsCheck', ['--mode', 'exact', '--expected-head', S1B.head, '--expected', expectedFile, '--out', ev('functions-state.json')]) !== 0) stopStage('step1', 'functions state check')
    if (runTool('functions-state-check', 'stateCheck', ['--mode', 'functions', '--expected', expectedFile, '--evidence', ev('functions-state.json'), '--out', ev('state-check-functions.json')]) !== 0) stopStage('step1', 'functions state differs from the pinned state')
    state.functionsVerified = true; save()
    const rulesEv = ev('rules-state-r3.jsonl')
    const rx = runTool('rules-state', 'stagingResources', ['--mode', 'verify-current-rules', '--project', S1B.project, '--expected-head', S1B.head, '--expected-rules-hash', S1B.rulesTarget, '--out', rulesEv])
    if (rx !== 0) {
      let why = 'rules-state-unreadable'
      try { why = rulesMismatchReason(fs.readFileSync(rulesEv, 'utf8')) } catch { /* no evidence file: the read itself failed */ }
      stopStage('step1', `live Rules are not the round-3 target (${why})`)
    }
    if (runTool('rules-state-check', 'stateCheck', ['--mode', 'rules', '--expected', expectedFile, '--evidence', rulesEv, '--canonical', S1B.rulesTarget, '--out', ev('state-check-rules.json')]) !== 0) stopStage('step1', 'live Rules differ from the pinned round-3 target (rules-not-r3)')
    state.rulesR3Verified = true
    state.rulesEvidenceSha256 = safeSha(rulesEv) // the cleanup gate may use only THIS evidence, unchanged
    save()
    checkpoint('step1')

    // ===== step 2 - readiness: the five M1 callables answer from the application layer, before any Auth user exists
    const rd = runTool('readiness', 'readiness', readinessArgs())
    let rr = null
    try { rr = readJson(ev('readiness/readiness-result.json')) } catch { rr = null }
    const names = rr?.functions ? Object.keys(rr.functions).sort().join() : ''
    const readyOk = rd === 0 && rr?.status === 'READY' && rr.allReadyInSameRound === true && names === [...S1B.m1Callables].sort().join() &&
      Object.values(rr.functions).every(f => f.ready === true && Number(f.attempts) >= 1 && f.lastVerdict === 'ready')
    state.readiness = { toolExit: rd, status: rr?.status ?? 'NO_RESULT', verified: readyOk }; save()
    if (!readyOk) stopStage('step2', `readiness gate not satisfied (tool exit ${rd}): no seed, no Auth user`)
    checkpoint('step2')

    // ===== step 3 - smoke preflight and private run dir (after readiness, before seed)
    if (runTool('smoke-preflight', 'smoke', [...smokeBase(), '--mode', 'preflight'], 'preflight') !== 0) stopStage('step3', 'smoke preflight')
    if (!(cfg.aclCheck ?? defaultAclCheck)(pkg, runDir)) stopStage('step3', 'run dir ACL not verified')
    checkpoint('step3')

    // ===== step 4 - smoke (each mode once, never repeated); a failing mode ends the sequence
    state.seedAttempted = true; save()
    let lastStop = null, rulesProbeFailure = false
    for (const stage of ['seed', 'ui', 'api', 'ui-r3']) {
      const code = stage === 'ui' ? runTool('smoke-ui', 'ui', uiArgs(), 'ui') : stage === 'ui-r3' ? runTool('smoke-ui-r3', 'uir3', uiArgs(), 'ui-r3') : runTool(`smoke-${stage}`, 'smoke', [...smokeBase(), '--mode', stage], stage)
      state.smoke[stage] = { exit: code }
      if (code === 0) {
        if (stage === 'ui') state.clientAccess.uiPass = true
        if (stage === 'api') state.clientAccess.apiPass = true
        if (stage === 'ui-r3') state.clientAccess.uiR3Pass = true
        save(); continue
      }
      const j = readRunJournal(runDir)
      lastStop = j.unreadable ? { kind: 'journal-unreadable', dispatch: null, reasonCode: null, reason: '' } : (lastStopOf(j.events, stage) ?? { kind: 'unknown', dispatch: null, reasonCode: null, reason: '' })
      rulesProbeFailure = /^R[1-9]\./.test(lastStop.reason)
      state.smoke[stage] = { exit: code, stopKind: lastStop.kind, dispatch: lastStop.dispatch, reasonCode: lastStop.reasonCode, rulesProbeFailure }
      journal('SMOKE_CLASSIFIED', { mode: stage, exitCode: code, kind: lastStop.kind, dispatch: lastStop.dispatch, reasonCode: lastStop.reasonCode, rulesProbeFailure })
      save()
      break
    }

    // ===== step 5 - cleanup branch: only on an explicit, linked decision (see cleanupDecision); never after an unknown outcome
    const decision = cleanupDecision({ seedAttempted: state.seedAttempted, stop: lastStop, ops, rulesProbeFailure })
    state.cleanup = { decision: decision.why, run: decision.run, exitCode: null, branch: null, verifyCleanExit: null, inventoryExit: null }
    journal('CLEANUP_DECISION', { run: decision.run, why: decision.why }); save()
    if (decision.run) {
      // The Rules evidence handed to the gate must be the very file verified in step 1, byte for byte (linked evidence).
      if (safeSha(rulesEv) !== state.rulesEvidenceSha256 || state.rulesEvidenceSha256 === null) {
        state.cleanup.run = false; state.cleanup.branch = 'RULES_EVIDENCE_NOT_LINKED'
        stopStage('step5', 'the Rules evidence changed after step 1: no cleanup')
      }
      // Every non-zero cleanup / verify-clean is judged from ITS OWN MODE_STOP (this invocation's events only, tied to the exit code), never from the exit code alone.
      // Only a verified refusal (3) or a verified remainder (assertion verify-clean.*) is a known class; everything else - unknown transport outcome, credentials, budget,
      // integrity, unexpected, a missing/stale/damaged/ambiguous journal - is a SAFE_STOP with NO inventory, NO verify-clean, NO provider read, NO retry (manual classification).
      const classify = (mode, code, baseline) => {
        const o = invocationOutcome(runDir, baseline, mode, code)
        journal('INVOCATION_CLASSIFIED', { mode, exitCode: code, verified: o.verified, kind: o.kind, dispatch: o.dispatch ?? null, reasonCode: o.reasonCode ?? null })
        return o
      }
      const unsafe = (branch, o) => { state.cleanup.branch = branch; state.cleanup.manualClassificationRequired = true; state.cleanup.unsafeStop = { verified: o.verified, kind: o.kind, dispatch: o.dispatch ?? null } }
      const baseCleanup = journalBaseline(runDir)
      const cx = runTool('cleanup', 'smoke', [...smokeBase(), '--mode', 'cleanup', '--rules-status', 'verified-new', '--rules-evidence', rulesEv], 'cleanup')
      state.cleanup.exitCode = cx
      if (cx === 0) {
        const baseVerify = journalBaseline(runDir)
        state.cleanup.verifyCleanExit = runTool('verify-clean', 'smoke', [...smokeBase(), '--mode', 'verify-clean'], 'verify-clean')
        if (state.cleanup.verifyCleanExit === 0) state.cleanup.branch = 'CLEANUP_COMPLETE_VERIFIED'
        else {
          const o = classify('verify-clean', state.cleanup.verifyCleanExit, baseVerify)
          if (verifiedRemainder(o)) { state.cleanup.inventoryExit = runTool('inventory', 'smoke', [...smokeBase(), '--mode', 'inventory'], 'inventory'); state.cleanup.branch = 'VERIFY_CLEAN_REMAINDER' }
          else unsafe('VERIFY_CLEAN_UNSAFE_STOP', o)
        }
      } else {
        const o = classify('cleanup', cx, baseCleanup)
        if (verifiedRefusal(o, cx)) state.cleanup.branch = 'CLEANUP_REFUSED'
        else if (verifiedRemainder(o)) { state.cleanup.inventoryExit = runTool('inventory', 'smoke', [...smokeBase(), '--mode', 'inventory'], 'inventory'); state.cleanup.branch = 'CLEANUP_REMAINDER_VERIFIED' }
        else unsafe('CLEANUP_UNSAFE_STOP', o)
      }
      journal('CLEANUP_RESULT', state.cleanup); save()
      if (state.cleanup.branch === 'CLEANUP_COMPLETE_VERIFIED') checkpoint('step5')
    }
    if (lastStop) stopStage('step4', `smoke ${Object.keys(state.smoke).at(-1)} stopped (kind ${lastStop.kind}${lastStop.dispatch ? `, dispatch ${lastStop.dispatch}` : ''}); cleanup: ${decision.why}`)
    if (!state.cleanup.run) stopStage('step5', `smoke passed but cleanup did not run (${decision.why})`)
    if (state.cleanup.branch !== 'CLEANUP_COMPLETE_VERIFIED') stopStage('step5', state.cleanup.branch)

    // ===== step 6 - final read-only checks: the same Functions and the R3 Rules
    const ff = runTool('final-functions', 'functionsCheck', ['--mode', 'exact', '--expected-head', S1B.head, '--expected', expectedFile, '--out', ev('functions-state-final.json')])
    const ffc = ff === 0 ? runTool('final-functions-check', 'stateCheck', ['--mode', 'functions', '--expected', expectedFile, '--evidence', ev('functions-state-final.json'), '--out', ev('state-check-functions-final.json')]) : null
    const fr = runTool('final-rules', 'stagingResources', ['--mode', 'verify-current-rules', '--project', S1B.project, '--expected-head', S1B.head, '--expected-rules-hash', S1B.rulesTarget, '--out', ev('rules-state-final.jsonl')])
    const frc = fr === 0 ? runTool('final-rules-check', 'stateCheck', ['--mode', 'rules', '--expected', expectedFile, '--evidence', ev('rules-state-final.jsonl'), '--canonical', S1B.rulesTarget, '--out', ev('state-check-rules-final.json')]) : null
    state.final = { functionsExit: ff, functionsCheckExit: ffc, rulesExit: fr, rulesCheckExit: frc }; save()
    if (ff !== 0 || ffc !== 0 || fr !== 0 || frc !== 0) stopStage('step6', 'final read-only check')
    checkpoint('step6')
  } catch (e) {
    if (!(e instanceof FlowStop)) { state.stop = { step: 'unexpected', reason: 'unexpected flow error' }; journal('STOP', { step: 'unexpected', reason: state.stop.reason }); save() }
  }
  const status = state.stop ? 'SAFE_STOP' : 'PASS'
  state.finishedAt = new Date().toISOString()
  fs.writeFileSync(ev('s1b-result.json'), `${JSON.stringify({ status, task: S1B.taskId, variant: S1B.variant, profile, head: S1B.head, stop: state.stop, completed: state.completed, clientAccess: state.clientAccess, cleanup: state.cleanup, final: state.final, finishedAt: state.finishedAt }, null, 2)}\n`)
  journal('RESULT', { status })
  return { status, exitCode: state.stop ? EXIT.SAFE_STOP : EXIT.PASS, stop: state.stop, state }
}

/** The run directory must carry the protected ACL (verified by show-run-acl.mjs: no problems listed). Injectable for tests. */
export function defaultAclCheck(pkg, runDir) {
  const r = spawnSync(process.execPath, [path.join(pkg, 'show-run-acl.mjs'), runDir], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) return false
  try { const a = JSON.parse(r.stdout); return Array.isArray(a.dirProblems) && Array.isArray(a.fileProblems) && a.dirProblems.length === 0 && a.fileProblems.length === 0 } catch { return false }
}
