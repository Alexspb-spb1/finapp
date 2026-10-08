// M1-STAGING-READONLY-RECON-PREP-03 - pins of the bounded READ-ONLY reconciliation of finapp-staging. Status: PREPARED_NOT_AUTHORIZED.
// Pure data: nothing here touches the network or any credential. The 2026-10-07 facts are a DATED BASELINE of the audit; this package exists to READ the
// current state later, under a separate one-use owner permit, and it never pre-declares what that reading will show.
import { createHash } from 'node:crypto'

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex')

export const RECON = Object.freeze({
  taskId: 'M1-STAGING-READONLY-RECON-PREP-03',
  status: 'PREPARED_NOT_AUTHORIZED',
  project: 'finapp-staging',
  head: '714d0f91c60a582ee87dc7da82d6249b3106329f',
  rulesTarget: 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd',
  stageHost: 'stage.aktivmetr.ru',
  baselineDate: '2026-10-07',
  // One-use evidence namespace of the future reading. Consumed and reserved names of every earlier flow are refused.
  evidenceName: 'm1-stg-readonly-recon-03',
  runtimeRoot: 'D:\\projects\\finapp\\.runtime',
  rehearsalBase: 'D:\\projects\\finapp\\.runtime\\m1-recon-rehearsal\\',
  consumedNames: Object.freeze(['m1-stg-r3-714d0f91', 'm1-stg-r3v5-714d0f91', 'm1-stg-r4-714d0f91', 'm1-stg-rev7-8526a79', 'm1-stg-rev8-8526a79', 'm1-stg-diag1-rev7', 'm1-stg-s1b-714d0f91',
    'm1-staging-run-714d0f91', 'm1-staging-run-714d0f91-v5', 'm1-staging-run-714d0f91-v6', 'm1-staging-run-714d0f91-s1b', 'm1-staging-run-8526a79-rev7', 'm1-staging-run-8526a79-rev8']),
  // The private run directory of the consumed run r3-ab9fb2fe (read-only source of the single synthetic subject of the optional Auth lookup).
  consumedJournal: 'D:\\projects\\finapp\\.runtime\\m1-staging-run-714d0f91-v5\\journal.jsonl',
  productionMarkers: Object.freeze(['finapp-prod-10a83', 'finapp-prod', 'app.aktivmetr.ru']),
  // Operation classes of the owner permit (every one is false in the template).
  operationClasses: Object.freeze({
    credentialConfigRead: 'read the cached Firebase CLI login (access token + expiry) from the owner profile, read-only, in memory; no refresh, no write, no print',
    functionsMetadataRead: 'two GET requests: Cloud Functions v1 and v2 list metadata of finapp-staging (no archive download, no code export, no IAM)',
    rulesReleaseRead: 'two GET requests: the live Firestore Rules release and its ruleset (canonical bytes and hash)',
    frontendPublicRead: 'seventeen public HTTPS GET requests to https://stage.aktivmetr.ru/ (fixed artifact paths, no credentials, no browser, no SDK)',
    authExactLookup: 'ONE POST accounts:lookup of the single synthetic subject of the old UNKNOWN create (no list, no search, no other account)'
  }),
  limits: Object.freeze({
    perRequestTimeoutMs: 10000, globalDeadlineMs: 120000, maxRequests: 22, maxTotalResponseBytes: 8 * 1024 * 1024,
    minTokenRemainingMs: 25 * 60 * 1000, maxPermitMs: 2 * 3600 * 1000
  })
})

/** Closed set of codes of a STOP. Nothing else (no message, URL, header, body or stack of an underlying error) is ever recorded. */
export const STOP_CODES = Object.freeze([
  'allowlist-denied', 'budget-exhausted', 'deadline', 'timeout', 'network-unknown', 'redirect', 'oversize', 'http-401', 'http-403', 'http-404', 'http-429', 'http-5xx', 'http-other',
  'malformed-json', 'unexpected-shape', 'pin-mismatch', 'credential-config-missing', 'credential-config-unreadable', 'credential-token-missing', 'credential-too-old',
  'subject-source-mismatch', 'subject-not-synthetic', 'unexpected'
])
export class Blocked extends Error {
  constructor(code) { super(code); this.code = STOP_CODES.includes(code) ? code : 'unexpected' }
}

const nameOf = p => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop()
/** Namespace problems for a reading about to start (existence is passed in). */
export function namespaceProblems({ profile, evidenceDir, exists }) {
  const problems = []
  const norm = p => String(p).toLowerCase()
  if (profile === 'staging') {
    if (nameOf(evidenceDir) !== RECON.evidenceName) problems.push('evidence directory name is not the pinned namespace')
    if (norm(evidenceDir.slice(0, evidenceDir.lastIndexOf('\\'))) !== norm(RECON.runtimeRoot)) problems.push('namespace outside the runtime root')
  } else if (!norm(evidenceDir).startsWith(norm(RECON.rehearsalBase)) || evidenceDir.includes('..')) problems.push('rehearsal evidence outside the rehearsal base')
  if (RECON.consumedNames.includes(nameOf(evidenceDir))) problems.push('consumed or reserved namespace')
  if (exists(evidenceDir)) problems.push('namespace already exists (a reading is never repeated)')
  return problems
}

/** Production markers in any input value, a non-staging project, or a foreign stage host. */
export function targetProblems({ project, values = [] }) {
  const problems = []
  if (project !== RECON.project) problems.push('target project is not finapp-staging')
  for (const v of values) for (const m of RECON.productionMarkers) if (String(v).toLowerCase().includes(m)) problems.push('production marker in the input values')
  return [...new Set(problems)]
}
