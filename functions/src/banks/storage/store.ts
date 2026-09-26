import { z } from 'zod'
import type { Firestore, Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { FirestoreDocumentIdSchema as Id } from '../../schemas/invitation'
import { requireActiveMember, requireRole, requireNotInMaintenanceMode } from '../../lib/authz'
import { authorizeBankRequest } from '../access'
import { BankAccountSchema, BankPolicySchema, ConnectionSchema, StatementPageSchema,
  parseBankData, type BankOperation } from '../contracts'
import { BankError } from '../errors'
import { operationKey, classifyOperation } from '../identity'
import { BindingSchema, BucketSchema, EnqueueSchema, JobRefSchema, JobSchema, LeaseSchema,
  ReceiptSchema, RowSchema, TenantSchema, bindingId, bucketId, counter, hash,
  type JobRef, type Lease, type StoredJob, type StoredRow } from './schema'

const GrantSchema = z.object({ connection: ConnectionSchema,
  accounts: z.array(BankAccountSchema).min(1).max(50) }).strict()
const DisconnectSchema = z.object({ companyId: Id, connectionId: Id }).strict()
const PageTokenSchema = z.object({ pageIndex: counter,
  cursor: z.string().min(1).max(2048).nullable() }).strict()
const ObservationSchema = z.object({ operationKey: z.string().length(64), proposal: StatementPageSchema.shape.operations.element }).strict()
const FailureSchema = z.enum(['transient', 'rate_limited', 'reauth', 'consent_revoked', 'permanent'])
export type Failure = z.infer<typeof FailureSchema>
const stop = (): never => { throw new BankError('bank_run_cancelled') }
const invalid = (): never => { throw new BankError('invalid_bank_data') }
const increment = (value: number) => parseBankData(counter, value + 1)

/** Private Admin-SDK repository. No callable, scheduler, credential or ledger writer.
 * All input grants are trusted server adapter output, never browser assertions.
 */
export class BankStore {
  constructor(private readonly db: Firestore, private readonly clock: () => number = Date.now) {}
  private now() { return parseBankData(counter, this.clock()) }
  private root(companyId: string) { return this.db.doc(`bankCompanies/${parseBankData(Id, companyId)}`) }
  private jobRef(ref: JobRef) { return this.root(ref.companyId).collection('jobs').doc(ref.jobId) }
  private async readJob(tx: Transaction, ref: JobRef) {
    const job = parseBankData(JobSchema, (await tx.get(this.jobRef(ref))).data())
    if (job.companyId !== ref.companyId || job.request.companyId !== ref.companyId) stop()
    return job
  }
  private async guard(tx: Transaction, job: StoredJob) {
    await requireNotInMaintenanceMode(this.db, tx)
    requireRole(await requireActiveMember(this.db, job.companyId, job.actorUid, tx), ['admin', 'accountant'])
    const root = this.root(job.companyId)
    const [company, tenantDoc, policyDoc, connectionDoc, accountDoc] = await tx.getAll(
      this.db.doc(`companies/${job.companyId}`), root, this.db.doc('system/bankIntegrations'),
      root.collection('connections').doc(job.connectionId),
      root.collection('bindings').doc(bindingId(job.connectionId, job.request.accountKey)))
    const tenant = parseBankData(TenantSchema, tenantDoc.data())
    const policy = parseBankData(BankPolicySchema, policyDoc.data())
    const connection = parseBankData(ConnectionSchema, connectionDoc.data())
    if (!company.exists || tenant.state !== 'active' || tenant.generation !== job.tenantGeneration
      || !policy.enabled || policy.generation !== job.policyGeneration
      || connection.companyId !== job.companyId || connection.id !== job.connectionId
      || connection.bankId !== job.request.bankId || connection.channel !== job.channel
      || connection.generation !== job.connectionGeneration || connection.status !== 'active'
      || connection.consent.status !== 'active'
      || !connection.consent.permissions.includes('statements:read')
      || (connection.consent.expiresAt && Date.parse(connection.consent.expiresAt) <= this.now())) stop()
    const binding = parseBankData(BindingSchema, accountDoc.data())
    if (binding.connectionId !== job.connectionId || binding.account.companyId !== job.companyId
      || binding.account.bankId !== job.request.bankId || binding.account.accountKey !== job.request.accountKey
      || binding.account.currency !== job.request.currency) stop()
    requireRole(await requireActiveMember(this.db, job.companyId, connection.consent.grantedBy, tx), ['admin'])
    return connection
  }
  private assertLease(job: StoredJob, lease: Lease) {
    if (job.status !== 'running' || job.owner !== lease.owner || job.fence !== lease.fence
      || job.leaseUntil <= this.now()) stop()
  }

  /** BANK-003 must verify bank consent/account ownership BEFORE calling this method.
   * Server overwrites grantedBy/generation; ledger mappings cannot be supplied here.
   */
  async installVerifiedGrant(request: CallableRequest<unknown>, rawGrant: unknown): Promise<void> {
    const grant = parseBankData(GrantSchema, rawGrant)
    await this.db.runTransaction(async tx => {
      const { companyId, uid } = await authorizeBankRequest(this.db, request, 'manage', tx)
      const root = this.root(companyId)
      const connRef = root.collection('connections').doc(grant.connection.id)
      const [tenantDoc, oldDoc] = await tx.getAll(root, connRef)
      const tenant = tenantDoc.exists ? parseBankData(TenantSchema, tenantDoc.data()) : { generation: 0, state: 'active' as const }
      const old = oldDoc.exists ? parseBankData(ConnectionSchema, oldDoc.data()) : null
      if (tenant.state !== 'active' || grant.connection.companyId !== companyId
        || grant.connection.status !== 'active' || grant.connection.consent.status !== 'active'
        || !grant.connection.consent.permissions.includes('statements:read')
        || (grant.connection.consent.expiresAt && Date.parse(grant.connection.consent.expiresAt) <= this.now())
        || (old && (old.bankId !== grant.connection.bankId || old.companyId !== companyId))
        || new Set(grant.accounts.map(a => a.accountKey)).size !== grant.accounts.length) invalid()
      for (const a of grant.accounts) {
        if (a.companyId !== companyId || a.bankId !== grant.connection.bankId || a.ledgerAccountId) invalid()
      }
      // Reauthorization replaces the allowed account set; stale bindings cannot survive.
      const previousBindings = await tx.get(root.collection('bindings').where('connectionId', '==', grant.connection.id))
      if (previousBindings.size > 50) invalid()
      tx.set(root, tenant)
      tx.set(connRef, { ...grant.connection, generation: old ? increment(old.generation) : 0,
        consent: { ...grant.connection.consent, grantedBy: uid } })
      for (const doc of previousBindings.docs) tx.delete(doc.ref)
      for (const account of grant.accounts) tx.set(root.collection('bindings').doc(bindingId(grant.connection.id, account.accountKey)),
        { connectionId: grant.connection.id, account })
    })
  }

  async enqueue(request: CallableRequest<unknown>): Promise<JobRef> {
    const input = parseBankData(EnqueueSchema, request.data)
    const ref = { companyId: input.companyId, jobId: hash('job-v1', input.companyId, input.requestId) }
    await this.db.runTransaction(async tx => {
      const { uid } = await authorizeBankRequest(this.db, { ...request, data: { companyId: input.companyId } }, 'sync', tx)
      const root = this.root(input.companyId)
      const [tenantDoc, policyDoc, connectionDoc, oldDoc] = await tx.getAll(root,
        this.db.doc('system/bankIntegrations'), root.collection('connections').doc(input.connectionId), this.jobRef(ref))
      const tenant = parseBankData(TenantSchema, tenantDoc.data())
      const policy = parseBankData(BankPolicySchema, policyDoc.data())
      const connection = parseBankData(ConnectionSchema, connectionDoc.data())
      const job: StoredJob = { companyId: input.companyId, connectionId: input.connectionId,
        actorUid: uid, request: input.request, channel: connection.channel,
        tenantGeneration: tenant.generation, policyGeneration: policy.generation,
        connectionGeneration: connection.generation, status: 'queued', cursor: null,
        pageIndex: 0, fence: 0, owner: null, leaseUntil: 0, nextAttemptAt: 0,
        attempts: 0, failures: 0, lastError: null }
      if (input.request.companyId !== input.companyId) invalid()
      await this.guard(tx, job)
      if (oldDoc.exists) {
        const old = parseBankData(JobSchema, oldDoc.data())
        if (old.actorUid !== uid || old.companyId !== input.companyId || old.connectionId !== input.connectionId
          || hash(old.request) !== hash(input.request)) invalid()
        return
      }
      tx.create(this.jobRef(ref), job)
    })
    return ref
  }

  async claim(rawRef: JobRef, rawOwner: string): Promise<Lease | null> {
    const ref = parseBankData(JobRefSchema, rawRef)
    const owner = parseBankData(Id, rawOwner)
    return this.db.runTransaction(async tx => {
      const job = await this.readJob(tx, ref)
      await this.guard(tx, job)
      if (['completed', 'failed'].includes(job.status) || job.nextAttemptAt > this.now()
        || (job.status === 'running' && job.leaseUntil > this.now())) return null
      const fence = increment(job.fence)
      tx.update(this.jobRef(ref), { status: 'running', owner, fence,
        leaseUntil: this.now() + 60_000, attempts: increment(job.attempts) })
      return { ...ref, owner, fence }
    })
  }

  async readWork(rawLease: Lease): Promise<StoredJob> {
    const lease = parseBankData(LeaseSchema, rawLease)
    return this.db.runTransaction(async tx => {
      const job = await this.readJob(tx, lease)
      await this.guard(tx, job)
      this.assertLease(job, lease)
      return job
    })
  }

  async commitPage(rawLease: Lease, rawToken: { pageIndex: number; cursor: string | null }, rawPage: unknown): Promise<'committed' | 'replayed'> {
    const lease = parseBankData(LeaseSchema, rawLease)
    const token = parseBankData(PageTokenSchema, rawToken)
    const page = parseBankData(StatementPageSchema, rawPage)
    // Bound transaction document/write count and serialized size, not only provider page count.
    if (page.operations.length > 100 || Buffer.byteLength(JSON.stringify(page)) > 512 * 1024) invalid()
    const digest = hash('page-v1', token, page)
    return this.db.runTransaction(async tx => {
      const job = await this.readJob(tx, lease)
      const connection = await this.guard(tx, job)
      const root = this.root(lease.companyId)
      const receiptRef = this.jobRef(lease).collection('receipts').doc(String(token.pageIndex))
      const receiptDoc = await tx.get(receiptRef)
      if (receiptDoc.exists) {
        const receipt = parseBankData(ReceiptSchema, receiptDoc.data())
        if (receipt.digest !== digest || receipt.owner !== lease.owner || receipt.fence !== lease.fence) stop()
        return 'replayed' as const
      }
      this.assertLease(job, lease)
      if (job.pageIndex !== token.pageIndex || job.cursor !== token.cursor || job.pageIndex >= 1000) stop()
      for (const op of page.operations) {
        if (op.companyId !== lease.companyId || op.bankId !== job.request.bankId
          || op.accountKey !== job.request.accountKey || op.money.currency !== job.request.currency
          || op.bookingDate < job.request.from || op.bookingDate > job.request.through
          || op.source.channel !== job.channel) invalid()
      }
      const cursorRef = page.nextCursor === null ? null : this.jobRef(lease).collection('cursors').doc(hash(page.nextCursor))
      if (cursorRef && (page.nextCursor === job.cursor || (await tx.get(cursorRef)).exists)) {
        throw new BankError('bank_pagination_invalid')
      }
      if (page.nextCursor !== null && job.pageIndex === 999) throw new BankError('bank_preview_limit')
      const keys = page.operations.map((op, i) => operationKey(op) ?? hash('weak-v1', lease.jobId, token.pageIndex, i))
      const rowRefs = [...new Set(keys)].map(key => root.collection('operations').doc(key))
      const bucketRefs = [...new Set(page.operations.map(bucketId))].map(key => root.collection('matchBuckets').doc(key))
      const proposalIds = page.operations.map((op, i) => hash('correction-v1', keys[i], { ...op, source: null }))
      const proposalRefs = [...new Set(proposalIds)].map(id => root.collection('observations').doc(id))
      const knownProposals = new Set<string>()
      if (proposalRefs.length) for (const doc of await tx.getAll(...proposalRefs)) {
        if (doc.exists) {
          const observation = parseBankData(ObservationSchema, doc.data())
          if (doc.id !== hash('correction-v1', observation.operationKey, { ...observation.proposal, source: null })) invalid()
          knownProposals.add(doc.id)
        }
      }
      const rows = new Map<string, StoredRow>()
      const buckets = new Map<string, boolean>()
      if (rowRefs.length) for (const doc of await tx.getAll(...rowRefs)) {
        if (doc.exists) rows.set(doc.id, parseBankData(RowSchema, doc.data()))
      }
      if (bucketRefs.length) for (const doc of await tx.getAll(...bucketRefs)) {
        buckets.set(doc.id, doc.exists ? parseBankData(BucketSchema, doc.data()).hasWeak : false)
      }
      for (const op of page.operations) if (!operationKey(op)) buckets.set(bucketId(op), true)
      const intents = new Map<string, { operationKey: string; sourceRevision: number; state: 'blocked'; reason: 'needs_review' | 'publication_unavailable' }>()
      const observations: { id: string; operationKey: string; proposal: BankOperation }[] = []
      for (const [i, op] of page.operations.entries()) {
        const key = keys[i]
        const old = rows.get(key)
        if (old) {
          if (operationKey(old.original) !== operationKey(op) || old.original.companyId !== lease.companyId) invalid()
          if (classifyOperation(op, [old.original]).kind === 'correction' && !knownProposals.has(proposalIds[i])) {
            observations.push({ id: proposalIds[i], operationKey: key, proposal: op })
            knownProposals.add(proposalIds[i])
            const revision = increment(old.revision)
            rows.set(key, { ...old, revision, disposition: 'needs_review' })
            intents.set(hash(key, revision), { operationKey: key, sourceRevision: revision, state: 'blocked', reason: 'needs_review' })
          }
        } else {
          const needsReview = !operationKey(op) || buckets.get(bucketId(op)) || op.status !== 'booked'
          rows.set(key, { original: op, revision: 0, disposition: needsReview ? 'needs_review' : 'staged' })
          intents.set(hash(key, 0), { operationKey: key, sourceRevision: 0, state: 'blocked',
            reason: needsReview ? 'needs_review' : 'publication_unavailable' })
        }
      }
      // Recheck wall-clock constraints after potentially slow transaction reads.
      this.assertLease(job, lease)
      if (connection.consent.expiresAt && Date.parse(connection.consent.expiresAt) <= this.now()) stop()
      for (const [id, row] of rows) tx.set(root.collection('operations').doc(id), row)
      for (const [id, hasWeak] of buckets) tx.set(root.collection('matchBuckets').doc(id), { hasWeak })
      for (const { id, ...observation } of observations) tx.create(root.collection('observations').doc(id), observation)
      for (const [id, intent] of intents) tx.create(root.collection('outbox').doc(id), { ...intent,
        companyId: job.companyId, jobId: lease.jobId, actorUid: job.actorUid,
        connectionId: job.connectionId, connectionGeneration: job.connectionGeneration,
        policyGeneration: job.policyGeneration, tenantGeneration: job.tenantGeneration })
      if (cursorRef) tx.create(cursorRef, { seen: true })
      tx.create(receiptRef, { digest, owner: lease.owner, fence: lease.fence })
      tx.update(this.jobRef(lease), { status: page.nextCursor === null ? 'completed' : 'queued',
        cursor: page.nextCursor, pageIndex: increment(job.pageIndex), owner: null, leaseUntil: 0,
        failures: 0, lastError: null, nextAttemptAt: 0 })
      return 'committed' as const
    })
  }

  async fail(rawLease: Lease, rawFailure: Failure, retryAfterMs = 0): Promise<void> {
    const lease = parseBankData(LeaseSchema, rawLease)
    const failure = parseBankData(FailureSchema, rawFailure)
    parseBankData(z.number().int().min(0).max(86_400_000), retryAfterMs)
    await this.db.runTransaction(async tx => {
      const job = await this.readJob(tx, lease)
      const connection = await this.guard(tx, job)
      this.assertLease(job, lease)
      const failures = increment(job.failures)
      const retry = ['transient', 'rate_limited'].includes(failure) && failures < 8
      // Stable jitter makes Firestore transaction retries deterministic.
      const jitter = Number.parseInt(hash(lease.jobId, failures).slice(0, 4), 16) % 1000
      tx.update(this.jobRef(lease), { status: retry ? 'retry_wait' : 'failed', owner: null,
        leaseUntil: 0, failures, lastError: failure,
        nextAttemptAt: retry ? this.now() + Math.max(retryAfterMs, Math.min(300_000, 1000 * 2 ** (failures - 1)) + jitter) : 0 })
      if (failure === 'reauth' || failure === 'consent_revoked') {
        tx.update(this.root(lease.companyId).collection('connections').doc(job.connectionId), {
          status: failure === 'reauth' ? 'requires_reauth' : 'consent_revoked',
          generation: increment(connection.generation),
          ...(failure === 'consent_revoked' ? { consent: { ...connection.consent, status: 'revoked' } } : {}),
        })
      }
    })
  }

  async disconnect(request: CallableRequest<unknown>): Promise<void> {
    const input = parseBankData(DisconnectSchema, request.data)
    await this.db.runTransaction(async tx => {
      await authorizeBankRequest(this.db, { ...request, data: { companyId: input.companyId } }, 'disconnect', tx)
      const ref = this.root(input.companyId).collection('connections').doc(input.connectionId)
      const connection = parseBankData(ConnectionSchema, (await tx.get(ref)).data())
      if (connection.companyId !== input.companyId || connection.id !== input.connectionId) stop()
      tx.update(ref, { status: 'disabled', generation: increment(connection.generation) })
    })
  }

  /** Hook to be called BEFORE company deletion. Does not delete any company data. */
  async markCompanyDeleting(request: CallableRequest<unknown>): Promise<void> {
    await this.db.runTransaction(async tx => {
      const { companyId } = await authorizeBankRequest(this.db, request, 'disconnect', tx)
      const ref = this.root(companyId)
      const doc = await tx.get(ref)
      const current = doc.exists ? parseBankData(TenantSchema, doc.data()) : { generation: 0 }
      tx.set(ref, { state: 'deleting', generation: increment(current.generation) })
    })
  }
}
