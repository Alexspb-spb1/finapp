// Cloud Functions entry point — SEC-003/SEC-004.
//
// `authzProbe` — a minimal READ-ONLY authorization probe. It exists to
// prove the real server authorization pipeline (requireAuth ->
// requireVerifiedEmail -> requireActiveMember -> requireRole) actually
// works end-to-end through the Functions Emulator — see
// functions/test/emulator/authzProbe.test.ts.
//
// `createCompany` (SEC-004) — the first privileged MUTATING callable. Moves
// company creation out of the client entirely: uid/email come only from
// requireAuth()/Admin Auth, the company id is a server-generated Firestore
// document id, and companies/{companyId}, its owner membership,
// company_data/{companyId}, and the users/{uid} compatibility bridge are
// all created in a single transaction guarded by the SEC-004 bootstrap
// idempotency mechanism (see lib/bootstrapIdempotency.ts). Deliberately
// does NOT call requireVerifiedEmail — the caller is a just-created Firebase
// Auth user who cannot have verified their email yet; mandatory
// verified-email enforcement is SEC-013. The verification email itself is
// still sent by the client right after Auth user creation (src/store/authStore.ts).
import { onCall } from 'firebase-functions/v2/https'
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { db, adminAuth } from './lib/admin'
import { requireAuth, requireVerifiedEmail, requireActiveMember, requireRole, requireNotInMaintenanceMode, validateRequest } from './lib/authz'
import { AppError, toSafeHttpsError } from './lib/errors'
import { writeAuditEvent } from './lib/audit'
import { runBootstrapIdempotent } from './lib/bootstrapIdempotency'
import { generateRawInvitationToken, hashInvitationToken, buildPendingInvitationDocument } from './lib/invitationToken'
import { AuthzProbeRequestSchema, type AuthzProbeResponse } from './schemas/auth'
import { CreateCompanyRequestSchema, type CreateCompanyResponse } from './schemas/company'
import {
  InviteMemberRequestSchema,
  InvitationLockDocumentSchema,
  InvitationDocumentSchema,
  computeInvitationLockId,
  INVITATION_TTL_MS,
  type InviteMemberResponse,
} from './schemas/invitation'

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

// Initial categories/settings written into company_data/{companyId} for a
// newly-created company — mirrors the current business defaults (formerly
// duplicated client-side in src/store/authStore.ts's DEFAULT_CATEGORIES).
const DEFAULT_CATEGORIES = [
  { id: 'cat_inc1', name: 'Выручка от клиентов', type: 'income', icon: 'TrendingUp', color: '#22c55e' },
  { id: 'cat_inc2', name: 'Прочие доходы', type: 'income', icon: 'BarChart2', color: '#10b981' },
  { id: 'cat_inc3', name: 'Займы полученные', type: 'income', icon: 'Banknote', color: '#6ee7b7' },
  { id: 'cat_exp1', name: 'Зарплата', type: 'expense', icon: 'Users', color: '#ef4444' },
  { id: 'cat_exp2', name: 'Аренда', type: 'expense', icon: 'Building2', color: '#f97316' },
  { id: 'cat_exp3', name: 'Реклама и маркетинг', type: 'expense', icon: 'Megaphone', color: '#a855f7' },
  { id: 'cat_exp4', name: 'Закупка товаров', type: 'expense', icon: 'Package', color: '#3b82f6' },
  { id: 'cat_exp5', name: 'Налоги', type: 'expense', icon: 'Landmark', color: '#64748b' },
  { id: 'cat_exp6', name: 'Связь и интернет', type: 'expense', icon: 'Wifi', color: '#06b6d4' },
  { id: 'cat_exp7', name: 'Командировки', type: 'expense', icon: 'Plane', color: '#8b5cf6' },
  { id: 'cat_tr1', name: 'Внутренний перевод', type: 'transfer', icon: 'ArrowLeftRight', color: '#94a3b8' },
]

export const createCompany = onCall(async request => {
  try {
    const auth = requireAuth(request)
    const input = validateRequest(CreateCompanyRequestSchema, request.data)

    // Email comes ONLY from the trusted Admin Auth record for this uid —
    // never from request.data (CreateCompanyRequestSchema.strict() already
    // rejects an "email" field outright, but this is the actual source of
    // truth even if that changed).
    const userRecord = await adminAuth.getUser(auth.uid)
    const email = (userRecord.email ?? '').toLowerCase()

    const result = await runBootstrapIdempotent({
      db,
      uid: auth.uid,
      idempotencyKey: input.idempotencyKey,
      payloadForFingerprint: {
        ownerName: input.ownerName,
        companyName: input.companyName,
        legalType: input.legalType,
        inn: input.inn ?? null,
      },
      run: async (txn: Transaction) => {
        // SEC-005 production preflight: Firestore Rules never apply to
        // this Admin SDK write path, so maintenance mode needs its own
        // explicit check — read via txn.get() (requireNotInMaintenanceMode's
        // txn parameter), so it is part of THIS transaction's read set and
        // closes the TOCTOU window between the check and commit (see the
        // function's doc comment in lib/authz.ts). Must stay the first
        // statement in run(), before any other read/write.
        await requireNotInMaintenanceMode(db, txn)

        const userRef = db.collection('users').doc(auth.uid)

        // Guard against bootstrapping a SECOND "first company" for a uid
        // that already has a users/{uid} profile but no bootstrap receipt —
        // e.g. a pre-SEC-004 legacy account, an admin-invited user
        // (authStore.inviteUser), or any other path that created a profile
        // without going through this callable. This read MUST happen inside
        // the SAME transaction as the receipt check (independent audit
        // finding on SEC-004 PR #12) — a plain pre-check outside the
        // transaction would race with a concurrent legitimate bootstrap.
        // Firestore's "all reads before all writes" rule is satisfied: this
        // is the very first statement in run(), before any txn.set() below.
        const existingUserSnap = await txn.get(userRef)
        if (existingUserSnap.exists) {
          // Stable, safe, no user-controlled data — never overwrites the
          // existing profile, never creates a company/membership for it.
          throw new AppError('idempotency_conflict')
        }

        // Server-generated random Firestore document id — never
        // Date.now(), the uid, or the idempotency key.
        const companyRef = db.collection('companies').doc()
        const companyId = companyRef.id
        const nowIso = new Date().toISOString()
        const serverNow = FieldValue.serverTimestamp()

        const membershipRef = companyRef.collection('members').doc(auth.uid)
        const companyDataRef = db.collection('company_data').doc(companyId)

        txn.set(companyRef, {
          id: companyId,
          name: input.companyName,
          legalType: input.legalType,
          ...(input.inn !== undefined ? { inn: input.inn } : {}),
          currency: 'RUB',
          createdAt: nowIso,
          ownerId: auth.uid,
        })

        txn.set(membershipRef, {
          uid: auth.uid,
          role: 'admin',
          status: 'active',
          createdAt: serverNow,
          updatedAt: serverNow,
        })

        txn.set(companyDataRef, {
          accounts: [],
          categories: DEFAULT_CATEGORIES,
          counterparties: [],
          transactions: [],
          projects: [],
          rules: [],
        })

        // Temporary server-side compatibility bridge: the client's legacy
        // users/{uid} reader (src/schemas/auth.ts LegacyUserSchema) still
        // expects role/companyId embedded on the profile document. The
        // client itself no longer writes this document at all (SEC-004);
        // full removal of these legacy fields is SEC-005/SEC-008.
        txn.set(userRef, {
          id: auth.uid,
          name: input.ownerName,
          email,
          role: 'admin',
          companyId,
          createdAt: nowIso,
        })

        writeAuditEvent(db, txn, request, { companyId, action: 'company_created' })

        return { companyId }
      },
    })

    const response: CreateCompanyResponse = { companyId: result.companyId }
    return response
  } catch (err) {
    throw toSafeHttpsError(err)
  }
})

// inviteMember (SEC-006 Stage 2) — the first callable to write to
// invitations/{inviteId} and invitationLocks/{lockId} (both deny-all in
// Firestore Rules since SEC-006 Stage 1 — writable only via this Admin SDK
// path). Scope is deliberately narrow: this creates a pending invitation
// and nothing else. listInvitations/cancelInvite/resendInvite/
// previewInvite/acceptInvite are separate, later stages.
//
// Token handling: the raw token is generated exactly once, BEFORE the
// transaction, and reused verbatim across any internal Firestore retry —
// never regenerated inside run(). It exists only in this local closure and
// in the single successful response; only its SHA-256 hash is ever
// persisted (see lib/invitationToken.ts).
//
// Duplicate-invite protection: `invitationLocks/{lockId}` (lockId derived
// deterministically from (companyId, emailNormalized) — see
// computeInvitationLockId) points at the current invitation for that pair.
// A still-pending, unexpired invitation behind the lock blocks a new one
// with the stable `invitation_already_pending` error; an expired/accepted/
// revoked invitation behind the lock is safe to atomically replace. Any
// corrupted or mismatched lock/invitation state fails closed with a
// generic `internal_error` — never disclosing document content, IDs, or
// which specific invariant broke.
export const inviteMember = onCall(async request => {
  try {
    const auth = requireAuth(request)
    requireVerifiedEmail(auth)
    const input = validateRequest(InviteMemberRequestSchema, request.data)

    const rawToken = generateRawInvitationToken()
    const tokenHash = hashInvitationToken(rawToken)
    const inviteRef = db.collection('invitations').doc()
    const inviteId = inviteRef.id
    const expiresAtDate = new Date(Date.now() + INVITATION_TTL_MS)
    const expiresAtTimestamp = Timestamp.fromDate(expiresAtDate)
    const lockId = computeInvitationLockId(input.companyId, input.email)
    const lockRef = db.collection('invitationLocks').doc(lockId)

    await db.runTransaction(async (txn: Transaction) => {
      // Must stay the first statement — see requireNotInMaintenanceMode's
      // own doc comment (lib/authz.ts) on why this closes the TOCTOU
      // window via Firestore's transactional read-set retry.
      await requireNotInMaintenanceMode(db, txn)

      const membership = await requireActiveMember(db, input.companyId, auth.uid, txn)
      requireRole(membership, ['admin'])

      // All reads before all writes: resolve the lock (and, if present,
      // the invitation it points to) before any txn.set() below.
      const lockSnap = await txn.get(lockRef)
      if (lockSnap.exists) {
        const lockParsed = InvitationLockDocumentSchema.safeParse(lockSnap.data())
        if (!lockParsed.success) throw new AppError('internal_error')

        const existingInviteRef = db.collection('invitations').doc(lockParsed.data.currentInviteId)
        const existingInviteSnap = await txn.get(existingInviteRef)
        if (!existingInviteSnap.exists) throw new AppError('internal_error')

        const existingInviteParsed = InvitationDocumentSchema.safeParse(existingInviteSnap.data())
        if (!existingInviteParsed.success) throw new AppError('internal_error')

        const existingInvite = existingInviteParsed.data
        if (existingInvite.companyId !== input.companyId || existingInvite.emailNormalized !== input.email) {
          throw new AppError('internal_error')
        }

        if (existingInvite.status === 'pending' && existingInvite.expiresAt.toMillis() > Date.now()) {
          // Still pending and not expired — refuse, change nothing.
          throw new AppError('invitation_already_pending')
        }
        // expired-pending / accepted / revoked — safe to atomically
        // replace the lock with the new invitation created below.
      }

      const serverNow = FieldValue.serverTimestamp()
      txn.set(inviteRef, buildPendingInvitationDocument({
        companyId: input.companyId,
        emailNormalized: input.email,
        role: input.role,
        tokenHash,
        expiresAt: expiresAtTimestamp,
        createdBy: auth.uid,
        createdAt: serverNow,
        updatedAt: serverNow,
        lastSentAt: serverNow,
      }))

      txn.set(lockRef, { currentInviteId: inviteId })

      writeAuditEvent(db, txn, request, { companyId: input.companyId, action: 'member_invited' })
    })

    const response: InviteMemberResponse = {
      inviteId,
      token: rawToken,
      expiresAtUtc: expiresAtDate.toISOString(),
    }
    return response
  } catch (err) {
    throw toSafeHttpsError(err)
  }
})
