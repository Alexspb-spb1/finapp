import { createHash } from 'node:crypto'
import { PROJECT } from './inventoryCore.mjs'

const blocked = () => { throw new Error('mailbox_discovery_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')

export const URLS = Object.freeze({
  project: `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}`,
  lookup: `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`,
})

export function normalizeMailbox(value) {
  if (typeof value !== 'string') blocked()
  const normalized = value.trim().toLowerCase()
  if (normalized.length < 3 || normalized.length > 254 || /[\r\n\0]/.test(normalized) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) blocked()
  return normalized
}

export function profileUrl(uid) {
  if (typeof uid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(uid)) blocked()
  return `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}`
}

export function discoveryTransport(baseFetch, mailbox) {
  const expectedMailbox = normalizeMailbox(mailbox)
  const dynamicProfiles = new Set()
  return {
    allowProfile(uid) { dynamicProfiles.add(profileUrl(uid)) },
    fetch: async (input, init = {}) => {
      if (typeof input !== 'string' && !(input instanceof URL)) blocked()
      const url = new URL(input)
      const method = init.method ?? 'GET'
      const base = `${url.origin}${url.pathname}`
      if (url.username || url.password || url.hash) blocked()
      const noBody = init.body === undefined
      const projectRead = method === 'GET' && noBody && base === URLS.project && url.searchParams.size === 1 &&
        url.searchParams.get('fields') === 'projectId,projectNumber'
      const profileRead = method === 'GET' && noBody && dynamicProfiles.has(base) && url.search === ''
      let lookupBody = false
      if (method === 'POST' && base === URLS.lookup && url.search === '' && typeof init.body === 'string') {
        try {
          const parsed = JSON.parse(init.body)
          lookupBody = record(parsed) && Object.keys(parsed).length === 1 && Array.isArray(parsed.email) &&
            parsed.email.length === 1 && parsed.email[0] === expectedMailbox
        } catch { /* blocked below */ }
      }
      const lookupRead = lookupBody
      const refresh = method === 'POST' && url.href === 'https://www.googleapis.com/oauth2/v3/token'
      const allowed = projectRead || profileRead || lookupRead || refresh
      if (!allowed) blocked()
      return baseFetch(input, { ...init, redirect: 'error' })
    },
  }
}

export function createMailboxRequests({ Client, transport, mailbox, auth = true }) {
  const exactMailbox = normalizeMailbox(mailbox)
  const client = origin => new Client({ urlPrefix: origin, auth })
  // firebase-tools mutates the options object passed to get/post. Returning a
  // fresh object for every call prevents a lookup body reaching a later GET.
  const options = () => ({
    headers: { 'x-goog-user-project': PROJECT },
    skipLog: { body: true, resBody: true, queryParams: true },
    redirect: 'error',
    timeout: 30000,
    retries: 0,
  })
  return {
    getProject: async () => (await client('https://firebase.googleapis.com').get(
      new URL(URLS.project).pathname,
      { ...options(), queryParams: { fields: 'projectId,projectNumber' } },
    )).body,
    lookupAccount: async () => (await client('https://identitytoolkit.googleapis.com').post(
      new URL(URLS.lookup).pathname,
      { email: [exactMailbox] },
      options(),
    )).body,
    getProfile: async uid => (await client('https://firestore.googleapis.com').get(
      new URL(profileUrl(uid)).pathname,
      options(),
    )).body,
    allowProfile: uid => transport.allowProfile(uid),
  }
}

export function sanitizeLookup(body, mailbox) {
  if (!record(body) || (body.users !== undefined && !Array.isArray(body.users))) blocked()
  const users = body.users ?? []
  if (users.length === 0) return { accountExists: false, uid: null, account: null }
  if (users.length !== 1) blocked()
  const user = users[0]
  if (!record(user) || typeof user.localId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(user.localId) ||
      normalizeMailbox(user.email) !== mailbox ||
      (user.emailVerified !== undefined && typeof user.emailVerified !== 'boolean')) blocked()
  const createdAt = typeof user.createdAt === 'string' && /^\d{1,20}$/.test(user.createdAt) ? user.createdAt : null
  return {
    accountExists: true,
    uid: user.localId,
    account: { uidSha256: sha256(user.localId), emailVerified: Boolean(user.emailVerified), createdAtEpochMs: createdAt },
  }
}

export function sanitizeProfile(body, uid) {
  if (!record(body) || body.name !== `projects/${PROJECT}/databases/(default)/documents/users/${uid}` ||
      (body.fields !== undefined && !record(body.fields))) blocked()
  return { profileExists: true, profileFieldsSha256: sha256(JSON.stringify(body.fields ?? {})) }
}

export async function discoverMailbox({ mailbox, getProject, lookupAccount, getProfile, allowProfile, now = () => new Date().toISOString() }) {
  const project = await getProject()
  if (!record(project) || project.projectId !== PROJECT || !/^\d+$/.test(project.projectNumber ?? '')) blocked()
  const sanitized = sanitizeLookup(await lookupAccount(mailbox), mailbox)
  let profile = { profileExists: false, profileFieldsSha256: null }
  if (sanitized.accountExists) {
    allowProfile(sanitized.uid)
    try {
      profile = sanitizeProfile(await getProfile(sanitized.uid), sanitized.uid)
    } catch (error) {
      if (error?.status !== 404) blocked()
    }
  }
  return {
    task: 'SEC-006 Stage 8 mailbox discovery',
    status: 'MAILBOX_DISCOVERY_COMPLETE',
    project: PROJECT,
    capturedAt: now(),
    accountExists: sanitized.accountExists,
    account: sanitized.account,
    profile,
    cloudMutations: 0,
    emailsSent: 0,
  }
}
