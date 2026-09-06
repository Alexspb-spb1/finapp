// Temporary compatibility with src/schemas/auth.ts LegacyUserSchema.
// This data is never used to authorize acceptance. All newly assigned
// role/company values originate in the token-authenticated invitation.
import { z } from 'zod'
import { AppError } from './errors'
import { RoleSchema, type Role } from '../schemas/auth'
import { FirestoreDocumentIdSchema, NormalizedEmailSchema } from '../schemas/invitation'

const profileFields = {
  id: z.string().min(1), name: z.string().min(1), email: z.string().min(1),
  createdAt: z.string().min(1), avatar: z.string().optional(),
}
const CanonicalProfileSchema = z.object(profileFields).strict()
const LegacyProfileSchema = z.object({
  ...profileFields,
  role: RoleSchema, companyId: FirestoreDocumentIdSchema,
  companies: z.array(z.object({ companyId: FirestoreDocumentIdSchema, role: RoleSchema }).strict()).optional(),
}).strict()

export function buildAcceptedInvitationProfile(
  raw: unknown,
  input: { uid: string; email: string; name: string; companyId: string; role: Role; createdAt: string },
): Record<string, unknown> {
  if (!NormalizedEmailSchema.safeParse(input.email).success) throw new AppError('invite_invalid')
  if (raw === undefined) {
    return { id: input.uid, name: input.name, email: input.email, role: input.role, companyId: input.companyId, createdAt: input.createdAt }
  }
  const parsed = z.union([LegacyProfileSchema, CanonicalProfileSchema]).safeParse(raw)
  if (!parsed.success || parsed.data.id !== input.uid) throw new AppError('internal_error')
  const profile = parsed.data
  if (!('companyId' in profile)) return { ...profile, email: input.email, companyId: input.companyId, role: input.role }

  const entries = profile.companies ?? [{ companyId: profile.companyId, role: profile.role }]
  if (new Set(entries.map(entry => entry.companyId)).size !== entries.length) throw new AppError('internal_error')
  const companies = entries.filter(entry => entry.companyId !== input.companyId)
  if (profile.companyId !== input.companyId && !companies.some(entry => entry.companyId === profile.companyId)) {
    companies.unshift({ companyId: profile.companyId, role: profile.role })
  }
  companies.push({ companyId: input.companyId, role: input.role })
  return {
    ...profile, email: input.email, companies,
    role: profile.companyId === input.companyId ? input.role : profile.role,
  }
}
