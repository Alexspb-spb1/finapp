import { beforeEach, describe, expect, it, vi } from 'vitest'
const defined = vi.hoisted(() => vi.fn())
vi.mock('firebase-functions/params', () => ({ defineSecret: defined }))
import { defineSberSecretProviders, sberSecretReaders } from '../../../src/banks/sber/runtimeSecrets'
import { TokenCipher } from '../../../src/banks/sber/secrets'

const oldKey = Buffer.alloc(32, 1).toString('base64'), newKey = Buffer.alloc(32, 2).toString('base64')
const transport = () => ({ clientSecret: 'synthetic-secret-canary', pfxBase64: Buffer.from('synthetic-pfx').toString('base64'),
  passphrase: 'synthetic-passphrase', ca: ['-----BEGIN CERTIFICATE-----\nU1lOVEhFVElD\n-----END CERTIFICATE-----\n'] })
const keyring = () => ({ currentKeyId: 'old', keys: { old: oldKey } })
const value = (object: unknown) => ({ value: () => JSON.stringify(object) })
beforeEach(() => { defined.mockReset(); defined.mockImplementation(name => ({ name, value: vi.fn() })) })
describe('BANK-003 Firebase secret readers', () => {
  it('defines environment-separated secret bindings without reading at module/factory initialization', () => {
    for (const env of ['sandbox', 'production'] as const) {
      const result = defineSberSecretProviders(env)
      expect(result.bindings.map(secret => secret.name)).toEqual([`FINAPP_SBER_${env.toUpperCase()}_KEYRING`, `FINAPP_SBER_${env.toUpperCase()}_TRANSPORT`])
      for (const secret of result.bindings) expect(secret.value).not.toHaveBeenCalled()
    }
  })
  it('reads the server client secret and mTLS material only through bound secret parameters', async () => {
    const secrets = sberSecretReaders(value(keyring()), value(transport()))
    expect(await secrets.clientSecret()).toBe('synthetic-secret-canary')
    expect(await secrets.tls()).toEqual({ pfx: Buffer.from('synthetic-pfx'), passphrase: 'synthetic-passphrase', ca: transport().ca })
    expect(secrets.keyring.current()).toEqual({ id: 'old', key: Buffer.alloc(32, 1) })
  })
  it('retains old decryption keys across rotation and refuses unavailable keys', () => {
    let ring: unknown = keyring()
    const secrets = sberSecretReaders({ value: () => JSON.stringify(ring) }, value(transport()))
    const cipher = new TokenCipher(secrets.keyring)
    const old = cipher.seal({ token: 'synthetic-old' }, 'company-a')
    ring = { currentKeyId: 'new', keys: { old: oldKey, new: newKey } }
    expect(cipher.seal({ token: 'synthetic-new' }, 'company-a').keyId).toBe('new')
    expect(cipher.open(old, 'company-a')).toEqual({ token: 'synthetic-old' })
    ring = { currentKeyId: 'new', keys: { new: newKey } }
    expect(() => cipher.open(old, 'company-a')).toThrow('bank_access_denied')
    expect(() => secrets.keyring.get('missing')).toThrow('bank_access_denied')
  })
  it.each([
    {}, { currentKeyId: 'missing', keys: { old: oldKey } }, { currentKeyId: 'old', keys: { old: 'invalid!' } },
    { currentKeyId: 'old', keys: { old: Buffer.alloc(31).toString('base64') } },
    { currentKeyId: 'old', keys: { old: oldKey.trim().replace(/=$/, '') } },
    { ...keyring(), unexpected: 'synthetic-secret-canary' },
    { currentKeyId: 'k0', keys: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, oldKey])) },
  ])('rejects invalid keyring without leaking key material %#', ring => {
    const secrets = sberSecretReaders(value(ring), value(transport()))
    expect(() => secrets.keyring.current()).toThrow('bank_access_denied')
  })
  it.each([
    {}, { ...transport(), pfxBase64: 'bad!' }, { ...transport(), passphrase: '' }, { ...transport(), ca: [] },
    { ...transport(), ca: ['-----BEGIN PRIVATE KEY-----\nU1lOVEhFVElD\n-----END PRIVATE KEY-----'] },
    { ...transport(), ca: [transport().ca[0] + 'appended-data'] }, { ...transport(), clientSecret: '' },
  ])('rejects missing/malformed transport material %#', async material => {
    const secrets = sberSecretReaders(value(keyring()), value(material))
    await expect(secrets.clientSecret()).rejects.toThrow('bank_access_denied')
    await expect(secrets.tls()).rejects.toThrow('bank_access_denied')
  })
  it('sanitizes secret-provider exceptions, malformed JSON and oversized payloads', async () => {
    for (const bad of [{ value: () => { throw new Error('synthetic-secret-canary') } },
      { value: () => '{synthetic-secret-canary' }, { value: () => ' '.repeat(65001) }]) {
      const secrets = sberSecretReaders(bad, bad)
      expect(() => secrets.keyring.current()).toThrow('bank_access_denied')
      await expect(secrets.tls()).rejects.toThrow('bank_access_denied')
    }
  })
})
