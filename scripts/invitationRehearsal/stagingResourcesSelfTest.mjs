import test from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT, DATABASE, rulesHash } from './inventoryCore.mjs'
import { INDEX, URLS, BASELINE_RULES_HASH, BASELINE_RULESET, sha256, verifyBackup, resourcesTransport, runResources, indexUrl, indexOperationUrl } from './stagingResourcesCore.mjs'
import { persistJournal } from './apiActivationCore.mjs'

const HEAD = 'f'.repeat(40)
const source = 'rules_version = "2";\r\n// исходник\r\n'
const rulesetName = `projects/${PROJECT}/rulesets/test-123`
const release = { name: `projects/${PROJECT}/releases/cloud.firestore`, rulesetName }
const fields = [{ name: `${DATABASE}/collectionGroups/retained/fields/a`, indexConfig: { usesAncestorConfig: false, indexes: [] } }]
const indexName = `${DATABASE}/collectionGroups/invitations/indexes/new123`
const operation = `${DATABASE}/operations/op123`
const target = state => ({ name: indexName, ...structuredClone(INDEX), state })
const options = mode => ({ mode, project: PROJECT, expectedHead: HEAD, expectedRulesHash: rulesHash(source), expectedFieldHash: sha256(JSON.stringify(fields)), env: {} })
const clean = () => ({ head: HEAD, status: '' })
const forbidden = 'RAW_SECRET_MUST_NOT_BE_LOGGED'

function harness(mode, initialIndexes = []) {
  let indexes = structuredClone(initialIndexes)
  let backup
  let authCount = 0, postCount = 0
  const calls = [], events = []
  const transport = { allowRuleset: () => {}, allowIndex: () => {}, allowOperation: () => {} }
  const get = async (url, params = {}) => {
    calls.push({ url, params })
    if (url === URLS.project) return { projectId: PROJECT, projectNumber: '12345' }
    if (url === URLS.database) return { name: DATABASE, type: 'FIRESTORE_NATIVE', locationId: 'eur3' }
    if (url === URLS.release) return structuredClone(release)
    if (url === `https://firebaserules.googleapis.com/v1/${rulesetName}`) return { name: rulesetName, source: { files: [{ name: 'firestore.rules', content: source }] } }
    if (url === URLS.fields) return { fields: structuredClone(fields) }
    if (url === URLS.indexes) return { indexes: structuredClone(indexes) }
    if (url === indexUrl(indexName)) return structuredClone(indexes.find(index => index.name === indexName))
    if (url === indexOperationUrl(operation)) return { name: operation, done: true, response: target('READY') }
    assert.fail(`Unexpected simulated endpoint ${url}`)
  }
  return {
    calls, events, get, auth: () => authCount, posts: () => postCount,
    backup: () => structuredClone(backup), setBackup: value => { backup = structuredClone(value) },
    run: overrides => runResources({
      options: options(mode), gitState: clean, transport,
      authorize: async () => { authCount++ }, get,
      persist: async event => { events.push(structuredClone(event)) },
      writeBackup: async value => { backup = structuredClone(value) },
      readBackup: async () => structuredClone(backup),
      postIndex: async body => {
        postCount++
        assert.deepEqual(body, INDEX)
        indexes.push(target('READY'))
        return { name: operation, done: true, response: target('READY') }
      },
      sleep: async () => {},
      ...overrides,
    }),
  }
}

test('project, mode, SHA, dirty checkout and unsafe Windows env stop before auth', async () => {
  for (const overrides of [
    { options: { ...options('ensure-index'), project: 'finapp-prod-10a83' } },
    { options: { ...options('ensure-index'), mode: 'delete' } },
    { options: { ...options('ensure-index'), expectedHead: 'main' } },
    { options: { ...options('ensure-index'), env: { Firebase_Token: forbidden } } },
    { options: { ...options('ensure-index'), expectedFieldHash: undefined } },
    { gitState: () => ({ head: HEAD, status: '?? unreviewed' }) },
  ]) {
    const h = harness('ensure-index')
    await assert.rejects(h.run(overrides))
    assert.equal(h.auth(), 0)
    assert.equal(h.calls.length, 0)
  }
})

test('Rules backup preserves raw source, verifies disk readback and refreshes active release', async () => {
  const h = harness('backup-rules')
  const result = await h.run()
  assert.equal(result.status, 'RULES_BACKUP_SAVED_VERIFIED')
  assert.equal(h.backup().source.files[0].content, source)
  assert.equal(h.backup().rawSha256, sha256(source))
  assert.equal(result.canonicalSha256, rulesHash(source))
  assert.equal(h.calls.filter(call => call.url === URLS.release).length, 2)
  assert.equal(h.posts(), 0)
  assert.ok(!JSON.stringify(h.events).includes('исходник'))
})

test('local backup verification has zero auth/network and rejects source/hash/identity corruption', async () => {
  const saved = harness('backup-rules')
  await saved.run()
  const h = harness('verify-rules-backup')
  h.setBackup(saved.backup())
  assert.equal((await h.run()).status, 'RULES_BACKUP_VERIFIED_LOCAL')
  assert.equal(h.auth(), 0)
  assert.equal(h.calls.length, 0)
  for (const mutate of [
    b => { b.source.files[0].content += 'corruption' },
    b => { b.rawSha256 = '0'.repeat(64) },
    b => { b.canonicalSha256 = '0'.repeat(64) },
    b => { b.project = 'other' },
    b => { b.release.rulesetName = 'projects/other/rulesets/id' },
    b => { b.sourceBytes++ },
  ]) {
    const backup = saved.backup()
    mutate(backup)
    assert.throws(() => verifyBackup(backup, rulesHash(source)))
  }
})

test('wrong live Rules hash, corrupted readback and release drift never declare backup verified', async () => {
  const wrong = harness('backup-rules')
  await assert.rejects(wrong.run({ options: { ...options('backup-rules'), expectedRulesHash: '0'.repeat(64) } }))
  assert.equal(wrong.backup(), undefined)
  const corrupt = harness('backup-rules')
  await assert.rejects(corrupt.run({ readBackup: async () => { const b = corrupt.backup(); b.source.files[0].content += 'changed'; return b } }))
  const drift = harness('backup-rules')
  let reads = 0
  await assert.rejects(drift.run({ get: async (url, params) => {
    if (url === URLS.release && ++reads === 2) return { ...release, rulesetName: 'projects/other/rulesets/id' }
    return drift.get(url, params)
  } }))
})

test('verify-current-rules requires the supplied exact hash and performs no backup write', async () => {
  const h = harness('verify-current-rules')
  assert.equal((await h.run({ writeBackup: async () => assert.fail('must not write backup') })).status, 'CURRENT_RULES_HASH_VERIFIED')
  assert.equal(h.posts(), 0)
})

test('create one exact additive index, journal uncertainty first and preserve unrelated definitions/field override', async () => {
  const other = { name: `${DATABASE}/collectionGroups/retained/indexes/other`, queryScope: 'COLLECTION', fields: [{ fieldPath: 'a', order: 'ASCENDING' }], state: 'READY' }
  const h = harness('ensure-index', [other])
  const result = await h.run()
  assert.equal(result.status, 'INVITATION_INDEX_READY_VERIFIED')
  assert.equal(h.posts(), 1)
  assert.equal(result.indexName, indexName)
  assert.equal(result.observedIndexState, 'READY')
  assert.deepEqual(h.events.map(event => event.status), ['INDEX_PREFLIGHT_VERIFIED', 'INDEX_CREATE_REQUEST_MAY_BE_SENT', 'INDEX_OPERATION_RECEIVED', 'INVITATION_INDEX_READY_VERIFIED'])
  assert.deepEqual(h.events[0].beforeIndexes, [other])
  assert.deepEqual(h.events[0].beforeFieldOverrides, fields)
})

test('existing READY index is reused and read-only verify-index never creates missing index', async () => {
  const exists = harness('ensure-index', [target('READY')])
  assert.equal((await exists.run()).status, 'INVITATION_INDEX_READY_VERIFIED')
  assert.equal(exists.posts(), 0)
  const absent = harness('verify-index')
  assert.equal((await absent.run()).status, 'INVITATION_INDEX_NOT_READY')
  assert.equal(absent.posts(), 0)
})

test('field hash mismatch or post-create field drift prevents verified completion', async () => {
  const mismatch = harness('ensure-index')
  await assert.rejects(mismatch.run({ options: { ...options('ensure-index'), expectedFieldHash: '0'.repeat(64) } }))
  assert.equal(mismatch.posts(), 0)
  const drift = harness('ensure-index')
  const result = await drift.run({ get: async (url, params) => url === URLS.fields && drift.posts() ? { fields: [] } : drift.get(url, params) })
  assert.equal(result.status, 'INDEX_CREATE_UNCERTAIN')
  assert.equal(drift.posts(), 1)
})

test('field/index pagination is complete and repeated tokens block before mutation', async () => {
  const h = harness('ensure-index')
  const result = await h.run({ get: async (url, params = {}) => {
    if (url === URLS.fields && !params.pageToken) return { fields: [], nextPageToken: 'page-two' }
    return h.get(url, params)
  } })
  assert.equal(result.status, 'INVITATION_INDEX_READY_VERIFIED')
  const repeats = harness('ensure-index')
  await assert.rejects(repeats.run({ get: async (url, params) => url === URLS.indexes ? { nextPageToken: 'repeat' } : repeats.get(url, params) }))
  assert.equal(repeats.posts(), 0)
})

test('unknown create outcome retains uncertainty and never retries or asserts current index state', async () => {
  const h = harness('ensure-index')
  let dispatches = 0
  const result = await h.run({ postIndex: async () => { dispatches++; throw new Error(forbidden) } })
  assert.equal(dispatches, 1)
  assert.equal(result.status, 'INDEX_CREATE_UNCERTAIN')
  assert.equal(result.observedIndexState, null)
  assert.ok(!JSON.stringify(h.events).includes(forbidden))
})

test('only exact registered LRO is polled, timeout bounded, provider error redacted', async () => {
  for (const outcome of ['failure', 'timeout']) {
    const h = harness('ensure-index')
    let posts = 0, polls = 0, registered
    const result = await h.run({
      postIndex: async () => { posts++; return { name: operation } },
      transport: { allowOperation: name => { registered = name } },
      get: async (url, params) => {
        if (url === indexOperationUrl(operation)) {
          assert.equal(registered, operation)
          polls++
          return { name: operation, ...(outcome === 'failure' ? { done: true, error: { message: forbidden } } : {}) }
        }
        return h.get(url, params)
      },
    })
    assert.equal(posts, 1)
    assert.equal(polls, outcome === 'timeout' ? 24 : 1)
    assert.equal(result.status, outcome === 'timeout' ? 'INDEX_CREATE_UNCERTAIN' : 'INDEX_OPERATION_FAILED')
    assert.ok(!JSON.stringify(h.events).includes(forbidden))
  }
})

test('native create guard dispatches once after timeout; blocks other writes and unregistered operations', async () => {
  let dispatches = 0
  const transport = resourcesTransport(async () => { dispatches++; throw new Error('timeout') }, 'ensure-index')
  await assert.rejects(transport.fetch(URLS.create, { method: 'POST' }))
  await assert.rejects(transport.fetch(URLS.create, { method: 'POST' }))
  assert.equal(dispatches, 1)
  for (const [url, method] of [[URLS.fields, 'PATCH'], [URLS.release, 'PATCH'], [URLS.create, 'DELETE'], [indexOperationUrl(operation), 'GET'], [URLS.create.replace(PROJECT, 'other'), 'POST']]) await assert.rejects(transport.fetch(url, { method }))
  assert.equal(dispatches, 1)
  const sent = []
  const allowed = resourcesTransport(async (url, init) => { sent.push({ url, init }); return {} }, 'backup-rules')
  allowed.allowRuleset(rulesetName)
  await allowed.fetch(URLS.release, { redirect: 'follow' })
  await allowed.fetch('https://www.googleapis.com/oauth2/v3/token', { method: 'POST' })
  assert.ok(sent.every(request => request.init.redirect === 'error'))
  assert.throws(() => allowed.allowRuleset('projects/other/rulesets/id'))
  assert.throws(() => transport.allowOperation(`${DATABASE}/operations/../other`))
  const local = resourcesTransport(async () => assert.fail('network in local mode'), 'verify-rules-backup')
  await assert.rejects(local.fetch(URLS.release))
})

test('short/zero journal writes and changing HEAD prevent index creation', async () => {
  for (const write of [() => 0, (_fd, bytes) => bytes.length - 1]) {
    const h = harness('ensure-index')
    await assert.rejects(h.run({ persist: event => persistJournal(1, event, { writeSync: write, fsyncSync: () => assert.fail('sync after short write') }) }))
    assert.equal(h.posts(), 0)
  }
  const h = harness('ensure-index')
  let checks = 0
  await assert.rejects(h.run({ gitState: () => ({ head: ++checks === 1 ? HEAD : '0'.repeat(40), status: '' }) }))
  assert.equal(h.posts(), 0)
})

test('wrong database location blocks writes; documented Rules baseline binds its exact release reference', async () => {
  const h = harness('ensure-index')
  await assert.rejects(h.run({ get: async (url, params) => url === URLS.database ? { name: DATABASE, type: 'FIRESTORE_NATIVE', locationId: 'us-central1' } : h.get(url, params) }))
  assert.equal(h.posts(), 0)
  const saved = harness('backup-rules')
  await saved.run()
  const wrong = saved.backup()
  // Content and every checksum remain valid: the reference alone differs.
  assert.doesNotThrow(() => verifyBackup(wrong, rulesHash(source)))
  assert.notEqual(wrong.rulesetName, BASELINE_RULESET)
  assert.throws(() => verifyBackup(wrong, rulesHash(source), BASELINE_RULESET))
  assert.equal(BASELINE_RULES_HASH.length, 64)
})
