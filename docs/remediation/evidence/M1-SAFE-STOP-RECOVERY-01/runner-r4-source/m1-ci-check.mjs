#!/usr/bin/env node
// FINAPP-1.0-M1 R3 — exact-head CI gate without jq or shell quoting (CI run 36830077757, HEAD 714d0f91).
//
//   node m1-ci-check.mjs --profile <staging|rehearsal> --run-id 36830077757 --expected-head <sha> --out <new abs json>
//
// Runs `gh run view <id> --repo Alexspb-spb1/finapp --json databaseId,headSha,status,conclusion,jobs` through
// execFile with shell:false and an argument array, then validates the structure
// fail-closed. Profile `rehearsal` runs the local no-network gh stub instead.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXPECTED_HEAD } from './m1-core.mjs'

export const CI_RUN_ID = 36830077757
export const REQUIRED_JOBS = Object.freeze(['ci', 'functions'])
// --repo is explicit: the release clone's remotes must not decide which repository the CI gate reads.
export const GH_REPO = 'Alexspb-spb1/finapp'
export const GH_ARGS = Object.freeze(['run', 'view', String(CI_RUN_ID), '--repo', GH_REPO, '--json', 'databaseId,headSha,status,conclusion,jobs'])
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Pure validation of `gh run view --json` output. Returns the list of problems. */
export function validateCiRun(raw, expectedHead = EXPECTED_HEAD) {
  let run
  try { run = JSON.parse(raw) } catch { return ['malformed JSON'] }
  const problems = []
  if (run === null || typeof run !== 'object' || Array.isArray(run)) return ['not an object']
  if (run.databaseId !== CI_RUN_ID) problems.push('run id mismatch')
  if (run.headSha !== expectedHead) problems.push('head mismatch')
  if (run.status !== 'completed') problems.push(`workflow status ${run.status}`)
  if (run.conclusion !== 'success') problems.push(`workflow conclusion ${run.conclusion}`)
  if (!Array.isArray(run.jobs)) return [...problems, 'jobs missing']
  const names = run.jobs.map(j => j?.name)
  for (const required of REQUIRED_JOBS) {
    const matches = run.jobs.filter(j => j?.name === required)
    if (matches.length !== 1) { problems.push(`job ${required} count ${matches.length}`); continue }
    if (matches[0].status !== 'completed') problems.push(`job ${required} status ${matches[0].status}`)
    if (matches[0].conclusion !== 'success') problems.push(`job ${required} conclusion ${matches[0].conclusion}`)
  }
  for (const name of names) if (!REQUIRED_JOBS.includes(name)) problems.push(`unexpected job ${name}`)
  return problems
}

function resolveGh() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'gh.exe')
    if (dir && fs.existsSync(candidate)) return candidate
  }
  return null
}

export function ghCommand(profile) {
  if (profile === 'staging') {
    if (Object.keys(process.env).some(k => k.toUpperCase().startsWith('M1_STUB_'))) throw new Error('stub environment present in staging profile')
    const gh = resolveGh()
    if (!gh) throw new Error('gh.exe not found on PATH')
    return { file: gh, args: [...GH_ARGS] }
  }
  if (profile === 'rehearsal') {
    if (!process.env.M1_STUB_SCENARIO) throw new Error('rehearsal profile requires M1_STUB_SCENARIO')
    return { file: process.execPath, args: ['--require', path.join(HERE, 'stubs', 'no-network.cjs'), path.join(HERE, 'stubs', 'stub-gh.mjs'), ...GH_ARGS] }
  }
  throw new Error('unknown profile')
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
if (isMain) {
  const args = process.argv.slice(2)
  const o = {}
  for (let i = 0; i < args.length; i += 2) o[args[i]] = args[i + 1]
  const finish = (status, extra) => {
    if (o['--out'] && path.isAbsolute(o['--out']) && !fs.existsSync(o['--out'])) {
      fs.writeFileSync(o['--out'], `${JSON.stringify({ status, runId: CI_RUN_ID, expectedHead: EXPECTED_HEAD, ...extra, at: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' })
    }
    console.log(`M1_CI_${status}${extra.problems?.length ? ` ${extra.problems.join('; ')}` : ''}`)
    process.exitCode = status === 'VERIFIED' ? 0 : 2
  }
  try {
    if (args.length !== 8 || o['--run-id'] !== String(CI_RUN_ID) || o['--expected-head'] !== EXPECTED_HEAD || !o['--out'] || !path.isAbsolute(o['--out']) || fs.existsSync(o['--out'])) {
      throw new Error('usage: --profile <staging|rehearsal> --run-id 36830077757 --expected-head <sha> --out <new abs json>')
    }
    const { file, args: argv } = ghCommand(o['--profile'])
    execFile(file, argv, { shell: false, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error && typeof error.code !== 'number') return finish('STOP', { problems: [`gh could not run: ${error.code ?? error.message}`] })
      if (error) return finish('STOP', { problems: [`gh exit ${error.code}`] })
      const problems = validateCiRun(stdout)
      let jobs = []
      try { jobs = JSON.parse(stdout).jobs.map(j => ({ name: j.name, status: j.status, conclusion: j.conclusion })) } catch { /* reported above */ }
      finish(problems.length ? 'STOP' : 'VERIFIED', { profile: o['--profile'], problems, jobs })
    })
  } catch (e) {
    finish('STOP', { problems: [e.message] })
  }
}
