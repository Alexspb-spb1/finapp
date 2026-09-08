import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CALLABLE_CAPS, FIXTURE_MUTATION_SLOT_SPECS, appendJournalEvent } from './liveAcceptanceCore.mjs'
import {
  classifyLiveBrowserRequest, createLiveBrowserRequestBinder, validateEndpointShapeReceipt,
} from './liveAcceptanceBrowserCore.mjs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createEndpointShapeRecorder, sanitizeRequestShape } = require('../browser/stage8-endpoint-shapes.cjs')
const h = value => createHash('sha256').update(value).digest('hex')
const fingerprint = h('six-field-staging-config')
const apiKey = 'private-test-key'
const apiKeySha256 = h(apiKey)
const at = '2026-09-08T00:00:00.000Z'

const add = (events, status, details) => [...appendJournalEvent(events, { seq: events.length, status, at, details })]
const bytes = events => `${events.map(JSON.stringify).join('\n')}\n`
function stableJournal(progress = 0) {
  let events = []
  const counts = Object.fromEntries(Object.keys(CALLABLE_CAPS).map(name => [name, 0]))
  let totalCallableCount = 0
  events = add(events, 'PRECONDITIONS_VERIFIED', {})
  events = add(events, 'PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED', { envelopeSha256: h('envelope') })
  events = add(events, 'SCENARIOS_RUNNING', {})
  for (let index = 0; index < progress; index++) {
    const spec = FIXTURE_MUTATION_SLOT_SPECS[index]
    const callableCount = spec.callable === null ? null : ++counts[spec.callable]
    if (spec.callable !== null) totalCallableCount++
    events = add(events, 'FIXTURE_MUTATION_MAY_BE_SENT', {
      index, slot: spec.slot, callCount: index + 1, callable: spec.callable,
      callableCount, totalCallableCount, requestSha256: h(`request-${index}`),
    })
    events = add(events, 'FIXTURE_MUTATION_RECONCILED', { index, slot: spec.slot, callCount: index + 1,
      callable: spec.callable, callableCount, totalCallableCount, disposition: spec.disposition,
      outcomeSha256: h(`outcome-${index}`), readbackSha256: h(`readback-${index}`) })
  }
  return events
}

function localReceipt() {
  const recorder = createEndpointShapeRecorder()
  recorder.observe('http://127.0.0.1:5176/finapp/assets/app.js', 'GET')
  recorder.observe('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=private-not-retained', 'POST')
  recorder.observe('http://127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fdemo-finapp%2Fdatabases%2F(default)&VER=8&RID=rpc', 'POST')
  recorder.observe('http://127.0.0.1:5001/demo-finapp/us-central1/previewInvite', 'POST')
  return recorder.receipt()
}

test('local recorder emits only sanitized endpoint shapes', () => {
  const receipt = localReceipt(), serialized = JSON.stringify(receipt)
  assert.equal(serialized.includes('private-not-retained'), false)
  assert.equal(serialized.includes('rpc'), false)
  assert.equal(validateEndpointShapeReceipt(receipt).shapeCount, 4)
  assert.throws(() => sanitizeRequestShape('http://127.0.0.1:5001/finapp-prod/us-central1/previewInvite', 'POST'))
  assert.throws(() => validateEndpointShapeReceipt({ ...receipt, liveRequests: 1 }))
  assert.equal(sanitizeRequestShape('http://127.0.0.1:5176/finapp/assets/private.opaque-extension', 'GET').operation, 'route')
  const harness = readFileSync('scripts/browser/stage8-rehearsal.cjs', 'utf8')
  assert.ok(harness.indexOf("[...tokens].some(token => request.url().includes(token))") < harness.indexOf('endpointShapeRecorder.observe(request.url(), request.method())'))
})

test('live browser classifier permits exact staging static/auth/functions/WebChannel only', () => {
  assert.equal(classifyLiveBrowserRequest('GET', 'http://127.0.0.1:5177/finapp/assets/app.js').kind, 'static')
  assert.equal(classifyLiveBrowserRequest('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=private-test-key').operation, 'accounts:signInWithPassword')
  assert.equal(classifyLiveBrowserRequest('POST', 'https://us-central1-finapp-staging.cloudfunctions.net/previewInvite').operation, 'previewInvite')
  assert.equal(classifyLiveBrowserRequest('OPTIONS', 'https://us-central1-finapp-staging.cloudfunctions.net/previewInvite').kind, 'preflight')
  assert.equal(classifyLiveBrowserRequest('POST', 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=projects%2Ffinapp-staging%2Fdatabases%2F(default)&VER=8').kind, 'firestore-webchannel')
  assert.equal(classifyLiveBrowserRequest('GET', 'https://api.exchangerate-api.com/v6/redacted/latest/RUB').kind, 'blocked-external')
  for (const [method, url] of [
    ['GET', 'https://example.com/'],
    ['POST', 'https://us-central1-finapp-prod-10a83.cloudfunctions.net/previewInvite'],
    ['POST', 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=projects%2Ffinapp-prod-10a83%2Fdatabases%2F(default)&VER=8'],
    ['POST', 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=a&extra=b'],
    ['POST', 'https://identitytoolkit.googleapis.com/v1/accounts:update?key=private-test-key'],
    ['POST', 'https://identitytoolkit.googleapis.com/v1/accounts:delete?key=private-test-key'],
    ['POST', 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Write/channel?database=projects%2Ffinapp-staging%2Fdatabases%2F(default)&VER=8'],
  ]) assert.throws(() => classifyLiveBrowserRequest(method, url))
  const identityPaths = ['accounts:signUp', 'accounts:signInWithPassword', 'accounts:lookup', 'accounts:sendOobCode']
  for (const method of ['POST', 'OPTIONS']) {
    for (const operation of identityPaths) {
      assert.equal(classifyLiveBrowserRequest(method, `https://identitytoolkit.googleapis.com/v1/${operation}?key=private-test-key`).operation, operation)
      assert.throws(() => classifyLiveBrowserRequest(method, `https://securetoken.googleapis.com/v1/${operation}?key=private-test-key`))
    }
    assert.equal(classifyLiveBrowserRequest(method, 'https://securetoken.googleapis.com/v1/token?key=private-test-key').operation, 'token')
    assert.throws(() => classifyLiveBrowserRequest(method, 'https://identitytoolkit.googleapis.com/v1/token?key=private-test-key'))
  }
})

test('binder consumes one fully validated durable MAY event exactly once', async () => {
  const body = JSON.stringify({ data: { companyId: 'safe' } }), digest = h(body)
  const index = FIXTURE_MUTATION_SLOT_SPECS.findIndex(row => row.slot === 'createMailboxCancelledInvite')
  let events = stableJournal(index), journal = bytes(events)
  const binder = createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: journal, readJournal: () => journal })
  events = add(events, 'FIXTURE_MUTATION_MAY_BE_SENT', {
    index, slot: 'createMailboxCancelledInvite', callCount: index + 1,
    callable: 'inviteMember', callableCount: 1, totalCallableCount: 3, requestSha256: digest,
  })
  journal = bytes(events); binder.armMutation()
  assert.throws(() => createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: journal, readJournal: () => journal }))
  const bound = await binder.bind({ method: 'POST', url: 'https://us-central1-finapp-staging.cloudfunctions.net/inviteMember', postData: body })
  assert.equal(bound.mutation.slot, 'createMailboxCancelledInvite')
  assert.equal(binder.counts().inviteMember, 1)
  await assert.rejects(() => binder.bind({ method: 'POST', url: 'https://us-central1-finapp-staging.cloudfunctions.net/inviteMember', postData: body }))
  const spec = FIXTURE_MUTATION_SLOT_SPECS[index]
  events = add(events, 'FIXTURE_MUTATION_RECONCILED', {
    index, slot: spec.slot, callCount: index + 1, callable: spec.callable,
    callableCount: 1, totalCallableCount: 3, disposition: spec.disposition,
    outcomeSha256: h('outcome'), readbackSha256: h('readback'),
  })
  journal = bytes(events); binder.syncMutationReconciled()
  assert.throws(() => createLiveBrowserRequestBinder({ stagingFingerprint: h('wrong'), expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: journal, readJournal: () => journal }))
})

test('binder requires durable read-only callable slots and reconstructed counts block preview nine', async () => {
  assert.equal(CALLABLE_CAPS.listInvitations, 10)
  assert.equal(CALLABLE_CAPS.previewInvite, 8)
  assert.equal(CALLABLE_CAPS.getCompanyAccess, 7)
  let events = stableJournal(), journal = bytes(events)
  let binder = createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: journal, readJournal: () => journal })
  await assert.rejects(() => binder.bind({ method: 'POST', url: 'https://us-central1-finapp-staging.cloudfunctions.net/previewInvite', postData: '{}' }))
  for (let index = 0; index < CALLABLE_CAPS.previewInvite; index++) {
    events = add(events, 'CALLABLE_REQUEST_MAY_BE_SENT', {
      callable: 'previewInvite', callableCount: index + 1, totalCallableCount: index + 1,
      requestSha256: h('{}'), bindingSha256: h(`binding-${index}`),
    })
    journal = bytes(events); binder.armCallable()
    await binder.bind({ method: 'POST', url: 'https://us-central1-finapp-staging.cloudfunctions.net/previewInvite', postData: '{}' })
    events = add(events, 'CALLABLE_REQUEST_RECONCILED', {
      callable: 'previewInvite', callableCount: index + 1, totalCallableCount: index + 1,
      outcomeSha256: h(`preview-outcome-${index}`), readbackSha256: h(`preview-readback-${index}`), bindingSha256: h(`binding-${index}`),
    })
    journal = bytes(events); binder.syncCallableReconciled()
    if (index === 6) binder = createLiveBrowserRequestBinder({
      stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
      journalBytes: journal, readJournal: () => journal,
    })
  }
  assert.equal(binder.counts().previewInvite, 8)
  assert.throws(() => add(events, 'CALLABLE_REQUEST_MAY_BE_SENT', {
    callable: 'previewInvite', callableCount: 9, totalCallableCount: 9, requestSha256: h('{}'), bindingSha256: h('binding-9'),
  }))
  await assert.rejects(() => binder.bind({ method: 'POST', url: 'https://us-central1-finapp-staging.cloudfunctions.net/previewInvite', postData: '{}' }))
})

test('verification permit is journal-backed and remains one-shot across binder restart', async () => {
  const body = JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken: 'opaque-value-never-retained-123456789' }), digest = h(body)
  let events = stableJournal(12), journal = bytes(events)
  const binder = createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: journal, readJournal: () => journal })
  binder.reserveVerificationEmail(digest)
  events = add(events, 'EMAIL_REQUEST_MAY_BE_SENT', { requestSha256: digest }); journal = bytes(events)
  assert.throws(() => createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: journal, readJournal: () => journal }))
  binder.armVerificationEmail()
  assert.equal((await binder.bind({ method: 'POST', url: 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=private-test-key', postData: body })).operation, 'accounts:sendOobCode')
  assert.equal(binder.counts().verificationDispatches, 1)
  assert.throws(() => binder.reserveVerificationEmail(digest))
  await assert.rejects(() => binder.bind({ method: 'POST', url: 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=private-test-key', postData: body }))
  events = add(events, 'EMAIL_SENT', { outcomeSha256: h('email-sent') }); journal = bytes(events); binder.syncVerificationEmailSent()
  const restarted = createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: journal, readJournal: () => journal })
  assert.throws(() => restarted.reserveVerificationEmail(digest))
})

test('verified session requires an exact durable sync before the acceptance mutation can arm', async () => {
  const emailBody = JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken: 'opaque-value-never-retained-123456789' })
  const emailDigest = h(emailBody), mutationBody = JSON.stringify({ data: { invitationId: 'safe', token: 'in-memory' } })
  let events = stableJournal(12), journal = bytes(events)
  const binder = createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: journal, readJournal: () => journal })
  binder.reserveVerificationEmail(emailDigest)
  events = add(events, 'EMAIL_REQUEST_MAY_BE_SENT', { requestSha256: emailDigest }); journal = bytes(events); binder.armVerificationEmail()
  await binder.bind({ method: 'POST', url: 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=private-test-key', postData: emailBody })
  events = add(events, 'EMAIL_SENT', { outcomeSha256: h('email-sent') }); journal = bytes(events); binder.syncVerificationEmailSent()
  events = add(events, 'VERIFIED_SESSION_COMMITTED', { challengeSha256: h('challenge'), sessionProofSha256: h('session-proof') })
  journal = bytes(events)
  assert.throws(() => binder.armMutation())
  binder.syncVerifiedSession()
  assert.throws(() => binder.syncVerifiedSession())
  const index = 12, spec = FIXTURE_MUTATION_SLOT_SPECS[index]
  events = add(events, 'FIXTURE_MUTATION_MAY_BE_SENT', {
    index, slot: spec.slot, callCount: index + 1, callable: spec.callable,
    callableCount: 3, totalCallableCount: 10, requestSha256: h(mutationBody),
  })
  journal = bytes(events); binder.armMutation()
  const bound = await binder.bind({ method: 'POST', url: 'https://us-central1-finapp-staging.cloudfunctions.net/acceptInvite', postData: mutationBody })
  assert.equal(bound.mutation.slot, 'acceptMailboxFinalInvite')
})

test('binder rejects foreign API keys, malformed journals and invalid transitions', async () => {
  const events = stableJournal(), journal = bytes(events)
  const binder = createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: journal, readJournal: () => journal })
  assert.equal((await binder.bind({ method: 'POST', url: `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, postData: '{}' })).kind, 'identity')
  await assert.rejects(() => binder.bind({ method: 'POST', url: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=foreign-test-key', postData: '{}' }))
  await assert.rejects(() => binder.bind({ method: 'POST', url: 'https://securetoken.googleapis.com/v1/token?key=foreign-test-key', postData: '{}' }))
  assert.throws(() => createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: journal.slice(0, -1), readJournal: () => journal }))
  const badAt = structuredClone(events); badAt[0].at = 'not-an-iso-time'
  assert.throws(() => createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: bytes(badAt), readJournal: () => bytes(badAt) }))
  const badTransition = [...events, { seq: events.length, status: 'EMAIL_SENT', at, details: { outcomeSha256: h('bad') } }]
  assert.throws(() => createLiveBrowserRequestBinder({ stagingFingerprint: fingerprint, expectedStagingFingerprint: fingerprint, apiKeySha256,
    journalBytes: bytes(badTransition), readJournal: () => bytes(badTransition) }))
})
