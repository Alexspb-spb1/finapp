#!/usr/bin/env node
// FINAPP-1.0-M1 R3 - the ONLY way the package runs a Firebase deploy, and it can run exactly two kinds,
// both Firestore Rules only, both against finapp-staging:
//   rules            the forward deploy of the round-3 Rules from the clean release clone (firebase.json
//                    of the repository, --only firestore:rules);
//   rules-rollback   the Rules rollback: re-publishes the pre-release (round-2) Rules from the verified
//                    fresh backup (--config <evidence>\m1-stg-rules-rollback-r3\firebase.json).
// No Functions, no indexes, no Hosting and no other target exist here.
//
//   node m1-deploy-wrapper.mjs --profile <staging|rehearsal> --kind rules --expected-head <sha> --out-dir <new abs dir>
//   node m1-deploy-wrapper.mjs --profile <staging|rehearsal> --kind rules-rollback --expected-head <sha>
//        --out-dir <new abs dir> --rollback-config <abs ...\m1-stg-rules-rollback-r3\firebase.json>
//
// * spawn with shell:false and a fixed argument array; target is always finapp-staging;
// * rules: refuses unless the repository firestore.rules is byte-for-byte the pinned round-3 file
//   (raw SHA-256 and size from expected-state-r3.json) and the worktree is clean at the expected head;
// * rules-rollback: refuses unless the rollback directory holds exactly the pinned pre-release Rules
//   (raw SHA-256, size and canonical hash) and a firebase.json that lists only the Rules file;
//   the rollback config must sit in the same evidence directory as the out-dir;
// * stdout.log / stderr.log hold the raw bytes, combined.log keeps chunk arrival order,
//   exit.json holds the exact exit code - nothing is written through a shell, no BOM is added;
// * run-once: out-dir is created exclusively; the log is never echoed to the terminal.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXPECTED_HEAD, REPO, gitState } from './m1-core.mjs'
import { validateExpected, canonicalOf } from './m1-state-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT = 'finapp-staging'
export const KINDS = Object.freeze({ rules: {}, 'rules-rollback': {} })
const ROLLBACK_CONFIG = /\\m1-stg-rules-rollback-r3\\firebase\.json$/i
const sha = v => createHash('sha256').update(v).digest('hex')

/** Exact Firebase CLI argument vector for a deploy kind (after the CLI entry point). */
export function deployArgs(kind, rollbackConfig) {
  if (kind === 'rules') return ['deploy', '--project', PROJECT, '--only', 'firestore:rules', '--non-interactive']
  if (kind === 'rules-rollback') return ['deploy', '--project', PROJECT, '--config', rollbackConfig, '--only', 'firestore:rules', '--non-interactive']
  throw new Error('unknown kind')
}

/** Resolves the executable and full argv for a profile. Never a shell. */
export function commandFor(profile, kind, rollbackConfig, env = process.env) {
  const stubVars = Object.keys(env).filter(k => k.toUpperCase().startsWith('M1_STUB_'))
  if (profile === 'staging') {
    if (stubVars.length) throw new Error('stub environment present in staging profile')
    for (const [k, v] of Object.entries(env)) {
      const key = k.toUpperCase()
      if (v && (/EMULATOR/.test(key) || ['FIREBASE_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED'].includes(key))) throw new Error(`forbidden environment ${key}`)
    }
    return { file: process.execPath, args: [path.join(REPO, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'), ...deployArgs(kind, rollbackConfig)] }
  }
  if (profile === 'rehearsal') {
    if (!env.M1_STUB_SCENARIO || !env.M1_STUB_STATE) throw new Error('rehearsal profile requires M1_STUB_SCENARIO and M1_STUB_STATE')
    return { file: process.execPath, args: ['--require', path.join(HERE, 'stubs', 'no-network.cjs'), path.join(HERE, 'stubs', 'stub-firebase.mjs'), ...deployArgs(kind, rollbackConfig)] }
  }
  throw new Error('unknown profile')
}

/** Rules bytes a kind is allowed to publish, checked against the pinned expected state. */
export function checkDeploySource(kind, expected, { repo = REPO, rollbackConfig } = {}) {
  if (validateExpected(expected).length) throw new Error('expected-state file')
  if (kind === 'rules') {
    const rules = fs.readFileSync(path.join(repo, 'firestore.rules'))
    if (sha(rules) !== expected.rulesTarget.rawSha256 || rules.length !== expected.rulesTarget.sourceBytes || canonicalOf(rules.toString('utf8')) !== expected.rulesTarget.canonicalSha256) throw new Error('repository firestore.rules is not the pinned round-3 Rules')
    const config = JSON.parse(fs.readFileSync(path.join(repo, 'firebase.json'), 'utf8'))
    if (config?.firestore?.rules !== 'firestore.rules') throw new Error('repository firebase.json does not point at firestore.rules')
    return
  }
  const dir = path.dirname(rollbackConfig)
  const rules = fs.readFileSync(path.join(dir, 'firestore.rules'))
  if (sha(rules) !== expected.rulesPre.rawSha256 || rules.length !== expected.rulesPre.sourceBytes || canonicalOf(rules.toString('utf8')) !== expected.rulesPre.canonicalSha256) throw new Error('rollback rules are not the pinned pre-release Rules')
  const config = JSON.parse(fs.readFileSync(rollbackConfig, 'utf8'))
  if (JSON.stringify(config) !== JSON.stringify({ firestore: { rules: 'firestore.rules' } })) throw new Error('rollback firebase.json is not the Rules-only config')
  if (fs.readdirSync(dir).sort().join(',') !== 'firebase.json,firestore.rules') throw new Error('rollback directory holds unexpected files')
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
if (isMain) {
  const argv = process.argv.slice(2)
  const o = {}
  const allowed = ['--profile', '--kind', '--expected-head', '--out-dir', '--rollback-config']
  try {
    if (argv.length % 2) throw new Error('usage')
    for (let i = 0; i < argv.length; i += 2) {
      if (!allowed.includes(argv[i]) || Object.hasOwn(o, argv[i])) throw new Error('usage')
      o[argv[i]] = argv[i + 1]
    }
    const kind = o['--kind']
    if (!Object.hasOwn(KINDS, kind)) throw new Error('unknown kind: the R3 release deploys nothing except the Rules and the Rules rollback')
    if ((kind === 'rules') === Object.hasOwn(o, '--rollback-config')) throw new Error('--rollback-config is required for rules-rollback and forbidden for rules')
    if (o['--expected-head'] !== EXPECTED_HEAD) throw new Error('expected head mismatch')
    const git = gitState()
    if (git.head !== EXPECTED_HEAD || git.status !== '') throw new Error('repository not clean at expected head')
    const outDir = o['--out-dir']
    if (typeof outDir !== 'string' || !path.isAbsolute(outDir) || !fs.existsSync(path.dirname(outDir))) throw new Error('out-dir must be a new absolute path with existing parent')
    const rollbackConfig = o['--rollback-config']
    if (kind === 'rules-rollback') {
      if (typeof rollbackConfig !== 'string' || !path.isAbsolute(rollbackConfig) || !ROLLBACK_CONFIG.test(rollbackConfig) || !fs.existsSync(rollbackConfig)) throw new Error('rollback config invalid')
      if (path.dirname(path.dirname(path.resolve(rollbackConfig))).toLowerCase() !== path.dirname(path.resolve(outDir)).toLowerCase()) throw new Error('rollback config and out-dir must share the evidence directory')
    }
    checkDeploySource(kind, JSON.parse(fs.readFileSync(path.join(HERE, 'expected-state-r3.json'), 'utf8')), { rollbackConfig })
    const { file, args } = commandFor(o['--profile'], kind, rollbackConfig)

    // Run-once guard: exclusive out-dir.
    fs.mkdirSync(outDir)

    const open = name => fs.openSync(path.join(outDir, name), 'wx', 0o600)
    const fds = { stdout: open('stdout.log'), stderr: open('stderr.log'), combined: open('combined.log') }
    const hashes = { stdout: createHash('sha256'), stderr: createHash('sha256'), combined: createHash('sha256') }
    const bytes = { stdout: 0, stderr: 0 }
    const firstBytes = { stdout: null, stderr: null }
    const startedAt = new Date().toISOString()
    const child = spawn(file, args, { cwd: REPO, env: { ...process.env }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const sink = stream => chunk => {
      if (firstBytes[stream] === null) firstBytes[stream] = chunk.subarray(0, 3).toString('hex')
      fs.writeSync(fds[stream], chunk); hashes[stream].update(chunk); bytes[stream] += chunk.length
      fs.writeSync(fds.combined, chunk); hashes.combined.update(chunk)
    }
    child.stdout.on('data', sink('stdout'))
    child.stderr.on('data', sink('stderr'))
    child.on('error', error => { finish(null, null, `spawn failed: ${error.code ?? error.message}`) })
    child.on('close', (code, signal) => finish(code, signal, null))
    let done = false
    function finish(code, signal, spawnError) {
      if (done) return
      done = true
      for (const fd of Object.values(fds)) { fs.fsyncSync(fd); fs.closeSync(fd) }
      const record = {
        kind, profile: o['--profile'], project: PROJECT, head: EXPECTED_HEAD,
        executable: path.basename(file), argv: args.map(a => (path.isAbsolute(a) ? path.basename(a) : a)),
        exitCode: code, signal, spawnError, startedAt, finishedAt: new Date().toISOString(),
        stdoutBytes: bytes.stdout, stderrBytes: bytes.stderr,
        stdoutStartsWithBom: firstBytes.stdout === 'efbbbf', stderrStartsWithBom: firstBytes.stderr === 'efbbbf',
        sha256: { stdout: hashes.stdout.digest('hex'), stderr: hashes.stderr.digest('hex'), combined: hashes.combined.digest('hex') },
      }
      const fd = fs.openSync(path.join(outDir, 'exit.json'), 'wx', 0o600)
      fs.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`); fs.fsyncSync(fd); fs.closeSync(fd)
      console.log(`M1_DEPLOY_RECORDED kind=${kind} exitCode=${code} stdoutBytes=${bytes.stdout} stderrBytes=${bytes.stderr}`)
      process.exitCode = spawnError ? 3 : 0
    }
  } catch (e) {
    console.log(`M1_DEPLOY_WRAPPER_STOP ${e.code === 'EEXIST' ? 'already attempted (out-dir exists)' : e.message}`)
    process.exitCode = 2
  }
}
