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
import { FieldValue, type Transaction } from 'firebase-admin/firestore'
import { db, adminAuth } from './lib/admin'
import { requireAuth, requireVerifiedEmail, requireActiveMember, requireRole, requireNotInMaintenanceMode, validateRequest } from './lib/authz'
import { AppError, toSafeHttpsError } from './lib/errors'
import { writeAuditEvent } from './lib/audit'
import { runBootstrapIdempotent } from './lib/bootstrapIdempotency'
import { AuthzProbeRequestSchema, type AuthzProbeResponse } from './schemas/auth'
import { CreateCompanyRequestSchema, type CreateCompanyResponse } from './schemas/company'

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
    // SEC-005 production preflight: Firestore Rules never apply to this
    // Admin SDK write path, so maintenance mode needs its own explicit
    // check here — checked before any read/write below.
    await requireNotInMaintenanceMode(db)
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
