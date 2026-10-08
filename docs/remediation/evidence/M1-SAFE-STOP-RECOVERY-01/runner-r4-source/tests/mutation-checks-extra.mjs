// Additional controlled mutation added after the main set (same method as mutation-checks.mjs): the Rules settle wait.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MUTANTS = 'D:\\projects\\finapp\\.runtime\\m1-r4-mutants-extra'
fs.mkdirSync(MUTANTS, { recursive: true })
const dir = path.join(MUTANTS, `m29-settle-${Date.now()}`)
fs.cpSync(PKG, dir, { recursive: true, filter: src => !src.includes(`${path.sep}results`) })
const f = path.join(dir, 'm1-orchestrator.ps1')
const from = "$RulesSettleSeconds   = if ($RunProfile -eq 'staging') { 60 } else { 0 }"
const text = fs.readFileSync(f, 'utf8')
if (!text.includes(from)) throw new Error('mutation anchor not found')
fs.writeFileSync(f, text.replace(from, "$RulesSettleSeconds   = if ($RunProfile -eq 'staging') { 0 } else { 0 }"))
spawnSync(process.execPath, [path.join(dir, 'tests', 'normalize-ps1-bom.mjs')], { encoding: 'utf8' })
spawnSync(process.execPath, [path.join(dir, 'tests', 'make-code-sums.mjs')], { encoding: 'utf8' })
const r = spawnSync(process.execPath, [path.join(dir, 'tests', 'node-helper-tests.mjs')], { encoding: 'utf8', cwd: dir, timeout: 15 * 60 * 1000 })
const failed = (r.stdout.match(/^FAIL .*$/gm) ?? []).map(l => l.slice(0, 120))
const detected = r.status !== 0 && failed.length > 0
fs.rmSync(MUTANTS, { recursive: true, force: true })
fs.mkdirSync(path.join(PKG, 'results'), { recursive: true })
fs.writeFileSync(path.join(PKG, 'results', 'mutation-checks-extra.json'), `${JSON.stringify({ total: 1, undetected: detected ? 0 : 1, results: [{ mutation: 'M29 the staging Rules settle wait is set to 0 seconds', detected, failed }], at: new Date().toISOString() }, null, 2)}\n`)
console.log(`${detected ? 'DETECTED' : 'NOT DETECTED'} M29 the staging Rules settle wait is set to 0 seconds ${JSON.stringify(failed)}`)
console.log(`MUTATION_CHECKS_EXTRA ${detected ? 'PASS' : 'FAIL'} detected=${detected ? 1 : 0}/1`)
process.exitCode = detected ? 0 : 1
