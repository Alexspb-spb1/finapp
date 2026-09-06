import { z } from 'zod'
import { RoleSchema } from './auth'
import { FirestoreDocumentIdSchema } from './invitation'

export const GetCompanyAccessRequestSchema = z.object({
  companyId: FirestoreDocumentIdSchema,
}).strict()

export const GetCompanyAccessResponseSchema = z.object({
  companyId: FirestoreDocumentIdSchema,
  uid: FirestoreDocumentIdSchema,
  role: RoleSchema,
}).strict()
export type GetCompanyAccessResponse = z.infer<typeof GetCompanyAccessResponseSchema>
