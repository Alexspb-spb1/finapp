import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { parseBankData } from '../contracts'
import { BankError } from '../errors'

const CipherSchema = z.object({ keyId: z.string().min(1).max(100), iv: z.string(), tag: z.string(), data: z.string().max(100000) }).strict()
export type Sealed = z.infer<typeof CipherSchema>
/** Deployment supplies keys from a server secret manager; there is no default key. */
export interface Keyring { current(): { id: string; key: Buffer }; get(id: string): Buffer }
export class TokenCipher {
  constructor(private readonly keys: Keyring) {}
  seal(value: unknown, context: string): Sealed {
    try {
      const { id, key } = this.keys.current()
      if (key.length !== 32) throw new Error()
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(context))
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
      return parseBankData(CipherSchema, { keyId: id, iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
    } catch { throw new BankError('bank_access_denied') }
  }
  open(raw: unknown, context: string): unknown {
    try {
      const value = parseBankData(CipherSchema, raw)
      const decipher = createDecipheriv('aes-256-gcm', this.keys.get(value.keyId), Buffer.from(value.iv, 'base64'))
      decipher.setAAD(Buffer.from(context))
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8')) as unknown
    } catch { throw new BankError('bank_access_denied') }
  }
}
