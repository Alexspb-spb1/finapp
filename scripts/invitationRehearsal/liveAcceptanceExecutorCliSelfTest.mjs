import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { LIVE_EXECUTOR_MISSING_ADAPTERS } from './liveAcceptanceExecutorAdapters.mjs'
import {
  approvalCommandSha256, executeApprovedLiveRuntime, parseExecutorCliArgs, routeExecutorCli, validateCleanExecutorHead,
  validateExecutionApproval, validatePrivateExecutorPaths,
} from './liveAcceptanceExecutorCliCore.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const head = 'a'.repeat(40)

function removeTemporary(base) {
  const resolved = fs.realpathSync(base)
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('finapp-executor-cli-')) throw new Error('temporary_path')
  fs.rmSync(resolved, { recursive: true, force: true })
}

function pathsAndArgs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finapp-executor-cli-'))
  const repoRoot = path.join(base, 'repo'), privateRoot = path.join(base, 'private')
  fs.mkdirSync(repoRoot); fs.mkdirSync(privateRoot)
  const approval = path.join(privateRoot, 'approval.json'), journal = path.join(privateRoot, 'journal.jsonl'), out = path.join(privateRoot, 'out.json')
  const args = ['--execute', '--project', 'finapp-staging', '--expected-head', head,
    '--approval', approval, '--approval-sha256', h('placeholder'), '--journal', journal, '--out', out]
  return { base, repoRoot, privateRoot, approval, journal, out, args }
}

test('CLI approval binds exact bytes, clean HEAD and new external output paths', () => {
  const fixture = pathsAndArgs()
  try {
    const preliminary = parseExecutorCliArgs(fixture.args)
    const approvedAt = '2026-09-08T12:00:00.000Z', expiresAt = '2026-09-08T13:00:00.000Z'
    const approval = {
      version: 1, task: 'SEC-006 Stage 8 live acceptance execution', status: 'APPROVED', project: 'finapp-staging',
      sourceHead: head, prHead: head, reviewStatus: 'PASS', ciStatus: 'PASS', functionsStatus: 'PASS',
      approvedAt, expiresAt, commandSha256: approvalCommandSha256(preliminary), mailboxSha256: h('subject'),
      functionsSha256: h('functions'), authMetadataSha256: h('auth'), stagingFingerprint: h('build'),
      limits: { fixtureMutationSlots: 16, totalCallableRequests: 40, verificationEmails: 1,
        cleanupAuthorized: false, productionAuthorized: false },
    }
    const bytes = Buffer.from(`${JSON.stringify(approval, null, 2)}\n`)
    fs.writeFileSync(fixture.approval, bytes, { flag: 'wx', mode: 0o600 })
    const args = [...fixture.args]
    args[args.indexOf('--approval-sha256') + 1] = h(bytes)
    const parsed = parseExecutorCliArgs(args)
    const resolved = validatePrivateExecutorPaths({ parsed, repoRoot: fixture.repoRoot, io: fs })
    assert.equal(resolved['--journal'], fixture.journal)
    assert.equal(resolved.recovery, `${fixture.out}.recovery.jsonl`)
    assert.equal(validateExecutionApproval({ parsed, bytes, now: () => Date.parse('2026-09-08T12:30:00.000Z') }).status, 'APPROVED')
    assert.throws(() => validateExecutionApproval({ parsed, bytes, now: () => Date.parse(expiresAt) }))
    assert.equal(validateCleanExecutorHead({ parsed, gitState: { head, status: '' } }), true)
    assert.throws(() => validateExecutionApproval({ parsed, bytes: Buffer.concat([bytes, Buffer.from(' ')]), now: () => Date.parse('2026-09-08T12:30:00.000Z') }))
    const twoHourBytes = Buffer.from(`${JSON.stringify({ ...approval, expiresAt: '2026-09-08T14:00:00.000Z' }, null, 2)}\n`)
    const twoHourArgs = [...args]
    twoHourArgs[twoHourArgs.indexOf('--approval-sha256') + 1] = h(twoHourBytes)
    assert.throws(() => validateExecutionApproval({ parsed: parseExecutorCliArgs(twoHourArgs), bytes: twoHourBytes,
      now: () => Date.parse('2026-09-08T12:30:00.000Z') }))
    assert.throws(() => validateCleanExecutorHead({ parsed, gitState: { head, status: ' M file' } }))
    fs.writeFileSync(fixture.journal, '')
    assert.throws(() => validatePrivateExecutorPaths({ parsed, repoRoot: fixture.repoRoot, io: fs }))
  } finally { removeTemporary(fixture.base) }
})

test('CLI rejects an existing or colliding deterministic recovery checkpoint', () => {
  const fixture = pathsAndArgs()
  try {
    let parsed = parseExecutorCliArgs(fixture.args)
    fs.writeFileSync(`${fixture.out}.recovery.jsonl`, '')
    assert.throws(() => validatePrivateExecutorPaths({ parsed, repoRoot: fixture.repoRoot, io: fs }))
    fs.rmSync(`${fixture.out}.recovery.jsonl`)

    const collidingArgs = [...fixture.args]
    collidingArgs[collidingArgs.indexOf('--journal') + 1] = `${fixture.out}.recovery.jsonl`
    parsed = parseExecutorCliArgs(collidingArgs)
    assert.throws(() => validatePrivateExecutorPaths({ parsed, repoRoot: fixture.repoRoot, io: fs }))

    const inCheckoutOut = path.join(fixture.repoRoot, 'out.json')
    const inCheckoutArgs = [...fixture.args]
    inCheckoutArgs[inCheckoutArgs.indexOf('--out') + 1] = inCheckoutOut
    parsed = parseExecutorCliArgs(inCheckoutArgs)
    assert.throws(() => validatePrivateExecutorPaths({ parsed, repoRoot: fixture.repoRoot, io: fs }))
  } finally { removeTemporary(fixture.base) }
})

test('live bindings remain statically allowlisted and complete after Auth shape discovery', () => {
  assert.deepEqual(LIVE_EXECUTOR_MISSING_ADAPTERS, [])
})

test('router isolates help, invalid args and self-test before execution', async () => {
  const calls = []
  const handlers = {
    writeHelp: async () => { calls.push('help') },
    runSelfTests: async () => { calls.push('self-test'); return 7 },
    execute: async parsed => { calls.push(['execute', parsed]); return 3 },
  }
  assert.equal(await routeExecutorCli({ args: ['--help'], ...handlers }), 0)
  assert.deepEqual(calls, ['help'])
  calls.length = 0
  assert.equal(await routeExecutorCli({ args: ['--self-test'], ...handlers }), 7)
  assert.deepEqual(calls, ['self-test'])
  calls.length = 0
  await assert.rejects(() => routeExecutorCli({ args: ['--execute'], ...handlers }))
  assert.deepEqual(calls, [])
})

test('approved runtime stays unloaded behind missing marker and runs once when empty', async () => {
  const fixture = pathsAndArgs()
  try {
    const preliminary = parseExecutorCliArgs(fixture.args)
    const approval = { version: 1, task: 'SEC-006 Stage 8 live acceptance execution', status: 'APPROVED', project: 'finapp-staging',
      sourceHead: head, prHead: head, reviewStatus: 'PASS', ciStatus: 'PASS', functionsStatus: 'PASS',
      approvedAt: '2026-09-08T12:00:00.000Z', expiresAt: '2026-09-08T13:00:00.000Z',
      commandSha256: approvalCommandSha256(preliminary), mailboxSha256: h('subject'), functionsSha256: h('functions'),
      authMetadataSha256: h('auth'), stagingFingerprint: h('build'), limits: { fixtureMutationSlots: 16,
        totalCallableRequests: 40, verificationEmails: 1, cleanupAuthorized: false, productionAuthorized: false } }
    const bytes = Buffer.from(`${JSON.stringify(approval)}\n`)
    fs.writeFileSync(fixture.approval, bytes, { flag: 'wx', mode: 0o600 })
    const args = [...fixture.args]; args[args.indexOf('--approval-sha256') + 1] = h(bytes)
    const parsed = parseExecutorCliArgs(args)
    let loads = 0, runs = 0
    let headReads = 0
    const base = { parsed, repoRoot: fixture.repoRoot, io: fs, gitState: async () => { headReads++; return { head, status: '' } },
      now: () => Date.parse('2026-09-08T12:30:00.000Z') }
    const stopped = await executeApprovedLiveRuntime({ ...base, missingAdapters: ['auth-shape'], loadRuntime: async () => { loads++; return {} } })
    assert.equal(stopped.status, 'ADAPTERS_INCOMPLETE'); assert.equal(loads, 0)
    const complete = await executeApprovedLiveRuntime({ ...base, missingAdapters: [], loadRuntime: async () => { loads++; return {
      run: async value => { runs++; assert.equal(value.approval.mailboxSha256, h('subject')); await value.recheckHead(); return { status: 'LIVE_ACCEPTANCE_VERIFIED' } },
    } } })
    assert.equal(complete.exitCode, 0); assert.equal(loads, 1); assert.equal(runs, 1); assert.equal(headReads, 4)
  } finally { removeTemporary(fixture.base) }
})
