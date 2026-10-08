// Deterministic tests of the table-top check: the real proposal passes; each ordering/precondition defect is detected.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRollout } from './tabletop-check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const spec0 = JSON.parse(fs.readFileSync(path.join(HERE, 'rollout-steps.json'), 'utf8'))
const runbook0 = fs.readFileSync(path.resolve(HERE, '../../../runbooks/M1-COMPATIBILITY-ROLLOUT-20261007.md'), 'utf8')
const clone = o => JSON.parse(JSON.stringify(o))
const step = (s, id) => s.steps.find(x => x.id === id)
let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`) } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`) } }
const has = (r, code) => { if (r.ok || !r.violations.some(x => x.startsWith(code))) throw new Error(`expected ${code}, got ${r.violations.join(' | ') || 'ok'}`) }

t('the proposal and the runbook pass the table-top replay', () => { const r = checkRollout(spec0, runbook0); if (!r.ok) throw new Error(r.violations.join(' | ')) })
t('the spec alone (no runbook text) passes', () => { const r = checkRollout(spec0); if (!r.ok) throw new Error(r.violations.join(' | ')) })
t('P6a does not require any post-merge fact; P6b requires only the merge', () => {
  const p6a = step(spec0, 'P6a'), p6b = step(spec0, 'P6b')
  if (p6a.requires.some(f => spec0.facts[f]?.phase === 'post-merge')) throw new Error('post-merge fact before merge')
  if (p6b.requires.join() !== 'merged') throw new Error('P6b must require the merge only')
})
t('tree equality as a P6a precondition is rejected', () => { const s = clone(spec0); step(s, 'P6a').requires.push('tree_equal_main_head'); has(checkRollout(s), 'POST_MERGE_FACT_AS_PRECONDITION') })
t('tree equality in the runbook P6a precondition cell is rejected', () => {
  const rb = runbook0.split('\n').map(l => l.startsWith('| P6a |') ? l.replace(/(\|[^|]*\|[^|]*\|)([^|]*)\|/, (m, a, b) => `${a}${b} tree \`origin/main\` = tree HEAD |`) : l).join('\n')
  has(checkRollout(spec0, rb), 'RUNBOOK_P6A_TREE_PRECONDITION')
})
t('swapping P3 and P4 is rejected (order and unmet precondition)', () => { const s = clone(spec0); const i = s.steps.findIndex(x => x.id === 'P3'); [s.steps[i], s.steps[i + 1]] = [s.steps[i + 1], s.steps[i]]; has(checkRollout(s), 'STEP_ORDER'); has(checkRollout(s), 'PRECONDITION_NOT_MET') })
t('a missing expected-BASE precondition in P6a is rejected', () => { const s = clone(spec0); step(s, 'P6a').requires = step(s, 'P6a').requires.filter(f => f !== 'main_is_expected_base'); has(checkRollout(s), 'P6A_MISSING_PRECONDITION') })
t('a missing required-checks precondition in P6a is rejected', () => { const s = clone(spec0); step(s, 'P6a').requires = step(s, 'P6a').requires.filter(f => f !== 'required_checks_success_on_head'); has(checkRollout(s), 'P6A_MISSING_PRECONDITION') })
t('merge without its own approval is rejected', () => { const s = clone(spec0); step(s, 'P6a').approval = null; has(checkRollout(s), 'EXTERNAL_STEP_WITHOUT_APPROVAL') })
t('the merge approval shared with another step is rejected', () => { const s = clone(spec0); step(s, 'P4').approval = 'merge'; has(checkRollout(s), 'MERGE_APPROVAL_NOT_SEPARATE') })
t('P6a using a deploy approval instead of the merge approval is rejected', () => { const s = clone(spec0); step(s, 'P6a').approval = 'vds_publish'; has(checkRollout(s), 'MERGE_APPROVAL_NOT_SEPARATE') })
t('an external step without rollback is rejected', () => { const s = clone(spec0); step(s, 'P3').rollback = null; has(checkRollout(s), 'EXTERNAL_STEP_WITHOUT_ROLLBACK') })
t('a P4 rollback that does not return to the C1 hotfix is rejected', () => { const s = clone(spec0); step(s, 'P4').rollback.restores = []; has(checkRollout(s), 'P4_ROLLBACK_NOT_COMPATIBLE') })
t('a step that changes Rules or restores the legacy client is rejected', () => { for (const c of ['rules', 'legacy_client']) { const s = clone(spec0); step(s, 'P3').changes.push(c); has(checkRollout(s), 'FORBIDDEN_CHANGE') } })
t('an unmet baseline fact blocks P0 and everything that depends on it', () => { const s = clone(spec0); s.baseline.facts = s.baseline.facts.filter(f => f !== 'rules_r3_live'); has(checkRollout(s), 'PRECONDITION_NOT_MET') })
t('the stage host with the date of the last check is mandatory', () => { const s = clone(spec0); s.stageHost.url = ''; has(checkRollout(s), 'STAGE_HOST'); const s2 = clone(spec0); delete s2.stageHost.lastAuditorCheck; has(checkRollout(s2), 'STAGE_HOST') })
t('the runbook must name the stage host and must not claim the address is unknown', () => {
  has(checkRollout(spec0, runbook0.replaceAll('https://stage.aktivmetr.ru/', 'stage')), 'RUNBOOK_STAGE_HOST')
  has(checkRollout(spec0, `${runbook0}\nАдрес не указан.\n`), 'RUNBOOK_STALE_CLAIM')
})
t('runbook rows that differ from the spec (P6b missing) are rejected', () => { has(checkRollout(spec0, runbook0.split('\n').filter(l => !l.startsWith('| P6b |')).join('\n')), 'RUNBOOK_ROWS') })
t('the runbook must carry the expected BASE and PR HEAD', () => { has(checkRollout(spec0, runbook0.replaceAll('6d713fe', 'xxxxxxx')), 'RUNBOOK_SHA') })

console.log(`ROLLOUT_TABLETOP_TESTS ${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail}`)
process.exitCode = fail ? 1 : 0
