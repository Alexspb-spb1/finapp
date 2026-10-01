// Member-management transaction bodies — SEC-007.
//
// Structured exactly like lib/cancelInviteTransaction.ts: the caller
// (performChangeMemberRole/… in functions/src/index.ts) computes the single
// `now` Timestamp ONCE, before `db.runTransaction()` is entered, and hands it
// in already-generated. This module never calls `new Date()`/`Timestamp.now()`,
// so a Firestore-forced retry of the update function can only ever write the
// same value it would have written on the first attempt.
//
// Authorization is identical for all four operations and is never derived from
// the payload: the caller must be an active `admin` of the SAME `companyId`
// that scopes the target document. Because the target is addressed as
// `companies/{companyId}/members/{subjectUid}`, an admin of company A
// structurally cannot reach a member of company B — there is no code path that
// reads a membership outside the caller's own verified company.
//
// The legacy `users/{uid}` profile is deliberately NOT written here. It is not
// an authorization source (see firestore.rules and ADR-001) and rewriting it
// would re-create the very legacy coupling SEC-007 removes.
import type { Firestore, Timestamp, Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import {
  requireActiveMember,
  requireRole,
  requireNotInMaintenanceMode,
  assertNotLastAdmin,
  type RequestAuth,
} from './authz'
import { AppError } from './errors'
import { writeAuditEvent } from './audit'
import { MembershipSchema, type Membership, type Role } from '../schemas/auth'
import type { MemberSubjectRequest, SetMemberRoleRequest } from '../schemas/auth'

export interface MemberManagementGeneratedValues {
  /** The one server timestamp written by this call; computed once by the
   * caller before the transaction so retries cannot drift. */
  nowTimestamp: Timestamp
}

interface BaseParams {
  db: Firestore
  txn: Transaction
  request: CallableRequest<unknown>
  auth: RequestAuth
  generated: MemberManagementGeneratedValues
}

export interface ChangeMemberRoleParams extends BaseParams {
  input: SetMemberRoleRequest
}

export interface MemberSubjectParams extends BaseParams {
  input: MemberSubjectRequest
}

/** Outcome of a member-management call. `changed: false` means the membership
 * was already in the requested state, so nothing was written and no audit
 * event was produced — the safe-repeat (idempotent) path. */
export interface MemberManagementResult {
  changed: boolean
}

function memberRef(db: Firestore, companyId: string, subjectUid: string) {
  return db.collection('companies').doc(companyId).collection('members').doc(subjectUid)
}

/**
 * Shared preamble for every member-management operation.
 *
 * Order is load-bearing:
 *   1. maintenance mode FIRST, inside the transaction (TOCTOU-safe, see
 *      requireNotInMaintenanceMode's own doc comment);
 *   2. the CALLER's own membership in this exact company, then the admin role;
 *   3. only then the target document.
 *
 * A caller who is not an active admin of `companyId` therefore never causes a
 * read of the target membership at all.
 */
async function authorizeAndReadTarget(params: {
  db: Firestore
  txn: Transaction
  auth: RequestAuth
  companyId: string
  subjectUid: string
}): Promise<{ target: Membership | undefined }> {
  const { db, txn, auth, companyId, subjectUid } = params

  await requireNotInMaintenanceMode(db, txn)

  const callerMembership = await requireActiveMember(db, companyId, auth.uid, txn)
  requireRole(callerMembership, ['admin'])

  let snap
  try {
    snap = await txn.get(memberRef(db, companyId, subjectUid))
  } catch {
    throw new AppError('membership_data_error')
  }

  if (!snap.exists) return { target: undefined }

  const parsed = MembershipSchema.safeParse(snap.data())
  // A membership whose stored `uid` disagrees with its own document ID is not
  // trustworthy input for a privileged mutation — refuse rather than guess,
  // exactly as requireActiveMember does for the caller.
  if (!parsed.success || parsed.data.uid !== snap.id) throw new AppError('membership_data_error')

  return { target: parsed.data }
}

/**
 * changeMemberRole — sets an existing membership's role.
 *
 * Idempotent: requesting the role the member already has writes nothing.
 * Last-admin protection: demoting an ACTIVE admin runs `assertNotLastAdmin`
 * inside this same transaction, so two concurrent demotions of the two last
 * admins cannot both commit — the loser's read set is invalidated and its
 * retry sees the smaller admin set and fails with `last_admin`.
 */
export async function runChangeMemberRoleTransaction(
  params: ChangeMemberRoleParams,
): Promise<MemberManagementResult> {
  const { db, txn, request, auth, input, generated } = params
  const { companyId, subjectUid, role } = input

  const { target } = await authorizeAndReadTarget({ db, txn, auth, companyId, subjectUid })
  if (!target) throw new AppError('membership_not_found')

  if (target.role === role) return { changed: false }

  const demotesAnActiveAdmin = target.status === 'active' && target.role === 'admin' && role !== 'admin'
  if (demotesAnActiveAdmin) {
    await assertNotLastAdmin(db, txn, companyId, subjectUid)
  }

  txn.update(memberRef(db, companyId, subjectUid), {
    role,
    updatedAt: generated.nowTimestamp,
  })
  writeAuditEvent(db, txn, request, {
    companyId,
    action: 'member_role_changed',
    targetUid: subjectUid,
  })
  return { changed: true }
}

/**
 * disableMember — revokes access without deleting the membership record.
 *
 * Idempotent: disabling an already-disabled membership writes nothing.
 * An `invited` membership cannot be disabled — it carries no access yet and
 * the invitation lifecycle owns that state (`membership_conflict`).
 */
export async function runDisableMemberTransaction(
  params: MemberSubjectParams,
): Promise<MemberManagementResult> {
  const { db, txn, request, auth, input, generated } = params
  const { companyId, subjectUid } = input

  const { target } = await authorizeAndReadTarget({ db, txn, auth, companyId, subjectUid })
  if (!target) throw new AppError('membership_not_found')

  if (target.status === 'disabled') return { changed: false }
  if (target.status !== 'active') throw new AppError('membership_conflict')

  if (target.role === 'admin') {
    await assertNotLastAdmin(db, txn, companyId, subjectUid)
  }

  txn.update(memberRef(db, companyId, subjectUid), {
    status: 'disabled',
    updatedAt: generated.nowTimestamp,
  })
  writeAuditEvent(db, txn, request, {
    companyId,
    action: 'member_disabled',
    targetUid: subjectUid,
  })
  return { changed: true }
}

/**
 * restoreMember — returns a previously disabled membership to active.
 *
 * Idempotent: restoring an already-active membership writes nothing. Only a
 * `disabled` membership may be restored; restoring an `invited` one would
 * bypass invitation acceptance entirely (`membership_conflict`).
 *
 * No last-admin check: restoring can only ever increase the active-admin set.
 */
export async function runRestoreMemberTransaction(
  params: MemberSubjectParams,
): Promise<MemberManagementResult> {
  const { db, txn, request, auth, input, generated } = params
  const { companyId, subjectUid } = input

  const { target } = await authorizeAndReadTarget({ db, txn, auth, companyId, subjectUid })
  if (!target) throw new AppError('membership_not_found')

  if (target.status === 'active') return { changed: false }
  if (target.status !== 'disabled') throw new AppError('membership_conflict')

  txn.update(memberRef(db, companyId, subjectUid), {
    status: 'active',
    updatedAt: generated.nowTimestamp,
  })
  writeAuditEvent(db, txn, request, {
    companyId,
    action: 'member_restored',
    targetUid: subjectUid,
  })
  return { changed: true }
}

/**
 * removeMember — deletes access to ONE company.
 *
 * The global Firebase Auth account is never touched: this deletes a single
 * `companies/{companyId}/members/{subjectUid}` document, so a user who is a
 * member of other companies keeps those memberships and keeps signing in.
 * Account-level disable/delete is a separate operator process (SEC-007 rule 7).
 *
 * Idempotent: removing an already-absent membership writes nothing and
 * succeeds, so a retried call after a committed delete is safe.
 */
export async function runRemoveMemberTransaction(
  params: MemberSubjectParams,
): Promise<MemberManagementResult> {
  const { db, txn, request, auth, input, generated } = params
  const { companyId, subjectUid } = input
  void generated

  const { target } = await authorizeAndReadTarget({ db, txn, auth, companyId, subjectUid })
  if (!target) return { changed: false }

  if (target.status === 'active' && target.role === 'admin') {
    await assertNotLastAdmin(db, txn, companyId, subjectUid)
  }

  txn.delete(memberRef(db, companyId, subjectUid))
  writeAuditEvent(db, txn, request, {
    companyId,
    action: 'member_removed',
    targetUid: subjectUid,
  })
  return { changed: true }
}

/** The four audit actions this module can emit. Exported for tests so the
 * expected action set is asserted against one source, not retyped. */
export const MEMBER_MANAGEMENT_AUDIT_ACTIONS = [
  'member_role_changed',
  'member_disabled',
  'member_restored',
  'member_removed',
] as const

export type MemberManagementAuditAction = (typeof MEMBER_MANAGEMENT_AUDIT_ACTIONS)[number]

/** Re-exported for the callables so they share one Role type import. */
export type { Role }
