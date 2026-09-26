import type { BankAccount, BankOperation, Money, StatementRequest } from './contracts'
import { BankError } from './errors'

export interface ApiBankAdapter {
  readonly bankId: string
  readonly capabilities: {
    readonly channel: 'api'
    readonly evidence: 'synthetic_tested' | 'bank_sandbox_tested' | 'live_verified'
    readonly readOnly: true
    readonly balances: boolean
    readonly incremental: boolean
    readonly authorization: 'synthetic' | 'oauth' | 'server_token'
    readonly revoke: 'api' | 'bank_portal' | 'unsupported'
  }
  // Return unknown so network responses always undergo runtime validation.
  listAccounts(companyId: string, signal: AbortSignal): Promise<unknown>
  readStatementPage(request: StatementRequest, cursor: string | null, signal: AbortSignal): Promise<unknown>
}

export interface BalanceSnapshot {
  companyId: string
  accountKey: string
  money: Money
  asOf: string
  kind: 'opening' | 'closing' | 'available'
}

// Persistent implementation and atomic lease/checkpoint transitions: BANK-002.
export interface SyncJob {
  companyId: string
  connectionId: string
  accountKey: string
  jobId: string
  window: { from: string; through: string }
  cursor: string | null
  status: 'queued' | 'running' | 'retry_wait' | 'completed' | 'cancelled' | 'failed'
  policyGeneration: number
  connectionGeneration: number
  fence: number
  leaseExpiresAt: string | null
  nextAttemptAt: string | null
  attempts: number
}

export interface FileStatementAdapter {
  readonly channel: 'file'
  readonly formatId: string
  parse(bytes: Uint8Array, account: BankAccount): Promise<readonly BankOperation[]>
}

export interface EmailStatementAdapter {
  readonly channel: 'email'
  // A separate ingress verifies signed provider delivery, anti-replay, sender,
  // recipient mapping and account ownership BEFORE granting a trusted receipt.
  ingestVerifiedReceipt(companyId: string, receiptId: string): Promise<void>
}

export interface PublicationEnvelope {
  version: 1
  companyId: string
  operationKey: string
  sourceRevision: number
  expectedLedgerRevision: number | null
  connectionGeneration: number
  policyGeneration: number
  idempotencyKey: string
  bankData: BankOperation
}
export type PublicationResult =
  | { status: 'applied' | 'already_applied'; receiptId: string; ledgerId: string }
  | { status: 'needs_review' | 'blocked_closed_period' | 'rejected' }
export interface LedgerPublicationPort {
  publish(envelope: PublicationEnvelope): Promise<PublicationResult>
}

/** The only implementation until ARCH's safe, atomic write path is available. */
export const unavailableLedgerPublisher: LedgerPublicationPort = {
  async publish() { throw new BankError('publication_unavailable') },
}

export interface BankLifecycleEvent {
  companyId: string
  connectionId?: string
  eventId: string
  generation: number
  occurredAt: string
  kind: 'connection_disabled' | 'consent_revoked' | 'company_deleting'
}

// No credential values or financial payloads can be carried by this event.
export interface BankAuditEvent {
  companyId: string
  jobId: string
  kind: 'sync_started' | 'sync_completed' | 'sync_failed' | 'sync_cancelled'
  operationCount: number
}
