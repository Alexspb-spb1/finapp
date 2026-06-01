import { useStore } from '../store/useStore'
import { formatCurrency, monthKey } from '../utils/format'

const MONTH_LABELS: Record<string, string> = {
  '01': 'Янв', '02': 'Фев', '03': 'Мар', '04': 'Апр',
  '05': 'Май', '06': 'Июн', '07': 'Июл', '08': 'Авг',
  '09': 'Сен', '10': 'Окт', '11': 'Ноя', '12': 'Дек',
}

export default function PnL() {
  const { transactions, categories } = useStore()

  const months = [...new Set(transactions.map(t => monthKey(t.date)))].sort()

  const incCats = categories.filter(c => c.type === 'income')
  const expCats = categories.filter(c => c.type === 'expense')

  function getVal(catId: string, month: string) {
    return transactions
      .filter(t => t.categoryId === catId && monthKey(t.date) === month)
      .reduce((s, t) => s + t.amount, 0)
  }

  function totalByType(type: 'income' | 'expense', month: string) {
    return transactions
      .filter(t => t.type === type && monthKey(t.date) === month)
      .reduce((s, t) => s + t.amount, 0)
  }

  const reversedMonths = [...months].reverse()

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700">Отчёт о прибылях и убытках</h3>
          <p className="text-xs text-slate-400 mt-0.5">по статьям</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3 w-56">Статья</th>
                {reversedMonths.map(m => (
                  <th key={m} className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">
                    {MONTH_LABELS[m.slice(5)]} {m.slice(0, 4)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Income section */}
              <tr className="bg-emerald-50/50 border-b border-slate-100">
                <td colSpan={reversedMonths.length + 1} className="px-5 py-2 text-xs font-bold text-emerald-700 uppercase tracking-wider">
                  Доходы
                </td>
              </tr>
              {incCats.map(cat => {
                const vals = reversedMonths.map(m => getVal(cat.id, m))
                if (vals.every(v => v === 0)) return null
                return (
                  <tr key={cat.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 text-sm text-slate-600">
                      <span className="flex items-center gap-2">
                        <span>{cat.icon}</span>
                        {cat.name}
                      </span>
                    </td>
                    {vals.map((v, i) => (
                      <td key={i} className="px-4 py-3 text-sm text-emerald-600 font-medium text-right">
                        {v > 0 ? formatCurrency(v) : '—'}
                      </td>
                    ))}
                  </tr>
                )
              })}
              <tr className="border-b-2 border-emerald-200 bg-emerald-50">
                <td className="px-5 py-3 text-sm font-bold text-emerald-800">Итого доходы</td>
                {reversedMonths.map(m => (
                  <td key={m} className="px-4 py-3 text-sm font-bold text-emerald-700 text-right">
                    {formatCurrency(totalByType('income', m))}
                  </td>
                ))}
              </tr>

              {/* Expense section */}
              <tr className="bg-red-50/50 border-b border-slate-100">
                <td colSpan={reversedMonths.length + 1} className="px-5 py-2 text-xs font-bold text-red-600 uppercase tracking-wider">
                  Расходы
                </td>
              </tr>
              {expCats.map(cat => {
                const vals = reversedMonths.map(m => getVal(cat.id, m))
                if (vals.every(v => v === 0)) return null
                return (
                  <tr key={cat.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 text-sm text-slate-600">
                      <span className="flex items-center gap-2">
                        <span>{cat.icon}</span>
                        {cat.name}
                      </span>
                    </td>
                    {vals.map((v, i) => (
                      <td key={i} className="px-4 py-3 text-sm text-red-500 font-medium text-right">
                        {v > 0 ? formatCurrency(v) : '—'}
                      </td>
                    ))}
                  </tr>
                )
              })}
              <tr className="border-b-2 border-red-200 bg-red-50">
                <td className="px-5 py-3 text-sm font-bold text-red-700">Итого расходы</td>
                {reversedMonths.map(m => (
                  <td key={m} className="px-4 py-3 text-sm font-bold text-red-600 text-right">
                    {formatCurrency(totalByType('expense', m))}
                  </td>
                ))}
              </tr>

              {/* Net profit */}
              <tr className="bg-indigo-50">
                <td className="px-5 py-4 text-sm font-bold text-indigo-800">Чистая прибыль</td>
                {reversedMonths.map(m => {
                  const net = totalByType('income', m) - totalByType('expense', m)
                  return (
                    <td key={m} className={`px-4 py-4 text-sm font-bold text-right ${net >= 0 ? 'text-indigo-700' : 'text-red-600'}`}>
                      {net >= 0 ? '+' : ''}{formatCurrency(net)}
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
