import { useState, useRef, useEffect } from 'react'
import { CreditCard, Banknote, Wallet, Bitcoin, Plus, X, Trash2, Upload, Pencil, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useAuth } from '../hooks/useAuth'
import { formatCurrency } from '../utils/format'
import { parseBankStatement } from '../utils/bankStatementParser'
import StatementPreview from '../components/bank/StatementPreview'
import StatementFilePicker from '../components/bank/StatementFilePicker'
import {
  classifyStatementTransactions,
  statementComment,
} from '../utils/bankStatementImport'
import { CURRENCIES, formatWithCurrency, currencySymbol, sumAccountsBase, fetchRate } from '../utils/currency'
import type { Account, Counterparty } from '../types'

const typeIcon: Record<string, React.ElementType> = {
  bank: CreditCard, cash: Banknote, card: Wallet, crypto: Bitcoin,
}
const typeLabel: Record<string, string> = {
  bank: 'Банковский счёт', cash: 'Касса', card: 'Карта', crypto: 'Криптовалюта',
}
const COLORS = ['#6366f1','#22c55e','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899','#14b8a6']

type ModalStep = 'form' | 'statement' | 'preview'

interface ImportSummary {
  accountName: string
  imported: number
  duplicates: number
  conflicts: number
}

export default function Accounts() {
  const store = useStore()
  const { readOnly } = useAuth()
  const { accounts, transactions } = store
  const total = sumAccountsBase(accounts)

  // Modal state
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [step, setStep] = useState<ModalStep>('form')
  const [name, setName] = useState('')
  const [type, setType] = useState<Account['type']>('bank')
  const [currency, setCurrency] = useState('RUB')
  const [rate, setRate] = useState('')
  const [fetchingRate, setFetchingRate] = useState(false)
  const [balance, setBalance] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<string | null>(null)

  // Авто-загрузка курса при выборе валютного счёта (если курс ещё не задан)
  useEffect(() => {
    if (!open || currency === 'RUB') { return }
    if (rate) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag for the async fetch started right below
    setFetchingRate(true)
    fetchRate(currency, 'RUB').then(r => {
      if (r) setRate(String(r))
      setFetchingRate(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, open])

  // Statement state
  const [statementFile, setStatementFile] = useState<File | null>(null)
  const [statementParsed, setStatementParsed] = useState<ReturnType<typeof parseBankStatement> | null>(null)
  const [parseLoading, setParseLoading] = useState(false)
  const [parseError, setParseError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null)

  function openAdd() {
    setEditingId(null)
    setStep('form')
    setName(''); setBalance(''); setColor(COLORS[0]); setType('bank'); setCurrency('RUB'); setRate('')
    setStatementFile(null); setStatementParsed(null); setParseError('')
    setPendingAccountId(null)
    setImportSummary(null)
    setOpen(true)
  }

  function openEdit(a: Account) {
    setEditingId(a.id)
    setName(a.name)
    setType(a.type)
    setCurrency(a.currency || 'RUB')
    setRate(a.rate ? String(a.rate) : '')
    setColor(a.color)
    // Вычисляем начальный остаток = текущий баланс − сумма операций
    const inc = transactions.filter(t => t.type === 'income'   && t.accountId === a.id).reduce((s, t) => s + t.amount, 0)
    const exp = transactions.filter(t => t.type === 'expense'  && t.accountId === a.id).reduce((s, t) => s + t.amount, 0)
    const initialBal = a.balance - (inc - exp)
    setBalance(String(Math.round(initialBal * 100) / 100))
    setStatementFile(null); setStatementParsed(null); setParseError('')
    setStep('form')
    setOpen(true)
  }

  function openStatementImport(a: Account) {
    setEditingId(null)
    setName(a.name)
    setStatementFile(null); setStatementParsed(null); setParseError('')
    setPendingAccountId(a.id)
    setImportSummary(null)
    setStep('statement')
    setOpen(true)
  }

  function clearStatementFile() {
    setStatementFile(null)
    setStatementParsed(null)
    setParseError('')
    if (fileRef.current) fileRef.current.value = ''
  }

  function resetModal() {
    setOpen(false)
    setEditingId(null)
    setStep('form')
    setName(''); setBalance(''); setColor(COLORS[0]); setType('bank'); setCurrency('RUB'); setRate('')
    setStatementFile(null); setStatementParsed(null); setParseError('')
    setPendingAccountId(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setStatementFile(file)
    setParseError('')
    setParseLoading(true)
    try {
      const text = await readFileAsText(file)
      const result = parseBankStatement(text)
      setStatementParsed(result)
      if (!result.ok) setParseError(result.errors[0] ?? 'Не удалось распознать выписку')
      else if (pendingAccountId) setStep('preview')
    } catch {
      setParseError('Ошибка чтения файла')
    } finally {
      setParseLoading(false)
    }
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault()

    const parsedRate = currency === 'RUB' ? undefined : (parseFloat(rate) || undefined)

    if (editingId) {
      const newInitial = parseFloat(balance.replace(/\s/g, '').replace(',', '.')) || 0
      // Пересчитываем баланс: начальный остаток + все операции по счёту
      const inc = transactions.filter(t => t.type === 'income'  && t.accountId === editingId).reduce((s, t) => s + t.amount, 0)
      const exp = transactions.filter(t => t.type === 'expense' && t.accountId === editingId).reduce((s, t) => s + t.amount, 0)
      const newBalance = newInitial + (inc - exp)
      store.updateAccount(editingId, { name, type, color, currency, rate: parsedRate, balance: newBalance })
      resetModal()
      return
    }

    const accId = 'acc_' + Date.now()
    const initialBalance = parseFloat(balance.replace(/\s/g, '').replace(',', '.')) || 0
    store.addAccount({ id: accId, name, type, currency, rate: parsedRate, balance: initialBalance, color })

    if (statementParsed && statementParsed.ok) {
      setPendingAccountId(accId)
      setStep('preview')
    } else {
      resetModal()
    }
  }

  function handleImport(selectedIndexes: number[]) {
    if (!pendingAccountId || !statementParsed?.ok) return

    const decisions = classifyStatementTransactions(
      statementParsed.transactions,
      store.transactions,
      store.counterparties,
      pendingAccountId,
    )
    const selected = new Set(selectedIndexes)
    const importable = decisions.filter((decision, index) =>
      selected.has(index) && decision.status === 'new'
    )
    const duplicateCount = decisions.filter(decision => decision.status === 'duplicate').length
    const conflictCount = decisions.filter(decision => decision.status === 'conflict').length
    const importedAccountName = accounts.find(account => account.id === pendingAccountId)?.name ?? name

    if (importable.length === 0) {
      resetModal()
      setImportSummary({
        accountName: importedAccountName,
        imported: 0,
        duplicates: duplicateCount,
        conflicts: conflictCount,
      })
      return
    }

    // ── Auto-create / match counterparties ─────────────────────────────────
    // Index existing counterparties by name and INN for deduplication
    const nameToId = new Map<string, string>(
      store.counterparties.map(cp => [cp.name.toLowerCase(), cp.id])
    )
    const innToId = new Map<string, string>(
      store.counterparties.filter(cp => cp.inn).map(cp => [cp.inn!, cp.id])
    )

    // Collect unique counterpart names
    const uniqueNames = [...new Set(
      importable.map(({ transaction }) => transaction.counterpart?.trim()).filter(Boolean) as string[]
    )]

    for (const name of uniqueNames) {
      const key = name.toLowerCase()

      // Pick bank details from the first transaction that has them for this name
      const txs = importable
        .map(({ transaction }) => transaction)
        .filter(t => t.counterpart?.trim().toLowerCase() === key)
      const ref  = txs.find(t => t.counterpartInn || t.counterpartAccount) ?? txs[0]
      const inn         = ref?.counterpartInn?.trim()      || undefined
      const bankAccount = ref?.counterpartAccount?.trim()  || undefined
      const bankName    = ref?.counterpartBankName?.trim() || undefined
      const bik         = ref?.counterpartBik?.trim()      || undefined

      // Match by INN first (most reliable), then by name
      if (inn && innToId.has(inn)) {
        const existingId = innToId.get(inn)!
        nameToId.set(key, existingId)
        // Fill in any missing bank details on the existing record
        const existing = store.counterparties.find(c => c.id === existingId)
        if (existing) {
          const patch: Partial<Counterparty> = {}
          if (!existing.bankAccount && bankAccount) patch.bankAccount = bankAccount
          if (!existing.bankName    && bankName)    patch.bankName    = bankName
          if (!existing.bik         && bik)         patch.bik         = bik
          if (Object.keys(patch).length) store.updateCounterparty(existingId, patch)
        }
        continue
      }
      if (nameToId.has(key)) continue

      // Determine type by transaction direction
      const hasIncome  = txs.some(t => t.type === 'income')
      const hasExpense = txs.some(t => t.type === 'expense')
      const cpType: Counterparty['type'] =
        hasIncome && !hasExpense ? 'client' :
        !hasIncome && hasExpense ? 'supplier' : 'other'

      const id = 'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2)
      store.addCounterparty({ id, name, type: cpType, inn, bankAccount, bankName, bik })
      nameToId.set(key, id)
      if (inn) innToId.set(inn, id)
    }

    // ── Add transactions with counterparty links ────────────────────────────
    // Статья по умолчанию — первая существующая категория нужного типа.
    // Не хардкодим cat_inc1/cat_exp1: их можно удалить в Настройках.
    const firstInc = store.categories.find(c => c.type === 'income')?.id ?? ''
    const firstExp = store.categories.find(c => c.type === 'expense')?.id ?? ''
    const sorted = [...importable].sort((a, b) =>
      a.transaction.date.localeCompare(b.transaction.date)
    )
    for (const { transaction: t, fingerprint } of sorted) {
      const cpName = t.counterpart?.trim()
      store.addTransaction({
        id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        date: t.date,
        type: t.type,
        amount: t.amount,
        accountId: pendingAccountId,
        categoryId: (t.type === 'income' ? firstInc : firstExp) || undefined,
        counterpartyId: cpName ? nameToId.get(cpName.toLowerCase()) : undefined,
        comment: statementComment(t),
        tags: [],
        bankOperationId: t.bankOperationId,
        importFingerprint: fingerprint,
      })
    }
    resetModal()
    setImportSummary({
      accountName: importedAccountName,
      imported: importable.length,
      duplicates: duplicateCount,
      conflicts: conflictCount,
    })
  }

  const statementDecisions = statementParsed?.ok && pendingAccountId
    ? classifyStatementTransactions(
        statementParsed.transactions,
        transactions,
        store.counterparties,
        pendingAccountId,
      )
    : []
  const duplicateIndexes = new Set(
    statementDecisions.flatMap((decision, index) =>
      decision.status === 'duplicate' ? [index] : []
    )
  )
  const conflictIndexes = new Set(
    statementDecisions.flatMap((decision, index) =>
      decision.status === 'conflict' ? [index] : []
    )
  )

  const deleteTxCount = deleteId
    ? transactions.filter(t => t.accountId === deleteId || t.toAccountId === deleteId).length
    : 0

  function confirmDelete() {
    if (deleteId && deleteTxCount === 0) store.deleteAccount(deleteId)
    setDeleteId(null)
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4">
        {accounts.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 px-5 py-4 shadow-sm flex-1">
            <p className="text-xs text-slate-500 uppercase tracking-wide">Общий баланс</p>
            <p className="text-3xl font-bold text-slate-800 mt-1">{formatCurrency(total)}</p>
            <p className="text-xs text-slate-400 mt-1">
              {accounts.length} {accounts.length === 1 ? 'счёт' : accounts.length < 5 ? 'счёта' : 'счетов'}
            </p>
          </div>
        )}
        {!readOnly && (
          <button onClick={openAdd}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors shrink-0">
            <Plus size={16} /> Добавить счёт
          </button>
        )}
      </div>

      {importSummary && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <CheckCircle2 size={18} className="text-emerald-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-emerald-800">
              Выписка для счёта «{importSummary.accountName}» обработана
            </p>
            <p className="text-xs text-emerald-700 mt-0.5">
              Добавлено операций: {importSummary.imported}.
              {importSummary.duplicates > 0 && ` Уже загруженных дублей пропущено: ${importSummary.duplicates}.`}
              {importSummary.conflicts > 0 && ` Конфликтующих операций заблокировано: ${importSummary.conflicts}.`}
            </p>
          </div>
          <button onClick={() => setImportSummary(null)}
            className="text-emerald-500 hover:text-emerald-700">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Empty state */}
      {accounts.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-16 text-center">
          <div className="text-5xl mb-4">🏦</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">Добавьте первый счёт</h3>
          <p className="text-sm text-slate-400 mb-6 max-w-xs mx-auto">
            Счёт — это расчётный счёт в банке, касса или карта.<br />
            При добавлении банковского счёта можно загрузить выписку.
          </p>
          {!readOnly && (
            <button onClick={openAdd}
              className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-5 py-2.5 rounded-xl transition-colors">
              <Plus size={16} /> Добавить счёт
            </button>
          )}
        </div>
      )}

      {/* Account cards */}
      {accounts.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {accounts.map(a => {
            const Icon = typeIcon[a.type] ?? Wallet
            const inc = transactions.filter(t => t.type === 'income' && t.accountId === a.id).reduce((s, t) => s + t.amount, 0)
            const exp = transactions.filter(t => t.type === 'expense' && t.accountId === a.id).reduce((s, t) => s + t.amount, 0)
            return (
              <div key={a.id} className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow relative group">
                {/* Action buttons */}
                {!readOnly && (
                  <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                    <button onClick={() => openEdit(a)}
                      className="p-1.5 rounded-lg text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 transition-all">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => setDeleteId(a.id)}
                      className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all">
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}

                <div className="flex items-start justify-between mb-4">
                  <div className="w-11 h-11 icon-circle flex items-center justify-center" style={{ background: a.color + '22' }}>
                    <Icon size={20} strokeWidth={1.5} style={{ color: a.color }} />
                  </div>
                  <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2 py-1 rounded-full">{a.currency}</span>
                </div>
                <p className="text-sm text-slate-500">{typeLabel[a.type] ?? a.type}</p>
                <p className="text-lg font-bold text-slate-800 mt-0.5">{a.name}</p>
                <p className="text-2xl font-bold mt-3" style={{ color: a.color }}>
                  {a.currency && a.currency !== 'RUB'
                    ? formatWithCurrency(a.balance, a.currency)
                    : formatCurrency(a.balance)}
                </p>
                <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-slate-400">Поступления</p>
                    <p className="text-sm font-semibold text-emerald-600 mt-0.5">
                      {a.currency && a.currency !== 'RUB' ? formatWithCurrency(inc, a.currency) : formatCurrency(inc)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Списания</p>
                    <p className="text-sm font-semibold text-red-500 mt-0.5">
                      {a.currency && a.currency !== 'RUB' ? formatWithCurrency(exp, a.currency) : formatCurrency(exp)}
                    </p>
                  </div>
                </div>
                {!readOnly && a.type === 'bank' && (
                  <button onClick={() => openStatementImport(a)}
                    className="mt-4 w-full flex items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition-colors">
                    <Upload size={15} /> Догрузить выписку
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Delete confirmation dialog ── */}
      {deleteId && (() => {
        const a = accounts.find(x => x.id === deleteId)
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6">
              {deleteTxCount > 0 ? (
                <>
                  <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <AlertCircle size={22} className="text-amber-500" />
                  </div>
                  <h3 className="text-base font-semibold text-slate-800 text-center mb-1">Счёт используется</h3>
                  <p className="text-sm text-slate-500 text-center mb-5">
                    К счёту «{a?.name}» привязано {deleteTxCount} операций. Сначала удалите или
                    перенесите эти операции на другой счёт, иначе они останутся без счёта.
                  </p>
                  <button onClick={() => setDeleteId(null)}
                    className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-lg transition">
                    Понятно
                  </button>
                </>
              ) : (
                <>
                  <div className="text-3xl mb-3 text-center">🗑️</div>
                  <h3 className="text-base font-semibold text-slate-800 text-center mb-1">Удалить счёт?</h3>
                  <p className="text-sm text-slate-500 text-center mb-5">
                    «{a?.name}» будет удалён безвозвратно.
                  </p>
                  <div className="flex gap-3">
                    <button onClick={() => setDeleteId(null)}
                      className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                      Отмена
                    </button>
                    <button onClick={confirmDelete}
                      className="flex-1 py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition">
                      Удалить
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── Add / Edit account modal ── */}
      {open && step === 'form' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-800">{editingId ? 'Редактировать счёт' : 'Новый счёт'}</h2>
              <button onClick={resetModal} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="px-6 py-5 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Название счёта</label>
                <input value={name} onChange={e => setName(e.target.value)} required
                  placeholder="Расчётный счёт Сбербанк"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>

              {/* Type */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Тип счёта</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['bank', 'cash', 'card'] as const).map(t => (
                    <button key={t} type="button" onClick={() => { setType(t); setStatementFile(null); setStatementParsed(null) }}
                      className={`py-2.5 rounded-lg text-sm font-medium border transition-all ${
                        type === t ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}>
                      {typeLabel[t]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Currency */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Валюта</label>
                <select value={currency} onChange={e => { setCurrency(e.target.value); setRate('') }}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300">
                  {CURRENCIES.map(c => (
                    <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                  ))}
                </select>
              </div>

              {/* Exchange rate — only for foreign-currency accounts (БАГ № 2) */}
              {currency !== 'RUB' && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                  <label className="block text-xs font-medium text-amber-700 mb-1.5">
                    Курс ({currency} → RUB)
                    {fetchingRate && <span className="ml-1 animate-spin inline-block"><RefreshCw size={10} /></span>}
                  </label>
                  <input
                    type="number" step="0.0001" min="0"
                    value={rate}
                    onChange={e => setRate(e.target.value)}
                    placeholder="например 90.5"
                    className="w-full border border-amber-300 bg-white rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-amber-300"
                  />
                  <p className="text-[11px] text-amber-600 mt-1.5">
                    Используется для пересчёта остатка в рубли в сводных отчётах
                  </p>
                </div>
              )}

              {/* Balance */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">
                  Начальный остаток, {currencySymbol(currency)}
                </label>
                <input value={balance} onChange={e => setBalance(e.target.value)}
                  placeholder="0"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                {editingId && (
                  <p className="text-xs text-slate-400 mt-1.5">
                    Текущий баланс = начальный остаток + все операции по счёту. При изменении баланс пересчитается автоматически.
                  </p>
                )}
              </div>

              {/* Color */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Цвет</label>
                <div className="flex gap-2 flex-wrap">
                  {COLORS.map(c => (
                    <button key={c} type="button" onClick={() => setColor(c)}
                      className={`w-8 h-8 rounded-full transition-all ${color === c ? 'ring-2 ring-offset-2 ring-slate-400 scale-110' : ''}`}
                      style={{ background: c }} />
                  ))}
                </div>
              </div>

              {/* Statement upload — optional when creating a bank account */}
              {!editingId && type === 'bank' && (
                <StatementFilePicker
                  file={statementFile}
                  result={statementParsed}
                  loading={parseLoading}
                  error={parseError}
                  inputRef={fileRef}
                  onChange={handleFileChange}
                  onClear={clearStatementFile}
                />
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={resetModal}
                  className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                  Отмена
                </button>
                <button type="submit" disabled={parseLoading}
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition">
                  {editingId ? 'Сохранить' : statementParsed?.ok ? 'Создать и импортировать →' : 'Создать счёт'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Upload a new statement to an existing account ── */}
      {open && step === 'statement' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <h2 className="font-semibold text-slate-800">Догрузить выписку</h2>
                <p className="text-xs text-slate-400 mt-0.5">в счёт «{name}»</p>
              </div>
              <button onClick={resetModal} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-slate-500">
                Выберите новую выписку. Перед импортом ФинУчёт покажет операции и автоматически исключит уже загруженные дубли.
              </p>
              <StatementFilePicker
                file={statementFile}
                result={statementParsed}
                loading={parseLoading}
                error={parseError}
                inputRef={fileRef}
                onChange={handleFileChange}
                onClear={clearStatementFile}
              />
              <button type="button" onClick={resetModal}
                className="w-full py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Statement preview ── */}
      {step === 'preview' && statementParsed && (
        <StatementPreview
          result={statementParsed}
          accountName={name}
          duplicateIndexes={duplicateIndexes}
          conflictIndexes={conflictIndexes}
          onImport={handleImport}
          onCancel={resetModal}
        />
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      const utf8text = e.target?.result as string
      if (utf8text.trimStart().startsWith('1CClientBankExchange')) {
        const r2 = new FileReader()
        r2.onload = e2 => resolve(e2.target?.result as string)
        r2.onerror = reject
        r2.readAsText(file, 'windows-1251')
        return
      }
      const bad = utf8text.includes('') || /[À-ÿ]{3,}/.test(utf8text.slice(0, 1000))
      if (bad) {
        const r2 = new FileReader()
        r2.onload = e2 => resolve(e2.target?.result as string)
        r2.onerror = reject
        r2.readAsText(file, 'windows-1251')
      } else {
        resolve(utf8text)
      }
    }
    reader.onerror = reject
    reader.readAsText(file, 'utf-8')
  })
}
