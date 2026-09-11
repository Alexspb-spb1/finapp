// Local-only request-shape recorder for the existing demo-finapp Stage 8
// Playwright rehearsal. It never records URL values, headers, request bodies,
// credentials, mailbox values, tokens or provider responses.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const PROJECT = 'demo-finapp'
const LOOPBACK = '127.0.0.1'
const CALLABLES = new Set(['createCompany', 'inviteMember', 'listInvitations', 'cancelInvite', 'resendInvite', 'previewInvite', 'acceptInvite', 'getCompanyAccess'])
const AUTH_OPERATIONS = new Set(['accounts:signUp', 'accounts:signInWithPassword', 'accounts:lookup', 'accounts:sendOobCode'])
const FIRESTORE_OPERATIONS = new Set(['Listen/channel', 'Write/channel'])

function exactQueryKeys(url, allowed) {
  const keys = [...new Set(url.searchParams.keys())].sort()
  if (keys.some(key => !allowed.has(key))) throw new Error('endpoint_shape')
  return keys
}

function sanitizeRequestShape(rawUrl, method = 'GET') {
  const url = new URL(rawUrl)
  const verb = String(method).toUpperCase()
  if (url.username || url.password || url.hash) throw new Error('endpoint_shape')
  if (url.origin === 'https://api.exchangerate-api.com') {
    return { kind: 'blocked-external', method: verb, operation: 'legacy-exchange-rate', queryKeys: [] }
  }
  if (url.protocol !== 'http:' || url.hostname !== LOOPBACK) throw new Error('endpoint_shape')
  if (url.port === '5176') {
    if (verb !== 'GET' || !url.pathname.startsWith('/finapp/') || url.search) throw new Error('endpoint_shape')
    const extension = path.posix.extname(url.pathname).toLowerCase()
    const operation = new Map([['.html', 'html'], ['.js', 'script'], ['.css', 'style'], ['.svg', 'image'], ['.json', 'json']]).get(extension) || 'route'
    return { kind: 'static', method: verb, operation, queryKeys: [] }
  }
  if (url.port === '5001') {
    const match = new RegExp(`^/${PROJECT}/us-central1/([A-Za-z0-9_-]+)$`).exec(url.pathname)
    if (!['POST', 'OPTIONS'].includes(verb) || !match || !CALLABLES.has(match[1]) || url.search) throw new Error('endpoint_shape')
    return { kind: 'callable', method: verb, operation: match[1], queryKeys: [] }
  }
  if (url.port === '9099') {
    const auth = /^\/identitytoolkit\.googleapis\.com\/v1\/(accounts:[A-Za-z]+)$/.exec(url.pathname)
    if (auth) {
      if (!['POST', 'OPTIONS'].includes(verb) || !AUTH_OPERATIONS.has(auth[1])) throw new Error('endpoint_shape')
      return { kind: 'identity', method: verb, operation: auth[1], queryKeys: exactQueryKeys(url, new Set(['key'])) }
    }
    const secure = /^\/securetoken\.googleapis\.com\/v1\/(token)$/.exec(url.pathname)
    if (secure) {
      if (!['POST', 'OPTIONS'].includes(verb)) throw new Error('endpoint_shape')
      return { kind: 'secure-token', method: verb, operation: secure[1], queryKeys: exactQueryKeys(url, new Set(['key'])) }
    }
    throw new Error('endpoint_shape')
  }
  if (url.port === '8080') {
    const rpc = /^\/google\.firestore\.v1\.Firestore\/(Listen\/channel|Write\/channel)$/.exec(url.pathname)
    if (!rpc || !FIRESTORE_OPERATIONS.has(rpc[1]) || !['GET', 'POST', 'OPTIONS'].includes(verb)) throw new Error('endpoint_shape')
    const keys = exactQueryKeys(url, new Set(['database', 'VER', 'RID', 'CVER', 'X-HTTP-Session-Id', 'zx', 't', 'TYPE', 'SID', 'AID', 'CI']))
    if (url.searchParams.has('database') && url.searchParams.get('database') !== `projects/${PROJECT}/databases/(default)`) throw new Error('endpoint_shape')
    return { kind: 'firestore-webchannel', method: verb, operation: rpc[1], queryKeys: keys }
  }
  throw new Error('endpoint_shape')
}

function createEndpointShapeRecorder() {
  const counts = new Map()
  return {
    observe(rawUrl, method) {
      const shape = sanitizeRequestShape(rawUrl, method)
      const key = JSON.stringify(shape)
      counts.set(key, (counts.get(key) || 0) + 1)
      return shape
    },
    receipt() {
      const shapes = [...counts].map(([key, count]) => ({ ...JSON.parse(key), count }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      if (!shapes.some(row => row.kind === 'callable') || !shapes.some(row => row.kind === 'identity') ||
          !shapes.some(row => row.kind === 'firestore-webchannel')) throw new Error('endpoint_shape_incomplete')
      return { task: 'SEC-006 Stage 8 local endpoint-shape discovery', status: 'PASS', project: PROJECT, shapes,
        containsUrlValues: false, containsHeaders: false, containsBodies: false, liveRequests: 0 }
    },
  }
}

function writeEndpointShapeReceipt(filename, value, repoRoot) {
  if (!path.isAbsolute(filename) || fs.existsSync(filename)) throw new Error('endpoint_shape_output')
  const parent = fs.realpathSync(path.dirname(filename)), root = fs.realpathSync(repoRoot)
  const target = path.join(parent, path.basename(filename)), relative = path.relative(root, target)
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('endpoint_shape_output')
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const fd = fs.openSync(target, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  if (!fs.readFileSync(target).equals(bytes)) throw new Error('endpoint_shape_output')
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

module.exports = { createEndpointShapeRecorder, sanitizeRequestShape, writeEndpointShapeReceipt }

if (require.main === module) {
  const assert = require('node:assert/strict')
  const recorder = createEndpointShapeRecorder()
  recorder.observe('http://127.0.0.1:5176/finapp/assets/app.js', 'GET')
  recorder.observe('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic', 'POST')
  recorder.observe('http://127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fdemo-finapp%2Fdatabases%2F(default)&VER=8', 'POST')
  recorder.observe('http://127.0.0.1:5001/demo-finapp/us-central1/previewInvite', 'POST')
  const receipt = recorder.receipt()
  assert.equal(receipt.liveRequests, 0)
  assert.equal(JSON.stringify(receipt).includes('synthetic'), false)
  assert.throws(() => sanitizeRequestShape('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=secret', 'POST'))
  assert.throws(() => sanitizeRequestShape('http://127.0.0.1:5001/finapp-prod/us-central1/previewInvite', 'POST'))
  console.log('STAGE8_ENDPOINT_SHAPES_SELF_TEST_PASS: sanitized shapes only; live requests 0.')
}
