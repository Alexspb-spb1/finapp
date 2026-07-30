import { useState } from 'react'
import { X, Plus, Trash2, Scissors, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useStore } from '../../store/useStore'
import { formatCurrency } from '../../utils/format'
import CategoryIcon from '../../utils/categoryIcons'
import type { Transaction, SplitPart } from '../../types'

interface Props {
  transaction: Transaction | null
  onClose: () => void
}

interface PartRow extends SplitPart {
  _key: number
}

let _keySeq = 0
function newKey() { return ++_keySeq }

export default function SplitTransactionModal({ transaction, onClose }: Props) {
  const store = useStore()
  const total = transaction?.amount ?? 0

  // Parent remounts this component (via `key`) whenever the target transaction
  // changes, so the initial state below is always seeded fresh — no reset effect needed.
  const [parts, setParts] = useState<PartRow[]>(() => [
    { _key: newKey(), categoryId: transaction?.categoryId ?? '', amount: 0, comment: '', projectId: transaction?.projectId ?? '' },
    { _key: newKey(), categoryId: '', amount: 0, comment: '', projectId: '' },
  ])

  if (!transaction) return null

  const cats = store.categories.filter(c => c.type === transaction.type && !c.isGroup)
  const groups = store.categories.filter(c => c.type === transaction.type && c.isGroup)
  const standalone = cats.filter(c => !c.parentId)
  const children   = cats.filter(c => !!c.parentId)

  const sumParts = parts.reduce((s, p) => s + (p.amount || 0), 0)
  const remaining = Math.round((total - sumParts) * 100) / 100
  const allFilled = parts.every(p => p.categoryId && p.amount > 0)
  const canSave   = allFilled && Math.abs(remaining) < 0.01 && parts.length >= 2

  function updatePart(key: number, changes: Partial<PartRow>) {
    setParts(prev => prev.map(p => p._key === key ? { ...p, ...changes } : p))
  }

  function addPart() {
    setParts(prev => [...prev, { _key: newKey(), categoryId: '', amount: 0, comment: '', projectId: '' }])
  }

  function removePart(key: number) {
    if (parts.length <= 2) return
    setParts(prev => prev.filter(p => p._key !== key))
  }

  // Fill remaining amount into last unfilled part
  function fillRemaining(key: number) {
    if (remaining <= 0) return
    updatePart(key, { amount: Math.round((parts.find(p => p._key === key)!.amount + remaining) * 100) / 100 })
  }

  function handleSave() {
    if (!canSave || !transaction) return
    store.splitTransaction(transaction.id, parts.map(p => ({
      categoryId: p.categoryId,
      amount: p.amount,
      comment: p.comment || undefined,
      projectId: p.projectId || undefined,
    })))
    onClose()
  }

  const isExpense = transaction.type === 'expense'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-100 flex items-center justify-center">
              <Scissors size={17} className="text-indigo-600" />
            </div>
            <div>
              <h2 className="font-semibold text-slate-800">Разделить операцию</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {isExpense ? 'Расход' : 'Доход'} ·{' '}
                <span className={`font-semibold ${isExpense ? 'text-red-500' : 'text-emerald-600'}`}>
                  {formatCurrency(total)}
                </span>
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <X size={18} />
          </button>
        </div>

        {/* Parts list */}
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-3">
          {parts.map((part, idx) => {
            const cat = cats.find(c => c.id === part.categoryId)
            const proj = store.projects.find(p => p.id === part.projectId)
            return (
              <div key={part._key} className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/50 group/part relative">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Часть {idx + 1}</span>
                  {parts.length > 2 && (
                    <button
                      onClick={() => removePart(part._key)}
                      className="p-1 rounded-lg text-slate-300 hover:text-red-400 hover:bg-red-50 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {/* Category */}
                  <div>
                    <label className="text-xs font-medium text-slate-500 block mb-1">Статья *</label>
                    <div className="flex items-center gap-2">
                      {cat && (
                        <div className="w-6 h-6 rounded flex items-center justify-center shrink-0"
                          style={{ background: cat.color + '22' }}>
                          <CategoryIcon name={cat.icon} size={12} color={cat.color} />
                        </div>
                      )}
                      <select
                        value={part.categoryId}
                        onChange={e => updatePart(part._key, { categoryId: e.target.value })}
                        className={`flex-1 border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 bg-white transition-colors ${
                          !part.categoryId ? 'border-amber-300' : 'border-slate-200'
                        }`}
                      >
                        <option value="">— Выберите статью —</option>
                        {groups.map(g => (
                          <optgroup key={g.id} label={g.name}>
                            {children.filter(c => c.parentId === g.id).map(c =>
                              <option key={c.id} value={c.id}>{c.name}</option>
                            )}
                          </optgroup>
                        ))}
                        {standalone.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Amount */}
                  <div>
                    <label className="text-xs font-medium text-slate-500 block mb-1">
                      Сумма *
                      {remaining > 0 && part.amount === 0 && (
                        <button
                          onClick={() => fillRemaining(part._key)}
                          className="ml-2 text-indigo-500 hover:text-indigo-700 font-medium text-[11px] underline"
                        >
                          подставить {formatCurrency(remaining)}
                        </button>
                      )}
                    </label>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={part.amount || ''}
                      onChange={e => updatePart(part._key, { amount: parseFloat(e.target.value) || 0 })}
                      placeholder="0.00"
                      className={`w-full border rounded-lg px-3 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-indigo-300 bg-white ${
                        !part.amount ? 'border-amber-300' : 'border-slate-200'
                      }`}
                    />
                  </div>

                  {/* Comment */}
                  <div>
                    <label className="text-xs font-medium text-slate-500 block mb-1">Назначение</label>
                    <input
                      type="text"
                      value={part.comment ?? ''}
                      onChange={e => updatePart(part._key, { comment: e.target.value })}
                      placeholder={transaction.comment || 'Необязательно'}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
                    />
                  </div>

                  {/* Project */}
                  {store.projects.length > 0 && (
                    <div>
                      <label className="text-xs font-medium text-slate-500 block mb-1">Проект</label>
                      <div className="flex items-center gap-2">
                        {proj && (
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: proj.color }} />
                        )}
                        <select
                          value={part.projectId ?? ''}
                          onChange={e => updatePart(part._key, { projectId: e.target.value })}
                          className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
                        >
                          <option value="">— Без проекта —</option>
                          {store.projects.filter(p => p.status === 'active').map(p =>
                            <option key={p.id} value={p.id}>{p.name}</option>
                          )}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* Add part */}
          <button
            onClick={addPart}
            className="w-full py-2.5 border-2 border-dashed border-slate-200 rounded-xl text-sm font-medium text-slate-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/40 transition-colors flex items-center justify-center gap-2"
          >
            <Plus size={14} /> Добавить часть
          </button>
        </div>

        {/* Footer: remainder + save */}
        <div className="px-6 py-4 border-t border-slate-100 shrink-0">
          {/* Remainder indicator */}
          <div className={`flex items-center justify-between rounded-xl px-4 py-3 mb-4 ${
            Math.abs(remaining) < 0.01
              ? 'bg-emerald-50 border border-emerald-200'
              : 'bg-amber-50 border border-amber-200'
          }`}>
            <div className="flex items-center gap-2">
              {Math.abs(remaining) < 0.01
                ? <CheckCircle2 size={15} className="text-emerald-500" />
                : <AlertCircle size={15} className="text-amber-500" />
              }
              <span className="text-sm font-medium text-slate-600">
                {Math.abs(remaining) < 0.01
                  ? 'Сумма распределена полностью'
                  : remaining > 0
                    ? `Не распределено: ${formatCurrency(remaining)}`
                    : `Превышение на: ${formatCurrency(-remaining)}`
                }
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-400">Итого:</span>
              <span className={`font-bold ${Math.abs(remaining) < 0.01 ? 'text-emerald-600' : 'text-amber-600'}`}>
                {formatCurrency(sumParts)}
              </span>
              <span className="text-slate-300">/</span>
              <span className="font-semibold text-slate-600">{formatCurrency(total)}</span>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition"
            >
              Отмена
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition flex items-center justify-center gap-2"
            >
              <Scissors size={14} /> Разделить на {parts.length} части
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
