import { z } from 'zod'
import type { CallableRequest } from 'firebase-functions/v2/https'
import type { Firestore, Transaction } from 'firebase-admin/firestore'
import { requireAuth, requireVerifiedEmail, requireActiveMember, requireRole,
  requireNotInMaintenanceMode, validateRequest } from '../lib/authz'
import { AppError } from '../lib/errors'
import { FirestoreDocumentIdSchema } from '../schemas/invitation'
import { BankPolicySchema } from './contracts'
import { BankError } from './errors'

const RequestSchema = z.object({ companyId: FirestoreDocumentIdSchema }).strict()
export type BankAction = 'view' | 'manage' | 'sync' | 'disconnect'

/** Existing canonical authz helpers remain the ONLY role/membership authority.
 * This is a preflight snapshot, NOT a reusable authorization credential.
 * Future mutations must use this gate in their own transaction and also read
 * the connection/consent/job fence in that transaction (BANK-002).
 */
export async function authorizeBankRequest(
  db: Firestore, request: CallableRequest<unknown>, action: BankAction, txn?: Transaction,
): Promise<{ companyId: string; uid: string }> {
  const auth = requireAuth(request)
  requireVerifiedEmail(auth)
  const { companyId } = validateRequest(RequestSchema, request.data)
  if (!FirestoreDocumentIdSchema.safeParse(auth.uid).success) throw new AppError('membership_data_error')
  if (!['view', 'manage', 'sync', 'disconnect'].includes(action)) throw new BankError('bank_access_denied')
  if (action !== 'view' && !txn) throw new BankError('bank_access_denied')
  const member = await requireActiveMember(db, companyId, auth.uid, txn)
  requireRole(member, action === 'view' ? ['viewer', 'accountant', 'admin']
    : action === 'sync' ? ['accountant', 'admin'] : ['admin'])
  if (action !== 'view') await requireNotInMaintenanceMode(db, txn)

  try {
    const companyRef = db.collection('companies').doc(companyId)
    const company = txn ? await txn.get(companyRef) : await companyRef.get()
    if (!company.exists) throw new BankError('bank_access_denied')
  } catch { throw new BankError('bank_access_denied') }

  // Disconnect must remain possible even when the module is off or its flag
  // cannot be read. Permission and maintenance checks above still apply.
  if (action !== 'disconnect') {
    try {
      const ref = db.collection('system').doc('bankIntegrations')
      const snap = txn ? await txn.get(ref) : await ref.get()
      const policy = BankPolicySchema.safeParse(snap.exists ? snap.data() : undefined)
      if (!policy.success || policy.data.enabled !== true) throw new BankError('bank_module_disabled')
    } catch { throw new BankError('bank_module_disabled') }
  }
  return { companyId, uid: auth.uid }
}
