import { z } from 'zod'
import { FirestoreDocumentIdSchema } from '../schemas/invitation'
import { BankError } from './errors'

export const BankIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/)
const ExternalKeySchema = z.string().min(1).max(256)
export const CurrencySchema = z.enum(['RUB', 'USD', 'EUR', 'CNY', 'JPY', 'KWD'])
export const MoneySchema = z.object({
  currency: CurrencySchema,
  minorUnits: z.string().max(31).regex(/^(0|-?[1-9]\d{0,29})$/),
}).strict()
export type Money = z.infer<typeof MoneySchema>

// Preserve the bank's calendar date. Never convert a local midnight to UTC.
export const BankDateSchema = z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/)
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  })

export const SourceSchema = z.object({
  channel: z.enum(['api', 'file', 'email']),
  deliveryId: ExternalKeySchema,
}).strict()
export const CounterpartySchema = z.object({
  name: z.string().max(512).optional(),
  taxId: z.string().max(32).optional(),
  registrationCode: z.string().max(32).optional(),
  accountNumber: z.string().max(64).optional(),
  bankCode: z.string().max(32).optional(),
}).strict()

export const BankOperationSchema = z.object({
  companyId: FirestoreDocumentIdSchema,
  bankId: BankIdSchema,
  accountKey: ExternalKeySchema,
  providerOperationId: ExternalKeySchema.optional(),
  bookingDate: BankDateSchema,
  valueDate: BankDateSchema.optional(),
  money: MoneySchema,
  status: z.enum(['pending', 'booked', 'reversed']),
  purpose: z.string().max(4096),
  counterparty: CounterpartySchema,
  source: SourceSchema,
}).strict()
export type BankOperation = z.infer<typeof BankOperationSchema>

export const BankAccountSchema = z.object({
  companyId: FirestoreDocumentIdSchema, bankId: BankIdSchema,
  // Stable across connection generations. Adapter assigns it from verified
  // account identity, never a connection ID or user-supplied display name.
  accountKey: ExternalKeySchema,
  currency: CurrencySchema,
  maskedNumber: z.string().max(64),
  ledgerAccountId: FirestoreDocumentIdSchema.optional(),
}).strict()
export type BankAccount = z.infer<typeof BankAccountSchema>

export const StatementRequestSchema = z.object({
  companyId: FirestoreDocumentIdSchema, bankId: BankIdSchema,
  accountKey: ExternalKeySchema, currency: CurrencySchema,
  from: BankDateSchema, through: BankDateSchema,
}).strict().refine(value => value.from <= value.through)
export type StatementRequest = z.infer<typeof StatementRequestSchema>

export const StatementPageSchema = z.object({
  operations: z.array(BankOperationSchema).max(1000),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict()
export type StatementPage = z.infer<typeof StatementPageSchema>

export const BankPolicySchema = z.object({
  enabled: z.boolean(), generation: z.number().int().nonnegative().safe(),
}).strict()

export const ConnectionSchema = z.object({
  companyId: FirestoreDocumentIdSchema, id: FirestoreDocumentIdSchema,
  bankId: BankIdSchema, channel: z.enum(['api', 'file', 'email']),
  status: z.enum(['awaiting_authorization', 'selecting_accounts', 'active',
    'syncing', 'requires_reauth', 'error', 'disabled', 'consent_revoked']),
  generation: z.number().int().nonnegative().safe(),
  consent: z.object({
    status: z.enum(['pending', 'active', 'revoked', 'expired']),
    grantedBy: FirestoreDocumentIdSchema,
    expiresAt: z.iso.datetime().optional(),
    permissions: z.array(z.enum(['accounts:read', 'balances:read', 'statements:read'])).max(3),
  }).strict(),
}).strict()
export type BankConnection = z.infer<typeof ConnectionSchema>

// Useful for adapters and private storage boundaries. Zod details never escape.
export function parseBankData<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new BankError('invalid_bank_data')
  return parsed.data
}
