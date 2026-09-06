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
import { onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { FieldValue, FieldPath, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { db, adminAuth } from './lib/admin'
import { requireAuth, requireVerifiedEmail, requireActiveMember, requireRole, requireNotInMaintenanceMode, validateRequest } from './lib/authz'
import { AppError, toSafeHttpsError } from './lib/errors'
import { writeAuditEvent } from './lib/audit'
import { runBootstrapIdempotent } from './lib/bootstrapIdempotency'
import { generateRawInvitationToken, hashInvitationToken } from './lib/invitationToken'
import { runInviteMemberTransaction } from './lib/inviteMemberTransaction'
import { runCancelInviteTransaction } from './lib/cancelInviteTransaction'
import { runResendInviteTransaction } from './lib/resendInviteTransaction'
import { runAcceptInviteTransaction } from './lib/acceptInviteTransaction'
import { verifyInvitationToken, requirePendingInvitation, requireCurrentInvitationLock, readInvitationCompanyName, maskInvitationEmail } from './lib/invitationAccess'
import { decodeInvitationsCursor, buildInvitationsCursor, timestampFromCursorPayload, mapInvitationDocumentToListItem } from './lib/invitationListing'
import { AuthzProbeRequestSchema, type AuthzProbeResponse } from './schemas/auth'
import { CreateCompanyRequestSchema, type CreateCompanyResponse } from './schemas/company'
import {
  InviteMemberRequestSchema,
  INVITATION_TTL_MS,
  ListInvitationsRequestSchema,
  CancelInviteRequestSchema,
  ResendInviteRequestSchema,
  AcceptInviteRequestSchema,
  PreviewInviteRequestSchema,
  FirestoreDocumentIdSchema,
  type AcceptInviteResponse,
  type PreviewInviteResponse,
  InvitationDocumentSchema,
  type InviteMemberResponse,
  type ListInvitationsResponse,
  type InvitationListItem,
  type InvitationDocument,
  type CancelInviteResponse,
  type ResendInviteResponse,
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
// never regenerated inside the transaction body. It exists only in this
// local closure and in the single successful response; only its SHA-256
// hash is ever persisted (see lib/invitationToken.ts). The transaction
// body itself (runInviteMemberTransaction, lib/inviteMemberTransaction.ts)
// imports neither the token generator nor the hasher at all, so it is
// structurally incapable of regenerating them no matter how many times
// Firestore invokes it on retry — see that module's own comment and
// test/unit/inviteMemberTransaction.test.ts for the accompanying proof
// (an injected transaction runner that invokes it twice).
//
// Duplicate-invite protection: `invitationLocks/{lockId}` (lockId derived
// deterministically from (companyId, emailNormalized) — see
// computeInvitationLockId in schemas/invitation.ts) points at the current
// invitation for that pair. A still-pending, unexpired invitation behind
// the lock blocks a new one with the stable `invitation_already_pending`
// error; an expired/accepted/revoked invitation behind the lock is safe to
// atomically replace. Any corrupted or mismatched lock/invitation state
// fails closed with a generic `internal_error` — never disclosing document
// content, IDs, or which specific invariant broke. All of that lives in
// runInviteMemberTransaction; see that file for the exact logic.
//
// `runTransactionImpl` defaults to the real `db.runTransaction`, but is
// injectable so a unit test can simulate Firestore invoking the update
// function more than once (an internal retry) against a fake Transaction —
// no Functions/Firestore Emulator involved.
export async function performInviteMember(
  request: CallableRequest<unknown>,
  runTransactionImpl: <T>(updateFn: (txn: Transaction) => Promise<T>) => Promise<T> = fn => db.runTransaction(fn),
): Promise<InviteMemberResponse> {
  const auth = requireAuth(request)
  requireVerifiedEmail(auth)
  const input = validateRequest(InviteMemberRequestSchema, request.data)

  const rawToken = generateRawInvitationToken()
  const tokenHash = hashInvitationToken(rawToken)
  const inviteId = db.collection('invitations').doc().id
  const expiresAtDate = new Date(Date.now() + INVITATION_TTL_MS)
  const expiresAtTimestamp = Timestamp.fromDate(expiresAtDate)

  await runTransactionImpl(txn =>
    runInviteMemberTransaction({
      db, txn, request, auth, input,
      generated: { tokenHash, inviteId, expiresAtTimestamp },
    }),
  )

  return {
    inviteId,
    token: rawToken,
    expiresAtUtc: expiresAtDate.toISOString(),
  }
}

export const inviteMember = onCall(async request => {
  try {
    return await performInviteMember(request)
  } catch (err) {
    throw toSafeHttpsError(err)
  }
})

// listInvitations (SEC-006 Stage 2b) — the first READ-ONLY callable over
// invitations/{inviteId}. Deliberately does nothing else: no write to
// invitations/invitationLocks/memberships/users/companies, no audit event,
// no Auth user, no maintenance-mode check (this reads nothing that
// maintenance mode protects, and the spec for this callable does not
// require one — see docs/remediation/reports/SEC-006.md).
//
// `companyId` is a lookup key ONLY — never proof of authorization by
// itself. The actual authorization decision is entirely
// requireActiveMember(db, input.companyId, auth.uid) + requireRole(...,
// ['admin']): an admin of a DIFFERENT company passing a foreign
// `companyId` has no membership document there and is rejected before any
// invitations query ever runs — the same pipeline every other privileged
// callable in this package uses.
//
// Pagination is a deterministic `orderBy(createdAt desc, __name__ desc)`
// keyset (never `offset()`), so two documents that happen to share the
// exact same `createdAt` are still ordered consistently by document ID —
// see lib/invitationListing.ts for the opaque, versioned cursor codec and
// the explicit response-field allowlist (never a raw document spread).
export async function performListInvitations(request: CallableRequest<unknown>): Promise<ListInvitationsResponse> {
  const auth = requireAuth(request)
  requireVerifiedEmail(auth)
  const input = validateRequest(ListInvitationsRequestSchema, request.data)
  const membership = await requireActiveMember(db, input.companyId, auth.uid)
  requireRole(membership, ['admin'])

  let startAfterCreatedAt: Timestamp | undefined
  let startAfterInviteId: string | undefined
  if (input.cursor !== undefined) {
    const cursorPayload = decodeInvitationsCursor(input.cursor)
    // A cursor minted for a different company can never be used to page
    // through THIS company's results, even if every other field is valid.
    if (cursorPayload.companyId !== input.companyId) throw new AppError('invalid_request')
    startAfterCreatedAt = timestampFromCursorPayload(cursorPayload)
    startAfterInviteId = cursorPayload.inviteId
  }

  let query = db.collection('invitations')
    .where('companyId', '==', input.companyId)
    .orderBy('createdAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc')
    .limit(input.pageSize + 1) // one extra doc, used only to detect a next page — never returned in items

  if (startAfterCreatedAt !== undefined && startAfterInviteId !== undefined) {
    query = query.startAfter(startAfterCreatedAt, startAfterInviteId)
  }

  let snap
  try {
    snap = await query.get()
  } catch {
    throw new AppError('internal_error')
  }

  // Every returned document — including the pageSize+1'th "lookahead" doc
  // used only to detect a next page — is validated against the SAME
  // schema the writer (runInviteMemberTransaction) uses, BEFORE any
  // slicing happens. Validating only the sliced page (independent review
  // finding #2 on SEC-006 Stage 2b round 1) would let a corrupted
  // lookahead document slip through undetected: the current page would
  // return successfully with a nextCursor, instead of the whole call
  // failing closed the same way a corrupted document ANYWHERE in the
  // result set must.
  const validatedDocs: Array<{ inviteId: string; data: InvitationDocument }> = []
  for (const doc of snap.docs) {
    const parsed = InvitationDocumentSchema.safeParse(doc.data())
    if (!parsed.success) throw new AppError('internal_error')
    validatedDocs.push({ inviteId: doc.id, data: parsed.data })
  }

  const hasNextPage = validatedDocs.length > input.pageSize
  const pageDocs = hasNextPage ? validatedDocs.slice(0, input.pageSize) : validatedDocs

  const items: InvitationListItem[] = pageDocs.map(d => mapInvitationDocumentToListItem(d.inviteId, d.data))
  const lastOnPage = pageDocs[pageDocs.length - 1]

  const nextCursor = hasNextPage && lastOnPage
    ? buildInvitationsCursor(input.companyId, lastOnPage.data.createdAt, lastOnPage.inviteId)
    : null

  return { items, nextCursor }
}

export const listInvitations = onCall(async request => {
  try {
    return await performListInvitations(request)
  } catch (err) {
    throw toSafeHttpsError(err)
  }
})

// cancelInvite (SEC-006 Stage 3) — the first MUTATING callable over
// invitations/{inviteId} besides inviteMember itself. Scope is
// deliberately narrow: revoke a single still-pending invitation and
// nothing else. resendInvite/previewInvite/acceptInvite are separate,
// later stages.
//
// `inviteId` is a bare lookup key here, same as `companyId` — neither is
// proof of authorization by itself. The invitation document's OWN
// `companyId` field is re-checked against `input.companyId` inside the
// transaction (see runCancelInviteTransaction); an admin of company B can
// never cancel an invitation belonging to company A even by guessing its
// inviteId, and gets the exact same `invitation_not_found` whether that
// ID belongs to another company or doesn't exist at all — no oracle.
//
// `revokedAtTimestamp` is computed exactly once, BEFORE the transaction,
// from this handler's own server clock (never `FieldValue.serverTimestamp()`,
// which cannot be read back synchronously for the response) — mirroring
// `performInviteMember`'s `expiresAtDate` precedent exactly, including the
// injectable `runTransactionImpl` for the same internal-retry-safety proof
// (see test/unit/cancelInviteTransaction.test.ts).
export async function performCancelInvite(
  request: CallableRequest<unknown>,
  runTransactionImpl: <T>(updateFn: (txn: Transaction) => Promise<T>) => Promise<T> = fn => db.runTransaction(fn),
): Promise<CancelInviteResponse> {
  const auth = requireAuth(request)
  requireVerifiedEmail(auth)
  const input = validateRequest(CancelInviteRequestSchema, request.data)

  const revokedAtDate = new Date()
  const revokedAtTimestamp = Timestamp.fromDate(revokedAtDate)

  await runTransactionImpl(txn =>
    runCancelInviteTransaction({ db, txn, request, auth, input, generated: { revokedAtTimestamp } }),
  )

  return {
    inviteId: input.inviteId,
    revokedAtUtc: revokedAtDate.toISOString(),
  }
}

export const cancelInvite = onCall(async request => {
  try {
    return await performCancelInvite(request)
  } catch (err) {
    throw toSafeHttpsError(err)
  }
})

// resendInvite (SEC-006 Stage 4) — mints a fresh token for an existing
// still-pending invitation ("Phase 1": the link is shared manually; no
// email delivery, provider, or UI in this stage). Scope is deliberately
// narrow: rotate the token/expiry of a single pending invitation and
// nothing else. previewInvite/acceptInvite are separate, later stages.
//
// `companyId`/`inviteId` are bare lookup keys, same as cancelInvite — the
// invitation document's own `companyId` is re-checked before it is even
// fully schema-validated (see runResendInviteTransaction, reusing
// cancelInvite's Stage 3 oracle-safety fix directly). Only a `pending`
// invitation can be resent; `accepted`/`revoked` are refused.
//
// The key addition over cancelInvite's shape: resendInvite also reads
// `invitationLocks/{lockId}` inside the SAME transaction and requires it
// to still point at exactly this `inviteId` — `inviteMember` can already
// replace an expired-but-still-`pending` invitation with a brand new one
// without ever touching the old document, so `status === 'pending'` alone
// is not sufficient to prove this invitation is still the active one for
// its (companyId, email) pair. See runResendInviteTransaction's own
// comment for the exact fail-closed behavior (never auto-repaired).
//
// `tokenHash`/`expiresAtTimestamp`/`nowTimestamp` are computed exactly
// once, BEFORE the transaction, from a real crypto source and this
// handler's own server clock (never `FieldValue.serverTimestamp()`,
// which cannot be read back synchronously for the response) — mirroring
// `performInviteMember`'s token-generation and `performCancelInvite`'s
// timestamp precedent exactly, including the injectable
// `runTransactionImpl` for the same internal-retry-safety proof (see
// test/unit/resendInviteTransaction.test.ts).
export async function performResendInvite(
  request: CallableRequest<unknown>,
  runTransactionImpl: <T>(updateFn: (txn: Transaction) => Promise<T>) => Promise<T> = fn => db.runTransaction(fn),
): Promise<ResendInviteResponse> {
  const auth = requireAuth(request)
  requireVerifiedEmail(auth)
  const input = validateRequest(ResendInviteRequestSchema, request.data)

  const rawToken = generateRawInvitationToken()
  const tokenHash = hashInvitationToken(rawToken)
  const expiresAtDate = new Date(Date.now() + INVITATION_TTL_MS)
  const expiresAtTimestamp = Timestamp.fromDate(expiresAtDate)
  const nowTimestamp = Timestamp.fromDate(new Date())

  await runTransactionImpl(txn =>
    runResendInviteTransaction({
      db, txn, request, auth, input,
      generated: { tokenHash, expiresAtTimestamp, nowTimestamp },
    }),
  )

  return {
    inviteId: input.inviteId,
    token: rawToken,
    expiresAtUtc: expiresAtDate.toISOString(),
  }
}

export const resendInvite = onCall(async request => {
  try {
    return await performResendInvite(request)
  } catch (err) {
    throw toSafeHttpsError(err)
  }
})

// SEC-006 Stage 5. No company, role or email is accepted from the payload.
// Hash once; evaluate the clock for each transaction attempt so a retry
// cannot reuse a timestamp from an earlier, not-yet-expired attempt.
export async function performAcceptInvite(
  request: CallableRequest<unknown>,
  runTransactionImpl: <T>(fn: (txn: Transaction) => Promise<T>) => Promise<T> = fn => db.runTransaction(fn),
  clock: () => Timestamp = () => Timestamp.now(),
): Promise<AcceptInviteResponse> {
  const auth = requireAuth(request)
  requireVerifiedEmail(auth)
  const input = validateRequest(AcceptInviteRequestSchema, request.data)
  if (!FirestoreDocumentIdSchema.safeParse(auth.uid).success) throw new AppError('invite_invalid')
  const tokenHash = hashInvitationToken(input.token)
  return runTransactionImpl(txn => runAcceptInviteTransaction({
    db, txn, request, auth, inviteId: input.inviteId, tokenHash, now: clock(),
  }))
}

export const acceptInvite = onCall(async request => {
  try {
    return await performAcceptInvite(request)
  } catch (err) {
    throw toSafeHttpsError(err)
  }
})

// Possession of the token permits only this minimal pre-auth preview.
// Status details become visible only after constant-time digest checking.
export async function performPreviewInvite(
  request: CallableRequest<unknown>,
  runTransactionImpl: <T>(fn: (txn: Transaction) => Promise<T>) => Promise<T> = fn => db.runTransaction(fn, { readOnly: true }),
  clock: () => Timestamp = () => Timestamp.now(),
): Promise<PreviewInviteResponse> {
  const input = validateRequest(PreviewInviteRequestSchema, request.data)
  const tokenHash = hashInvitationToken(input.token)
  return runTransactionImpl(async txn => {
    const snap = await txn.get(db.collection('invitations').doc(input.inviteId))
    const invite = verifyInvitationToken(snap.data(), tokenHash)
    requirePendingInvitation(invite, clock())
    await requireCurrentInvitationLock(db, txn, input.inviteId, invite)
    const companyDisplayName = await readInvitationCompanyName(db, txn, invite.companyId)
    const labels: Record<typeof invite.role, PreviewInviteResponse['roleLabel']> = {
      viewer: 'Наблюдатель', accountant: 'Бухгалтер', admin: 'Администратор',
    }
    return {
      maskedEmail: maskInvitationEmail(invite.emailNormalized), companyDisplayName,
      roleLabel: labels[invite.role], expiresAt: invite.expiresAt.toDate().toISOString(),
    }
  })
}

export const previewInvite = onCall(async request => {
  try {
    return await performPreviewInvite(request)
  } catch (err) {
    throw toSafeHttpsError(err)
  }
})
