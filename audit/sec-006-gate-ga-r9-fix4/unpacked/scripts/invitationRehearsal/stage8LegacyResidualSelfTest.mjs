import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  LEGACY_KNOWN, evaluateLegacyResidual, legacyEvidenceSummary, planLegacyInventory,
} from './stage8LegacyResidualCore.mjs'

const sha256 = v => createHash('sha256').update(v).digest('hex')

function exactInventory(overrides = {}) {
  const company = {
    id: 'co-legacy-1', name: LEGACY_KNOWN.companyName, ownerUid: LEGACY_KNOWN.ownerAUid,
    ownerName: LEGACY_KNOWN.ownerName, legalType: LEGACY_KNOWN.legalType,
    idempotencyKeySha256: sha256(LEGACY_KNOWN.idempotencyKey),
    companyDataExists: true,
    subcollections: ['members', 'audit_events'],
    members: [{ uid: LEGACY_KNOWN.ownerAUid, role: 'admin' }],
    auditEvents: [{ id: 'ev-legacy-1', action: 'company_created' }],
    ...(overrides.company ?? {}),
  }
  return {
    ownerAAuth: { exists: true, uid: LEGACY_KNOWN.ownerAUid },
    ownerBAuth: { exists: false },
    bootstrap: { exists: true, ownerUid: LEGACY_KNOWN.ownerAUid },
    companies: [company],
    ...overrides,
  }
}

test('planLegacyInventory is a read-only structural spec naming exactly the known owner-A uid, never owner-B as a mutation target', () => {
  const plan = planLegacyInventory()
  assert.equal(plan.namespace, 'stage8-legacy-residual')
  assert.ok(plan.reads.every(r => !['delete', 'write', 'mutate'].includes(r.kind)))
  assert.ok(plan.reads.some(r => r.kind === 'auth-by-uid' && r.uid === LEGACY_KNOWN.ownerAUid))
})

test('evaluateLegacyResidual: exact match is eligible with exactly the expected 5 delete targets', () => {
  const result = evaluateLegacyResidual(exactInventory())
  assert.equal(result.eligible, true)
  assert.deepEqual(result.reasons, [])
  assert.deepEqual(result.deleteTargets.authUids, [LEGACY_KNOWN.ownerAUid])
  assert.equal(result.deleteTargets.firestorePaths.length, 5)
  assert.ok(result.deleteTargets.firestorePaths.every(p => p.includes('co-legacy-1') || p.includes(LEGACY_KNOWN.ownerAUid)))
})

test('evaluateLegacyResidual: owner-B unexpectedly present blocks eligibility entirely', () => {
  const result = evaluateLegacyResidual(exactInventory({ ownerBAuth: { exists: true } }))
  assert.equal(result.eligible, false)
  assert.ok(result.reasons.includes('OWNER_B_UNEXPECTEDLY_PRESENT'))
})

test('evaluateLegacyResidual: any company field mismatch (name, legalType, owner, idempotency) blocks eligibility', () => {
  assert.ok(evaluateLegacyResidual(exactInventory({ company: { name: 'Different Name' } })).reasons.includes('COMPANY_FIELDS_MISMATCH'))
  assert.ok(evaluateLegacyResidual(exactInventory({ company: { legalType: 'ao' } })).reasons.includes('COMPANY_FIELDS_MISMATCH'))
  assert.ok(evaluateLegacyResidual(exactInventory({ company: { idempotencyKeySha256: sha256('wrong-key') } })).reasons.includes('COMPANY_FIELDS_MISMATCH'))
})

test('evaluateLegacyResidual: zero or more than one matching company blocks eligibility', () => {
  assert.ok(evaluateLegacyResidual(exactInventory({ companies: [] })).reasons.includes('COMPANY_COUNT_NOT_EXACTLY_ONE'))
  const two = exactInventory(); two.companies = [two.companies[0], { ...two.companies[0], id: 'co-legacy-2' }]
  assert.ok(evaluateLegacyResidual(two).reasons.includes('COMPANY_COUNT_NOT_EXACTLY_ONE'))
})

test('evaluateLegacyResidual: any unexpected subcollection blocks eligibility', () => {
  const result = evaluateLegacyResidual(exactInventory({ company: { subcollections: ['members', 'audit_events', 'mystery'] } }))
  assert.equal(result.eligible, false)
  assert.ok(result.reasons.includes('UNEXPECTED_SUBCOLLECTIONS'))
})

test('evaluateLegacyResidual: company_data is a top-level sibling document, not a subcollection — its absence blocks eligibility', () => {
  const result = evaluateLegacyResidual(exactInventory({ company: { companyDataExists: false } }))
  assert.equal(result.eligible, false)
  assert.ok(result.reasons.includes('COMPANY_DATA_DOCUMENT_MISSING'))
  const ok = evaluateLegacyResidual(exactInventory())
  assert.deepEqual(ok.deleteTargets.firestorePaths.filter(p => p.startsWith('company_data/')), [`company_data/co-legacy-1`])
})

test('evaluateLegacyResidual: an extra or wrong-role member blocks eligibility', () => {
  assert.ok(evaluateLegacyResidual(exactInventory({ company: { members: [{ uid: LEGACY_KNOWN.ownerAUid, role: 'admin' }, { uid: 'stranger', role: 'viewer' }] } })).reasons.includes('UNEXPECTED_MEMBERS'))
  assert.ok(evaluateLegacyResidual(exactInventory({ company: { members: [{ uid: LEGACY_KNOWN.ownerAUid, role: 'viewer' }] } })).reasons.includes('UNEXPECTED_MEMBERS'))
})

test('evaluateLegacyResidual: extra or wrong-shape audit events block eligibility', () => {
  assert.ok(evaluateLegacyResidual(exactInventory({ company: { auditEvents: [{ id: 'a', action: 'company_created' }, { id: 'b', action: 'member_invited' }] } })).reasons.includes('UNEXPECTED_AUDIT_EVENTS'))
  assert.ok(evaluateLegacyResidual(exactInventory({ company: { auditEvents: [{ id: 'a', action: 'something_else' }] } })).reasons.includes('UNEXPECTED_AUDIT_EVENTS'))
})

test('evaluateLegacyResidual: missing owner-A auth or bootstrap mismatch blocks eligibility', () => {
  assert.ok(evaluateLegacyResidual(exactInventory({ ownerAAuth: { exists: false, uid: null } })).reasons.includes('OWNER_A_AUTH_MISMATCH'))
  assert.ok(evaluateLegacyResidual(exactInventory({ bootstrap: { exists: false, ownerUid: null } })).reasons.includes('BOOTSTRAP_MISMATCH'))
})

test('legacyEvidenceSummary never carries plaintext idempotency key, owner name, or company name', () => {
  const result = evaluateLegacyResidual(exactInventory())
  const summary = legacyEvidenceSummary(result)
  const text = JSON.stringify(summary)
  assert.equal(text.includes(LEGACY_KNOWN.idempotencyKey), false)
  assert.equal(text.includes(LEGACY_KNOWN.ownerName), false)
  assert.equal(text.includes(LEGACY_KNOWN.companyName), false)
  assert.equal(summary.eligible, true)
})

test('a mutated LEGACY_KNOWN.ownerAUid would fail the exact-match constant check (mutation significance)', () => {
  assert.equal(LEGACY_KNOWN.ownerAUid, 'stage8-mtww3p0r-1ae5cb84b43c285e-ownerA')
  const inventory = exactInventory()
  inventory.ownerAAuth = { exists: true, uid: 'stage8-mtww3p0r-1ae5cb84b43c285e-ownerA-DIFFERENT' }
  assert.equal(evaluateLegacyResidual(inventory).eligible, false)
})
