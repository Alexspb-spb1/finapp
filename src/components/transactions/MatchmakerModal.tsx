import { useState, useMemo } from 'react'
import { X, Zap, CheckCircle2, AlertCircle } from 'lucide-react'
import { useStore } from '../../store/useStore'
import { formatCurrency, formatDateShort } from '../../utils/format'
import CategoryIcon from '../../utils/categoryIcons'
import type { Transaction } from '../../types'

interface Props {
  open: boolean
  onClose: () => void
}

// Minimal rule-matching for auto-suggestions
function suggestCategory(tx: Transaction, store: ReturnType<typeof useStore>): string {
  for (const rule of store.rules.filter(r => r.enabled)) {
    const match = rule.conditions.every(cond => {
      switch (cond.field) {
        case 'type':           return tx.type === cond.value
        case 'accountId':      return tx.accountId === cond.value
        case 'counterpartyId': return tx.counterpartyId === cond.value
        case 'categoryId':     return tx.categoryId === cond.value
        case 'projectId':      return tx.projectId === cond.value
        case 'commentContains':
          return cond.value.split(',').some(v =>
            v.trim() && (tx.comment ?? '').toLowerCase().includes(v.trim().toLowerCase()))
        case 'counterpartyName': {
          const cp = store.counterparties.find(c => c.id === tx.counterpartyId)
          return (cp?.name ?? '').toLowerCase().includes(cond.value.toLowerCase())
        }
        case 'amountGt': return tx.amount > parseFloat(cond.value || '0')
        case 'amountLt': return tx.amount < parseFloat(cond.value || '0')
        case 'amountEq': return tx.amount === parseFloat(cond.value || '0')
        default: {
          const key = cond.field as 'type' | 'accountId' | 'counterpartyId' | 'categoryId' | 'projectId'
          return tx[key] === cond.value
        }
      }
    })
    if (match) {
      const catAction = rule.actions.find(a => a.field === 'categoryId')
      if (catAction?.value) return catAction.value
    }
  }
  return ''
}

export default function MatchmakerModal({ open, onClose }: Props) {
  const store = useStore()

  const uncategorized = useMemo(() =>
    store.transactions.filter(t => !t.categoryId && t.type !== 'transfer'),
    [store.transactions]
  )

  // Map txId → selected categoryId (pre-filled by rule suggestions)
  const [assignments, setAssignments] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    for (const tx of store.transactions.filter(t => !t.categoryId && t.type !== 'transfer')) {
      map[tx.id] = suggestCategory(tx, store)
    }
    return map
  })

  // Track which were auto-suggested
  const suggested = useMemo(() => {
    const s = new Set<string>()
    for (const tx of uncategorized) {
      if (suggestCategory(tx, store)) s.add(tx.id)
    }
    return s
  }, [uncategorized, store])

  if (!open) return null

  const filledCount = Object.values(assignments).filter(Boolean).length

  function applyAll() {
    for (const [txId, catId] of Object.entries(assignments)) {
      if (catId) store.updateTransaction(txId, { categoryId: catId })
    }
    onClose()
  }

  if (uncategorized.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-8 text-center">
          <CheckCircle2 size={40} className="text-emerald-500 mx-auto mb-3" />
          <h2 className="font-semibold text-slate-800 mb-1">Все операции категоризированы!</h2>
          <p className="text-sm text-slate-400 mb-5">Нет операций без статьи.</p>
          <button onClick={onClose}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition">
            Закрыть
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[88vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h2 className="font-semibold text-slate-800">Операции без статьи</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {uncategorized.length} операций · {filledCount} назначено
              {suggested.size > 0 && ` · ${suggested.size} предложено правилами`}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <X size={18} />
          </button>
        </div>

        {/* Hint */}
        {suggested.size > 0 && (
          <div className="mx-6 mt-3 flex items-start gap-2 bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-2.5 text-xs text-indigo-700 shrink-0">
            <Zap size={13} className="shrink-0 mt-0.5" />
            <span>Правила автоматизации предложили статьи для <strong>{suggested.size}</strong> операций — проверьте и нажмите «Применить».</span>
          </div>
        )}

        {/* Table */}
        <div className="overflow-y-auto flex-1 mt-3">
          <table className="w-full">
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-100 z-10">
              <tr>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-2.5 w-24">Дата</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-2.5">Контрагент / Назначение</th>
                <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-2.5 w-28">Сумма</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-2.5 w-52">Статья</th>
              </tr>
            </thead>
            <tbody>
              {uncategorized.map(tx => {
                const cp = store.counterparties.find(c => c.id === tx.counterpartyId)
                const filteredCats = store.categories.filter(c => c.type === tx.type && !c.isGroup)
                const typeGroups   = store.categories.filter(c => c.type === tx.type && c.isGroup)
                const standalone   = filteredCats.filter(c => !c.parentId)
                const children     = filteredCats.filter(c => !!c.parentId)
                const isSuggested  = suggested.has(tx.id) && !!assignments[tx.id]
                const assigned     = assignments[tx.id]
                const assignedCat  = store.categories.find(c => c.id === assigned)

                return (
                  <tr key={tx.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 text-xs text-slate-400 whitespace-nowrap">
                      {formatDateShort(tx.date)}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-slate-700 truncate max-w-[220px]">
                        {cp?.name ?? (tx.type === 'income' ? 'Поступление' : 'Списание')}
                      </p>
                      {tx.comment && (
                        <p className="text-xs text-slate-400 truncate max-w-[220px]">{tx.comment}</p>
                      )}
                    </td>
                    <td className={`px-4 py-3 text-sm font-semibold text-right whitespace-nowrap ${tx.type === 'income' ? 'text-emerald-600' : 'text-red-500'}`}>
                      {tx.type === 'income' ? '+' : '−'}{formatCurrency(tx.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {assignedCat && (
                          <div className="w-5 h-5 flex items-center justify-center shrink-0 rounded"
                            style={{ background: assignedCat.color + '22' }}>
                            <CategoryIcon name={assignedCat.icon} size={11} color={assignedCat.color} />
                          </div>
                        )}
                        <select
                          value={assignments[tx.id] ?? ''}
                          onChange={e => setAssignments(prev => ({ ...prev, [tx.id]: e.target.value }))}
                          className={`flex-1 border rounded-lg px-2 py-1.5 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 bg-white transition-colors ${
                            isSuggested ? 'border-indigo-300 bg-indigo-50/40' : 'border-slate-200'
                          }`}>
                          <option value="">— Выберите статью —</option>
                          {typeGroups.map(g => (
                            <optgroup key={g.id} label={g.name}>
                              {children.filter(c => c.parentId === g.id).map(c =>
                                <option key={c.id} value={c.id}>{c.name}</option>
                              )}
                            </optgroup>
                          ))}
                          {standalone.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        {isSuggested && (
                          <span title="Предложено правилом">
                            <Zap size={12} className="text-indigo-400 shrink-0" />
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between shrink-0">
          <div className="text-sm text-slate-500">
            {filledCount === 0
              ? <span className="flex items-center gap-1.5 text-amber-600"><AlertCircle size={14} /> Выберите статьи для сохранения</span>
              : <span className="text-emerald-600 font-medium">✓ {filledCount} из {uncategorized.length} заполнено</span>
            }
          </div>
          <div className="flex gap-3">
            <button onClick={onClose}
              className="px-4 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
              Отмена
            </button>
            <button onClick={applyAll} disabled={filledCount === 0}
              className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition">
              Применить {filledCount > 0 ? `(${filledCount})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
