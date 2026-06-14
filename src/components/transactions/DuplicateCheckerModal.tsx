import { X, Trash2, CheckCircle2, Copy, AlertTriangle } from 'lucide-react'
import { useStore } from '../../store/useStore'
import type { Transaction } from '../../types'
import { formatCurrency, formatDate } from '../../utils/format'
import CategoryIcon from '../../utils/categoryIcons'

interface Props {
  open: boolean
  onClose: () => void
}

const TYPE_LABELS: Record<string, string> = {
  income: 'Доход',
  expense: 'Расход',
  transfer: 'Перевод',
}

function findDuplicateGroups(transactions: Transaction[]): Transaction[][] {
  const map = new Map<string, Transaction[]>()
  for (const tx of transactions) {
    const key = `${tx.date}|${tx.type}|${tx.amount}|${tx.accountId}`
    const arr = map.get(key) ?? []
    arr.push(tx)
    map.set(key, arr)
  }
  return [...map.values()].filter(g => g.length >= 2)
}

function completenessScore(tx: Transaction): number {
  return (tx.projectId ? 2 : 0) + (tx.counterpartyId ? 1 : 0) + ((tx.comment ?? '').trim() ? 1 : 0)
}

export default function DuplicateCheckerModal({ open, onClose }: Props) {
  const store = useStore()
  const { transactions, accounts, categories, counterparties, projects } = store

  if (!open) return null

  const groups = findDuplicateGroups(transactions)
  const totalDupes = groups.reduce((s, g) => s + g.length - 1, 0)

  function deleteTx(id: string) {
    store.deleteTransaction(id)
  }

  function deleteAllDupes() {
    const toDelete: string[] = []
    for (const group of groups) {
      const sorted = [...group].sort((a, b) => completenessScore(b) - completenessScore(a))
      toDelete.push(...sorted.slice(1).map(tx => tx.id))
    }
    store.deleteTransactions(toDelete)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[85vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2">
            <Copy size={18} className="text-amber-500" />
            <h2 className="font-semibold text-slate-800">Поиск дублей</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center px-8">
            <CheckCircle2 size={44} className="text-emerald-500 mb-3" />
            <p className="font-semibold text-slate-800 mb-1">Дублей не найдено</p>
            <p className="text-sm text-slate-400">Все операции уникальны</p>
            <button onClick={onClose}
              className="mt-6 px-6 py-2.5 border border-slate-200 text-slate-600 text-sm font-medium rounded-lg hover:bg-slate-50 transition">
              Закрыть
            </button>
          </div>
        ) : (
          <>
            {/* Summary bar */}
            <div className="px-6 py-3 bg-amber-50 border-b border-amber-100 shrink-0 flex items-center gap-2">
              <AlertTriangle size={14} className="text-amber-500 shrink-0" />
              <p className="text-xs text-amber-700 flex-1">
                <span className="font-semibold">Найдено {totalDupes} вероятных {totalDupes === 1 ? 'дубля' : totalDupes < 5 ? 'дубля' : 'дублей'}</span>
                {' '}в {groups.length} {groups.length === 1 ? 'группе' : groups.length < 5 ? 'группах' : 'группах'}
              </p>
              <button onClick={deleteAllDupes}
                className="shrink-0 text-xs text-red-600 hover:text-red-800 font-medium border border-red-200 hover:bg-red-50 px-2.5 py-1 rounded-lg transition">
                Удалить все дубли
              </button>
            </div>

            {/* Groups list */}
            <div className="overflow-y-auto flex-1">
              {groups.map((group, gi) => {
                const first = group[0]
                const acc = accounts.find(a => a.id === first.accountId)
                const sorted = [...group].sort((a, b) => completenessScore(b) - completenessScore(a))
                const bestId = sorted[0].id

                return (
                  <div key={gi} className="border-b border-slate-100 last:border-0">
                    {/* Group header */}
                    <div className="px-5 py-2.5 bg-slate-50 flex items-center gap-2">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        first.type === 'income' ? 'bg-emerald-100 text-emerald-700'
                        : first.type === 'expense' ? 'bg-red-100 text-red-600'
                        : 'bg-indigo-100 text-indigo-700'
                      }`}>{TYPE_LABELS[first.type]}</span>
                      <span className="text-xs text-slate-500">{formatDate(first.date)}</span>
                      <span className="text-xs font-semibold text-slate-700">{formatCurrency(first.amount)}</span>
                      {acc && <span className="text-xs text-slate-400">· {acc.name}</span>}
                      <span className="ml-auto text-xs text-amber-600 font-medium">{group.length} копии</span>
                    </div>

                    {/* Transactions in group */}
                    <ul className="divide-y divide-slate-50">
                      {sorted.map(tx => {
                        const cat  = categories.find(c => c.id === tx.categoryId)
                        const cp   = counterparties.find(c => c.id === tx.counterpartyId)
                        const proj = projects.find(p => p.id === tx.projectId)
                        const isKeep = tx.id === bestId

                        return (
                          <li key={tx.id} className={`flex items-center gap-3 px-5 py-3 ${isKeep ? 'bg-white' : 'bg-rose-50/40'}`}>
                            <div className="w-8 h-8 icon-circle flex items-center justify-center shrink-0"
                              style={{ background: (cat?.color ?? '#94a3b8') + '22' }}>
                              <CategoryIcon name={cat?.icon ?? 'DollarSign'} size={14} color={cat?.color ?? '#94a3b8'} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-slate-700 truncate">{cat?.name ?? '—'}</p>
                              <p className="text-xs text-slate-400 truncate">
                                {cp ? cp.name : '—'}
                                {proj && <span className="ml-1 text-indigo-500">· {proj.name}</span>}
                                {tx.comment && <span className="ml-1">· {tx.comment.length > 40 ? tx.comment.slice(0, 40) + '…' : tx.comment}</span>}
                              </p>
                            </div>
                            {isKeep ? (
                              <span className="text-xs text-emerald-600 font-medium shrink-0 px-2 py-1 bg-emerald-50 rounded-lg">оставить</span>
                            ) : (
                              <button onClick={() => deleteTx(tx.id)}
                                className="shrink-0 flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium border border-red-200 hover:bg-red-50 px-2.5 py-1 rounded-lg transition">
                                <Trash2 size={12} /> Удалить
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )
              })}
            </div>

            <div className="px-6 py-4 border-t border-slate-100 shrink-0">
              <button onClick={onClose}
                className="w-full py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                Закрыть
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
