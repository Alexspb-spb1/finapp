// M1-STAGING-R3-SMOKE-PREP-02 - the owner's execution permit for the S1b smoke-only flow.
// A permit is a JSON document that BINDS one execution to exact bytes (the package code sums, the operation budget, the expected-state file, the staging
// build manifest), the target project, the namespace and an explicit list of allowed operation classes. Without a valid permit the staging profile is
// refused before anything runs. This module only validates a document; it never creates a permit and never decides for the owner.
import { S1B } from './m1-s1b-pins.mjs'

export const PERMIT_FORMAT = 'finapp-m1-s1b-permit-v1'
export const MAX_RECONCILIATION_AGE_MS = 24 * 3600 * 1000

// The operation classes of the flow. Every class is false in the template; the owner turns on exactly what is allowed.
export const OPERATION_CLASSES = Object.freeze({
  githubCiRead: 'one read of the CI run of the reviewed head (gh run view)',
  stagingStateReads: 'read-only, operator credentials: Functions exact state, the live Rules hash (start and end) and the preflight reads (maintenance flag, fixture e-mails absent)',
  readinessProbes: 'unauthenticated probes of the five M1 callables (application layer)',
  authCreate: 'create the three synthetic Auth users (m1-<runId>-*@example.invalid)',
  firestoreAndCallables: 'seed and API/UI modes: two createCompany calls, one operator commit, the M1 callables, Rules probes with client tokens',
  cleanup: 'cleanup of exactly the synthetic resources recorded in the run directory (gates G1-G5)',
  cleanupExactLookup: 'the G4 exact synthetic-subject lookup (Auth accounts:lookup by uid/email, Firestore reads) that cleanup, verify-clean and inventory perform',
  cleanupAfterProvenNonDispatch: 'allow cleanup after a PROVEN pre-dispatch transport failure (accepted recovery policy); off = a manual decision is required'
})

export function permitTemplate() {
  return {
    format: PERMIT_FORMAT,
    taskId: S1B.taskId,
    variant: S1B.variant,
    status: 'TEMPLATE_NOT_A_PERMIT',
    target: { project: S1B.project, head: S1B.head, stageHost: S1B.stageHost },
    namespace: { evidenceName: S1B.evidenceName, runName: S1B.runName },
    bytes: { codeSums: '<sha256 of CODE-SHA256SUMS.txt>', budget: '<sha256 of operation-budget.json>', expectedState: '<sha256 of expected-state-r3.json>', distManifest: '<sha256 of dist-staging-manifest.txt>' },
    rules: { canonicalSha256: S1B.rulesTarget },
    reconciliation: { performedAtUtc: '<ISO time of the separately permitted read-only state reconciliation>', evidenceRef: '<reference to the auditor/owner-accepted reading>' },
    operations: Object.fromEntries(Object.keys(OPERATION_CLASSES).map(k => [k, false])),
    owner: { approvalRef: '<reference to the owner decision>', approvedAtUtc: '<ISO>', expiresAtUtc: '<ISO, at most 24 h after approval>' }
  }
}

/** Problems of a permit against the facts of THIS package and run. `facts` = { codeSumsSha256, budgetSha256, expectedStateSha256, distManifestSha256, evidenceName, runName }. */
export function permitProblems(permit, facts, nowMs) {
  const problems = []
  const p = permit && typeof permit === 'object' && !Array.isArray(permit) ? permit : null
  if (!p) return ['permit is not an object']
  if (p.format !== PERMIT_FORMAT) problems.push('permit format')
  if (p.status === 'TEMPLATE_NOT_A_PERMIT') problems.push('the template is not a permit')
  if (p.taskId !== S1B.taskId || p.variant !== S1B.variant) problems.push('permit task/variant')
  if (p.target?.project !== S1B.project) problems.push('permit target project is not finapp-staging')
  if (p.target?.head !== S1B.head) problems.push('permit head')
  if (p.namespace?.evidenceName !== facts.evidenceName || p.namespace?.runName !== facts.runName || facts.evidenceName !== S1B.evidenceName || facts.runName !== S1B.runName) problems.push('permit namespace')
  if (p.bytes?.codeSums !== facts.codeSumsSha256) problems.push('permit is not bound to these package bytes')
  if (p.bytes?.budget !== facts.budgetSha256) problems.push('permit is not bound to this operation budget')
  if (p.bytes?.expectedState !== facts.expectedStateSha256) problems.push('permit is not bound to this expected-state file')
  if (p.bytes?.distManifest !== facts.distManifestSha256) problems.push('permit is not bound to this staging build manifest')
  if (p.rules?.canonicalSha256 !== S1B.rulesTarget) problems.push('permit Rules pin')
  const ops = p.operations && typeof p.operations === 'object' ? p.operations : {}
  if (Object.keys(ops).sort().join() !== Object.keys(OPERATION_CLASSES).sort().join() || Object.values(ops).some(v => typeof v !== 'boolean')) problems.push('permit operations shape')
  // The flow cannot run partially: the mandatory classes must all be on.
  for (const k of ['githubCiRead', 'stagingStateReads', 'readinessProbes', 'authCreate', 'firestoreAndCallables']) if (ops[k] !== true) problems.push(`permit does not allow ${k}`)
  // Cleanup is one decision: the exact lookup (G4) is part of it and neither alone is acceptable.
  if (ops.cleanup !== ops.cleanupExactLookup) problems.push('permit: cleanup and its exact lookup must be allowed together')
  if (ops.cleanupAfterProvenNonDispatch === true && ops.cleanup !== true) problems.push('permit: cleanup after a proven non-dispatch requires cleanup')
  const time = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) ? Date.parse(v) : NaN)
  const recon = time(p.reconciliation?.performedAtUtc), approved = time(p.owner?.approvedAtUtc), expires = time(p.owner?.expiresAtUtc)
  if (Number.isNaN(recon) || Number.isNaN(approved) || Number.isNaN(expires)) problems.push('permit times')
  else {
    if (!(approved <= nowMs && nowMs < expires)) problems.push('permit is not valid now')
    if (expires - approved > MAX_RECONCILIATION_AGE_MS) problems.push('permit validity longer than 24 h')
    if (recon > approved || approved - recon > MAX_RECONCILIATION_AGE_MS) problems.push('state reconciliation is missing or older than 24 h at approval')
  }
  if (typeof p.owner?.approvalRef !== 'string' || p.owner.approvalRef.length < 3 || /^<.*>$/.test(p.owner.approvalRef)) problems.push('permit approval reference')
  if (typeof p.reconciliation?.evidenceRef !== 'string' || /^<.*>$/.test(p.reconciliation.evidenceRef)) problems.push('permit reconciliation reference')
  return problems
}
