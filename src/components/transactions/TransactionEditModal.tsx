import { useState } from 'react'
import { X, Building2 } from 'lucide-react'
import type { Transaction, TransactionType } from '../../types'
import { useStore } from '../../store/useStore'

interface Props {
  transaction: Transaction | null
  onClose: () => void
}

// Inner component — remounts each time via key={transaction.id}
// so useState initializers always get the right values
function EditForm({ transaction, onClose }: { transaction: Transaction; onClose: () => void }) {
  const store = useStore()
  const { accounts, categories, counterparties, projects } = store

  const [type,           setType]           = useState<TransactionType>(transaction.type)
  const [amount,         setAmount]         = useState(String(transaction.amount))
  const [date,           setDate]           = useState(transaction.date)
  const [accountId,      setAccountId]      = useState(transaction.accountId)
  const [toAccountId,    setToAccountId]    = useState(transaction.toAccountId ?? '')
  const [categoryId,     setCategoryId]     = useState(transaction.categoryId)
  const [counterpartyId, setCounterpartyId] = useState(transaction.counterpartyId ?? '')
  const [projectId,      setProjectId]      = useState(transaction.projectId ?? '')
  const [comment,        setComment]        = useState(transaction.comment ?? '')

  const filteredCats = categories.filter(c => c.type === type)
  const selectedCp   = counterparties.find(c => c.id === counterpartyId)
  const selectedAcc  = accounts.find(a => a.id === accountId)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const num = parseFloat(amount.replace(/\s/g, '').replace(',', '.'))
    if (!num || num <= 0) return
    store.updateTransaction(transaction.id, {
      type,
      amount: num,
      date,
      accountId,
      toAccountId: type === 'transfer' ? (toAccountId || undefined) : undefined,
      categoryId:  categoryId || (filteredCats[0]?.id ?? ''),
      counterpartyId: (type !== 'transfer' && counterpartyId) ? counterpartyId : undefined,
      projectId:   (type !== 'transfer' && projectId) ? projectId : undefined,
      comment,
    })
    onClose()
  }

  const tabs: { t: TransactionType; label: string }[] = [
    { t: 'income',   label: 'Доход'   },
    { t: 'expense',  label: 'Расход'  },
    { t: 'transfer', label: 'Перевод' },
  ]

  const fmtBankAcc = (s: string) => s.replace(/(.{4})/g, '$1 ').trim()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[92vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <h2 className="font-semibold text-slate-800">Редактировать операцию</h2>
          <button type="button" onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4 overflow-y-auto">

          {/* Type tabs */}
          <div className="flex gap-2">
            {tabs.map(({ t, label }) => (
              <button key={t} type="button"
                onClick={() => { setType(t); setCategoryId('') }}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                  type === t
                    ? t === 'income'   ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                    : t === 'expense'  ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
                    :                   'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200'
                    : 'text-slate-500 hover:bg-slate-50'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {/* Amount + Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Сумма, ₽</label>
              <input
                type="text"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0"
                required
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-xl font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Дата</label>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </div>
          </div>

          {/* My account */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">
              {type === 'transfer' ? 'Откуда (мой счёт)' : 'Мой счёт'}
            </label>
            <select
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            >
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {selectedAcc && (
              <p className="text-xs text-slate-400 mt-1">
                {selectedAcc.type === 'bank'   ? 'Банковский счёт'
                  : selectedAcc.type === 'card' ? 'Карта'
                  : selectedAcc.type === 'cash' ? 'Наличные'
                  : 'Криптовалюта'} · {selectedAcc.currency}
              </p>
            )}
          </div>

          {/* Transfer: to account */}
          {type === 'transfer' && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Куда</label>
              <select
                value={toAccountId}
                onChange={e => setToAccountId(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option value="">— Выберите счёт —</option>
                {accounts.filter(a => a.id !== accountId).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Category */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Статья</label>
            <select
              value={categoryId}
              onChange={e => setCategoryId(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            >
              <option value="">— Выберите статью —</option>
              {filteredCats.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
            </select>
          </div>

          {/* Counterparty */}
          {type !== 'transfer' && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Контрагент</label>
                <select
                  value={counterpartyId}
                  onChange={e => setCounterpartyId(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
                >
                  <option value="">— Не указан —</option>
                  {counterparties.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              {/* Counterparty bank details (read-only) */}
              {selectedCp && (selectedCp.bankAccount || selectedCp.inn) && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2 text-slate-400">
                    <Building2 size={13} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide">Реквизиты контрагента</span>
                  </div>
                  {selectedCp.bankAccount && (
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">Р/с контрагента</p>
                      <p className="text-sm font-mono text-slate-700 font-medium tracking-wide">
                        {fmtBankAcc(selectedCp.bankAccount)}
                      </p>
                    </div>
                  )}
                  {selectedCp.bankName && (
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">Банк</p>
                      <p className="text-sm text-slate-700">{selectedCp.bankName}</p>
                    </div>
                  )}
                  {selectedCp.inn && (
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">ИНН</p>
                      <p className="text-sm text-slate-700">{selectedCp.inn}</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Project */}
          {type !== 'transfer' && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Проект</label>
              <select
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option value="">— Без проекта —</option>
                {projects.filter(p => p.status === 'active').map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Comment */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Комментарий</label>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Необязательно"
              rows={3}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-1 pb-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-600 font-medium hover:bg-slate-50 transition">
              Отмена
            </button>
            <button type="submit"
              className={`flex-1 py-2.5 rounded-lg text-white text-sm font-medium transition ${
                type === 'income'   ? 'bg-emerald-500 hover:bg-emerald-600'
                : type === 'expense' ? 'bg-red-500 hover:bg-red-600'
                : 'bg-indigo-500 hover:bg-indigo-600'
              }`}>
              Сохранить
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Outer wrapper: renders nothing when transaction is null,
// remounts EditForm via key when transaction changes
export default function TransactionEditModal({ transaction, onClose }: Props) {
  if (!transaction) return null
  return <EditForm key={transaction.id} transaction={transaction} onClose={onClose} />
}
