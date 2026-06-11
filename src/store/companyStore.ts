import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { subscribeAuth, authStore } from './authStore'
import type { Account, Category, Counterparty, Transaction, Project, TransactionRule } from '../types'

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
  accounts:       Account[]
  categories:     Category[]
  counterparties: Counterparty[]
  transactions:   Transaction[]
  projects:       Project[]
  rules:          TransactionRule[]
}

const EMPTY: CompanyData = {
  accounts: [], categories: DEFAULT_CATEGORIES, counterparties: [],
  transactions: [], projects: [], rules: [],
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
    if (!saved.rules)      saved.rules      = []
    if (!saved.categories) saved.categories = DEFAULT_CATEGORIES
    state            = saved
    currentCompanyId = lastId   // ← чтобы persist() работал сразу
  } catch {}
})()

// ── Persist: localStorage (всегда) + Firestore (кросс-устройства) ────────────
function persist() {
  if (currentCompanyId) {
    (state as any)._savedAt = Date.now()
    // 1. localStorage — мгновенно, никогда не падает
    try {
      localStorage.setItem(LS_LAST_ID, currentCompanyId)
      localStorage.setItem(lsKey(currentCompanyId), JSON.stringify(state))
    } catch {}
    // 2. Firestore — фоновая синхронизация между устройствами
    setDoc(doc(db, 'company_data', currentCompanyId), state).catch(err => {
      console.error('[companyStore] Firestore write error:', err)
    })
  }
  notify()
}

function savedAt(d: CompanyData): number { return (d as any)._savedAt ?? 0 }

export const companyStore = {
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
        if (!lsData.rules)      lsData.rules      = []
        if (!lsData.categories) lsData.categories = DEFAULT_CATEGORIES
        state = lsData
        notify()
      } catch {}
    }

    // 2. Затем данные из Firestore — актуальная версия с других устройств
    // Берём Firestore только если его timestamp >= localStorage (он новее или равен)
    // Это защищает от случая когда Firestore пуст/устарел и затирает свежие локальные данные
    try {
      const snap = await getDoc(doc(db, 'company_data', companyId))
      if (snap.exists()) {
        const fresh = snap.data() as CompanyData
        if (!fresh.rules)      fresh.rules      = []
        if (!fresh.categories) fresh.categories = DEFAULT_CATEGORIES
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
          if (!fresh.rules)      fresh.rules      = []
          if (!fresh.categories) fresh.categories = DEFAULT_CATEGORIES
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
  get accounts()       { return state.accounts      },
  get categories()     { return state.categories    },
  get counterparties() { return state.counterparties },
  get transactions()   { return state.transactions  },
  get projects()       { return state.projects      },
  get rules()          { return state.rules ?? []   },

  // ── Transactions ──────────────────────────────────────────────────────────
  addTransaction(t: Transaction) {
    state = {
      ...state,
      transactions: [t, ...state.transactions],
      accounts: state.accounts.map(a => {
        if (t.type === 'income'   && a.id === t.accountId)   return { ...a, balance: a.balance + t.amount }
        if (t.type === 'expense'  && a.id === t.accountId)   return { ...a, balance: a.balance - t.amount }
        if (t.type === 'transfer') {
          if (a.id === t.accountId)   return { ...a, balance: a.balance - t.amount }
          if (a.id === t.toAccountId) return { ...a, balance: a.balance + t.amount }
        }
        return a
      }),
    }
    persist()
  },

  deleteTransaction(id: string) {
    const t = state.transactions.find(x => x.id === id)
    if (!t) return
    state = {
      ...state,
      transactions: state.transactions.filter(x => x.id !== id),
      accounts: state.accounts.map(a => {
        if (t.type === 'income'   && a.id === t.accountId)   return { ...a, balance: a.balance - t.amount }
        if (t.type === 'expense'  && a.id === t.accountId)   return { ...a, balance: a.balance + t.amount }
        if (t.type === 'transfer') {
          if (a.id === t.accountId)   return { ...a, balance: a.balance + t.amount }
          if (a.id === t.toAccountId) return { ...a, balance: a.balance - t.amount }
        }
        return a
      }),
    }
    persist()
  },

  deleteTransactions(ids: string[]) {
    const idSet = new Set(ids)
    let { accounts, transactions } = state
    for (const id of ids) {
      const t = transactions.find(x => x.id === id)
      if (!t) continue
      accounts = accounts.map(a => {
        if (t.type === 'income'  && a.id === t.accountId)   return { ...a, balance: a.balance - t.amount }
        if (t.type === 'expense' && a.id === t.accountId)   return { ...a, balance: a.balance + t.amount }
        if (t.type === 'transfer') {
          if (a.id === t.accountId)   return { ...a, balance: a.balance + t.amount }
          if (a.id === t.toAccountId) return { ...a, balance: a.balance - t.amount }
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
    const updated: Transaction = { ...old, ...changes }
    let accounts = state.accounts.map(a => {
      if (old.type === 'income'  && a.id === old.accountId)   return { ...a, balance: a.balance - old.amount }
      if (old.type === 'expense' && a.id === old.accountId)   return { ...a, balance: a.balance + old.amount }
      if (old.type === 'transfer') {
        if (a.id === old.accountId)   return { ...a, balance: a.balance + old.amount }
        if (a.id === old.toAccountId) return { ...a, balance: a.balance - old.amount }
      }
      return a
    })
    accounts = accounts.map(a => {
      if (updated.type === 'income'  && a.id === updated.accountId)   return { ...a, balance: a.balance + updated.amount }
      if (updated.type === 'expense' && a.id === updated.accountId)   return { ...a, balance: a.balance - updated.amount }
      if (updated.type === 'transfer') {
        if (a.id === updated.accountId)   return { ...a, balance: a.balance - updated.amount }
        if (a.id === updated.toAccountId) return { ...a, balance: a.balance + updated.amount }
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
      const updated: Transaction = { ...old, ...changes }
      accounts = accounts.map(a => {
        if (old.type === 'income'  && a.id === old.accountId)   return { ...a, balance: a.balance - old.amount }
        if (old.type === 'expense' && a.id === old.accountId)   return { ...a, balance: a.balance + old.amount }
        if (old.type === 'transfer') {
          if (a.id === old.accountId)   return { ...a, balance: a.balance + old.amount }
          if (a.id === old.toAccountId) return { ...a, balance: a.balance - old.amount }
        }
        return a
      })
      accounts = accounts.map(a => {
        if (updated.type === 'income'  && a.id === updated.accountId)   return { ...a, balance: a.balance + updated.amount }
        if (updated.type === 'expense' && a.id === updated.accountId)   return { ...a, balance: a.balance - updated.amount }
        if (updated.type === 'transfer') {
          if (a.id === updated.accountId)   return { ...a, balance: a.balance - updated.amount }
          if (a.id === updated.toAccountId) return { ...a, balance: a.balance + updated.amount }
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
    state = { ...state, counterparties: state.counterparties.filter(c => c.id !== id) }
    persist()
  },
  deleteCounterparties(ids: string[]) {
    const s = new Set(ids)
    state = { ...state, counterparties: state.counterparties.filter(c => !s.has(c.id)) }
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
    state = { ...state, projects: state.projects.filter(p => p.id !== id) }
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

// ── Авто-инициализация при смене пользователя ─────────────────────────────────
subscribeAuth(() => {
  const company = authStore.getCurrentCompany()
  if (company?.id) {
    // Пользователь вошёл / сменился — инициализируем данные его компании
    void companyStore.init(company.id)
  }
  // При выходе НЕ сбрасываем данные — они останутся до следующего init().
  // Это предотвращает случайную потерю данных из-за временного null-состояния Firebase.
})
