import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FirestoreDocumentIdSchema as Id } from '../../schemas/invitation'
import { BankAccountSchema, BankOperationSchema, StatementRequestSchema } from '../contracts'

export const counter = z.number().int().nonnegative().safe()
export const TenantSchema = z.object({ generation: counter, state: z.enum(['active', 'deleting']) }).strict()
export const BindingSchema = z.object({ connectionId: Id, account: BankAccountSchema }).strict()
export const JobSchema = z.object({
  companyId: Id, connectionId: Id, actorUid: Id, request: StatementRequestSchema,
  channel: z.enum(['api', 'file', 'email']), tenantGeneration: counter,
  policyGeneration: counter, connectionGeneration: counter,
  status: z.enum(['queued', 'running', 'retry_wait', 'completed', 'failed']),
  cursor: z.string().min(1).max(2048).nullable(), pageIndex: counter,
  fence: counter, owner: z.string().min(1).max(200).nullable(), leaseUntil: counter,
  nextAttemptAt: counter, attempts: counter, failures: counter,
  lastError: z.enum(['transient', 'rate_limited', 'reauth', 'consent_revoked', 'permanent']).nullable(),
}).strict()
export type StoredJob = z.infer<typeof JobSchema>
export const RowSchema = z.object({
  original: BankOperationSchema, revision: counter,
  disposition: z.enum(['staged', 'needs_review']),
}).strict()
export type StoredRow = z.infer<typeof RowSchema>
export const BucketSchema = z.object({ hasWeak: z.boolean() }).strict()
export const ReceiptSchema = z.object({ digest: z.string().length(64), owner: z.string(), fence: counter }).strict()
export const JobRefSchema = z.object({ companyId: Id, jobId: Id }).strict()
export const LeaseSchema = JobRefSchema.extend({ owner: Id, fence: counter }).strict()
export type JobRef = z.infer<typeof JobRefSchema>
export type Lease = z.infer<typeof LeaseSchema>
export const EnqueueSchema = z.object({ companyId: Id, connectionId: Id, requestId: Id,
  request: StatementRequestSchema }).strict()
export const hash = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
export const bindingId = (connectionId: string, accountKey: string) => hash('binding-v1', connectionId, accountKey)
export const bucketId = (op: z.infer<typeof BankOperationSchema>) => hash('match-v1', op.companyId,
  op.bankId, op.accountKey, op.bookingDate, op.money.currency, op.money.minorUnits)
