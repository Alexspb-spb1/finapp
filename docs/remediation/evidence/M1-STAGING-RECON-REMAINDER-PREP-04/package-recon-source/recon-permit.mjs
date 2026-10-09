// The one-use owner permit of the bounded read-only reconciliation. It BINDS one reading to exact bytes (package code sums, request allowlist, frontend allowlist, consumed-subject
// pin, expected state, build manifest), the target, the evidence namespace, a short time window and an explicit list of read operation classes. It authorizes NOTHING else:
// no S1b smoke, no readiness POST, no callable, no mutation, no cleanup, no deploy, no merge. Validation only - this module never creates a permit and never decides for the owner.
import { RECON } from './recon-pins.mjs'

export const PERMIT_FORMAT = 'finapp-m1-recon-permit-v1'
export const ACK_KEYS = Object.freeze(['noTokenRefreshAndNoConfigWrite', 'noRetryAndStopOnUnknown', 'absentNowIsNotProofOfNonDispatch', 'resultsAreObservationsNotAcceptance'])

export function permitTemplate() {
  return {
    format: PERMIT_FORMAT, taskId: RECON.taskId, status: 'TEMPLATE_NOT_A_PERMIT',
    target: { project: RECON.project, stageHost: RECON.stageHost, head: RECON.head },
    namespace: { evidenceName: RECON.evidenceName },
    bytes: { codeSums: '<sha256 of CODE-SHA256SUMS.txt>', requestAllowlist: '<sha256 of request-allowlist.json>', frontendAllowlist: '<sha256 of frontend-allowlist.json>', consumedSubjectPin: '<sha256 of consumed-subject-pin.json>', expectedState: '<sha256 of expected-state-r3.json>', distManifest: '<sha256 of dist-staging-manifest.txt>' },
    rules: { canonicalSha256: RECON.rulesTarget },
    operations: Object.fromEntries(Object.keys(RECON.operationClasses).map(k => [k, false])),
    acknowledgements: Object.fromEntries(ACK_KEYS.map(k => [k, false])),
    owner: { approvalRef: '<reference to the owner decision>', approvedAtUtc: '<ISO>', expiresAtUtc: '<ISO, at most 2 h after approval>' }
  }
}

/** Problems of a permit against the facts of THIS package: facts = { codeSumsSha256, requestAllowlistSha256, frontendAllowlistSha256, consumedSubjectPinSha256, expectedStateSha256, distManifestSha256, evidenceName }. */
export function permitProblems(permit, facts, nowMs) {
  const p = permit && typeof permit === 'object' && !Array.isArray(permit) ? permit : null
  if (!p) return ['permit is not an object']
  const problems = []
  if (p.format !== PERMIT_FORMAT) problems.push('permit format')
  if (p.status === 'TEMPLATE_NOT_A_PERMIT') problems.push('the template is not a permit')
  if (p.taskId !== RECON.taskId) problems.push('permit task')
  if (p.target?.project !== RECON.project || p.target?.stageHost !== RECON.stageHost || p.target?.head !== RECON.head) problems.push('permit target (project / stage host / head)')
  if (p.namespace?.evidenceName !== facts.evidenceName || facts.evidenceName !== RECON.evidenceName) problems.push('permit namespace')
  const bound = [['codeSums', 'codeSumsSha256'], ['requestAllowlist', 'requestAllowlistSha256'], ['frontendAllowlist', 'frontendAllowlistSha256'], ['consumedSubjectPin', 'consumedSubjectPinSha256'], ['expectedState', 'expectedStateSha256'], ['distManifest', 'distManifestSha256']]
  for (const [k, f] of bound) if (typeof facts[f] !== 'string' || p.bytes?.[k] !== facts[f]) problems.push(`permit is not bound to these bytes (${k})`)
  if (p.rules?.canonicalSha256 !== RECON.rulesTarget) problems.push('permit Rules pin')
  const ops = p.operations && typeof p.operations === 'object' ? p.operations : {}
  if (Object.keys(ops).sort().join() !== Object.keys(RECON.operationClasses).sort().join() || Object.values(ops).some(v => typeof v !== 'boolean')) problems.push('permit operations shape')
  else {
    if (![ops.functionsMetadataRead, ops.rulesReleaseRead, ops.frontendPublicRead, ops.authExactLookup].some(Boolean)) problems.push('permit allows no reading')
    // The cached login is read iff some Google API branch is permitted - and only then.
    const needsLogin = ops.functionsMetadataRead || ops.rulesReleaseRead || ops.authExactLookup
    if (needsLogin !== ops.credentialConfigRead) problems.push('permit: credentialConfigRead must be on exactly when a Google API branch is on')
  }
  const ack = p.acknowledgements && typeof p.acknowledgements === 'object' ? p.acknowledgements : {}
  if (Object.keys(ack).sort().join() !== [...ACK_KEYS].sort().join() || ACK_KEYS.some(k => ack[k] !== true)) problems.push('permit acknowledgements (all four must be true)')
  const time = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) ? Date.parse(v) : NaN)
  const approved = time(p.owner?.approvedAtUtc), expires = time(p.owner?.expiresAtUtc)
  if (Number.isNaN(approved) || Number.isNaN(expires)) problems.push('permit times')
  else {
    if (!(approved <= nowMs && nowMs < expires)) problems.push('permit is not valid now')
    if (expires - approved > RECON.limits.maxPermitMs) problems.push('permit validity longer than 2 h')
  }
  if (typeof p.owner?.approvalRef !== 'string' || p.owner.approvalRef.length < 3 || /^<.*>$/.test(p.owner.approvalRef)) problems.push('permit approval reference')
  return problems
}
