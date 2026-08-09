// Typed client for the server `createCompany` callable — SEC-004.
//
// This is the ONLY place the client calls into company creation. The
// callable's response is strictly validated here (never trusted as-is) —
// an invalid/unexpected shape is treated as a failure, same as a network
// error, never as a partial success.
import { z } from 'zod'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

const CreateCompanyResponseSchema = z.object({
  companyId: z.string().min(1),
}).strict()
export type CreateCompanyResponse = z.infer<typeof CreateCompanyResponseSchema>

export interface CreateCompanyParams {
  idempotencyKey: string
  ownerName: string
  companyName: string
  legalType: 'ooo' | 'ip'
  inn?: string
}

export async function callCreateCompany(params: CreateCompanyParams): Promise<CreateCompanyResponse> {
  const callable = httpsCallable(functions, 'createCompany')
  const result = await callable(params)
  const parsed = CreateCompanyResponseSchema.safeParse(result.data)
  if (!parsed.success) throw new Error('createCompany: invalid response shape')
  return parsed.data
}
