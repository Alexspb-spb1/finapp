// Firestore Rules emulator tests — BASE-004A emergency remediation.
//
// Все идентификаторы, email и имена — синтетические, не production-данные
// (см. docs/remediation/BASE-004A_EMERGENCY_RULES_PLAN.md, требование
// "используй только синтетические значения").
//
// Запуск: npm run test:rules (оборачивает Firestore Emulator через
// `firebase emulators:exec`). Требует Java 21+ для firebase-tools —
// если недоступно, см. BASE_004A_PARTIAL в отчёте задачи.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'

const PROJECT_ID = 'demo-finapp-rules-test'

let testEnv: RulesTestEnvironment

// ── Синтетические фикстуры ──────────────────────────────────────────────────
const COMPANY_A = 'companyA_synthetic'
const COMPANY_B = 'companyB_synthetic'
const COMPANY_C = 'companyC_synthetic'

const ADMIN_A = 'uid_admin_a'
const ACCOUNTANT_A = 'uid_accountant_a'
const VIEWER_A = 'uid_viewer_a'
const ADMIN_B = 'uid_admin_b'
const ADMIN_C = 'uid_admin_c'
const NO_PROFILE_UID = 'uid_no_profile'
const ATTACKER_UID = 'uid_attacker'
const MULTI_COMPANY_UID = 'uid_multi_company'

async function seedUser(
  uid: string,
  profile: Record<string, unknown>,
) {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'users', uid), {
      id: uid,
      name: 'Multi Company User',
      email: `${uid}@example.test`,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...profile,
    })
  })
}

async function seed() {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore()
    await Promise.all([
      setDoc(doc(db, 'companies', COMPANY_A), {
        id: COMPANY_A, name: 'Company A', legalType: 'ooo',
        currency: 'RUB', createdAt: '2026-01-01T00:00:00.000Z', ownerId: ADMIN_A,
      }),
      setDoc(doc(db, 'companies', COMPANY_B), {
        id: COMPANY_B, name: 'Company B', legalType: 'ip',
        currency: 'RUB', createdAt: '2026-01-01T00:00:00.000Z', ownerId: ADMIN_B,
      }),
      setDoc(doc(db, 'companies', COMPANY_C), {
        id: COMPANY_C, name: 'Company C', legalType: 'ip',
        currency: 'RUB', createdAt: '2026-01-01T00:00:00.000Z', ownerId: ADMIN_C,
      }),
      setDoc(doc(db, 'users', ADMIN_A), {
        id: ADMIN_A, name: 'Admin A', email: 'admin.a@example.test',
        role: 'admin', companyId: COMPANY_A, createdAt: '2026-01-01T00:00:00.000Z',
      }),
      setDoc(doc(db, 'users', ACCOUNTANT_A), {
        id: ACCOUNTANT_A, name: 'Accountant A', email: 'accountant.a@example.test',
        role: 'accountant', companyId: COMPANY_A, createdAt: '2026-01-01T00:00:00.000Z',
      }),
      setDoc(doc(db, 'users', VIEWER_A), {
        id: VIEWER_A, name: 'Viewer A', email: 'viewer.a@example.test',
        role: 'viewer', companyId: COMPANY_A, createdAt: '2026-01-01T00:00:00.000Z',
      }),
      setDoc(doc(db, 'users', ADMIN_B), {
        id: ADMIN_B, name: 'Admin B', email: 'admin.b@example.test',
        role: 'admin', companyId: COMPANY_B, createdAt: '2026-01-01T00:00:00.000Z',
      }),
      setDoc(doc(db, 'users', ADMIN_C), {
        id: ADMIN_C, name: 'Admin C', email: 'admin.c@example.test',
        role: 'admin', companyId: COMPANY_C, createdAt: '2026-01-01T00:00:00.000Z',
      }),
      setDoc(doc(db, 'company_data', COMPANY_A), {
        accounts: [], categories: [], counterparties: [], transactions: [],
        projects: [], rules: [], budgets: [], recurring: [], paymentCalendar: [],
      }),
      setDoc(doc(db, 'company_data', COMPANY_B), {
        accounts: [], categories: [], counterparties: [], transactions: [],
        projects: [], rules: [], budgets: [], recurring: [], paymentCalendar: [],
      }),
      setDoc(doc(db, 'company_data', COMPANY_C), {
        accounts: [], categories: [], counterparties: [], transactions: [],
        projects: [], rules: [], budgets: [], recurring: [], paymentCalendar: [],
      }),
    ])
  })
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  })
})

afterAll(async () => {
  await testEnv.cleanup()
})

beforeEach(async () => {
  await testEnv.clearFirestore()
  await seed()
})

// ── 1. Unauthenticated → отказ для всех путей ───────────────────────────────
describe('1. unauthenticated access', () => {
  it('denies reading users, companies, company_data', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(db, 'users', ADMIN_A)))
    await assertFails(getDoc(doc(db, 'companies', COMPANY_A)))
    await assertFails(getDoc(doc(db, 'company_data', COMPANY_A)))
  })
  it('denies writing anywhere', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(setDoc(doc(db, 'company_data', COMPANY_A), { accounts: [] }))
  })
})

// ── 2. Пользователь без users/{uid} → отказ ─────────────────────────────────
describe('2. authenticated but no users/{uid} profile', () => {
  it('cannot read company data', async () => {
    const db = testEnv.authenticatedContext(NO_PROFILE_UID).firestore()
    await assertFails(getDoc(doc(db, 'company_data', COMPANY_A)))
  })
  it('cannot read another user profile', async () => {
    const db = testEnv.authenticatedContext(NO_PROFILE_UID).firestore()
    await assertFails(getDoc(doc(db, 'users', ADMIN_A)))
  })
})

// ── 3. Пользователь читает разрешённые данные своей компании ────────────────
describe('3. member reads own-company data', () => {
  it('viewer reads own company_data', async () => {
    const db = testEnv.authenticatedContext(VIEWER_A).firestore()
    await assertSucceeds(getDoc(doc(db, 'company_data', COMPANY_A)))
  })
  it('member reads own company doc', async () => {
    const db = testEnv.authenticatedContext(ACCOUNTANT_A).firestore()
    await assertSucceeds(getDoc(doc(db, 'companies', COMPANY_A)))
  })
})

// ── 4. Пользователь другой компании → отказ ─────────────────────────────────
describe('4. cross-company read denied', () => {
  it('admin B cannot read company_data of company A', async () => {
    const db = testEnv.authenticatedContext(ADMIN_B).firestore()
    await assertFails(getDoc(doc(db, 'company_data', COMPANY_A)))
  })
  it('admin B cannot read companies/A', async () => {
    const db = testEnv.authenticatedContext(ADMIN_B).firestore()
    await assertFails(getDoc(doc(db, 'companies', COMPANY_A)))
  })
})

// ── 5. self-update обычного профильного поля → разрешён ─────────────────────
describe('5. self-update of safe profile field', () => {
  it('viewer can update own name', async () => {
    const db = testEnv.authenticatedContext(VIEWER_A).firestore()
    await assertSucceeds(updateDoc(doc(db, 'users', VIEWER_A), { name: 'Viewer A Renamed' }))
  })
})

// ── 6-8. self-update role / companyId / companies[] → отказ (CRITICAL) ──────
describe('6-8. self-escalation via self-update is blocked', () => {
  it('cannot self-update role to admin', async () => {
    const db = testEnv.authenticatedContext(VIEWER_A).firestore()
    await assertFails(updateDoc(doc(db, 'users', VIEWER_A), { role: 'admin' }))
  })
  it('cannot self-update companyId to another company', async () => {
    const db = testEnv.authenticatedContext(VIEWER_A).firestore()
    await assertFails(updateDoc(doc(db, 'users', VIEWER_A), { companyId: COMPANY_B }))
  })
  it('cannot self-update companies[] to add another company as admin', async () => {
    const db = testEnv.authenticatedContext(VIEWER_A).firestore()
    await assertFails(updateDoc(doc(db, 'users', VIEWER_A), {
      companies: [{ companyId: COMPANY_B, role: 'admin' }],
    }))
  })
})

// ── 9. self-create с role: admin → отказ ─────────────────────────────────────
describe('9. self-create with privileged fields is blocked', () => {
  it('cannot create own profile with role admin + arbitrary companyId', async () => {
    const db = testEnv.authenticatedContext(ATTACKER_UID).firestore()
    await assertFails(setDoc(doc(db, 'users', ATTACKER_UID), {
      id: ATTACKER_UID, name: 'Attacker', email: 'attacker@example.test',
      role: 'admin', companyId: COMPANY_B, createdAt: '2026-01-01T00:00:00.000Z',
    }))
  })
  it('can create own profile without auth-sensitive fields', async () => {
    const db = testEnv.authenticatedContext(ATTACKER_UID).firestore()
    await assertSucceeds(setDoc(doc(db, 'users', ATTACKER_UID), {
      id: ATTACKER_UID, name: 'New User',
    }))
  })
})

// ── 10. удаление и повторное создание профиля с admin → отказ ───────────────
describe('10. delete + recreate bypass is blocked', () => {
  it('delete of own profile is denied outright', async () => {
    const db = testEnv.authenticatedContext(VIEWER_A).firestore()
    await assertFails(deleteDoc(doc(db, 'users', VIEWER_A)))
  })
  it('even if a profile did not exist, recreate with admin role is denied', async () => {
    const db = testEnv.authenticatedContext(ATTACKER_UID).firestore()
    await assertFails(setDoc(doc(db, 'users', ATTACKER_UID), {
      id: ATTACKER_UID, role: 'admin', companyId: COMPANY_A,
    }))
  })
})

// ── 11. viewer читает разрешённые данные ─────────────────────────────────────
describe('11. viewer read access', () => {
  it('viewer reads company_data of own company', async () => {
    const db = testEnv.authenticatedContext(VIEWER_A).firestore()
    await assertSucceeds(getDoc(doc(db, 'company_data', COMPANY_A)))
  })
})

// ── 12. viewer не записывает company_data ────────────────────────────────────
describe('12. viewer cannot write company_data', () => {
  it('viewer create denied', async () => {
    const db = testEnv.authenticatedContext(VIEWER_A).firestore()
    await assertFails(setDoc(doc(db, 'company_data', 'newco_synthetic'), { accounts: [] }))
  })
  it('viewer update denied', async () => {
    const db = testEnv.authenticatedContext(VIEWER_A).firestore()
    await assertFails(updateDoc(doc(db, 'company_data', COMPANY_A), { accounts: [] }))
  })
})

// ── 13. accountant выполняет только предусмотренные операции ────────────────
describe('13. accountant scoped operations', () => {
  it('accountant can update non-admin-only fields', async () => {
    const db = testEnv.authenticatedContext(ACCOUNTANT_A).firestore()
    await assertSucceeds(updateDoc(doc(db, 'company_data', COMPANY_A), { accounts: [{ id: 'acc1' }] }))
  })
  it('accountant cannot set closingDate (admin-only field)', async () => {
    const db = testEnv.authenticatedContext(ACCOUNTANT_A).firestore()
    await assertFails(updateDoc(doc(db, 'company_data', COMPANY_A), { closingDate: '2026-06-30' }))
  })
})

// ── 14. admin своей компании выполняет разрешённые операции ─────────────────
describe('14. admin scoped operations', () => {
  it('admin can set closingDate for own company', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertSucceeds(updateDoc(doc(db, 'company_data', COMPANY_A), { closingDate: '2026-06-30' }))
  })
  it('admin can update own company profile fields', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertSucceeds(updateDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A Renamed' }))
  })
})

// ── 15. поддельный admin другой компании получает отказ ─────────────────────
describe('15. forged admin of another company is denied', () => {
  it('admin B cannot update company A', async () => {
    const db = testEnv.authenticatedContext(ADMIN_B).firestore()
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_A), { name: 'Hijacked' }))
  })
  it('admin B cannot update company_data of A even with admin role', async () => {
    const db = testEnv.authenticatedContext(ADMIN_B).firestore()
    await assertFails(updateDoc(doc(db, 'company_data', COMPANY_A), { closingDate: '2026-06-30' }))
  })
})

// ── 16. list/query чужой компании получает отказ ─────────────────────────────
describe('16. cross-company list/query denied', () => {
  it('admin B cannot query users where companyId == A', async () => {
    const db = testEnv.authenticatedContext(ADMIN_B).firestore()
    await assertFails(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_A),
    )))
  })

  it('authenticated user cannot run an unscoped users collection query', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(getDocs(collection(db, 'users')))
  })

  it('admin A can query only users constrained to company A', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    const snap = await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_A),
    )))
    expect(snap.docs.length).toBe(3)
    expect(snap.docs.every(item => item.data().companyId === COMPANY_A)).toBe(true)
  })

  it('collection queries cannot enumerate companies', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(getDocs(collection(db, 'companies')))
  })

  it('collection queries cannot enumerate company_data', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(getDocs(collection(db, 'company_data')))
  })
})

// ── 17. create company_data без membership получает отказ ───────────────────
describe('17. create company_data without membership denied', () => {
  it('user with no profile cannot create company_data for any company', async () => {
    const db = testEnv.authenticatedContext(NO_PROFILE_UID).firestore()
    await assertFails(setDoc(doc(db, 'company_data', COMPANY_A), { accounts: [] }))
  })
  it('member of A cannot create company_data for B (not a member of B)', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(setDoc(doc(db, 'company_data', COMPANY_B), { accounts: [] }, { merge: true }))
  })
})

// ── 18. update company_data другой компании получает отказ ──────────────────
describe('18. update company_data of another company denied', () => {
  it('accountant A cannot update company_data of B', async () => {
    const db = testEnv.authenticatedContext(ACCOUNTANT_A).firestore()
    await assertFails(updateDoc(doc(db, 'company_data', COMPANY_B), { accounts: [] }))
  })
})

// ── 19. delete company_data получает отказ (для всех ролей) ─────────────────
describe('19. delete company_data always denied', () => {
  it('admin cannot delete own company_data', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(deleteDoc(doc(db, 'company_data', COMPANY_A)))
  })
})

// ── 20. admin одной компании не удаляет/не изменяет пользователя другой ─────
describe('20. admin cannot manage users of another company', () => {
  it('admin B cannot update role of accountant A', async () => {
    const db = testEnv.authenticatedContext(ADMIN_B).firestore()
    await assertFails(updateDoc(doc(db, 'users', ACCOUNTANT_A), { role: 'viewer' }))
  })
  it('admin B cannot delete user of company A', async () => {
    const db = testEnv.authenticatedContext(ADMIN_B).firestore()
    await assertFails(deleteDoc(doc(db, 'users', ACCOUNTANT_A)))
  })
  it('admin A (own company) also cannot update another user’s role client-side (emergency lockdown)', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(updateDoc(doc(db, 'users', VIEWER_A), { role: 'admin' }))
  })
})

// ── 21. CRITICAL-цепочка из BASE-004 полностью заблокирована ────────────────
describe('21. BASE-004 CRITICAL escalation chain is fully blocked', () => {
  it('full chain: self-update companyId + role admin, then act as admin of B — denied at step 1', async () => {
    const db = testEnv.authenticatedContext(VIEWER_A).firestore()
    // Step 1 of the original exploit chain must already fail.
    await assertFails(updateDoc(doc(db, 'users', VIEWER_A), {
      companyId: COMPANY_B, role: 'admin',
    }))
    // Even though step 1 failed, verify the downstream privilege (as if it
    // had somehow landed) is ALSO independently denied — defense in depth:
    // viewer_a's real (unchanged) profile still has companyId A / role viewer.
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_B), { name: 'Hijacked' }))
    await assertFails(getDoc(doc(db, 'company_data', COMPANY_B)))
  })

  it('HIGH: company_data create for a non-existent companyId without membership is denied', async () => {
    const db = testEnv.authenticatedContext(ATTACKER_UID).firestore()
    await assertFails(setDoc(doc(db, 'company_data', 'nonexistent_company_synthetic'), { accounts: [] }))
  })
})

// ── Позитивные сценарии приложения (не должно превратиться в deny-all) ──────
describe('positive application flows still work for legitimate same-company use', () => {
  it('admin reads the list of own-company colleagues (Users page)', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    const snap = await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_A),
    )))
    expect(snap.docs.length).toBe(3)
  })
  it('accountant can add a transaction (setDoc overwrite of company_data)', async () => {
    const db = testEnv.authenticatedContext(ACCOUNTANT_A).firestore()
    await assertSucceeds(setDoc(doc(db, 'company_data', COMPANY_A), {
      accounts: [], categories: [], counterparties: [],
      transactions: [{ id: 'tx1', amount: 100 }],
      projects: [], rules: [], budgets: [], recurring: [], paymentCalendar: [],
    }))
  })
  it('any authenticated user can create a brand-new company they own', async () => {
    const db = testEnv.authenticatedContext(ATTACKER_UID).firestore()
    await assertSucceeds(setDoc(doc(db, 'companies', 'brand_new_co_synthetic'), {
      id: 'brand_new_co_synthetic', name: 'New Co', legalType: 'ip',
      currency: 'RUB', createdAt: '2026-01-01T00:00:00.000Z', ownerId: ATTACKER_UID,
    }))
  })
  it('cannot create a new company claiming someone else as owner', async () => {
    const db = testEnv.authenticatedContext(ATTACKER_UID).firestore()
    await assertFails(setDoc(doc(db, 'companies', 'spoofed_owner_co_synthetic'), {
      id: 'spoofed_owner_co_synthetic', name: 'Spoofed', legalType: 'ip',
      currency: 'RUB', createdAt: '2026-01-01T00:00:00.000Z', ownerId: ADMIN_A,
    }))
  })
})

// ── Роли должны вычисляться отдельно для каждой компании ───────────────────
describe('per-company role isolation for companies[] memberships', () => {
  it('additional viewer can read company B', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'viewer' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(getDoc(doc(db, 'company_data', COMPANY_B)))
  })

  it('primary admin A remains only viewer in additional company B', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'viewer' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_B), { name: 'Escalated' }))
    await assertFails(updateDoc(doc(db, 'company_data', COMPANY_B), { accounts: [{ id: 'bad' }] }))
  })

  it('additional accountant can edit data but not company settings or closingDate', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'accountant' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(updateDoc(doc(db, 'company_data', COMPANY_B), {
      accounts: [{ id: 'accountant-ok' }],
    }))
    await assertFails(updateDoc(doc(db, 'company_data', COMPANY_B), {
      closingDate: '2026-06-30',
    }))
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_B), {
      name: 'Accountant Cannot Rename',
    }))
  })

  it('additional admin can edit company B and its closingDate', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'admin' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(updateDoc(doc(db, 'companies', COMPANY_B), {
      name: 'Admin B Rename',
    }))
    await assertSucceeds(updateDoc(doc(db, 'company_data', COMPANY_B), {
      closingDate: '2026-06-30',
    }))
  })
})

// ── Повреждённые memberships обрабатываются fail-closed ────────────────────
describe('companies[] membership validation is fail-closed', () => {
  it('membership without a role cannot grant access to company B', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDoc(doc(db, 'company_data', COMPANY_B)))
  })

  it('unknown role cannot grant access to company B', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'superadmin' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDoc(doc(db, 'company_data', COMPANY_B)))
  })

  it('null companies value cannot grant access and does not break primary membership', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: null,
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(getDoc(doc(db, 'company_data', COMPANY_A)))
    await assertFails(getDoc(doc(db, 'company_data', COMPANY_B)))
  })

  it('more than ten additional memberships are rejected', async () => {
    const memberships = Array.from({ length: 10 }, (_, index) => ({
      companyId: `dummy_company_${index}`,
      role: 'viewer',
    }))
    memberships.push({ companyId: COMPANY_B, role: 'admin' })
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: memberships,
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_B), {
      name: 'Eleventh Membership Must Fail',
    }))
  })

  it('a valid tenth additional membership remains usable', async () => {
    const memberships = Array.from({ length: 9 }, (_, index) => ({
      companyId: `dummy_company_${index}`,
      role: 'viewer',
    }))
    memberships.push({ companyId: COMPANY_B, role: 'admin' })
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: memberships,
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(updateDoc(doc(db, 'companies', COMPANY_B), {
      name: 'Tenth Membership Works',
    }))
  })

  it('conflicting roles for the same additional company deny all access', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [
        { companyId: COMPANY_B, role: 'viewer' },
        { companyId: COMPANY_B, role: 'admin' },
      ],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDoc(doc(db, 'company_data', COMPANY_B)))
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_B), {
      name: 'Conflicting Role Escalation',
    }))
  })

  it('an additional role conflicting with the primary role denies access', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_B,
      companies: [{ companyId: COMPANY_B, role: 'admin' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDoc(doc(db, 'company_data', COMPANY_B)))
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_B), {
      name: 'Primary Conflict Escalation',
    }))
  })

  it('duplicate identical viewer memberships do not elevate privileges', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [
        { companyId: COMPANY_B, role: 'viewer' },
        { companyId: COMPANY_B, role: 'viewer' },
      ],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(getDoc(doc(db, 'company_data', COMPANY_B)))
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_B), {
      name: 'Duplicate Viewer Escalation',
    }))
  })
})

// ── BASE-004A-FIX-02 ─────────────────────────────────────────────────────────
// Дефект: пользователь с валидным membership в ДОПОЛНИТЕЛЬНОЙ компании не мог
// выполнить query сотрудников этой компании — приложение выполняет РЕАЛЬНЫЙ
// query `where('companyId', '==', selectedCompanyId)` (вход с ранее выбранной
// доп. компанией, switchCompany(), загрузка списка сотрудников выбранной
// компании), а прежний `allow list` на users сравнивал ТОЛЬКО с
// `callerProfile().companyId` (основной компанией), из-за чего запрос для
// дополнительной компании получал permission-denied.
//
// baseline: на commit bfa23b6 (до исправления) тест
// "BASELINE (defect reproduction)" ниже padает с permission-denied — именно
// это и есть подтверждение дефекта, зафиксированное ДО правки firestore.rules
// (см. docs/remediation/reports/BASE-004A.md).
describe('BASE-004A-FIX-02: scoped member queries for additional companies', () => {
  it('BASELINE (defect reproduction): additional member of B can query B\'s employees — must now ALLOW', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'viewer' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    const snap = await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
    expect(snap.docs.some(d => d.id === ADMIN_B)).toBe(true)
  })

  // ── Позитивные ──────────────────────────────────────────────────────────
  it('1. primary-company member query still works', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    const snap = await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_A),
    )))
    expect(snap.docs.length).toBe(3)
  })

  it('3. additional admin role can query the additional company employees', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'admin' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
  })

  it('4. additional accountant role can query the additional company employees', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'accountant' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
  })

  it('5. additional viewer role can query the additional company employees', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'viewer' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
  })

  it('6. a valid membership at the tenth position can still query that company', async () => {
    const memberships = Array.from({ length: 9 }, (_, index) => ({
      companyId: `dummy_company_${index}`,
      role: 'viewer',
    }))
    memberships.push({ companyId: COMPANY_B, role: 'admin' })
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: memberships,
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
  })

  it('7. query matches the real switchCompany() app flow (where companyId == selected company)', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'accountant' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    const selectedCompanyId = COMPANY_B // as persisted by switchCompany() / LS_ACTIVE_COMPANY
    const snap = await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', selectedCompanyId),
    )))
    expect(snap.docs.every(d => d.data().companyId === COMPANY_B)).toBe(true)
  })

  // ── Негативные ──────────────────────────────────────────────────────────
  it('8. query for employees of a company the caller is not a member of at all — DENY', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'viewer' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_C),
    )))
  })

  it('9. query combining an allowed company and a foreign company (in-query) — DENY', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'viewer' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDocs(query(
      collection(db, 'users'),
      where('companyId', 'in', [COMPANY_A, COMPANY_C]),
    )))
  })

  it('10. unrestricted getDocs(collection(users)) remains denied for a multi-company member', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'viewer' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDocs(collection(db, 'users')))
  })

  it('11. unrestricted query with only a limit() (no companyId constraint) — DENY', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(getDocs(query(collection(db, 'users'), limit(5))))
  })

  it('12. orderBy without a companyId constraint — DENY', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(getDocs(query(collection(db, 'users'), orderBy('name'))))
  })

  it('13. direct get() of a user in a company the caller has no membership in — DENY', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'viewer' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDoc(doc(db, 'users', ADMIN_C)))
  })

  it('14. additional membership with an unknown role cannot query that company', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'superadmin' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
  })

  it('15. membership missing companyId cannot grant a query for any company', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [{ role: 'admin' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
  })

  it('16. a null element inside companies[] is ignored fail-closed, primary access unaffected', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [null],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_A),
    )))
    await assertFails(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
  })

  it('17. companies[] of the wrong type (string, not a list) is fail-closed', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: 'not-a-list',
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_A),
    )))
    await assertFails(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
  })

  it('19. more than ten additional memberships denies the query for the extra company', async () => {
    const memberships = Array.from({ length: 10 }, (_, index) => ({
      companyId: `dummy_company_${index}`,
      role: 'viewer',
    }))
    memberships.push({ companyId: COMPANY_B, role: 'admin' })
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: memberships,
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
  })

  it('20. admin of A / viewer of B does not get admin-level access in B via query-adjacent write', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'viewer' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertSucceeds(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_B),
    )))
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_B), { name: 'Should not work' }))
    await assertFails(updateDoc(doc(db, 'company_data', COMPANY_B), { closingDate: '2026-06-30' }))
  })

  it('21. member of additional company B gets no access at all to unrelated company C', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'admin',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'admin' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(getDocs(query(
      collection(db, 'users'),
      where('companyId', '==', COMPANY_C),
    )))
    await assertFails(getDoc(doc(db, 'companies', COMPANY_C)))
    await assertFails(getDoc(doc(db, 'company_data', COMPANY_C)))
  })

  it('22. cannot self-update auth-sensitive fields while holding an additional membership', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'admin' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(updateDoc(doc(db, 'users', MULTI_COMPANY_UID), { role: 'admin' }))
    await assertFails(updateDoc(doc(db, 'users', MULTI_COMPANY_UID), { companyId: COMPANY_B }))
    await assertFails(updateDoc(doc(db, 'users', MULTI_COMPANY_UID), {
      companies: [{ companyId: COMPANY_C, role: 'admin' }],
    }))
    await assertFails(updateDoc(doc(db, 'users', MULTI_COMPANY_UID), { id: ATTACKER_UID }))
    await assertFails(updateDoc(doc(db, 'users', MULTI_COMPANY_UID), { email: 'new@example.test' }))
  })

  it('23. admin of the additional company cannot spoof/change companies.ownerId', async () => {
    await seedUser(MULTI_COMPANY_UID, {
      role: 'viewer',
      companyId: COMPANY_A,
      companies: [{ companyId: COMPANY_B, role: 'admin' }],
    })
    const db = testEnv.authenticatedContext(MULTI_COMPANY_UID).firestore()
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_B), { ownerId: MULTI_COMPANY_UID }))
  })
})

// ── SEC-005 production preflight — maintenance mode blocks client writes ────
describe('SEC-005 production preflight: maintenance mode blocks client writes', () => {
  async function setMaintenanceMode(enabled: boolean): Promise<void> {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), 'system', 'maintenance'), { enabled, taskId: 'SEC-005' })
    })
  }

  it('client cannot create a new company while maintenance mode is active', async () => {
    await setMaintenanceMode(true)
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(setDoc(doc(db, 'companies', 'new_co_synthetic'), {
      id: 'new_co_synthetic', ownerId: ADMIN_A,
    }))
  })

  it('client cannot update an existing company while maintenance mode is active', async () => {
    await setMaintenanceMode(true)
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(updateDoc(doc(db, 'companies', COMPANY_A), { name: 'Renamed during maintenance' }))
  })

  it('client cannot self-create a users/{uid} profile while maintenance mode is active', async () => {
    await setMaintenanceMode(true)
    const db = testEnv.authenticatedContext(NO_PROFILE_UID).firestore()
    await assertFails(setDoc(doc(db, 'users', NO_PROFILE_UID), { id: NO_PROFILE_UID }))
  })

  it('client cannot self-update a users/{uid} profile field while maintenance mode is active', async () => {
    await setMaintenanceMode(true)
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(updateDoc(doc(db, 'users', ADMIN_A), { name: 'Renamed during maintenance' }))
  })

  it('client cannot create/update company_data while maintenance mode is active', async () => {
    await setMaintenanceMode(true)
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(updateDoc(doc(db, 'company_data', COMPANY_A), { closingDate: '2026-06-30' }))
  })

  it('reads still work while maintenance mode is active — only writes are blocked', async () => {
    await setMaintenanceMode(true)
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertSucceeds(getDoc(doc(db, 'companies', COMPANY_A)))
  })

  it('writes work normally once maintenance mode is explicitly disabled again', async () => {
    await setMaintenanceMode(true)
    await setMaintenanceMode(false)
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertSucceeds(updateDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A Renamed' }))
  })

  it('writes work normally when system/maintenance does not exist at all (the default, pre-runbook state)', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertSucceeds(updateDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A Renamed' }))
  })

  it('system/maintenance itself is never client-writable, even by an admin, even outside maintenance mode', async () => {
    const db = testEnv.authenticatedContext(ADMIN_A).firestore()
    await assertFails(setDoc(doc(db, 'system', 'maintenance'), { enabled: false }))
  })
})

// ── 22. SEC-006 Stage 1: invitations/invitationLocks are fully server-only ──
//
// Both collections are written/read exclusively by trusted Cloud Functions
// via the Admin SDK (which is not subject to these Rules at all) — see
// firestore.rules' own comment above these two match blocks, and
// docs/adr/001-company-membership-and-roles.md. No client, including an
// admin of the invitation's own company, may read or write either
// collection directly. This describe block exists purely to prove the
// deny-all Rules — no callable exists yet (Stage 1 is model/schema/Rules
// only), so these tests seed synthetic documents directly (bypassing
// Rules) and assert every client access path is denied.
describe('22. invitations/invitationLocks are fully server-only (SEC-006 Stage 1)', () => {
  const INVITE_ID = 'invite_synthetic_01'
  const LOCK_ID = 'lock_synthetic_01'

  const SYNTHETIC_INVITATION = {
    companyId: COMPANY_A,
    emailNormalized: 'invitee@example.test',
    role: 'viewer',
    tokenHash: '0'.repeat(64),
    status: 'pending',
    expiresAt: '2026-06-08T00:00:00.000Z',
    createdBy: ADMIN_A,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    acceptedAt: null,
    acceptedByUid: null,
    revokedAt: null,
    revokedBy: null,
    resendCount: 0,
    lastSentAt: null,
  }

  const SYNTHETIC_LOCK = { currentInviteId: INVITE_ID }

  async function seedInvitationAndLock(): Promise<void> {
    await testEnv.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore()
      await Promise.all([
        setDoc(doc(db, 'invitations', INVITE_ID), SYNTHETIC_INVITATION),
        setDoc(doc(db, 'invitationLocks', LOCK_ID), SYNTHETIC_LOCK),
      ])
    })
  }

  // (actor label, context factory) — covers all four required actor rows:
  // unauthenticated, authenticated non-admin (of the invitation's own
  // company), admin of a DIFFERENT company, admin of the SAME company.
  const ACTORS: Array<[string, () => ReturnType<typeof testEnv.authenticatedContext> | ReturnType<typeof testEnv.unauthenticatedContext>]> = [
    ['unauthenticated', () => testEnv.unauthenticatedContext()],
    ['authenticated non-admin (viewer of the same company)', () => testEnv.authenticatedContext(VIEWER_A)],
    ['admin of a different company', () => testEnv.authenticatedContext(ADMIN_B)],
    ['admin of the same company as the invitation', () => testEnv.authenticatedContext(ADMIN_A)],
  ]

  describe('invitations/{inviteId}', () => {
    beforeEach(seedInvitationAndLock)

    for (const [label, ctx] of ACTORS) {
      it(`${label}: get denied`, async () => {
        const db = ctx().firestore()
        await assertFails(getDoc(doc(db, 'invitations', INVITE_ID)))
      })

      it(`${label}: list/query denied`, async () => {
        const db = ctx().firestore()
        await assertFails(getDocs(query(collection(db, 'invitations'), where('companyId', '==', COMPANY_A))))
      })

      it(`${label}: create denied`, async () => {
        const db = ctx().firestore()
        await assertFails(setDoc(doc(db, 'invitations', 'invite_attacker_created'), SYNTHETIC_INVITATION))
      })

      it(`${label}: update denied`, async () => {
        const db = ctx().firestore()
        await assertFails(updateDoc(doc(db, 'invitations', INVITE_ID), { status: 'revoked' }))
      })

      it(`${label}: delete denied`, async () => {
        const db = ctx().firestore()
        await assertFails(deleteDoc(doc(db, 'invitations', INVITE_ID)))
      })
    }
  })

  describe('invitationLocks/{lockId}', () => {
    beforeEach(seedInvitationAndLock)

    for (const [label, ctx] of ACTORS) {
      it(`${label}: get denied`, async () => {
        const db = ctx().firestore()
        await assertFails(getDoc(doc(db, 'invitationLocks', LOCK_ID)))
      })

      it(`${label}: list/query denied`, async () => {
        const db = ctx().firestore()
        await assertFails(getDocs(query(collection(db, 'invitationLocks'), limit(10))))
      })

      it(`${label}: create denied`, async () => {
        const db = ctx().firestore()
        await assertFails(setDoc(doc(db, 'invitationLocks', 'lock_attacker_created'), SYNTHETIC_LOCK))
      })

      it(`${label}: update denied`, async () => {
        const db = ctx().firestore()
        await assertFails(updateDoc(doc(db, 'invitationLocks', LOCK_ID), { currentInviteId: 'invite_attacker_swap' }))
      })

      it(`${label}: delete denied`, async () => {
        const db = ctx().firestore()
        await assertFails(deleteDoc(doc(db, 'invitationLocks', LOCK_ID)))
      })
    }
  })
})
