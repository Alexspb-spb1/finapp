import { randomUUID } from 'node:crypto'
import type { Firestore } from 'firebase-admin/firestore'
import { z } from 'zod'
import { BankError } from '../errors'
import { BankReadFailure } from '../storage/worker'
import { counter, hash } from '../storage/schema'
import { parseBankData } from '../contracts'
import { ConfigSchema, type SberConfig } from './protocol'

const Lease = z.object({ owner: z.string().uuid().nullable(), fence: counter,
  leaseUntil: counter, nextAllowedAt: counter }).strict()
const GAP_MS = 2200 // More than the documented 2000 ms; small clock/network margin.
const LEASE_MS = 45_000 // Exceeds the 20-second network timeout and 30-second worker timeout.
const MAX_WAIT_MS = 25_000

export interface SberRateGate { run<T>(send: (leaseUntil: number) => Promise<T>, signal: AbortSignal): Promise<T> }

/** One durable request slot shared by every Sber connection for one platform client.
 * It covers token, user-info and statements. No HTTP call is made in a transaction.
 * Only an active owner may use the slot, and its transactionally released cooldown
 * begins AFTER its response/error. A crashed owner retains a bounded lease.
 */
export class FirestoreSberRateGate implements SberRateGate {
  private readonly path: string
  constructor(private readonly db: Firestore, config: SberConfig, private readonly clock: () => number = Date.now) {
    const parsed = parseBankData(ConfigSchema, config)
    this.path = `bankSberRequestGates/${parsed.environment}-${hash(parsed.clientId)}`
  }
  private async wait(ms: number, signal: AbortSignal) {
    if (signal.aborted) throw new BankError('bank_run_cancelled')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
      const abort = () => { clearTimeout(timer); reject(new BankError('bank_run_cancelled')) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  async run<T>(send: (leaseUntil: number) => Promise<T>, signal: AbortSignal): Promise<T> {
    const ref = this.db.doc(this.path), owner = randomUUID(), started = this.clock()
    let fence: number | undefined, leaseUntil: number | undefined
    try {
      for (;;) {
        if (signal.aborted) throw new BankError('bank_run_cancelled')
        const attempt = await this.db.runTransaction(async tx => {
          const snap = await tx.get(ref), current = snap.exists ? parseBankData(Lease, snap.data()) : null
          const now = this.clock()
          if (current && ((current.owner && current.leaseUntil > now) || current.nextAllowedAt > now)) {
            const available = Math.max(current.owner ? current.leaseUntil : 0, current.nextAllowedAt)
            return { wait: Math.min(1000, Math.max(1, available - now)) }
          }
          const nextFence = parseBankData(counter, (current?.fence ?? 0) + 1)
          const until = parseBankData(counter, now + LEASE_MS)
          const value = { owner, fence: nextFence, leaseUntil: until, nextAllowedAt: current?.nextAllowedAt ?? 0 }
          if (current) tx.set(ref, value); else tx.create(ref, value)
          return { fence: nextFence, leaseUntil: until }
        })
        if (attempt.fence !== undefined && attempt.leaseUntil !== undefined) {
          fence = attempt.fence; leaseUntil = attempt.leaseUntil; break
        }
        if (this.clock() - started >= MAX_WAIT_MS) throw new BankReadFailure('rate_limited', GAP_MS)
        await this.wait(attempt.wait ?? 1000, signal)
      }
      if (fence === undefined || leaseUntil === undefined) throw new BankReadFailure('transient')
      // A late callback after a stalled process must not send on an expired slot.
      try {
        if (signal.aborted || this.clock() + 20_000 >= leaseUntil) throw new BankError('bank_run_cancelled')
        return await send(leaseUntil)
      } finally {
        // A failure to persist the cooldown is a failure, never a successful send.
        await this.db.runTransaction(async tx => {
          const value = parseBankData(Lease, (await tx.get(ref)).data())
          if (value.owner !== owner || value.fence !== fence || value.leaseUntil <= this.clock()) {
            throw new BankReadFailure('transient')
          }
          tx.update(ref, { owner: null, leaseUntil: 0, nextAllowedAt: parseBankData(counter, this.clock() + GAP_MS) })
        })
      }
    } catch (error) {
      if (error instanceof BankReadFailure || (error instanceof BankError && error.code === 'bank_run_cancelled')) throw error
      throw new BankReadFailure('transient')
    }
  }
}
