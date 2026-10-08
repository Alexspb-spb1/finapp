// M1-STAGING-R3-SMOKE-PREP-02 (variant S1b) - the pins of the smoke-only flow for a staging project whose Rules are ALREADY the round-3 target.
// Pure data and pure functions: nothing here touches the network or the owner's credentials. The 2026-10-07 live facts are a DATED BASELINE of the
// audit, not current readings; before any live execution a new, separately permitted state reconciliation is required (see m1-s1b-permit.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex')

export const S1B = Object.freeze({
  taskId: 'M1-STAGING-R3-SMOKE-PREP-02',
  variant: 'S1b',
  status: 'PREPARED_NOT_AUTHORIZED',
  project: 'finapp-staging',
  // The reviewed application commit whose build, Functions and Rules are exercised (PR #28 HEAD).
  head: '714d0f91c60a582ee87dc7da82d6249b3106329f',
  priorHead: '8526a791ce3f62dee5a64aa239b795c609a39226',
  // Canonical (CRLF-normalised) Rules hashes.
  rulesTarget: 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd',
  rulesRound2: 'f117e489f9549da9083c19bdf4104b3651aa500061aa52426f09cb6fe492adda',
  stageHost: 'https://stage.aktivmetr.ru/',
  baselineDate: '2026-10-07',
  // New namespace: none of these exists, and none may be reused.
  evidenceName: 'm1-stg-s1b-714d0f91',
  runName: 'm1-staging-run-714d0f91-s1b',
  packageName: 'm1-s1b-staging',
  rehearsalBase: 'D:\\projects\\finapp\\.runtime\\m1-s1b-rehearsal\\',
  runtimeRoot: 'D:\\projects\\finapp\\.runtime',
  m1Callables: Object.freeze(['changeMemberRole', 'disableMember', 'restoreMember', 'removeMember', 'listCompanyMembers']),
  // Consumed or reserved namespaces. A new run must not write into, rename or reuse any of them.
  consumedEvidence: Object.freeze(['m1-stg-r3-714d0f91', 'm1-stg-r3v5-714d0f91', 'm1-stg-r4-714d0f91', 'm1-stg-rev7-8526a79', 'm1-stg-rev8-8526a79', 'm1-stg-diag1-rev7']),
  consumedRuns: Object.freeze(['m1-staging-run-714d0f91', 'm1-staging-run-714d0f91-v5', 'm1-staging-run-714d0f91-v6', 'm1-staging-run-8526a79-rev7', 'm1-staging-run-8526a79-rev8']),
  // The first four are consumed by earlier staging runs (m1-core.PRIOR_RUN_IDS holds the synthetic-run ids, the last one belongs to the consumed run r3-ab9fb2fe).
  consumedRunIds: Object.freeze(['bbb573d8', 'acf785fd', '7cbe0a6e']),
  // Names that mark a production target in any config, argument or environment value.
  productionMarkers: Object.freeze(['finapp-prod-10a83', 'finapp-prod'])
})

/** 'r3' (the target), 'r2' (the round-2 Rules the old orchestrator required), or 'unknown'. */
export function classifyRulesHash(hash) {
  if (hash === S1B.rulesTarget) return 'r3'
  if (hash === S1B.rulesRound2) return 'r2'
  return 'unknown'
}

/** Why a verify-current-rules evidence file does not show the R3 target (best effort; the reason is one of a closed set, never file content). */
export function rulesMismatchReason(evidenceText) {
  try {
    const last = evidenceText.trim().split('\n').filter(Boolean).at(-1)
    const e = JSON.parse(last)
    const observed = e.observedCanonicalSha256 ?? e.canonicalSha256
    if (e.status === 'CURRENT_RULES_HASH_VERIFIED' && observed === S1B.rulesTarget) return 'rules-r3'
    const c = classifyRulesHash(observed)
    return c === 'r2' ? 'rules-r2-live' : 'rules-not-r3'
  } catch { return 'rules-evidence-unreadable' }
}

const nameOf = p => path.basename(String(p).replace(/[\\/]+$/, ''))

/** Namespace problems for a flow about to start. Pure over the given names/paths (existence is passed in). */
export function namespaceProblems({ profile, evidenceDir, runDir, exists }) {
  const problems = []
  if (profile === 'staging') {
    if (nameOf(evidenceDir) !== S1B.evidenceName) problems.push('evidence directory name is not the S1b namespace')
    if (nameOf(runDir) !== S1B.runName) problems.push('run directory name is not the S1b namespace')
    if (path.dirname(evidenceDir).toLowerCase() !== S1B.runtimeRoot.toLowerCase() || path.dirname(runDir).toLowerCase() !== S1B.runtimeRoot.toLowerCase()) problems.push('namespace outside the runtime root')
  } else {
    if (!evidenceDir.toLowerCase().startsWith(S1B.rehearsalBase.toLowerCase()) || evidenceDir.includes('..')) problems.push('rehearsal evidence outside the rehearsal base')
    if (path.dirname(runDir).toLowerCase() !== evidenceDir.toLowerCase()) problems.push('rehearsal run directory is not inside the evidence directory')
  }
  for (const d of [evidenceDir, runDir]) {
    const n = nameOf(d)
    if (S1B.consumedEvidence.includes(n) || S1B.consumedRuns.includes(n)) problems.push(`consumed or reserved namespace ${n}`)
    if (exists(d)) problems.push(`namespace already exists: ${n} (a run is never repeated)`)
  }
  return problems
}

/** Facts about the target; production markers, a non-staging project or an emulator marker in a live profile are refused. */
export function targetProblems({ profile, project, webConfigProject, values = [] }) {
  const problems = []
  if (profile === 'staging') {
    if (project !== S1B.project) problems.push('target project is not finapp-staging')
    if (webConfigProject !== S1B.project) problems.push('web config project is not finapp-staging')
  }
  for (const v of values) for (const m of S1B.productionMarkers) if (String(v).toLowerCase().includes(m)) problems.push('production marker in the input values')
  return [...new Set(problems)]
}

// ── operation budget ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const BUDGET_MODES = Object.freeze(['preflight', 'seed', 'ui', 'api', 'ui-r3', 'cleanup', 'verify-clean', 'inventory'])
export const BUDGET_FIELDS = Object.freeze(['maxRequests', 'maxAuthCreates', 'maxAuthDeletes', 'maxOperatorCommits'])
export function budgetProblems(budget) {
  const problems = []
  if (budget?.format !== 'finapp-m1-s1b-operation-budget-v1' || budget.project !== S1B.project || budget.head !== S1B.head) problems.push('budget format/project/head')
  const modes = budget?.modes ?? {}
  if (Object.keys(modes).sort().join() !== [...BUDGET_MODES].sort().join()) problems.push('budget modes')
  for (const m of BUDGET_MODES) {
    const b = modes[m]
    if (!b || Object.keys(b).sort().join() !== [...BUDGET_FIELDS].sort().join() || BUDGET_FIELDS.some(k => !Number.isInteger(b[k]) || b[k] < 0 || b[k] > 100000)) problems.push(`budget ${m}`)
  }
  // Hard ceilings that no budget may exceed: 3 synthetic Auth users, nothing else is created or deleted through Auth.
  const total = k => BUDGET_MODES.reduce((n, m) => n + (modes[m]?.[k] ?? 0), 0)
  if (total('maxAuthCreates') > 3) problems.push('budget creates more than 3 Auth users')
  if (total('maxAuthDeletes') > 3) problems.push('budget deletes more than 3 Auth users')
  for (const m of ['preflight', 'ui', 'api', 'ui-r3', 'verify-clean', 'inventory']) if ((modes[m]?.maxAuthCreates ?? 0) !== 0 || (modes[m]?.maxAuthDeletes ?? 0) !== 0) problems.push(`budget ${m} may not create or delete Auth users`)
  if ((modes.seed?.maxAuthDeletes ?? 0) !== 0 || (modes.cleanup?.maxAuthCreates ?? 0) !== 0) problems.push('budget seed deletes / cleanup creates')
  return problems
}
export function loadBudget(file) {
  const bytes = fs.readFileSync(file)
  const budget = JSON.parse(bytes.toString('utf8'))
  return { budget, sha256: sha256Hex(bytes), problems: budgetProblems(budget) }
}
/** The JSON the flow hands to a tool through M1_S1B_BUDGET. */
export function budgetEnvValue(budget, mode) {
  const b = budget.modes[mode]
  return JSON.stringify(Object.fromEntries(BUDGET_FIELDS.map(k => [k, b[k]])))
}
