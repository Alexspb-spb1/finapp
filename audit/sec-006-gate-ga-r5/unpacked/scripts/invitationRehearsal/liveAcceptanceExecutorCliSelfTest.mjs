import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { LIVE_EXECUTOR_MISSING_ADAPTERS } from './liveAcceptanceExecutorAdapters.mjs'
import {
  GATE_GA_TASK, approvalCommandSha256, executeApprovedLiveRuntime, parseExecutorCliArgs, routeExecutorCli,
  validateCleanExecutorHead, validateExecutionApproval, validatePrivateExecutorPaths,
} from './liveAcceptanceExecutorCliCore.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const head = 'a'.repeat(40)

function removeTemporary(base) {
  const resolved = fs.realpathSync(base)
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('finapp-executor-cli-')) throw new Error('temporary_path')
  fs.rmSync(resolved, { recursive: true, force: true })
}

function pathsAndArgs(overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finapp-executor-cli-'))
  const repoRoot = path.join(base, 'repo'), privateRoot = path.join(base, 'private')
  fs.mkdirSync(repoRoot); fs.mkdirSync(privateRoot)
  const approval = path.join(privateRoot, 'approval.json'), journal = path.join(privateRoot, 'journal.jsonl'), out = path.join(privateRoot, 'out.json')
  const args = ['--execute', '--profile', 'staging', '--project', 'finapp-staging', '--expected-head', head,
    '--approval', approval, '--approval-sha256', h('placeholder'), '--journal', journal, '--out', out,
    '--recipient', 'owner-confirmed@example.invalid', '--recipient-confirmed-sha256', h('owner-confirmed@example.invalid'),
    ...(overrides.extraArgs ?? [])]
  return { base, repoRoot, privateRoot, approval, journal, out, args }
}

function gateGaApproval(preliminary, overrides = {}) {
  return {
    version: 1, task: GATE_GA_TASK, status: 'APPROVED', profile: 'staging', project: 'finapp-staging',
    sourceHead: head, prHead: head, reviewStatus: 'PASS', ciStatus: 'PASS', functionsStatus: 'PASS',
    approvedAt: '2026-09-08T12:00:00.000Z', expiresAt: '2026-09-08T13:00:00.000Z',
    commandSha256: approvalCommandSha256(preliminary), mailboxSha256: h('subject'),
    functionsSha256: h('functions'), authMetadataSha256: h('auth'), stagingFingerprint: h('build'),
    limits: { fixtureMutationSlots: 16, totalCallableRequests: 40, verificationEmails: 1,
      cleanupAuthorized: true, legacyCleanupRequiresSeparateConfirmation: true, productionAuthorized: false },
    ...overrides,
  }
}

test('CLI approval binds exact bytes, clean HEAD, new external output paths and the confirmed recipient', () => {
  const fixture = pathsAndArgs()
  try {
    const preliminary = parseExecutorCliArgs(fixture.args)
    const approval = gateGaApproval(preliminary)
    const bytes = Buffer.from(`${JSON.stringify(approval, null, 2)}\n`)
    fs.writeFileSync(fixture.approval, bytes, { flag: 'wx', mode: 0o600 })
    const args = [...fixture.args]
    args[args.indexOf('--approval-sha256') + 1] = h(bytes)
    const parsed = parseExecutorCliArgs(args)
    const resolved = validatePrivateExecutorPaths({ parsed, repoRoot: fixture.repoRoot, io: fs })
    assert.equal(resolved['--journal'], fixture.journal)
    assert.equal(resolved.recovery, `${fixture.out}.recovery.jsonl`)
    assert.equal(validateExecutionApproval({ parsed, bytes, now: () => Date.parse('2026-09-08T12:30:00.000Z') }).status, 'APPROVED')
    assert.throws(() => validateExecutionApproval({ parsed, bytes, now: () => Date.parse(approval.expiresAt) }))
    assert.equal(validateCleanExecutorHead({ parsed, gitState: { head, status: '' } }), true)
    assert.throws(() => validateExecutionApproval({ parsed, bytes: Buffer.concat([bytes, Buffer.from(' ')]), now: () => Date.parse('2026-09-08T12:30:00.000Z') }))

    // An approval bound to a DIFFERENT confirmed recipient hash must be refused.
    const otherRecipientArgs = [...fixture.args]
    otherRecipientArgs[otherRecipientArgs.indexOf('--recipient-confirmed-sha256') + 1] = h('someone-else@example.invalid')
    const otherParsed = parseExecutorCliArgs(otherRecipientArgs)
    assert.throws(() => validateExecutionApproval({ parsed: otherParsed, bytes, now: () => Date.parse('2026-09-08T12:30:00.000Z') }))

    assert.throws(() => validateCleanExecutorHead({ parsed, gitState: { head, status: ' M file' } }))
    fs.writeFileSync(fixture.journal, '')
    assert.throws(() => validatePrivateExecutorPaths({ parsed, repoRoot: fixture.repoRoot, io: fs }))
  } finally { removeTemporary(fixture.base) }
})

test('the historical CLEANUP_PLAN_ONLY approval shape is structurally rejected (different task, cleanupAuthorized inverted)', () => {
  const fixture = pathsAndArgs()
  try {
    const preliminary = parseExecutorCliArgs(fixture.args)
    const historical = {
      version: 1, task: 'SEC-006 Stage 8 live acceptance execution', status: 'APPROVED', profile: 'staging', project: 'finapp-staging',
      sourceHead: head, prHead: head, reviewStatus: 'PASS', ciStatus: 'PASS', functionsStatus: 'PASS',
      approvedAt: '2026-09-08T12:00:00.000Z', expiresAt: '2026-09-08T13:00:00.000Z',
      commandSha256: approvalCommandSha256(preliminary), mailboxSha256: h('subject'), functionsSha256: h('functions'),
      authMetadataSha256: h('auth'), stagingFingerprint: h('build'),
      limits: { fixtureMutationSlots: 16, totalCallableRequests: 40, verificationEmails: 1, cleanupAuthorized: false, productionAuthorized: false },
    }
    const bytes = Buffer.from(`${JSON.stringify(historical)}\n`)
    fs.writeFileSync(fixture.approval, bytes, { flag: 'wx', mode: 0o600 })
    const args = [...fixture.args]; args[args.indexOf('--approval-sha256') + 1] = h(bytes)
    const parsed = parseExecutorCliArgs(args)
    assert.throws(() => validateExecutionApproval({ parsed, bytes, now: () => Date.parse('2026-09-08T12:30:00.000Z') }))

    // Same task name, but cleanupAuthorized still false — also rejected.
    const wrongPolarity = { ...gateGaApproval(preliminary), limits: { ...gateGaApproval(preliminary).limits, cleanupAuthorized: false } }
    const wrongBytes = Buffer.from(`${JSON.stringify(wrongPolarity)}\n`)
    const wrongArgs = [...fixture.args]; wrongArgs[wrongArgs.indexOf('--approval-sha256') + 1] = h(wrongBytes)
    assert.throws(() => validateExecutionApproval({ parsed: parseExecutorCliArgs(wrongArgs), bytes: wrongBytes, now: () => Date.parse('2026-09-08T12:30:00.000Z') }))
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

test('parseExecutorCliArgs enforces the profile/project pairing and rejects a mismatched or unknown profile', () => {
  const fixture = pathsAndArgs()
  try {
    assert.ok(parseExecutorCliArgs(fixture.args))
    const emulatorMismatch = [...fixture.args]
    emulatorMismatch[emulatorMismatch.indexOf('--project') + 1] = 'demo-finapp'
    assert.throws(() => parseExecutorCliArgs(emulatorMismatch)) // profile=staging with demo-finapp

    const unknownProfile = [...fixture.args]
    unknownProfile[unknownProfile.indexOf('--profile') + 1] = 'production'
    assert.throws(() => parseExecutorCliArgs(unknownProfile))

    const emulatorArgs = [...fixture.args]
    emulatorArgs[emulatorArgs.indexOf('--profile') + 1] = 'emulator'
    emulatorArgs[emulatorArgs.indexOf('--project') + 1] = 'demo-finapp'
    assert.ok(parseExecutorCliArgs(emulatorArgs))
  } finally { removeTemporary(fixture.base) }
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

test('approved runtime stays unloaded behind missing marker, reports PASS and reports SAFE_STOP without throwing', async () => {
  const fixture = pathsAndArgs()
  try {
    const preliminary = parseExecutorCliArgs(fixture.args)
    const approval = gateGaApproval(preliminary)
    const bytes = Buffer.from(`${JSON.stringify(approval)}\n`)
    fs.writeFileSync(fixture.approval, bytes, { flag: 'wx', mode: 0o600 })
    const args = [...fixture.args]; args[args.indexOf('--approval-sha256') + 1] = h(bytes)
    const parsed = parseExecutorCliArgs(args)
    let loads = 0, runs = 0, headReads = 0
    const base = { parsed, repoRoot: fixture.repoRoot, io: fs, gitState: async () => { headReads++; return { head, status: '' } },
      now: () => Date.parse('2026-09-08T12:30:00.000Z') }
    const stopped = await executeApprovedLiveRuntime({ ...base, missingAdapters: ['auth-shape'], loadRuntime: async () => { loads++; return {} } })
    assert.equal(stopped.status, 'ADAPTERS_INCOMPLETE'); assert.equal(loads, 0)

    const passResult = await executeApprovedLiveRuntime({ ...base, missingAdapters: [], loadRuntime: async () => { loads++; return {
      run: async value => { runs++; assert.equal(value.approval.mailboxSha256, h('subject')); await value.recheckHead(); return { status: 'PASS' } },
    } } })
    assert.equal(passResult.exitCode, 0); assert.equal(passResult.status, 'PASS'); assert.equal(loads, 1); assert.equal(runs, 1)

    const stopResult = await executeApprovedLiveRuntime({ ...base, missingAdapters: [], loadRuntime: async () => ({
      run: async () => ({ status: 'SAFE_STOP', reason: 'READINESS_NOT_SATISFIED' }),
    }) })
    // A SAFE_STOP is reported, not thrown — cleanup for the current run has
    // already been attempted by the orchestrator before this returns.
    assert.equal(stopResult.exitCode, 1); assert.equal(stopResult.status, 'SAFE_STOP')

    await assert.rejects(() => executeApprovedLiveRuntime({ ...base, missingAdapters: [], loadRuntime: async () => ({
      run: async () => ({ status: 'SOMETHING_ELSE' }),
    }) }))
    assert.ok(headReads >= 6, `expected multiple HEAD rechecks across the four calls, got ${headReads}`)
  } finally { removeTemporary(fixture.base) }
})
