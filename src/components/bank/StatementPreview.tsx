import { useState } from 'react'
import { CheckCircle2, XCircle, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react'
import type { ParseResult, ParsedTransaction } from '../../utils/bankStatementParser'
import { formatCurrency } from '../../utils/format'

interface Props {
  result: ParseResult
  accountName: string
  onImport: (selected: ParsedTransaction[]) => void
  onCancel: () => void
}

export default function StatementPreview({ result, accountName, onImport, onCancel }: Props) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(result.transactions.map((_, i) => i))
  )
  const [showAll, setShowAll] = useState(false)

  const visible = showAll ? result.transactions : result.transactions.slice(0, 50)
  const totalIncome = result.transactions
    .filter((_, i) => selected.has(i) && result.transactions[i].type === 'income')
    .reduce((s, t) => s + t.amount, 0)
  const totalExpense = result.transactions
    .filter((_, i) => selected.has(i) && result.transactions[i].type === 'expense')
    .reduce((s, t) => s + t.amount, 0)

  function toggleAll() {
    if (selected.size === result.transactions.length) setSelected(new Set())
    else setSelected(new Set(result.transactions.map((_, i) => i)))
  }

  function toggle(i: number) {
    const next = new Set(selected)
    next.has(i) ? next.delete(i) : next.add(i)
    setSelected(next)
  }

  function handleImport() {
    onImport(result.transactions.filter((_, i) => selected.has(i)))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-semibold text-slate-800 text-base">Импорт выписки</h2>
              <p className="text-xs text-slate-400 mt-0.5">в счёт «{accountName}»</p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="bg-indigo-50 text-indigo-700 font-medium px-2.5 py-1 rounded-full">{result.bankName}</span>
              {result.period && (
                <span className="bg-slate-100 text-slate-500 px-2.5 py-1 rounded-full">{result.period}</span>
              )}
            </div>
          </div>

          {/* Stats */}
          <div className="flex gap-4 mt-3">
            <div className="flex items-center gap-1.5 text-sm">
              <CheckCircle2 size={14} className="text-emerald-500" />
              <span className="font-medium text-slate-700">{result.transactions.length}</span>
              <span className="text-slate-400">операций распознано</span>
            </div>
            {result.skipped > 0 && (
              <div className="flex items-center gap-1.5 text-sm">
                <AlertCircle size={14} className="text-amber-500" />
                <span className="font-medium text-slate-700">{result.skipped}</span>
                <span className="text-slate-400">строк пропущено</span>
              </div>
            )}
            {result.accountNumber && (
              <div className="text-sm text-slate-400">
                Счёт: <span className="font-mono text-slate-600">{result.accountNumber.replace(/(.{4})/g, '$1 ').trim()}</span>
              </div>
            )}
          </div>

          {result.errors.length > 0 && (
            <div className="mt-2 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-600">
              <XCircle size={14} className="shrink-0 mt-0.5" />
              {result.errors[0]}
            </div>
          )}
        </div>

        {/* Summary bar */}
        {selected.size > 0 && (
          <div className="px-6 py-2.5 bg-slate-50 border-b border-slate-100 flex items-center gap-6 text-sm shrink-0">
            <span className="text-slate-500">Выбрано: <span className="font-semibold text-slate-700">{selected.size}</span></span>
            <span className="text-emerald-600">+ {formatCurrency(totalIncome)}</span>
            <span className="text-red-500">− {formatCurrency(totalExpense)}</span>
          </div>
        )}

        {/* Table */}
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white z-10">
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-2.5 w-10">
                  <input type="checkbox"
                    checked={selected.size === result.transactions.length}
                    onChange={toggleAll}
                    className="rounded accent-indigo-600 cursor-pointer"
                  />
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-2 py-2.5">Дата</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-2 py-2.5">Тип</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-2 py-2.5">Описание</th>
                <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-2.5">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t, i) => (
                <tr
                  key={i}
                  onClick={() => toggle(i)}
                  className={`border-b border-slate-50 cursor-pointer transition-colors ${selected.has(i) ? 'hover:bg-slate-50' : 'opacity-40 hover:opacity-60 bg-slate-50/50'}`}
                >
                  <td className="px-4 py-2.5">
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)}
                      className="rounded accent-indigo-600 cursor-pointer" onClick={e => e.stopPropagation()} />
                  </td>
                  <td className="px-2 py-2.5 text-slate-500 whitespace-nowrap font-mono text-xs">
                    {t.date.split('-').reverse().join('.')}
                  </td>
                  <td className="px-2 py-2.5">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                      t.type === 'income' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                    }`}>
                      {t.type === 'income' ? 'Доход' : 'Расход'}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 text-slate-600 max-w-xs truncate" title={t.description}>
                    {t.description || '—'}
                  </td>
                  <td className={`px-4 py-2.5 font-semibold text-right whitespace-nowrap ${
                    t.type === 'income' ? 'text-emerald-600' : 'text-red-500'
                  }`}>
                    {t.type === 'income' ? '+' : '−'}{formatCurrency(t.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.transactions.length > 50 && (
            <button
              onClick={() => setShowAll(v => !v)}
              className="w-full py-3 text-sm text-indigo-600 hover:bg-indigo-50 transition-colors flex items-center justify-center gap-1.5"
            >
              {showAll ? <><ChevronUp size={14} /> Свернуть</> : <><ChevronDown size={14} /> Показать все ({result.transactions.length})</>}
            </button>
          )}

          {result.transactions.length === 0 && (
            <div className="py-16 text-center">
              <div className="text-4xl mb-3">🤔</div>
              <p className="text-slate-500 font-medium">Операции не распознаны</p>
              <p className="text-slate-400 text-sm mt-1">Убедитесь, что файл содержит данные выписки в формате TXT</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-3 shrink-0">
          <button onClick={onCancel}
            className="px-4 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
            Отмена
          </button>
          <button
            onClick={handleImport}
            disabled={selected.size === 0}
            className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition"
          >
            Импортировать {selected.size > 0 ? `${selected.size} операций` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
