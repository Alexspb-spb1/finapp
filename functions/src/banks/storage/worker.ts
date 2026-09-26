import { randomUUID } from 'node:crypto'
import type { ApiBankAdapter } from '../ports'
import { BankError } from '../errors'
import { BankStore, type Failure } from './store'
import type { JobRef } from './schema'

/** Adapter may expose only an allowlisted failure category, never bank response text. */
export class BankReadFailure extends Error {
  constructor(readonly category: Failure, readonly retryAfterMs = 0) { super('bank_read_failed') }
}

/** Exactly one bounded API page. Scheduling/refresh/OAuth are later stages.
 * No network call is executed inside a retryable Firestore transaction.
 */
export async function runOnePage(store: BankStore, ref: JobRef, adapter: ApiBankAdapter,
  signal?: AbortSignal): Promise<'busy' | 'committed' | 'replayed' | 'retry_recorded'> {
  if (signal?.aborted) throw new BankError('bank_run_cancelled')
  const lease = await store.claim(ref, randomUUID())
  if (!lease) return 'busy'
  const job = await store.readWork(lease)
  if (job.channel !== 'api' || adapter.bankId !== job.request.bankId
    || adapter.capabilities.channel !== 'api' || adapter.capabilities.readOnly !== true) {
    await store.fail(lease, 'permanent')
    throw new BankError('bank_not_supported')
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  let page: unknown
  try {
    page = await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new BankError('bank_run_cancelled')
        return adapter.readStatementPage(Object.freeze({ ...job.request }), job.cursor, controller.signal)
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => { controller.abort(); reject(new BankError('bank_run_cancelled')) }
        signal?.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => { controller.abort(); reject(new BankReadFailure('transient')) }, 30_000)
        if (signal?.aborted) onAbort()
      }),
    ])
  } catch (error) {
    if (signal?.aborted) throw new BankError('bank_run_cancelled') // lease expires; no late response commit
    await store.fail(lease, error instanceof BankReadFailure ? error.category : 'transient',
      error instanceof BankReadFailure ? error.retryAfterMs : 0)
    return 'retry_recorded'
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
  if (signal?.aborted) throw new BankError('bank_run_cancelled')
  // Storage/auth failures propagate; they are not misreported as provider retries.
  return store.commitPage(lease, { pageIndex: job.pageIndex, cursor: job.cursor }, page)
}
