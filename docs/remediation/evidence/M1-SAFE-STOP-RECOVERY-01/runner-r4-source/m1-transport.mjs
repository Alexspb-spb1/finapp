// Guarded HTTP layer for the M1 smoke runner. Every request is matched against
// an explicit allowlist before it leaves the process; invitation callables are
// refused unconditionally. Response bodies are returned to the caller only.
import path from 'node:path'
import { createRequire } from 'node:module'
import { REPO, M1_CALLABLES, SEED_CALLABLES, INVITATION_CALLABLES, stop } from './m1-core.mjs'

// ── transport failure classification (M1-SAFE-STOP-RECOVERY-01) ─────────────────────────────────────────────────────────────────────
// The consumed R3 run stopped with `transport: network failure POST accounts` after 10.7 s and the durable evidence could not say whether the request
// ever left the process. fetch() rejects for very different reasons. Only a failure of the CONNECT phase (name resolution, TCP connect, the undici
// connect timer, TLS certificate verification) proves that no byte of the request was sent; everything else (a reset or close while or after the request
// was written, a response timeout, the runner's own abort, an error of unknown shape) may have happened after the provider received the mutation and
// stays an UNKNOWN outcome - fail closed. The result is a closed set of codes: no URL, host, message text or stack of the underlying error is kept.
// (PRE_DISPATCH_REASON_CODES, the closed set of connect-phase codes, lives in m1-core.mjs: the transport, the seed journal and the cleanup gate share it.)
const CONNECT_PHASE_CODES = new Map([['ECONNREFUSED', 'connection-refused'], ['ENETUNREACH', 'network-unreachable'], ['EHOSTUNREACH', 'network-unreachable'], ['ENETDOWN', 'network-unreachable'], ['ETIMEDOUT', 'connect-timeout']])
const NAME_RESOLUTION_CODES = new Map([['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['EAI_FAIL', 'dns']])
const TLS_VERIFY_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'])
const object = v => (v !== null && typeof v === 'object' ? v : null)
function preDispatchCode(e) {
  if (!object(e)) return null
  if (e.code === 'UND_ERR_CONNECT_TIMEOUT') return 'connect-timeout'
  if (typeof e.code === 'string' && CONNECT_PHASE_CODES.has(e.code) && e.syscall === 'connect') return CONNECT_PHASE_CODES.get(e.code)
  if (typeof e.code === 'string' && NAME_RESOLUTION_CODES.has(e.code) && e.syscall === 'getaddrinfo') return NAME_RESOLUTION_CODES.get(e.code)
  if (typeof e.code === 'string' && TLS_VERIFY_CODES.has(e.code)) return 'tls-verify'
  return null
}
/** Pure. Returns { reasonCode, dispatch } with dispatch 'not-dispatched' (proven: the connect phase failed) or 'unknown'. Never throws. */
export function classifyFetchError(error) {
  try {
    const top = object(error)
    if (top?.name === 'TimeoutError') return { reasonCode: 'abort-timeout', dispatch: 'unknown' }
    const node = object(top?.cause) ?? top
    if (node && Array.isArray(node.errors) && node.errors.length > 0) {
      // dual-stack connect attempts: every single attempt must have failed in connect()/name resolution
      const codes = node.errors.map(preDispatchCode)
      if (codes.every(Boolean)) return { reasonCode: codes.includes('connect-timeout') ? 'connect-timeout' : codes[0], dispatch: 'not-dispatched' }
      return { reasonCode: 'other', dispatch: 'unknown' }
    }
    const pre = preDispatchCode(node)
    if (pre) return { reasonCode: pre, dispatch: 'not-dispatched' }
    if (node?.code === 'ECONNRESET') return { reasonCode: 'connection-reset', dispatch: 'unknown' }
    if (node?.code === 'UND_ERR_SOCKET') return { reasonCode: 'socket-closed', dispatch: 'unknown' }
    if (node?.code === 'UND_ERR_HEADERS_TIMEOUT' || node?.code === 'UND_ERR_BODY_TIMEOUT') return { reasonCode: 'response-timeout', dispatch: 'unknown' }
  } catch { /* an unclassifiable error is an unknown outcome */ }
  return { reasonCode: 'other', dispatch: 'unknown' }
}

/** `webConfig` is the result of loadStagingWebConfig(--web-config) for staging. */
export async function makeTransport(target, { counters, webConfig, requestTimeoutMs }) {
  // The request timeout is 30 s. Only a test may shorten it (100..30000 ms); anything else keeps 30 s.
  const timeoutMs = Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= 100 && requestTimeoutMs <= 30000 ? requestTimeoutMs : 30000
  if (target.name === 'staging' && webConfig?.projectId !== 'finapp-staging') stop('transport', 'verified staging web config required', 'integrity')
  const docsRoot = `${target.firestore}/v1/projects/${target.project}/databases/(default)/documents`
  let operatorHeaders

  if (target.name === 'staging') {
    const require = createRequire(import.meta.url)
    const ft = name => require(path.join(REPO, 'node_modules/firebase-tools/lib', name))
    ft('logger.js').logger.silent = true
    const account = ft('auth.js').getGlobalDefaultAccount()
    if (!account?.user || typeof account?.tokens?.refresh_token !== 'string') stop('transport', 'firebase CLI login required')
    const ok = await ft('requireAuth.js').requireAuth({ project: target.project, user: account.user, tokens: account.tokens }, true)
    if (!ok) stop('transport', 'firebase CLI auth failed')
    const apiv2 = ft('apiv2.js')
    operatorHeaders = async () => ({ authorization: `Bearer ${await apiv2.getAccessToken()}`, 'x-goog-user-project': target.project })
  } else {
    operatorHeaders = async () => ({ authorization: 'Bearer owner' })
  }
  const apiKey = target.name === 'staging' ? webConfig.apiKey : 'fake-api-key'

  function allowed(method, url) {
    const u = new URL(url)
    const base = `${u.origin}${u.pathname}`
    const authProject = `${target.auth}/v1/projects/${target.project}`
    if (method === 'POST' && [`${authProject}/accounts`, `${authProject}/accounts:lookup`, `${authProject}/accounts:delete`,
      `${target.auth}/v1/accounts:signInWithPassword`].includes(base)) return true
    if (base.startsWith(`${docsRoot}/`) || base === `${docsRoot}:commit` || base === `${docsRoot}:runQuery`) {
      return ['GET', 'PATCH', 'POST'].includes(method)
    }
    if (method === 'POST' && base.startsWith(`${target.functions}/`)) {
      const name = base.slice(target.functions.length + 1)
      if (INVITATION_CALLABLES.includes(name)) { counters.invitationCallsRefused++; return false }
      return M1_CALLABLES.includes(name) || SEED_CALLABLES.includes(name)
    }
    return false
  }

  async function http(method, url, { body, bearer, operator = false } = {}) {
    if (!allowed(method, url)) stop('transport', `request not allowlisted: ${method} ${new URL(url).pathname}`)
    const headers = { 'content-type': 'application/json' }
    if (operator) Object.assign(headers, await operatorHeaders())
    if (bearer) headers.authorization = `Bearer ${bearer}`
    counters.requests++
    let res
    const startedAt = Date.now()
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      // Never classified as a smoke assertion. The reason text stays fixed; reasonCode/dispatch/elapsedMs are closed-set evidence. Only a failure of the connect phase
      // is a PROVEN non-dispatch (kind transport-not-dispatched); every other outcome stays unknown (kind transport) and refuses cleanup. No retry, ever.
      const { reasonCode, dispatch } = classifyFetchError(error)
      stop('transport', `network failure ${method} ${new URL(url).pathname.split('/').slice(-1)[0]}`, dispatch === 'not-dispatched' ? 'transport-not-dispatched' : 'transport', { reasonCode, dispatch, elapsedMs: Date.now() - startedAt })
    }
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: res.status, json }
  }

  const authProject = `${target.auth}/v1/projects/${target.project}`
  return {
    docsRoot,
    docName: p => `projects/${target.project}/databases/(default)/documents/${p}`,

    async createAuthUser(u) {
      const r = await http('POST', `${authProject}/accounts`, { operator: true, body: { email: u.email, password: u.password, displayName: u.name, emailVerified: true } })
      if (r.status !== 200 || typeof r.json?.localId !== 'string') stop('auth-create', `status ${r.status}`)
      counters.authCreates++
      return r.json.localId
    },
    async lookupAuth({ localIds = [], emails = [] }) {
      const body = {}
      if (localIds.length) body.localId = localIds
      if (emails.length) body.email = emails
      const r = await http('POST', `${authProject}/accounts:lookup`, { operator: true, body })
      if (r.status !== 200) stop('auth-lookup', `status ${r.status}`)
      return (r.json?.users ?? []).map(x => ({ uid: x.localId, email: x.email, emailVerified: x.emailVerified === true, disabled: x.disabled === true }))
    },
    async deleteAuthUser(uid) {
      const r = await http('POST', `${authProject}/accounts:delete`, { operator: true, body: { localId: uid } })
      if (r.status !== 200) stop('auth-delete', `status ${r.status}`)
      counters.authDeletes++
    },
    async signIn(u) {
      const r = await http('POST', `${target.auth}/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, { body: { email: u.email, password: u.password, returnSecureToken: true } })
      if (r.status !== 200 || typeof r.json?.idToken !== 'string' || r.json.localId !== u.uid) stop('sign-in', `status ${r.status}`)
      return r.json.idToken
    },
    async call(name, idToken, data) {
      const r = await http('POST', `${target.functions}/${name}`, { bearer: idToken, body: { data } })
      counters.callables[name] = (counters.callables[name] ?? 0) + 1
      if (r.status === 200 && r.json && 'result' in r.json) return { ok: true, result: r.json.result }
      return { ok: false, httpStatus: r.status, status: r.json?.error?.status ?? null, appCode: r.json?.error?.details?.appCode ?? null }
    },
    // Operator (IAM) document access — bypasses Rules.
    async getDoc(p) {
      const r = await http('GET', `${docsRoot}/${p}`, { operator: true })
      if (r.status === 404) return { exists: false }
      if (r.status !== 200) stop('get-doc', `status ${r.status}`)
      return { exists: true, fields: r.json.fields ?? {}, updateTime: r.json.updateTime }
    },
    async listDocs(parentPath, collectionId) {
      const names = []
      let pageToken
      for (let page = 0; page < 20; page++) {
        const q = new URLSearchParams({ pageSize: '100', showMissing: 'false' })
        if (pageToken) q.set('pageToken', pageToken)
        const r = await http('GET', `${docsRoot}/${parentPath}/${collectionId}?${q}`, { operator: true })
        if (r.status !== 200) stop('list-docs', `status ${r.status}`)
        for (const d of r.json?.documents ?? []) names.push({ name: d.name, fields: d.fields ?? {}, updateTime: d.updateTime })
        pageToken = r.json?.nextPageToken
        if (!pageToken) return names
      }
      stop('list-docs', 'too many pages')
    },
    async listCollectionIds(docPath) {
      const r = await http('POST', `${docsRoot}/${docPath}:listCollectionIds`, { operator: true, body: { pageSize: 100 } })
      if (r.status !== 200) stop('list-collections', `status ${r.status}`)
      return r.json?.collectionIds ?? []
    },
    async runQuery(collectionId, field, values) {
      const body = { structuredQuery: { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: field }, op: 'IN', value: { arrayValue: { values: values.map(v => ({ stringValue: v })) } } } }, limit: 50 } }
      const r = await http('POST', `${docsRoot}:runQuery`, { operator: true, body })
      if (r.status !== 200) stop('run-query', `status ${r.status}`)
      return (r.json ?? []).filter(x => x.document).map(x => x.document.name)
    },
    async commit(writes) {
      const r = await http('POST', `${docsRoot}:commit`, { operator: true, body: { writes } })
      if (r.status !== 200) stop('commit', `status ${r.status}`)
      counters.operatorCommits++
      return r.json
    },
    // Client (Rules-evaluated) access with a Firebase ID token.
    async clientGet(p, idToken) {
      return (await http('GET', `${docsRoot}/${p}`, { bearer: idToken })).status
    },
    async clientList(parentPath, collectionId, idToken) {
      return (await http('GET', `${docsRoot}/${parentPath}/${collectionId}?pageSize=10`, { bearer: idToken })).status
    },
    async clientListRoot(collectionId, idToken) {
      return (await http('GET', `${docsRoot}/${collectionId}?pageSize=10`, { bearer: idToken })).status
    },
    async clientPatch(p, fields, mask, idToken) {
      const q = new URLSearchParams()
      for (const f of mask) q.append('updateMask.fieldPaths', f)
      q.set('currentDocument.exists', 'true')
      return (await http('PATCH', `${docsRoot}/${p}?${q}`, { bearer: idToken, body: { fields } })).status
    },
    async clientCommit(writes, idToken) {
      return (await http('POST', `${docsRoot}:commit`, { bearer: idToken, body: { writes } })).status
    },
  }
}
