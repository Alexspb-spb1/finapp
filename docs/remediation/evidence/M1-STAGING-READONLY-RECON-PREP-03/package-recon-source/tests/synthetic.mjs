// Synthetic world for the offline tests: raw provider-shaped responses, pins built from them, and a RECORDER fetch (no socket is ever opened).
// Nothing here is, or is derived from, a live reading; the only real inputs are the package's own request allowlist and (optionally) local files.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = f => import(pathToFileURL(path.join(PKG, f)).href)
const { RECON, sha256Hex } = await imp('recon-pins.mjs')
const { projectFunction, loadPins } = await imp('recon-core.mjs')
const { canonicalOf } = await imp('m1-state-lib.mjs')
export { RECON, sha256Hex, PKG }

export const FN_IDS = ['acceptInvite', 'cancelInvite', 'changeMemberRole', 'createCompany', 'disableMember', 'getCompanyAccess', 'inviteMember', 'listCompanyMembers', 'listInvitations', 'previewInvite', 'removeMember', 'resendInvite', 'restoreMember']
export const M1_IDS = ['changeMemberRole', 'disableMember', 'listCompanyMembers', 'removeMember', 'restoreMember']
export const RULES_TEXT = 'rules_version = \'2\';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n'
export const RULES_PRE_TEXT = `${RULES_TEXT}// previous round\n`

export const rawFunction = (id, over = {}) => ({
  name: `projects/finapp-staging/locations/us-central1/functions/${id}`, state: 'ACTIVE', environment: 'GEN_2',
  buildConfig: { runtime: 'nodejs22', entryPoint: id, build: `projects/860039810193/locations/us-central1/builds/${sha256Hex(id).slice(0, 8)}-0000-4000-8000-${sha256Hex(id).slice(8, 20)}`, source: { storageSource: { bucket: 'synthetic-bucket', object: `src-${id}.zip` } } },
  serviceConfig: { availableMemory: '256Mi', availableCpu: '1', maxInstanceRequestConcurrency: 1, maxInstanceCount: 1, timeoutSeconds: 60, revision: `${id.toLowerCase()}-00001-abc` },
  ...over
})

export function syntheticExpected() {
  const projected = FN_IDS.map(id => projectFunction(rawFunction(id)))
  return {
    project: RECON.project, sourceHead: RECON.head,
    caps: { memory: '256Mi', cpu: 1, concurrency: 1, minInstances: 0, maxInstances: 1, timeoutSeconds: 60 },
    functions: projected.map(f => ({ id: f.id, group: M1_IDS.includes(f.id) ? 'm1' : 'baseline', revision: f.revision, build: f.build, sourceReferenceSha256: f.sourceReferenceSha256 })),
    rulesPre: { rulesetName: 'projects/finapp-staging/rulesets/pre-release-0001', canonicalSha256: canonicalOf(RULES_PRE_TEXT), rawSha256: sha256Hex(RULES_PRE_TEXT), sourceBytes: Buffer.byteLength(RULES_PRE_TEXT) },
    rulesTarget: { canonicalSha256: canonicalOf(RULES_TEXT), rawSha256: sha256Hex(RULES_TEXT), sourceBytes: Buffer.byteLength(RULES_TEXT) }
  }
}

export function syntheticFrontend() {
  const files = {}
  const paths = ['404.html', 'index.html', 'favicon.svg', 'icons.svg', 'assets/firebase-AAAA1111.js', 'assets/index-BBBB2222.js', 'assets/LegacyApp-CCCC3333.js', 'assets/AcceptInvite-DDDD4444.js', 'assets/authStore-EEEE5555.js',
    'assets/invitationEntry-FFFF6666.js', 'assets/inviteAcceptanceApi-GGGG7777.js', 'assets/jsx-runtime-HHHH8888.js', 'assets/react-dom-IIII9999.js', 'assets/renderApp-JJJJ0000.js', 'assets/renderApp-KKKK1111.css']
  for (const p of paths) files[p] = p.startsWith('assets/firebase-') ? 'const c={VITE_FIREBASE_PROJECT_ID:"finapp-staging",VITE_APP_ENV:"staging"};export{c}\n' : `/* synthetic ${p} */\n${'x'.repeat(40 + p.length)}\n`
  const fp = {
    format: 'finapp-m1-recon-frontend-allowlist-v1', host: RECON.stageHost, base: '/finapp/', marker: { chunkPrefix: 'assets/firebase-', projectId: 'finapp-staging', forbidden: ['finapp-prod-10a83'] },
    index: { sha256: sha256Hex(files['index.html']), bytes: Buffer.byteLength(files['index.html']) },
    files: paths.map(p => ({ path: p, sha256: sha256Hex(files[p]), bytes: Buffer.byteLength(files[p]) }))
  }
  return { fp, files }
}

export function syntheticSubject() {
  const runId = 'abcdef01'
  const events = [{ event: 'MODE_START' }, { event: 'PREFLIGHT_OK', runId }, { event: 'MODE_PASS' }, { event: 'AUTH_CREATE_MAY_BE_SENT', key: 'admin' }, { event: 'MODE_STOP', kind: 'transport' }]
  const journal = Buffer.from(`${events.map(e => JSON.stringify(e)).join('\n')}\n`)
  const email = `m1-${runId}-admin@example.invalid`
  const pin = { format: 'finapp-m1-recon-consumed-subject-pin-v1', run: 'r3-ab9fb2fe', runId, subjectKey: 'admin', source: { sha256: sha256Hex(journal), bytes: journal.length, events: events.length }, subjectSha256: sha256Hex(email) }
  return { journal, email, pin }
}

/** All the synthetic inputs of one reading. */
export function makeWorld(over = {}) {
  const real = loadPins(PKG)
  const expected = syntheticExpected()
  const { fp, files } = syntheticFrontend()
  const subject = syntheticSubject()
  const pins = { allow: real.allow, frontend: fp, subject: subject.pin, expected, hashes: real.hashes, ...over.pins }
  return { pins, files, subject, expected, frontend: fp }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
/** Default provider behaviour matching the synthetic pins; `override(key, req)` may return a Response (or throw) to alter ONE exchange. */
export function recorderFetch(world, override = () => undefined) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const call = { method: init.method ?? 'GET', url: String(url), host: u.hostname, path: u.pathname, search: u.search, headers: { ...(init.headers ?? {}) }, body: init.body, redirect: init.redirect, hasSignal: !!init.signal }
    calls.push(call)
    const key = `${call.method} ${u.hostname}${u.pathname}`
    const o = override(key, call)
    if (o !== undefined) return o
    if (u.hostname === RECON.stageHost) {
      const rel = u.pathname === '/' || u.pathname === '/finapp/' ? 'index.html' : u.pathname.replace(/^\/finapp\//, '')
      return world.files[rel] !== undefined ? new Response(world.files[rel], { status: 200 }) : new Response('not found', { status: 404 })
    }
    if (key === 'GET cloudfunctions.googleapis.com/v1/projects/finapp-staging/locations/-/functions') return json({})
    if (key === 'GET cloudfunctions.googleapis.com/v2/projects/finapp-staging/locations/-/functions') return json({ functions: FN_IDS.map(id => rawFunction(id)) })
    if (key === 'GET firebaserules.googleapis.com/v1/projects/finapp-staging/releases/cloud.firestore') return json({ name: 'projects/finapp-staging/releases/cloud.firestore', rulesetName: 'projects/finapp-staging/rulesets/live-ruleset-0002', updateTime: '2026-10-07T08:06:12.689131Z' })
    if (key === 'GET firebaserules.googleapis.com/v1/projects/finapp-staging/rulesets/live-ruleset-0002') return json({ name: 'projects/finapp-staging/rulesets/live-ruleset-0002', createTime: '2026-10-07T08:06:10Z', source: { files: [{ name: 'firestore.rules', content: RULES_TEXT }] } })
    if (key === 'POST identitytoolkit.googleapis.com/v1/projects/finapp-staging/accounts:lookup') return json({})
    return new Response('{}', { status: 404 })
  }
  return { fetchImpl, calls }
}

let unitN = 0
export function newUnit(base = RECON.rehearsalBase) { fs.mkdirSync(base, { recursive: true }); return path.join(base, `unit-${process.pid}-${Date.now()}-${++unitN}`) }

export const SYNTH_TOKEN = 'ya29.SYNTHETIC-TEST-TOKEN-0123456789abcdefghijklmnopqrstuvwxyz'
export const bootstrapOk = () => ({ accessToken: SYNTH_TOKEN, remainingMs: 3600000, reads: 1 })

/** A rehearsal configuration over the synthetic world (profile rehearsal: injected fetch / pins / bootstrap / journal). */
export function rehearsalCfg(world, { override, ops, bootstrap = bootstrapOk, extra = {} } = {}) {
  const rec = recorderFetch(world, override)
  const unit = newUnit()
  fs.mkdirSync(unit, { recursive: true })
  const journalPath = path.join(unit, 'journal.jsonl')
  fs.writeFileSync(journalPath, world.subject.journal)
  const bootstrapCalls = []
  const cfg = {
    profile: 'rehearsal', pkg: PKG, evDir: path.join(unit, 'ev'), env: {}, fetchImpl: rec.fetchImpl, pins: world.pins, ops, consumedJournalPath: journalPath,
    bootstrap: (...a) => { bootstrapCalls.push(a); return bootstrap(...a) }, ...extra
  }
  return { cfg, calls: rec.calls, unit, journalPath, bootstrapCalls }
}
export const sha = sha256Hex
export { os, fs, path }
