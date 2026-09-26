// Mutation checks on gateGaDeploymentCheck13Core.mjs — proves
// gateGaDeploymentCheck13SelfTest.mjs actually catches regressions in each
// of this check's load-bearing lines, not just that the current code
// happens to pass. FINAPP-1.0-SEC-006-GATE-G-A-DEPLOYMENT-CHECK-13FN.
// Same technique as every other *MutationChecks.mjs file in this
// directory: copy the whole scripts/invitationRehearsal directory, apply
// one deliberate literal defect, rerun the self-test unmodified against
// the mutated copy, and require it to now fail.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const MUTANTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-deployment-check-13fn-mutants-'))
const results = []

function copyDir(name) {
  const dest = path.join(MUTANTS_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.cpSync(SRC, dest, { recursive: true })
  return dest
}
function mutate(dir, file, from, to) {
  const f = path.join(dir, file)
  const text = fs.readFileSync(f, 'utf8')
  if (!text.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from.slice(0, 100)}`)
  fs.writeFileSync(f, text.replace(from, () => to))
}
function runSelfTest(dir) {
  const r = spawnSync(process.execPath, ['--test', path.join(dir, 'gateGaDeploymentCheck13SelfTest.mjs')], { encoding: 'utf8', cwd: dir, timeout: 60_000 })
  const fail = r.stdout.match(/ℹ fail (\d+)/)
  return { exitCode: r.status, fail: fail ? Number(fail[1]) : null }
}
function record(name, detected, detail) {
  results.push({ mutation: name, detected: Boolean(detected), detail })
  console.log(`${detected ? 'DETECTED' : 'NOT DETECTED'} ${name} ${JSON.stringify(detail)}`)
}
function expectFailure(name, dir) {
  const r = runSelfTest(dir)
  record(name, r.exitCode !== 0 || (r.fail !== null && r.fail > 0), r)
}

{
  const dir = copyDir('m1-no-exact-count-check')
  mutate(dir, 'gateGaDeploymentCheck13Core.mjs',
    'if (v2.length !== ALL_CALLABLES.length) blocked()',
    'if (false) blocked()')
  expectFailure('M1 exact-13-function-count check removed', dir)
}
{
  const dir = copyDir('m2-no-baseline-drift-diff')
  mutate(dir, 'gateGaDeploymentCheck13Core.mjs',
    `      const recorded = baselineByName.get(shortName)
      if (!recorded || checked.revision !== recorded.revision || checked.build !== recorded.build ||
          checked.sourceReferenceSha256 !== recorded.sourceReferenceSha256 ||
          checked.sourceProvenanceSha256 !== recorded.sourceProvenanceSha256) blocked()`,
    '      const recorded = baselineByName.get(shortName)\n      void recorded')
  expectFailure('M2 baseline revision/build/source drift diff against the receipt removed', dir)
}
{
  const dir = copyDir('m3-no-receipt-sha-pin')
  mutate(dir, 'gateGaDeploymentCheck13Core.mjs',
    'if (sha256Bytes(bytes) !== expectedReceiptSha256 || !commitIsReachable) blocked()',
    'if (!commitIsReachable) blocked()')
  expectFailure('M3 baseline receipt SHA-256 provenance pin check removed', dir)
}
{
  const dir = copyDir('m4-no-commit-reachable-check')
  mutate(dir, 'gateGaDeploymentCheck13Core.mjs',
    'if (sha256Bytes(bytes) !== expectedReceiptSha256 || !commitIsReachable) blocked()',
    'if (sha256Bytes(bytes) !== expectedReceiptSha256) blocked()')
  expectFailure('M4 receipt sourceHead git-reachability check removed', dir)
}
{
  const dir = copyDir('m5-no-post-loop-uniqueness-check')
  mutate(dir, 'gateGaDeploymentCheck13Core.mjs',
    'if (seen.size !== ALL_CALLABLES.length) blocked()',
    'if (false) blocked()')
  expectFailure('M5 post-loop unique-name-count check removed (misses a same-count internal duplicate)', dir)
}
{
  const dir = copyDir('m9-no-receipt-post-loop-uniqueness-check')
  mutate(dir, 'gateGaDeploymentCheck13Core.mjs',
    'if (byName.size !== BASELINE_CALLABLES.length) blocked()',
    'if (false) blocked()')
  expectFailure('M9 receipt post-loop unique-name-count check removed (misses a same-count internal duplicate)', dir)
}
{
  const dir = copyDir('m6-member-management-allowlist-swapped-to-baseline')
  mutate(dir, 'gateGaDeploymentCheck13Core.mjs',
    'const name = MEMBER_MANAGEMENT_CALLABLES.find(id => value.name ===',
    'const name = BASELINE_CALLABLES.find(id => value.name ===')
  expectFailure('M6 checkMemberManagementFunction allowlist swapped to the baseline set', dir)
}
{
  const dir = copyDir('m7-no-receipt-function-count-check')
  mutate(dir, 'gateGaDeploymentCheck13Core.mjs',
    'receipt.functions.length !== BASELINE_CALLABLES.length ||',
    'false ||')
  expectFailure('M7 receipt exact-eight function-count structural check removed', dir)
}
{
  const dir = copyDir('m8-no-member-management-resource-shape-check')
  mutate(dir, 'gateGaDeploymentCheck13Core.mjs',
    `  if (config.availableMemory !== '256Mi' || config.availableCpu !== '1' ||
      config.maxInstanceRequestConcurrency !== 1 || minInstanceCount !== 0 ||
      config.maxInstanceCount !== 1 || config.timeoutSeconds !== 60) blocked()
  const revisionPrefix = \`\${name.toLowerCase()}-\`
  if (typeof config.revision !== 'string' || !config.revision.startsWith(revisionPrefix) ||
      !/^\\d{5,}-[a-z0-9]{3,10}$/.test(config.revision.slice(revisionPrefix.length))) blocked()
  const build = value.buildConfig.build
  if (typeof build !== 'string' || !new RegExp(\`^projects/(?:\${PROJECT}|\${projectNumber})/locations/[a-z0-9-]+/builds/[a-f0-9-]{36}$\`).test(build)) blocked()
  if (!record(value.buildConfig.source) || !Object.keys(value.buildConfig.source).length) blocked()
  const source = value.buildConfig.source
  const sourceKind = record(source.storageSource) ? 'storage' : record(source.repoSource) ? 'repository' : null
  if (!sourceKind) blocked()
  return {
    name: value.name, state: 'ACTIVE', generation: 2, runtime: 'nodejs22', region: REGION,
    resources: { memory: '256Mi', cpu: 1, concurrency: 1, minInstances: 0, maxInstances: 1, timeoutSeconds: 60 },
    revision: config.revision, build,
    sourceKind, sourceReferenceSha256: sha(source),
    sourceProvenanceSha256: record(value.buildConfig.sourceProvenance) ? sha(value.buildConfig.sourceProvenance) : null,
    rollbackArtifactAvailability: 'NOT_VERIFIED',
  }
}`,
    `  return {
    name: value.name, state: 'ACTIVE', generation: 2, runtime: 'nodejs22', region: REGION,
    resources: { memory: config.availableMemory, cpu: 1, concurrency: 1, minInstances: 0, maxInstances: 1, timeoutSeconds: config.timeoutSeconds },
    revision: config.revision, build: value.buildConfig.build,
    sourceKind: 'storage', sourceReferenceSha256: sha(value.buildConfig.source ?? {}),
    sourceProvenanceSha256: null,
    rollbackArtifactAvailability: 'NOT_VERIFIED',
  }
}`)
  expectFailure('M8 member-management resource-limit shape validation removed', dir)
}

fs.rmSync(MUTANTS_ROOT, { recursive: true, force: true })
const undetected = results.filter(r => !r.detected)
console.log(`\nSUMMARY total=${results.length} detected=${results.length - undetected.length} undetected=${undetected.length}`)
if (undetected.length) { console.error('UNDETECTED:', undetected.map(r => r.mutation)); process.exitCode = 1 }
