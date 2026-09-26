import { describe, expect, it } from 'vitest'
import { BindingSchema, JobRefSchema, LeaseSchema, ReceiptSchema, TenantSchema, bucketId, bindingId } from '../../../src/banks/storage/schema'
import { operation } from './fixtures/statement'

describe('BANK-002 persisted boundaries', () => {
  it.each([{ companyId: '../company', jobId: 'job' }, { companyId: 'company', jobId: 'a/b' },
    { companyId: 'company', jobId: 'job', uid: 'forged' }])('rejects invalid job paths/extra identity %#', raw => {
    expect(JobRefSchema.safeParse(raw).success).toBe(false)
  })
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects unsafe fence %s', fence => {
    expect(LeaseSchema.safeParse({ companyId: 'company', jobId: 'job', owner: 'worker', fence }).success).toBe(false)
  })
  it('rejects corrupt tenant/receipt/account documents', () => {
    expect(TenantSchema.safeParse({ state: 'active', generation: 0, enabled: true }).success).toBe(false)
    expect(ReceiptSchema.safeParse({ digest: 'short', owner: 'worker', fence: 1 }).success).toBe(false)
    expect(BindingSchema.safeParse({ connectionId: 'connection' }).success).toBe(false)
  })
  it('weak match bucket is company/account scoped but channel independent', () => {
    const a = operation()
    expect(bucketId(a)).toBe(bucketId({ ...a, source: { channel: 'file', deliveryId: 'other' } }))
    expect(bucketId(a)).not.toBe(bucketId({ ...a, companyId: 'company-b' }))
    expect(bucketId(a)).not.toBe(bucketId({ ...a, accountKey: 'account-b' }))
    expect(bindingId('a', 'b/c')).not.toBe(bindingId('a/b', 'c'))
  })
})
