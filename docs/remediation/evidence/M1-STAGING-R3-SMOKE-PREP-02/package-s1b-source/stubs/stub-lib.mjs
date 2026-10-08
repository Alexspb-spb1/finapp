// Shared helpers for the R3 local stubs. Pure filesystem; no network modules.
// Every stub must run with `--require no-network.cjs` (enforced by assertPreloaded).
import fs from 'node:fs'
import path from 'node:path'

export const H = '714d0f91c60a582ee87dc7da82d6249b3106329f'
export const CI_RUN_ID = '36830077757'
// Canonical (CRLF-normalised) hashes: the round-2 Rules live on staging before the release (= rollback target)
// and the round-3 Rules the release deploys.
export const RULES_PRE = 'f117e489f9549da9083c19bdf4104b3651aa500061aa52426f09cb6fe492adda'
export const RULES_TARGET = 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd'
export const RULES_OTHER = '0000000000000000000000000000000000000000000000000000000000000000'
export const NEW_RULESET = 'projects/finapp-staging/rulesets/00000000-0000-4000-8000-0000000000r3'
export const ROLLBACK_RULESET = 'projects/finapp-staging/rulesets/00000000-0000-4000-8000-00000000rb02'

export function assertPreloaded() {
  if (process.env.M1_NO_NETWORK_PRELOADED !== '1') { console.error('STUB_REFUSED no-network preload missing'); process.exit(98) }
}
export function scenario() {
  const file = process.env.M1_STUB_SCENARIO
  if (!file || !fs.existsSync(file)) { console.error('STUB_REFUSED scenario missing'); process.exit(98) }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
export function stateDir() {
  const dir = process.env.M1_STUB_STATE
  if (!dir || !path.isAbsolute(dir)) { console.error('STUB_REFUSED state dir missing'); process.exit(98) }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
/** Records one invocation of `key`; refuses (exit 97) past `max` invocations. */
export function claim(key, max = 1) {
  const dir = stateDir()
  const record = path.join(dir, 'invocations.jsonl')
  const prior = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.key === key).length : 0
  fs.appendFileSync(record, `${JSON.stringify({ key, n: prior + 1, at: new Date().toISOString(), refused: prior >= max })}\n`)
  if (prior >= max) { console.error(`STUB_REFUSED repeated invocation of ${key}`); process.exit(97) }
}
export function refuse(reason) {
  const dir = process.env.M1_STUB_STATE
  if (dir) fs.appendFileSync(path.join(dir, 'invocations.jsonl'), `${JSON.stringify({ key: 'refusal', reason, at: new Date().toISOString(), refused: true })}\n`)
  console.error(`STUB_REFUSED ${reason}`)
  process.exit(96)
}
export function sameArgs(actual, expected) {
  return actual.length === expected.length && actual.every((a, i) => a === expected[i])
}
// The R3 release starts from the round-2 Rules that rev7 deployed and rev8 re-verified. A scenario may start
// elsewhere with `rulesInitial` = TARGET | OTHER (state-drift cases). The forward deploy sets TARGET, a rollback
// sets PRE again - published as a NEW ruleset (`via` = 'rollback'), exactly like a real re-publication.
export function rulesState() {
  const f = path.join(stateDir(), 'rules-state.json')
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  const initial = scenario().rulesInitial
  return { current: initial === 'TARGET' ? RULES_TARGET : initial === 'OTHER' ? RULES_OTHER : RULES_PRE, via: 'initial' }
}
export function setRulesState(current, via) {
  fs.writeFileSync(path.join(stateDir(), 'rules-state.json'), JSON.stringify({ current, via, at: new Date().toISOString() }))
}
export function writeNew(file, text) {
  if (!path.isAbsolute(file) || fs.existsSync(file)) refuse(`output path not new/absolute: ${path.basename(String(file))}`)
  fs.writeFileSync(file, text, { flag: 'wx' })
}
export const sleep = ms => new Promise(r => setTimeout(r, ms))
