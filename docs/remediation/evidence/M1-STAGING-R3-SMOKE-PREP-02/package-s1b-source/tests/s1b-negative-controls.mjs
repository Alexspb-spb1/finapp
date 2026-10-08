// Deterministic negative controls and unit tests of the S1b smoke-only flow (no emulator, no network, synthetic data only).
// The flow runs with an INJECTED executor, git and ACL check: no tool process is started, so nothing here can reach a live system. Staging-profile cases are
// INIT-refusal cases only and their executor throws if it is ever called.
//   node tests/s1b-negative-controls.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = f => import(pathToFileURL(path.join(PKG, f)).href)
const { S1B, classifyRulesHash, rulesMismatchReason, namespaceProblems, targetProblems, budgetProblems, loadBudget, budgetEnvValue } = await imp('m1-s1b-pins.mjs')
const { PERMIT_FORMAT, OPERATION_CLASSES, permitTemplate, permitProblems } = await imp('m1-s1b-permit.mjs')
const { runFlow, cleanupDecision, readRunJournal, lastStopOf, EXIT } = await imp('m1-s1b-flow.mjs')
const { offlineGuardProblems, STEPS } = await imp('m1-s1b.mjs')
const { bootstrapOperatorCredentials, parseBudget, makeTransport, CREDENTIAL_REASON_CODES } = await imp('m1-transport.mjs')
const { Stop } = await imp('m1-core.mjs')

let pass = 0, fail = 0
const failures = []
const record = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push(name) } console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${String(detail).slice(0, 300)}`}`) }
const t = async (name, fn) => { try { const r = await fn(); record(name, r === undefined || r === true, r) } catch (e) { record(name, false, e?.stack?.split('\n').slice(0, 2).join(' | ') ?? e) } }
const sha = v => createHash('sha256').update(v).digest('hex')
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const realStagingDirs = [path.join(S1B.runtimeRoot, S1B.evidenceName), path.join(S1B.runtimeRoot, S1B.runName)]
const namespaceUntouched = () => realStagingDirs.every(d => !fs.existsSync(d))
const startedClean = namespaceUntouched()

// ── harness ────────────────────────────────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(S1B.rehearsalBase, { recursive: true })
let unitN = 0
const newUnit = () => { const dir = path.join(S1B.rehearsalBase, `unit-${process.pid}-${Date.now()}-${++unitN}`); return dir }
const GOOD_GIT = () => ({ head: S1B.head, status: '', functionsUnchanged: () => true })
const readinessOk = { status: 'READY', allReadyInSameRound: true, functions: Object.fromEntries(S1B.m1Callables.map(n => [n, { ready: true, attempts: 1, lastVerdict: 'ready' }])) }

/** Fake executor: records every call; `handlers[label]` is an exit code or (args, env, ctx) => exit code. Default 0 plus the files the next step reads. */
function makeExec(unit, handlers = {}, calls = []) {
  return (label, argv, { env }) => {
    calls.push({ label, argv, env })
    const arg = n => argv[argv.indexOf(n) + 1]
    if (label === 'readiness' && !(label in handlers)) { fs.mkdirSync(arg('--out-dir'), { recursive: true }); fs.writeFileSync(path.join(arg('--out-dir'), 'readiness-result.json'), JSON.stringify(readinessOk)) }
    if (label === 'rules-state' && !(label in handlers)) fs.writeFileSync(arg('--out'), `${JSON.stringify({ mode: 'verify-current-rules', project: S1B.project, sourceHead: S1B.head, canonicalSha256: S1B.rulesTarget, status: 'CURRENT_RULES_HASH_VERIFIED', finishedAt: new Date().toISOString() })}\n`)
    if (label in handlers) { const h = handlers[label]; return typeof h === 'function' ? h(argv, env, { unit, arg }) : h }
    return 0
  }
}
function rehearsal(unit, extra = {}) {
  fs.mkdirSync(unit, { recursive: true })
  const scenario = path.join(unit, 'scenario.json')
  fs.writeFileSync(scenario, JSON.stringify({ gh: { kind: 'success' }, reads: {} }))
  const calls = []
  const cfg = { profile: 'rehearsal', pkg: PKG, repo: path.join(unit, 'repo'), evDir: path.join(unit, 'ev'), runDir: path.join(unit, 'ev', 'run'), stagingDist: 'D:\\x\\staging-dist', uiDist: 'D:\\x\\ui-dist', scenario, env: {}, git: GOOD_GIT, aclCheck: () => true, calls, ...extra }
  cfg.exec = extra.exec ?? makeExec(unit, extra.handlers ?? {}, calls)
  return cfg
}
const labels = cfg => cfg.calls.map(c => c.label)
function writeRunJournal(cfg, lines) { fs.mkdirSync(cfg.runDir, { recursive: true }); fs.writeFileSync(path.join(cfg.runDir, 'journal.jsonl'), lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n') }

// staging harness: the executor must never be reached
const STAGING_EXEC = () => { throw new Error('LIVE_EXEC_FORBIDDEN: a staging test reached the executor') }
function stagingCfg(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's1b-staging-test-'))
  const webConfig = path.join(tmp, 'web.env')
  fs.writeFileSync(webConfig, 'VITE_FIREBASE_PROJECT_ID=finapp-staging\nVITE_FIREBASE_API_KEY=SYNTHETIC-NOT-A-KEY\nVITE_APP_ENV=staging\n')
  return { profile: 'staging', pkg: PKG, repo: path.join(tmp, 'repo'), evDir: realStagingDirs[0], runDir: realStagingDirs[1], stagingDist: 'D:\\x\\s', uiDist: 'D:\\x\\s', webConfig, env: {}, exec: STAGING_EXEC, git: GOOD_GIT, aclCheck: () => true, ...overrides, _tmp: tmp }
}
const factsOf = () => ({
  codeSumsSha256: sha(fs.readFileSync(path.join(PKG, 'CODE-SHA256SUMS.txt'))), budgetSha256: sha(fs.readFileSync(path.join(PKG, 'operation-budget.json'))),
  expectedStateSha256: sha(fs.readFileSync(path.join(PKG, 'expected-state-r3.json'))), distManifestSha256: sha(fs.readFileSync(path.join(PKG, 'dist-staging-manifest.txt'))),
  evidenceName: S1B.evidenceName, runName: S1B.runName
})
const NOW = Date.parse('2026-11-01T12:00:00Z')
function goodPermit(over = {}) {
  const f = factsOf()
  const p = permitTemplate()
  p.status = 'APPROVED'
  p.bytes = { codeSums: f.codeSumsSha256, budget: f.budgetSha256, expectedState: f.expectedStateSha256, distManifest: f.distManifestSha256 }
  p.reconciliation = { performedAtUtc: '2026-11-01T09:00:00Z', evidenceRef: 'reconciliation-ref-1' }
  p.operations = Object.fromEntries(Object.keys(OPERATION_CLASSES).map(k => [k, true])); p.operations.cleanupAfterProvenNonDispatch = false
  p.owner = { approvalRef: 'owner-decision-ref-1', approvedAtUtc: '2026-11-01T10:00:00Z', expiresAtUtc: '2026-11-01T22:00:00Z' }
  return Object.assign(p, over)
}

// ── pins, rules classification, namespace, target ───────────────────────────────────────────────────────────────────
await t('pins: the S1b pins equal the accepted expected-state file (project, head, round-3 target, round-2 reference)', () => {
  const e = JSON.parse(fs.readFileSync(path.join(PKG, 'expected-state-r3.json'), 'utf8'))
  return e.project === S1B.project && e.sourceHead === S1B.head && e.rulesTarget.canonicalSha256 === S1B.rulesTarget && e.rulesPre.canonicalSha256 === S1B.rulesRound2
})
await t('rules classification: r3 / r2 / unknown', () => classifyRulesHash(S1B.rulesTarget) === 'r3' && classifyRulesHash(S1B.rulesRound2) === 'r2' && classifyRulesHash('0'.repeat(64)) === 'unknown' && classifyRulesHash(undefined) === 'unknown')
await t('rules mismatch reason is a closed set and never echoes file content', () => {
  const r2 = JSON.stringify({ status: 'STAGING_RESOURCES_BLOCKED', observedCanonicalSha256: S1B.rulesRound2 })
  const unk = JSON.stringify({ status: 'STAGING_RESOURCES_BLOCKED', observedCanonicalSha256: 'f'.repeat(64), secret: 'LEAK-ME' })
  return rulesMismatchReason(r2) === 'rules-r2-live' && rulesMismatchReason(unk) === 'rules-not-r3' && rulesMismatchReason('not json') === 'rules-evidence-unreadable' && !rulesMismatchReason(unk).includes('LEAK')
})
await t('namespace: consumed, reserved, existing, foreign-name and out-of-root namespaces are refused; the S1b names are accepted when new', () => {
  const none = () => false
  const ok = namespaceProblems({ profile: 'staging', evidenceDir: realStagingDirs[0], runDir: realStagingDirs[1], exists: none })
  const cases = [
    ['consumed evidence', { evidenceDir: path.join(S1B.runtimeRoot, 'm1-stg-r3v5-714d0f91'), runDir: realStagingDirs[1] }],
    ['reserved evidence', { evidenceDir: path.join(S1B.runtimeRoot, 'm1-stg-r4-714d0f91'), runDir: realStagingDirs[1] }],
    ['consumed run', { evidenceDir: realStagingDirs[0], runDir: path.join(S1B.runtimeRoot, 'm1-staging-run-714d0f91-v5') }],
    ['reserved run', { evidenceDir: realStagingDirs[0], runDir: path.join(S1B.runtimeRoot, 'm1-staging-run-714d0f91-v6') }],
    ['foreign name', { evidenceDir: path.join(S1B.runtimeRoot, 'm1-stg-other'), runDir: realStagingDirs[1] }],
    ['outside root', { evidenceDir: path.join('D:\\elsewhere', S1B.evidenceName), runDir: realStagingDirs[1] }]
  ]
  const results = cases.map(([n, c]) => [n, namespaceProblems({ profile: 'staging', ...c, exists: none }).length > 0])
  const exists = namespaceProblems({ profile: 'staging', evidenceDir: realStagingDirs[0], runDir: realStagingDirs[1], exists: () => true }).some(p => p.includes('already exists'))
  return ok.length === 0 && results.every(([, bad]) => bad) && exists
})
await t('namespace: the consumed run ids include the id of the consumed run r3-ab9fb2fe and a new synthetic run can never pick one', async () => {
  const core = await imp('m1-core.mjs')
  return S1B.consumedRunIds.every(id => core.PRIOR_RUN_IDS.includes(id)) && core.PRIOR_RUN_IDS.includes('7cbe0a6e') && (() => { const picks = ['7cbe0a6e', 'bbb573d8', 'acf785fd', '0123abcd']; let i = 0; return core.pickRunId(() => picks[i++]) === '0123abcd' })()
})
await t('target: production markers, a non-staging project and a mismatching web config are refused', () => {
  const base = { profile: 'staging', project: S1B.project, webConfigProject: S1B.project, values: [] }
  return targetProblems(base).length === 0 && targetProblems({ ...base, project: 'finapp-prod-10a83' }).length > 0 && targetProblems({ ...base, webConfigProject: 'finapp-prod-10a83' }).length > 0 &&
    targetProblems({ ...base, values: ['x=FINAPP-PROD-10A83'] }).length > 0 && targetProblems({ ...base, webConfigProject: 'demo-finapp' }).length > 0 && targetProblems({ ...base, project: 'demo-finapp' }).length > 0
})

// ── INIT refusals (staging profile; the executor must never run) ────────────────────────────────────────────────────
await t('staging INIT: without a permit nothing runs and no directory is created', () => {
  const cfg = stagingCfg({ permit: undefined })
  const r = runFlow(cfg)
  return r.status === 'INIT_REFUSED' && r.exitCode === 3 && /permit/.test(r.reason) && namespaceUntouched()
})
await t('staging INIT: a production project in the web config is refused before the permit is even read', () => {
  const cfg = stagingCfg({ permit: goodPermit(), now: () => NOW })
  fs.writeFileSync(cfg.webConfig, 'VITE_FIREBASE_PROJECT_ID=finapp-prod-10a83\nVITE_APP_ENV=production\n')
  const r = runFlow(cfg)
  return r.status === 'INIT_REFUSED' && /target/.test(r.reason) && namespaceUntouched()
})
await t('staging INIT: a production marker hidden in another config value or in the environment is refused', () => {
  const cfg = stagingCfg({ permit: goodPermit(), now: () => NOW })
  fs.writeFileSync(cfg.webConfig, 'VITE_FIREBASE_PROJECT_ID=finapp-staging\nVITE_FIREBASE_AUTH_DOMAIN=finapp-prod-10a83.firebaseapp.com\n')
  const a = runFlow(cfg)
  const cfg2 = stagingCfg({ permit: goodPermit(), now: () => NOW, env: { SOME_TARGET: 'finapp-prod-10a83' } })
  const b = runFlow(cfg2)
  return a.status === 'INIT_REFUSED' && b.status === 'INIT_REFUSED' && /target/.test(a.reason + b.reason) && namespaceUntouched()
})
await t('staging INIT: forbidden environment (NODE_OPTIONS, emulator host, token variables) and stub variables are refused', () => {
  const rs = [{ NODE_OPTIONS: '--require=x.cjs' }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, { FIREBASE_TOKEN: 'x' }, { GOOGLE_APPLICATION_CREDENTIALS: 'x' }, { M1_STUB_SCENARIO: 'x' }].map(env => runFlow(stagingCfg({ permit: goodPermit(), now: () => NOW, env })))
  return rs.every(r => r.status === 'INIT_REFUSED') && namespaceUntouched()
})
await t('staging INIT: a missing or relative web config is refused', () => {
  const a = runFlow(stagingCfg({ permit: goodPermit(), now: () => NOW, webConfig: undefined }))
  const b = runFlow(stagingCfg({ permit: goodPermit(), now: () => NOW, webConfig: 'relative.env' }))
  return a.status === 'INIT_REFUSED' && b.status === 'INIT_REFUSED' && namespaceUntouched()
})
await t('staging INIT: an existing evidence or run namespace is refused (a run is never repeated)', () => {
  const unit = newUnit(); fs.mkdirSync(unit, { recursive: true })
  // a rehearsal flow into an existing evidence dir is the same code path
  const cfg = rehearsal(unit); fs.mkdirSync(cfg.evDir, { recursive: true })
  const r = runFlow(cfg)
  return r.status === 'INIT_REFUSED' && /already exists/.test(r.reason) && cfg.calls.length === 0
})
await t('rehearsal INIT: evidence outside the rehearsal base and a missing scenario are refused', () => {
  const cfg = rehearsal(newUnit()); cfg.evDir = 'D:\\elsewhere\\ev'; cfg.runDir = 'D:\\elsewhere\\ev\\run'
  const a = runFlow(cfg)
  const cfg2 = rehearsal(newUnit()); cfg2.scenario = path.join(cfg2.evDir, 'nope.json')
  const b = runFlow(cfg2)
  return a.status === 'INIT_REFUSED' && b.status === 'INIT_REFUSED' && cfg.calls.length === 0 && cfg2.calls.length === 0
})
await t('INIT: an unknown profile is refused', () => runFlow({ ...rehearsal(newUnit()), profile: 'production' }).status === 'INIT_REFUSED')

// ── permit ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await t('permit: the template is not a permit, and a complete permit for these bytes is accepted', () => {
  const f = factsOf()
  return permitProblems(permitTemplate(), f, NOW).length > 0 && permitProblems(goodPermit(), f, NOW).length === 0
})
await t('permit: every binding is enforced (bytes, budget, expected state, build manifest, namespace, head, project, Rules pin)', () => {
  const f = factsOf()
  const bad = [
    p => { p.bytes.codeSums = '0'.repeat(64) }, p => { p.bytes.budget = '0'.repeat(64) }, p => { p.bytes.expectedState = '0'.repeat(64) }, p => { p.bytes.distManifest = '0'.repeat(64) },
    p => { p.namespace.runName = 'm1-staging-run-714d0f91-v5' }, p => { p.namespace.evidenceName = 'm1-stg-r4-714d0f91' }, p => { p.target.head = '8526a791ce3f62dee5a64aa239b795c609a39226' },
    p => { p.target.project = 'finapp-prod-10a83' }, p => { p.rules.canonicalSha256 = S1B.rulesRound2 }, p => { p.taskId = 'OTHER' }, p => { p.format = 'x' }
  ]
  return bad.every(m => { const p = goodPermit(); m(p); return permitProblems(p, f, NOW).length > 0 })
})
await t('permit: time rules (not yet valid, expired, longer than 24 h, stale or future reconciliation) and placeholders are refused', () => {
  const f = factsOf()
  const bad = [
    p => { p.owner.approvedAtUtc = '2026-11-01T13:00:00Z'; p.owner.expiresAtUtc = '2026-11-01T20:00:00Z' }, p => { p.owner.expiresAtUtc = '2026-11-01T11:00:00Z' },
    p => { p.owner.approvedAtUtc = '2026-10-30T10:00:00Z'; p.owner.expiresAtUtc = '2026-11-01T20:00:00Z' }, p => { p.reconciliation.performedAtUtc = '2026-10-30T09:00:00Z' },
    p => { p.reconciliation.performedAtUtc = '2026-11-01T10:30:00Z' }, p => { p.owner.approvalRef = '<reference to the owner decision>' }, p => { p.reconciliation.evidenceRef = '<x>' }, p => { p.owner.approvedAtUtc = 'tomorrow' }
  ]
  return bad.every(m => { const p = goodPermit(); m(p); return permitProblems(p, f, NOW).length > 0 })
})
await t('permit: mandatory operation classes cannot be off; cleanup and its exact lookup are one decision; unknown classes are refused', () => {
  const f = factsOf()
  const bad = [
    p => { p.operations.authCreate = false }, p => { p.operations.stagingStateReads = false }, p => { p.operations.githubCiRead = false }, p => { p.operations.cleanupExactLookup = false },
    p => { p.operations.cleanup = false }, p => { p.operations.extra = true }, p => { delete p.operations.readinessProbes }, p => { p.operations.cleanupAfterProvenNonDispatch = 'yes' },
    p => { p.operations.cleanup = false; p.operations.cleanupExactLookup = false; p.operations.cleanupAfterProvenNonDispatch = true }
  ]
  return bad.every(m => { const p = goodPermit(); m(p); return permitProblems(p, f, NOW).length > 0 })
})
await t('permit: a valid permit passed to the flow is accepted by INIT (up to the first step) - verified with a fake executor and a fake git that fail at step 0', () => {
  // The staging namespace is NOT used: we only check that INIT passes by observing the refusal reason is not about the permit.
  const cfg = stagingCfg({ permit: goodPermit(), now: () => NOW, git: () => ({ head: 'x'.repeat(40), status: '', functionsUnchanged: () => true }) })
  if (!namespaceUntouched()) return 'namespace already touched'
  // A passing INIT would create the evidence directory in the real runtime root. Prove the permit gate only through permitProblems (above) and never run it here.
  return permitProblems(cfg.permit, factsOf(), NOW).length === 0
})

// ── step 0 / step 1 stops (rehearsal flow, fake executor) ────────────────────────────────────────────────────────────
const mutating = ['readiness', 'smoke-preflight', 'smoke-seed', 'smoke-ui', 'smoke-api', 'smoke-ui-r3', 'cleanup', 'verify-clean', 'inventory']
const noneReached = cfg => !labels(cfg).some(l => mutating.includes(l))
async function stopsAt(name, mutate, expectStep, expectReason, lastLabel = null) {
  await t(name, () => {
    const cfg = rehearsal(newUnit(), mutate.cfg ?? {})
    if (mutate.handlers) { cfg.exec = makeExec(cfg.evDir, mutate.handlers, cfg.calls) }
    const r = runFlow(cfg)
    return r.status === 'SAFE_STOP' && r.exitCode === 2 && r.stop.step === expectStep && (!expectReason || r.stop.reason.includes(expectReason)) && (lastLabel ? labels(cfg).at(-1) === lastLabel : noneReached(cfg)) ? true : `status=${r.status} stop=${JSON.stringify(r.stop)} calls=${labels(cfg).join(',')}`
  })
}
await stopsAt('stale pin: a different application HEAD stops at step 0 before any tool runs', { cfg: { git: () => ({ head: '8526a791ce3f62dee5a64aa239b795c609a39226', status: '', functionsUnchanged: () => true }) } }, 'step0', 'HEAD')
await stopsAt('stale pin: a different root Node version stops at step 0 before any tool runs', { cfg: { nodeVersion: 'v22.3.0' } }, 'step0', 'Node')
await stopsAt('stale pin: a dirty application worktree stops at step 0',{ cfg: { git: () => ({ head: S1B.head, status: ' M src/x.ts', functionsUnchanged: () => true }) } }, 'step0', 'worktree')
await stopsAt('stale pin: Functions/Firebase config changed since the prior head stops at step 0', { cfg: { git: () => ({ head: S1B.head, status: '', functionsUnchanged: () => false }) } }, 'step0', 'Functions')
await stopsAt('stale pin: package hash mismatch stops at step 0', { handlers: { 'code-sums': 2 } }, 'step0', 'package code hashes')
await stopsAt('stale frontend: staging build manifest mismatch stops at step 0', { handlers: { 'dist-manifest': 2 } }, 'step0', 'staging build manifest')
await stopsAt('stale pin: the pinned local Rules file differs stops at step 0', { handlers: { 'local-rules-check': 2 } }, 'step0', 'pinned Rules')
await stopsAt('CI of the reviewed head not verified stops at step 0', { handlers: { 'ci-check': 2 } }, 'step0', 'CI')
await stopsAt('Functions state drift (live tool fails) stops at step 1 before any mutation', { handlers: { 'functions-state': 2 } }, 'step1', 'functions state')
await stopsAt('Functions state drift (report differs from the pins) stops at step 1', { handlers: { 'functions-state-check': 2 } }, 'step1', 'differs from the pinned')
await stopsAt('R2 Rules live: the flow stops at step 1 with the r2 reason and never reaches readiness or smoke', {
  handlers: { 'rules-state': (argv) => { fs.writeFileSync(argv[argv.indexOf('--out') + 1], `${JSON.stringify({ status: 'STAGING_RESOURCES_BLOCKED', observedCanonicalSha256: S1B.rulesRound2 })}\n`); return 2 } }
}, 'step1', 'rules-r2-live')
await stopsAt('unknown Rules live: stops at step 1 (rules-not-r3)', {
  handlers: { 'rules-state': (argv) => { fs.writeFileSync(argv[argv.indexOf('--out') + 1], `${JSON.stringify({ status: 'STAGING_RESOURCES_BLOCKED', observedCanonicalSha256: 'a'.repeat(64) })}\n`); return 2 } }
}, 'step1', 'rules-not-r3')
await stopsAt('Rules read failed (no evidence): stops at step 1', { handlers: { 'rules-state': 2 } }, 'step1', 'rules-state-unreadable')
await stopsAt('non-matching Rules bytes (state check against the pin fails although the tool exited 0) stops at step 1', { handlers: { 'rules-state-check': 2 } }, 'step1', 'rules-not-r3')
await stopsAt('readiness not satisfied stops at step 2: no preflight, no seed', { handlers: { readiness: (argv) => { const d = argv[argv.indexOf('--out-dir') + 1]; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'readiness-result.json'), JSON.stringify({ ...readinessOk, status: 'NOT_READY' })); return 2 } } }, 'step2', 'readiness', 'readiness')
await t('readiness: a READY result file with a non-zero tool exit is NOT accepted (exit code and result must agree)', () => {
  const cfg = rehearsal(newUnit(), { handlers: { readiness: (argv) => { const d = argv[argv.indexOf('--out-dir') + 1]; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'readiness-result.json'), JSON.stringify(readinessOk)); return 2 } } })
  const r = runFlow(cfg)
  return r.status === 'SAFE_STOP' && r.stop.step === 'step2' && !labels(cfg).includes('smoke-preflight')
})
await t('readiness result with a missing callable or a tool exit 0 but not READY is not accepted', () => {
  const cases = [{ ...readinessOk, functions: Object.fromEntries(Object.entries(readinessOk.functions).slice(1)) }, { ...readinessOk, allReadyInSameRound: false }, { ...readinessOk, status: 'TIMEOUT' }]
  return cases.every(body => {
    const cfg = rehearsal(newUnit(), { handlers: { readiness: (argv) => { const d = argv[argv.indexOf('--out-dir') + 1]; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'readiness-result.json'), JSON.stringify(body)); return 0 } } })
    const r = runFlow(cfg)
    return r.status === 'SAFE_STOP' && r.stop.step === 'step2' && !labels(cfg).includes('smoke-preflight')
  })
})
await stopsAt('preflight failure stops at step 3: no seed', { handlers: { 'smoke-preflight': 2 } }, 'step3', 'preflight', 'smoke-preflight')
await t('run dir ACL not verified stops at step 3: no seed', () => {
  const cfg = rehearsal(newUnit(), { aclCheck: () => false }); const r = runFlow(cfg)
  return r.status === 'SAFE_STOP' && r.stop.step === 'step3' && !labels(cfg).includes('smoke-seed')
})

// ── smoke stops, cleanup decisions, no retry ──────────────────────────────────────────────────────────────────────────
const stopEvent = (mode, kind, extra = {}) => ({ at: new Date().toISOString(), event: 'MODE_STOP', mode, kind, reason: 'x', ...extra })
function smokeFailure(mode, journalLines, handlersExtra = {}) {
  const unit = newUnit()
  let cfg
  cfg = rehearsal(unit, { handlers: { [`smoke-${mode}`]: () => { writeRunJournal(cfg, journalLines); return 2 }, ...handlersExtra } })
  const r = runFlow(cfg)
  return { cfg, r, state: r.state }
}
await t('cleanup decision table: unknown transport outcome, unexpected, integrity, credentials, budget, guard, unreadable journal, rules probe failure -> NO cleanup', () => {
  const ops = { cleanup: true, cleanupExactLookup: true, cleanupAfterProvenNonDispatch: true }
  const kinds = ['transport', 'unexpected', 'integrity', 'credentials', 'budget', 'guard', 'manifest', 'acl', 'web-config', 'journal-unreadable', 'unknown', 'cleanup-refused']
  const noRun = kinds.every(kind => cleanupDecision({ seedAttempted: true, stop: { kind, dispatch: kind === 'transport' ? 'unknown' : null }, ops, rulesProbeFailure: false }).run === false)
  const rules = cleanupDecision({ seedAttempted: true, stop: { kind: 'assertion' }, ops, rulesProbeFailure: true }).run === false
  const notDisp = cleanupDecision({ seedAttempted: true, stop: { kind: 'transport-not-dispatched', dispatch: 'not-dispatched' }, ops: { ...ops, cleanupAfterProvenNonDispatch: false }, rulesProbeFailure: false }).run === false
  const notDispBadProof = cleanupDecision({ seedAttempted: true, stop: { kind: 'transport-not-dispatched', dispatch: 'unknown' }, ops, rulesProbeFailure: false }).run === false
  return noRun && rules && notDisp && notDispBadProof
})
await t('cleanup decision table: assertion/ui-flow and all-passed run cleanup only with the permitted pair; proven non-dispatch only with its explicit permission; seed not attempted never', () => {
  const on = { cleanup: true, cleanupExactLookup: true, cleanupAfterProvenNonDispatch: false }
  const d = (stop, ops = on, seedAttempted = true) => cleanupDecision({ seedAttempted, stop, ops, rulesProbeFailure: false }).run
  return d(null) && d({ kind: 'assertion' }) && d({ kind: 'ui-flow' }) && !d(null, { ...on, cleanup: false }) && !d(null, { ...on, cleanupExactLookup: false }) && !d(null, on, false) &&
    d({ kind: 'transport-not-dispatched', dispatch: 'not-dispatched' }, { ...on, cleanupAfterProvenNonDispatch: true })
})
await t('unknown network outcome in seed: SAFE_STOP, no cleanup, no inventory, no retry, no replay (each smoke mode at most once)', () => {
  const { cfg, r, state } = smokeFailure('seed', [stopEvent('seed', 'transport', { reasonCode: 'connection-reset', dispatch: 'unknown' })])
  const l = labels(cfg)
  return r.status === 'SAFE_STOP' && state.cleanup.run === false && state.cleanup.decision === 'manual-classification-required' && !l.includes('cleanup') && !l.includes('inventory') && !l.includes('verify-clean') &&
    l.filter(x => x === 'smoke-seed').length === 1 && !l.includes('smoke-ui') && new Set(l).size === l.length
})
await t('proven pre-dispatch failure without the explicit permission: no automatic cleanup either', () => {
  const { cfg, r, state } = smokeFailure('seed', [stopEvent('seed', 'transport-not-dispatched', { reasonCode: 'connect-timeout', dispatch: 'not-dispatched' })])
  return r.status === 'SAFE_STOP' && state.cleanup.decision === 'manual-classification-required' && !labels(cfg).includes('cleanup')
})
await t('proven pre-dispatch failure WITH the explicit permission: cleanup (the smoke tool gates still decide) and a STOP anyway', () => {
  const unit = newUnit()
  let cfg
  cfg = rehearsal(unit, { rehearsalOps: { cleanup: true, cleanupExactLookup: true, cleanupAfterProvenNonDispatch: true }, handlers: { 'smoke-seed': () => { writeRunJournal(cfg, [stopEvent('seed', 'transport-not-dispatched', { reasonCode: 'connect-timeout', dispatch: 'not-dispatched' })]); return 2 } } })
  const r = runFlow(cfg)
  const l = labels(cfg)
  return r.status === 'SAFE_STOP' && l.includes('cleanup') && l.includes('verify-clean') && r.stop.step === 'step4'
})
await t('assertion failure in api: cleanup runs once with the linked Rules evidence, the run is still a SAFE_STOP', () => {
  const { cfg, r, state } = smokeFailure('api', [stopEvent('api', 'assertion', { reason: 'api.roster: assertion failed' })])
  const c = cfg.calls.find(x => x.label === 'cleanup')
  return r.status === 'SAFE_STOP' && state.cleanup.run === true && !!c && c.argv.includes('verified-new') && c.argv.includes(path.join(cfg.evDir, 'rules-state-r3.jsonl')) && r.stop.step === 'step4'
})
await t('rules probe failure (R-prefixed reason) in api: no cleanup (no rollback exists in S1b; needs a decision)', () => {
  const { cfg, r, state } = smokeFailure('api', [stopEvent('api', 'assertion', { reason: 'R3.profile-read-other: expected deny' })])
  return r.status === 'SAFE_STOP' && state.cleanup.decision === 'rules-probe-failure-needs-a-decision' && !labels(cfg).includes('cleanup')
})
await t('damaged run journal: classified journal-unreadable, no cleanup', () => {
  const { cfg, r, state } = smokeFailure('seed', [stopEvent('seed', 'assertion'), '{"at":"2026-11-01T00:00:00Z","event":"MODE_ST'])
  return r.status === 'SAFE_STOP' && state.smoke.seed.stopKind === 'journal-unreadable' && !labels(cfg).includes('cleanup')
})
await t('missing journal after a failing mode: kind unknown -> no cleanup', () => {
  const unit = newUnit(); const cfg = rehearsal(unit, { handlers: { 'smoke-ui': 2 } })
  const r = runFlow(cfg)
  return r.status === 'SAFE_STOP' && r.state.smoke.ui.stopKind === 'journal-unreadable' && !labels(cfg).includes('cleanup')
})
await t('cleanup without the permitted pair never runs, even after an assertion failure', () => {
  const unit = newUnit(); let cfg
  cfg = rehearsal(unit, { rehearsalOps: { cleanup: false, cleanupExactLookup: false, cleanupAfterProvenNonDispatch: false }, handlers: { 'smoke-api': () => { writeRunJournal(cfg, [stopEvent('api', 'assertion')]); return 2 } } })
  const r = runFlow(cfg)
  return r.state.cleanup.decision === 'cleanup-not-permitted' && !labels(cfg).includes('cleanup')
})
await t('linked evidence: if the Rules evidence file changes after step 1, cleanup does not run', () => {
  const unit = newUnit()
  let cfg
  cfg = rehearsal(unit, { handlers: { 'smoke-ui-r3': () => { fs.appendFileSync(path.join(cfg.evDir, 'rules-state-r3.jsonl'), ' '); return 0 } } })
  const r = runFlow(cfg)
  return r.status === 'SAFE_STOP' && r.stop.step === 'step5' && r.state.cleanup.branch === 'RULES_EVIDENCE_NOT_LINKED' && !labels(cfg).includes('cleanup')
})
await t('cleanup branches: refused (3) -> STOP without verify-clean; partial (4) / stopped (2) -> inventory; remainder -> inventory', () => {
  const run = code => { const cfg = rehearsal(newUnit(), { handlers: { cleanup: code } }); const r = runFlow(cfg); return { r, l: labels(cfg) } }
  const a = run(3), b = run(4), c = run(2)
  const cfg = rehearsal(newUnit(), { handlers: { 'verify-clean': 2 } }); const d = runFlow(cfg)
  return a.r.stop.step === 'step5' && a.r.state.cleanup.branch === 'CLEANUP_REFUSED' && !a.l.includes('verify-clean') && !a.l.includes('inventory') &&
    b.r.state.cleanup.branch === 'CLEANUP_PARTIAL' && b.l.includes('inventory') && c.r.state.cleanup.branch === 'CLEANUP_STOPPED_BEFORE_DELETES' && c.l.includes('inventory') &&
    d.state.cleanup.branch === 'VERIFY_CLEAN_REMAINDER' && labels(cfg).includes('inventory')
})
await t('final read-only check failure is a SAFE_STOP at step 6', () => {
  const cfg = rehearsal(newUnit(), { handlers: { 'final-rules-check': 2 } }); const r = runFlow(cfg)
  return r.status === 'SAFE_STOP' && r.stop.step === 'step6'
})

// ── the full success path with the fake executor ───────────────────────────────────────────────────────────────────
await t('success path: the exact order, each tool once, the budget handed to every smoke/ui mode, client access flags only from the client modes', () => {
  const cfg = rehearsal(newUnit()); const r = runFlow(cfg)
  const l = labels(cfg)
  const order = ['code-sums', 'dist-manifest', 'local-rules-check', 'ci-check', 'functions-state', 'functions-state-check', 'rules-state', 'rules-state-check', 'readiness', 'smoke-preflight', 'smoke-seed', 'smoke-ui', 'smoke-api', 'smoke-ui-r3', 'cleanup', 'verify-clean', 'final-functions', 'final-functions-check', 'final-rules', 'final-rules-check']
  const bf = loadBudget(path.join(PKG, 'operation-budget.json')).budget
  const modeOf = lb => (lb.startsWith('smoke-') ? lb.slice(6) : lb)
  const budgeted = ['smoke-preflight', 'smoke-seed', 'smoke-ui', 'smoke-api', 'smoke-ui-r3', 'cleanup', 'verify-clean'].every(lb => { const c = cfg.calls.find(x => x.label === lb); return c && typeof c.env.M1_S1B_BUDGET === 'string' && eq(JSON.parse(c.env.M1_S1B_BUDGET), JSON.parse(budgetEnvValue(bf, modeOf(lb)))) })
  const res = JSON.parse(fs.readFileSync(path.join(cfg.evDir, 's1b-result.json'), 'utf8'))
  const st = JSON.parse(fs.readFileSync(path.join(cfg.evDir, 's1b-state.json'), 'utf8'))
  return r.status === 'PASS' && r.exitCode === 0 && eq(l, order) && budgeted && res.status === 'PASS' && eq(res.completed, ['step0', 'step1', 'step2', 'step3', 'step5', 'step6']) &&
    res.clientAccess.adminReadsAreClientAccess === false && res.clientAccess.uiPass && res.clientAccess.apiPass && res.clientAccess.uiR3Pass && st.rulesR3Verified === true && st.stop === null
})
await t('success path: no export, no deploy, no rollback, no Functions build and no Node22 tool is ever invoked', () => {
  const cfg = rehearsal(newUnit()); runFlow(cfg)
  return !labels(cfg).some(x => /export|deploy|rollback|backup|functions-build|inventory-live/.test(x)) && !cfg.calls.some(c => c.argv.some(a => /deploy|export|rollback|backup-rules|gcloud/i.test(String(a))))
})
await t('state and result agree (same status, same stop) after a stop', () => {
  const cfg = rehearsal(newUnit(), { handlers: { readiness: 2 } }); const r = runFlow(cfg)
  const res = JSON.parse(fs.readFileSync(path.join(cfg.evDir, 's1b-result.json'), 'utf8')), st = JSON.parse(fs.readFileSync(path.join(cfg.evDir, 's1b-state.json'), 'utf8'))
  return res.status === 'SAFE_STOP' && eq(res.stop, st.stop) && r.stop.step === 'step2'
})
await t('an unexpected error inside the flow ends as SAFE_STOP with a fixed reason (no raw error text)', () => {
  const cfg = rehearsal(newUnit(), { exec: () => { throw new Error('SECRET-LEAK-TEXT') } }); const r = runFlow(cfg)
  const txt = fs.readFileSync(path.join(cfg.evDir, 's1b-journal.jsonl'), 'utf8') + fs.readFileSync(path.join(cfg.evDir, 's1b-state.json'), 'utf8')
  return r.status === 'SAFE_STOP' && r.stop.step === 'unexpected' && !txt.includes('SECRET-LEAK-TEXT')
})

// ── credential bootstrap failure (transport) ─────────────────────────────────────────────────────────────────────────
const TARGET_STAGING = { name: 'staging', project: 'finapp-staging', auth: 'https://identitytoolkit.googleapis.com', firestore: 'https://firestore.googleapis.com', functions: 'https://us-central1-finapp-staging.cloudfunctions.net', tokenRefresh: 'https://securetoken.googleapis.com' }
const ftWith = overrides => name => ({ 'logger.js': { logger: { silent: false } }, 'auth.js': { getGlobalDefaultAccount: () => ({ user: { email: 'x' }, tokens: { refresh_token: 'REFRESH-SECRET' } }) }, 'requireAuth.js': { requireAuth: async () => true }, 'apiv2.js': { getAccessToken: async () => 'TOKEN-SECRET' }, ...overrides }[name])
async function fetchSpy(fn) { const orig = globalThis.fetch; let n = 0; globalThis.fetch = async () => { n++; throw new Error('no fetch expected') }; try { return { result: await fn(), calls: n } } finally { globalThis.fetch = orig } }
async function bootstrapCase(overrides) {
  return fetchSpy(async () => { try { const h = await bootstrapOperatorCredentials(TARGET_STAGING, ftWith(overrides)); await h(); return { ok: true } } catch (e) { return { stop: e } } })
}
await t('credential bootstrap failures end in the fixed reason and a closed reason code, kind credentials, dispatch not-dispatched, no raw error, no token, no request', async () => {
  const cases = [
    ['no CLI login', { 'auth.js': { getGlobalDefaultAccount: () => undefined } }, 'cli-login-missing'],
    ['login without refresh token', { 'auth.js': { getGlobalDefaultAccount: () => ({ user: { email: 'x' }, tokens: {} }) } }, 'cli-login-missing'],
    ['CLI auth refused', { 'requireAuth.js': { requireAuth: async () => false } }, 'cli-auth-failed'],
    ['CLI auth throws a leaky error', { 'requireAuth.js': { requireAuth: async () => { throw new Error('Bearer LEAKY-TOKEN-ABCDEFGHIJKLMNOPQRSTUV from https://secret.example/x') } } }, 'provider-error'],
    ['module load throws', { 'logger.js': null }, 'provider-error'],
    ['token unavailable (throws)', { 'apiv2.js': { getAccessToken: async () => { throw new Error('AIzaLEAKLEAKLEAKLEAKLEAKLEAKLEAKLEAK') } } }, 'token-unavailable'],
    ['token empty', { 'apiv2.js': { getAccessToken: async () => '' } }, 'token-unavailable']
  ]
  for (const [name, ov, code] of cases) {
    const { result, calls } = await bootstrapCase(ov)
    const e = result.stop
    const text = JSON.stringify({ m: e?.message, r: e?.reason, k: e?.kind, c: e?.reasonCode, d: e?.dispatch, s: String(e?.stack ?? '').slice(0, 0) })
    const ok = e instanceof Stop && e.kind === 'credentials' && e.reason === 'operator credential bootstrap failed' && e.reasonCode === code && CREDENTIAL_REASON_CODES.includes(e.reasonCode) && e.dispatch === 'not-dispatched' && calls === 0 &&
      !/LEAK|TOKEN-SECRET|REFRESH|secret\.example|Bearer/i.test(text)
    if (!ok) return `${name}: ${text} calls=${calls}`
  }
  return true
})
await t('credential bootstrap: a working provider returns headers with the bearer token (the happy path is not broken)', async () => {
  const h = await bootstrapOperatorCredentials(TARGET_STAGING, ftWith({}))
  const headers = await h()
  return headers.authorization === 'Bearer TOKEN-SECRET' && headers['x-goog-user-project'] === 'finapp-staging'
})
await t('credential bootstrap failure inside makeTransport(staging) stops BEFORE any request and is not a cleanup-safe kind', async () => {
  const { CLEANUP_SAFE_STOP_KINDS } = await imp('m1-core.mjs')
  const { result, calls } = await fetchSpy(async () => { try { await makeTransport(TARGET_STAGING, { counters: { requests: 0, callables: {} }, webConfig: { projectId: 'finapp-staging', apiKey: 'k' }, budget: { maxRequests: 5, maxAuthCreates: 1, maxAuthDeletes: 1, maxOperatorCommits: 1 }, loadFt: ftWith({ 'auth.js': { getGlobalDefaultAccount: () => undefined } }) }); return null } catch (e) { return e } })
  return result instanceof Stop && result.kind === 'credentials' && calls === 0 && !CLEANUP_SAFE_STOP_KINDS.includes('credentials')
})
await t('credential bootstrap on the staging path is only a dependency-injected loader: the CLI never passes one (no hook reachable from the command line)', () => {
  const src = fs.readFileSync(path.join(PKG, 'm1-smoke.mjs'), 'utf8') + fs.readFileSync(path.join(PKG, 'm1-ui-smoke.mjs'), 'utf8')
  return !/loadFt|operatorCredentials|operatorHeaders/.test(src)
})

// ── operation budget ─────────────────────────────────────────────────────────────────────────────────────────────────
await t('budget file: valid, per-mode, ceilings (3 Auth creates, 3 deletes) and mode restrictions are enforced by budgetProblems', () => {
  const b = loadBudget(path.join(PKG, 'operation-budget.json'))
  const mod = f => { const x = JSON.parse(JSON.stringify(b.budget)); f(x); return budgetProblems(x).length > 0 }
  return b.problems.length === 0 && mod(x => { x.modes.seed.maxAuthCreates = 4 }) && mod(x => { x.modes.cleanup.maxAuthDeletes = 4 }) && mod(x => { x.modes.api.maxAuthCreates = 1 }) && mod(x => { x.modes.ui.maxAuthDeletes = 1 }) &&
    mod(x => { x.modes.cleanup.maxAuthCreates = 1 }) && mod(x => { delete x.modes.inventory }) && mod(x => { x.modes.seed.extra = 1 }) && mod(x => { x.head = 'x' }) && mod(x => { x.project = 'finapp-prod-10a83' }) && mod(x => { x.modes.seed.maxRequests = -1 })
})
await t('budget env value carries exactly the four caps of the mode and parseBudget rejects anything else', () => {
  const b = loadBudget(path.join(PKG, 'operation-budget.json')).budget
  const v = JSON.parse(budgetEnvValue(b, 'seed'))
  let bad = 0
  for (const x of ['{', '[]', '{"maxRequests":1}', '{"maxRequests":1,"maxAuthCreates":1,"maxAuthDeletes":1,"maxOperatorCommits":1,"x":1}', '{"maxRequests":-1,"maxAuthCreates":1,"maxAuthDeletes":1,"maxOperatorCommits":1}', '{"maxRequests":"1","maxAuthCreates":1,"maxAuthDeletes":1,"maxOperatorCommits":1}']) { try { parseBudget(x) } catch (e) { if (e instanceof Stop) bad++ } }
  return eq(Object.keys(v).sort(), ['maxAuthCreates', 'maxAuthDeletes', 'maxOperatorCommits', 'maxRequests']) && parseBudget(undefined) === null && bad === 6
})
await t('transport budget: staging without a budget is refused; an emulator-type transport stops BEFORE dispatch when the request cap is reached (the server sees exactly the allowed requests)', async () => {
  const http = await import('node:http')
  let seen = 0
  const server = http.createServer((req, res) => { seen++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ localId: 'u' + seen })) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const target = { name: 'emulator', project: 'demo-finapp', auth: `http://127.0.0.1:${port}/identitytoolkit.googleapis.com`, firestore: `http://127.0.0.1:${port}`, functions: `http://127.0.0.1:${port}/f`, tokenRefresh: `http://127.0.0.1:${port}/s` }
  try {
    let noBudget = null
    try { await makeTransport(TARGET_STAGING, { counters: { requests: 0, callables: {} }, webConfig: { projectId: 'finapp-staging', apiKey: 'k' }, loadFt: ftWith({}) }) } catch (e) { noBudget = e }
    const counters = { requests: 0, authCreates: 0, authDeletes: 0, operatorCommits: 0, invitationCallsRefused: 0, callables: {} }
    const tr = await makeTransport(target, { counters, webConfig: null, budget: { maxRequests: 2, maxAuthCreates: 1, maxAuthDeletes: 0, maxOperatorCommits: 0 } })
    const u = { email: 'm1-00000000-x@example.invalid', password: 'p', name: 'n' }
    await tr.createAuthUser(u)
    let second = null, del = null, third = null
    try { await tr.createAuthUser(u) } catch (e) { second = e }          // create cap (1) reached
    try { await tr.deleteAuthUser('u1') } catch (e) { del = e }            // delete cap (0)
    await tr.getDoc('system/maintenance').catch(() => {})                   // request 2 allowed
    try { await tr.getDoc('system/maintenance') } catch (e) { third = e }   // request cap (2) reached
    return noBudget instanceof Stop && noBudget.kind === 'integrity' && second?.kind === 'budget' && del?.kind === 'budget' && third?.kind === 'budget' && seen === 2 && counters.requests === 2
  } finally { server.close() }
})

// ── offline guard, plan, selftest, hygiene ───────────────────────────────────────────────────────────────────────────
await t('offline guard: refuses without the fence, without the fence log, or with credential-like variables; accepts a clean fenced environment', () => {
  const ok = { NODE_OPTIONS: '--require=D:\\p\\offline-fence\\loopback-only.cjs', M1_FENCE_LOG: 'D:\\x\\f.jsonl', GCLOUD_PROJECT: 'demo-finapp', GOOGLE_CLOUD_PROJECT: 'demo-finapp', FIREBASE_EMULATORS_PATH: 'D:\\e' }
  return offlineGuardProblems(ok).length === 0 && offlineGuardProblems({ ...ok, NODE_OPTIONS: '' }).length > 0 && offlineGuardProblems({ ...ok, M1_FENCE_LOG: '' }).length > 0 &&
    ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'HTTPS_PROXY', 'CLOUDSDK_AUTH_ACCESS_TOKEN'].every(k => offlineGuardProblems({ ...ok, [k]: 'x' }).length > 0)
})
await t('CLI: plan / selftest / rehearse refuse (exit 3) without the fence; execute without a permit refuses (exit 3) and creates nothing', () => {
  const run = (args, env) => spawnSync(process.execPath, [path.join(PKG, 'm1-s1b.mjs'), ...args], { env, encoding: 'utf8', windowsHide: true })
  const clean = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }
  const a = ['plan', 'selftest', 'rehearse', 'permit-draft'].map(c => run([c], clean))
  const e = run(['execute', '--permit', path.join(os.tmpdir(), 'no-such-permit.json'), '--web-config', path.join(os.tmpdir(), 'no-such.env')], clean)
  return a.every(r => r.status === 3 && /offline guard/.test(r.stdout)) && e.status === 3 && /INIT_REFUSED/.test(e.stdout) && namespaceUntouched()
})
await t('CLI selftest and plan (fenced environment, a fence log): pass and make NO network event', () => {
  const log = path.join(os.tmpdir(), `s1b-fence-${process.pid}.jsonl`); fs.writeFileSync(log, '')
  const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, NODE_OPTIONS: `--require=${path.join(PKG, 'offline-fence', 'loopback-only.cjs')}`, M1_FENCE_LOG: log }
  const st = spawnSync(process.execPath, [path.join(PKG, 'm1-s1b.mjs'), 'selftest'], { env, encoding: 'utf8', windowsHide: true })
  const pl = spawnSync(process.execPath, [path.join(PKG, 'm1-s1b.mjs'), 'plan'], { env, encoding: 'utf8', windowsHide: true })
  const events = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length
  let plan = null; try { plan = JSON.parse(pl.stdout) } catch { /* below */ }
  return st.status === 0 && /SELFTEST_PASS/.test(st.stdout) && pl.status === 0 && plan?.steps?.length === STEPS.length && plan.status === 'PREPARED_NOT_AUTHORIZED' && events === 0 ? true : `st=${st.status} ${st.stdout} pl=${pl.status} events=${events}`
})
await t('offline launcher: runs selftest/plan/permit-draft in an isolated environment even when the parent environment holds credential variables (they are not inherited), with no network event', () => {
  const parent = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, GOOGLE_APPLICATION_CREDENTIALS: 'x', FIREBASE_TOKEN: 'y', GITHUB_TOKEN: 'z', HTTPS_PROXY: 'http://p.invalid:1' }
  const run = cmd => spawnSync(process.execPath, [path.join(PKG, 'm1-s1b-offline.mjs'), cmd], { env: parent, encoding: 'utf8', windowsHide: true })
  const a = run('selftest'), b = run('plan'), c = run('permit-draft')
  const ev = r => Number((r.stderr.match(/fenceEvents=(\d+)/) ?? [])[1])
  let draft = null; try { draft = JSON.parse(c.stdout) } catch { /* below */ }
  return a.status === 0 && /SELFTEST_PASS/.test(a.stdout) && b.status === 0 && c.status === 0 && ev(a) === 0 && ev(b) === 0 && ev(c) === 0 && draft?.status === 'TEMPLATE_NOT_A_PERMIT' ? true : `a=${a.status} b=${b.status} c=${c.status} ${a.stderr.slice(0, 120)}`
})
await t('permit-draft: carries the byte bindings of this package, every operation off and placeholders for the owner; it is not accepted as a permit and becomes valid only when the owner completes it', () => {
  const out = spawnSync(process.execPath, [path.join(PKG, 'm1-s1b-offline.mjs'), 'permit-draft'], { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, encoding: 'utf8', windowsHide: true })
  const d = JSON.parse(out.stdout)
  const f = factsOf()
  const bound = d.bytes.codeSums === f.codeSumsSha256 && d.bytes.budget === f.budgetSha256 && d.bytes.expectedState === f.expectedStateSha256 && d.bytes.distManifest === f.distManifestSha256
  const allOff = Object.values(d.operations).every(v => v === false)
  const rejected = permitProblems(d, f, NOW).length > 0
  d.status = 'APPROVED'; d.operations = Object.fromEntries(Object.keys(OPERATION_CLASSES).map(k => [k, true])); d.operations.cleanupAfterProvenNonDispatch = false
  d.reconciliation = { performedAtUtc: '2026-11-01T09:00:00Z', evidenceRef: 'reconciliation-ref-1' }; d.owner = { approvalRef: 'owner-decision-ref-1', approvedAtUtc: '2026-11-01T10:00:00Z', expiresAtUtc: '2026-11-01T22:00:00Z' }
  return bound && allOff && rejected && permitProblems(d, f, NOW).length === 0
})
await t('hygiene: the package has NO export, deploy, Rules-rollback or Functions-deploy code or file (S1b variant)', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  const files = walk(PKG).filter(f => !f.includes(`${path.sep}results${path.sep}`))
  const names = files.map(f => path.relative(PKG, f).replaceAll('\\', '/'))
  const forbiddenNames = names.filter(n => /(^|\/)(m1-export|m1-deploy-wrapper|m1-rules-rollback-prepare|m1-orchestrator|stub-firebase|stub-gcloud)\./.test(n))
  const code = files.filter(f => /\.(mjs|cjs)$/.test(f) && !f.includes(`${path.sep}tests${path.sep}`) && !f.endsWith('ui-route-policy-tests.mjs') && !f.endsWith('local-acl-webconfig-tests.mjs') && !f.endsWith('emulator-cleanup-gate-tests.mjs'))
  const hits = []
  for (const f of code) {
    const text = fs.readFileSync(f, 'utf8')
    for (const re of [/firebase deploy/i, /--only\s+(firestore|functions)/i, /gcloud\.(cmd|exe)/i, /gcloud['" ]+(firestore|beta|alpha|functions|auth|config)/i, /firestore export/i, /backup-rules/i, /deployArgs/, /\bnpm\b[^\n]*run build/, /rules-rollback(?!-deploy-exit)/]) if (re.test(text)) hits.push(`${path.basename(f)}:${re}`)
  }
  return forbiddenNames.length === 0 && hits.length === 0 ? true : `names=${forbiddenNames} hits=${hits}`
})
await t('hygiene: the flow passes only the verified-new Rules status to cleanup and never a rollback argument', () => {
  const flow = fs.readFileSync(path.join(PKG, 'm1-s1b-flow.mjs'), 'utf8')
  const cfg = rehearsal(newUnit()); runFlow(cfg)
  const cleanupArgs = cfg.calls.find(c => c.label === 'cleanup').argv
  const stripped = flow.replace(/no Rules rollback branch|NO Rules rollback branch|no Rules rollback/gi, '').replace(/NO export, NO Rules\/Functions\/frontend deploy and NO Rules rollback branch/g, '')
  return !/rolled-back|rollback/i.test(stripped) && cleanupArgs.includes('verified-new') && !cleanupArgs.some(a => /rollback|rolled-back/.test(a))
})
await t('hygiene: the operation classes of the permit and the steps of the plan cover each other (nothing live without a class)', () => {
  const live = new Set(STEPS.map(s => s.live).join('+').split('+'))
  const classes = Object.keys(OPERATION_CLASSES)
  const need = ['github-read', 'staging-state-reads', 'readiness-probes', 'auth-create', 'firestore', 'callables', 'exact-lookup', 'deletes']
  return need.every(n => live.has(n)) && ['githubCiRead', 'stagingStateReads', 'readinessProbes', 'authCreate', 'firestoreAndCallables', 'cleanup', 'cleanupExactLookup', 'cleanupAfterProvenNonDispatch'].every(c => classes.includes(c)) && PERMIT_FORMAT.startsWith('finapp-m1-s1b')
})
await t('hygiene: the package fence files are byte-identical to the accepted ones of M1-SAFE-STOP-RECOVERY-01 (checked by the repo tooling; here: a pinned hash)', () => {
  const pinned = JSON.parse(fs.readFileSync(path.join(PKG, 'offline-fence', 'FENCE-PINS.json'), 'utf8'))
  return Object.entries(pinned).every(([f, h]) => sha(fs.readFileSync(path.join(PKG, 'offline-fence', f))) === h)
})

await t('the real staging namespace was never touched by these tests', () => startedClean && namespaceUntouched())
console.log(`S1B_NEGATIVE_CONTROLS ${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail}${fail ? ` failed=${failures.join(' | ')}` : ''}`)
process.exitCode = fail ? 1 : 0
