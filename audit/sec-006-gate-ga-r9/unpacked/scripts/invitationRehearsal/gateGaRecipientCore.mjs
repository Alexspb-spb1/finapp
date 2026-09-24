import { createHash } from 'node:crypto'
import { PROJECT } from './inventoryCore.mjs'
import { normalizeMailbox } from './mailboxDiscoveryCore.mjs'

const blocked = () => { throw new Error('recipient_guard_blocked') }
const KNOWN_PRODUCTION_PROJECTS = Object.freeze(['finapp-prod-10a83'])
const sha256 = value => createHash('sha256').update(value).digest('hex')

// PROJECT is imported from the same fixed, non-configurable constant every
// staging tool in this module tree uses — this call can never resolve to a
// production project id by construction, and this assertion makes that a
// runtime-checked fact rather than an assumption.
export function assertNotProduction() {
  if (KNOWN_PRODUCTION_PROJECTS.includes(PROJECT)) blocked()
  if (PROJECT !== 'finapp-staging') blocked()
  return true
}

/**
 * recipient is a MANDATORY runtime parameter — there is no default, no
 * fallback file lookup here. Returns only a redaction (sha256) and the
 * discovery outcome; the plaintext email never leaves this function's local
 * scope (not returned, not logged by the caller because it never has it).
 */
export async function resolveRecipientPreflight(recipient, { lookupAccount, getProfile, getProject, allowProfile = false, now } = {}) {
  if (typeof recipient !== 'string' || recipient.length === 0) blocked('recipient is a mandatory runtime parameter')
  assertNotProduction()
  const mailbox = normalizeMailbox(recipient)
  const { discoverMailbox } = await import('./mailboxDiscoveryCore.mjs')
  const discovery = await discoverMailbox({ mailbox, getProject, lookupAccount, getProfile, allowProfile, now })
  return Object.freeze({
    project: PROJECT,
    recipientSha256: sha256(mailbox),
    accountExists: discovery.accountExists,
    profileExists: discovery.profileExists ?? false,
    absent: discovery.accountExists === false,
  })
}

/**
 * The email must never be sent without the owner having confirmed the exact
 * hash this preflight computed. ownerConfirmedSha256 is whatever the owner
 * typed/pasted back after being shown recipientSha256 in chat — a mismatch
 * (wrong owner input, stale confirmation from a different recipient, or a
 * caller trying to skip confirmation) refuses unconditionally.
 */
export function assertOwnerConfirmedRecipient(preflight, ownerConfirmedSha256) {
  if (!preflight || typeof preflight.recipientSha256 !== 'string') blocked()
  if (typeof ownerConfirmedSha256 !== 'string' || ownerConfirmedSha256 !== preflight.recipientSha256) blocked()
  if (preflight.absent !== true) blocked('recipient must be absent from staging Auth before any invitation/email')
  return true
}
