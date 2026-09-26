import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { assertNotProduction, assertOwnerConfirmedRecipient, resolveRecipientPreflight } from './gateGaRecipientCore.mjs'

const sha256 = v => createHash('sha256').update(v).digest('hex')

test('assertNotProduction passes for the fixed staging project constant', () => {
  assert.equal(assertNotProduction(), true)
})

test('resolveRecipientPreflight refuses a missing or empty recipient (mandatory parameter, no default)', async () => {
  await assert.rejects(() => resolveRecipientPreflight(undefined, {}))
  await assert.rejects(() => resolveRecipientPreflight('', {}))
})

test('resolveRecipientPreflight never returns the plaintext email, only a hash and existence flags', async () => {
  const email = 'owner-mailbox@example.invalid'
  const result = await resolveRecipientPreflight(email, {
    getProject: async () => ({ projectId: 'finapp-staging', projectNumber: '860039810193' }),
    lookupAccount: async () => ({ users: [] }),
  })
  assert.equal(result.recipientSha256, sha256(email.toLowerCase()))
  assert.equal(Object.values(result).some(v => typeof v === 'string' && v.includes('@')), false)
  assert.equal(result.absent, true)
  assert.equal(result.project, 'finapp-staging')
})

test('resolveRecipientPreflight reports absent:false when the account already exists in staging Auth', async () => {
  const email = 'already-there@example.invalid'
  const result = await resolveRecipientPreflight(email, {
    getProject: async () => ({ projectId: 'finapp-staging', projectNumber: '860039810193' }),
    lookupAccount: async () => ({ users: [{ localId: 'uid-existing', email, emailVerified: true }] }),
    allowProfile: () => {},
    getProfile: async () => { const error = new Error('not found'); error.status = 404; throw error },
  })
  assert.equal(result.accountExists, true)
  assert.equal(result.absent, false)
})

test('assertOwnerConfirmedRecipient refuses without a matching owner-confirmed hash', () => {
  const preflight = { recipientSha256: sha256('a@example.invalid'), absent: true }
  assert.throws(() => assertOwnerConfirmedRecipient(preflight, undefined))
  assert.throws(() => assertOwnerConfirmedRecipient(preflight, sha256('different@example.invalid')))
  assert.equal(assertOwnerConfirmedRecipient(preflight, preflight.recipientSha256), true)
})

test('assertOwnerConfirmedRecipient refuses even a correctly-confirmed hash if the recipient already exists (existing recipient guard)', () => {
  const preflight = { recipientSha256: sha256('taken@example.invalid'), absent: false }
  assert.throws(() => assertOwnerConfirmedRecipient(preflight, preflight.recipientSha256))
})
