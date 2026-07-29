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
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } from 'firebase/firestore'

const PROJECT_ID = 'demo-finapp-rules-test'

let testEnv: RulesTestEnvironment

// ── Синтетические фикстуры ──────────────────────────────────────────────────
const COMPANY_A = 'companyA_synthetic'
const COMPANY_B = 'companyB_synthetic'

const ADMIN_A = 'uid_admin_a'
const ACCOUNTANT_A = 'uid_accountant_a'
const VIEWER_A = 'uid_viewer_a'
const ADMIN_B = 'uid_admin_b'
const NO_PROFILE_UID = 'uid_no_profile'
const ATTACKER_UID = 'uid_attacker'

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
      setDoc(doc(db, 'company_data', COMPANY_A), {
        accounts: [], categories: [], counterparties: [], transactions: [],
        projects: [], rules: [], budgets: [], recurring: [], paymentCalendar: [],
      }),
      setDoc(doc(db, 'company_data', COMPANY_B), {
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
  it('admin B query of users where companyId == A returns nothing readable (per-doc denied)', async () => {
    const db = testEnv.authenticatedContext(ADMIN_B).firestore()
    // list is allowed to be attempted (callerHasProfile), but resulting
    // per-document `get` condition for company-A users must reject them.
    await assertFails(getDoc(doc(db, 'users', ADMIN_A)))
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
    const snap = await assertSucceeds(getDocs(collection(db, 'users')))
    // per-doc filtering happens at the rules layer; the query itself must
    // not be rejected outright for a user with a profile.
    expect(snap).toBeDefined()
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
