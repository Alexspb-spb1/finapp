import { timingSafeEqual, createHash } from 'node:crypto'
import {
  CALLABLE_CAPS, FIXTURE_MUTATION_SLOT_SPECS, PROJECT,
  assertNoSecretMaterial, authorizePendingDispatchJournal, classifyLiveEndpoint,
  liveAcceptanceTransport, recoverLiveAcceptanceJournal,
} from './liveAcceptanceCore.mjs'

const blocked = () => { throw new Error('live_browser_blocked') }
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())

export const LIVE_BROWSER_ORIGINS = Object.freeze({
  static: 'http://127.0.0.1:5177',
  identity: 'https://identitytoolkit.googleapis.com',
  secureToken: 'https://securetoken.googleapis.com',
  firestore: 'https://firestore.googleapis.com',
  functions: `https://us-central1-${PROJECT}.cloudfunctions.net`,
  blockedLegacyRates: 'https://api.exchangerate-api.com',
})

export const SLOT_ENDPOINTS = Object.freeze({
  createCompanyA: ['callable', 'createCompany'], createCompanyB: ['callable', 'createCompany'],
  createMailboxCancelledInvite: ['callable', 'inviteMember'], cancelMailboxInvite: ['callable', 'cancelInvite'],
  createMailboxFinalInvite: ['callable', 'inviteMember'], denyMailboxResendCooldown: ['callable', 'resendInvite'],
  resendMailboxFinalInvite: ['callable', 'resendInvite'], createOwnerMailboxAuth: ['identity', 'accounts:signUp'],
  denyWrongIdentityAccept: ['callable', 'acceptInvite'], denyUnverifiedMailboxAccept: ['callable', 'acceptInvite'],
  acceptMailboxFinalInvite: ['callable', 'acceptInvite'], replayMailboxFinalInvite: ['callable', 'acceptInvite'],
  createOwnerBInvite: ['callable', 'inviteMember'], acceptOwnerBInvite: ['callable', 'acceptInvite'],
})

const WEBCHANNEL_QUERY_KEYS = new Set(['database', 'VER', 'RID', 'CVER', 'X-HTTP-Session-Id', 'zx', 't', 'TYPE', 'SID', 'AID', 'CI'])
const AUTH_BROWSER_OPERATIONS = new Set(['accounts:signUp', 'accounts:signInWithPassword', 'accounts:lookup', 'accounts:sendOobCode'])

function oneApiKey(url) {
  return url.searchParams.size === 1 && url.searchParams.getAll('key').length === 1 && Boolean(url.searchParams.get('key'))
}

/** Browser-only classifier. It delegates REST/callable endpoints to the shared
 * live classifier and narrowly adds the two Firestore WebChannel paths that
 * the local Playwright recorder observes from the Firebase Web SDK. */
export function classifyLiveBrowserRequest(method, rawUrl) {
  if (!['GET', 'POST', 'OPTIONS'].includes(method) || typeof rawUrl !== 'string') blocked()
  const url = new URL(rawUrl)
  if (url.username || url.password || url.hash) blocked()
  if (url.origin === LIVE_BROWSER_ORIGINS.static) {
    if (method !== 'GET' || !url.pathname.startsWith('/finapp/') || url.search) blocked()
    return { kind: 'static', operation: 'asset', mutation: false, verificationEmail: false }
  }
  if (url.origin === LIVE_BROWSER_ORIGINS.blockedLegacyRates) {
    return { kind: 'blocked-external', operation: 'legacy-exchange-rate', mutation: false, verificationEmail: false }
  }
  if (url.origin === LIVE_BROWSER_ORIGINS.functions && method === 'OPTIONS') {
    if (url.search || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname) || !Object.values(SLOT_ENDPOINTS).some(([, operation]) => `/${operation}` === url.pathname) &&
        !['/listInvitations', '/previewInvite', '/getCompanyAccess'].includes(url.pathname)) blocked()
    return { kind: 'preflight', operation: `callable:${url.pathname.slice(1)}`, mutation: false, verificationEmail: false }
  }
  if ([LIVE_BROWSER_ORIGINS.identity, LIVE_BROWSER_ORIGINS.secureToken].includes(url.origin) && method === 'OPTIONS') {
    const identity = url.origin === LIVE_BROWSER_ORIGINS.identity &&
      ['/v1/accounts:signUp', '/v1/accounts:signInWithPassword', '/v1/accounts:lookup', '/v1/accounts:sendOobCode'].includes(url.pathname)
    const secure = url.origin === LIVE_BROWSER_ORIGINS.secureToken && url.pathname === '/v1/token'
    if ((!identity && !secure) || !oneApiKey(url)) blocked()
    return { kind: 'preflight', operation: identity ? url.pathname.slice(4) : 'token', mutation: false, verificationEmail: false }
  }
  if (url.origin === LIVE_BROWSER_ORIGINS.firestore) {
    const match = /^\/google\.firestore\.v1\.Firestore\/(Listen\/channel|Write\/channel)$/.exec(url.pathname)
    if (match) {
      if ([...url.searchParams.keys()].some(key => !WEBCHANNEL_QUERY_KEYS.has(key)) ||
          url.searchParams.getAll('database').length !== 1 ||
          url.searchParams.get('database') !== `projects/${PROJECT}/databases/(default)`) blocked()
      if (match[1] === 'Write/channel') blocked()
      return { kind: 'firestore-webchannel', operation: match[1], mutation: false, verificationEmail: false }
    }
  }
  let shared
  try { shared = classifyLiveEndpoint(method, rawUrl) } catch { blocked() }
  const operation = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
  if (shared.kind === 'identity') {
    if (!oneApiKey(url)) blocked()
    const authOperation = url.pathname.slice('/v1/'.length)
    if (!AUTH_BROWSER_OPERATIONS.has(authOperation)) blocked()
    const mutation = authOperation === 'accounts:signUp'
    return { kind: 'identity', operation: authOperation, mutation, verificationEmail: shared.verificationEmail }
  }
  if (shared.kind === 'secure-token') {
    if (!oneApiKey(url)) blocked()
    return { kind: 'secure-token', operation: 'token', mutation: false, verificationEmail: false }
  }
  if (shared.kind === 'callable') {
    return { kind: 'callable', operation, mutation: ['createCompany', 'inviteMember', 'cancelInvite', 'resendInvite', 'acceptInvite'].includes(operation), verificationEmail: false }
  }
  blocked()
}

export function validateEndpointShapeReceipt(receipt) {
  if (!exactKeys(receipt, ['task', 'status', 'project', 'shapes', 'containsUrlValues', 'containsHeaders', 'containsBodies', 'liveRequests']) ||
      receipt.task !== 'SEC-006 Stage 8 local endpoint-shape discovery' || receipt.status !== 'PASS' ||
      receipt.project !== 'demo-finapp' || receipt.containsUrlValues !== false || receipt.containsHeaders !== false ||
      receipt.containsBodies !== false || receipt.liveRequests !== 0 || !Array.isArray(receipt.shapes)) blocked()
  const kinds = new Set()
  for (const row of receipt.shapes) {
    if (!exactKeys(row, ['kind', 'method', 'operation', 'queryKeys', 'count']) || !Number.isSafeInteger(row.count) || row.count < 1 ||
        !Array.isArray(row.queryKeys) || row.queryKeys.some(key => typeof key !== 'string' || /token|password|email|oob/i.test(key)) ||
        typeof row.operation !== 'string' || /[?&=@]/.test(row.operation)) blocked()
    kinds.add(row.kind)
  }
  for (const required of ['static', 'callable', 'identity', 'firestore-webchannel']) if (!kinds.has(required)) blocked()
  assertNoSecretMaterial({ shapeCount: receipt.shapes.length, liveRequests: receipt.liveRequests })
  return { shapeCount: receipt.shapes.length, receiptSha256: sha256(`${JSON.stringify(receipt)}\n`) }
}

function sameFingerprint(actual, expected) {
  if (!hex64(actual) || !hex64(expected)) return false
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

function extendsExactly(prefix, events, extra) {
  return events.length === prefix.length + extra &&
    JSON.stringify(events.slice(0, prefix.length)) === JSON.stringify(prefix)
}

/** Binds each browser mutation to an already-fsynced exact journal MAY event.
 * It sees sensitive bodies only long enough to hash/validate them and returns
 * metadata that is safe to journal. */
export function createLiveBrowserRequestBinder({ stagingFingerprint, expectedStagingFingerprint, apiKeySha256, journalBytes, readJournal }) {
  if (!sameFingerprint(stagingFingerprint, expectedStagingFingerprint) || !hex64(apiKeySha256) || typeof readJournal !== 'function') blocked()
  const recovered = recoverLiveAcceptanceJournal(journalBytes)
  let stableEvents = [...recovered.events]
  let stableReconciled = recovered.reconciledMutations
  let counts = { ...recovered.callableCounts }
  let total = recovered.totalCallableCount, armedMutation = null, mutationDispatched = false
  let armedCallable = null, callableDispatched = false
  let reservedEmailSha256 = null, armedEmailSha256 = null, emailDispatched = recovered.emailRequestMayBeSentCount > 0
  let emailSentSynced = false, verifiedSessionSynced = false
  const emailPermit = liveAcceptanceTransport(async () => ({ permitConsumed: true }), { recoveryJournal: journalBytes, readJournal })
  const consumeMutation = (classification, bodySha256) => {
    const event = armedMutation
    if (!event || mutationDispatched || event.details.requestSha256 !== bodySha256) blocked()
    const spec = FIXTURE_MUTATION_SLOT_SPECS[event.details.index]
    if (!spec || event.details.callCount !== event.details.index + 1 || spec.slot !== event.details.slot || SLOT_ENDPOINTS[spec.slot]?.[0] !== classification.kind ||
        SLOT_ENDPOINTS[spec.slot]?.[1] !== classification.operation || event.details.callable !== spec.callable) blocked()
    if (spec.callable === null) {
      if (event.details.callableCount !== null || event.details.totalCallableCount !== total) blocked()
    } else {
      if (event.details.callableCount !== counts[spec.callable] + 1 || event.details.totalCallableCount !== total + 1) blocked()
      counts[spec.callable] = event.details.callableCount
      total = event.details.totalCallableCount
    }
    armedMutation = null; mutationDispatched = true
    return { slot: spec.slot, disposition: spec.disposition, index: event.details.index }
  }
  const consumeCallable = (classification, bodySha256) => {
    const pending = armedCallable
    if (!pending || callableDispatched || pending.requestSha256 !== bodySha256 || pending.callable !== classification.operation ||
        pending.callableCount !== counts[pending.callable] + 1 || pending.totalCallableCount !== total + 1) blocked()
    counts[pending.callable] = pending.callableCount
    total = pending.totalCallableCount
    armedCallable = null; callableDispatched = true
    return { bindingSha256: pending.bindingSha256 }
  }
  return {
    armMutation() {
      if (armedMutation || mutationDispatched || armedCallable || callableDispatched) blocked()
      const pending = authorizePendingDispatchJournal(readJournal(), 'fixture')
      const spec = FIXTURE_MUTATION_SLOT_SPECS[pending.index]
      const expectedCounts = { ...counts }
      if (spec?.callable !== null) expectedCounts[spec.callable]++
      const expectedTotal = total + (spec?.callable === null ? 0 : 1)
      if (pending.pendingSeq !== stableEvents.length || pending.reconciledMutations !== stableReconciled ||
          pending.index !== pending.reconciledMutations || pending.totalCallableCount !== expectedTotal ||
          JSON.stringify(pending.callableCounts) !== JSON.stringify(expectedCounts)) blocked()
      armedMutation = { details: {
        index: pending.index, slot: pending.slot, callCount: pending.callCount,
        callable: spec.callable,
        callableCount: spec.callable === null ? null : pending.callableCounts[spec.callable],
        totalCallableCount: pending.totalCallableCount,
        disposition: pending.disposition, requestSha256: pending.requestSha256,
      } }
    },
    syncMutationReconciled() {
      if (!mutationDispatched || armedMutation) blocked()
      const next = recoverLiveAcceptanceJournal(readJournal())
      if (!extendsExactly(stableEvents, next.events, 2) || next.events.at(-2).status !== 'FIXTURE_MUTATION_MAY_BE_SENT' ||
          next.events.at(-1).status !== 'FIXTURE_MUTATION_RECONCILED') blocked()
      stableEvents = [...next.events]; stableReconciled = next.reconciledMutations
      counts = { ...next.callableCounts }; total = next.totalCallableCount; mutationDispatched = false
    },
    armCallable() {
      if (armedMutation || mutationDispatched || armedCallable || callableDispatched) blocked()
      const pending = authorizePendingDispatchJournal(readJournal(), 'callable')
      const expectedCounts = { ...counts, [pending.callable]: counts[pending.callable] + 1 }
      if (pending.pendingSeq !== stableEvents.length || pending.reconciledMutations !== stableReconciled ||
          pending.totalCallableCount !== total + 1 || JSON.stringify(pending.callableCounts) !== JSON.stringify(expectedCounts)) blocked()
      armedCallable = {
        callable: pending.callable, callableCount: pending.callableCount,
        totalCallableCount: pending.totalCallableCount, requestSha256: pending.requestSha256,
        bindingSha256: pending.bindingSha256,
      }
    },
    syncCallableReconciled() {
      if (!callableDispatched || armedCallable) blocked()
      const next = recoverLiveAcceptanceJournal(readJournal())
      if (!extendsExactly(stableEvents, next.events, 2) || next.events.at(-2).status !== 'CALLABLE_REQUEST_MAY_BE_SENT' ||
          next.events.at(-1).status !== 'CALLABLE_REQUEST_RECONCILED' ||
          next.events.at(-2).details.bindingSha256 !== next.events.at(-1).details.bindingSha256) blocked()
      stableEvents = [...next.events]; stableReconciled = next.reconciledMutations
      counts = { ...next.callableCounts }; total = next.totalCallableCount; callableDispatched = false
    },
    reserveVerificationEmail(bodySha256) {
      if (!hex64(bodySha256) || reservedEmailSha256 || armedEmailSha256 || emailDispatched || mutationDispatched || armedMutation) blocked()
      emailPermit.reserveVerificationEmail(bodySha256)
      reservedEmailSha256 = bodySha256
    },
    armVerificationEmail() {
      if (!reservedEmailSha256 || armedEmailSha256 || emailDispatched) blocked()
      const pending = authorizePendingDispatchJournal(readJournal(), 'email')
      if (pending.pendingSeq !== stableEvents.length || pending.requestSha256 !== reservedEmailSha256 || pending.emailSentCount !== 0) blocked()
      armedEmailSha256 = reservedEmailSha256
    },
    syncVerificationEmailSent() {
      if (!emailDispatched || armedEmailSha256) blocked()
      const next = recoverLiveAcceptanceJournal(readJournal())
      if (!extendsExactly(stableEvents, next.events, 2) || next.events.at(-2).status !== 'EMAIL_REQUEST_MAY_BE_SENT' ||
          next.events.at(-1).status !== 'EMAIL_SENT') blocked()
      stableEvents = [...next.events]
      emailSentSynced = true
    },
    syncVerifiedSession() {
      if (!emailSentSynced || verifiedSessionSynced || armedMutation || mutationDispatched || armedCallable || callableDispatched) blocked()
      const next = recoverLiveAcceptanceJournal(readJournal())
      if (!extendsExactly(stableEvents, next.events, 1) || next.events.at(-1).status !== 'VERIFIED_SESSION_COMMITTED') blocked()
      stableEvents = [...next.events]
      verifiedSessionSynced = true
    },
    async bind({ method, url, postData }) {
      const classification = classifyLiveBrowserRequest(method, url)
      if (classification.kind === 'blocked-external') return { action: 'abort', ...classification }
      const parsedUrl = new URL(url)
      if (classification.kind === 'identity' || classification.kind === 'secure-token' ||
          (classification.kind === 'preflight' && [LIVE_BROWSER_ORIGINS.identity, LIVE_BROWSER_ORIGINS.secureToken].includes(parsedUrl.origin))) {
        const presented = parsedUrl.searchParams.get('key')
        if (typeof presented !== 'string' || !sameFingerprint(sha256(presented), apiKeySha256)) blocked()
      }
      const bodySha256 = postData === null || postData === undefined ? null : sha256(postData)
      let mutation = null, callableBinding = null
      if (classification.kind === 'callable') {
        const name = classification.operation
        if (!Object.hasOwn(CALLABLE_CAPS, name)) blocked()
        if (classification.mutation) mutation = consumeMutation(classification, bodySha256)
        else callableBinding = consumeCallable(classification, bodySha256)
      } else if (classification.kind === 'identity' && classification.operation === 'accounts:signUp') {
        mutation = consumeMutation(classification, bodySha256)
      }
      if (classification.verificationEmail) {
        if (emailDispatched || armedEmailSha256 !== bodySha256) blocked()
        let body
        try { body = JSON.parse(postData) } catch { blocked() }
        if (!exactKeys(body, ['requestType', 'idToken']) || body.requestType !== 'VERIFY_EMAIL' || typeof body.idToken !== 'string' || body.idToken.length < 20) blocked()
        emailPermit.authorizeRequest({ method, url, bodySha256 })
        await emailPermit.fetch(url, { method, body: postData })
        emailDispatched = true; armedEmailSha256 = null; reservedEmailSha256 = null
      }
      return { action: 'continue', kind: classification.kind, operation: classification.operation,
        ...(mutation ? { mutation } : {}), ...(callableBinding ? { callableBinding } : {}) }
    },
    counts() { return { ...counts, total, verificationDispatches: emailDispatched ? 1 : 0 } },
  }
}
