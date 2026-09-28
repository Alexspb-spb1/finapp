import { BankReadFailure } from '../storage/worker'
import { BankError } from '../errors'
import { parseBankData } from '../contracts'
import { type SberConfig, type Tokens, type Profile, type BankSignatureVerifier,
  ConfigSchema, ProfileSchema, tokens, verifiedClaims } from './protocol'
import { type SberTransport, requireSuccess } from './transport'

export interface SberProvider {
  exchange(code: string, nonce: string, signal: AbortSignal): Promise<{ tokens: Tokens; profile: Profile }>
  refresh(refreshToken: string, signal: AbortSignal): Promise<Tokens>
}
export class RestSberProvider implements SberProvider {
  private readonly config: SberConfig
  constructor(config: SberConfig, private readonly transport: SberTransport,
    private readonly clientSecret: () => Promise<string>, private readonly verifier: BankSignatureVerifier,
    private readonly clock: () => number = Date.now) { this.config = parseBankData(ConfigSchema, config) }
  private async tokenRequest(values: Record<string, string>, signal: AbortSignal) {
    let secret: string
    try { secret = await this.clientSecret() } catch { throw new BankError('bank_access_denied') }
    if (!secret) throw new BankError('bank_access_denied')
    const response = await this.transport.send({ resource: 'token', form: new URLSearchParams({
      ...values, client_id: this.config.clientId, client_secret: secret }) }, signal)
    if (response.status === 400) {
      let error: unknown
      try { error = (JSON.parse(response.body) as { error?: unknown }).error } catch { /* generic status below */ }
      if (error === 'invalid_grant') throw new BankReadFailure('reauth')
    }
    const body = requireSuccess(response, this.clock())
    try { return tokens(JSON.parse(body)) } catch { throw new BankError('invalid_bank_data') }
  }
  async exchange(code: string, nonce: string, signal: AbortSignal) {
    const value = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri }, signal)
    if (!value.id_token) throw new BankError('bank_access_denied')
    const identity = await verifiedClaims(value.id_token, this.config, this.verifier, this.clock(), nonce)
    const signedProfile = requireSuccess(await this.transport.send({ resource: 'profile', token: value.access_token }, signal), this.clock())
    const claims = await verifiedClaims(signedProfile, this.config, this.verifier, this.clock())
    const profile = parseBankData(ProfileSchema, claims)
    if (profile.sub !== identity.sub || !Number.isFinite(Date.parse(profile.offerExpirationDate))) throw new BankError('bank_access_denied')
    return { tokens: value, profile }
  }
  async refresh(refreshToken: string, signal: AbortSignal) {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal)
  }
}
