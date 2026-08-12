import { describe, it, expect } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'
import { runBootstrapIdempotent } from '../../src/lib/bootstrapIdempotency'

// These cover only the synchronous key-validation guard, which runs BEFORE
// any Firestore access (see bootstrapIdempotency.ts) — a fake db that
// throws on first use is enough to prove no Firestore call happens for an
// invalid key, without needing the emulator.
function dbThatMustNotBeTouched(): Firestore {
  return new Proxy(
    {},
    { get: () => { throw new Error('Firestore must not be touched for an invalid idempotency key') } },
  ) as unknown as Firestore
}

describe('runBootstrapIdempotent — key validation', () => {
  it('rejects an empty idempotency key without touching Firestore', async () => {
    await expect(
      runBootstrapIdempotent({
        db: dbThatMustNotBeTouched(),
        uid: 'uid_1',
        idempotencyKey: '',
        payloadForFingerprint: {},
        run: async () => ({ companyId: 'should_not_run' }),
      }),
    ).rejects.toEqual(expect.objectContaining({ appCode: 'invalid_request' }))
  })

  it('rejects an excessively long idempotency key without touching Firestore', async () => {
    await expect(
      runBootstrapIdempotent({
        db: dbThatMustNotBeTouched(),
        uid: 'uid_1',
        idempotencyKey: 'x'.repeat(500),
        payloadForFingerprint: {},
        run: async () => ({ companyId: 'should_not_run' }),
      }),
    ).rejects.toEqual(expect.objectContaining({ appCode: 'invalid_request' }))
  })
})
