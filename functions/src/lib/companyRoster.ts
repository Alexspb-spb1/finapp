// Canonical company roster — SEC-007 R1.
//
// The single source of "who belongs to this company" is
// companies/{companyId}/members. This module joins that to the display fields
// in users/{uid} and returns nothing else.
//
// Why this exists on the server at all: a member of a SECONDARY company has
// `users/{uid}.companyId` naming their PRIMARY company, and the canonical
// Rules only let a caller read a profile for a company they are both members
// of. A browser therefore cannot join roster to profile without either
// weakening those Rules or denormalising email into the membership document.
// A read-only callable is the smallest correct alternative.
//
// Legacy profile fields are never used to decide membership here: a document
// in `members` is what includes a row, and its own role/status is what the
// row reports. A revoked membership disappears the moment its document is
// gone, no matter what the profile still says.
import type { Firestore } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { requireAuth, requireVerifiedEmail, requireActiveMember, validateRequest } from './authz'
import { AppError } from './errors'
import {
  CompanyScopedRequestSchema,
  MembershipSchema,
  type CompanyMember,
  type ListCompanyMembersResponse,
} from '../schemas/auth'

/** Display fields are optional and untrusted for authorization; only their
 * shape is checked, and anything unusable becomes null rather than failing
 * the whole roster. */
function displayField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export async function readCompanyRoster(
  db: Firestore,
  request: CallableRequest<unknown>,
): Promise<ListCompanyMembersResponse> {
  const auth = requireAuth(request)
  requireVerifiedEmail(auth)
  const input = validateRequest(CompanyScopedRequestSchema, request.data)

  // Any ACTIVE member may see who else is in the company — the same audience
  // the canonical Rules grant `members` read to. Role changes still require
  // admin; this is read-only.
  await requireActiveMember(db, input.companyId, auth.uid)

  let snap
  try {
    snap = await db.collection('companies').doc(input.companyId).collection('members').get()
  } catch {
    throw new AppError('membership_data_error')
  }

  // A membership that fails validation, or whose stored uid disagrees with its
  // own document id, is not trustworthy enough to report a role for — it is
  // excluded, exactly as assertNotLastAdmin excludes it from the admin count.
  const valid = snap.docs.flatMap(doc => {
    const parsed = MembershipSchema.safeParse(doc.data())
    if (!parsed.success || parsed.data.uid !== doc.id) return []
    return [{ id: doc.id, membership: parsed.data }]
  })

  const profiles = await Promise.all(valid.map(async entry => {
    try {
      const profileSnap = await db.collection('users').doc(entry.id).get()
      return profileSnap.exists ? profileSnap.data() : undefined
    } catch {
      // A profile read failure must not hide an existing member.
      return undefined
    }
  }))

  const members: CompanyMember[] = valid.map((entry, index) => ({
    uid: entry.id,
    role: entry.membership.role,
    status: entry.membership.status,
    name: displayField(profiles[index]?.name),
    email: displayField(profiles[index]?.email),
  }))

  members.sort((a, b) => a.uid.localeCompare(b.uid))
  return { members }
}
