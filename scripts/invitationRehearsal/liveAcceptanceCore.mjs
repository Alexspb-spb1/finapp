import { createHash } from 'node:crypto'
import { guard, PROJECT } from './inventoryCore.mjs'
import { normalizeMailbox } from './mailboxDiscoveryCore.mjs'

export { PROJECT }

export const PINNED_DISCOVERY_SOURCE_HEAD = '5e476df19c5ad3e90184a6191430d94c23fea99a'
export const PINNED_DISCOVERY_SHA256 = 'b9be2d78de4711406361be6bb4be55b90e9ada3d78275a55dc130719da96ffe6'
export const OAUTH_REFRESH_URL = 'https://www.googleapis.com/oauth2/v3/token'
export const LIVE_LIMITS = Object.freeze({
  companies: 2, syntheticAuthUsers: 2, ownerMailboxAccounts: 1,
  memberships: 4, invitations: 3, invitationLocks: 2, auditEvents: 9, verificationEmails: 1,
})
export const FIXTURE_MUTATION_SLOT_SPECS = Object.freeze([
  { slot: 'createOwnerAAuth', callable: null, disposition: 'WRITE' },
  { slot: 'createCompanyA', callable: 'createCompany', disposition: 'WRITE' },
  { slot: 'createOwnerBAuth', callable: null, disposition: 'WRITE' },
  { slot: 'createCompanyB', callable: 'createCompany', disposition: 'WRITE' },
  { slot: 'createMailboxCancelledInvite', callable: 'inviteMember', disposition: 'WRITE' },
  { slot: 'cancelMailboxInvite', callable: 'cancelInvite', disposition: 'WRITE' },
  { slot: 'createMailboxFinalInvite', callable: 'inviteMember', disposition: 'WRITE' },
  { slot: 'denyMailboxResendCooldown', callable: 'resendInvite', disposition: 'NO_WRITE' },
  { slot: 'resendMailboxFinalInvite', callable: 'resendInvite', disposition: 'WRITE' },
  { slot: 'createOwnerMailboxAuth', callable: null, disposition: 'WRITE' },
  { slot: 'denyWrongIdentityAccept', callable: 'acceptInvite', disposition: 'NO_WRITE' },
  { slot: 'denyUnverifiedMailboxAccept', callable: 'acceptInvite', disposition: 'NO_WRITE' },
  { slot: 'acceptMailboxFinalInvite', callable: 'acceptInvite', disposition: 'WRITE' },
  { slot: 'replayMailboxFinalInvite', callable: 'acceptInvite', disposition: 'IDEMPOTENT_READBACK' },
  { slot: 'createOwnerBInvite', callable: 'inviteMember', disposition: 'WRITE' },
  { slot: 'acceptOwnerBInvite', callable: 'acceptInvite', disposition: 'WRITE' },
].map(Object.freeze))
export const FIXTURE_MUTATION_SLOTS = Object.freeze(FIXTURE_MUTATION_SLOT_SPECS.map(row => row.slot))
export const CALLABLE_CAPS = Object.freeze({
  createCompany: 2, inviteMember: 3, listInvitations: 10, cancelInvite: 1,
  resendInvite: 2, previewInvite: 8, acceptInvite: 6, getCompanyAccess: 7,
})
export const TOTAL_CALLABLE_CAP = 40
export const READ_ONLY_CALLABLES = Object.freeze(['listInvitations', 'previewInvite', 'getCompanyAccess'])
export const SCENARIO_NAMES = Object.freeze([
  'mailbox-cancelled-invitation',
  'mailbox-resend-token-rotation',
  'wrong-identity-denial',
  'owner-mailbox-verification-acceptance',
  'existing-user-company-isolation',
  'same-uid-replay-session-recovery',
])
export const READBACK_CHECKS = Object.freeze([
  'company-a', 'company-b', 'mailbox-membership', 'owner-b-membership',
  'mailbox-final-invitation', 'owner-b-invitation', 'mailbox-lock',
  'owner-b-lock', 'audit-events', 'owner-mailbox-profile',
])
export const TRANSPORT_CAPS = Object.freeze({
  authorizedRequests: 80, dispatchedRequests: 80, oauthRefreshes: 20, verificationDispatches: 1,
})

const blocked = () => { throw new Error('live_acceptance_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const exactKeys = (value, keys) => record(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const rfc3339 = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value))
const deepFreeze = value => {
  if (record(value) || Array.isArray(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

export function liveAcceptanceGuard(options, git) {
  guard({ ...options, ...git })
}

/** Validate both the exact private artifact bytes and its deliberately tiny,
 * sanitized JSON contract. A re-serialized or newer receipt is not accepted. */
export function validateMailboxDiscoveryReceipt(bytes) {
  if (!(typeof bytes === 'string' || Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) ||
      sha256(bytes) !== PINNED_DISCOVERY_SHA256) blocked()
  let value
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { blocked() }
  if (!exactKeys(value, [
    'task', 'status', 'project', 'capturedAt', 'accountExists', 'account',
    'profile', 'cloudMutations', 'emailsSent', 'sourceHead',
  ]) || !exactKeys(value.profile, ['profileExists', 'profileFieldsSha256']) ||
      value.task !== 'SEC-006 Stage 8 mailbox discovery' ||
      value.status !== 'MAILBOX_DISCOVERY_COMPLETE' || value.project !== PROJECT ||
      !iso(value.capturedAt) || value.accountExists !== false || value.account !== null ||
      value.profile.profileExists !== false || value.profile.profileFieldsSha256 !== null ||
      value.cloudMutations !== 0 || value.emailsSent !== 0 ||
      value.sourceHead !== PINNED_DISCOVERY_SOURCE_HEAD) blocked()
  return Object.freeze({
    project: value.project,
    sourceHead: value.sourceHead,
    capturedAt: value.capturedAt,
    accountExists: false,
    profileExists: false,
    receiptSha256: PINNED_DISCOVERY_SHA256,
  })
}

/** Pure, network-free preflight used by the executable wrapper. */
export async function prepareLiveAcceptance({ options, gitState, mailboxText, discoveryReceipt, distFiles, now = () => new Date().toISOString() }) {
  const git = typeof gitState === 'function' ? await gitState() : gitState
  liveAcceptanceGuard(options, git)
  const discovery = validateMailboxDiscoveryReceipt(discoveryReceipt)
  const mailboxSha256 = sha256(normalizeMailbox(mailboxText))
  safeRunId(options.runId)
  if (!Array.isArray(distFiles) || distFiles.length === 0) blocked()
  const files = distFiles.map(row => {
    if (!exactKeys(row, ['path', 'sha256']) || typeof row.path !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,300}$/.test(row.path) || row.path.includes('..') ||
        row.path.startsWith('/') || !hex64(row.sha256)) blocked()
    return { path: row.path.replaceAll('\\', '/'), sha256: row.sha256 }
  }).sort((a, b) => a.path.localeCompare(b.path))
  if (new Set(files.map(row => row.path)).size !== files.length) blocked()
  const preparedAt = now()
  if (!iso(preparedAt)) blocked()
  const fixtureEnvelope = buildFixtureEnvelope({ runId: options.runId, mailboxSha256 })
  const result = {
    task: 'SEC-006 Stage 8 live acceptance', status: 'LIVE_ACCEPTANCE_PREPARED',
    project: PROJECT, sourceHead: options.expectedHead, runId: options.runId,
    mailboxSha256, discoveryReceiptSha256: discovery.receiptSha256,
    fixtureEnvelopeSha256: sha256(JSON.stringify(fixtureEnvelope)),
    distFilesCount: files.length, distFilesSha256: sha256(JSON.stringify(files)),
    limits: { ...LIVE_LIMITS }, preparedAt, cloudMutations: 0, emailsSent: 0,
  }
  assertNoSecretMaterial(result)
  return result
}

function safeRunId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{7,39}$/.test(value) || value.includes('--')) blocked()
  return value
}

function exactIdMap(value, keys) {
  if (!exactKeys(value, keys) || keys.some(key => !safeId(value[key])) || new Set(Object.values(value)).size !== keys.length) blocked()
  return value
}

export function buildFixtureEnvelope({ runId, mailboxSha256 }) {
  safeRunId(runId)
  if (!hex64(mailboxSha256)) blocked()
  return deepFreeze({
    version: 1, task: 'SEC-006 Stage 8 live acceptance', project: PROJECT,
    runId, namespaceSha256: sha256(JSON.stringify([PROJECT, runId, mailboxSha256])),
    mailboxSha256, limits: { ...LIVE_LIMITS }, mutationSlots: [...FIXTURE_MUTATION_SLOTS],
  })
}

/**
 * Materialize the exact fixture namespace after createCompany/Auth return their
 * provider IDs. No mailbox is accepted here: only its SHA-256 and the two
 * already-computed application lock IDs cross this boundary.
 */
export function buildFixturePlan({ runId, mailboxSha256, companyIds, syntheticAuthUids, ownerMailboxUid, lockIds }) {
  safeRunId(runId)
  if (!hex64(mailboxSha256) || !safeId(ownerMailboxUid)) blocked()
  exactIdMap(companyIds, ['a', 'b'])
  exactIdMap(syntheticAuthUids, ['ownerA', 'ownerB'])
  if (Object.values(syntheticAuthUids).includes(ownerMailboxUid)) blocked()
  if (!exactKeys(lockIds, ['mailbox', 'ownerB']) || !hex64(lockIds.mailbox) || !hex64(lockIds.ownerB) || lockIds.mailbox === lockIds.ownerB) blocked()

  const members = [
    { company: 'a', uidKind: 'ownerA', path: `companies/${companyIds.a}/members/${syntheticAuthUids.ownerA}`, cleanup: 'DELETE' },
    { company: 'b', uidKind: 'ownerB', path: `companies/${companyIds.b}/members/${syntheticAuthUids.ownerB}`, cleanup: 'DELETE' },
    { company: 'a', uidKind: 'ownerB', path: `companies/${companyIds.a}/members/${syntheticAuthUids.ownerB}`, cleanup: 'DELETE' },
    { company: 'a', uidKind: 'ownerMailbox', path: `companies/${companyIds.a}/members/${ownerMailboxUid}`, cleanup: 'CAS_REQUIRED' },
  ]
  const envelope = buildFixtureEnvelope({ runId, mailboxSha256 })
  const plan = {
    version: 1,
    task: 'SEC-006 Stage 8 live acceptance',
    project: PROJECT,
    runId,
    namespaceSha256: sha256(JSON.stringify([PROJECT, runId, mailboxSha256])),
    fixtureEnvelopeSha256: sha256(JSON.stringify(envelope)),
    mailboxSha256,
    counts: Object.freeze({
      companies: LIVE_LIMITS.companies, syntheticAuthUsers: LIVE_LIMITS.syntheticAuthUsers,
      ownerMailboxAccounts: LIVE_LIMITS.ownerMailboxAccounts, invitations: LIVE_LIMITS.invitations,
      memberships: LIVE_LIMITS.memberships, invitationLocks: LIVE_LIMITS.invitationLocks,
      auditEvents: LIVE_LIMITS.auditEvents,
    }),
    companies: [
      { key: 'a', id: companyIds.a, path: `companies/${companyIds.a}`, dataPath: `company_data/${companyIds.a}` },
      { key: 'b', id: companyIds.b, path: `companies/${companyIds.b}`, dataPath: `company_data/${companyIds.b}` },
    ],
    authUsers: [
      { key: 'ownerA', uid: syntheticAuthUids.ownerA, disposition: 'DELETE', profilePath: `users/${syntheticAuthUids.ownerA}`, bootstrapPath: `user_bootstrap/${syntheticAuthUids.ownerA}` },
      { key: 'ownerB', uid: syntheticAuthUids.ownerB, disposition: 'DELETE', profilePath: `users/${syntheticAuthUids.ownerB}`, bootstrapPath: `user_bootstrap/${syntheticAuthUids.ownerB}` },
      { key: 'ownerMailbox', uid: ownerMailboxUid, disposition: 'PRESERVE_AUTH', profilePath: `users/${ownerMailboxUid}`, bootstrapPath: null },
    ],
    members,
    locks: [
      { key: 'mailbox', id: lockIds.mailbox, path: `invitationLocks/${lockIds.mailbox}`, invitationSlots: ['mailboxCancelled', 'mailboxFinal'] },
      { key: 'ownerB', id: lockIds.ownerB, path: `invitationLocks/${lockIds.ownerB}`, invitationSlots: ['ownerBExisting'] },
    ],
    dynamicSlots: Object.freeze({
      invitations: ['mailboxCancelled', 'mailboxFinal', 'ownerBExisting'],
      // Every listed successful handler calls writeAuditEvent exactly once;
      // list/preview/denial/replay paths write none. This is therefore 8
      // events under A and the company-created event under B, total 9.
      auditEvents: [
        { slot: 'companyACreated', company: 'a' },
        { slot: 'companyBCreated', company: 'b' },
        { slot: 'mailboxCancelledCreated', company: 'a' },
        { slot: 'mailboxCancelled', company: 'a' },
        { slot: 'mailboxFinalCreated', company: 'a' },
        { slot: 'mailboxFinalResent', company: 'a' },
        { slot: 'mailboxFinalAccepted', company: 'a' },
        { slot: 'ownerBInviteCreated', company: 'a' },
        { slot: 'ownerBInviteAccepted', company: 'a' },
      ],
    }),
  }
  assertNoSecretMaterial(plan)
  return deepFreeze(plan)
}

export function validateFixturePlan(plan) {
  if (!exactKeys(plan, [
    'version', 'task', 'project', 'runId', 'namespaceSha256', 'fixtureEnvelopeSha256', 'mailboxSha256',
    'counts', 'companies', 'authUsers', 'members', 'locks', 'dynamicSlots',
  ]) || !Array.isArray(plan.companies) || plan.companies.length !== 2 ||
      !Array.isArray(plan.authUsers) || plan.authUsers.length !== 3 ||
      !Array.isArray(plan.locks) || plan.locks.length !== 2) blocked()
  const expected = buildFixturePlan({
    runId: plan.runId, mailboxSha256: plan.mailboxSha256,
    companyIds: { a: plan.companies[0]?.id, b: plan.companies[1]?.id },
    syntheticAuthUids: { ownerA: plan.authUsers[0]?.uid, ownerB: plan.authUsers[1]?.uid },
    ownerMailboxUid: plan.authUsers[2]?.uid,
    lockIds: { mailbox: plan.locks[0]?.id, ownerB: plan.locks[1]?.id },
  })
  if (JSON.stringify(plan) !== JSON.stringify(expected)) blocked()
  return true
}

const ALLOWED_TRANSITIONS = Object.freeze({
  START: ['PRECONDITIONS_VERIFIED'],
  PRECONDITIONS_VERIFIED: ['PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED', 'FAILED'],
  PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED: ['SCENARIOS_RUNNING', 'FAILED'],
  SCENARIOS_RUNNING: ['FIXTURE_MUTATION_MAY_BE_SENT', 'CALLABLE_REQUEST_MAY_BE_SENT', 'FAILED'],
  FIXTURE_MUTATION_MAY_BE_SENT: ['FIXTURE_MUTATION_RECONCILED', 'FIXTURE_MUTATION_UNCERTAIN', 'FAILED'],
  FIXTURE_MUTATION_RECONCILED: ['FIXTURE_MUTATION_MAY_BE_SENT', 'CALLABLE_REQUEST_MAY_BE_SENT', 'EMAIL_REQUEST_MAY_BE_SENT', 'MATERIALIZED_FIXTURE_PLAN_COMMITTED', 'FAILED'],
  FIXTURE_MUTATION_UNCERTAIN: ['FAILED'],
  CALLABLE_REQUEST_MAY_BE_SENT: ['CALLABLE_REQUEST_RECONCILED', 'CALLABLE_REQUEST_UNCERTAIN', 'FAILED'],
  CALLABLE_REQUEST_RECONCILED: ['FIXTURE_MUTATION_MAY_BE_SENT', 'CALLABLE_REQUEST_MAY_BE_SENT', 'EMAIL_REQUEST_MAY_BE_SENT', 'MATERIALIZED_FIXTURE_PLAN_COMMITTED', 'FAILED'],
  CALLABLE_REQUEST_UNCERTAIN: ['FAILED'],
  EMAIL_REQUEST_MAY_BE_SENT: ['EMAIL_SENT', 'EMAIL_UNCERTAIN', 'FAILED'],
  EMAIL_SENT: ['VERIFIED_SESSION_COMMITTED', 'FAILED'],
  VERIFIED_SESSION_COMMITTED: ['FIXTURE_MUTATION_MAY_BE_SENT', 'CALLABLE_REQUEST_MAY_BE_SENT', 'FAILED'],
  EMAIL_UNCERTAIN: ['FAILED'],
  MATERIALIZED_FIXTURE_PLAN_COMMITTED: ['ACCEPTANCE_VERIFIED', 'FAILED'],
  ACCEPTANCE_VERIFIED: ['CLEANUP_DEFERRED', 'FAILED'],
  CLEANUP_DEFERRED: [],
  FAILED: [],
})

const forbiddenKey = /(?:authorization|cookie|email|mailbox|password|secret|token)/i
const forbiddenText = /(?:bearer\s+|eyJ[a-zA-Z0-9_-]{8,}\.|[?&](?:oobCode|token|key|password)=|[^\s@]+@[^\s@]+\.[^\s@]+)/i

export function assertNoSecretMaterial(value) {
  const visit = (node, key = '') => {
    if (forbiddenKey.test(key)) {
      const safeHash = /Sha256$/.test(key) && hex64(node)
      const safeCount = /(?:Count|Counts|Accounts|Emails|Sent)$/.test(key) && Number.isSafeInteger(node) && node >= 0
      if (!safeHash && !safeCount) blocked()
    }
    if (typeof node === 'string' && forbiddenText.test(node)) blocked()
    if (Array.isArray(node)) return node.forEach(item => visit(item))
    if (record(node)) for (const [childKey, child] of Object.entries(node)) visit(child, childKey)
  }
  visit(value)
}

function validateEvent(event, expectedSeq) {
  if (!exactKeys(event, ['seq', 'status', 'at', 'details']) || event.seq !== expectedSeq ||
      !Object.hasOwn(ALLOWED_TRANSITIONS, event.status) || !iso(event.at) || !record(event.details)) blocked()
  const schemas = {
    PRECONDITIONS_VERIFIED: [],
    PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED: ['envelopeSha256'],
    SCENARIOS_RUNNING: [],
    FIXTURE_MUTATION_MAY_BE_SENT: ['index', 'slot', 'callCount', 'callable', 'callableCount', 'totalCallableCount', 'requestSha256'],
    FIXTURE_MUTATION_RECONCILED: ['index', 'slot', 'callCount', 'callable', 'callableCount', 'totalCallableCount', 'disposition', 'outcomeSha256', 'readbackSha256'],
    FIXTURE_MUTATION_UNCERTAIN: ['index', 'slot', 'callable', 'callableCount', 'totalCallableCount', 'outcomeSha256'],
    CALLABLE_REQUEST_MAY_BE_SENT: ['callable', 'callableCount', 'totalCallableCount', 'requestSha256', 'bindingSha256'],
    CALLABLE_REQUEST_RECONCILED: ['callable', 'callableCount', 'totalCallableCount', 'outcomeSha256', 'readbackSha256', 'bindingSha256'],
    CALLABLE_REQUEST_UNCERTAIN: ['callable', 'callableCount', 'totalCallableCount', 'outcomeSha256', 'bindingSha256'],
    EMAIL_REQUEST_MAY_BE_SENT: ['requestSha256'],
    EMAIL_SENT: ['outcomeSha256'],
    VERIFIED_SESSION_COMMITTED: ['challengeSha256', 'sessionProofSha256'],
    EMAIL_UNCERTAIN: ['outcomeSha256'],
    MATERIALIZED_FIXTURE_PLAN_COMMITTED: ['planSha256'],
    ACCEPTANCE_VERIFIED: ['observationsSha256'],
    CLEANUP_DEFERRED: ['cleanupPlanSha256'],
    FAILED: ['failureCode'],
  }
  if (!exactKeys(event.details, schemas[event.status])) blocked()
  for (const [key, value] of Object.entries(event.details)) {
    if (key.endsWith('Sha256') && !hex64(value)) blocked()
  }
  if (event.status === 'FAILED' && !['PRECONDITION', 'FIXTURE_MUTATION_UNCERTAIN', 'CALLABLE_REQUEST_UNCERTAIN', 'EMAIL_UNCERTAIN', 'VALIDATION', 'READBACK', 'TRANSPORT'].includes(event.details.failureCode)) blocked()
  assertNoSecretMaterial(event)
}

function mutationProgress(events) {
  const reconciled = events.filter(event => event.status === 'FIXTURE_MUTATION_RECONCILED')
  for (let index = 0; index < reconciled.length; index++) {
    const details = reconciled[index].details
    if (details.index !== index || details.callCount !== index + 1 || details.slot !== FIXTURE_MUTATION_SLOTS[index] ||
        details.callable !== FIXTURE_MUTATION_SLOT_SPECS[index].callable ||
        details.disposition !== FIXTURE_MUTATION_SLOT_SPECS[index].disposition) blocked()
  }
  return reconciled.length
}

function callableProgress(events) {
  const counts = Object.fromEntries(Object.keys(CALLABLE_CAPS).map(name => [name, 0]))
  let total = 0
  for (const event of events) {
    if (!['FIXTURE_MUTATION_MAY_BE_SENT', 'CALLABLE_REQUEST_MAY_BE_SENT'].includes(event.status)) continue
    const callable = event.details.callable
    if (callable === null) {
      if (event.details.callableCount !== null || event.details.totalCallableCount !== total) blocked()
      continue
    }
    if (!Object.hasOwn(counts, callable)) blocked()
    counts[callable]++
    total++
    if (event.details.callableCount !== counts[callable] || event.details.totalCallableCount !== total ||
        counts[callable] > CALLABLE_CAPS[callable] || total > TOTAL_CALLABLE_CAP) blocked()
  }
  return { counts, total }
}

export function validateJournalTransition(events, nextEvent) {
  if (!Array.isArray(events)) blocked()
  events.forEach((event, index) => {
    validateEvent(event, index)
    const previous = index === 0 ? 'START' : events[index - 1].status
    if (!ALLOWED_TRANSITIONS[previous].includes(event.status)) blocked()
  })
  validateEvent(nextEvent, events.length)
  const previous = events.length === 0 ? 'START' : events.at(-1).status
  if (!ALLOWED_TRANSITIONS[previous].includes(nextEvent.status)) blocked()
  const combined = [...events, nextEvent]
  for (const status of ['EMAIL_REQUEST_MAY_BE_SENT', 'EMAIL_SENT', 'EMAIL_UNCERTAIN']) {
    if (combined.filter(event => event.status === status).length > 1) blocked()
  }
  const progress = mutationProgress(events)
  const callableBefore = callableProgress(events)
  if (nextEvent.status === 'FIXTURE_MUTATION_MAY_BE_SENT') {
    const spec = FIXTURE_MUTATION_SLOT_SPECS[progress]
    const expectedCallableCount = spec?.callable === null ? null : callableBefore.counts[spec?.callable] + 1
    const expectedTotal = callableBefore.total + (spec?.callable === null ? 0 : 1)
    if (nextEvent.details.callCount !== progress + 1 ||
        nextEvent.details.index !== progress || nextEvent.details.slot !== FIXTURE_MUTATION_SLOTS[progress] ||
        nextEvent.details.callable !== spec?.callable || nextEvent.details.callableCount !== expectedCallableCount ||
        nextEvent.details.totalCallableCount !== expectedTotal || !hex64(nextEvent.details.requestSha256)) blocked()
    if (spec?.callable !== null && (expectedCallableCount > CALLABLE_CAPS[spec.callable] || expectedTotal > TOTAL_CALLABLE_CAP)) blocked()
  }
  if (nextEvent.status === 'FIXTURE_MUTATION_RECONCILED') {
    const pendingEvent = events.at(-1)
    if (pendingEvent?.status !== 'FIXTURE_MUTATION_MAY_BE_SENT' || nextEvent.details.callCount !== pendingEvent.details.callCount ||
        nextEvent.details.index !== pendingEvent.details.index || nextEvent.details.slot !== pendingEvent.details.slot ||
        nextEvent.details.callable !== pendingEvent.details.callable || nextEvent.details.callableCount !== pendingEvent.details.callableCount ||
        nextEvent.details.totalCallableCount !== pendingEvent.details.totalCallableCount ||
        nextEvent.details.disposition !== FIXTURE_MUTATION_SLOT_SPECS[progress].disposition ||
        !hex64(nextEvent.details.outcomeSha256) || !hex64(nextEvent.details.readbackSha256)) blocked()
  }
  if (nextEvent.status === 'FIXTURE_MUTATION_UNCERTAIN') {
    const pendingEvent = events.at(-1)
    if (pendingEvent?.status !== 'FIXTURE_MUTATION_MAY_BE_SENT' ||
        nextEvent.details.index !== pendingEvent.details.index || nextEvent.details.slot !== pendingEvent.details.slot ||
        nextEvent.details.callable !== pendingEvent.details.callable || nextEvent.details.callableCount !== pendingEvent.details.callableCount ||
        nextEvent.details.totalCallableCount !== pendingEvent.details.totalCallableCount) blocked()
  }
  if (nextEvent.status === 'CALLABLE_REQUEST_MAY_BE_SENT') {
    const callable = nextEvent.details.callable
    if (!READ_ONLY_CALLABLES.includes(callable) || nextEvent.details.callableCount !== callableBefore.counts[callable] + 1 ||
        nextEvent.details.totalCallableCount !== callableBefore.total + 1 || !hex64(nextEvent.details.requestSha256) || !hex64(nextEvent.details.bindingSha256) ||
        nextEvent.details.callableCount > CALLABLE_CAPS[callable] || nextEvent.details.totalCallableCount > TOTAL_CALLABLE_CAP) blocked()
  }
  if (['CALLABLE_REQUEST_RECONCILED', 'CALLABLE_REQUEST_UNCERTAIN'].includes(nextEvent.status)) {
    const pendingEvent = events.at(-1)
    if (pendingEvent?.status !== 'CALLABLE_REQUEST_MAY_BE_SENT' || nextEvent.details.callable !== pendingEvent.details.callable ||
        nextEvent.details.callableCount !== pendingEvent.details.callableCount ||
        nextEvent.details.totalCallableCount !== pendingEvent.details.totalCallableCount ||
        nextEvent.details.bindingSha256 !== pendingEvent.details.bindingSha256 ||
        !hex64(nextEvent.details.outcomeSha256) ||
        (nextEvent.status === 'CALLABLE_REQUEST_RECONCILED' && !hex64(nextEvent.details.readbackSha256))) blocked()
  }
  if (nextEvent.status === 'EMAIL_REQUEST_MAY_BE_SENT' && progress !== 12) blocked()
  if (nextEvent.status === 'MATERIALIZED_FIXTURE_PLAN_COMMITTED' &&
      (progress !== FIXTURE_MUTATION_SLOTS.length || !exactKeys(nextEvent.details, ['planSha256']) || !hex64(nextEvent.details.planSha256))) blocked()
  return true
}

export function appendJournalEvent(events, nextEvent) {
  validateJournalTransition(events, nextEvent)
  return Object.freeze([...events, Object.freeze(structuredClone(nextEvent))])
}

export function validateCompleteJournal(events) {
  if (!Array.isArray(events) || events.length === 0) blocked()
  const rebuilt = []
  for (const event of events) rebuilt.push(appendJournalEvent(rebuilt, event).at(-1))
  if (events.at(-1).status !== 'CLEANUP_DEFERRED' || mutationProgress(events) !== FIXTURE_MUTATION_SLOTS.length ||
      events.filter(event => event.status === 'EMAIL_REQUEST_MAY_BE_SENT').length !== 1 ||
      events.filter(event => event.status === 'EMAIL_SENT').length !== 1 ||
      events.filter(event => event.status === 'VERIFIED_SESSION_COMMITTED').length !== 1 ||
      events.some(event => event.status === 'EMAIL_UNCERTAIN')) blocked()
  return true
}

/** Parse only fully newline-terminated JSONL and return resumable counters.
 * Terminal or uncertain/request-in-flight journals are evidence, never replay
 * instructions, and are deliberately rejected for recovery. */
function parseJournal(bytes, allowedPendingStatus = null) {
  if (!(typeof bytes === 'string' || Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) blocked()
  const text = Buffer.from(bytes).toString('utf8')
  if (!text.endsWith('\n') || text.includes('\0')) blocked()
  const lines = text.slice(0, -1).split('\n')
  if (lines.length === 0 || lines.some(line => line.trim() === '')) blocked()
  let events = []
  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { blocked() }
    events = appendJournalEvent(events, event)
  }
  const last = events.at(-1).status
  if (['FAILED', 'FIXTURE_MUTATION_UNCERTAIN', 'CALLABLE_REQUEST_UNCERTAIN', 'EMAIL_UNCERTAIN', 'CLEANUP_DEFERRED'].includes(last) ||
      (last === 'FIXTURE_MUTATION_MAY_BE_SENT' && allowedPendingStatus !== last) ||
      (last === 'CALLABLE_REQUEST_MAY_BE_SENT' && allowedPendingStatus !== last) ||
      (last === 'EMAIL_REQUEST_MAY_BE_SENT' && allowedPendingStatus !== last)) blocked()
  const emailMay = events.filter(event => event.status === 'EMAIL_REQUEST_MAY_BE_SENT')
  const emailSent = events.filter(event => event.status === 'EMAIL_SENT')
  const reconciled = events.filter(event => event.status === 'FIXTURE_MUTATION_RECONCILED')
  const callables = callableProgress(events)
  return deepFreeze({
    events, nextSeq: events.length, reconciledMutations: mutationProgress(events),
    mutationDispatchCount: events.filter(event => event.status === 'FIXTURE_MUTATION_MAY_BE_SENT').length,
    writeReconciledCount: reconciled.filter(event => event.details.disposition === 'WRITE').length,
    noWriteReconciledCount: reconciled.filter(event => event.details.disposition === 'NO_WRITE').length,
    idempotentReadbackCount: reconciled.filter(event => event.details.disposition === 'IDEMPOTENT_READBACK').length,
    emailRequestMayBeSentCount: emailMay.length, emailSentCount: emailSent.length,
    emailRequestSha256: emailMay[0]?.details.requestSha256 ?? null,
    callableCounts: callables.counts, totalCallableCount: callables.total,
  })
}

export function recoverLiveAcceptanceJournal(bytes) {
  return parseJournal(bytes)
}

/** Bind a browser/provider dispatch to the exact, fully persisted JSONL state.
 * This validates evidence only; it performs no I/O and grants no transport
 * access by itself. */
export function authorizePendingDispatchJournal(bytes, kind) {
  const expectedStatus = kind === 'fixture' ? 'FIXTURE_MUTATION_MAY_BE_SENT'
    : kind === 'callable' ? 'CALLABLE_REQUEST_MAY_BE_SENT'
      : kind === 'email' ? 'EMAIL_REQUEST_MAY_BE_SENT' : null
  if (!expectedStatus) blocked()
  const state = parseJournal(bytes, expectedStatus)
  const pending = state.events.at(-1)
  if (pending.status !== expectedStatus) blocked()
  const result = {
    kind,
    pendingStatus: pending.status,
    pendingSeq: pending.seq,
    requestSha256: pending.details.requestSha256,
    mutationDispatchCount: state.mutationDispatchCount,
    reconciledMutations: state.reconciledMutations,
    emailRequestMayBeSentCount: state.emailRequestMayBeSentCount,
    emailSentCount: state.emailSentCount,
    callableCounts: state.callableCounts,
    totalCallableCount: state.totalCallableCount,
    journalSha256: sha256(bytes),
    ...(kind === 'fixture' ? {
      index: pending.details.index,
      slot: pending.details.slot,
      callCount: pending.details.callCount,
      disposition: FIXTURE_MUTATION_SLOT_SPECS[pending.details.index].disposition,
    } : kind === 'callable' ? {
      callable: pending.details.callable,
      callableCount: pending.details.callableCount,
      bindingSha256: pending.details.bindingSha256,
    } : {}),
  }
  assertNoSecretMaterial(result)
  return deepFreeze(result)
}

function bodyHash(body) {
  if (body === undefined || body === null) return null
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return sha256(body)
  blocked()
}

const CALLABLES = new Set(['createCompany', 'inviteMember', 'listInvitations', 'cancelInvite', 'resendInvite', 'previewInvite', 'acceptInvite', 'getCompanyAccess'])

function apiKeyQuery(url) {
  return url.searchParams.size === 1 && typeof url.searchParams.get('key') === 'string' && url.searchParams.get('key').length >= 10
}

export function classifyLiveEndpoint(method, raw) {
  if (typeof raw !== 'string' || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) blocked()
  const url = new URL(raw)
  const callableHost = new RegExp(`^[a-z0-9-]+-${PROJECT}\\.cloudfunctions\\.net$`)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || /@|%40|\.\.|%2f|%5c/i.test(url.pathname)) blocked()
  if (callableHost.test(url.hostname) && method === 'POST' && url.search === '' && CALLABLES.has(url.pathname.slice(1))) {
    return { url: url.href, kind: 'callable', verificationEmail: false }
  }
  const identityPaths = new Set(['/v1/accounts:signUp', '/v1/accounts:signInWithPassword', '/v1/accounts:lookup', '/v1/accounts:sendOobCode', '/v1/accounts:update', '/v1/accounts:delete'])
  if (url.hostname === 'identitytoolkit.googleapis.com' && method === 'POST' && identityPaths.has(url.pathname) && apiKeyQuery(url)) {
    return { url: url.href, kind: 'identity', verificationEmail: url.pathname === '/v1/accounts:sendOobCode' }
  }
  if (url.hostname === 'securetoken.googleapis.com' && method === 'POST' && url.pathname === '/v1/token' && apiKeyQuery(url)) {
    return { url: url.href, kind: 'secure-token', verificationEmail: false }
  }
  const documents = `/v1/projects/${PROJECT}/databases/(default)/documents`
  const safeFirestoreQuery = [...url.searchParams.keys()].every(key => !forbiddenKey.test(key))
  const documentSuffix = url.pathname.startsWith(`${documents}/`) ? url.pathname.slice(documents.length + 1) : ''
  const pathParts = documentSuffix.split('/')
  const documentPath = /^(?:users|user_bootstrap|companies|company_data|invitations|invitationLocks|system)(?:\/[a-zA-Z0-9_-]{1,128})*$/.test(documentSuffix)
  const firestoreDocumentMethod = documentPath && (
    method === 'GET' ||
    (method === 'POST' && pathParts.length % 2 === 1 && pathParts[0] !== 'system') ||
    (['PATCH', 'DELETE'].includes(method) && pathParts.length % 2 === 0 && pathParts[0] !== 'system')
  )
  const firestoreRpc = new Map([[`${documents}:commit`, 'POST'], [`${documents}:batchGet`, 'POST'], [`${documents}:runQuery`, 'POST']])
  if (url.hostname === 'firestore.googleapis.com' && safeFirestoreQuery &&
      (firestoreDocumentMethod || firestoreRpc.get(url.pathname) === method)) {
    return { url: url.href, kind: 'firestore', verificationEmail: false }
  }
  if (url.hostname === 'firebase.googleapis.com' && method === 'GET' && url.pathname === `/v1beta1/projects/${PROJECT}` && url.search === '') {
    return { url: url.href, kind: 'project', verificationEmail: false }
  }
  blocked()
}

/** One authorization opens one request window. The SDK may refresh OAuth once
 * inside that window; the exact provider request is consumed before dispatch,
 * so a native timeout cannot be retried by a library. */
export function liveAcceptanceTransport(baseFetch, { recoveryJournal, readJournal } = {}) {
  if (typeof baseFetch !== 'function') blocked()
  const recovered = recoveryJournal === undefined ? null : recoverLiveAcceptanceJournal(recoveryJournal)
  if (readJournal !== undefined && typeof readJournal !== 'function') blocked()
  let pending = null
  let emailReservation = null
  let emailDispatched = Boolean(recovered?.emailRequestMayBeSentCount)
  return {
    reserveVerificationEmail(requestSha256) {
      if (!recovered || !readJournal || emailReservation || emailDispatched ||
          recovered.emailRequestMayBeSentCount !== 0 || !hex64(requestSha256)) blocked()
      emailReservation = requestSha256
    },
    authorizeRequest(spec) {
      if (pending || !exactKeys(spec, ['method', 'url', 'bodySha256'])) blocked()
      const method = spec.method
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method) ||
          !(spec.bodySha256 === null || hex64(spec.bodySha256))) blocked()
      const endpoint = classifyLiveEndpoint(method, spec.url)
      if ((method === 'GET' || method === 'DELETE') && spec.bodySha256 !== null) blocked()
      if (endpoint.verificationEmail && emailReservation !== spec.bodySha256) blocked()
      pending = { method, url: endpoint.url, bodySha256: spec.bodySha256, refreshUsed: false, requestUsed: false, verificationEmail: endpoint.verificationEmail }
    },
    hasPendingRequest() { return Boolean(pending && !pending.requestUsed) },
    fetch: async (input, init = {}) => {
      if (!pending || (typeof input !== 'string' && !(input instanceof URL))) blocked()
      const url = new URL(input)
      if (url.username || url.password || url.hash) blocked()
      const method = (init.method ?? 'GET').toUpperCase()
      if (method === 'POST' && url.href === OAUTH_REFRESH_URL) {
        if (pending.refreshUsed || pending.requestUsed) {
          pending = null
          blocked()
        }
        pending.refreshUsed = true
        try {
          return await baseFetch(input, { ...init, redirect: 'error' })
        } catch (error) {
          pending = null
          throw error
        }
      }
      const active = pending
      pending = null
      const matches = !active.requestUsed && method === active.method && url.href === active.url && bodyHash(init.body) === active.bodySha256
      if (!matches) blocked()
      if (active.verificationEmail) {
        const durable = parseJournal(readJournal(), 'EMAIL_REQUEST_MAY_BE_SENT')
        if (emailDispatched || durable.emailRequestMayBeSentCount !== 1 || durable.emailSentCount !== 0 ||
            durable.emailRequestSha256 !== active.bodySha256 || durable.events.at(-1).status !== 'EMAIL_REQUEST_MAY_BE_SENT') blocked()
        emailDispatched = true
        emailReservation = null
      }
      // Consume before native dispatch. Caller must reconcile and explicitly
      // authorize another attempt after any thrown/unknown outcome.
      return baseFetch(input, { ...init, redirect: 'error', retries: 0 })
    },
  }
}

function validateDynamicIds(plan, observed) {
  if (!exactKeys(observed, ['invitationIds', 'auditEventIds'])) blocked()
  if (!exactKeys(observed.invitationIds, plan.dynamicSlots.invitations) ||
      plan.dynamicSlots.invitations.some(key => !safeId(observed.invitationIds[key])) ||
      new Set(Object.values(observed.invitationIds)).size !== plan.counts.invitations) blocked()
  if (!Array.isArray(observed.auditEventIds) || observed.auditEventIds.length !== plan.counts.auditEvents) blocked()
  for (let index = 0; index < observed.auditEventIds.length; index++) {
    const row = observed.auditEventIds[index]
    const expected = plan.dynamicSlots.auditEvents[index]
    if (!exactKeys(row, ['slot', 'company', 'id']) || row.slot !== expected.slot ||
        row.company !== expected.company || !safeId(row.id)) blocked()
  }
  if (new Set(observed.auditEventIds.map(row => `${row.company}/${row.id}`)).size !== plan.counts.auditEvents) blocked()
}

export function buildCleanupTargets(plan, observed) {
  validateFixturePlan(plan)
  validateDynamicIds(plan, observed)
  const company = Object.fromEntries(plan.companies.map(row => [row.key, row]))
  const destructive = {
    authUids: plan.authUsers.filter(row => row.disposition === 'DELETE').map(row => row.uid),
    firestorePaths: [
      ...Object.values(observed.invitationIds).map(id => `invitations/${id}`),
      ...plan.locks.map(row => row.path),
      ...observed.auditEventIds.map(row => `companies/${company[row.company].id}/audit_events/${row.id}`),
      ...plan.members.filter(row => row.cleanup === 'DELETE').map(row => row.path),
      ...plan.authUsers.filter(row => row.disposition === 'DELETE').flatMap(row => [row.bootstrapPath, row.profilePath]),
      ...plan.companies.flatMap(row => [row.dataPath, row.path]),
    ],
  }
  const casRequired = {
    authUids: [],
    firestorePaths: [
      plan.members.find(row => row.uidKind === 'ownerMailbox').path,
      plan.authUsers.find(row => row.key === 'ownerMailbox').profilePath,
    ],
  }
  const result = { version: 1, project: PROJECT, runId: plan.runId, destructive, casRequired }
  validateCleanupTargets(plan, result, observed)
  return Object.freeze(result)
}

export function validateCleanupTargets(plan, targets, observed) {
  validateFixturePlan(plan)
  validateDynamicIds(plan, observed)
  if (!exactKeys(targets, ['version', 'project', 'runId', 'destructive', 'casRequired']) ||
      targets.version !== 1 || targets.project !== PROJECT || targets.runId !== plan.runId ||
      !exactKeys(targets.destructive, ['authUids', 'firestorePaths']) ||
      !exactKeys(targets.casRequired, ['authUids', 'firestorePaths']) ||
      targets.casRequired.authUids.length !== 0) blocked()
  for (const group of [targets.destructive.authUids, targets.destructive.firestorePaths, targets.casRequired.firestorePaths]) {
    if (!Array.isArray(group) || group.some(value => typeof value !== 'string') || new Set(group).size !== group.length) blocked()
  }
  const owner = plan.authUsers.find(row => row.key === 'ownerMailbox')
  if (targets.destructive.authUids.includes(owner.uid) || targets.destructive.firestorePaths.includes(owner.profilePath) ||
      targets.destructive.firestorePaths.includes(plan.members.find(row => row.uidKind === 'ownerMailbox').path)) blocked()
  const rebuilt = buildExpectedCleanupTargets(plan, observed)
  if (JSON.stringify(targets) !== JSON.stringify(rebuilt)) blocked()
  return true
}

function buildExpectedCleanupTargets(plan, observed) {
  const company = Object.fromEntries(plan.companies.map(row => [row.key, row]))
  return {
    version: 1, project: PROJECT, runId: plan.runId,
    destructive: {
      authUids: plan.authUsers.filter(row => row.disposition === 'DELETE').map(row => row.uid),
      firestorePaths: [
        ...Object.values(observed.invitationIds).map(id => `invitations/${id}`),
        ...plan.locks.map(row => row.path),
        ...observed.auditEventIds.map(row => `companies/${company[row.company].id}/audit_events/${row.id}`),
        ...plan.members.filter(row => row.cleanup === 'DELETE').map(row => row.path),
        ...plan.authUsers.filter(row => row.disposition === 'DELETE').flatMap(row => [row.bootstrapPath, row.profilePath]),
        ...plan.companies.flatMap(row => [row.dataPath, row.path]),
      ],
    },
    casRequired: {
      authUids: [],
      firestorePaths: [
        plan.members.find(row => row.uidKind === 'ownerMailbox').path,
        plan.authUsers.find(row => row.key === 'ownerMailbox').profilePath,
      ],
    },
  }
}

export function sanitizePublicResult({ sourceHead, plan, journal, scenarios, observations, startedAt, finishedAt }) {
  if (!/^[a-f0-9]{40}$/.test(sourceHead ?? '') || !iso(startedAt) || !iso(finishedAt) ||
      !Array.isArray(scenarios) || scenarios.length !== SCENARIO_NAMES.length) blocked()
  validateFixturePlan(plan)
  validateCompleteJournal(journal)
  const journalCallables = callableProgress(journal)
  const safeScenarios = scenarios.map((row, index) => {
    if (!exactKeys(row, ['name', 'status']) || row.name !== SCENARIO_NAMES[index] || !['PASS', 'FAIL'].includes(row.status)) blocked()
    return { name: row.name, status: row.status }
  })
  if (!exactKeys(observations, ['readbacks', 'callableCounts', 'transportCounts']) ||
      !Array.isArray(observations.readbacks) || observations.readbacks.length !== READBACK_CHECKS.length ||
      !exactKeys(observations.callableCounts, Object.keys(CALLABLE_CAPS)) ||
      !exactKeys(observations.transportCounts, Object.keys(TRANSPORT_CAPS))) blocked()
  const readbacks = observations.readbacks.map((row, index) => {
    if (!exactKeys(row, ['check', 'stateSha256', 'updateTime']) || row.check !== READBACK_CHECKS[index] ||
        !hex64(row.stateSha256) || !rfc3339(row.updateTime)) blocked()
    return { ...row }
  })
  for (const [name, cap] of Object.entries(CALLABLE_CAPS)) {
    const count = observations.callableCounts[name]
    if (!Number.isSafeInteger(count) || count < 0 || count > cap) blocked()
  }
  const requiredCalls = {
    createCompany: 2, inviteMember: 3, listInvitations: 2, cancelInvite: 1,
    resendInvite: 2, previewInvite: 4, acceptInvite: 5, getCompanyAccess: 2,
  }
  if (Object.entries(requiredCalls).some(([name, minimum]) => observations.callableCounts[name] < minimum)) blocked()
  if (Object.values(observations.callableCounts).reduce((sum, count) => sum + count, 0) > TOTAL_CALLABLE_CAP) blocked()
  if (JSON.stringify(observations.callableCounts) !== JSON.stringify(journalCallables.counts) ||
      journalCallables.total !== Object.values(observations.callableCounts).reduce((sum, count) => sum + count, 0)) blocked()
  for (const [name, cap] of Object.entries(TRANSPORT_CAPS)) {
    const count = observations.transportCounts[name]
    if (!Number.isSafeInteger(count) || count < 0 || count > cap) blocked()
  }
  if (observations.transportCounts.authorizedRequests !== observations.transportCounts.dispatchedRequests ||
      observations.transportCounts.verificationDispatches !== 1) blocked()
  const planSha256 = sha256(JSON.stringify(plan))
  const observationsSha256 = sha256(JSON.stringify({ readbacks, callableCounts: observations.callableCounts, transportCounts: observations.transportCounts }))
  if (journal.find(event => event.status === 'MATERIALIZED_FIXTURE_PLAN_COMMITTED')?.details.planSha256 !== planSha256 ||
      journal.find(event => event.status === 'ACCEPTANCE_VERIFIED')?.details.observationsSha256 !== observationsSha256) blocked()
  const result = {
    task: 'SEC-006 Stage 8 live acceptance',
    status: safeScenarios.every(row => row.status === 'PASS') ? 'LIVE_ACCEPTANCE_VERIFIED' : 'LIVE_ACCEPTANCE_FAILED',
    project: PROJECT,
    sourceHead,
    runSha256: sha256(plan.runId),
    planSha256,
    observationsSha256,
    startedAt,
    finishedAt,
    counts: { ...plan.counts },
    scenarios: safeScenarios,
    readbacks,
    callableCounts: { ...observations.callableCounts },
    callableCaps: { ...CALLABLE_CAPS },
    totalCallableCap: TOTAL_CALLABLE_CAP,
    transportCounts: { ...observations.transportCounts },
    transportCaps: { ...TRANSPORT_CAPS },
    verificationDispatch: { requestMayBeSentEvents: 1, sentEvents: 1 },
    cleanup: 'DEFERRED_SEPARATE_APPROVAL',
  }
  assertNoSecretMaterial(result)
  return result
}
