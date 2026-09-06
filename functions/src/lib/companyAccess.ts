import type { CallableRequest } from 'firebase-functions/v2/https'
import type { Firestore } from 'firebase-admin/firestore'
import { requireAuth, requireVerifiedEmail, requireActiveMember, requireRole, validateRequest } from './authz'
import { AppError } from './errors'
import { FirestoreDocumentIdSchema } from '../schemas/invitation'
import { GetCompanyAccessRequestSchema, type GetCompanyAccessResponse } from '../schemas/companyAccess'

// SEC-006 Stage 7: confirm current membership before entering the financial
// application. This is a read-only snapshot, never an authorization credential
// for subsequent requests. It does not replace Rules or the SEC-008/011 work.
export async function readCompanyAccess(
  db: Firestore,
  request: CallableRequest<unknown>,
): Promise<GetCompanyAccessResponse> {
  const auth = requireAuth(request)
  requireVerifiedEmail(auth)
  const { companyId } = validateRequest(GetCompanyAccessRequestSchema, request.data)
  if (!FirestoreDocumentIdSchema.safeParse(auth.uid).success) throw new AppError('membership_data_error')
  const membership = await requireActiveMember(db, companyId, auth.uid)
  requireRole(membership, ['viewer', 'accountant', 'admin'])
  return { companyId, uid: auth.uid, role: membership.role }
}
