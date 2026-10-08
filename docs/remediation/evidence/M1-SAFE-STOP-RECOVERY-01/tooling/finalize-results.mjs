// Finalizes the sanitized result evidence of a candidate package: collect -> redact user names -> scan -> hash -> (re)build and verify the code sums.
// Fail closed: the first failing step ends the run with a non-zero exit code and the success marker RESULTS_FINALIZED is printed ONLY when every step succeeded.
// Usage: node finalize-results.mjs --pkg <candidate package dir> --base <rehearsal root> [--name <os user name>]...
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolveTarget, redactUserNames, scanSecrets, scanUserNames, writeSums, verifySums, currentUserNames } from './results-tools.mjs'

const defaultExec = (args, cwd) => { const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true }); return { status: r.status ?? 1, stdout: `${r.stdout || ''}${r.stderr || ''}` } }

// `exec(args, cwd)` runs a node child process; it is injectable so the failure paths are testable without touching a real package.
export function finalize({ pkg, base, names, exec = defaultExec }) {
  const steps = []
  const log = []
  const run = (name, fn) => {
    let status = 1, note = ''
    try { const r = fn(); status = r.status; note = r.note || '' } catch (e) { note = e.message }
    steps.push({ name, status, note })
    log.push(`${name} exit=${status}${note ? ` ${note}` : ''}`)
    return status === 0
  }
  const finish = () => { const failed = steps.find(s => s.status !== 0); return { ok: !failed, failedStep: failed?.name, exitCode: failed ? (failed.status === 2 ? 2 : 1) : 0, steps, log } }

  let results = ''
  if (!run('target', () => { results = resolveTarget(pkg); return { status: 0 } })) return finish()
  const userNames = names && names.length ? names : currentUserNames()
  const last = line => line.trim().split('\n').pop().slice(0, 200)
  if (!run('collect', () => { const r = exec([path.join(pkg, 'tests', 'collect-results.mjs'), '--base', base], pkg); return { status: r.status, note: last(r.stdout) } })) return finish()
  if (!run('redact-user-names', () => ({ status: 0, note: `files=${redactUserNames(results, userNames)}` }))) return finish()
  if (!run('scan', () => {
    const s = scanSecrets(results), u = scanUserNames(results, userNames)
    return { status: s.length || u.length ? 2 : 0, note: `secretPatternHits=${s.length} userNameHits=${u.length}${[...s, ...u].slice(0, 5).map(h => ` ${h.file}:${h.kind}`).join('')}` }
  })) return finish()
  if (!run('results-sums', () => { const r = writeSums(results); return { status: 0, note: `files=${r.files} sumsSha256=${r.sumsSha256}` } })) return finish()
  if (!run('results-sums-verify', () => { const p = verifySums(results); return { status: p.length ? 2 : 0, note: `problems=${p.length}` } })) return finish()
  if (!run('code-sums', () => { const r = exec([path.join(pkg, 'tests', 'make-code-sums.mjs')], pkg); return { status: r.status, note: last(r.stdout) } })) return finish()
  if (!run('code-sums-verify', () => {
    const r = exec([path.join(pkg, 'm1-verify-sums.mjs'), '--sums', path.join(pkg, 'CODE-SHA256SUMS.txt'), '--root', pkg], pkg)
    return { status: r.status, note: last(r.stdout) }
  })) return finish()
  return finish()
}

function main() {
  const rest = process.argv.slice(2)
  const arg = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined }
  const names = rest.flatMap((a, i) => rest[i - 1] === '--name' ? [a] : [])
  const r = finalize({ pkg: arg('--pkg'), base: arg('--base'), names })
  for (const l of r.log) console.log(l)
  console.log(r.ok ? 'RESULTS_FINALIZED' : `RESULTS_FINALIZE_FAILED step=${r.failedStep}`)
  process.exitCode = r.exitCode
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
