// Offline table-top check of the production rollout proposal: replays the step order and the preconditions from rollout-steps.json
// against a state machine and cross-checks the runbook text. No network, no cloud, no file writes; it executes no rollout step.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXPECTED_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6a', 'P6b']
const FORBIDDEN_CHANGES = new Set(['rules', 'legacy_client'])
const STALE_PHRASES = ['адрес не указан', 'не указан в исходных данных']

// Pure function: spec = parsed rollout-steps.json, runbookText = markdown text (optional).
export function checkRollout(spec, runbookText) {
  const violations = []
  const trace = []
  const v = (code, detail) => violations.push(`${code}: ${detail}`)
  const steps = spec.steps || []
  const ids = steps.map(s => s.id)
  if (new Set(ids).size !== ids.length) v('DUPLICATE_STEP_ID', ids.join(','))
  if (ids.join(',') !== EXPECTED_ORDER.join(',')) v('STEP_ORDER', `expected ${EXPECTED_ORDER.join(',')} got ${ids.join(',')}`)

  const state = new Set(spec.baseline?.facts || [])
  for (const k of Object.keys(spec.inputs || {})) state.add(k)
  const approvals = new Set(spec.approvals || [])
  const mergeIdx = steps.findIndex(s => (s.establishes || []).includes('merged'))
  const approvalUse = new Map()
  const usedInputs = new Set()

  steps.forEach((s, i) => {
    const missing = (s.requires || []).filter(f => !state.has(f))
    for (const f of s.requires || []) if (spec.inputs && f in spec.inputs) usedInputs.add(f)
    if (missing.length) v('PRECONDITION_NOT_MET', `${s.id} needs ${missing.join(',')} before it is established`)
    for (const f of s.requires || []) {
      const phase = spec.facts?.[f]?.phase
      if (phase === 'post-merge' && (mergeIdx < 0 || i <= mergeIdx)) v('POST_MERGE_FACT_AS_PRECONDITION', `${s.id} requires post-merge fact ${f} at or before the merge`)
    }
    if (s.external) {
      if (!s.approval) v('EXTERNAL_STEP_WITHOUT_APPROVAL', s.id)
      else if (!approvals.has(s.approval)) v('UNKNOWN_APPROVAL', `${s.id} uses ${s.approval}`)
      if (!s.rollback) v('EXTERNAL_STEP_WITHOUT_ROLLBACK', s.id)
    }
    if (s.approval) approvalUse.set(s.approval, [...(approvalUse.get(s.approval) || []), s.id])
    for (const c of s.changes || []) if (FORBIDDEN_CHANGES.has(c)) v('FORBIDDEN_CHANGE', `${s.id} changes ${c}`)
    for (const f of s.establishes || []) state.add(f)
    trace.push(`${s.id}${s.external ? ' [external]' : ''} requires=${(s.requires || []).length} establishes=${(s.establishes || []).join(',') || '-'}${missing.length ? ' BLOCKED' : ''}`)
  })

  const mergeApprovalUsers = approvalUse.get('merge') || []
  if (mergeApprovalUsers.length !== 1 || mergeApprovalUsers[0] !== 'P6a') v('MERGE_APPROVAL_NOT_SEPARATE', `users=${mergeApprovalUsers.join(',')}`)
  for (const [a, users] of approvalUse) if (a !== 'merge' && users.includes('P6a')) v('MERGE_USES_OTHER_APPROVAL', a)
  const p6a = steps.find(s => s.id === 'P6a')
  for (const f of ['main_is_expected_base', 'pr_head_is_expected', 'required_checks_success_on_head']) if (p6a && !(p6a.requires || []).includes(f)) v('P6A_MISSING_PRECONDITION', f)
  const pos = id => ids.indexOf(id)
  if (!(pos('P3') >= 0 && pos('P3') < pos('P4') && pos('P4') < pos('P6a'))) v('FUNCTIONS_BEFORE_VDS_BEFORE_MERGE', 'P3 < P4 < P6a violated')
  const p4 = steps.find(s => s.id === 'P4')
  if (p4 && !(p4.rollback?.restores || []).includes('vds_is_c1_hotfix')) v('P4_ROLLBACK_NOT_COMPATIBLE', 'rollback must restore vds_is_c1_hotfix')
  for (const f of Object.keys(spec.inputs || {})) if (!usedInputs.has(f)) v('UNUSED_INPUT', f)
  if (!/^https:\/\/stage\.aktivmetr\.ru\/$/.test(spec.stageHost?.url || '')) v('STAGE_HOST', 'stage host URL missing or malformed')
  if (!spec.stageHost?.lastAuditorCheck) v('STAGE_HOST', 'date of the last check is missing')
  if (!spec.baseline?.mainSha || !spec.baseline?.prHeadSha) v('BASELINE', 'expected BASE or PR HEAD missing')

  if (typeof runbookText === 'string') {
    const rowIds = [...runbookText.matchAll(/^\| (P\d[a-z]?) \|/gm)].map(m => m[1])
    if (rowIds.join(',') !== EXPECTED_ORDER.join(',')) v('RUNBOOK_ROWS', `runbook rows ${rowIds.join(',')} differ from ${EXPECTED_ORDER.join(',')}`)
    if (!runbookText.includes(spec.stageHost?.url || '\0')) v('RUNBOOK_STAGE_HOST', 'runbook does not mention the stage host')
    for (const sha of [spec.baseline?.mainSha, spec.baseline?.prHeadSha]) if (sha && !runbookText.includes(sha.slice(0, 8))) v('RUNBOOK_SHA', `runbook lacks ${sha.slice(0, 8)}`)
    for (const p of STALE_PHRASES) if (runbookText.toLowerCase().includes(p)) v('RUNBOOK_STALE_CLAIM', p)
    const p6aRow = runbookText.split('\n').find(l => l.startsWith('| P6a |')) || ''
    if (/tree\s+`?origin\/main`?\s*=/.test(p6aRow.split('|')[3] || '')) v('RUNBOOK_P6A_TREE_PRECONDITION', 'tree equality appears in the P6a precondition cell')
  }
  return { ok: violations.length === 0, violations, trace }
}

function main() {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
  const specPath = arg('--spec') || path.join(HERE, 'rollout-steps.json')
  const runbookPath = arg('--runbook') || path.resolve(HERE, '../../../runbooks/M1-COMPATIBILITY-ROLLOUT-20261007.md')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
  const runbook = fs.existsSync(runbookPath) ? fs.readFileSync(runbookPath, 'utf8') : undefined
  const r = checkRollout(spec, runbook)
  for (const line of r.trace) console.log(line)
  for (const x of r.violations) console.log(`VIOLATION ${x}`)
  console.log(`ROLLOUT_TABLETOP ${r.ok ? 'PASS' : 'FAIL'} steps=${spec.steps?.length} violations=${r.violations.length} runbook=${runbook === undefined ? 'not-checked' : 'checked'}`)
  process.exitCode = r.ok ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
