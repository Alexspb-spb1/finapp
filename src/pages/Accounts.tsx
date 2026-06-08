import { useState, useRef } from 'react'
import { CreditCard, Banknote, Wallet, Bitcoin, Plus, X, Trash2, Upload, FileText, Loader2, Pencil } from 'lucide-react'
import { useStore } from '../store/useStore'
import { formatCurrency } from '../utils/format'
import { parseBankStatement, type ParsedTransaction } from '../utils/bankStatementParser'
import StatementPreview from '../components/bank/StatementPreview'
import type { Account, Counterparty } from '../types'

const typeIcon: Record<string, React.ElementType> = {
  bank: CreditCard, cash: Banknote, card: Wallet, crypto: Bitcoin,
}
const typeLabel: Record<string, string> = {
  bank: 'Банковский счёт', cash: 'Касса', card: 'Карта', crypto: 'Криптовалюта',
}
const COLORS = ['#6366f1','#22c55e','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899','#14b8a6']

type ModalStep = 'form' | 'preview'

export default function Accounts() {
  const store = useStore()
  const { accounts, transactions } = store
  const total = accounts.reduce((s, a) => s + a.balance, 0)

  // Modal state
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [step, setStep] = useState<ModalStep>('form')
  const [name, setName] = useState('')
  const [type, setType] = useState<Account['type']>('bank')
  const [balance, setBalance] = useState('')
  const [color, setColor] = useState(COLORS[0])

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<string | null>(null)

  // Statement state
  const [statementFile, setStatementFile] = useState<File | null>(null)
  const [statementParsed, setStatementParsed] = useState<ReturnType<typeof parseBankStatement> | null>(null)
  const [parseLoading, setParseLoading] = useState(false)
  const [parseError, setParseError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null)

  function openAdd() {
    setEditingId(null)
    setName(''); setBalance(''); setColor(COLORS[0]); setType('bank')
    setStatementFile(null); setStatementParsed(null); setParseError('')
    setOpen(true)
  }

  function openEdit(a: Account) {
    setEditingId(a.id)
    setName(a.name)
    setType(a.type)
    setBalance('')
    setColor(a.color)
    setStatementFile(null); setStatementParsed(null); setParseError('')
    setStep('form')
    setOpen(true)
  }

  function resetModal() {
    setOpen(false)
    setEditingId(null)
    setStep('form')
    setName(''); setBalance(''); setColor(COLORS[0]); setType('bank')
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
    } catch {
      setParseError('Ошибка чтения файла')
    } finally {
      setParseLoading(false)
    }
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (editingId) {
      // Edit mode — only update name, type, color (balance managed by transactions)
      store.updateAccount(editingId, { name, type, color })
      resetModal()
      return
    }

    const accId = 'acc_' + Date.now()
    const initialBalance = parseFloat(balance.replace(/\s/g, '').replace(',', '.')) || 0
    store.addAccount({ id: accId, name, type, currency: 'RUB', balance: initialBalance, color })

    if (statementParsed && statementParsed.ok) {
      setPendingAccountId(accId)
      setStep('preview')
    } else {
      resetModal()
    }
  }

  function handleImport(selected: ParsedTransaction[]) {
    if (!pendingAccountId) return

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
      selected.map(t => t.counterpart?.trim()).filter(Boolean) as string[]
    )]

    for (const name of uniqueNames) {
      const key = name.toLowerCase()

      // Pick bank details from the first transaction that has them for this name
      const txs = selected.filter(t => t.counterpart?.trim().toLowerCase() === key)
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
    const sorted = [...selected].sort((a, b) => a.date.localeCompare(b.date))
    for (const t of sorted) {
      const cpName = t.counterpart?.trim()
      store.addTransaction({
        id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        date: t.date,
        type: t.type,
        amount: t.amount,
        accountId: pendingAccountId,
        categoryId: t.type === 'income' ? 'cat_inc1' : 'cat_exp1',
        counterpartyId: cpName ? nameToId.get(cpName.toLowerCase()) : undefined,
        comment: t.description,
        tags: [],
      })
    }
    resetModal()
  }

  function confirmDelete() {
    if (deleteId) store.deleteAccount(deleteId)
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
        <button onClick={openAdd}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors shrink-0">
          <Plus size={16} /> Добавить счёт
        </button>
      </div>

      {/* Empty state */}
      {accounts.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-16 text-center">
          <div className="text-5xl mb-4">🏦</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">Добавьте первый счёт</h3>
          <p className="text-sm text-slate-400 mb-6 max-w-xs mx-auto">
            Счёт — это расчётный счёт в банке, касса или карта.<br />
            При добавлении банковского счёта можно загрузить выписку.
          </p>
          <button onClick={openAdd}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-5 py-2.5 rounded-xl transition-colors">
            <Plus size={16} /> Добавить счёт
          </button>
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

                <div className="flex items-start justify-between mb-4">
                  <div className="w-11 h-11 icon-circle flex items-center justify-center" style={{ background: a.color + '22' }}>
                    <Icon size={20} strokeWidth={1.5} style={{ color: a.color }} />
                  </div>
                  <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2 py-1 rounded-full">{a.currency}</span>
                </div>
                <p className="text-sm text-slate-500">{typeLabel[a.type] ?? a.type}</p>
                <p className="text-lg font-bold text-slate-800 mt-0.5">{a.name}</p>
                <p className="text-2xl font-bold mt-3" style={{ color: a.color }}>{formatCurrency(a.balance)}</p>
                <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-slate-400">Поступления</p>
                    <p className="text-sm font-semibold text-emerald-600 mt-0.5">{formatCurrency(inc)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Списания</p>
                    <p className="text-sm font-semibold text-red-500 mt-0.5">{formatCurrency(exp)}</p>
                  </div>
                </div>
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
              <div className="text-3xl mb-3 text-center">🗑️</div>
              <h3 className="text-base font-semibold text-slate-800 text-center mb-1">Удалить счёт?</h3>
              <p className="text-sm text-slate-500 text-center mb-5">
                «{a?.name}» будет удалён. Операции по этому счёту останутся.
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

              {/* Balance — only for new accounts */}
              {!editingId && (
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Начальный остаток, ₽</label>
                  <input value={balance} onChange={e => setBalance(e.target.value)}
                    placeholder="0"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                </div>
              )}

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

              {/* Statement upload — only for new bank accounts */}
              {!editingId && type === 'bank' && (
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">
                    Выписка из банка <span className="text-slate-400 font-normal">(необязательно · TXT)</span>
                  </label>
                  {!statementFile ? (
                    <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-200 rounded-xl px-4 py-5 cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition-all group">
                      <Upload size={20} className="text-slate-300 group-hover:text-indigo-400 transition-colors" />
                      <span className="text-sm text-slate-400 group-hover:text-indigo-500">Загрузить файл выписки .txt</span>
                      <span className="text-xs text-slate-300">Сбербанк, Тинькофф, Альфа, ВТБ и др.</span>
                      <input ref={fileRef} type="file" accept=".txt,.csv" onChange={handleFileChange} className="hidden" />
                    </label>
                  ) : (
                    <div className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                      parseError ? 'border-red-200 bg-red-50' :
                      statementParsed?.ok ? 'border-emerald-200 bg-emerald-50' :
                      'border-slate-200 bg-slate-50'
                    }`}>
                      {parseLoading ? (
                        <Loader2 size={18} className="text-indigo-500 animate-spin mt-0.5 shrink-0" />
                      ) : parseError ? (
                        <span className="text-lg shrink-0">❌</span>
                      ) : (
                        <FileText size={18} className="text-emerald-600 mt-0.5 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-700 truncate">{statementFile.name}</p>
                        {parseLoading && <p className="text-xs text-slate-400 mt-0.5">Читаю выписку…</p>}
                        {!parseLoading && statementParsed?.ok && (
                          <p className="text-xs text-emerald-700 mt-0.5">
                            {statementParsed.bankName} · {statementParsed.transactions.length} операций
                            {statementParsed.period && ` · ${statementParsed.period}`}
                          </p>
                        )}
                        {!parseLoading && parseError && (
                          <p className="text-xs text-red-600 mt-0.5">{parseError}</p>
                        )}
                      </div>
                      <button type="button" onClick={() => { setStatementFile(null); setStatementParsed(null); setParseError(''); if (fileRef.current) fileRef.current.value = '' }}
                        className="text-slate-400 hover:text-slate-600 shrink-0">
                        <X size={15} />
                      </button>
                    </div>
                  )}
                </div>
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

      {/* ── Statement preview ── */}
      {step === 'preview' && statementParsed && (
        <StatementPreview
          result={statementParsed}
          accountName={name}
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
