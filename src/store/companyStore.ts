import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore'
import { db, auth } from '../lib/firebase'
import { subscribeAuth, authStore } from './authStore'
import { round2 } from '../utils/currency'
import type { Account, Category, Counterparty, Transaction, Project, TransactionRule, BudgetItem, SplitPart, RecurringTemplate, RecurringPeriod, PaymentCalendarItem } from '../types'

const DEFAULT_CATEGORIES: Category[] = [
  { id: 'cat_inc1', name: 'Выручка от клиентов', type: 'income',   icon: 'TrendingUp',     color: '#22c55e' },
  { id: 'cat_inc2', name: 'Прочие доходы',        type: 'income',   icon: 'BarChart2',      color: '#10b981' },
  { id: 'cat_inc3', name: 'Займы полученные',      type: 'income',   icon: 'Banknote',       color: '#6ee7b7' },
  { id: 'cat_exp1', name: 'Зарплата',              type: 'expense',  icon: 'Users',          color: '#ef4444' },
  { id: 'cat_exp2', name: 'Аренда',                type: 'expense',  icon: 'Building2',      color: '#f97316' },
  { id: 'cat_exp3', name: 'Реклама и маркетинг',   type: 'expense',  icon: 'Megaphone',      color: '#a855f7' },
  { id: 'cat_exp4', name: 'Закупка товаров',        type: 'expense',  icon: 'Package',        color: '#3b82f6' },
  { id: 'cat_exp5', name: 'Налоги',                type: 'expense',  icon: 'Landmark',       color: '#64748b' },
  { id: 'cat_exp6', name: 'Связь и интернет',      type: 'expense',  icon: 'Wifi',           color: '#06b6d4' },
  { id: 'cat_exp7', name: 'Командировки',          type: 'expense',  icon: 'Plane',          color: '#8b5cf6' },
  { id: 'cat_tr1',  name: 'Внутренний перевод',    type: 'transfer', icon: 'ArrowLeftRight', color: '#94a3b8' },
]

interface CompanyData {
  accounts:        Account[]
  categories:      Category[]
  counterparties:  Counterparty[]
  transactions:    Transaction[]
  projects:        Project[]
  rules:           TransactionRule[]
  budgets:         BudgetItem[]
  recurring:       RecurringTemplate[]
  paymentCalendar: PaymentCalendarItem[]
  closingDate?:    string   // период закрыт по эту дату включ.: операции <= неё нельзя менять/удалять (БАГ №6)
  _savedAt?:       number   // метка времени последней записи — для выбора более свежей версии (localStorage vs Firestore)
}

const EMPTY: CompanyData = {
  accounts: [], categories: DEFAULT_CATEGORIES, counterparties: [],
  transactions: [], projects: [], rules: [], budgets: [], recurring: [],
  paymentCalendar: [],
}

// ── Pub/sub ──────────────────────────────────────────────────────────────────
type Listener = () => void
const listeners = new Set<Listener>()
function notify() { listeners.forEach(fn => fn()) }

// ── localStorage ключи ───────────────────────────────────────────────────────
const lsKey        = (id: string) => `company_data_${id}`
const LS_LAST_ID   = 'finapp_last_company_id'

// ── In-memory state ──────────────────────────────────────────────────────────
let currentCompanyId: string | null = null
let state: CompanyData = { ...EMPTY }
let unsubSnapshot: (() => void) | null = null

// ── Предзагрузка из localStorage при старте модуля ────────────────────────────
// Данные доступны СРАЗУ, до того как Firebase вернёт авторизацию.
// Это исключает "мигание" пустого состояния при загрузке страницы.
;(function preload() {
  try {
    const lastId = localStorage.getItem(LS_LAST_ID)
    if (!lastId) return
    const raw = localStorage.getItem(lsKey(lastId))
    if (!raw) return
    const saved = JSON.parse(raw) as CompanyData
    if (!saved.rules)           saved.rules           = []
    if (!saved.budgets)         saved.budgets         = []
    if (!saved.recurring)       saved.recurring       = []
    if (!saved.paymentCalendar) saved.paymentCalendar = []
    if (!saved.categories)      saved.categories      = DEFAULT_CATEGORIES
    state            = saved
    currentCompanyId = lastId   // ← чтобы persist() работал сразу
  } catch { /* повреждённые данные в localStorage — остаёмся с пустым состоянием */ }
})()

// ── Persist: localStorage (всегда) + Firestore (кросс-устройства) ────────────
function persist() {
  // Используем company ID если есть, иначе UID Firebase Auth как запасной ключ.
  // Это гарантирует сохранение данных даже если companies/{id} не существует в Firestore.
  const saveId = currentCompanyId ?? auth.currentUser?.uid ?? null

  if (saveId) {
    state._savedAt = Date.now()
    // 1. localStorage — мгновенно, никогда не падает
    try {
      localStorage.setItem(LS_LAST_ID, saveId)
      localStorage.setItem(lsKey(saveId), JSON.stringify(state))
    } catch (e) {
      console.error('[companyStore] localStorage write error:', e)
    }
    // 2. Firestore — фоновая синхронизация между устройствами
    setDoc(doc(db, 'company_data', saveId), state).catch(err => {
      console.error('[companyStore] Firestore write error:', err)
    })
    console.debug('[companyStore] persist() saved with id:', saveId, 'accounts:', state.accounts.length)
  } else {
    console.warn('[companyStore] persist() skipped — no saveId (currentCompanyId and auth.currentUser are both null)')
  }
  notify()
}

function savedAt(d: CompanyData): number { return d._savedAt ?? 0 }

// Период закрыт: операцию с датой <= closingDate нельзя менять или удалять (БАГ №6)
function isPeriodLocked(dateStr: string): boolean {
  return !!state.closingDate && dateStr <= state.closingDate
}

function advanceDate(dateStr: string, period: RecurringPeriod): string {
  const d = new Date(dateStr)
  switch (period) {
    case 'weekly':    d.setDate(d.getDate() + 7);       break
    case 'monthly':   d.setMonth(d.getMonth() + 1);     break
    case 'quarterly': d.setMonth(d.getMonth() + 3);     break
    case 'yearly':    d.setFullYear(d.getFullYear() + 1); break
  }
  return d.toISOString().slice(0, 10)
}

const companyStoreImpl = {
  // ── Init: load data + subscribe to real-time changes ──────────────────────
  async init(companyId: string) {
    if (currentCompanyId === companyId && unsubSnapshot !== null) return
    currentCompanyId = companyId

    // Unsubscribe previous listener
    if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null }

    // 1. Сначала данные из localStorage — мгновенно, без ожидания сети
    const lsRaw = localStorage.getItem(lsKey(companyId))
    if (lsRaw) {
      try {
        const lsData = JSON.parse(lsRaw) as CompanyData
        if (!lsData.rules)           lsData.rules           = []
        if (!lsData.budgets)         lsData.budgets         = []
        if (!lsData.recurring)       lsData.recurring       = []
        if (!lsData.paymentCalendar) lsData.paymentCalendar = []
        if (!lsData.categories)      lsData.categories      = DEFAULT_CATEGORIES
        state = lsData
        notify()
      } catch { /* повреждённые данные в localStorage — пропускаем, ждём Firestore */ }
    }

    // 2. Затем данные из Firestore — актуальная версия с других устройств
    // Берём Firestore только если его timestamp >= localStorage (он новее или равен)
    // Это защищает от случая когда Firestore пуст/устарел и затирает свежие локальные данные
    try {
      const snap = await getDoc(doc(db, 'company_data', companyId))
      if (snap.exists()) {
        const fresh = snap.data() as CompanyData
        if (!fresh.rules)           fresh.rules           = []
        if (!fresh.budgets)         fresh.budgets         = []
        if (!fresh.recurring)       fresh.recurring       = []
        if (!fresh.paymentCalendar) fresh.paymentCalendar = []
        if (!fresh.categories)      fresh.categories      = DEFAULT_CATEGORIES
        if (savedAt(fresh) >= savedAt(state)) {
          state = fresh
          notify()
        }
      } else if (!lsRaw) {
        state = { ...EMPTY }
        notify()
      }
    } catch (err) {
      console.error('[companyStore] Firestore load error:', err)
    }

    // 3. Real-time listener — синхронизация между устройствами и вкладками
    unsubSnapshot = onSnapshot(
      doc(db, 'company_data', companyId),
      docSnap => {
        if (docSnap.exists()) {
          const fresh = docSnap.data() as CompanyData
          if (!fresh.rules)           fresh.rules           = []
          if (!fresh.budgets)         fresh.budgets         = []
          if (!fresh.recurring)       fresh.recurring       = []
          if (!fresh.paymentCalendar) fresh.paymentCalendar = []
          if (!fresh.categories)      fresh.categories      = DEFAULT_CATEGORIES
          // Принимаем только если Firestore новее текущего состояния
          if (savedAt(fresh) >= savedAt(state)) {
            state = fresh
            notify()
          }
        }
      },
      err => { console.error('[companyStore] Firestore snapshot error:', err) },
    )
  },

  // ── Getters ───────────────────────────────────────────────────────────────
  get accounts()       { return state.accounts        },
  get categories()     { return state.categories      },
  get counterparties() { return state.counterparties  },
  get transactions()   { return state.transactions    },
  get projects()       { return state.projects        },
  get rules()          { return state.rules     ?? [] },
  get budgets()        { return state.budgets   ?? [] },
  get recurring()        { return state.recurring        ?? [] },
  get paymentCalendar()  { return state.paymentCalendar  ?? [] },
  get closingDate()      { return state.closingDate      ?? '' },
  isPeriodLocked(dateStr: string) { return isPeriodLocked(dateStr) },
  setClosingDate(date: string) {
    const next = { ...state }
    if (date) next.closingDate = date
    else delete next.closingDate
    state = next
    persist()
  },
  get allTags()        {
    const set = new Set<string>()
    for (const t of state.transactions) for (const tag of (t.tags ?? [])) set.add(tag)
    return [...set].sort()
  },

  // ── Transactions ──────────────────────────────────────────────────────────
  addTransaction(t: Transaction) {
    state = {
      ...state,
      transactions: [t, ...state.transactions],
      accounts: state.accounts.map(a => {
        if (t.type === 'income'   && a.id === t.accountId)   return { ...a, balance: round2(a.balance + t.amount) }
        if (t.type === 'expense'  && a.id === t.accountId)   return { ...a, balance: round2(a.balance - t.amount) }
        if (t.type === 'transfer') {
          if (a.id === t.accountId)   return { ...a, balance: round2(a.balance - t.amount) }
          // Cross-currency transfer: credit toAmount (if set) else amount
          if (a.id === t.toAccountId) return { ...a, balance: round2(a.balance + (t.toAmount ?? t.amount)) }
        }
        return a
      }),
    }
    persist()
  },

  deleteTransaction(id: string) {
    const t = state.transactions.find(x => x.id === id)
    if (!t) return
    if (isPeriodLocked(t.date)) return   // период закрыт (БАГ №6)
    state = {
      ...state,
      transactions: state.transactions.filter(x => x.id !== id),
      accounts: state.accounts.map(a => {
        if (t.type === 'income'   && a.id === t.accountId)   return { ...a, balance: round2(a.balance - t.amount) }
        if (t.type === 'expense'  && a.id === t.accountId)   return { ...a, balance: round2(a.balance + t.amount) }
        if (t.type === 'transfer') {
          if (a.id === t.accountId)   return { ...a, balance: round2(a.balance + t.amount) }
          if (a.id === t.toAccountId) return { ...a, balance: round2(a.balance - (t.toAmount ?? t.amount)) }
        }
        return a
      }),
    }
    persist()
  },

  deleteTransactions(ids: string[]) {
    // Из закрытого периода удалять нельзя — отбрасываем такие id (БАГ №6)
    const removable = ids.filter(id => {
      const t = state.transactions.find(x => x.id === id)
      return t && !isPeriodLocked(t.date)
    })
    const idSet = new Set(removable)
    let { accounts, transactions } = state
    for (const id of removable) {
      const t = transactions.find(x => x.id === id)
      if (!t) continue
      accounts = accounts.map(a => {
        if (t.type === 'income'  && a.id === t.accountId)   return { ...a, balance: round2(a.balance - t.amount) }
        if (t.type === 'expense' && a.id === t.accountId)   return { ...a, balance: round2(a.balance + t.amount) }
        if (t.type === 'transfer') {
          if (a.id === t.accountId)   return { ...a, balance: round2(a.balance + t.amount) }
          if (a.id === t.toAccountId) return { ...a, balance: round2(a.balance - (t.toAmount ?? t.amount)) }
        }
        return a
      })
    }
    transactions = transactions.filter(x => !idSet.has(x.id))
    state = { ...state, transactions, accounts }
    persist()
  },

  updateTransaction(id: string, changes: Partial<Omit<Transaction, 'id'>>) {
    const old = state.transactions.find(x => x.id === id)
    if (!old) return
    // Нельзя менять операцию закрытого периода или переносить её в закрытый период (БАГ №6)
    if (isPeriodLocked(old.date) || (changes.date != null && isPeriodLocked(changes.date))) return
    const updated: Transaction = { ...old, ...changes }
    let accounts = state.accounts.map(a => {
      if (old.type === 'income'  && a.id === old.accountId)   return { ...a, balance: round2(a.balance - old.amount) }
      if (old.type === 'expense' && a.id === old.accountId)   return { ...a, balance: round2(a.balance + old.amount) }
      if (old.type === 'transfer') {
        if (a.id === old.accountId)   return { ...a, balance: round2(a.balance + old.amount) }
        if (a.id === old.toAccountId) return { ...a, balance: round2(a.balance - (old.toAmount ?? old.amount)) }
      }
      return a
    })
    accounts = accounts.map(a => {
      if (updated.type === 'income'  && a.id === updated.accountId)   return { ...a, balance: round2(a.balance + updated.amount) }
      if (updated.type === 'expense' && a.id === updated.accountId)   return { ...a, balance: round2(a.balance - updated.amount) }
      if (updated.type === 'transfer') {
        if (a.id === updated.accountId)   return { ...a, balance: round2(a.balance - updated.amount) }
        if (a.id === updated.toAccountId) return { ...a, balance: round2(a.balance + (updated.toAmount ?? updated.amount)) }
      }
      return a
    })
    state = { ...state, transactions: state.transactions.map(x => x.id === id ? updated : x), accounts }
    persist()
  },

  batchUpdateTransactions(updates: { id: string; changes: Partial<Omit<Transaction, 'id'>> }[]) {
    let { transactions, accounts } = state
    for (const { id, changes } of updates) {
      const old = transactions.find(x => x.id === id)
      if (!old) continue
      if (isPeriodLocked(old.date) || (changes.date != null && isPeriodLocked(changes.date))) continue   // период закрыт (БАГ №6)
      const updated: Transaction = { ...old, ...changes }
      accounts = accounts.map(a => {
        if (old.type === 'income'  && a.id === old.accountId)   return { ...a, balance: round2(a.balance - old.amount) }
        if (old.type === 'expense' && a.id === old.accountId)   return { ...a, balance: round2(a.balance + old.amount) }
        if (old.type === 'transfer') {
          if (a.id === old.accountId)   return { ...a, balance: round2(a.balance + old.amount) }
          if (a.id === old.toAccountId) return { ...a, balance: round2(a.balance - (old.toAmount ?? old.amount)) }
        }
        return a
      })
      accounts = accounts.map(a => {
        if (updated.type === 'income'  && a.id === updated.accountId)   return { ...a, balance: round2(a.balance + updated.amount) }
        if (updated.type === 'expense' && a.id === updated.accountId)   return { ...a, balance: round2(a.balance - updated.amount) }
        if (updated.type === 'transfer') {
          if (a.id === updated.accountId)   return { ...a, balance: round2(a.balance - updated.amount) }
          if (a.id === updated.toAccountId) return { ...a, balance: round2(a.balance + (updated.toAmount ?? updated.amount)) }
        }
        return a
      })
      transactions = transactions.map(t => t.id === id ? updated : t)
    }
    state = { ...state, transactions, accounts }
    persist()
  },

  // ── Accounts ──────────────────────────────────────────────────────────────
  addAccount(a: Account) {
    state = { ...state, accounts: [...state.accounts, a] }
    persist()
  },
  deleteAccount(id: string) {
    // Защита: нельзя удалить счёт с привязанными операциями — иначе они осиротеют (БАГ № 6)
    const hasTx = state.transactions.some(t => t.accountId === id || t.toAccountId === id)
    if (hasTx) {
      console.warn('[companyStore] deleteAccount отклонён: к счёту привязаны операции', id)
      return
    }
    state = { ...state, accounts: state.accounts.filter(a => a.id !== id) }
    persist()
  },
  updateAccount(id: string, changes: Partial<Omit<Account, 'id'>>) {
    state = { ...state, accounts: state.accounts.map(a => a.id === id ? { ...a, ...changes } : a) }
    persist()
  },

  // ── Counterparties ────────────────────────────────────────────────────────
  addCounterparty(cp: Counterparty) {
    state = { ...state, counterparties: [...state.counterparties, cp] }
    persist()
  },
  deleteCounterparty(id: string) {
    // Каскад: убираем ссылку у операций, чтобы не было «висячих» counterpartyId (БАГ №10)
    state = {
      ...state,
      counterparties: state.counterparties.filter(c => c.id !== id),
      transactions: state.transactions.map(t => t.counterpartyId === id ? { ...t, counterpartyId: undefined } : t),
    }
    persist()
  },
  deleteCounterparties(ids: string[]) {
    const s = new Set(ids)
    state = {
      ...state,
      counterparties: state.counterparties.filter(c => !s.has(c.id)),
      transactions: state.transactions.map(t => t.counterpartyId && s.has(t.counterpartyId) ? { ...t, counterpartyId: undefined } : t),
    }
    persist()
  },
  updateCounterparty(id: string, changes: Partial<Omit<Counterparty, 'id'>>) {
    state = { ...state, counterparties: state.counterparties.map(c => c.id === id ? { ...c, ...changes } : c) }
    persist()
  },

  // ── Categories ────────────────────────────────────────────────────────────
  addCategory(cat: Category) {
    state = { ...state, categories: [...state.categories, cat] }
    persist()
  },
  updateCategory(id: string, changes: Partial<Omit<Category, 'id'>>) {
    state = { ...state, categories: state.categories.map(c => c.id === id ? { ...c, ...changes } : c) }
    persist()
  },
  deleteCategory(id: string) {
    state = { ...state, categories: state.categories.filter(c => c.id !== id) }
    persist()
  },

  // ── Projects ──────────────────────────────────────────────────────────────
  addProject(p: Project) {
    state = { ...state, projects: [...state.projects, p] }
    persist()
  },
  updateProject(id: string, changes: Partial<Omit<Project, 'id'>>) {
    state = { ...state, projects: state.projects.map(p => p.id === id ? { ...p, ...changes } : p) }
    persist()
  },
  deleteProject(id: string) {
    // Каскад: убираем projectId у операций и шаблонов (БАГ №10)
    state = {
      ...state,
      projects: state.projects.filter(p => p.id !== id),
      transactions: state.transactions.map(t => t.projectId === id ? { ...t, projectId: undefined } : t),
      recurring: (state.recurring ?? []).map(r => r.projectId === id ? { ...r, projectId: undefined } : r),
    }
    persist()
  },

  // ── Budgets ───────────────────────────────────────────────────────────────
  upsertBudget(categoryId: string, month: string, planned: number) {
    const budgets = state.budgets ?? []
    const existing = budgets.find(b => b.categoryId === categoryId && b.month === month)
    if (existing) {
      state = { ...state, budgets: budgets.map(b => b.id === existing.id ? { ...b, planned } : b) }
    } else {
      state = { ...state, budgets: [...budgets, { id: 'b' + Date.now(), categoryId, month, planned, actual: 0 }] }
    }
    persist()
  },
  deleteBudget(categoryId: string, month: string) {
    state = { ...state, budgets: (state.budgets ?? []).filter(b => !(b.categoryId === categoryId && b.month === month)) }
    persist()
  },

  // ── Recurring templates ───────────────────────────────────────────────────
  addRecurring(t: RecurringTemplate) {
    state = { ...state, recurring: [...(state.recurring ?? []), t] }
    persist()
  },
  updateRecurring(id: string, changes: Partial<Omit<RecurringTemplate, 'id'>>) {
    state = { ...state, recurring: (state.recurring ?? []).map(r => r.id === id ? { ...r, ...changes } : r) }
    persist()
  },
  deleteRecurring(id: string) {
    state = { ...state, recurring: (state.recurring ?? []).filter(r => r.id !== id) }
    persist()
  },
  // Создаёт реальную транзакцию из шаблона и сдвигает nextDate на следующий период
  executeRecurring(id: string) {
    const tmpl = (state.recurring ?? []).find(r => r.id === id)
    if (!tmpl || !tmpl.enabled) return
    const tx: Transaction = {
      id: 'tx' + Date.now(),
      date: tmpl.nextDate,
      type: tmpl.type,
      amount: tmpl.amount,
      accountId: tmpl.accountId,
      categoryId: tmpl.categoryId,
      counterpartyId: tmpl.counterpartyId,
      projectId: tmpl.projectId,
      comment: tmpl.comment,
      tags: [],
    }
    // Advance nextDate by period
    const next = advanceDate(tmpl.nextDate, tmpl.period)
    const expired = tmpl.endDate && next > tmpl.endDate
    // Add transaction + update template
    let { transactions, accounts, recurring } = state
    accounts = accounts.map(a => {
      if (tx.type === 'income'  && a.id === tx.accountId) return { ...a, balance: round2(a.balance + tx.amount) }
      if (tx.type === 'expense' && a.id === tx.accountId) return { ...a, balance: round2(a.balance - tx.amount) }
      return a
    })
    transactions = [tx, ...transactions]
    recurring = (recurring ?? []).map(r =>
      r.id === id ? { ...r, nextDate: next, enabled: expired ? false : r.enabled } : r
    )
    state = { ...state, transactions, accounts, recurring }
    persist()
  },

  // ── Split transaction ─────────────────────────────────────────────────────
  // Удаляет оригинальную операцию и создаёт N частей с общим splitId.
  // Баланс счёта не меняется, т.к. сумма частей == сумма оригинала.
  splitTransaction(originalId: string, parts: SplitPart[]) {
    const original = state.transactions.find(t => t.id === originalId)
    if (!original || parts.length < 2) return
    if (isPeriodLocked(original.date)) return   // период закрыт (БАГ №6)

    const splitId = 'sp' + Date.now()
    const ts = Date.now()

    // Удаляем оригинал из списка (без пересчёта баланса — он компенсируется частями)
    let { transactions, accounts } = state

    // Реверсируем баланс от оригинала
    accounts = accounts.map(a => {
      if (original.type === 'income'  && a.id === original.accountId) return { ...a, balance: round2(a.balance - original.amount) }
      if (original.type === 'expense' && a.id === original.accountId) return { ...a, balance: round2(a.balance + original.amount) }
      return a
    })

    transactions = transactions.filter(t => t.id !== originalId)

    // Добавляем части
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      const newTx: Transaction = {
        ...original,
        id: `${splitId}_${i}_${ts + i}`,
        amount: p.amount,
        categoryId: p.categoryId,
        comment: p.comment ?? original.comment,
        projectId: p.projectId ?? original.projectId,
        tags: original.tags,
        splitId,
      }
      transactions = [newTx, ...transactions]
      accounts = accounts.map(a => {
        if (original.type === 'income'  && a.id === original.accountId) return { ...a, balance: round2(a.balance + p.amount) }
        if (original.type === 'expense' && a.id === original.accountId) return { ...a, balance: round2(a.balance - p.amount) }
        return a
      })
    }

    // Сортируем: части split рядом, сверху
    transactions = [
      ...transactions.filter(t => t.splitId === splitId),
      ...transactions.filter(t => t.splitId !== splitId),
    ]

    state = { ...state, transactions, accounts }
    persist()
  },

  // ── Payment Calendar ─────────────────────────────────────────────────────
  addCalendarItem(item: PaymentCalendarItem) {
    state = { ...state, paymentCalendar: [item, ...(state.paymentCalendar ?? [])] }
    persist()
  },
  updateCalendarItem(id: string, changes: Partial<Omit<PaymentCalendarItem, 'id'>>) {
    state = { ...state, paymentCalendar: (state.paymentCalendar ?? []).map(i => i.id === id ? { ...i, ...changes } : i) }
    persist()
  },
  deleteCalendarItem(id: string) {
    state = { ...state, paymentCalendar: (state.paymentCalendar ?? []).filter(i => i.id !== id) }
    persist()
  },
  /** Mark item as paid and create a real transaction */
  payCalendarItem(id: string) {
    const item = (state.paymentCalendar ?? []).find(i => i.id === id)
    if (!item || item.status === 'paid') return   // защита от двойной оплаты (БАГ №1)
    // Счёт из платежа, иначе первый счёт как запасной вариант (БАГ №3)
    const acc = (item.accountId ? state.accounts.find(a => a.id === item.accountId) : null) ?? state.accounts[0]
    if (!acc) return
    const tx: Transaction = {
      id: 'tx_cal_' + Date.now(),
      date: new Date().toISOString().slice(0, 10),
      type: item.type,
      amount: item.amount,
      currency: acc.currency,
      accountId: acc.id,
      categoryId: item.categoryId,
      counterpartyId: item.counterpartyId,
      comment: item.description,
      tags: [],
    }
    // Add transaction + update account balance
    state = {
      ...state,
      transactions: [tx, ...state.transactions],
      accounts: state.accounts.map(a => {
        if (a.id !== acc.id) return a
        return { ...a, balance: round2(item.type === 'income' ? a.balance + item.amount : a.balance - item.amount) }
      }),
      paymentCalendar: (state.paymentCalendar ?? []).map(i => i.id === id ? { ...i, status: 'paid' } : i),
    }
    persist()
  },

  // ── Rules ────────────────────────────────────────────────────────────────
  addRule(r: TransactionRule) {
    state = { ...state, rules: [...(state.rules ?? []), r] }
    persist()
  },
  updateRule(id: string, changes: Partial<Omit<TransactionRule, 'id'>>) {
    state = { ...state, rules: (state.rules ?? []).map(r => r.id === id ? { ...r, ...changes } : r) }
    persist()
  },
  deleteRule(id: string) {
    state = { ...state, rules: (state.rules ?? []).filter(r => r.id !== id) }
    persist()
  },

  subscribe(fn: Listener) {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
}

// ── Права доступа: блокируем любые изменения данных для роли «Наблюдатель» ────
// Единая точка контроля — даже если UI где-то не скрыл кнопку, запись не пройдёт.
const WRITE_METHODS = new Set<string>([
  'addTransaction', 'deleteTransaction', 'deleteTransactions', 'updateTransaction', 'batchUpdateTransactions',
  'addAccount', 'deleteAccount', 'updateAccount',
  'addCounterparty', 'deleteCounterparty', 'deleteCounterparties', 'updateCounterparty',
  'addCategory', 'updateCategory', 'deleteCategory',
  'addProject', 'updateProject', 'deleteProject',
  'upsertBudget', 'deleteBudget',
  'addRecurring', 'updateRecurring', 'deleteRecurring', 'executeRecurring',
  'splitTransaction',
  'addCalendarItem', 'updateCalendarItem', 'deleteCalendarItem', 'payCalendarItem',
  'addRule', 'updateRule', 'deleteRule',
  'setClosingDate',
])

export const companyStore: typeof companyStoreImpl = new Proxy(companyStoreImpl, {
  get(target, prop, recv) {
    const val = Reflect.get(target, prop, recv)
    if (typeof val === 'function' && WRITE_METHODS.has(prop as string)) {
      return (...args: unknown[]) => {
        if (!authStore.canWrite()) {
          console.warn('[companyStore] изменение заблокировано: роль только для чтения —', String(prop))
          return undefined
        }
        return (val as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
    return val
  },
})

// ── Авто-инициализация при смене пользователя ─────────────────────────────────
subscribeAuth(() => {
  // Use active company (may differ from home company after switchCompany)
  const initId = authStore.getActiveCompanyId() ?? auth.currentUser?.uid ?? null

  if (initId) {
    void companyStore.init(initId)
  }
  // При выходе НЕ сбрасываем данные — они останутся до следующего init().
  // Это предотвращает случайную потерю данных из-за временного null-состояния Firebase.
})
