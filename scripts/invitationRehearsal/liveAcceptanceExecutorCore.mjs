import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  CALLABLE_CAPS, FIXTURE_MUTATION_SLOT_SPECS, PROJECT, READBACK_CHECKS,
  READ_ONLY_CALLABLES, TOTAL_CALLABLE_CAP, TRANSPORT_CAPS, appendJournalEvent,
  assertNoSecretMaterial, buildCleanupTargets, buildFixtureEnvelope,
  buildFixturePlan, validateFixturePlan,
} from './liveAcceptanceCore.mjs'

export const ACTIVE_RULES_SHA256 = '15bbc0050dd1ed2259c921818794b4f234c4457ad3e66ee2d0fa1da6d148f89d'
export const FIELD_OVERRIDES_SHA256 = 'af2e9e80c150cc9a6b2f4c5f5bae330dacb214d7a104188fa5ef4fcfad3c6aee'
export const LIVE_FUNCTIONS = Object.freeze([
  'acceptInvite', 'cancelInvite', 'createCompany', 'getCompanyAccess',
  'inviteMember', 'listInvitations', 'previewInvite', 'resendInvite',
])
export const PREFLIGHT_ADAPTERS = Object.freeze([
  'project', 'functions', 'rules', 'indexes', 'auth', 'maintenance', 'subjectAbsence', 'build',
])
export const READ_ONLY_SLOT_SPECS = Object.freeze([
  { slot: 'listCancelledPending', afterFixtureCount: 5, callable: 'listInvitations', identity: 'ownerA', entity: 'companyA', expectation: 'PENDING' },
  { slot: 'previewCancelledActive', afterFixtureCount: 5, callable: 'previewInvite', identity: 'anonymous', entity: 'mailboxCancelledInvite', capability: 'mailboxCancelledCapability', expectation: 'ACTIVE' },
  { slot: 'previewCancelledDenied', afterFixtureCount: 6, callable: 'previewInvite', identity: 'anonymous', entity: 'mailboxCancelledInvite', capability: 'mailboxCancelledCapability', expectation: 'DENIED' },
  { slot: 'listFinalPending', afterFixtureCount: 7, callable: 'listInvitations', identity: 'ownerA', entity: 'companyA', expectation: 'PENDING' },
  { slot: 'previewFinalPreviousDenied', afterFixtureCount: 9, callable: 'previewInvite', identity: 'anonymous', entity: 'mailboxFinalInvite', capability: 'mailboxPreviousCapability', expectation: 'DENIED' },
  { slot: 'previewFinalCurrentActive', afterFixtureCount: 9, callable: 'previewInvite', identity: 'anonymous', entity: 'mailboxFinalInvite', capability: 'mailboxFinalCapability', expectation: 'ACTIVE' },
  { slot: 'mailboxCompanyAAccountant', afterFixtureCount: 13, callable: 'getCompanyAccess', identity: 'ownerMailbox', entity: 'companyA', expectation: 'ALLOWED_ACCOUNTANT' },
  { slot: 'mailboxCompanyBDenied', afterFixtureCount: 13, callable: 'getCompanyAccess', identity: 'ownerMailbox', entity: 'companyB', expectation: 'DENIED' },
  { slot: 'ownerBCompanyBAdmin', afterFixtureCount: 14, callable: 'getCompanyAccess', identity: 'ownerB', entity: 'companyB', expectation: 'ALLOWED_ADMIN' },
  { slot: 'ownerBCompanyADenied', afterFixtureCount: 14, callable: 'getCompanyAccess', identity: 'ownerB', entity: 'companyA', expectation: 'DENIED' },
  { slot: 'listOwnerBPending', afterFixtureCount: 14, callable: 'listInvitations', identity: 'ownerA', entity: 'companyA', expectation: 'PENDING' },
  { slot: 'ownerBCompanyAViewer', afterFixtureCount: 15, callable: 'getCompanyAccess', identity: 'ownerB', entity: 'companyA', expectation: 'ALLOWED_VIEWER' },
  { slot: 'ownerBCompanyBStillAdmin', afterFixtureCount: 15, callable: 'getCompanyAccess', identity: 'ownerB', entity: 'companyB', expectation: 'ALLOWED_ADMIN' },
  { slot: 'ownerBCompanyARecovery', afterFixtureCount: 16, callable: 'getCompanyAccess', identity: 'ownerB', entity: 'companyA', expectation: 'ALLOWED_VIEWER' },
].map(Object.freeze))

const blocked = () => { throw new Error('live_executor_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => record(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const rfc3339 = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const jsonHash = value => sha256(JSON.stringify(value))
const clone = value => structuredClone(value)
const frozen = value => Object.freeze(clone(value))
const verifiedSessionProofs = new WeakSet()
const privateRecoveryByJournal = new WeakMap()

const forbiddenPrivateRecoveryKey = /(?:authorization|cookie|password|secret|provider(?:body|error|payload|response)|raw(?:capability|invite|token))/i
const forbiddenPrivateRecoveryText = /(?:bearer\s+|eyJ[a-zA-Z0-9_-]{8,}\.|[?&](?:oobCode|token|key|password)=|[^\s@]+@[^\s@]+\.[^\s@]+)/i

/** Recovery output deliberately contains generated idempotency keys, while
 * still rejecting credentials, raw invite capabilities and provider data. */
export function assertPrivateRecoveryMaterial(value) {
  const visit = (node, key = '') => {
    if (forbiddenPrivateRecoveryKey.test(key)) {
      const safeHash = /Sha256$/.test(key) && hex64(node)
      if (!safeHash) blocked()
    }
    if (typeof node === 'string' && forbiddenPrivateRecoveryText.test(node)) blocked()
    if (Array.isArray(node)) return node.forEach(item => visit(item))
    if (record(node)) for (const [childKey, child] of Object.entries(node)) visit(child, childKey)
  }
  visit(value)
  return true
}

export function readPrivateExecutorRecovery(journal) {
  const value = privateRecoveryByJournal.get(journal)
  if (!value) blocked()
  const result = clone(value)
  assertPrivateRecoveryMaterial(result)
  return frozen(result)
}

function freshObservedAt(value, floor, ceiling) {
  if (!iso(value)) blocked()
  const instant = Date.parse(value)
  if (instant < floor || instant > ceiling) blocked()
  return instant
}

function validateExpectedPreflight(expected) {
  if (!exactKeys(expected, [
    'sourceHead', 'functionsSha256', 'authMetadataSha256', 'stagingFingerprint', 'mailboxSha256',
  ]) || !/^[a-f0-9]{40}$/.test(expected.sourceHead) ||
      [expected.functionsSha256, expected.authMetadataSha256, expected.stagingFingerprint, expected.mailboxSha256].some(value => !hex64(value))) blocked()
}

/** Run every fresh GET-only adapter before any journal event can authorize a
 * write. Adapters return only allowlisted metadata and hashes; provider bodies,
 * credentials and the mailbox value do not cross this boundary. */
export async function runFreshLivePreflight({ adapters, expected, now = () => Date.now(), maximumAgeMs = 120_000 }) {
  validateExpectedPreflight(expected)
  if (!exactKeys(adapters, PREFLIGHT_ADAPTERS) || PREFLIGHT_ADAPTERS.some(name => typeof adapters[name] !== 'function') ||
      !Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1 || maximumAgeMs > 300_000) blocked()
  const startedAtMs = now()
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) blocked()
  const values = await Promise.all(PREFLIGHT_ADAPTERS.map(name => adapters[name]()))
  const finishedAtMs = now()
  if (!Number.isSafeInteger(finishedAtMs) || finishedAtMs < startedAtMs || finishedAtMs - startedAtMs > maximumAgeMs) blocked()
  const result = Object.fromEntries(PREFLIGHT_ADAPTERS.map((name, index) => [name, values[index]]))
  const floor = startedAtMs - maximumAgeMs
  const ceiling = finishedAtMs + 1_000

  if (!exactKeys(result.project, ['projectId', 'databaseId', 'databaseLocation', 'databaseType', 'billingEnabled', 'sourceHead', 'observedAt']) ||
      result.project.projectId !== PROJECT || result.project.databaseId !== '(default)' || result.project.databaseLocation !== 'eur3' ||
      result.project.databaseType !== 'FIRESTORE_NATIVE' || result.project.billingEnabled !== true || result.project.sourceHead !== expected.sourceHead) blocked()
  if (!exactKeys(result.functions, ['items', 'inventorySha256', 'authzProbeAbsent', 'sourceHead', 'observedAt']) ||
      !Array.isArray(result.functions.items) || result.functions.inventorySha256 !== expected.functionsSha256 ||
      result.functions.authzProbeAbsent !== true || result.functions.sourceHead !== expected.sourceHead) blocked()
  const names = []
  for (const item of result.functions.items) {
    if (!exactKeys(item, ['name', 'state', 'generation', 'runtime', 'region', 'memory', 'cpu', 'concurrency', 'minInstances', 'maxInstances', 'timeoutSeconds']) ||
        !LIVE_FUNCTIONS.includes(item.name) || item.state !== 'ACTIVE' || item.generation !== 2 || item.runtime !== 'nodejs22' ||
        item.region !== 'us-central1' || item.memory !== '256Mi' || item.cpu !== 1 || item.concurrency !== 1 ||
        item.minInstances !== 0 || item.maxInstances !== 1 || item.timeoutSeconds !== 60) blocked()
    names.push(item.name)
  }
  if (names.length !== LIVE_FUNCTIONS.length || JSON.stringify([...names].sort()) !== JSON.stringify([...LIVE_FUNCTIONS].sort()) ||
      jsonHash(result.functions.items) !== result.functions.inventorySha256) blocked()
  if (!exactKeys(result.rules, ['canonicalSha256', 'observedAt']) || result.rules.canonicalSha256 !== ACTIVE_RULES_SHA256) blocked()
  if (!exactKeys(result.indexes, ['invitationIndexState', 'fieldOverrideCount', 'fieldOverridesSha256', 'observedAt']) ||
      result.indexes.invitationIndexState !== 'READY' || result.indexes.fieldOverrideCount !== 1 ||
      result.indexes.fieldOverridesSha256 !== FIELD_OVERRIDES_SHA256) blocked()
  if (!exactKeys(result.auth, [
    'emailPasswordEnabled', 'userSignupDisabled', 'verificationMethodPresent',
    'verificationTemplateMetadataPresent', 'callbackDomainPresent', 'metadataSha256', 'observedAt',
  ]) || result.auth.emailPasswordEnabled !== true || result.auth.userSignupDisabled !== false ||
      result.auth.verificationMethodPresent !== true || result.auth.verificationTemplateMetadataPresent !== true ||
      result.auth.callbackDomainPresent !== true || result.auth.metadataSha256 !== expected.authMetadataSha256) blocked()
  if (!exactKeys(result.maintenance, ['state', 'observedAt']) || !['ABSENT', 'INACTIVE'].includes(result.maintenance.state)) blocked()
  if (!exactKeys(result.subjectAbsence, ['mailboxSha256', 'accountExists', 'profileExists', 'observedAt']) ||
      result.subjectAbsence.mailboxSha256 !== expected.mailboxSha256 || result.subjectAbsence.accountExists !== false ||
      result.subjectAbsence.profileExists !== false) blocked()
  if (!exactKeys(result.build, ['sourceHead', 'stagingFingerprint', 'servedFrom', 'sixFieldsVerified', 'observedAt']) ||
      result.build.sourceHead !== expected.sourceHead || result.build.stagingFingerprint !== expected.stagingFingerprint ||
      result.build.servedFrom !== 'http://127.0.0.1:5177' || result.build.sixFieldsVerified !== true) blocked()
  for (const value of Object.values(result)) freshObservedAt(value.observedAt, floor, ceiling)

  const receipt = {
    task: 'SEC-006 Stage 8 live acceptance fresh preflight', status: 'PRECONDITIONS_VERIFIED',
    project: PROJECT, sourceHead: expected.sourceHead, startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(), mailboxSha256: expected.mailboxSha256,
    functionsSha256: expected.functionsSha256, authMetadataSha256: expected.authMetadataSha256,
    stagingFingerprint: expected.stagingFingerprint, activeRulesSha256: ACTIVE_RULES_SHA256,
    fieldOverridesSha256: FIELD_OVERRIDES_SHA256, maintenanceState: result.maintenance.state,
    cloudMutations: 0, callableInvocations: 0, emailsSent: 0,
  }
  assertNoSecretMaterial(receipt)
  return frozen(receipt)
}

function privateNewPath(filename, repoRoot, io) {
  if (typeof filename !== 'string' || typeof repoRoot !== 'string' || !path.isAbsolute(filename) || !path.isAbsolute(repoRoot) || io.existsSync(filename)) blocked()
  const parent = io.realpathSync(path.dirname(filename))
  const root = io.realpathSync(repoRoot)
  const target = path.join(parent, path.basename(filename))
  const relative = path.relative(root, target)
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) blocked()
  return target
}

/** A single-writer JSONL journal. `wx` prevents replay/truncation and every
 * accepted event is fully written, fsynced, reread and byte-compared before
 * it becomes the in-memory state used to authorize a dispatch. */
export function createDurableLiveJournal({ filename, repoRoot, now = () => new Date().toISOString(), io = fs }) {
  const target = privateNewPath(filename, repoRoot, io)
  const descriptor = io.openSync(target, 'wx', 0o600)
  let events = [], expectedBytes = Buffer.alloc(0), failed = false, closed = false
  const ensureOpen = () => { if (failed || closed) blocked() }
  return Object.freeze({
    append(status, details = {}) {
      ensureOpen()
      const at = now()
      const nextEvents = appendJournalEvent(events, { seq: events.length, status, at, details })
      const bytes = Buffer.from(`${JSON.stringify(nextEvents.at(-1))}\n`)
      try {
        let offset = 0
        while (offset < bytes.length) {
          const written = io.writeSync(descriptor, bytes, offset, bytes.length - offset)
          if (!Number.isSafeInteger(written) || written < 1 || written > bytes.length - offset) blocked()
          offset += written
        }
        io.fsyncSync(descriptor)
        const candidate = Buffer.concat([expectedBytes, bytes])
        if (!io.readFileSync(target).equals(candidate)) blocked()
        expectedBytes = candidate
        events = [...nextEvents]
        return frozen(nextEvents.at(-1))
      } catch {
        failed = true
        closed = true
        try { io.closeSync(descriptor) } catch { /* preserve the original durability failure */ }
        throw new Error('live_executor_blocked')
      }
    },
    bytes() { ensureOpen(); return Buffer.from(expectedBytes) },
    events() { ensureOpen(); return clone(events) },
    close() {
      if (closed) blocked()
      closed = true
      try { io.fsyncSync(descriptor) } finally { io.closeSync(descriptor) }
      return { journalSha256: sha256(expectedBytes), eventCount: events.length }
    },
  })
}

export function createRealCooldownGate({ wallNow = () => Date.now(), monotonicNow = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let started = false, ready = false, startWall, startMonotonic, lastWall, lastMonotonic
  return Object.freeze({
    start() {
      if (started) blocked()
      startWall = lastWall = wallNow(); startMonotonic = lastMonotonic = monotonicNow()
      if (!Number.isFinite(startWall) || !Number.isFinite(startMonotonic)) blocked()
      started = true
    },
    async wait() {
      if (!started || ready) blocked()
      while (true) {
        const wall = wallNow(), monotonic = monotonicNow()
        if (!Number.isFinite(wall) || !Number.isFinite(monotonic) || wall < lastWall || monotonic < lastMonotonic) blocked()
        lastWall = wall; lastMonotonic = monotonic
        const wallElapsed = wall - startWall, monotonicElapsed = monotonic - startMonotonic
        if (wallElapsed >= 60_000 && monotonicElapsed >= 60_000) {
          ready = true
          return frozen({ wallElapsedMs: Math.floor(wallElapsed), monotonicElapsedMs: Math.floor(monotonicElapsed) })
        }
        const remaining = Math.max(60_000 - wallElapsed, 60_000 - monotonicElapsed)
        await sleep(Math.max(1, Math.min(1_000, Math.ceil(remaining))))
      }
    },
    isReady() { return ready },
  })
}

const OWNER_SESSION_METHODS = Object.freeze([
  'inspectBoundary', 'confirmCredentialReady', 'prepareRegistration', 'dispatchRegistration',
  'prepareVerification', 'dispatchVerification', 'confirmVerifiedSession', 'close',
])

/** The executor can pause a visible Playwright session without receiving a
 * credential value, mailbox value, action code, capability or browser storage.
 * The concrete adapter owns those values and exposes only safe commitments. */
export function createVisibleOwnerHandoff({ openSession, pause }) {
  if (typeof openSession !== 'function' || typeof pause !== 'function') blocked()
  let session = null, opened = false, closed = false
  const requireSession = () => { if (!opened || closed || !session) blocked() }
  return Object.freeze({
    async open() {
      if (opened) blocked()
      try {
        session = await openSession({ headless: false, persistent: false, recordHar: false, recordVideo: false, trace: false })
        if (!exactKeys(session, OWNER_SESSION_METHODS) || OWNER_SESSION_METHODS.some(name => typeof session[name] !== 'function')) blocked()
        const boundary = await session.inspectBoundary()
        if (!exactKeys(boundary, ['visible', 'persistent', 'fragmentRemovedBeforeInit', 'financialModulesLoaded', 'cachedCompanyDataLoaded', 'capabilityPersisted']) ||
            boundary.visible !== true || boundary.persistent !== false || boundary.fragmentRemovedBeforeInit !== true ||
            boundary.financialModulesLoaded !== false || boundary.cachedCompanyDataLoaded !== false || boundary.capabilityPersisted !== false) blocked()
        opened = true
        return frozen(boundary)
      } catch {
        closed = true
        try { if (session && typeof session.close === 'function') await session.close() } catch { /* best-effort fail-closed browser teardown */ }
        throw new Error('live_executor_blocked')
      }
    },
    async awaitCredentialReady() {
      requireSession()
      const acknowledgement = await pause({ action: 'OWNER_ENTER_CREDENTIAL', browserRemainsOpen: true })
      if (!exactKeys(acknowledgement, ['acknowledged']) || acknowledgement.acknowledged !== true) blocked()
      const state = await session.confirmCredentialReady()
      if (!exactKeys(state, ['ready', 'minimumLengthSatisfied']) || state.ready !== true || state.minimumLengthSatisfied !== true) blocked()
      return frozen(state)
    },
    async prepareRegistration() {
      requireSession()
      const prepared = await session.prepareRegistration()
      if (!exactKeys(prepared, ['requestSha256', 'binding']) || !hex64(prepared.requestSha256) || !record(prepared.binding)) blocked()
      return frozen(prepared)
    },
    async dispatchRegistration(permit) { requireSession(); return session.dispatchRegistration(frozen(permit)) },
    async prepareVerification() {
      requireSession()
      const prepared = await session.prepareVerification()
      if (!exactKeys(prepared, ['requestSha256']) || !hex64(prepared.requestSha256)) blocked()
      return frozen(prepared)
    },
    async dispatchVerification(permit) { requireSession(); return session.dispatchVerification(frozen(permit)) },
    async awaitVerifiedSession(challenge) {
      requireSession()
      if (!exactKeys(challenge, ['challengeSha256']) || !hex64(challenge.challengeSha256)) blocked()
      const acknowledgement = await pause({ action: 'OWNER_COMPLETE_PROVIDER_VERIFICATION', browserRemainsOpen: true })
      if (!exactKeys(acknowledgement, ['acknowledged']) || acknowledgement.acknowledged !== true) blocked()
      const state = await session.confirmVerifiedSession(frozen(challenge))
      if (!exactKeys(state, ['challengeSha256', 'verified', 'reloaded', 'forcedRefresh']) ||
          state.challengeSha256 !== challenge.challengeSha256 || state.verified !== true || state.reloaded !== true || state.forcedRefresh !== true) blocked()
      const proof = frozen({ ...state, sessionProofSha256: jsonHash(state) })
      verifiedSessionProofs.add(proof)
      return proof
    },
    async close() { requireSession(); closed = true; await session.close() },
  })
}

const SLOT_BINDING_KEYS = Object.freeze({
  createOwnerAAuth: ['identity', 'subjectSha256'],
  createCompanyA: ['identity', 'actorUid', 'idempotencyKeySha256'],
  createOwnerBAuth: ['identity', 'subjectSha256'],
  createCompanyB: ['identity', 'actorUid', 'idempotencyKeySha256'],
  createMailboxCancelledInvite: ['identity', 'actorUid', 'companyId', 'subjectSha256', 'role'],
  cancelMailboxInvite: ['identity', 'actorUid', 'companyId', 'invitationId'],
  createMailboxFinalInvite: ['identity', 'actorUid', 'companyId', 'subjectSha256', 'role'],
  denyMailboxResendCooldown: ['identity', 'actorUid', 'companyId', 'invitationId'],
  resendMailboxFinalInvite: ['identity', 'actorUid', 'companyId', 'invitationId'],
  createOwnerMailboxAuth: ['identity', 'subjectSha256'],
  denyWrongIdentityAccept: ['identity', 'actorUid', 'invitationId', 'capabilitySha256'],
  denyUnverifiedMailboxAccept: ['identity', 'actorUid', 'invitationId', 'capabilitySha256'],
  acceptMailboxFinalInvite: ['identity', 'actorUid', 'invitationId', 'capabilitySha256'],
  replayMailboxFinalInvite: ['identity', 'actorUid', 'invitationId', 'capabilitySha256'],
  createOwnerBInvite: ['identity', 'actorUid', 'companyId', 'subjectSha256', 'role'],
  acceptOwnerBInvite: ['identity', 'actorUid', 'invitationId', 'capabilitySha256'],
})

function initialState(initial) {
  if (!exactKeys(initial, ['runId', 'mailboxSha256', 'ownerASubjectSha256', 'ownerBSubjectSha256']) ||
      typeof initial.runId !== 'string' || !/^[a-z][a-z0-9-]{7,39}$/.test(initial.runId) || initial.runId.includes('--') ||
      [initial.mailboxSha256, initial.ownerASubjectSha256, initial.ownerBSubjectSha256].some(value => !hex64(value)) ||
      new Set([initial.mailboxSha256, initial.ownerASubjectSha256, initial.ownerBSubjectSha256]).size !== 3) blocked()
  return {
    ...clone(initial), ownerAUid: null, ownerBUid: null, ownerMailboxUid: null,
    companyAId: null, companyBId: null, mailboxCancelledInviteId: null,
    mailboxCancelledCapabilitySha256: null, mailboxFinalInviteId: null,
    mailboxFinalCapabilitySha256: null, mailboxPreviousCapabilitySha256: null,
    ownerBInviteId: null, ownerBCapabilitySha256: null, mailboxLockId: null, ownerBLockId: null,
  }
}

function requireValue(actual, expected) { if (actual !== expected) blocked() }
function validateBinding(slot, binding, state) {
  if (!exactKeys(binding, SLOT_BINDING_KEYS[slot])) blocked()
  const identities = { createOwnerAAuth: 'ownerA', createCompanyA: 'ownerA', createOwnerBAuth: 'ownerB', createCompanyB: 'ownerB',
    createMailboxCancelledInvite: 'ownerA', cancelMailboxInvite: 'ownerA', createMailboxFinalInvite: 'ownerA',
    denyMailboxResendCooldown: 'ownerA', resendMailboxFinalInvite: 'ownerA', createOwnerMailboxAuth: 'ownerMailbox',
    denyWrongIdentityAccept: 'ownerB', denyUnverifiedMailboxAccept: 'ownerMailbox', acceptMailboxFinalInvite: 'ownerMailbox',
    replayMailboxFinalInvite: 'ownerMailbox', createOwnerBInvite: 'ownerA', acceptOwnerBInvite: 'ownerB' }
  requireValue(binding.identity, identities[slot])
  if (Object.hasOwn(binding, 'actorUid') && !safeId(binding.actorUid)) blocked()
  if (Object.hasOwn(binding, 'companyId') && !safeId(binding.companyId)) blocked()
  if (Object.hasOwn(binding, 'invitationId') && !safeId(binding.invitationId)) blocked()
  for (const key of ['subjectSha256', 'capabilitySha256', 'idempotencyKeySha256']) if (Object.hasOwn(binding, key) && !hex64(binding[key])) blocked()
  if (['createOwnerAAuth'].includes(slot)) requireValue(binding.subjectSha256, state.ownerASubjectSha256)
  if (['createOwnerBAuth'].includes(slot)) requireValue(binding.subjectSha256, state.ownerBSubjectSha256)
  if (['createOwnerMailboxAuth', 'createMailboxCancelledInvite', 'createMailboxFinalInvite'].includes(slot)) requireValue(binding.subjectSha256, state.mailboxSha256)
  if (slot === 'createOwnerBInvite') requireValue(binding.subjectSha256, state.ownerBSubjectSha256)
  if (['createCompanyA', 'createMailboxCancelledInvite', 'cancelMailboxInvite', 'createMailboxFinalInvite', 'denyMailboxResendCooldown', 'resendMailboxFinalInvite', 'createOwnerBInvite'].includes(slot)) requireValue(binding.actorUid, state.ownerAUid)
  if (slot === 'createCompanyB' || slot === 'denyWrongIdentityAccept' || slot === 'acceptOwnerBInvite') requireValue(binding.actorUid, state.ownerBUid)
  if (['denyUnverifiedMailboxAccept', 'acceptMailboxFinalInvite', 'replayMailboxFinalInvite'].includes(slot)) requireValue(binding.actorUid, state.ownerMailboxUid)
  if (['createMailboxCancelledInvite', 'cancelMailboxInvite', 'createMailboxFinalInvite', 'denyMailboxResendCooldown', 'resendMailboxFinalInvite', 'createOwnerBInvite'].includes(slot)) requireValue(binding.companyId, state.companyAId)
  if (['cancelMailboxInvite'].includes(slot)) requireValue(binding.invitationId, state.mailboxCancelledInviteId)
  if (['denyMailboxResendCooldown', 'resendMailboxFinalInvite', 'denyWrongIdentityAccept', 'denyUnverifiedMailboxAccept', 'acceptMailboxFinalInvite', 'replayMailboxFinalInvite'].includes(slot)) requireValue(binding.invitationId, state.mailboxFinalInviteId)
  if (slot === 'acceptOwnerBInvite') requireValue(binding.invitationId, state.ownerBInviteId)
  if (['denyWrongIdentityAccept', 'denyUnverifiedMailboxAccept', 'acceptMailboxFinalInvite', 'replayMailboxFinalInvite'].includes(slot)) requireValue(binding.capabilitySha256, state.mailboxFinalCapabilitySha256)
  if (slot === 'acceptOwnerBInvite') requireValue(binding.capabilitySha256, state.ownerBCapabilitySha256)
  if (Object.hasOwn(binding, 'role')) requireValue(binding.role, slot === 'createOwnerBInvite' ? 'viewer' : 'accountant')
  assertNoSecretMaterial(binding)
}

export function validateExecutorStateAliases(state) {
  const entityKeys = ['ownerAUid', 'ownerBUid', 'ownerMailboxUid', 'companyAId', 'companyBId',
    'mailboxCancelledInviteId', 'mailboxFinalInviteId', 'ownerBInviteId']
  const lockKeys = ['mailboxLockId', 'ownerBLockId']
  const capabilityKeys = ['mailboxCancelledCapabilitySha256', 'mailboxPreviousCapabilitySha256',
    'mailboxFinalCapabilitySha256', 'ownerBCapabilitySha256']
  const groups = [entityKeys, lockKeys, capabilityKeys].map(keys => keys.map(key => state[key]).filter(value => value !== null))
  if (groups[0].some(value => !safeId(value)) || groups[1].some(value => !hex64(value)) || groups[2].some(value => !hex64(value))) blocked()
  for (const values of groups) if (new Set(values).size !== values.length) blocked()
  const all = groups.flat()
  if (new Set(all).size !== all.length) blocked()
  return true
}

function applyProduced(slot, produced, state) {
  const schemas = {
    createOwnerAAuth: ['ownerAUid'], createCompanyA: ['companyAId'], createOwnerBAuth: ['ownerBUid'], createCompanyB: ['companyBId'],
    createMailboxCancelledInvite: ['mailboxCancelledInviteId', 'mailboxCancelledCapabilitySha256', 'mailboxLockId'],
    cancelMailboxInvite: [], createMailboxFinalInvite: ['mailboxFinalInviteId', 'mailboxFinalCapabilitySha256', 'mailboxLockId'],
    denyMailboxResendCooldown: [], resendMailboxFinalInvite: ['mailboxFinalCapabilitySha256'],
    createOwnerMailboxAuth: ['ownerMailboxUid'], denyWrongIdentityAccept: [], denyUnverifiedMailboxAccept: [],
    acceptMailboxFinalInvite: [], replayMailboxFinalInvite: [],
    createOwnerBInvite: ['ownerBInviteId', 'ownerBCapabilitySha256', 'ownerBLockId'], acceptOwnerBInvite: [],
  }
  if (!exactKeys(produced, schemas[slot])) blocked()
  for (const [key, value] of Object.entries(produced)) {
    if (key.endsWith('Sha256')) { if (!hex64(value)) blocked() } else if (!safeId(value)) blocked()
  }
  if (slot === 'createMailboxFinalInvite' && produced.mailboxLockId !== state.mailboxLockId) blocked()
  const candidate = { ...state, ...produced }
  if (slot === 'resendMailboxFinalInvite') {
    if (produced.mailboxFinalCapabilitySha256 === state.mailboxFinalCapabilitySha256) blocked()
    candidate.mailboxPreviousCapabilitySha256 = state.mailboxFinalCapabilitySha256
  }
  validateExecutorStateAliases(candidate)
  Object.assign(state, candidate)
}

function journalCallableCounts(events) {
  const counts = Object.fromEntries(Object.keys(CALLABLE_CAPS).map(name => [name, 0]))
  let total = 0
  for (const event of events) {
    if (!['FIXTURE_MUTATION_MAY_BE_SENT', 'CALLABLE_REQUEST_MAY_BE_SENT'].includes(event.status) || event.details.callable === null) continue
    counts[event.details.callable]++; total++
  }
  return { counts, total }
}

function safeDispatchResult(value, requestSha256) {
  if (!exactKeys(value, ['requestSha256', 'outcomeSha256', 'producedSha256']) || value.requestSha256 !== requestSha256 ||
      !hex64(value.outcomeSha256) || !hex64(value.producedSha256)) blocked()
  assertNoSecretMaterial(value)
  return value
}

function safeEmailDispatchResult(value, requestSha256) {
  if (!exactKeys(value, ['requestSha256', 'outcomeSha256']) || value.requestSha256 !== requestSha256 || !hex64(value.outcomeSha256)) blocked()
  assertNoSecretMaterial(value)
  return value
}

function safeReadback(value, requestSha256, outcomeSha256, producedSha256) {
  if (!exactKeys(value, ['requestSha256', 'outcomeSha256', 'readbackSha256', 'produced']) ||
      value.requestSha256 !== requestSha256 || value.outcomeSha256 !== outcomeSha256 || !hex64(value.readbackSha256) || !record(value.produced) ||
      jsonHash(value.produced) !== producedSha256) blocked()
  return value
}

function readOnlyExpectedBinding(spec, state) {
  const actorUid = { ownerA: state.ownerAUid, ownerB: state.ownerBUid, ownerMailbox: state.ownerMailboxUid }[spec.identity]
  const companyId = { companyA: state.companyAId, companyB: state.companyBId }[spec.entity]
  if (spec.callable === 'listInvitations') return { identity: spec.identity, actorUid, companyId, expectation: spec.expectation }
  if (spec.callable === 'previewInvite') {
    const invitationId = { mailboxCancelledInvite: state.mailboxCancelledInviteId, mailboxFinalInvite: state.mailboxFinalInviteId }[spec.entity]
    const capabilitySha256 = {
      mailboxCancelledCapability: state.mailboxCancelledCapabilitySha256,
      mailboxPreviousCapability: state.mailboxPreviousCapabilitySha256,
      mailboxFinalCapability: state.mailboxFinalCapabilitySha256,
    }[spec.capability]
    return { identity: spec.identity, invitationId, capabilitySha256, expectation: spec.expectation }
  }
  return { identity: spec.identity, actorUid, companyId, expectation: spec.expectation }
}

function validateReadOnlyBinding(spec, binding, state) {
  const callable = spec.callable
  const schemas = {
    listInvitations: ['identity', 'actorUid', 'companyId', 'expectation'],
    previewInvite: ['identity', 'invitationId', 'capabilitySha256', 'expectation'],
    getCompanyAccess: ['identity', 'actorUid', 'companyId', 'expectation'],
  }
  const expected = readOnlyExpectedBinding(spec, state)
  if (!exactKeys(binding, schemas[callable]) || Object.entries(expected).some(([key, value]) => binding[key] !== value)) blocked()
  if (Object.hasOwn(binding, 'actorUid') && !safeId(binding.actorUid)) blocked()
  if (Object.hasOwn(binding, 'companyId') && !safeId(binding.companyId)) blocked()
  if (Object.hasOwn(binding, 'invitationId') && !safeId(binding.invitationId)) blocked()
  if (Object.hasOwn(binding, 'capabilitySha256') && !hex64(binding.capabilitySha256)) blocked()
  assertNoSecretMaterial(binding)
  return frozen(expected)
}

export function createLiveStagingExecutor({ journal, preflightAdapters, expectedPreflight, initial, nowMs = () => Date.now(), cooldownGate = createRealCooldownGate() }) {
  if (!journal || typeof journal.append !== 'function' || typeof journal.bytes !== 'function' || typeof journal.events !== 'function' ||
      !cooldownGate || typeof cooldownGate.start !== 'function' || typeof cooldownGate.wait !== 'function' || typeof cooldownGate.isReady !== 'function') blocked()
  const state = initialState(initial)
  const recovery = {
    version: 1, runId: state.runId, mailboxSha256: state.mailboxSha256,
    authSubjects: { ownerASubjectSha256: state.ownerASubjectSha256, ownerBSubjectSha256: state.ownerBSubjectSha256 },
    lifecycle: 'CREATED', fixtureSlots: Object.fromEntries(FIXTURE_MUTATION_SLOT_SPECS.map((spec, index) => [spec.slot, {
      index, callable: spec.callable, disposition: spec.disposition, state: 'NOT_STARTED',
    }])),
    readOnlySlots: Object.fromEntries(READ_ONLY_SLOT_SPECS.map(spec => [spec.slot, { callable: spec.callable, state: 'NOT_STARTED' }])),
    verificationEmail: { state: 'NOT_STARTED' }, state: clone(state),
  }
  privateRecoveryByJournal.set(journal, recovery)
  let started = false, nextSlot = 0, nextReadOnlySlot = 0, emailCompleted = false, emailOutcomeSha256 = null
  let verificationChallengeSha256 = null, verifiedSessionProofSha256 = null, plan = null, acceptanceVerified = false
  const appendFailure = code => { journal.append('FAILED', { failureCode: code }) }
  const requireStarted = () => { if (!started || plan || acceptanceVerified) blocked() }
  return Object.freeze({
    async start() {
      if (started || journal.events().length !== 0) blocked()
      const receipt = await runFreshLivePreflight({ adapters: preflightAdapters, expected: expectedPreflight, now: nowMs })
      const envelope = buildFixtureEnvelope({ runId: state.runId, mailboxSha256: state.mailboxSha256 })
      journal.append('PRECONDITIONS_VERIFIED')
      journal.append('PROVISIONAL_FIXTURE_ENVELOPE_COMMITTED', { envelopeSha256: jsonHash(envelope) })
      journal.append('SCENARIOS_RUNNING')
      recovery.lifecycle = 'SCENARIOS_RUNNING'
      started = true
      return receipt
    },
    async executeFixtureSlot({ slot, requestSha256, binding, dispatch, readback }) {
      requireStarted()
      const spec = FIXTURE_MUTATION_SLOT_SPECS[nextSlot]
      if (!spec || slot !== spec.slot || !hex64(requestSha256) || typeof dispatch !== 'function' || typeof readback !== 'function') blocked()
      if (READ_ONLY_SLOT_SPECS[nextReadOnlySlot]?.afterFixtureCount <= nextSlot) blocked()
      if (slot === 'resendMailboxFinalInvite' && !cooldownGate.isReady()) blocked()
      if (slot === 'acceptMailboxFinalInvite' && !verifiedSessionProofSha256) blocked()
      validateBinding(slot, binding, state)
      const progress = journalCallableCounts(journal.events())
      const callableCount = spec.callable === null ? null : progress.counts[spec.callable] + 1
      const totalCallableCount = progress.total + (spec.callable === null ? 0 : 1)
      const may = { index: nextSlot, slot, callCount: nextSlot + 1, callable: spec.callable, callableCount, totalCallableCount, requestSha256 }
      journal.append('FIXTURE_MUTATION_MAY_BE_SENT', may)
      recovery.fixtureSlots[slot] = { ...recovery.fixtureSlots[slot], state: 'MAY_BE_SENT', requestSha256, binding: clone(binding) }
      let dispatched
      try {
        dispatched = safeDispatchResult(await dispatch(frozen({ ...may, binding: clone(binding), journalBytes: journal.bytes() })), requestSha256)
        const reconciled = safeReadback(await readback(frozen({ slot, binding: clone(binding), requestSha256, outcomeSha256: dispatched.outcomeSha256 })),
          requestSha256, dispatched.outcomeSha256, dispatched.producedSha256)
        applyProduced(slot, reconciled.produced, state)
        journal.append('FIXTURE_MUTATION_RECONCILED', {
          index: may.index, slot: may.slot, callCount: may.callCount, callable: may.callable,
          callableCount: may.callableCount, totalCallableCount: may.totalCallableCount,
          disposition: spec.disposition, outcomeSha256: dispatched.outcomeSha256, readbackSha256: reconciled.readbackSha256,
        })
        recovery.fixtureSlots[slot] = { ...recovery.fixtureSlots[slot], state: 'RECONCILED', requestSha256,
          binding: clone(binding), outcomeSha256: dispatched.outcomeSha256, readbackSha256: reconciled.readbackSha256,
          produced: clone(reconciled.produced) }
        recovery.state = clone(state)
      } catch {
        const outcomeSha256 = dispatched?.outcomeSha256 ?? sha256(`uncertain:${slot}:${requestSha256}`)
        try {
          journal.append('FIXTURE_MUTATION_UNCERTAIN', {
            index: nextSlot, slot, callable: spec.callable, callableCount, totalCallableCount, outcomeSha256,
          })
          appendFailure('FIXTURE_MUTATION_UNCERTAIN')
        } catch { /* retain the last bytes that did reach fsync */ }
        recovery.fixtureSlots[slot] = { ...recovery.fixtureSlots[slot], state: 'UNCERTAIN', requestSha256,
          binding: clone(binding), outcomeSha256 }
        recovery.lifecycle = 'RECOVERY_REQUIRED'
        throw new Error('live_executor_blocked')
      }
      if (slot === 'denyMailboxResendCooldown') cooldownGate.start()
      nextSlot++
      return frozen({ slot, index: nextSlot - 1, disposition: spec.disposition, readbackSha256: journal.events().at(-1).details.readbackSha256 })
    },
    async awaitResendCooldown() { requireStarted(); return cooldownGate.wait() },
    async executeReadOnlyCallable({ slot, callable, requestSha256, binding, dispatch, readback }) {
      requireStarted()
      const spec = READ_ONLY_SLOT_SPECS[nextReadOnlySlot]
      if (!spec || slot !== spec.slot || callable !== spec.callable || nextSlot !== spec.afterFixtureCount ||
          !READ_ONLY_CALLABLES.includes(callable) || !hex64(requestSha256) || typeof dispatch !== 'function' || typeof readback !== 'function') blocked()
      const validatedBinding = validateReadOnlyBinding(spec, binding, state)
      const progress = journalCallableCounts(journal.events())
      const callableCount = progress.counts[callable] + 1, totalCallableCount = progress.total + 1
      const bindingSha256 = jsonHash({ slot, callable, binding: validatedBinding })
      const may = { callable, callableCount, totalCallableCount, requestSha256, bindingSha256 }
      journal.append('CALLABLE_REQUEST_MAY_BE_SENT', may)
      recovery.readOnlySlots[slot] = { ...recovery.readOnlySlots[slot], state: 'MAY_BE_SENT', requestSha256,
        binding: clone(validatedBinding), bindingSha256 }
      let dispatched
      try {
        dispatched = safeDispatchResult(await dispatch(frozen({ ...may, slot, binding: clone(validatedBinding), journalBytes: journal.bytes() })), requestSha256)
        const reconciled = safeReadback(await readback(frozen({ slot, callable, binding: clone(validatedBinding), requestSha256, outcomeSha256: dispatched.outcomeSha256 })),
          requestSha256, dispatched.outcomeSha256, dispatched.producedSha256)
        if (Object.keys(reconciled.produced).length !== 0) blocked()
        journal.append('CALLABLE_REQUEST_RECONCILED', { callable, callableCount, totalCallableCount, bindingSha256,
          outcomeSha256: dispatched.outcomeSha256, readbackSha256: reconciled.readbackSha256 })
        recovery.readOnlySlots[slot] = { ...recovery.readOnlySlots[slot], state: 'RECONCILED', requestSha256,
          binding: clone(validatedBinding), bindingSha256, outcomeSha256: dispatched.outcomeSha256,
          readbackSha256: reconciled.readbackSha256 }
      } catch {
        const outcomeSha256 = dispatched?.outcomeSha256 ?? sha256(`uncertain:${callable}:${requestSha256}`)
        try {
          journal.append('CALLABLE_REQUEST_UNCERTAIN', { callable, callableCount, totalCallableCount, bindingSha256, outcomeSha256 })
          appendFailure('CALLABLE_REQUEST_UNCERTAIN')
        } catch { /* retain the last bytes that did reach fsync */ }
        recovery.readOnlySlots[slot] = { ...recovery.readOnlySlots[slot], state: 'UNCERTAIN', requestSha256,
          binding: clone(validatedBinding), bindingSha256, outcomeSha256 }
        recovery.lifecycle = 'RECOVERY_REQUIRED'
        throw new Error('live_executor_blocked')
      }
      nextReadOnlySlot++
      return frozen({ slot, callable, callableCount, totalCallableCount, bindingSha256 })
    },
    async executeVerificationEmail({ requestSha256, dispatch }) {
      requireStarted()
      if (nextSlot !== 12 || emailCompleted || !hex64(requestSha256) || typeof dispatch !== 'function') blocked()
      journal.append('EMAIL_REQUEST_MAY_BE_SENT', { requestSha256 })
      recovery.verificationEmail = { state: 'MAY_BE_SENT', requestSha256 }
      try {
        const result = safeEmailDispatchResult(await dispatch(frozen({ requestSha256, journalBytes: journal.bytes() })), requestSha256)
        journal.append('EMAIL_SENT', { outcomeSha256: result.outcomeSha256 })
        recovery.verificationEmail = { state: 'SENT', requestSha256, outcomeSha256: result.outcomeSha256 }
        emailCompleted = true; emailOutcomeSha256 = result.outcomeSha256
        return frozen({ sent: true, outcomeSha256: result.outcomeSha256 })
      } catch {
        const outcomeSha256 = sha256(`uncertain:verification:${requestSha256}`)
        try { journal.append('EMAIL_UNCERTAIN', { outcomeSha256 }); appendFailure('EMAIL_UNCERTAIN') } catch { /* retain synced evidence */ }
        recovery.verificationEmail = { state: 'UNCERTAIN', requestSha256, outcomeSha256 }
        recovery.lifecycle = 'RECOVERY_REQUIRED'
        throw new Error('live_executor_blocked')
      }
    },
    verificationSessionChallenge() {
      requireStarted()
      if (nextSlot !== 12 || !emailCompleted || verificationChallengeSha256 || verifiedSessionProofSha256) blocked()
      verificationChallengeSha256 = jsonHash({
        actorUid: state.ownerMailboxUid, emailOutcomeSha256, journalSha256: sha256(journal.bytes()),
      })
      return frozen({ challengeSha256: verificationChallengeSha256 })
    },
    markVerifiedSession(proof) {
      requireStarted()
      if (!verificationChallengeSha256 || verifiedSessionProofSha256 || !record(proof) || !verifiedSessionProofs.has(proof) ||
          !exactKeys(proof, ['challengeSha256', 'verified', 'reloaded', 'forcedRefresh', 'sessionProofSha256']) ||
          proof.challengeSha256 !== verificationChallengeSha256 || proof.verified !== true || proof.reloaded !== true || proof.forcedRefresh !== true ||
          proof.sessionProofSha256 !== jsonHash({ challengeSha256: proof.challengeSha256, verified: true, reloaded: true, forcedRefresh: true })) blocked()
      verifiedSessionProofs.delete(proof)
      journal.append('VERIFIED_SESSION_COMMITTED', {
        challengeSha256: proof.challengeSha256, sessionProofSha256: proof.sessionProofSha256,
      })
      verifiedSessionProofSha256 = proof.sessionProofSha256
      return frozen({ verifiedSessionMarked: true, sessionProofSha256: verifiedSessionProofSha256 })
    },
    materializeFixturePlan() {
      requireStarted()
      if (nextSlot !== FIXTURE_MUTATION_SLOT_SPECS.length || nextReadOnlySlot !== READ_ONLY_SLOT_SPECS.length || !emailCompleted) blocked()
      plan = buildFixturePlan({
        runId: state.runId, mailboxSha256: state.mailboxSha256,
        companyIds: { a: state.companyAId, b: state.companyBId },
        syntheticAuthUids: { ownerA: state.ownerAUid, ownerB: state.ownerBUid },
        ownerMailboxUid: state.ownerMailboxUid,
        lockIds: { mailbox: state.mailboxLockId, ownerB: state.ownerBLockId },
      })
      journal.append('MATERIALIZED_FIXTURE_PLAN_COMMITTED', { planSha256: jsonHash(plan) })
      return frozen(plan)
    },
    verifyAcceptance(bundle) {
      if (!plan || acceptanceVerified) blocked()
      const validated = validateAcceptanceObservationBundle(plan, bundle, state, journal.events())
      journal.append('ACCEPTANCE_VERIFIED', { observationsSha256: validated.observationsSha256 })
      acceptanceVerified = true
      return validated
    },
    buildCleanupPlanOnly(bundle) {
      if (!plan || !acceptanceVerified) blocked()
      const validated = validateAcceptanceObservationBundle(plan, bundle, state, journal.events())
      const targets = buildCleanupTargets(plan, validated.observedDynamic)
      const cleanupPlanSha256 = jsonHash(targets)
      journal.append('CLEANUP_DEFERRED', { cleanupPlanSha256 })
      recovery.lifecycle = 'COMPLETE'
      return frozen({ status: 'CLEANUP_PLAN_ONLY', executionEnabled: false, cleanupPerformed: false, cleanupPlanSha256, targets })
    },
    snapshot() { return frozen({ nextSlot, nextReadOnlySlot, emailCompleted, verifiedSessionMarked: Boolean(verifiedSessionProofSha256), planMaterialized: Boolean(plan), state }) },
  })
}

export function validateAcceptanceObservationBundle(plan, bundle, state, journalEvents) {
  validateFixturePlan(plan)
  const statePlan = buildFixturePlan({
    runId: state?.runId, mailboxSha256: state?.mailboxSha256,
    companyIds: { a: state?.companyAId, b: state?.companyBId },
    syntheticAuthUids: { ownerA: state?.ownerAUid, ownerB: state?.ownerBUid },
    ownerMailboxUid: state?.ownerMailboxUid,
    lockIds: { mailbox: state?.mailboxLockId, ownerB: state?.ownerBLockId },
  })
  if (JSON.stringify(statePlan) !== JSON.stringify(plan)) blocked()
  if (!exactKeys(bundle, ['readbacks', 'auditEvents', 'replay', 'callableCounts', 'transportCounts']) ||
      !Array.isArray(bundle.readbacks) || bundle.readbacks.length !== READBACK_CHECKS.length || !Array.isArray(bundle.auditEvents) ||
      !exactKeys(bundle.callableCounts, Object.keys(CALLABLE_CAPS)) || !exactKeys(bundle.transportCounts, Object.keys(TRANSPORT_CAPS))) blocked()
  const readbacks = bundle.readbacks.map((row, index) => {
    if (!exactKeys(row, ['check', 'stateSha256', 'updateTime']) || row.check !== READBACK_CHECKS[index] || !hex64(row.stateSha256) || !rfc3339(row.updateTime)) blocked()
    return clone(row)
  })
  const expectedAudits = plan.dynamicSlots.auditEvents
  const auditEventIds = bundle.auditEvents.map((row, index) => {
    const expected = expectedAudits[index]
    if (!exactKeys(row, ['slot', 'company', 'id', 'stateSha256', 'createTime', 'updateTime']) || !expected || row.slot !== expected.slot ||
        row.company !== expected.company || !safeId(row.id) || !hex64(row.stateSha256) || !rfc3339(row.createTime) || !rfc3339(row.updateTime) ||
        Date.parse(row.updateTime) < Date.parse(row.createTime)) blocked()
    return { slot: row.slot, company: row.company, id: row.id }
  })
  if (auditEventIds.length !== plan.counts.auditEvents || new Set(auditEventIds.map(row => `${row.company}/${row.id}`)).size !== auditEventIds.length) blocked()
  if (!exactKeys(bundle.replay, [
    'invitationUpdateTimeBefore', 'invitationUpdateTimeAfter', 'membershipUpdateTimeBefore', 'membershipUpdateTimeAfter',
    'profileUpdateTimeBefore', 'profileUpdateTimeAfter', 'auditCountBefore', 'auditCountAfter',
  ])) blocked()
  for (const key of Object.keys(bundle.replay).filter(key => key.includes('Time'))) if (!rfc3339(bundle.replay[key])) blocked()
  if (bundle.replay.invitationUpdateTimeBefore !== bundle.replay.invitationUpdateTimeAfter ||
      bundle.replay.membershipUpdateTimeBefore !== bundle.replay.membershipUpdateTimeAfter ||
      bundle.replay.profileUpdateTimeBefore !== bundle.replay.profileUpdateTimeAfter ||
      !Number.isSafeInteger(bundle.replay.auditCountBefore) || bundle.replay.auditCountBefore !== plan.counts.auditEvents ||
      bundle.replay.auditCountAfter !== bundle.replay.auditCountBefore) blocked()
  for (const [name, cap] of Object.entries(CALLABLE_CAPS)) {
    if (!Number.isSafeInteger(bundle.callableCounts[name]) || bundle.callableCounts[name] < 0 || bundle.callableCounts[name] > cap) blocked()
  }
  const requiredCalls = { createCompany: 2, inviteMember: 3, listInvitations: 3, cancelInvite: 1,
    resendInvite: 2, previewInvite: 4, acceptInvite: 5, getCompanyAccess: 7 }
  if (Object.entries(requiredCalls).some(([name, count]) => bundle.callableCounts[name] !== count)) blocked()
  const journalCounts = journalCallableCounts(journalEvents)
  if (JSON.stringify(bundle.callableCounts) !== JSON.stringify(journalCounts.counts) ||
      Object.values(bundle.callableCounts).reduce((sum, count) => sum + count, 0) !== journalCounts.total || journalCounts.total > TOTAL_CALLABLE_CAP) blocked()
  for (const [name, cap] of Object.entries(TRANSPORT_CAPS)) {
    if (!Number.isSafeInteger(bundle.transportCounts[name]) || bundle.transportCounts[name] < 0 || bundle.transportCounts[name] > cap) blocked()
  }
  if (bundle.transportCounts.authorizedRequests !== bundle.transportCounts.dispatchedRequests || bundle.transportCounts.verificationDispatches !== 1) blocked()
  const invitationIds = {
    mailboxCancelled: state.mailboxCancelledInviteId, mailboxFinal: state.mailboxFinalInviteId, ownerBExisting: state.ownerBInviteId,
  }
  if (Object.values(invitationIds).some(value => !safeId(value)) || new Set(Object.values(invitationIds)).size !== 3) blocked()
  const coreObservations = { readbacks, callableCounts: clone(bundle.callableCounts), transportCounts: clone(bundle.transportCounts) }
  const result = {
    coreObservations, observationsSha256: jsonHash(coreObservations),
    observedDynamic: { invitationIds, auditEventIds }, replay: clone(bundle.replay),
  }
  return frozen(result)
}
