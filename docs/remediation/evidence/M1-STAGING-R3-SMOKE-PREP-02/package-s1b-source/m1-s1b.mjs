#!/usr/bin/env node
// M1-STAGING-R3-SMOKE-PREP-02 (variant S1b) - entry point of the smoke-only package. Status: PREPARED_NOT_AUTHORIZED.
//
//   node m1-s1b.mjs plan                                  offline: prints the sequence, operation classes, budget and pins as JSON
//   node m1-s1b.mjs selftest                              offline: the package is consistent (sums, budget, expected state, pins)
//   node m1-s1b.mjs rehearse --scenario <abs json> --evidence-root <abs dir under the rehearsal base> --ui-dist <abs emulator build> --staging-dist <abs>
//                            the SAME flow against local emulators with no-network read stubs; no permit, no live system
//   node m1-s1b.mjs execute --permit <abs json> --web-config <abs staging web config file>
//                            the staging execution: refused (exit 3) unless the permit is valid for exactly these bytes; NOT run in the preparation block
//
// plan/selftest/rehearse are OFFLINE modes: they refuse to start unless the loopback-only network fence is preloaded (NODE_OPTIONS) with its log, and unless no
// credential-like environment variable is present. They never import a live adapter and never read owner credential files. Exit codes: 0 PASS, 2 SAFE_STOP, 3 INIT_REFUSED.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { S1B, budgetProblems, loadBudget } from './m1-s1b-pins.mjs'
import { OPERATION_CLASSES, permitTemplate } from './m1-s1b-permit.mjs'
import { runFlow } from './m1-s1b-flow.mjs'
import { validateExpected } from './m1-state-lib.mjs'
import { REPO } from './m1-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CREDENTIAL_ENV = /^(GOOGLE_(?!CLOUD_PROJECT$)|GCLOUD(?!_PROJECT$)|CLOUDSDK_(?!CONFIG$)|FIREBASE_(?!EMULATORS_PATH$|CLI_DISABLE_UPDATE_CHECK$)|GH_|GITHUB_|AWS_|AZURE_|NPM_TOKEN|NODE_AUTH_TOKEN|HTTPS?_PROXY|ALL_PROXY)/i

export const STEPS = Object.freeze([
  { id: 'step0', title: 'local gates: application repo HEAD/clean, package hashes, staging build manifest, web config marker, Functions unchanged, pinned Rules file, CI run', live: 'github-read' },
  { id: 'step1', title: 'read-only exact state: 13 pinned Functions, live Rules == round-3 target (round 2 / unknown -> STOP)', live: 'staging-state-reads' },
  { id: 'step2', title: 'readiness: five M1 callables answer from the application layer (unauthenticated probes)', live: 'readiness-probes' },
  { id: 'step3', title: 'smoke preflight: maintenance off, fixture e-mails absent; private run dir + ACL', live: 'operator-reads' },
  { id: 'step4', title: 'smoke: seed, ui, api, ui-r3 (each once, never repeated)', live: 'auth-create+firestore+callables+browser' },
  { id: 'step5', title: 'cleanup (gates G1-G5, linked Rules evidence) + verify-clean; only on an explicit decision', live: 'exact-lookup+deletes' },
  { id: 'step6', title: 'final read-only checks: same Functions, round-3 Rules', live: 'staging-state-reads' }
])

export function offlineGuardProblems(env) {
  const problems = []
  const opts = env.NODE_OPTIONS ?? ''
  if (!/loopback-only\.cjs/.test(opts)) problems.push('the loopback-only network fence is not preloaded')
  if (!env.M1_FENCE_LOG) problems.push('M1_FENCE_LOG is not set')
  if (Object.keys(env).some(k => CREDENTIAL_ENV.test(k) && env[k])) problems.push('credential-like environment variables are present')
  return problems
}

function sumsProblems() {
  const lines = fs.readFileSync(path.join(HERE, 'CODE-SHA256SUMS.txt'), 'utf8').split('\n').filter(Boolean)
  const problems = []
  for (const l of lines) {
    const hash = l.slice(0, 64), rel = l.slice(66)
    let actual = null
    try { actual = createHash('sha256').update(fs.readFileSync(path.join(HERE, ...rel.split('/')))).digest('hex') } catch { /* missing */ }
    if (actual !== hash) problems.push(`code hash ${rel}`)
  }
  return { problems, files: lines.length }
}

export function selftest() {
  const problems = []
  const sums = sumsProblems()
  problems.push(...sums.problems)
  const b = loadBudget(path.join(HERE, 'operation-budget.json'))
  problems.push(...b.problems)
  const expected = JSON.parse(fs.readFileSync(path.join(HERE, 'expected-state-r3.json'), 'utf8'))
  problems.push(...validateExpected(expected))
  if (expected.project !== S1B.project || expected.sourceHead !== S1B.head || expected.rulesTarget.canonicalSha256 !== S1B.rulesTarget || expected.rulesPre.canonicalSha256 !== S1B.rulesRound2) problems.push('pins differ from the expected-state file')
  if (budgetProblems(b.budget).length) problems.push('budget')
  for (const n of [S1B.evidenceName, S1B.runName]) if (S1B.consumedEvidence.includes(n) || S1B.consumedRuns.includes(n)) problems.push('namespace collides with a consumed one')
  return { ok: problems.length === 0, problems, files: sums.files, budgetSha256: b.sha256 }
}

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const line = (status, extra = '') => console.log(`M1_S1B_STATUS=${status}${extra ? ` ${extra}` : ''}`)

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (['plan', 'selftest', 'rehearse', 'permit-draft'].includes(cmd)) {
    const g = offlineGuardProblems(process.env)
    if (g.length) { line('INIT_REFUSED', `reason=offline guard: ${g[0]}`); process.exit(3) }
  }
  if (cmd === 'permit-draft') {
    // A DRAFT for the owner: the byte bindings of THIS package are filled in, every operation class is off, every owner field is a placeholder. It is not a permit.
    const sha = f => createHash('sha256').update(fs.readFileSync(path.join(HERE, f))).digest('hex')
    const p = permitTemplate()
    p.bytes = { codeSums: sha('CODE-SHA256SUMS.txt'), budget: sha('operation-budget.json'), expectedState: sha('expected-state-r3.json'), distManifest: sha('dist-staging-manifest.txt') }
    console.log(JSON.stringify(p, null, 2))
    return
  }
  if (cmd === 'plan') {
    const b = loadBudget(path.join(HERE, 'operation-budget.json'))
    console.log(JSON.stringify({ task: S1B.taskId, variant: S1B.variant, status: S1B.status, project: S1B.project, head: S1B.head, rulesTarget: S1B.rulesTarget, namespace: { evidence: S1B.evidenceName, run: S1B.runName }, steps: STEPS, operationClasses: OPERATION_CLASSES, budget: b.budget.modes, budgetSha256: b.sha256 }, null, 2))
    return
  }
  if (cmd === 'selftest') {
    const r = selftest()
    line(r.ok ? 'SELFTEST_PASS' : 'SELFTEST_FAIL', `files=${r.files} budgetSha256=${r.budgetSha256}${r.problems.length ? ` problems=${r.problems.slice(0, 3).join('; ')}` : ''}`)
    process.exit(r.ok ? 0 : 2)
  }
  if (cmd === 'rehearse') {
    const evDir = arg(rest, '--evidence-root')
    const r = runFlow({ profile: 'rehearsal', pkg: HERE, repo: REPO, evDir, runDir: path.join(evDir ?? '', 'run'), stagingDist: arg(rest, '--staging-dist'), uiDist: arg(rest, '--ui-dist'), scenario: arg(rest, '--scenario'), env: { ...process.env } })
    line(r.status, r.stop ? `step=${r.stop.step} reason=${r.stop.reason}` : r.reason ? `reason=${r.reason}` : '')
    process.exit(r.exitCode)
  }
  if (cmd === 'execute') {
    let permit = null
    try { permit = JSON.parse(fs.readFileSync(arg(rest, '--permit'), 'utf8')) } catch { /* refused by the flow */ }
    const runtime = S1B.runtimeRoot
    const r = runFlow({
      profile: 'staging', pkg: HERE, repo: REPO, evDir: path.join(runtime, S1B.evidenceName), runDir: path.join(runtime, S1B.runName),
      stagingDist: path.join(runtime, 'm1-dist-staging-714d0f91'), uiDist: path.join(runtime, 'm1-dist-staging-714d0f91'),
      webConfig: arg(rest, '--web-config'), permit, env: { ...process.env }
    })
    line(r.status, r.stop ? `step=${r.stop.step} reason=${r.stop.reason}` : r.reason ? `reason=${r.reason}` : '')
    process.exit(r.exitCode)
  }
  console.error('usage: m1-s1b.mjs <plan|selftest|rehearse|execute> ...')
  process.exit(3)
}
if (process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) main()
