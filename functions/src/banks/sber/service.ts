import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Firestore, Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { requireActiveMember, requireRole, requireNotInMaintenanceMode } from '../../lib/authz'
import { FirestoreDocumentIdSchema as Id } from '../../schemas/invitation'
import { authorizeBankRequest } from '../access'
import { BankPolicySchema, ConnectionSchema, parseBankData } from '../contracts'
import { BankError } from '../errors'
import { BankStore } from '../storage/store'
import { counter, hash, TenantSchema } from '../storage/schema'
import { BankReadFailure } from '../storage/worker'
import { accounts, authorizationUrl, ConfigSchema, ProfileSchema, TokenSchema, tokens,
  type SberConfig } from './protocol'
import { TokenCipher } from './secrets'
import type { SberProvider } from './provider'

const RefSchema = z.object({ companyId: Id, connectionId: Id }).strict()
export type ConnectionRef = z.infer<typeof RefSchema>
const Session = z.string().min(32).max(256)
const StateSchema = RefSchema.extend({ uid: Id, sessionHash: z.string(), nonce: z.string(),
  expectedInn: z.string(), policyGeneration: counter, tenantGeneration: counter,
  connectionGeneration: counter, configHash: z.string(), expiresAt: counter,
  phase: z.enum(['issued', 'exchanging', 'completed']) }).strict()
const CredentialSchema = RefSchema.extend({ actorUid: Id, expectedInn: z.string(), configHash: z.string(), policyGeneration: counter,
  tenantGeneration: counter, connectionGeneration: counter, version: counter,
  fence: counter, owner: z.string().nullable(), leaseUntil: counter,
  refreshStartedAt: counter, nextRefreshAt: counter, accessExpiresAt: counter, sealed: z.unknown() }).strict()
const CallbackSchema = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(4096) }).strict()
const denied = (): never => { throw new BankError('bank_access_denied') }
const context = (ref: ConnectionRef, generation: number, version: number) => JSON.stringify(['sber-tokens-v1', ref.companyId, ref.connectionId, generation, version])
const innSchema = z.string().regex(/^(\d{10}|\d{12})$/)

/** Private service, never an HTTP handler. Caller session must be server-verified. */
export class SberConnections {
  private readonly config: SberConfig
  constructor(private readonly db: Firestore, config: SberConfig, private readonly provider: SberProvider,
    private readonly cipher: TokenCipher, private readonly clock: () => number = Date.now) {
    this.config = parseBankData(ConfigSchema, config)
  }
  private root(ref: ConnectionRef) { return this.db.doc(`bankCompanies/${ref.companyId}`) }
  private connection(ref: ConnectionRef) { return this.root(ref).collection('connections').doc(ref.connectionId) }
  private credential(ref: ConnectionRef) { return this.root(ref).collection('credentials').doc(ref.connectionId) }
  private async boundaries(tx: Transaction, ref: ConnectionRef) {
    const [tenantDoc, policyDoc, companyDoc, connectionDoc] = await tx.getAll(this.root(ref),
      this.db.doc('system/bankIntegrations'), this.db.doc(`companies/${ref.companyId}`), this.connection(ref))
    const tenant = tenantDoc.exists ? parseBankData(TenantSchema, tenantDoc.data()) : null
    const policy = parseBankData(BankPolicySchema, policyDoc.data())
    const connection = connectionDoc.exists ? parseBankData(ConnectionSchema, connectionDoc.data()) : null
    if (!companyDoc.exists || !policy.enabled || tenant?.state === 'deleting'
      || (connection && (connection.companyId !== ref.companyId || connection.id !== ref.connectionId || connection.bankId !== 'sber'))) denied()
    return { tenant, policy, connection, inn: parseBankData(innSchema, companyDoc.data()?.inn) }
  }
  async begin(request: CallableRequest<unknown>, trustedSession: string): Promise<{ authorizationUrl: string }> {
    const ref = parseBankData(RefSchema, request.data)
    const session = parseBankData(Session, trustedSession)
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url')
    await this.db.runTransaction(async tx => {
      const { uid } = await authorizeBankRequest(this.db, { ...request, data: { companyId: ref.companyId } }, 'manage', tx)
      const current = await this.boundaries(tx, ref)
      const generation = parseBankData(counter, (current.connection?.generation ?? -1) + 1)
      tx.create(this.db.doc(`bankOAuthStates/${hash(state)}`), { ...ref, uid, sessionHash: hash(session), nonce,
        expectedInn: current.inn, policyGeneration: current.policy.generation,
        tenantGeneration: current.tenant?.generation ?? 0, connectionGeneration: generation,
        configHash: hash(this.config), expiresAt: this.clock() + 600_000, phase: 'issued' })
      if (!current.tenant) tx.create(this.root(ref), { state: 'active', generation: 0 })
      tx.set(this.connection(ref), { companyId: ref.companyId, id: ref.connectionId, bankId: 'sber', channel: 'api',
        generation, status: 'awaiting_authorization', consent: { status: 'pending', grantedBy: uid, permissions: [] } })
    })
    return { authorizationUrl: authorizationUrl(this.config, state, nonce) }
  }
  private async checkState(tx: Transaction, request: CallableRequest<unknown>, session: string, key: string, phase: 'issued' | 'exchanging') {
    const state = parseBankData(StateSchema, (await tx.get(this.db.doc(`bankOAuthStates/${key}`))).data())
    const { uid } = await authorizeBankRequest(this.db, { ...request, data: { companyId: state.companyId } }, 'manage', tx)
    const current = await this.boundaries(tx, state)
    if (state.uid !== uid || state.sessionHash !== hash(session) || state.phase !== phase
      || state.expiresAt <= this.clock() || state.configHash !== hash(this.config)
      || state.expectedInn !== current.inn || state.policyGeneration !== current.policy.generation
      || state.tenantGeneration !== current.tenant?.generation || state.connectionGeneration !== current.connection?.generation
      || current.connection.status !== 'awaiting_authorization') denied()
    return state
  }
  async callback(request: CallableRequest<unknown>, trustedSession: string, signal: AbortSignal): Promise<ConnectionRef> {
    const input = parseBankData(CallbackSchema, request.data)
    const session = parseBankData(Session, trustedSession), key = hash(input.state)
    const state = await this.db.runTransaction(async tx => {
      const value = await this.checkState(tx, request, session, key, 'issued')
      tx.update(this.db.doc(`bankOAuthStates/${key}`), { phase: 'exchanging' })
      return value
    })
    if (signal.aborted) denied()
    // Code is used once, immediately; never persisted, logged or queued.
    const tokenRequestedAt = this.clock()
    const result = await this.provider.exchange(input.code, state.nonce, signal)
    if (signal.aborted) denied()
    const profile = parseBankData(ProfileSchema, result.profile), value = tokens(result.tokens)
    const expiresAt = Date.parse(profile.offerExpirationDate)
    if (profile.inn !== state.expectedInn || !Number.isFinite(expiresAt) || expiresAt <= this.clock()) denied()
    const bankAccounts = accounts(state.companyId, profile)
    await this.db.runTransaction(async tx => {
      const fresh = await this.checkState(tx, request, session, key, 'exchanging')
      const generation = parseBankData(counter, fresh.connectionGeneration + 1)
      const ref = { companyId: state.companyId, connectionId: state.connectionId }
      const sealed = this.cipher.seal(value, context(ref, generation, 0))
      // Uses BANK-002 in THIS transaction: state/token/connection activation cannot split.
      await new BankStore(this.db, this.clock).installVerifiedGrant({ ...request, data: { companyId: state.companyId } }, {
        connection: { companyId: state.companyId, id: state.connectionId, bankId: 'sber', channel: 'api', status: 'active', generation,
          consent: { status: 'active', grantedBy: state.uid, expiresAt: new Date(expiresAt).toISOString(),
            permissions: ['accounts:read', 'statements:read'] } }, accounts: bankAccounts,
      }, tx)
      tx.set(this.credential(ref), { ...ref, actorUid: state.uid, expectedInn: state.expectedInn, configHash: state.configHash, policyGeneration: state.policyGeneration,
        tenantGeneration: state.tenantGeneration, connectionGeneration: generation,
        version: 0, fence: 0, owner: null, leaseUntil: 0, refreshStartedAt: 0, nextRefreshAt: 0,
        accessExpiresAt: tokenRequestedAt + value.expires_in * 1000, sealed })
      tx.update(this.db.doc(`bankOAuthStates/${key}`), { phase: 'completed' })
    })
    return { companyId: state.companyId, connectionId: state.connectionId }
  }
  private async checkedCredential(tx: Transaction, ref: ConnectionRef) {
    const value = parseBankData(CredentialSchema, (await tx.get(this.credential(ref))).data())
    await requireNotInMaintenanceMode(this.db, tx)
    requireRole(await requireActiveMember(this.db, ref.companyId, value.actorUid, tx), ['admin'])
    const current = await this.boundaries(tx, ref)
    const c = current.connection
    if (value.companyId !== ref.companyId || value.connectionId !== ref.connectionId
      || value.expectedInn !== current.inn || value.configHash !== hash(this.config)
      || value.policyGeneration !== current.policy.generation || value.tenantGeneration !== current.tenant?.generation
      || value.connectionGeneration !== c?.generation || c.status !== 'active'
      || c.consent.status !== 'active' || c.consent.grantedBy !== value.actorUid
      || !c.consent.permissions.includes('statements:read') || !c.consent.expiresAt
      || Date.parse(c.consent.expiresAt) <= this.clock()) denied()
    return value
  }
  /** Server-only token access, guarded before use and after refresh. Never return to a browser. */
  async accessToken(rawRef: ConnectionRef, signal: AbortSignal): Promise<string> {
    const ref = parseBankData(RefSchema, rawRef), owner = randomUUID()
    const claim = await this.db.runTransaction(async tx => {
      const value = await this.checkedCredential(tx, ref)
      const secret = parseBankData(TokenSchema, this.cipher.open(value.sealed, context(ref, value.connectionGeneration, value.version)))
      if (value.accessExpiresAt > this.clock() + 60_000) return { value, secret, refresh: false }
      if (value.nextRefreshAt > this.clock()) throw new BankReadFailure('rate_limited', value.nextRefreshAt - this.clock())
      if (value.leaseUntil > this.clock()) throw new BankReadFailure('transient', 1000)
      // Unknown refresh outcome is retried only within the documented 1h recovery window.
      if (value.refreshStartedAt && value.refreshStartedAt + 3_600_000 <= this.clock()) throw new BankReadFailure('reauth')
      const fence = parseBankData(counter, value.fence + 1)
      tx.update(this.credential(ref), { owner, fence, leaseUntil: this.clock() + 60_000,
        refreshStartedAt: value.refreshStartedAt || this.clock() })
      return { value: { ...value, fence }, secret, refresh: true }
    })
    if (signal.aborted) denied()
    if (!claim.refresh) return claim.secret.access_token
    // On uncertain network outcome, retain ciphertext and lease for bounded recovery.
    const tokenRequestedAt = this.clock()
    let refreshed: z.infer<typeof TokenSchema>
    try { refreshed = tokens(await this.provider.refresh(claim.secret.refresh_token, signal)) } catch (error) {
      if (error instanceof BankReadFailure && ['reauth', 'consent_revoked', 'permanent'].includes(error.category)) {
        await this.db.runTransaction(async tx => {
          const current = await this.checkedCredential(tx, ref)
          if (current.owner !== owner || current.fence !== claim.value.fence || current.version !== claim.value.version
            || current.leaseUntil <= this.clock()) denied()
          tx.update(this.connection(ref), { status: 'requires_reauth', generation: parseBankData(counter, current.connectionGeneration + 1) })
        })
      }
      if (error instanceof BankReadFailure && error.category === 'rate_limited') {
        const delay = parseBankData(z.number().int().min(0).max(86_400_000), error.retryAfterMs)
        await this.db.runTransaction(async tx => {
          const current = await this.checkedCredential(tx, ref)
          if (current.owner !== owner || current.fence !== claim.value.fence || current.version !== claim.value.version) denied()
          tx.update(this.credential(ref), { nextRefreshAt: this.clock() + delay })
        })
      }
      // Preserve only safe adapter categories, never SDK/provider exception text.
      throw error instanceof BankReadFailure ? error : new BankError('bank_unavailable')
    }
    if (signal.aborted) denied()
    await this.db.runTransaction(async tx => {
      const current = await this.checkedCredential(tx, ref)
      if (current.owner !== owner || current.fence !== claim.value.fence || current.version !== claim.value.version
        || current.leaseUntil <= this.clock()) denied()
      const version = parseBankData(counter, current.version + 1)
      tx.update(this.credential(ref), { version, owner: null, leaseUntil: 0, refreshStartedAt: 0, nextRefreshAt: 0,
        accessExpiresAt: tokenRequestedAt + refreshed.expires_in * 1000,
        sealed: this.cipher.seal(refreshed, context(ref, current.connectionGeneration, version)) })
    })
    return refreshed.access_token
  }
}
