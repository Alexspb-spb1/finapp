import { defineSecret, type SecretParam } from 'firebase-functions/params'
import { z } from 'zod'
import { BankError } from '../errors'
import type { Keyring } from './secrets'
import type { TlsSecrets } from './transport'

const KeyId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const KeyringSchema = z.object({ currentKeyId: KeyId,
  keys: z.record(KeyId, z.string().max(44)) }).strict()
const TransportSchema = z.object({ clientSecret: z.string().min(1).max(16000),
  pfxBase64: z.string().min(4).max(40000), passphrase: z.string().min(1).max(1024),
  ca: z.array(z.string().min(1).max(12000)).min(1).max(8) }).strict()
type SecretValue = Pick<SecretParam, 'value'>
const deny = (): never => { throw new BankError('bank_access_denied') }
function decode(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (!decoded.length || decoded.toString('base64') !== value) deny()
  return decoded
}
function json(secret: SecretValue): unknown {
  const raw = secret.value()
  if (!raw || Buffer.byteLength(raw) > 65000) deny()
  return JSON.parse(raw) as unknown
}

/** Concrete readers for Firebase SecretParam values. Lazy, no environment/default
 * fallback. These checks validate secret shape; the TLS stack verifies actual PFX/CA.
 */
export function sberSecretReaders(keyringSecret: SecretValue, transportSecret: SecretValue): {
  keyring: Keyring; clientSecret: () => Promise<string>; tls: () => Promise<TlsSecrets>
} {
  const keyring = () => {
    try {
      const parsed = KeyringSchema.parse(json(keyringSecret))
      const entries = Object.entries(parsed.keys)
      if (!entries.length || entries.length > 8 || !Object.hasOwn(parsed.keys, parsed.currentKeyId)) deny()
      const keys = new Map(entries.map(([id, encoded]) => {
        const key = decode(encoded); if (key.length !== 32) deny(); return [id, key] as const
      }))
      return { id: parsed.currentKeyId, keys }
    } catch { return deny() }
  }
  const transport = () => {
    try {
      const value = TransportSchema.parse(json(transportSecret))
      const pfx = decode(value.pfxBase64)
      // A CA entry is exactly one PEM certificate, with no appended key/config.
      for (const ca of value.ca) if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(ca)) deny()
      return { value, pfx }
    } catch { return deny() }
  }
  return {
    keyring: {
      current() { const value = keyring(); const key = value.keys.get(value.id); if (!key) return deny(); return { id: value.id, key } },
      get(id) { const key = keyring().keys.get(id); if (!key) return deny(); return key },
    },
    async clientSecret() { return transport().value.clientSecret },
    async tls() { const { value, pfx } = transport(); return { pfx, passphrase: value.passphrase, ca: value.ca } },
  }
}

/** Call only in the future deployment composition root and bind BOTH secrets to
 * onRequest/onTask options. Defining parameters does not provision or read secrets.
 * Deliberately not invoked/imported by index.ts while BANK-003 gates remain open.
 */
export function defineSberSecretProviders(environment: 'sandbox' | 'production') {
  if (environment !== 'sandbox' && environment !== 'production') deny()
  const prefix = `FINAPP_SBER_${environment.toUpperCase()}`
  const keyring = defineSecret(`${prefix}_KEYRING`)
  const transport = defineSecret(`${prefix}_TRANSPORT`)
  return { bindings: [keyring, transport], ...sberSecretReaders(keyring, transport) }
}
