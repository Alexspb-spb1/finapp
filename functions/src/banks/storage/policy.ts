import type { Firestore } from 'firebase-admin/firestore'
import { BankPolicySchema, parseBankData } from '../contracts'
import { counter } from './schema'

/** Operator-only helper, NOT a callable. Every transition increments generation,
 * including off -> on, so old jobs cannot regain authority. No invocation at startup.
 * Operators must use this protocol rather than manually toggling the enabled field.
 */
export async function setBankModuleEnabled(db: Firestore, enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') throw new TypeError('invalid_bank_policy')
  await db.runTransaction(async tx => {
    const ref = db.doc('system/bankIntegrations')
    const doc = await tx.get(ref)
    const previous = doc.exists ? parseBankData(BankPolicySchema, doc.data()) : { enabled: false, generation: 0 }
    tx.set(ref, { enabled, generation: parseBankData(counter, previous.generation + 1) })
  })
}
