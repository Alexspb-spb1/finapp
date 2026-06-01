import type { Account, Category, Counterparty, Transaction, Project, TransactionRule } from '../types'

// Default categories every new company gets (no transactions, no accounts)
const DEFAULT_CATEGORIES: Category[] = [
  { id: 'cat_inc1', name: 'Выручка от клиентов', type: 'income', icon: '💰', color: '#22c55e' },
  { id: 'cat_inc2', name: 'Прочие доходы', type: 'income', icon: '📈', color: '#10b981' },
  { id: 'cat_inc3', name: 'Займы полученные', type: 'income', icon: '🏦', color: '#6ee7b7' },
  { id: 'cat_exp1', name: 'Зарплата', type: 'expense', icon: '👥', color: '#ef4444' },
  { id: 'cat_exp2', name: 'Аренда', type: 'expense', icon: '🏢', color: '#f97316' },
  { id: 'cat_exp3', name: 'Реклама и маркетинг', type: 'expense', icon: '📣', color: '#a855f7' },
  { id: 'cat_exp4', name: 'Закупка товаров', type: 'expense', icon: '📦', color: '#3b82f6' },
  { id: 'cat_exp5', name: 'Налоги', type: 'expense', icon: '🏛️', color: '#64748b' },
  { id: 'cat_exp6', name: 'Связь и интернет', type: 'expense', icon: '📡', color: '#06b6d4' },
  { id: 'cat_exp7', name: 'Командировки', type: 'expense', icon: '✈️', color: '#8b5cf6' },
  { id: 'cat_tr1', name: 'Внутренний перевод', type: 'transfer', icon: '🔄', color: '#94a3b8' },
]

interface CompanyData {
  accounts: Account[]
  categories: Category[]
  counterparties: Counterparty[]
  transactions: Transaction[]
  projects: Project[]
  rules: TransactionRule[]
}

function storageKey(companyId: string) {
  return `finapp_data_${companyId}`
}

function load(companyId: string): CompanyData {
  try {
    const raw = localStorage.getItem(storageKey(companyId))
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  // Fresh company — default categories, nothing else
  return {
    accounts: [],
    categories: DEFAULT_CATEGORIES,
    counterparties: [],
    transactions: [],
    projects: [],
    rules: [],
  }
}

function save(companyId: string, data: CompanyData) {
  localStorage.setItem(storageKey(companyId), JSON.stringify(data))
}

type Listener = () => void
const listeners = new Set<Listener>()
function notify() { listeners.forEach(fn => fn()) }

let currentCompanyId: string | null = null
let state: CompanyData = { accounts: [], categories: DEFAULT_CATEGORIES, counterparties: [], transactions: [], projects: [], rules: [] }

export const companyStore = {
  init(companyId: string) {
    if (currentCompanyId === companyId) return
    currentCompanyId = companyId
    state = load(companyId)
    notify()
  },

  get accounts() { return state.accounts },
  get categories() { return state.categories },
  get counterparties() { return state.counterparties },
  get transactions() { return state.transactions },
  get projects() { return state.projects },
  get rules() { return state.rules ?? [] },

  addTransaction(t: Transaction) {
    state = {
      ...state,
      transactions: [t, ...state.transactions],
      accounts: state.accounts.map(a => {
        if (t.type === 'income' && a.id === t.accountId) return { ...a, balance: a.balance + t.amount }
        if (t.type === 'expense' && a.id === t.accountId) return { ...a, balance: a.balance - t.amount }
        if (t.type === 'transfer') {
          if (a.id === t.accountId) return { ...a, balance: a.balance - t.amount }
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
        if (t.type === 'income' && a.id === t.accountId) return { ...a, balance: a.balance - t.amount }
        if (t.type === 'expense' && a.id === t.accountId) return { ...a, balance: a.balance + t.amount }
        if (t.type === 'transfer') {
          if (a.id === t.accountId) return { ...a, balance: a.balance + t.amount }
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

  deleteCounterparties(ids: string[]) {
    const idSet = new Set(ids)
    state = { ...state, counterparties: state.counterparties.filter(c => !idSet.has(c.id)) }
    persist()
  },

  updateTransaction(id: string, changes: Partial<Omit<Transaction, 'id'>>) {
    const old = state.transactions.find(x => x.id === id)
    if (!old) return
    const updated: Transaction = { ...old, ...changes }
    // Reverse old balance effects
    let accounts = state.accounts.map(a => {
      if (old.type === 'income'  && a.id === old.accountId)   return { ...a, balance: a.balance - old.amount }
      if (old.type === 'expense' && a.id === old.accountId)   return { ...a, balance: a.balance + old.amount }
      if (old.type === 'transfer') {
        if (a.id === old.accountId)   return { ...a, balance: a.balance + old.amount }
        if (a.id === old.toAccountId) return { ...a, balance: a.balance - old.amount }
      }
      return a
    })
    // Apply new balance effects
    accounts = accounts.map(a => {
      if (updated.type === 'income'  && a.id === updated.accountId)   return { ...a, balance: a.balance + updated.amount }
      if (updated.type === 'expense' && a.id === updated.accountId)   return { ...a, balance: a.balance - updated.amount }
      if (updated.type === 'transfer') {
        if (a.id === updated.accountId)   return { ...a, balance: a.balance - updated.amount }
        if (a.id === updated.toAccountId) return { ...a, balance: a.balance + updated.amount }
      }
      return a
    })
    state = {
      ...state,
      transactions: state.transactions.map(x => x.id === id ? updated : x),
      accounts,
    }
    persist()
  },

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

  addCounterparty(cp: Counterparty) {
    state = { ...state, counterparties: [...state.counterparties, cp] }
    persist()
  },

  deleteCounterparty(id: string) {
    state = { ...state, counterparties: state.counterparties.filter(c => c.id !== id) }
    persist()
  },

  updateCounterparty(id: string, changes: Partial<Omit<import('../types').Counterparty, 'id'>>) {
    state = { ...state, counterparties: state.counterparties.map(c => c.id === id ? { ...c, ...changes } : c) }
    persist()
  },

  addCategory(cat: Category) {
    state = { ...state, categories: [...state.categories, cat] }
    persist()
  },

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

  batchUpdateTransactions(updates: { id: string; changes: Partial<Omit<Transaction, 'id'>> }[]) {
    let { transactions } = state
    for (const { id, changes } of updates) {
      transactions = transactions.map(t => t.id === id ? { ...t, ...changes } : t)
    }
    state = { ...state, transactions }
    persist()
  },

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

function persist() {
  if (currentCompanyId) save(currentCompanyId, state)
  notify()
}
