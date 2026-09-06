import { guard, PROJECT } from './inventoryCore.mjs'

export const SERVICE = 'cloudfunctions.googleapis.com'
export const PROJECT_URL = `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}`
export const SERVICE_URL = `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/${SERVICE}`
export const BILLING_URL = `https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`
const blocked = () => { throw new Error('functions_api_inspection_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function activationGuard(options, git) {
  guard({ ...options, ...git })
  if (!['inspect', 'enable'].includes(options.mode) || options.service !== SERVICE) blocked()
}

export function operationUrl(name) {
  if (typeof name !== 'string' || !/^operations\/[a-zA-Z0-9._-]{1,300}$/.test(name)) blocked()
  return `https://serviceusage.googleapis.com/v1/${name}`
}

export function activationTransport(baseFetch, mode, beforeEnable = () => {}) {
  let dispatched = false
  let allowedOperation
  return {
    allowOperation(name) { allowedOperation = operationUrl(name) },
    fetch: async (input, init = {}) => {
    if (typeof input !== 'string' && !(input instanceof URL)) blocked()
    const url = new URL(input)
    const method = init.method ?? 'GET'
    const base = `${url.origin}${url.pathname}`
    const read = method === 'GET' && [PROJECT_URL, SERVICE_URL, BILLING_URL, allowedOperation].includes(base)
    const refresh = method === 'POST' && url.href === 'https://www.googleapis.com/oauth2/v3/token'
    const enable = mode === 'enable' && method === 'POST' && url.href === `${SERVICE_URL}:enable`
    if (url.username || url.password || url.hash || (!read && !refresh && !enable)) blocked()
    if (enable) {
      // Set BEFORE native dispatch, including a throw/timeout. This blocks
      // firebase-tools' automatic retries even after a premature close.
      if (dispatched) blocked()
      dispatched = true
      await beforeEnable()
    }
    return baseFetch(input, { ...init, redirect: 'error' })
    },
  }
}

export function persistJournal(fd, event, io) {
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')
  if (io.writeSync(fd, bytes) !== bytes.length) blocked()
  io.fsyncSync(fd)
}

export async function runFunctionsApi({ options, gitState, authorize, get, post, allowOperation, persist, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date().toISOString() }) {
  activationGuard(options, await gitState())
  await authorize()
  const startedAt = now()
  const project = await get(PROJECT_URL, 'projectId,projectNumber')
  if (!record(project) || project.projectId !== PROJECT || !/^\d+$/.test(project.projectNumber ?? '')) blocked()
  const readService = async () => {
    const service = await get(SERVICE_URL, 'name,state,config(name,usage(requirements))')
    if (!record(service) || ![
    `projects/${PROJECT}/services/${SERVICE}`,
    `projects/${project.projectNumber}/services/${SERVICE}`,
    ].includes(service.name) || !['ENABLED', 'DISABLED'].includes(service.state) || service.config?.name !== SERVICE) blocked()
    return service
  }
  const service = await readService()
  const requirements = service.config?.usage?.requirements
  if (requirements !== undefined && (!Array.isArray(requirements) || requirements.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9./_-]{1,300}$/.test(value)))) blocked()
  activationGuard(options, await gitState())
  const report = {
    task: 'SEC-006 Stage 8', sourceHead: options.expectedHead,
    status: 'FUNCTIONS_API_INSPECTED',
    project: PROJECT, service: SERVICE, beforeState: service.state, observedAfterState: null,
    usageRequirements: requirements ?? [],
    usageRequirementsReported: requirements !== undefined,
    startedAt, finishedAt: now(), activationAttempted: false, operation: null,
  }
  const finish = async (status, extra = {}) => {
    const result = { ...report, ...extra, status, finishedAt: now() }
    await persist(result)
    return result
  }
  if (options.mode === 'inspect') return finish('FUNCTIONS_API_INSPECTED')
  if (service.state === 'ENABLED') return finish('FUNCTIONS_API_ALREADY_ENABLED', { observedAfterState: 'ENABLED' })
  // Billing is checked read-only. Standard Cloud ToS remains enforced by the
  // enable endpoint; this helper never accepts terms or claims independent
  // verification. Any other requirement needs a separate explicit decision.
  const supported = ['serviceusage.googleapis.com/billing-enabled', 'serviceusage.googleapis.com/tos/cloud']
  if (requirements === undefined || requirements.some(value => !supported.includes(value))) {
    return finish('API_ENABLE_BLOCKED_REQUIREMENTS')
  }
  if (requirements.includes('serviceusage.googleapis.com/billing-enabled')) {
    const billing = await get(BILLING_URL, 'projectId,billingEnabled')
    if (!record(billing) || billing.projectId !== PROJECT || billing.billingEnabled !== true) return finish('API_ENABLE_BLOCKED_BILLING')
  }
  // Persist the before-state, then refresh it and the reviewed checkout just
  // before the POST. Reusing a cached CLI enabled-state is forbidden.
  await persist({ ...report, status: 'API_ENABLE_PREFLIGHT_VERIFIED' })
  const fresh = await readService()
  if (fresh.state === 'ENABLED') return finish('FUNCTIONS_API_ALREADY_ENABLED', { observedAfterState: 'ENABLED' })
  if (JSON.stringify(fresh.config?.usage?.requirements) !== JSON.stringify(requirements)) return finish('API_ENABLE_BLOCKED_REQUIREMENTS_CHANGED')
  activationGuard(options, await gitState())
  // Durable uncertainty record must succeed BEFORE dispatch. If the process
  // crashes next, do not rerun enable; inspect current state read-only.
  report.activationAttempted = true
  await persist({ ...report, status: 'API_ENABLE_REQUEST_MAY_BE_SENT' })
  let operation
  try {
    operation = await post()
    if (!record(operation)) blocked()
    operationUrl(operation.name)
    report.operation = operation.name
    await persist({ ...report, status: 'API_ENABLE_OPERATION_RECEIVED' })
    allowOperation(operation.name)
    activationGuard(options, await gitState())
  } catch {
    return finish('API_ENABLE_UNCERTAIN')
  }
  for (let poll = 0; poll <= 12; poll++) {
    if (operation.done === true) {
      if (operation.error !== undefined) return finish('API_ENABLE_OPERATION_FAILED')
      try {
        const after = await readService()
        activationGuard(options, await gitState())
        return finish(after.state === 'ENABLED' ? 'FUNCTIONS_API_ENABLED_VERIFIED' : 'API_ENABLE_UNCERTAIN', { observedAfterState: after.state })
      } catch { return finish('API_ENABLE_UNCERTAIN') }
    }
    if (operation.done !== undefined && operation.done !== false) return finish('API_ENABLE_UNCERTAIN')
    if (poll === 12) return finish('API_ENABLE_UNCERTAIN')
    await sleep(5000)
    try {
      operation = await get(operationUrl(report.operation), 'name,done,error(code)')
      if (!record(operation) || operation.name !== report.operation) blocked()
    } catch { return finish('API_ENABLE_UNCERTAIN') }
  }
}
