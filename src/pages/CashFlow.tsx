import { useState } from 'react'
import { ChevronDown, ChevronRight, Wallet, Download } from 'lucide-react'
import { downloadSheet } from '../utils/exportExcel'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import { useStore } from '../store/useStore'
import { formatCurrency, monthKey } from '../utils/format'
import { toBase, sumAccountsBase } from '../utils/currency'
import CategoryIcon from '../utils/categoryIcons'
import type { CategoryKind } from '../types'

const MONTH_LABELS: Record<string, string> = {
  '01': 'Янв', '02': 'Фев', '03': 'Мар', '04': 'Апр',
  '05': 'Май', '06': 'Июн', '07': 'Июл', '08': 'Авг',
  '09': 'Сен', '10': 'Окт', '11': 'Ноя', '12': 'Дек',
}

const KIND_LABELS: Record<CategoryKind, string> = {
  1: 'Операционная деятельность',
  2: 'Инвестиционная деятельность',
  3: 'Финансовая деятельность',
}

const KIND_COLORS: Record<CategoryKind, { inc: string; exp: string; net: string; bg: string; text: string }> = {
  1: { inc: '#4ade80', exp: '#f87171', net: '#6366f1', bg: 'bg-emerald-50/50 text-emerald-800', text: 'text-emerald-700' },
  2: { inc: '#60a5fa', exp: '#fb923c', net: '#8b5cf6', bg: 'bg-blue-50/50 text-blue-800',    text: 'text-blue-700'    },
  3: { inc: '#a78bfa', exp: '#f472b6', net: '#64748b', bg: 'bg-violet-50/50 text-violet-800', text: 'text-violet-700' },
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-lg text-sm">
      <p className="font-semibold text-slate-700 mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }} className="flex justify-between gap-6">
          <span>{p.name}:</span>
          <span className="font-medium">{formatCurrency(p.value)}</span>
        </p>
      ))}
    </div>
  )
}

export default function CashFlow() {
  const { transactions, categories, accounts } = useStore()

  // Period
  const allMonths = [...new Set(transactions.map(t => monthKey(t.date)))].sort()
  const allYears  = [...new Set(allMonths.map(m => m.slice(0, 4)))].sort().reverse()
  const currentYear = new Date().getFullYear().toString()
  const [year, setYear] = useState(allYears[0] ?? currentYear)

  const months = allMonths.filter(m => m.startsWith(year))
  const reversedMonths = [...months].reverse()

  // Section expand/collapse
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['inc-1', 'exp-1']))
  function toggle(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // Get kind for a category (default 1 = operational)
  function catKind(catId: string): CategoryKind {
    const cat = categories.find(c => c.id === catId)
    return (cat?.kind ?? 1) as CategoryKind
  }

  // Sum helpers
  function sumKindMonth(type: 'income' | 'expense', kind: CategoryKind, month: string) {
    return transactions
      .filter(t => t.type === type && catKind(t.categoryId) === kind && monthKey(t.date) === month)
      .reduce((s, t) => s + toBase(t), 0)
  }

  function sumCatMonth(catId: string, month: string) {
    return transactions
      .filter(t => t.categoryId === catId && monthKey(t.date) === month)
      .reduce((s, t) => s + toBase(t), 0)
  }

  // Categories for section
  function catsForSection(type: 'income' | 'expense', kind: CategoryKind) {
    return categories.filter(c => !c.isGroup && c.type === type && (c.kind ?? 1) === kind)
  }

  // Total net flow per month
  const totalNetPerMonth = months.map(m =>
    ([1, 2, 3] as CategoryKind[]).reduce((s, k) =>
      s + sumKindMonth('income', k, m) - sumKindMonth('expense', k, m), 0)
  )

  // Running balance: current balance - sum of future net flows
  const totalCurrentBalance = sumAccountsBase(accounts)
  // closing balance for each month in reverse (latest = current balance)
  const closingBalances: Record<string, number> = {}
  let runningBalance = totalCurrentBalance
  for (const m of [...reversedMonths]) {
    closingBalances[m] = runningBalance
    const idx = reversedMonths.indexOf(m)
    if (idx < reversedMonths.length - 1) {
      runningBalance -= totalNetPerMonth[months.indexOf(reversedMonths[idx + 1])]
    }
  }

  // Chart data — all available months (not just selected year)
  const chartMonths = allMonths.filter(m => m.startsWith(year))
  const chartData = chartMonths.map(m => ({
    name: MONTH_LABELS[m.slice(5)] ?? m,
    Поступления: ([1, 2, 3] as CategoryKind[]).reduce((s, k) => s + sumKindMonth('income', k, m), 0),
    Выплаты:     ([1, 2, 3] as CategoryKind[]).reduce((s, k) => s + sumKindMonth('expense', k, m), 0),
  }))

  // Summary totals for header cards
  const totalIncome  = months.reduce((s, m) => s + ([1,2,3] as CategoryKind[]).reduce((ss, k) => ss + sumKindMonth('income',  k, m), 0), 0)
  const totalExpense = months.reduce((s, m) => s + ([1,2,3] as CategoryKind[]).reduce((ss, k) => ss + sumKindMonth('expense', k, m), 0), 0)
  const totalNet     = totalIncome - totalExpense

  function handleExport() {
    const monthHeaders = months.map(m => MONTH_LABELS[m.slice(5)] ?? m)
    const rows: Record<string, string | number | null>[] = []

    for (const kind of [1, 2, 3] as CategoryKind[]) {
      rows.push({ 'Статья': KIND_LABELS[kind], ...Object.fromEntries(monthHeaders.map(h => [h, null])) })

      // Income categories
      for (const cat of catsForSection('income', kind)) {
        const vals = months.map(m => sumCatMonth(cat.id, m))
        if (vals.every(v => v === 0)) continue
        rows.push({ 'Статья': `  ${cat.name} (поступление)`, ...Object.fromEntries(months.map((_, i) => [monthHeaders[i], vals[i] || null])) })
      }
      // Expense categories
      for (const cat of catsForSection('expense', kind)) {
        const vals = months.map(m => sumCatMonth(cat.id, m))
        if (vals.every(v => v === 0)) continue
        rows.push({ 'Статья': `  ${cat.name} (выплата)`, ...Object.fromEntries(months.map((_, i) => [monthHeaders[i], vals[i] ? -vals[i] : null])) })
      }
      // Net row
      rows.push({ 'Статья': `Чистый поток (${KIND_LABELS[kind]})`, ...Object.fromEntries(months.map((m, i) => [monthHeaders[i], sumKindMonth('income', kind, m) - sumKindMonth('expense', kind, m)])) })
      rows.push({ 'Статья': '', ...Object.fromEntries(monthHeaders.map(h => [h, null])) })
    }

    // Total net + closing balance
    rows.push({ 'Статья': 'ИТОГО чистый поток', ...Object.fromEntries(months.map((_, i) => [monthHeaders[i], totalNetPerMonth[i]])) })
    rows.push({ 'Статья': 'Остаток на конец месяца', ...Object.fromEntries(months.map((m, i) => [monthHeaders[i], closingBalances[m]])) })

    downloadSheet(rows, 'ДДС', `cashflow_${year}.xlsx`)
  }

  if (months.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center">
        <Wallet size={32} className="mx-auto text-slate-300 mb-3" />
        <p className="text-slate-500 font-medium">Нет данных для отчёта</p>
        <p className="text-slate-400 text-sm mt-1">Добавьте операции чтобы увидеть ДДС</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-800">Движение денежных средств</h2>
          <p className="text-xs text-slate-400 mt-0.5">ДДС · кассовый метод</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={year} onChange={e => setYear(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 bg-white">
            {allYears.map(y => <option key={y} value={y}>{y}</option>)}
            {!allYears.includes(currentYear) && <option value={currentYear}>{currentYear}</option>}
          </select>
          <button onClick={handleExport} title="Экспорт в Excel"
            className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-300 transition-colors">
            <Download size={15} />
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Поступления',   value: totalIncome,  color: 'text-emerald-600' },
          { label: 'Выплаты',       value: totalExpense, color: 'text-red-600'     },
          { label: 'Чистый поток',  value: totalNet,     color: totalNet >= 0 ? 'text-indigo-600' : 'text-red-600' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
            <p className={`text-xl font-bold mt-1 ${color}`}>{formatCurrency(value)}</p>
            <p className="text-xs text-slate-400 mt-0.5">{year} год</p>
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Поступления и выплаты</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} barGap={3}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
            <Bar dataKey="Поступления" fill="#4ade80" radius={[3, 3, 0, 0]} />
            <Bar dataKey="Выплаты"     fill="#f87171" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* ДДС Table by kind */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3 w-60">Статья</th>
                {reversedMonths.map(m => (
                  <th key={m} className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">
                    {MONTH_LABELS[m.slice(5)]} {m.slice(0, 4)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {([1, 2, 3] as CategoryKind[]).map(kind => {
                const colors = KIND_COLORS[kind]
                const incCats = catsForSection('income',  kind)
                const expCats = catsForSection('expense', kind)
                const kindIncomes  = reversedMonths.map(m => sumKindMonth('income',  kind, m))
                const kindExpenses = reversedMonths.map(m => sumKindMonth('expense', kind, m))
                const kindNets     = reversedMonths.map((_, i) => kindIncomes[i] - kindExpenses[i])
                const hasAnyData   = months.some(m => sumKindMonth('income', kind, m) + sumKindMonth('expense', kind, m) > 0)
                if (!hasAnyData && kind !== 1) return null

                return (
                  <>
                    {/* Kind header */}
                    <tr key={`h-${kind}`} className="bg-slate-100 border-b border-slate-200">
                      <td colSpan={reversedMonths.length + 1} className="px-5 py-2 text-xs font-bold text-slate-600 uppercase tracking-wider">
                        {KIND_LABELS[kind]}
                      </td>
                    </tr>

                    {/* Income section */}
                    <tr key={`inc-h-${kind}`}
                      className={`border-b border-slate-100 cursor-pointer hover:opacity-80 transition-opacity ${colors.bg}`}
                      onClick={() => toggle(`inc-${kind}`)}>
                      <td className="px-5 py-2.5 text-xs font-bold uppercase tracking-wide">
                        <span className="flex items-center gap-1.5">
                          {expanded.has(`inc-${kind}`) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          Поступления
                        </span>
                      </td>
                      {kindIncomes.map((v, i) => (
                        <td key={i} className={`px-4 py-2.5 text-sm font-semibold text-right text-emerald-700`}>
                          {v > 0 ? formatCurrency(v) : '—'}
                        </td>
                      ))}
                    </tr>
                    {expanded.has(`inc-${kind}`) && incCats.map(cat => {
                      const vals = reversedMonths.map(m => sumCatMonth(cat.id, m))
                      if (vals.every(v => v === 0)) return null
                      return (
                        <tr key={cat.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                          <td className="px-5 py-2 pl-10 text-sm text-slate-500">
                            <span className="flex items-center gap-2">
                              <CategoryIcon name={cat.icon} size={13} color={cat.color} />
                              {cat.name}
                            </span>
                          </td>
                          {vals.map((v, i) => (
                            <td key={i} className={`px-4 py-2 text-sm text-right ${v > 0 ? 'text-emerald-600' : 'text-slate-300'}`}>
                              {v > 0 ? formatCurrency(v) : '—'}
                            </td>
                          ))}
                        </tr>
                      )
                    })}

                    {/* Expense section */}
                    <tr key={`exp-h-${kind}`}
                      className="border-b border-slate-100 cursor-pointer hover:opacity-80 transition-opacity bg-red-50/40 text-red-700"
                      onClick={() => toggle(`exp-${kind}`)}>
                      <td className="px-5 py-2.5 text-xs font-bold text-red-700 uppercase tracking-wide">
                        <span className="flex items-center gap-1.5">
                          {expanded.has(`exp-${kind}`) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          Выплаты
                        </span>
                      </td>
                      {kindExpenses.map((v, i) => (
                        <td key={i} className="px-4 py-2.5 text-sm font-semibold text-right text-red-600">
                          {v > 0 ? formatCurrency(v) : '—'}
                        </td>
                      ))}
                    </tr>
                    {expanded.has(`exp-${kind}`) && expCats.map(cat => {
                      const vals = reversedMonths.map(m => sumCatMonth(cat.id, m))
                      if (vals.every(v => v === 0)) return null
                      return (
                        <tr key={cat.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                          <td className="px-5 py-2 pl-10 text-sm text-slate-500">
                            <span className="flex items-center gap-2">
                              <CategoryIcon name={cat.icon} size={13} color={cat.color} />
                              {cat.name}
                            </span>
                          </td>
                          {vals.map((v, i) => (
                            <td key={i} className={`px-4 py-2 text-sm text-right ${v > 0 ? 'text-red-500' : 'text-slate-300'}`}>
                              {v > 0 ? formatCurrency(v) : '—'}
                            </td>
                          ))}
                        </tr>
                      )
                    })}

                    {/* Net for this kind */}
                    <tr key={`net-${kind}`} className="border-b-2 border-slate-200 bg-slate-50">
                      <td className="px-5 py-3 text-sm font-bold text-slate-700">
                        Чистый поток · {KIND_LABELS[kind].split(' ')[0].toLowerCase()}
                      </td>
                      {kindNets.map((v, i) => (
                        <td key={i} className={`px-4 py-3 text-sm font-bold text-right ${v >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                          {v !== 0 ? formatCurrency(v) : '—'}
                        </td>
                      ))}
                    </tr>
                  </>
                )
              })}

              {/* Total net */}
              <tr className="bg-indigo-50 border-y-2 border-indigo-200">
                <td className="px-5 py-3 text-sm font-bold text-indigo-800">Итого чистый поток</td>
                {reversedMonths.map(m => {
                  const idx = months.indexOf(m)
                  const v = totalNetPerMonth[idx] ?? 0
                  return (
                    <td key={m} className={`px-4 py-3 text-sm font-bold text-right ${v >= 0 ? 'text-indigo-700' : 'text-red-600'}`}>
                      {v !== 0 ? formatCurrency(v) : '—'}
                    </td>
                  )
                })}
              </tr>

              {/* Closing balance */}
              <tr className="bg-slate-100 border-b border-slate-200">
                <td className="px-5 py-3 text-sm font-semibold text-slate-700">Остаток на конец месяца</td>
                {reversedMonths.map(m => (
                  <td key={m} className="px-4 py-3 text-sm font-semibold text-right text-slate-600">
                    {closingBalances[m] !== undefined ? formatCurrency(closingBalances[m]) : '—'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
