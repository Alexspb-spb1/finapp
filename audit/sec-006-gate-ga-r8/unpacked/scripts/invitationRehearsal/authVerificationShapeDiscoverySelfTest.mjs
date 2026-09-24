import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { parseAuthShapeDiscoveryArgs, runAuthVerificationShapeDiscovery } from './authVerificationShapeDiscoveryCore.mjs'

const h = value => createHash('sha256').update(value).digest('hex')
const head = 'a'.repeat(40)
const discovered = Object.freeze({
  emailPasswordEnabled: true, userSignupDisabled: false, verificationMethodPresent: true,
  verificationTemplateMetadataPresent: true, callbackDomainPresent: true, metadataSha256: h('auth-shape'),
})
function removeTemporary(base) {
  const resolved = fs.realpathSync(base), temp = fs.realpathSync(os.tmpdir())
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('finapp-auth-shape-')) throw new Error('temporary_path')
  fs.rmSync(resolved, { recursive: true, force: true })
}

function setup(t, override = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finapp-auth-shape-'))
  const repoRoot = path.join(base, 'repo'), privateRoot = path.join(base, 'private')
  fs.mkdirSync(repoRoot); fs.mkdirSync(privateRoot)
  t.after(() => removeTemporary(base))
  const output = path.join(privateRoot, 'receipt.json')
  const args = ['--project', 'finapp-staging', '--expected-head', head, '--out', output]
  const calls = []
  const options = {
    args, repoRoot,
    gitState: async () => { calls.push('git'); return { head, status: '' } },
    loadRuntime: async () => {
      calls.push('load-runtime')
      return {
        openSession: async gates => { calls.push(['open-session', gates]); return Object.freeze({ project: 'finapp-staging', authenticated: true }) },
        discover: async session => { calls.push(['discover', session.project]); return { ...discovered } },
      }
    },
    now: () => '2026-09-08T12:00:00.000Z', io: fs,
    ...override,
  }
  return { base, repoRoot, privateRoot, output, args, calls, options }
}

test('exact local gates precede guarded session and receipt contains only safe shape metadata', async t => {
  const originalFetch = globalThis.fetch
  let networkCalls = 0, fsyncs = 0
  globalThis.fetch = async () => { networkCalls++; throw new Error('network_forbidden') }
  t.after(() => { globalThis.fetch = originalFetch })
  const io = new Proxy(fs, { get(target, property) {
    if (property === 'fsyncSync') return descriptor => { fsyncs++; return target.fsyncSync(descriptor) }
    return Reflect.get(target, property)
  } })
  const value = setup(t, { io })
  const result = await runAuthVerificationShapeDiscovery(value.options)
  assert.equal(networkCalls, 0); assert.equal(fsyncs, 1)
  assert.deepEqual(value.calls, ['git', 'load-runtime', ['open-session', { approvalValidated: true, localGatesValidated: true }],
    ['discover', 'finapp-staging'], 'git'])
  assert.deepEqual(result.receipt, {
    task: 'SEC-006 Stage 8 Auth verification-template shape discovery',
    status: 'AUTH_VERIFICATION_TEMPLATE_SHAPE_DISCOVERED', project: 'finapp-staging', sourceHead: head,
    observedAt: '2026-09-08T12:00:00.000Z', emailPasswordEnabled: true, userSignupDisabled: false,
    verificationMethodPresent: true, verificationTemplateMetadataPresent: true,
    callbackDomainPresent: true, metadataSha256: h('auth-shape'),
  })
  const bytes = fs.readFileSync(value.output)
  assert.equal(bytes.at(-1), 10)
  assert.deepEqual(JSON.parse(bytes), result.receipt)
  assert.equal(JSON.stringify(result.receipt).includes('@'), false)
  for (const forbidden of ['templateBody', 'headers', 'idToken', 'refreshToken', 'oobCode', 'Bearer']) assert.equal(JSON.stringify(result.receipt).includes(forbidden), false)
})

test('invalid args, dirty HEAD and non-external output stop before runtime load', async t => {
  for (const mutate of [
    value => { value.options.args = ['--project', 'finapp-prod-10a83', '--expected-head', head, '--out', value.output] },
    value => { value.options.args = ['--project', 'finapp-staging', '--expected-head', 'bad', '--out', value.output] },
    value => { value.options.args = ['--project', 'finapp-staging', '--expected-head', head, '--out', path.join(value.repoRoot, 'receipt.json')] },
    value => { value.options.gitState = async () => ({ head, status: ' M src/file.ts' }) },
    value => { value.options.gitState = async () => ({ head: 'b'.repeat(40), status: '' }) },
  ]) {
    const value = setup(t)
    mutate(value)
    let loaded = 0
    value.options.loadRuntime = async () => { loaded++; throw new Error('must-not-load') }
    await assert.rejects(() => runAuthVerificationShapeDiscovery(value.options))
    assert.equal(loaded, 0)
    assert.equal(fs.existsSync(value.output), false)
  }
})

test('existing output, unsafe runtime shape and provider metadata leakage fail closed', async t => {
  const existing = setup(t)
  fs.writeFileSync(existing.output, 'preserve')
  await assert.rejects(() => runAuthVerificationShapeDiscovery(existing.options))
  assert.equal(fs.readFileSync(existing.output, 'utf8'), 'preserve')
  assert.deepEqual(existing.calls, [])

  const badRuntime = setup(t, { loadRuntime: async () => ({ openSession: async () => ({}) }) })
  await assert.rejects(() => runAuthVerificationShapeDiscovery(badRuntime.options))
  assert.equal(fs.existsSync(badRuntime.output), false)

  for (const bad of [
    { ...discovered, templateBody: '<html>private</html>' },
    { ...discovered, metadataSha256: 'bad' },
    { ...discovered, verificationTemplateMetadataPresent: false },
  ]) {
    const value = setup(t)
    value.options.loadRuntime = async () => ({ openSession: async () => ({}), discover: async () => bad })
    await assert.rejects(() => runAuthVerificationShapeDiscovery(value.options))
    assert.equal(fs.existsSync(value.output), false)
  }
})

test('HEAD drift after read-only discovery blocks receipt creation', async t => {
  const value = setup(t)
  let checks = 0
  value.options.gitState = async () => ({ head: checks++ === 0 ? head : 'b'.repeat(40), status: '' })
  await assert.rejects(() => runAuthVerificationShapeDiscovery(value.options))
  assert.equal(fs.existsSync(value.output), false)
  assert.equal(value.calls.includes('load-runtime'), true)
})

test('parser accepts only the exact three arguments once', () => {
  const output = path.resolve(os.tmpdir(), 'auth-shape-receipt.json')
  assert.deepEqual(parseAuthShapeDiscoveryArgs(['--out', output, '--expected-head', head, '--project', 'finapp-staging']), {
    '--out': output, '--expected-head': head, '--project': 'finapp-staging',
  })
  assert.throws(() => parseAuthShapeDiscoveryArgs(['--project', 'finapp-staging', '--project', 'finapp-staging', '--out', output]))
  assert.throws(() => parseAuthShapeDiscoveryArgs(['--project', 'finapp-staging', '--expected-head', head, '--out', output, '--extra', 'x']))
})
