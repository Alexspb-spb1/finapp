// Worker of the CR2 race test: runs the rehearsal flow for ONE shared evidence namespace with an injected executor that records every tool label in a shared log.
// No tool process is started and nothing is sent anywhere. Prints the flow status (PASS | SAFE_STOP | INIT_REFUSED).
//   node tests/s1b-race-worker.mjs <unit dir> <evidence dir> <calls log>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { runFlow } = await import(pathToFileURL(path.join(PKG, 'm1-s1b-flow.mjs')).href)
const { S1B } = await import(pathToFileURL(path.join(PKG, 'm1-s1b-pins.mjs')).href)
const [unit, evDir, callsLog] = process.argv.slice(2)
const readiness = { status: 'READY', allReadyInSameRound: true, functions: Object.fromEntries(S1B.m1Callables.map(n => [n, { ready: true, attempts: 1, lastVerdict: 'ready' }])) }
const exec = (label, argv) => {
  fs.appendFileSync(callsLog, `${label}\n`)
  const arg = n => argv[argv.indexOf(n) + 1]
  if (label === 'readiness') { fs.mkdirSync(arg('--out-dir'), { recursive: true }); fs.writeFileSync(path.join(arg('--out-dir'), 'readiness-result.json'), JSON.stringify(readiness)) }
  if (label === 'rules-state') fs.writeFileSync(arg('--out'), `${JSON.stringify({ mode: 'verify-current-rules', project: S1B.project, sourceHead: S1B.head, canonicalSha256: S1B.rulesTarget, status: 'CURRENT_RULES_HASH_VERIFIED', finishedAt: new Date().toISOString() })}\n`)
  return 0
}
const r = runFlow({
  profile: 'rehearsal', pkg: PKG, repo: path.join(unit, 'repo'), evDir, runDir: path.join(evDir, 'run'), stagingDist: 'D:\\x\\s', uiDist: 'D:\\x\\u', scenario: path.join(unit, 'scenario.json'), env: {},
  git: () => ({ head: S1B.head, status: '', functionsUnchanged: () => true }), aclCheck: () => true, exec
})
console.log(r.status)
