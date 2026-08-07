// Cloud Functions entry point — SEC-003.
//
// This file exports exactly one callable: a minimal READ-ONLY
// authorization probe. It exists to prove the real server authorization
// pipeline (requireAuth -> requireVerifiedEmail -> requireActiveMember ->
// requireRole) actually works end-to-end through the Functions Emulator —
// see functions/test/emulator/authzProbe.test.ts.
//
// No privileged MUTATING Cloud Function is implemented here.
// FUNCTIONS_IMPLEMENTATION_APPROVED covered only this authorization
// foundation for SEC-003; server-side company creation, membership
// mutation, and invitations are SEC-004/SEC-005/SEC-006.
import { onCall } from 'firebase-functions/v2/https'
import { db } from './lib/admin'
import { requireAuth, requireVerifiedEmail, requireActiveMember, requireRole, validateRequest } from './lib/authz'
import { toSafeHttpsError } from './lib/errors'
import { AuthzProbeRequestSchema, type AuthzProbeResponse } from './schemas/auth'

export const authzProbe = onCall(async request => {
  try {
    const auth = requireAuth(request)
    requireVerifiedEmail(auth)
    const { companyId } = validateRequest(AuthzProbeRequestSchema, request.data)
    const membership = await requireActiveMember(db, companyId, auth.uid)
    requireRole(membership, ['admin'])

    // Read-only, non-privileged response — proves the pipeline succeeded
    // without exposing membership content, personal data, or anything
    // company-specific.
    const response: AuthzProbeResponse = { ok: true }
    return response
  } catch (err) {
    throw toSafeHttpsError(err)
  }
})
